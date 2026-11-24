import assert from "node:assert/strict";
import test from "node:test";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../../../renderer/shared/design-app.js";
import { BackgroundJobLimitError, type DesignJobView, type DesignLogRead, type StartDesignJobInput } from "../../follow-through/background-jobs.js";
import type { JobSockets } from "../../follow-through/listening-ports.js";
import { WorkspaceMutationGate } from "../../workspace-mutation-gate.js";
import type { CanvasConfig } from "../canvas-config.js";
import { DesignAppConsent, type DesignAppConsentOwner } from "./app-consent.js";
import type { LaunchSurfaceProblem, LaunchSurfaceRead } from "./app-fingerprint.js";
import { missingModuleHint } from "./app-launch-core.js";
import type { DesignAppConsentRecord, DesignAppInstallRecord, DesignAppRecords } from "./app-records.js";
import type { DetectedApp } from "./app-server-core.js";
import {
  DESIGN_APP_INSTALL_TIMEOUT_MS,
  DESIGN_APP_PRESENCE_GRACE_MS,
  DESIGN_APP_READY_CAP_MS,
  DESIGN_APP_READY_IDLE_MS,
  DesignAppServers,
  type DesignAppServersDeps,
  type DesignWorkspace,
} from "./app-server-main.js";
import type { AppToolchain } from "./app-toolchain.js";

// ── Fakes ──

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeClock {
  now = 1_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };
  clear = (id: unknown): void => {
    this.timers.delete(id as number);
  };
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
  pending(): number {
    return this.timers.size;
  }
}

type FakeJob = { input: StartDesignJobInput; view: DesignJobView; tail: string };

class FakeJobs {
  jobs: FakeJob[] = [];
  sockets = new Map<string, JobSockets>();
  socketCalls: string[][] = [];
  stopCalls: string[] = [];
  logReads: Array<{ jobId: string; after: number; maxBytes: number }> = [];
  full = false;
  private listeners = new Set<(view: DesignJobView) => void>();
  constructor(private readonly clock: FakeClock, private readonly order: string[]) {}
  onChange = (listener: (view: DesignJobView) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(job: FakeJob) {
    for (const listener of this.listeners) listener({ ...job.view });
  }
  startDesign = (input: StartDesignJobInput): DesignJobView => {
    if (this.full) throw new BackgroundJobLimitError("Design mode already runs 8 apps.");
    this.order.push(`spawn:${input.argv.args.join(" ")}`);
    const view: DesignJobView = {
      id: `job_${String(this.jobs.length + 1).padStart(8, "0")}`,
      workspaceId: input.workspaceId,
      command: input.display,
      state: "running",
      startedAt: this.clock.now,
      outputBytes: 0,
      owner: "design",
      appRoot: input.appRoot,
      oldestKeptByte: 0,
    };
    this.jobs.push({ input, view, tail: "" });
    return { ...view };
  };
  stopDesign = async (jobId: string): Promise<DesignJobView> => {
    this.stopCalls.push(jobId);
    const job = this.byId(jobId);
    if (job.view.state === "running") {
      job.view = { ...job.view, state: "stopped", endReason: "person", endedAt: this.clock.now };
      this.emit(job);
    }
    return { ...job.view };
  };
  getDesign = (jobId: string) => {
    const job = this.jobs.find((entry) => entry.view.id === jobId);
    return job ? { ...job.view } : undefined;
  };
  designTail = (jobId: string) => this.jobs.find((entry) => entry.view.id === jobId)?.tail ?? "";
  designSockets = async (jobIds: readonly string[]) => {
    this.socketCalls.push([...jobIds]);
    return new Map(jobIds.map((id) => [id, this.sockets.get(id) ?? { ok: true as const, sockets: [] }]));
  };
  readDesignLog = async (jobId: string, options: { after: number; maxBytes: number }): Promise<DesignLogRead> => {
    this.logReads.push({ jobId, ...options });
    const text = this.designTail(jobId).slice(options.after, options.after + options.maxBytes);
    return { text, from: options.after, next: options.after + text.length, truncated: false };
  };
  byId(jobId: string): FakeJob {
    const job = this.jobs.find((entry) => entry.view.id === jobId);
    assert.ok(job, jobId);
    return job;
  }
  last(): FakeJob {
    const job = this.jobs[this.jobs.length - 1];
    assert.ok(job, "a job was started");
    return job;
  }
  /** Like `BackgroundJobs`, output is no change event: readers see it in the view and the tail. */
  output(jobId: string, text: string) {
    const job = this.byId(jobId);
    job.tail += text;
    job.view = { ...job.view, outputBytes: job.view.outputBytes + Buffer.byteLength(text) };
  }
  exit(jobId: string, code: number | null, signal?: string) {
    const job = this.byId(jobId);
    job.view = { ...job.view, state: code === 0 ? "exited" : "failed", exitCode: code, ...(signal ? { signal } : {}), endedAt: this.clock.now };
    this.emit(job);
  }
  /** `stopWorkspace` or quit stopping a job from outside the service. */
  stoppedElsewhere(jobId: string) {
    const job = this.byId(jobId);
    job.view = { ...job.view, state: "stopped", endReason: "access-changed", endedAt: this.clock.now };
    this.emit(job);
  }
  running(): FakeJob[] {
    return this.jobs.filter((job) => job.view.state === "running");
  }
}

function fakeOwner(id = 7, kind?: "remote") {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const owner: DesignAppConsentOwner & { sent: typeof sent } = {
    ...(kind ? { kind } : {}),
    id,
    documentId: `doc-${id}`,
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ channel, payload: payload as Record<string, unknown> });
    },
    onInvalidated: () => () => undefined,
    sent,
  };
  return owner;
}

