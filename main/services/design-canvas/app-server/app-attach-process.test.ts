// Connect running server… against real processes: the real socket reader
// (lsof on macOS, /proc on Linux), real `ps`, and the fake dev server in
// tests/fixtures/design-app-server. The fake-reader tests in
// app-attach.test.ts are the oracle for the rules; this file proves the
// darwin and Linux readers give them what they need. It never contacts a
// server: everything is read from the process and socket tables.
//
// The servers are started by a shell that exits at once, so they're no
// descendants of this test process (whose tree the scan treats as Aiden's).
// Each carries a marker argument, and every one is killed in `after`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultSocketReaderDeps, readJobSockets } from "../../follow-through/listening-ports.js";
import { checkAttach, findRebind, rebindHolder, scanRunningServers, type AttachScanDeps } from "./app-attach.js";
import { defaultOsPort } from "./app-ports.js";

const skip = process.platform === "win32" || typeof process.getuid !== "function" ? "attaching reads Unix process tables" : false;
const SERVER = fileURLToPath(new URL("../../../../tests/fixtures/design-app-server/server.mjs", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually<T>(read: () => Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function deps(overrides: Partial<AttachScanDeps> = {}): AttachScanDeps {
  return {
    reader: defaultSocketReaderDeps(),
    uid: process.getuid!(),
    self: process.pid,
    realpath: (target) => realpath(target),
    lstat: (target) => lstat(target),
    excludedPorts: () => new Set(),
    ownedPids: () => new Set(),
    terminalShellPids: () => [],
    ...overrides,
  };
}

const shellQuote = (value: string) => `'${value.split("'").join(`'\\''`)}'`;

async function harness(t: test.TestContext) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-attach-")));
  const workspace = path.join(base, "workspace");
  const web = path.join(workspace, "apps", "web");
  const outside = path.join(base, "outside");
  await mkdir(web, { recursive: true });
  await mkdir(outside, { recursive: true });
  const marker = `--aiden-attach-test=${path.basename(base)}`;
  const direct: number[] = [];
  t.after(async () => {
    for (const pid of direct) if (alive(pid)) process.kill(pid, "SIGKILL");
    try {
      // The pattern is the marker without its dashes, so pkill doesn't read it as an option.
      execFileSync("pkill", ["-KILL", "-f", marker.slice(2)], { stdio: "ignore" });
    } catch {
      // No process left to kill.
    }
    await rm(base, { recursive: true, force: true });
  });

  /** A server whose parent (a shell) exits at once, so it isn't this process's descendant. Resolves to its pid. */
  const startOrphan = async (cwd: string, args: readonly string[]): Promise<number> => {
    const line = [process.execPath, SERVER, ...args, marker].map(shellQuote).join(" ");
    const shell = spawn("/bin/sh", ["-c", `${line} >/dev/null 2>&1 & echo $!`], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    shell.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => shell.once("exit", resolve));
    const pid = Number(out.trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `a pid from the shell: ${out}`);
    return pid;
  };
  /** A server started by this process: part of the test runner's own tree. */
  const startChild = (cwd: string, args: readonly string[]): number => {
    const child = spawn(process.execPath, [SERVER, ...args, marker], { cwd, stdio: "ignore" });
    direct.push(child.pid!);
    return child.pid!;
  };
  const scan = () => scanRunningServers({ workspacePath: workspace, roots: ["apps/web"], busyRoots: new Set() }, deps());
  const listed = (port: number) =>
    eventually(async () => {
      const result = await scan();
      return result.ok ? result.servers.find((server) => server.port === port) : undefined;
    }, `port ${port} to be listed`);
  return { workspace, web, outside, startOrphan, startChild, scan, listed };
}

test("a server started from apps/web on 127.0.0.1 is listed under apps/web with its real process name", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  const server = await h.listed(port);
  assert.equal(server.pid, pid);
  assert.equal(server.appRoot, "apps/web");
  assert.equal(server.folder, "apps/web");
  assert.equal(server.connectable, true);
  assert.equal(server.origin, `http://127.0.0.1:${port}`);
  assert.match(server.processName, /node/iu);
});

test("the same server started from outside the workspace isn't listed", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.outside, ["--host", "127.0.0.1", "--port", String(port)]);
  // Wait until it really listens, by the check that reads the socket table for this port.
  await eventually(
    async () => (await checkAttach({ workspacePath: h.outside, appRoot: ".", port }, deps())).ok,
    "the outside server to listen",
  );
  assert.ok(alive(pid));
  const result = await h.scan();
  assert.ok(result.ok);
  assert.equal(result.servers.some((server) => server.port === port), false);
  const check = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps());
  assert.deepEqual(check, { ok: false, problem: "attach-not-in-app" });
});

