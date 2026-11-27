// Design mode's dev servers against real processes: the real BackgroundJobs,
// socket reader, port chooser and records file, a fake dev server and package
// manager (tests/fixtures/design-app-server), and the repo's own Vite. The
// fake-dependency tests in app-server-main.test.ts are the oracle for the
// rules; this file proves the wiring on this host (lsof on macOS, /proc on
// Linux). Everything listens on 127.0.0.1, except the short-lived wildcard
// listeners the exposure tests exist to catch.
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../../../renderer/shared/design-app.js";
import { BackgroundJobs, type DesignJobView } from "../../follow-through/background-jobs.js";
import { WorkspaceMutationGate } from "../../workspace-mutation-gate.js";
import { readCanvasConfig, saveCanvasConfigApp } from "../canvas-config.js";
import { DesignAppConsent, type DesignAppConsentOwner } from "./app-consent.js";
import { detectWebApp } from "./app-detect.js";
import { launchDirsUnchanged, readLaunchSurface } from "./app-fingerprint.js";
import { chooseAppPort, defaultOsPort } from "./app-ports.js";
import { createDesignAppRecords } from "./app-records.js";
import { DesignAppServers, type DesignAppLimits } from "./app-server-main.js";
import { defaultAppToolchainDeps, resolveAppToolchain } from "./app-toolchain.js";

const skip = process.platform === "win32" ? "design apps run on macOS and Linux" : false;
const FIXTURES = fileURLToPath(new URL("../../../../tests/fixtures/design-app-server/", import.meta.url));
const REPO_NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Setup {
  scripts: Record<string, string>;
  lockfile?: boolean;
  /** `true`: an empty node_modules; "repo": a link to the repo's node_modules; false: none. */
  nodeModules?: boolean | "repo";
  /** The real Node and npm, found the way the app finds them. */
  realToolchain?: boolean;
  limits?: Partial<DesignAppLimits>;
  rotateBytes?: number;
  files?: Record<string, string>;
}

async function harness(t: test.TestContext, setup: Setup) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-design-process-")));
  const root = path.join(base, "workspace");
  const tools = path.join(base, "tools");
  await mkdir(root, { recursive: true });
  await mkdir(tools, { recursive: true });
  await copyFile(path.join(FIXTURES, "server.mjs"), path.join(root, "server.mjs"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, devDependencies: { vite: "*" }, scripts: setup.scripts }, null, 2),
  );
  if (setup.lockfile) await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  if (setup.nodeModules === true) await mkdir(path.join(root, "node_modules"));
  if (setup.nodeModules === "repo") await symlink(REPO_NODE_MODULES, path.join(root, "node_modules"), "dir");
  for (const [name, text] of Object.entries(setup.files ?? {})) await writeFile(path.join(root, name), text);
  const shim = path.join(tools, "npm");
  await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIXTURES, "fake-pm.mjs"))} "$@"\n`);
  await chmod(shim, 0o755);

  const listeners = new Set<(view: DesignJobView) => void>();
  const jobs = new BackgroundJobs({
    logDir: path.join(base, "logs"),
    onDesignChange: (view) => {
      for (const listener of listeners) listener(view);
    },
    stopGraceMs: 1_000,
    ...(setup.rotateBytes ? { designLogRotateBytes: setup.rotateBytes } : {}),
  });
  const records = createDesignAppRecords(() => path.join(base, "design-apps.json"));
  const consent = new DesignAppConsent();
  const cards: Array<Record<string, unknown>> = [];
  const owner: DesignAppConsentOwner = {
    id: 7,
    documentId: "doc-7",
    isDestroyed: () => false,
    onInvalidated: () => () => undefined,
    send: (channel, payload) => {
      if (channel !== "designApp:consent") return;
      cards.push(payload as Record<string, unknown>);
      // The person allows every card.
      queueMicrotask(() => consent.answer((payload as { requestId: string }).requestId, "allow", owner));
    },
  };
  const reports: Array<Record<string, unknown>> = [];
  const snapshots: DesignAppsSnapshot[] = [];
  const servers = new DesignAppServers({
    jobs,
    onJobChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    detect: (workspaceRoot) => detectWebApp(workspaceRoot, { stopAt: path.dirname(workspaceRoot), homeDir: path.dirname(workspaceRoot) }),
    readConfig: readCanvasConfig,
    saveConfigApp: saveCanvasConfigApp,
    toolchain: setup.realToolchain
      ? (app) => resolveAppToolchain(app, defaultAppToolchainDeps())
      : async () => ({ ok: true, node: process.execPath, manager: { name: "npm", path: shim } }),
    fingerprint: readLaunchSurface,
    dirsUnchanged: launchDirsUnchanged,
    records,
    choosePort: (input) => chooseAppPort(input),
    osPort: defaultOsPort,
    consent,
    views: { visible: () => 1, onPresence: () => () => undefined },
    workspace: async (id) => (id === "ws" ? { id, path: root, permission: "full" } : undefined),
    gate: new WorkspaceMutationGate(),
    recoveryReady: Promise.resolve(true),
    launchEnv: () => ({ env: process.env, providerKeys: [] }),
    report: (event) => reports.push({ ...event }),
    limits: { readyIdleMs: 5_000, graceMs: 1_000, ...setup.limits },
  });
  servers.onStatus((snapshot) => snapshots.push(snapshot));
  t.after(async () => {
    await servers.forgetWorkspace("ws").catch(() => undefined);
    await jobs.shutdown().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });
  const latest = (): DesignAppStatus | undefined => {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const app = snapshots[index]!.apps.find((entry) => entry.appRoot === ".");
      if (app) return app;
    }
    return undefined;
  };
  const start = (install?: boolean) =>
    servers.start({ workspaceId: "ws", appRoot: ".", by: "person", chatId: "chat-1", owner, permission: "full", ...(install ? { install } : {}) });
  const logText = async () => (await servers.logs("ws", ".", { after: 0, maxBytes: 64 * 1024 })).text;
  return { root, base, jobs, servers, records, cards, reports, latest, start, logText };
}

async function get(origin: string): Promise<number> {
  const response = await fetch(origin);
  await response.text();
  return response.status;
}

const serve = (flags = "") => `node server.mjs${flags ? ` ${flags}` : ""}`;

test("a custom dev script starts on loopback and runs at http://127.0.0.1:<port>", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve() }, nodeModules: true });
  const status = await h.start();
  assert.equal(status.phase, "running", JSON.stringify(status));
  assert.equal(status.origin, `http://127.0.0.1:${status.port}`);
  assert.equal(await get(status.origin!), 200);
  assert.equal(h.cards.length, 1);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "running" }]);
  assert.deepEqual(h.servers.appForOrigin(status.origin!), { workspaceId: "ws", appRoot: "." });
});