class FakeViews {
  private counts = new Map<string, number>();
  private listeners = new Set<(workspaceId: string, count: number) => void>();
  constructor(private readonly initial: number) {}
  visible = (workspaceId: string) => this.counts.get(workspaceId) ?? this.initial;
  onPresence = (listener: (workspaceId: string, count: number) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(workspaceId: string, count: number) {
    this.counts.set(workspaceId, count);
    for (const listener of this.listeners) listener(workspaceId, count);
  }
}

function webApp(overrides: Partial<DetectedApp> = {}): DetectedApp {
  return {
    root: ".",
    name: "web",
    kind: "web",
    reason: "ok",
    framework: "vite",
    script: "dev",
    scripts: ["build", "dev"],
    usesReact: true,
    packageManager: { name: "npm", source: "lockfile", lockfile: "package-lock.json", lockfileLevelsUp: 0 },
    installRoot: overrides.root ?? ".",
    installed: true,
    ...overrides,
  };
}

/** `app-records.ts` without the file: the same answers, synchronous underneath, so fake timers settle in a few turns. */
function memoryRecords(): DesignAppRecords {
  const consents = new Map<string, DesignAppConsentRecord>();
  const installs = new Map<string, DesignAppInstallRecord>();
  const ports = new Map<string, number>();
  const key = (workspaceId: string, root: string) => `${workspaceId}\0${root}`;
  return {
    consentOf: async (workspaceId, appRoot) => consents.get(key(workspaceId, appRoot)),
    approveShown: async (workspaceId, appRoot, consent, shown, current) => {
      if (shown !== current) return false;
      consents.set(key(workspaceId, appRoot), { fingerprint: shown, ...consent, at: 1 });
      return true;
    },
    installOf: async (workspaceId, installRoot) => installs.get(key(workspaceId, installRoot)),
    markInstall: async (workspaceId, installRoot, record) => {
      installs.set(key(workspaceId, installRoot), { ...record, at: 1 });
    },
    portOf: async (workspaceId, appRoot) => ports.get(key(workspaceId, appRoot)),
    setPort: async (workspaceId, appRoot, port) => {
      ports.set(key(workspaceId, appRoot), port);
    },
    forgetWorkspace: async (workspaceId) => {
      for (const map of [consents, installs, ports]) for (const name of [...map.keys()]) if (name.startsWith(`${workspaceId}\0`)) map.delete(name);
    },
  };
}

const NODE = "/opt/tools/bin/node";
const MANAGER = "/opt/tools/bin/npm";

interface Options {
  apps?: DetectedApp[];
  config?: CanvasConfig | null;
  visible?: number;
  recovery?: Promise<boolean>;
}

function harness(_t: test.TestContext, options: Options = {}) {
  const clock = new FakeClock();
  const order: string[] = [];
  const jobs = new FakeJobs(clock, order);
  const owner = fakeOwner();
  const views = new FakeViews(options.visible ?? 1);
  const gate = new WorkspaceMutationGate();
  const reports: Array<Record<string, unknown>> = [];
  const statuses: DesignAppsSnapshot[] = [];
  const workspaces = new Map<string, DesignWorkspace>([
    ["ws", { id: "ws", path: "/w/ws", permission: "full" }],
    ["other", { id: "other", path: "/w/other", permission: "full" }],
  ]);
  const state = {
    apps: options.apps ?? [webApp()],
    config: options.config ?? null,
    fingerprints: new Map<string, string>(),
    surfaceProblem: undefined as LaunchSurfaceProblem | undefined,
    toolchain: { ok: true, node: NODE, manager: { name: "npm", path: MANAGER } } as AppToolchain,
    lockHash: "L1",
    calls: { detect: 0, toolchain: 0, fingerprint: 0, config: 0 },
    portCalls: [] as Array<{ sticky?: number; fallback: number }>,
    osPorts: 40_000,
    saved: [] as Array<{ root: string; script: string }>,
  };
  const records = memoryRecords();
  const consent = new DesignAppConsent();
  const deps: DesignAppServersDeps = {
    jobs,
    onJobChange: jobs.onChange,
    detect: async () => {
      state.calls.detect += 1;
      return { apps: state.apps.map((app) => ({ ...app })), truncated: false };
    },
    readConfig: async () => {
      state.calls.config += 1;
      return state.config;
    },
    saveConfigApp: async (_root, app) => {
      order.push(`save:${app.root}:${app.script}`);
      state.saved.push(app);
      return "saved";
    },
    toolchain: async () => {
      state.calls.toolchain += 1;
      return state.toolchain;
    },
    fingerprint: async (_root, app): Promise<LaunchSurfaceRead | LaunchSurfaceProblem> => {
      state.calls.fingerprint += 1;
      if (state.surfaceProblem) return state.surfaceProblem;
      const script = app.script!;
      return {
        fingerprint: state.fingerprints.get(app.root) ?? "F1",
        surface: {
          appRoot: app.root,
          installRoot: app.installRoot,
          lockfileLevelsUp: app.packageManager.lockfileLevelsUp,
          manager: app.packageManager.name,
          script,
          scripts: { [`app:${script}`]: "vite" },
          packageManager: { app: undefined, install: undefined },
          devEngines: { app: undefined, install: undefined },
          installArgv: ["npm", "ci"],
          runArgv: ["npm", "run", script],
          files: [],
        },
        scripts: [{ name: script, text: "vite" }],
        launchFiles: ["vite.config.ts"],
        packageName: app.name,
        lockHash: state.lockHash,
      };
    },
    records,
    choosePort: async (input) => {
      state.portCalls.push(input);
      return input.sticky ?? input.fallback;
    },
    osPort: async () => (state.osPorts += 1),
    consent,
    views,
    workspace: async (id) => {
      const record = workspaces.get(id);
      return record ? { ...record } : undefined;
    },
    gate,
    recoveryReady: options.recovery ?? Promise.resolve(true),
    launchEnv: () => ({ env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-secret", NODE_ENV: "production" }, providerKeys: ["OPENAI_API_KEY"] }),
    report: (event) => reports.push({ ...event }),
    now: () => clock.now,
    timers: { set: clock.set, clear: clock.clear },
    platform: "darwin",
  };
  const servers = new DesignAppServers(deps);
  servers.onStatus((snapshot) => statuses.push(snapshot));
  const cards = () => owner.sent.filter((entry) => entry.channel === "designApp:consent").map((entry) => entry.payload);
  const closedCards = () => owner.sent.filter((entry) => entry.channel === "designApp:consentClosed").map((entry) => entry.payload.requestId);
  const openCard = () => cards().find((card) => !closedCards().includes(card.requestId));
  const answer = async (value: "allow" | "decline") => {
    const card = openCard();
    assert.ok(card, "a card is waiting");
    assert.equal(consent.answer(card.requestId, value, owner), true);
    await settle();
  };
  const input = (overrides: Partial<Parameters<DesignAppServers["start"]>[0]> = {}) => ({
    workspaceId: "ws",
    appRoot: ".",
    by: "person" as const,
    chatId: "chat-1",
    owner,
    permission: "full" as const,
    ...overrides,
  });
  const latest = (appRoot = ".", workspaceId = "ws"): DesignAppStatus | undefined => {
    for (let index = statuses.length - 1; index >= 0; index -= 1) {
      const snapshot = statuses[index]!;
      if (snapshot.workspaceId !== workspaceId) continue;
      const found = snapshot.apps.find((app) => app.appRoot === appRoot);
      if (found) return found;
    }
    return undefined;
  };
  const phases = (appRoot = ".") => {
    const seen: string[] = [];
    for (const snapshot of statuses) {
      const app = snapshot.apps.find((entry) => entry.appRoot === appRoot && snapshot.workspaceId === "ws");
      if (app && seen[seen.length - 1] !== app.phase) seen.push(app.phase);
    }
    return seen;
  };
  /** The server job prints its URL and holds the planned port on 127.0.0.1; one poll later it runs. */
  const makeReady = async (job = jobs.last(), port = plannedPort(job)) => {
    jobs.output(job.view.id, `  ➜  Local:   http://127.0.0.1:${port}/\n`);
    jobs.sockets.set(job.view.id, { ok: true, sockets: [{ pid: 101, address: "127.0.0.1", port }] });
    await clock.advance(500);
  };
  /** Start, allow the card if one shows, and become ready. */
  const runApp = async (overrides: Partial<Parameters<DesignAppServers["start"]>[0]> = {}) => {
    const started = servers.start(input(overrides));
    await settle();
    if (openCard()) await answer("allow");
    await makeReady();
    return started;
  };
  return { servers, deps, clock, jobs, owner, views, gate, reports, statuses, workspaces, state, records, consent, order, cards, openCard, answer, input, latest, phases, makeReady, runApp };
}

function plannedPort(job: FakeJob): number {
  const args = job.input.argv.args;
  const index = args.indexOf("--port");
  return index >= 0 ? Number(args[index + 1]) : Number(job.input.env.PORT);
}

// ── Starting ──

test("the first start asks, and Allow installs when node_modules is missing, then starts, then runs at http://127.0.0.1:<port>", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const started = h.servers.start(h.input());
  await settle();
  const card = h.openCard();
  assert.ok(card);
  assert.equal(card.kind, "launch");
  assert.equal(card.reason, "first");
  assert.equal(card.appRoot, ".");
  assert.equal(card.frameworkLabel, "Vite");
  assert.equal(card.packageName, "web");
  assert.equal(card.runCommand, "npm run dev");
  assert.equal(card.installCommand, "npm ci");
  assert.deepEqual(card.scripts, [{ name: "dev", text: "vite" }]);
  assert.deepEqual(card.launchFiles, ["vite.config.ts"]);
  assert.equal(card.savesChoice, false);
  assert.equal(h.jobs.jobs.length, 0, "nothing runs before Allow");

  await h.answer("allow");
  const install = h.jobs.last();
  assert.deepEqual(install.input.argv, { file: MANAGER, args: ["ci"] });
  assert.equal(install.input.cwd, "/w/ws");
  assert.equal((await h.records.installOf("ws", "."))?.state, "started");

  h.state.apps = [webApp({ installed: true })];
  h.jobs.exit(install.view.id, 0);
  await settle();
  assert.equal((await h.records.installOf("ws", "."))?.state, "done");
  const server = h.jobs.last();
  assert.notEqual(server, install);
  assert.deepEqual(server.input.argv, { file: MANAGER, args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"] });
  assert.equal(server.input.env.OPENAI_API_KEY, undefined, "provider keys are scrubbed");
  assert.equal(server.input.env.NODE_ENV, undefined);
  assert.equal(server.input.env.BROWSER, "none");
  assert.ok(server.input.env.PATH?.startsWith("/opt/tools/bin"));

  await h.makeReady();
  const status = await started;
  assert.equal(status.phase, "running");
  assert.equal(status.origin, "http://127.0.0.1:5173");
  assert.equal(status.port, 5173);
  assert.equal(status.startedBy, "person");
  assert.equal(status.manager, "npm");
  assert.equal(status.script, "dev");
  assert.deepEqual(h.phases(), ["consent", "installing", "starting", "running"]);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "running" }]);
});

test("a second start with the same fingerprint asks nothing", async (t) => {
  const h = harness(t);
  await h.runApp();
  await h.servers.stop("ws", ".");
  const again = h.servers.start(h.input());
  await settle();
  assert.equal(h.openCard(), undefined);
  await h.makeReady();
  assert.equal((await again).phase, "running");
  assert.equal(h.cards().length, 1);
});

test("a start while running answers running, and a changed script asks again with reason changed; Not now leaves it stopped with consent-declined", async (t) => {
  const h = harness(t);
  await h.runApp();
  assert.equal((await h.servers.start(h.input())).phase, "running");
  assert.equal(h.jobs.jobs.length, 1);
  await h.servers.stop("ws", ".");
  h.state.fingerprints.set(".", "F2");
  const again = h.servers.start(h.input());
  await settle();
  assert.equal(h.openCard()?.reason, "changed");
  await h.answer("decline");
  const status = await again;
  assert.equal(status.phase, "stopped");
  assert.deepEqual(status.problem, { problem: "consent-declined" });
  assert.equal(h.jobs.jobs.length, 1, "no new job");
  assert.equal(h.reports.length, 1, "a decline sends nothing");
});

test("a consent given without the install line asks again with reason install when an install becomes needed", async (t) => {
  const h = harness(t);
  await h.runApp();
  assert.equal((await h.records.consentOf("ws", "."))?.installShown, false);
  await h.servers.stop("ws", ".");
  h.state.apps = [webApp({ installed: false })];
  void h.servers.start(h.input());
  await settle();
  assert.equal(h.openCard()?.reason, "install");
  assert.equal(h.openCard()?.installCommand, "npm ci");
});

test("before each spawn, detection, toolchain and fingerprint run again", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const install = h.jobs.last();
  const before = { ...h.state.calls };
  h.state.apps = [webApp({ installed: true })];
  h.state.fingerprints.set(".", "F2");
  h.jobs.exit(install.view.id, 0);
  await settle();
  assert.ok(h.state.calls.detect > before.detect && h.state.calls.toolchain > before.toolchain && h.state.calls.fingerprint > before.fingerprint);
  assert.equal(h.jobs.jobs.length, 1, "the changed repo is not started");
  assert.equal(h.openCard()?.reason, "changed", "a second card");
  await h.answer("allow");
  await h.makeReady();
  assert.equal((await started).phase, "running");
  assert.equal((await h.records.consentOf("ws", "."))?.fingerprint, "F2");

  // A changed manager path is the environment, not the repo: no card, the new path runs.
  await h.servers.stop("ws", ".");
  h.state.toolchain = { ok: true, node: "/usr/local/bin/node", manager: { name: "npm", path: "/usr/local/bin/npm" } };
  const cardsBefore = h.cards().length;
  const again = h.servers.start(h.input());
  await settle();
  assert.equal(h.cards().length, cardsBefore);
  assert.equal(h.jobs.last().input.argv.file, "/usr/local/bin/npm");
  await h.makeReady();
  assert.equal((await again).phase, "running");
});