test("a server on 0.0.0.0 is listed as not connectable", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  await h.startOrphan(h.web, ["--host", "0.0.0.0", "--port", String(port)]);
  const server = await h.listed(port);
  assert.equal(server.connectable, false);
  assert.equal(server.why, "beyond-loopback");
  assert.equal(server.origin, undefined);
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps()), {
    ok: false,
    problem: "attach-not-loopback",
  });
});

test("a server whose child binds 0.0.0.0 is listed as not connectable", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port), "--fake-child-wildcard"]);
  const server = await eventually(async () => {
    const result = await h.scan();
    const found = result.ok ? result.servers.find((candidate) => candidate.port === port) : undefined;
    // The child starts after the parent listens; wait until its socket shows.
    return found && !found.connectable ? found : undefined;
  }, "the child's wildcard to show");
  assert.equal(server.why, "beyond-loopback");
});

test("checkAttach passes for the loopback server and gives the 127.0.0.1 origin", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  const check = await eventually(async () => {
    const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid }, deps());
    return result.ok ? result : undefined;
  }, "the check to pass");
  assert.equal(check.pid, pid);
  assert.equal(check.origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(check.held, ["127.0.0.1"]);
  assert.equal(check.folder, "apps/web");
  // Bound to the pid: another pid for the same port is refused.
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid: pid + 100_000 }, deps()), {
    ok: false,
    problem: "attach-not-in-app",
  });
});

test("the test runner's own process tree is never listed", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  h.startChild(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  // It listens, as the same scan with another `self` shows.
  await eventually(async () => {
    const result = await scanRunningServers({ workspacePath: h.workspace, roots: ["apps/web"], busyRoots: new Set() }, deps({ self: 1 }));
    return result.ok && result.servers.some((server) => server.port === port);
  }, "the child to listen");
  const result = await h.scan();
  assert.ok(result.ok);
  assert.equal(result.servers.some((server) => server.port === port), false);
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps()), {
    ok: false,
    problem: "attach-not-in-app",
  });
});

test("after the server exits, readJobSockets with its root pid shows no sockets", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  await h.listed(port);
  const before = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
  assert.ok(before?.ok);
  assert.ok(before.sockets.some((socket) => socket.port === port && socket.pid === pid));
  process.kill(pid, "SIGKILL");
  await eventually(async () => !alive(pid), "the server to exit");
  const after = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
  assert.ok(after?.ok);
  assert.deepEqual(after.sockets, []);
  assert.deepEqual(after.rows ?? [], []);
});

test("with --respawn-child, killing the child leaves a new child under the same parent holding the port, which the re-bind rule accepts", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const parent = await h.startOrphan(h.web, ["--respawn-child", "--host", "127.0.0.1", "--port", String(port)]);
  const first = await eventually(async () => {
    const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps());
    return result.ok ? result : undefined;
  }, "the first child to listen");
  assert.notEqual(first.pid, parent, "the child holds the port, not the parent");
  assert.equal(first.ppid, parent);
  process.kill(first.pid, "SIGKILL");
  // Read the old parent's subtree the way the watch does, then apply the pure rule.
  const found = await eventually(async () => {
    const read = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["parent", parent]]))).get("parent");
    if (!read?.ok || !read.rows) return undefined;
    const socketsOf = (pid: number) => read.sockets.filter((socket) => socket.pid === pid);
    const next = rebindHolder(read.rows, socketsOf, { ppid: parent, uid: process.getuid!(), port, held: first.held });
    return next && next.pid !== first.pid ? next : undefined;
  }, "a new child to hold the port");
  assert.equal(found.ppid, parent);
  assert.ok(alive(found.pid));
  // The async helper over a fresh table agrees.
  assert.deepEqual(await findRebind({ ppid: parent, port, held: first.held }, deps()), found);
  // Under launchd or init there's no re-bind.
  assert.equal(await findRebind({ ppid: 1, port, held: first.held }, deps()), undefined);
});