test("the real Vite starts through a node_modules symlink with --host, --port and --strictPort, and binds loopback only", { skip }, async (t) => {
  const h = await harness(t, {
    scripts: { dev: "vite" },
    nodeModules: "repo",
    realToolchain: true,
    limits: { readyIdleMs: 30_000 },
    files: { "index.html": "<!doctype html><title>fixture</title><h1>Hello</h1>\n" },
  });
  // Nothing may install here: an install would reach the registry.
  const detected = await detectWebApp(h.root, { stopAt: path.dirname(h.root), homeDir: path.dirname(h.root) });
  assert.equal(detected.apps[0]?.installed, true, "the node_modules link counts as installed");
  const status = await h.start();
  assert.equal(status.phase, "running", `${JSON.stringify(status)}\n${await h.logText()}`);
  assert.equal(await get(status.origin!), 200);
  const job = h.jobs.listDesign("ws")[0]!;
  assert.match(job.command, /^npm run dev$/u);
  const sockets = (await h.jobs.designSockets([job.id])).get(job.id);
  assert.ok(sockets?.ok, JSON.stringify(sockets));
  const listening = sockets.sockets.filter((socket) => socket.port === status.port);
  assert.ok(listening.length > 0);
  assert.deepEqual([...new Set(sockets.sockets.map((socket) => socket.address))], ["127.0.0.1"], JSON.stringify(sockets.sockets));
});

test("a wildcard listener is stopped as exposed", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-wildcard") }, nodeModules: true });
  const status = await h.start();
  assert.deepEqual(status.problem, { problem: "exposed" });
  assert.equal(h.jobs.listDesign("ws")[0]?.state, "stopped");
});

test("a late wildcard listener is stopped as exposed while running", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-late-wildcard=1500") }, nodeModules: true });
  assert.equal((await h.start()).phase, "running");
  await eventually(() => h.latest()?.phase === "stopped", "the exposure stop", 10_000);
  assert.deepEqual(h.latest()?.problem, { problem: "exposed" });
});

test("a setsid child's wildcard listener is caught, and the stop ends it", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-setsid-child") }, nodeModules: true });
  const status = await h.start();
  const pid = Number(/setsid pid (\d+)/u.exec(await h.logText())?.[1]);
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  });
  // It may be caught while starting or on the first running poll.
  await eventually(() => h.latest()?.phase === "stopped", "the exposure stop", 10_000);
  assert.deepEqual(h.latest()?.problem ?? status.problem, { problem: "exposed" });
  assert.ok(pid > 0);
  await eventually(() => !alive(pid), "the setsid listener to end", 5_000);
});

test("a crash ends the setsid child the server started, found by the job's marker", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-setsid-loopback-child --fake-crash-after=1500") }, nodeModules: true });
  assert.equal((await h.start()).phase, "running");
  const pid = Number(/setsid pid (\d+)/u.exec(await h.logText())?.[1]);
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.ok(pid > 0 && alive(pid));
  await eventually(() => h.latest()?.phase === "crashed", "the crash", 10_000);
  await eventually(() => !alive(pid), "the setsid child to end with the crash", 5_000);
});