test("a repo change between the card and Allow asks again with reason changed, and nothing runs until the new card is allowed", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  assert.equal(h.openCard()?.reason, "first");
  h.state.fingerprints.set(".", "F2");
  await h.answer("allow");
  assert.equal(h.jobs.jobs.length, 0);
  assert.equal(await h.records.consentOf("ws", "."), undefined, "the shown fingerprint is not stored");
  assert.equal(h.openCard()?.reason, "changed");
  await h.answer("allow");
  await h.makeReady();
  assert.equal((await started).phase, "running");
  assert.equal((await h.records.consentOf("ws", "."))?.fingerprint, "F2");
});

test("with permission none, a read-only caller, or a Remote owner, start, restart and choose are refused with no-access or desktop-only, and nothing is read", async (t) => {
  const h = harness(t);
  await h.runApp();
  await h.servers.stop("ws", ".");
  const calls = { ...h.state.calls };
  const remote = fakeOwner(0, "remote");
  const refusals: Array<[Promise<DesignAppStatus>, string]> = [
    [h.servers.start(h.input({ permission: "none" })), "no-access"],
    [h.servers.start(h.input({ permission: "read-only" })), "no-access"],
    [h.servers.start(h.input({ owner: remote })), "desktop-only"],
    [h.servers.start(h.input({ owner: undefined })), "desktop-only"],
    [h.servers.start(h.input({ owner: fakeOwner(0) })), "desktop-only"],
    [h.servers.restart(h.input({ owner: remote })), "desktop-only"],
    [h.servers.restart(h.input({ permission: "none" })), "no-access"],
    [h.servers.choose({ ...h.input({ owner: remote }), appRoot: "." }), "desktop-only"],
    [h.servers.choose({ ...h.input({ permission: "read-only" }), appRoot: "." }), "no-access"],
  ];
  for (const [result, problem] of refusals) assert.equal((await result).problem?.problem, problem);
  assert.deepEqual(h.state.calls, calls, "no detection, config, toolchain or fingerprint read");
  assert.equal(remote.sent.length, 0);
  assert.equal(h.jobs.jobs.length, 1);
});

test("start waits for recoveryReady, and a failed recovery ends with recovery-failed", async (t) => {
  let finish!: (ready: boolean) => void;
  const h = harness(t, { recovery: new Promise<boolean>((resolve) => (finish = resolve)) });
  const started = h.servers.start(h.input());
  await settle();
  assert.equal(h.state.calls.detect, 0, "nothing is read before recovery");
  finish(false);
  const status = await started;
  assert.deepEqual(status.problem, { problem: "recovery-failed" });
  assert.equal(h.state.calls.detect, 0);
  assert.equal(h.reports.length, 0);
});

test("a toolchain problem ends the attempt with that problem and sends design_app_started failed without manager", async (t) => {
  const h = harness(t);
  h.state.toolchain = { ok: false, problem: "manager-missing", manager: "npm" };
  const status = await h.servers.start(h.input());
  assert.deepEqual(status.problem, { problem: "manager-missing", manager: "npm" });
  assert.equal(status.phase, "stopped");
  assert.equal(h.cards().length, 0, "no card for an app that can't run");
  assert.deepEqual(h.reports, [{ framework: "vite", outcome: "failed" }]);
});

test("a launch file Aiden can't read refuses the start without a card", async (t) => {
  const h = harness(t);
  h.state.surfaceProblem = { problem: "launch-file-unreadable", file: "vite.config.ts" };
  const status = await h.servers.start(h.input());
  assert.deepEqual(status.problem, { problem: "launch-file-unreadable", file: "vite.config.ts" });
  assert.equal(h.cards().length, 0);
  assert.equal(h.reports.length, 0);
});

test("node_modules present and no install record skips the install; a started record reinstalls; restart with install reinstalls", async (t) => {
  const h = harness(t);
  await h.runApp();
  assert.equal(h.jobs.jobs.length, 1, "no install");
  await h.servers.stop("ws", ".");
  await h.records.markInstall("ws", ".", { state: "started", manager: "npm", lockHash: "L1" });
  void h.servers.start(h.input());
  await settle();
  await h.answer("allow"); // the old consent didn't show the install line
  assert.deepEqual(h.jobs.last().input.argv.args, ["ci"]);
  h.jobs.exit(h.jobs.last().view.id, 0);
  await settle();
  await h.makeReady();
  const count = h.jobs.jobs.length;
  const restarted = h.servers.restart({ ...h.input(), install: true });
  await settle();
  assert.deepEqual(h.jobs.jobs[count]!.input.argv.args, ["ci"], "restart with install reinstalls");
  h.jobs.exit(h.jobs.jobs[count]!.view.id, 0);
  await settle();
  await h.makeReady();
  assert.equal((await restarted).phase, "running");
});

test("an enclosing lockfile never installs: with node_modules it starts, without it ends with install-outside-workspace", async (t) => {
  const enclosing = { name: "npm" as const, source: "enclosing" as const, lockfile: "package-lock.json", lockfileLevelsUp: 1 };
  const h = harness(t, { apps: [webApp({ packageManager: enclosing, installed: true })] });
  await h.runApp();
  assert.equal(h.jobs.jobs.length, 1);
  assert.notDeepEqual(h.jobs.jobs[0]!.input.argv.args, ["ci"]);
  await h.servers.stop("ws", ".");
  h.state.apps = [webApp({ packageManager: enclosing, installed: false })];
  const status = await h.servers.start(h.input());
  assert.deepEqual(status.problem, { problem: "install-outside-workspace" });
  assert.equal(h.jobs.jobs.length, 1);
  assert.deepEqual(h.reports[h.reports.length - 1], { framework: "vite", manager: "npm", outcome: "failed" });
});

test("an install exit 1 gives install-failed with the last lines, and the record stays started", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const install = h.jobs.last();
  h.jobs.output(install.view.id, "npm ERR! code ERESOLVE\nnpm ERR! could not resolve\n");
  h.jobs.exit(install.view.id, 1);
  const status = await started;
  assert.equal(status.problem?.problem, "install-failed");
  assert.equal((status.problem as { exitCode: number }).exitCode, 1);
  assert.match((status.problem as { tail: string }).tail, /could not resolve/u);
  assert.equal((await h.records.installOf("ws", "."))?.state, "started");
  assert.equal(h.jobs.jobs.length, 1);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "failed" }]);
});