test("a server that never listens is stopped as not-ready, and its process is gone", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-never-listen") }, nodeModules: true });
  const status = await h.start();
  assert.equal(status.problem?.problem, "not-ready");
  const job = h.jobs.listDesign("ws")[0]!;
  assert.equal(job.state, "stopped");
  assert.ok(job.pid);
  await eventually(() => !alive(job.pid!), "the process to end", 5_000);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "failed" }]);
});

test("a chatty server that never listens survives past the inactivity timer, until the hard cap", { skip }, async (t) => {
  const h = await harness(t, {
    scripts: { dev: serve("--fake-chatty-never-listen") },
    nodeModules: true,
    limits: { readyIdleMs: 2_500, readyCapMs: 8_000 },
  });
  const began = Date.now();
  const status = await h.start();
  const took = Date.now() - began;
  assert.equal(status.problem?.problem, "not-ready");
  assert.match((status.problem as { tail: string }).tail, /compiling/u);
  assert.ok(took >= 7_500, `stopped after ${took} ms, before the hard cap`);
});

test("a crash after start is reported as crashed with its tail", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-crash-after=1500") }, nodeModules: true });
  assert.equal((await h.start()).phase, "running");
  await eventually(() => h.latest()?.phase === "crashed", "the crash", 10_000);
  assert.equal(h.latest()?.exitCode, 1);
  assert.match(h.latest()?.tail ?? "", /the fake server broke/u);
});

test("a server listening on another port than it prints is ready on the port it really holds", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-other-port") }, nodeModules: true });
  const status = await h.start();
  assert.equal(status.phase, "running");
  const printed = Number(/127\.0\.0\.1:(\d+)/u.exec(await h.logText())?.[1]);
  assert.notEqual(status.port, printed);
  assert.equal(await get(status.origin!), 200);
});

test("a flood of 8 MB keeps the server running, with the log rotated", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve(`--fake-flood=${8 * 1024 * 1024}`) }, nodeModules: true, rotateBytes: 1024 * 1024 });
  const status = await h.start();
  assert.equal(status.phase, "running");
  const job = h.jobs.listDesign("ws")[0]!;
  await eventually(() => (h.jobs.getDesign(job.id)?.outputBytes ?? 0) >= 8 * 1024 * 1024, "the flood", 20_000);
  const view = h.jobs.getDesign(job.id)!;
  assert.equal(view.state, "running");
  assert.ok(view.oldestKeptByte > 0, "older output was rotated away");
  assert.equal(await get(status.origin!), 200);
  assert.equal(h.latest()?.phase, "running");
});

test("stop ends the server and its SIGTERM-ignoring child", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-child") }, nodeModules: true });
  assert.equal((await h.start()).phase, "running");
  const child = Number(/child pid (\d+)/u.exec(await h.logText())?.[1]);
  t.after(() => {
    if (child && alive(child)) process.kill(child, "SIGKILL");
  });
  assert.ok(alive(child));
  const stopped = await h.servers.stop("ws", ".");
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.problem, undefined);
  await eventually(() => !alive(child), "the child to end", 5_000);
});

test("a first install runs fake-pm ci, writes the stamp, and the next start skips it", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve() }, lockfile: true, nodeModules: false });
  const status = await h.start();
  assert.equal(status.phase, "running", JSON.stringify(status));
  assert.equal(await readFile(path.join(h.root, "node_modules", ".fake-installed"), "utf8"), "ci\n");
  assert.equal((await h.records.installOf("ws", "."))?.state, "done");
  const jobsBefore = h.jobs.listDesign("ws").length;
  assert.equal(jobsBefore, 2, "the install, then the server");
  await h.servers.stop("ws", ".");
  assert.equal((await h.start()).phase, "running");
  assert.equal(h.jobs.listDesign("ws").length, jobsBefore + 1, "no second install");
});

test("with no lockfile, one card covers the install that writes one: one install, and the next start asks nothing", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve() }, lockfile: false, nodeModules: false });
  const status = await h.start();
  assert.equal(status.phase, "running", JSON.stringify(status));
  assert.equal(await readFile(path.join(h.root, "node_modules", ".fake-installed"), "utf8"), "install\n");
  assert.ok((await readFile(path.join(h.root, "package-lock.json"), "utf8")).includes("lockfileVersion"), "the install wrote a lockfile");
  const installs = () => h.jobs.listDesign("ws").filter((job) => / (install|ci)$/u.test(job.command));
  assert.equal(h.cards.length, 1, "no second card for the lockfile Aiden's install wrote");
  assert.equal(installs().length, 1);
  await h.servers.stop("ws", ".");
  assert.equal((await h.start()).phase, "running");
  assert.equal(h.cards.length, 1, "the next start asks nothing");
  assert.equal(installs().length, 1, "and installs nothing");
});

test("CRA's address-in-use message is retried once on another port", { skip }, async (t) => {
  const h = await harness(t, { scripts: { dev: serve("--fake-in-use-once=.in-use-once") }, nodeModules: true });
  const status = await h.start();
  assert.equal(status.phase, "running", JSON.stringify(status));
  const jobs = h.jobs.listDesign("ws");
  assert.equal(jobs.length, 2);
  assert.equal(h.cards.length, 1, "the retry asks nothing");
});