test("an install past 15 minutes is stopped with install-timeout", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  await h.clock.advance(DESIGN_APP_INSTALL_TIMEOUT_MS - 1);
  assert.equal(h.jobs.stopCalls.length, 0);
  await h.clock.advance(1);
  const status = await started;
  assert.deepEqual(status.problem, { problem: "install-timeout" });
  assert.deepEqual(h.jobs.stopCalls, [h.jobs.jobs[0]!.view.id]);
});

test("two chats starting the same app share one attempt, one card and one job", async (t) => {
  const h = harness(t);
  const first = h.servers.start(h.input());
  const second = h.servers.start(h.input({ chatId: "chat-2" }));
  await settle();
  assert.equal(h.cards().length, 1);
  await h.answer("allow");
  await h.makeReady();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.phase, "running");
  assert.equal(b.phase, "running");
  assert.equal(h.jobs.jobs.length, 1);
});

test("a ninth design server gives job-limit", async (t) => {
  const h = harness(t);
  h.jobs.full = true;
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const status = await started;
  assert.deepEqual(status.problem, { problem: "job-limit" });
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "failed" }]);
});

// ── Workspace changes ──

test("a workspace mutation that begins during consent or install aborts the attempt and stops its job", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const duringConsent = h.servers.start(h.input());
  await settle();
  const end = h.gate.begin("ws");
  assert.deepEqual((await duringConsent).problem, { problem: "interrupted" });
  assert.equal(h.openCard(), undefined, "the card closed");
  end();

  const duringInstall = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const install = h.jobs.last();
  const release = h.gate.begin("ws");
  assert.deepEqual((await duringInstall).problem, { problem: "interrupted" });
  assert.deepEqual(h.jobs.stopCalls, [install.view.id]);
  release();
  assert.equal(h.reports.length, 0);
});

test("a rename-only update ends the attempt with interrupted; a permission change to none or a removed folder gives no-access", async (t) => {
  const h = harness(t);
  for (const [change, problem] of [
    [() => undefined, "interrupted"],
    [() => h.workspaces.set("ws", { id: "ws", path: "/w/ws", permission: "none" }), "no-access"],
    [() => h.workspaces.delete("ws"), "no-access"],
  ] as const) {
    const started = h.servers.start(h.input());
    await settle();
    change();
    const end = h.gate.begin("ws");
    assert.deepEqual((await started).problem, { problem }, problem);
    end();
    h.workspaces.set("ws", { id: "ws", path: "/w/ws", permission: "full" });
  }
});

test("a running server whose workspace folder path changes is stopped", async (t) => {
  const h = harness(t);
  await h.runApp();
  h.workspaces.set("ws", { id: "ws", path: "/w/moved", permission: "full" });
  await h.clock.advance(2_000);
  assert.equal(h.jobs.stopCalls.length, 1);
  assert.equal(h.latest()?.phase, "stopped");
});

// ── Readiness and exposure ──

test("a printed URL on a port the job doesn't own never makes it ready, and 120 s without output stops it with not-ready", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const job = h.jobs.last();
  h.jobs.output(job.view.id, "Local: http://127.0.0.1:5173/\n");
  h.jobs.sockets.set(job.view.id, { ok: true, sockets: [] });
  // The next poll sees the output; 120 s of silence count from there.
  await h.clock.advance(500);
  await h.clock.advance(DESIGN_APP_READY_IDLE_MS - 1);
  assert.equal(h.latest()?.phase, "starting");
  await h.clock.advance(1);
  const status = await started;
  assert.equal(status.problem?.problem, "not-ready");
  assert.match((status.problem as { tail: string }).tail, /127\.0\.0\.1:5173/u);
  assert.deepEqual(h.jobs.stopCalls, [job.view.id]);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "failed" }]);
});

test("output resets the readiness timer, and the 10-minute cap stops it anyway", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const job = h.jobs.last();
  let elapsed = 0;
  while (elapsed + 100_000 < DESIGN_APP_READY_CAP_MS) {
    await h.clock.advance(100_000);
    elapsed += 100_000;
    h.jobs.output(job.view.id, "compiling…\n");
    await settle();
    assert.equal(h.latest()?.phase, "starting", `still starting at ${elapsed}`);
  }
  await h.clock.advance(DESIGN_APP_READY_CAP_MS - elapsed);
  assert.equal((await started).problem?.problem, "not-ready");
});

test("a wildcard socket stops the job with exposed, even after it printed a loopback URL", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const job = h.jobs.last();
  h.jobs.output(job.view.id, "Local: http://127.0.0.1:5173/\n");
  h.jobs.sockets.set(job.view.id, {
    ok: true,
    sockets: [
      { pid: 1, address: "127.0.0.1", port: 5173 },
      { pid: 1, address: "*", port: 5173 },
    ],
  });
  await h.clock.advance(500);
  const status = await started;
  assert.deepEqual(status.problem, { problem: "exposed" });
  assert.deepEqual(h.jobs.stopCalls, [job.view.id]);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "failed" }]);
});

test("a socket that turns wildcard while running is caught on the next 2 s poll", async (t) => {
  const h = harness(t);
  await h.runApp();
  const job = h.jobs.last();
  h.jobs.sockets.set(job.view.id, { ok: true, sockets: [{ pid: 1, address: "127.0.0.1", port: 5173 }, { pid: 2, address: "::", port: 9000 }] });
  await h.clock.advance(1_999);
  assert.equal(h.latest()?.phase, "running");
  await h.clock.advance(1);
  assert.equal(h.latest()?.phase, "stopped");
  assert.deepEqual(h.latest()?.problem, { problem: "exposed" });
});

test("failed socket reads never mark it running; three in a row while running stop it with exposure-unknown, and one success resets the count", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const job = h.jobs.last();
  h.jobs.output(job.view.id, "Local: http://127.0.0.1:5173/\n");
  h.jobs.sockets.set(job.view.id, { ok: false, reason: "lsof timed out" });
  await h.clock.advance(5_000);
  assert.equal(h.latest()?.phase, "starting");
  h.jobs.sockets.set(job.view.id, { ok: true, sockets: [{ pid: 1, address: "127.0.0.1", port: 5173 }] });
  await h.clock.advance(500);
  assert.equal((await started).phase, "running");
  const fail = () => h.jobs.sockets.set(job.view.id, { ok: false, reason: "lsof timed out" });
  const succeed = () => h.jobs.sockets.set(job.view.id, { ok: true, sockets: [{ pid: 1, address: "127.0.0.1", port: 5173 }] });
  fail();
  await h.clock.advance(4_000);
  succeed();
  await h.clock.advance(2_000);
  fail();
  await h.clock.advance(4_000);
  assert.equal(h.latest()?.phase, "running", "two failures after a success");
  await h.clock.advance(2_000);
  assert.equal(h.latest()?.phase, "stopped");
  assert.deepEqual(h.latest()?.problem, { problem: "exposure-unknown" });
});

test("an address-in-use exit during starting retries once on a new port; a second one is a crash", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const first = h.jobs.last();
  h.jobs.output(first.view.id, "Error: Port 5173 is already in use\n");
  h.jobs.exit(first.view.id, 1);
  await settle();
  const second = h.jobs.last();
  assert.notEqual(second, first);
  assert.equal(plannedPort(second), 40_001);
  assert.equal(h.cards().length, 1, "no second card");
  h.jobs.output(second.view.id, "Error: listen EADDRINUSE: address already in use 127.0.0.1:40001\n");
  h.jobs.exit(second.view.id, 1);
  const status = await started;
  assert.equal(status.phase, "crashed");
  assert.equal(status.exitCode, 1);
  assert.equal(h.jobs.jobs.length, 2);
  assert.deepEqual(h.reports, [{ framework: "vite", manager: "npm", outcome: "crashed" }]);
});

test("the ready port is recorded as the sticky port", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  // The script's own port wins: the job prints and holds 5199.
  await h.makeReady(h.jobs.last(), 5199);
  assert.equal((await started).port, 5199);
  assert.equal(await h.records.portOf("ws", "."), 5199);
  await h.servers.stop("ws", ".");
  void h.servers.start(h.input());
  await settle();
  assert.deepEqual(h.state.portCalls[h.state.portCalls.length - 1], { sticky: 5199, fallback: 5173 });
});

test("two servers share one designSockets call per tick: every 500 ms while either is starting, every 2 s once both run, and no ticks once both stop", async (t) => {
  const h = harness(t, { apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b", name: "b" })] });
  const a = h.servers.start(h.input({ appRoot: "apps/a" }));
  await settle();
  await h.answer("allow");
  const b = h.servers.start(h.input({ appRoot: "apps/b" }));
  await settle();
  await h.answer("allow");
  const [jobA, jobB] = h.jobs.jobs;
  h.jobs.socketCalls.length = 0;
  await h.clock.advance(1_000);
  assert.deepEqual(h.jobs.socketCalls, [[jobA!.view.id, jobB!.view.id], [jobA!.view.id, jobB!.view.id]]);
  await h.makeReady(jobA!, 5173);
  h.jobs.sockets.set(jobB!.view.id, { ok: true, sockets: [{ pid: 2, address: "127.0.0.1", port: 5174 }] });
  await h.clock.advance(500);
  await Promise.all([a, b]);
  h.jobs.socketCalls.length = 0;
  await h.clock.advance(4_000);
  assert.equal(h.jobs.socketCalls.length, 2, "every 2 s once both run");
  await h.servers.stop("ws", "apps/a");
  await h.servers.stop("ws", "apps/b");
  h.jobs.socketCalls.length = 0;
  await h.clock.advance(10_000);
  assert.equal(h.jobs.socketCalls.length, 0);
});

// ── Crash, stop and restart ──

test("an exit while running is crashed with the exit code and at most 20 lines, and nothing restarts it", async (t) => {
  const h = harness(t);
  await h.runApp();
  const job = h.jobs.last();
  h.jobs.output(job.view.id, Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n");
  h.jobs.exit(job.view.id, 1);
  await settle();
  const status = h.latest()!;
  assert.equal(status.phase, "crashed");
  assert.equal(status.exitCode, 1);
  assert.equal(status.tail?.split("\n").length, 20);
  assert.ok(status.tail!.endsWith("line 39"));
  await h.clock.advance(60_000);
  assert.equal(h.jobs.jobs.length, 1);
  assert.equal(h.reports.length, 1, "only the running event");
});

test("an exit with code 0 while running is crashed", async (t) => {
  const h = harness(t);
  await h.runApp();
  h.jobs.exit(h.jobs.last().view.id, 0);
  await settle();
  assert.equal(h.latest()?.phase, "crashed");
  assert.equal(h.latest()?.exitCode, 0);
});

test('a crash tail with "Cannot find module" carries the install hint', async (t) => {
  const h = harness(t);
  await h.runApp();
  const job = h.jobs.last();
  h.jobs.output(job.view.id, "Error: Cannot find module 'react'\n");
  h.jobs.exit(job.view.id, 1);
  await settle();
  assert.equal(missingModuleHint(h.latest()!.tail!), "Try design_app restart with install: true.");
});

test("stop ends the job and leaves stopped with no problem; a second stop is a no-op", async (t) => {
  const h = harness(t);
  await h.runApp();
  const stopped = await h.servers.stop("ws", ".");
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.problem, undefined);
  assert.equal(stopped.origin, undefined);
  assert.equal((await h.servers.stop("ws", ".")).phase, "stopped");
  assert.equal(h.jobs.stopCalls.length, 1);
});

test("stop during consent closes the card; stop during install stops the install", async (t) => {
  const h = harness(t, { apps: [webApp({ installed: false })] });
  const asking = h.servers.start(h.input());
  await settle();
  await h.servers.stop("ws", ".");
  const ended = await asking;
  assert.equal(ended.phase, "stopped");
  assert.equal(ended.problem, undefined);
  assert.equal(h.openCard(), undefined);

  const installing = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  const install = h.jobs.last();
  await h.servers.stop("ws", ".");
  assert.equal((await installing).phase, "stopped");
  assert.deepEqual(h.jobs.stopCalls, [install.view.id]);
  assert.equal(h.reports.length, 0, "a stop before ready sends nothing");
});

test("restart keeps the port and runs the D5 checks again", async (t) => {
  const h = harness(t);
  const started = h.servers.start(h.input());
  await settle();
  await h.answer("allow");
  await h.makeReady(h.jobs.last(), 5180);
  await started;
  const calls = h.state.calls.fingerprint;
  const restarted = h.servers.restart({ ...h.input() });
  await settle();
  assert.ok(h.state.calls.fingerprint > calls);
  assert.equal(plannedPort(h.jobs.last()), 5180);
  await h.makeReady();
  assert.equal((await restarted).port, 5180);
  // A repo change between restarts asks again.
  h.state.fingerprints.set(".", "F9");
  void h.servers.restart({ ...h.input() });
  await settle();
  assert.equal(h.openCard()?.reason, "changed");
});

// ── Presence and lifecycle ──

test("60 s after the last visible canvas of a workspace goes, its servers stop; becoming visible within 60 s keeps them", async (t) => {
  const h = harness(t);
  await h.runApp();
  h.views.set("ws", 0);
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS - 1);
  h.views.set("ws", 1);
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS * 2);
  assert.equal(h.latest()?.phase, "running");
  h.views.set("ws", 0);
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS);
  assert.equal(h.latest()?.phase, "stopped");
  assert.equal(h.latest()?.problem, undefined);
  assert.equal(h.jobs.stopCalls.length, 1);
});

test("a server started while nothing is visible stops 60 s later", async (t) => {
  const h = harness(t, { visible: 0 });
  await h.runApp();
  assert.equal(h.latest()?.phase, "running");
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS);
  assert.equal(h.latest()?.phase, "stopped");
});

test("presence in another workspace changes nothing here", async (t) => {
  const h = harness(t);
  await h.runApp();
  h.views.set("other", 0);
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS * 2);
  assert.equal(h.latest()?.phase, "running");
});

test("the job stopped from stopWorkspace marks the app stopped", async (t) => {
  const h = harness(t);
  await h.runApp();
  h.jobs.stoppedElsewhere(h.jobs.last().view.id);
  await settle();
  assert.equal(h.latest()?.phase, "stopped");
  assert.equal(h.latest()?.problem, undefined);
});

test("forgetWorkspace stops timers, clears statuses and isAppOrigin entries, and forgets records", async (t) => {
  const h = harness(t);
  await h.runApp();
  assert.equal(h.servers.isAppOrigin("http://127.0.0.1:5173"), true);
  await h.servers.forgetWorkspace("ws");
  assert.equal(h.servers.isAppOrigin("http://127.0.0.1:5173"), false);
  assert.equal(h.servers.appForOrigin("http://127.0.0.1:5173"), undefined);
  assert.equal(await h.records.consentOf("ws", "."), undefined);
  assert.equal(await h.records.portOf("ws", "."), undefined);
  assert.equal(h.jobs.running().length, 0);
  assert.equal(h.clock.pending(), 0, "no timers left");
  const snapshot = await h.servers.snapshot("ws");
  assert.ok(snapshot.apps.every((app) => app.phase === "stopped" && app.revision === 0));
});

test("constructing the service and restoring views never starts, probes or reads anything", async () => {
  const thrower = (name: string): never => {
    throw new Error(`${name} used`);
  };
  const explode = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, key) => (key === "then" ? undefined : () => thrower(`${name}.${String(key)}`)),
      },
    );
  const presence = new Set<(workspaceId: string, count: number) => void>();
  const clock = new FakeClock();
  const servers = new DesignAppServers({
    jobs: explode("jobs") as DesignAppServersDeps["jobs"],
    onJobChange: () => () => undefined,
    detect: () => thrower("detect"),
    readConfig: () => thrower("readConfig"),
    saveConfigApp: () => thrower("saveConfigApp"),
    toolchain: () => thrower("toolchain"),
    fingerprint: () => thrower("fingerprint"),
    records: explode("records") as DesignAppServersDeps["records"],
    choosePort: () => thrower("choosePort"),
    osPort: () => thrower("osPort"),
    consent: explode("consent") as DesignAppServersDeps["consent"],
    views: {
      visible: () => thrower("views.visible"),
      onPresence: (listener) => {
        presence.add(listener);
        return () => presence.delete(listener);
      },
    },
    workspace: () => thrower("workspace"),
    gate: explode("gate") as DesignAppServersDeps["gate"],
    recoveryReady: Promise.resolve(true),
    launchEnv: () => thrower("launchEnv"),
    report: () => thrower("report"),
    now: () => clock.now,
    timers: { set: clock.set, clear: clock.clear },
    platform: "darwin",
  });
  for (const listener of presence) {
    listener("ws", 1);
    listener("ws", 0);
  }
  await clock.advance(DESIGN_APP_PRESENCE_GRACE_MS * 3);
  assert.equal(servers.isAppOrigin("http://127.0.0.1:5173"), false);
  assert.equal(clock.pending(), 0);
});

// ── Toggle and choose ──

test("designModeEntered starts the single web app", async (t) => {
  const h = harness(t);
  h.servers.designModeEntered({ chatId: "chat-1", workspaceId: "ws", owner: h.owner });
  await settle();
  assert.equal(h.openCard()?.appRoot, ".");
  await h.answer("allow");
  await h.makeReady();
  assert.equal(h.latest()?.phase, "running");
  assert.equal(h.latest()?.startedBy, "person");
});

test("designModeEntered with two web apps and no described roots starts nothing, and the snapshot target is choose", async (t) => {
  const h = harness(t, { apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b" })] });
  h.servers.designModeEntered({ chatId: "chat-1", workspaceId: "ws", owner: h.owner });
  await settle();
  assert.equal(h.cards().length, 0);
  assert.equal(h.jobs.jobs.length, 0);
  const snapshot = await h.servers.snapshot("ws");
  assert.equal(snapshot.target, "choose");
  assert.deepEqual(snapshot.candidates.map((candidate) => candidate.appRoot), ["apps/a", "apps/b"]);
});

test("described roots in .aiden/canvas.json start in turn, each with its own card; a designMd-only entry describes nothing", async (t) => {
  const h = harness(t, {
    apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b", scripts: ["dev", "start"] }), webApp({ root: "apps/c" })],
    config: { version: 1, apps: [{ root: "apps/b", script: "start" }, { root: "apps/a", script: "dev" }, { root: "apps/c", designMd: "DESIGN.md" }] },
  });
  h.servers.designModeEntered({ chatId: "chat-1", workspaceId: "ws", owner: h.owner });
  await settle();
  assert.equal(h.openCard()?.appRoot, "apps/b");
  assert.equal(h.openCard()?.runCommand, "npm run start");
  await h.answer("allow");
  await h.makeReady();
  assert.equal(h.openCard()?.appRoot, "apps/a");
  await h.answer("allow");
  await h.makeReady();
  await settle();
  assert.equal(h.cards().length, 2);
  assert.deepEqual(h.jobs.jobs.map((job) => job.input.appRoot), ["apps/b", "apps/a"]);
  assert.deepEqual(h.jobs.jobs[0]!.input.argv.args.slice(0, 2), ["run", "start"]);
  assert.deepEqual((await h.servers.snapshot("ws")).chosen, ["apps/b", "apps/a"]);
});

test("a described entry naming a non-web root, a missing script or an unsafe name is ignored", async (t) => {
  const h = harness(t, {
    apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b" }), webApp({ root: "apps/native", kind: "react-nonweb", reason: "react-native" })],
    config: {
      version: 1,
      apps: [
        { root: "apps/native", script: "dev" },
        { root: "apps/a", script: "storybook" },
        { root: "apps/b", script: "dev; rm -rf /" },
      ],
    },
  });
  h.servers.designModeEntered({ chatId: "chat-1", workspaceId: "ws", owner: h.owner });
  await settle();
  assert.equal(h.cards().length, 0);
  assert.equal(h.jobs.jobs.length, 0);
});

test("choose shows a card with reason choose and savesChoice, and Allow calls saveCanvasConfigApp before starting", async (t) => {
  const h = harness(t, { apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b", scripts: ["dev", "start"] })] });
  const chosen = h.servers.choose({ ...h.input(), appRoot: "apps/b", script: "start" });
  await settle();
  const card = h.openCard();
  assert.equal(card?.reason, "choose");
  assert.equal(card?.savesChoice, true);
  assert.equal(card?.runCommand, "npm run start");
  assert.deepEqual(h.state.saved, [], "nothing is saved before Allow");
  await h.answer("allow");
  assert.deepEqual(h.order.slice(0, 2), ["save:apps/b:start", "spawn:run start -- --host 127.0.0.1 --port 5173 --strictPort"]);
  await h.makeReady();
  assert.equal((await chosen).phase, "running");
});

test("choose on a react-nonweb or unknown-framework root is refused with not-web", async (t) => {
  const h = harness(t, {
    apps: [
      webApp({ root: "apps/native", kind: "react-nonweb", reason: "react-native" }),
      webApp({ root: "apps/odd", kind: "none", reason: "unknown-framework", framework: undefined }),
    ],
  });
  for (const appRoot of ["apps/native", "apps/odd", "apps/missing"]) {
    assert.deepEqual((await h.servers.choose({ ...h.input(), appRoot })).problem, { problem: "not-web" }, appRoot);
  }
  assert.deepEqual((await h.servers.choose({ ...h.input(), appRoot: "apps/native", script: "rm -rf" })).problem, { problem: "not-web" });
  assert.equal(h.cards().length, 0);
});

test("a chat moved to another workspace with design mode on starts nothing there", async (t) => {
  const h = harness(t);
  // A move is not a false → true change: only its presence and snapshot reads reach the service.
  h.views.set("other", 1);
  await h.servers.snapshot("other");
  await h.clock.advance(DESIGN_APP_PRESENCE_GRACE_MS);
  assert.equal(h.cards().length, 0);
  assert.equal(h.jobs.jobs.length, 0);
  assert.equal(h.state.calls.fingerprint + h.state.calls.toolchain, 0);
});

// ── 3a and 2c contract ──

test("appForOrigin matches only the exact address and port the running job holds", async (t) => {
  const h = harness(t);
  await h.runApp();
  const key = { workspaceId: "ws", appRoot: "." };
  assert.deepEqual(h.servers.appForOrigin("http://127.0.0.1:5173"), key);
  for (const origin of ["http://localhost:5173", "http://[::1]:5173", "http://127.0.0.1:5174", "http://localhost.evil.com:5173", "https://127.0.0.1:5173", "http://127.0.0.1:5173/path", "nonsense"]) {
    assert.equal(h.servers.appForOrigin(origin), undefined, origin);
  }
  h.jobs.sockets.set(h.jobs.last().view.id, {
    ok: true,
    sockets: [
      { pid: 1, address: "127.0.0.1", port: 5173 },
      { pid: 1, address: "::1", port: 5173 },
    ],
  });
  await h.clock.advance(2_000);
  assert.deepEqual(h.servers.appForOrigin("http://[::1]:5173"), key);
  assert.equal(h.servers.appForOrigin("http://localhost:5173"), undefined);
});

test("isAppOrigin stays true for every origin served this session after the server stops, until forgetWorkspace", async (t) => {
  const h = harness(t);
  await h.runApp();
  await h.servers.stop("ws", ".");
  assert.equal(h.servers.appForOrigin("http://127.0.0.1:5173"), undefined);
  assert.equal(h.servers.isAppOrigin("http://127.0.0.1:5173"), true);
  assert.equal(h.servers.isAppOrigin("http://localhost:5173"), true, "the localhost alias");
  assert.equal(h.servers.isAppOrigin("http://127.0.0.1:5174"), false);
  await h.servers.forgetWorkspace("ws");
  assert.equal(h.servers.isAppOrigin("http://localhost:5173"), false);
});

test("onOriginsChanged fires when a server starts and stops running", async (t) => {
  const h = harness(t);
  let changes = 0;
  h.servers.onOriginsChanged(() => (changes += 1));
  await h.runApp();
  assert.equal(changes, 1);
  await h.servers.stop("ws", ".");
  assert.equal(changes, 2);
});

test("logs pass the byte cursor through and cap at maxBytes", async (t) => {
  const h = harness(t);
  await h.runApp();
  const logs = await h.servers.logs("ws", ".", { after: 4, maxBytes: 10 });
  assert.deepEqual(h.jobs.logReads[0], { jobId: h.jobs.last().view.id, after: 4, maxBytes: 10 });
  assert.equal(logs.from, 4);
  await h.servers.logs("ws", ".", { after: 0, maxBytes: 10 * 1024 * 1024 });
  assert.equal(h.jobs.logReads[1]!.maxBytes, 64 * 1024);
  assert.deepEqual(await h.servers.logs("ws", "apps/none", { maxBytes: 100 }), { text: "", from: 0, next: 0, truncated: false });
});

test("snapshot lists candidates, described roots and every app's status with relative roots only", async (t) => {
  const h = harness(t, {
    apps: [webApp({ root: "apps/a" }), webApp({ root: "apps/b", name: "@acme/b", framework: "next" })],
    config: { version: 1, apps: [{ root: "apps/a", script: "dev" }] },
  });
  await h.runApp({ appRoot: "apps/a" });
  const snapshot = await h.servers.snapshot("ws");
  assert.equal(snapshot.target, "choose");
  assert.deepEqual(snapshot.chosen, ["apps/a"]);
  assert.deepEqual(snapshot.candidates, [
    { appRoot: "apps/a", framework: "vite", frameworkLabel: "Vite", script: "dev", name: "web" },
    { appRoot: "apps/b", framework: "next", frameworkLabel: "Next.js", script: "dev", name: "@acme/b" },
  ]);
  assert.equal(snapshot.apps.find((app) => app.appRoot === "apps/a")?.phase, "running");
  const text = JSON.stringify(snapshot);
  for (const absolute of ["/w/ws", "/opt/tools"]) assert.equal(text.includes(absolute), false, absolute);
});
