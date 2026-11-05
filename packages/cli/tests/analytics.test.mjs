import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const api = await import("../dist/parity-test-api.js");

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgDir, "dist", "app", "cli.js");
const SHOWN = "2026-11-01T00:00:00.000Z";
const INSTALL_ID = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
const NEW_ID = "1c7f5b7f-4d2e-4a9f-8b3c-8d6e2f1a0b9c";
const KEY = "phc_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const SERVER_READY = "Aiden Remote is off";

const stateFile = (agentDir) => join(agentDir, "aiden-analytics.json");
const readState = (agentDir) => JSON.parse(readFileSync(stateFile(agentDir), "utf8"));
const eventNames = (sent) => sent.map((message) => message.event);
const started = (h, launch = "foreground") => {
  const run = api.startServerAnalytics(launch, h.context);
  run.ready();
  return run;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A real process stopped inside the consent lock, until `resume()` or it is killed. */
async function holdConsentLock(t, agentDir) {
  const entered = join(agentDir, "lock-entered");
  const resumeFile = join(agentDir, "lock-resume");
  const child = spawn(process.execPath, [join(pkgDir, "tests", "fixtures", "analytics-hold-consent.mjs"), agentDir, INSTALL_ID, entered, resumeFile], { stdio: "inherit" });
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  for (const deadline = Date.now() + 30_000; !existsSync(entered);) {
    assert.ok(Date.now() < deadline, "the holder took the lock");
    await settle();
  }
  return {
    closed,
    kill: () => child.kill("SIGKILL"),
    resume: () => writeFileSync(resumeFile, ""),
  };
}

/** A temporary agent directory, optionally with consent already on disk. */
function agentDirFor(t, state) {
  const agentDir = mkdtempSync(join(tmpdir(), "aiden-analytics-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  if (state) writeFileSync(stateFile(agentDir), JSON.stringify(state));
  return agentDir;
}

/** A fake PostHog transport. `overrides` replace any of its methods. */
function fakeTransport(overrides = {}) {
  const sent = [];
  const calls = [];
  const transport = {
    capture: (message) => { sent.push(message); },
    revokeQueue: () => { calls.push("revokeQueue"); },
    captureOptOut: async (message) => { sent.push(message); calls.push("captureOptOut"); },
    flush: async () => { calls.push("flush"); },
    shutdown: async () => { calls.push("shutdown"); },
    discard: async () => { calls.push("discard"); },
    ...overrides,
  };
  return { sent, calls, transport };
}

/** A context whose transport, stderr and crash host are all observable. */
function harness(t, { state, env = {}, isTTY = false, transport = fakeTransport(), ...rest } = {}) {
  const agentDir = rest.agentDir ?? agentDirFor(t, state);
  const appDir = mkdtempSync(join(tmpdir(), "aiden-analytics-app-"));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  let stderrText = "";
  let created = 0;
  const crashHost = new EventEmitter();
  const rethrown = [];
  const context = {
    agentDir,
    appDir,
    env,
    stderr: { isTTY, write: (text) => { stderrText += text; } },
    createTransport: async () => { created += 1; return transport.transport; },
    randomUUID: () => NEW_ID,
    crashHost,
    rethrow: (error) => { rethrown.push(error); },
    ...rest,
  };
  return {
    agentDir,
    appDir,
    context,
    crashHost,
    rethrown,
    ...transport,
    stderr: () => stderrText,
    created: () => created,
  };
}

const allowed = { enabled: true, noticeShownAt: SHOWN };

test("the first server on a terminal shows the notice once, records it and starts sending", async (t) => {
  const h = harness(t, { isTTY: true });
  await started(h).finish();
  assert.equal(h.stderr(), api.SERVER_ANALYTICS_NOTICE);
  assert.ok(Date.parse(readState(h.agentDir).noticeShownAt) > 0);
  assert.deepEqual(eventNames(h.sent), ["server_started"]);

  const again = harness(t, { isTTY: true, agentDir: h.agentDir });
  await started(again).finish();
  assert.equal(again.stderr(), "", "the notice is one-time");
  assert.deepEqual(eventNames(again.sent), ["server_started"]);
});

test("a server with no terminal that never showed the notice stays silent and records nothing", async (t) => {
  const h = harness(t, { isTTY: false });
  await started(h, "service").finish();
  assert.equal(h.stderr(), "");
  assert.equal(h.created(), 0);
  assert.equal(existsSync(stateFile(h.agentDir)), false);
});

test("a server with no terminal sends once the notice was shown earlier", async (t) => {
  const h = harness(t, { isTTY: false, state: allowed });
  await started(h, "service").finish();
  assert.equal(h.stderr(), "");
  assert.deepEqual(h.sent.map((message) => message.properties.launch), ["service"]);
});

test("the notice from a service install or a --daemon terminal lets the detached server send", async (t) => {
  const install = harness(t, { isTTY: false });
  api.showServerNotice(install.context);
  assert.equal(install.stderr(), api.SERVER_ANALYTICS_NOTICE);
  const service = harness(t, { isTTY: false, agentDir: install.agentDir });
  await started(service, "service").finish();
  assert.deepEqual(eventNames(service.sent), ["server_started"]);

  const terminal = harness(t, { isTTY: true });
  api.showServerNoticeInTerminal(terminal.context);
  assert.equal(terminal.stderr(), api.SERVER_ANALYTICS_NOTICE);
  const log = harness(t, { isTTY: false });
  api.showServerNoticeInTerminal(log.context);
  assert.equal(log.stderr(), "", "a log file is not a person");
  assert.equal(existsSync(stateFile(log.agentDir)), false);
});

test("a notice that cannot be recorded stays pending and the server still starts", async (t) => {
  const h = harness(t, { isTTY: true });
  mkdirSync(stateFile(h.agentDir));
  const run = started(h);
  await run.finish();
  assert.equal(h.created(), 0);
});

test("with CI set nothing is shown, recorded or sent, whatever the state", async (t) => {
  for (const CI of ["true", "1", "false", ""]) {
    const fresh = harness(t, { isTTY: true, env: { CI } });
    await started(fresh).finish();
    api.showServerNotice(fresh.context);
    assert.equal(fresh.stderr(), "");
    assert.equal(existsSync(stateFile(fresh.agentDir)), false);

    const shown = harness(t, { state: allowed, env: { CI } });
    await started(shown).finish();
    assert.equal(shown.created(), 0);
  }
});

test("server_started carries only the launch and the shared fields", async (t) => {
  for (const launch of ["foreground", "daemon", "service"]) {
    const h = harness(t, { state: allowed });
    await started(h, launch).finish();
    assert.equal(h.sent.length, 1);
    const [{ distinctId, properties }] = h.sent;
    assert.equal(properties.launch, launch);
    assert.equal(distinctId, NEW_ID);
    assert.equal(properties.surface, "server");
    assert.equal(properties.app_version, "0.1.0");
    assert.equal(properties.$process_person_profile, false);
  }
});

test("a server that fails before it is ready is not counted", async (t) => {
  const h = harness(t, { state: allowed });
  await api.startServerAnalytics("foreground", h.context).finish();
  assert.deepEqual(h.sent, []);
});

test("how a server was started is read from its service manager", () => {
  assert.equal(api.runsUnderServiceManager({ XPC_SERVICE_NAME: api.LAUNCHD_LABEL }, false), true);
  assert.equal(api.runsUnderServiceManager({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" }, true), false);
  assert.equal(api.runsUnderServiceManager({ INVOCATION_ID: "a1b2" }, false), true);
  assert.equal(api.runsUnderServiceManager({ INVOCATION_ID: "a1b2" }, true), false, "a terminal opened from a unit is a person");
  assert.equal(api.runsUnderServiceManager({}, false), false);
});

test("the install ID is created on the first send, kept afterwards and stored in its own file", async (t) => {
  const h = harness(t, { state: allowed });
  await started(h).finish();
  assert.equal(readState(h.agentDir).installId, NEW_ID);
  const next = harness(t, { agentDir: h.agentDir, randomUUID: () => { throw new Error("the existing ID must be kept"); } });
  await started(next).finish();
  assert.equal(next.sent[0].distinctId, NEW_ID);
  assert.equal(existsSync(join(h.agentDir, "settings.json")), false, "Pi's settings file is not touched");
});

test("a damaged consent file counts as off, so it can never undo an opt-out", async (t) => {
  for (const damaged of ['{"enabled":false,"noticeSh', '{"enabled":"false","noticeShownAt":"2026-11-01T00:00:00.000Z"}', "null", "[]", ""]) {
    const h = harness(t, { isTTY: true });
    writeFileSync(stateFile(h.agentDir), damaged);
    await started(h).finish();
    api.showServerNotice(h.context);
    assert.equal(h.stderr(), "", damaged);
    assert.equal(h.created(), 0, damaged);
    assert.equal(readFileSync(stateFile(h.agentDir), "utf8"), damaged, "left for the person to see");
    assert.equal((await api.telemetryCommand(h.agentDir, ["status"], h.context)).reason, "disabled");

    const report = await api.telemetryCommand(h.agentDir, ["on"], h.context);
    assert.equal(report.sending, true, "telemetry on replaces it");
  }
});

test("DO_NOT_TRACK=1 and AIDEN_ANALYTICS=0 turn everything off", async (t) => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { AIDEN_ANALYTICS: "0" }]) {
    const fresh = harness(t, { isTTY: true, env });
    await started(fresh).finish();
    assert.equal(fresh.stderr(), "");
    assert.equal(fresh.created(), 0);

    const shown = harness(t, { state: { ...allowed, installId: INSTALL_ID }, env });
    await started(shown).finish();
    assert.equal(shown.created(), 0);
    assert.equal((await api.telemetryCommand(shown.agentDir, ["status"], shown.context)).reason, "environment");
    await api.telemetryCommand(shown.agentDir, ["off"], shown.context);
    assert.equal(shown.created(), 0, "turning it off under a kill switch sends nothing");
    assert.equal(readState(shown.agentDir).enabled, false);
  }
});

test("a build with no key never creates a transport and shows no notice", async (t) => {
  const h = harness(t, { createTransport: undefined, buildConfig: { channel: "dev" }, isTTY: true });
  await started(h).finish();
  api.showServerNotice(h.context);
  assert.equal(h.stderr(), "");
  assert.equal(h.crashHost.listenerCount("uncaughtException"), 0);
  const status = await api.telemetryCommand(h.agentDir, ["status"], h.context);
  assert.deepEqual({ sending: status.sending, reason: status.reason }, { sending: false, reason: "no_key" });
});

test("telemetry status names what is holding sending back", async (t) => {
  const report = async (options) => {
    const h = harness(t, options);
    return api.telemetryCommand(h.agentDir, [], h.context);
  };
  const pending = await report({});
  assert.deepEqual([pending.enabled, pending.sending, pending.reason], [true, false, "notice_pending"]);
  assert.equal((await report({ state: allowed, env: { CI: "1" } })).reason, "ci");
  assert.equal((await report({ state: { enabled: false } })).reason, "disabled");
  const sending = await report({ state: allowed });
  assert.equal(sending.sending, true);
  assert.equal("reason" in sending, false);
});

test("telemetry off sends analytics_disabled once under the old ID and forgets it", async (t) => {
  const h = harness(t, { state: { ...allowed, installId: INSTALL_ID } });
  const report = await api.telemetryCommand(h.agentDir, ["off"], h.context);
  assert.equal(report.enabled, false);
  assert.equal(report.reason, "disabled");
  assert.deepEqual(eventNames(h.sent), ["analytics_disabled"]);
  assert.equal(h.sent[0].distinctId, INSTALL_ID);
  assert.equal(h.sent[0].properties.surface, "server");
  assert.ok(h.calls.includes("captureOptOut") && h.calls.includes("discard"));
  const saved = readState(h.agentDir);
  assert.equal(saved.enabled, false);
  assert.equal("installId" in saved, false);
});

test("telemetry off sends nothing when this install never sent anything", async (t) => {
  const h = harness(t, { state: allowed });
  await api.telemetryCommand(h.agentDir, ["off"], h.context);
  assert.equal(h.created(), 0);
  assert.equal(readState(h.agentDir).enabled, false);
});

test("telemetry off is saved and returns within its cap when the network hangs", async (t) => {
  const hanging = fakeTransport({ captureOptOut: () => new Promise(() => {}) });
  const h = harness(t, { state: { ...allowed, installId: INSTALL_ID }, transport: hanging });
  const began = Date.now();
  await api.telemetryCommand(h.agentDir, ["off"], h.context);
  assert.ok(Date.now() - began < 3_000);
  assert.ok(hanging.calls.includes("discard"));
  assert.equal(readState(h.agentDir).enabled, false);
});

test("telemetry on answers the notice and a later send uses a new install ID", async (t) => {
  const h = harness(t, { state: { enabled: false } });
  const report = await api.telemetryCommand(h.agentDir, ["on"], h.context);
  assert.deepEqual([report.enabled, report.sending], [true, true]);
  assert.ok(readState(h.agentDir).noticeShownAt);
  await started(h).finish();
  assert.equal(h.sent[0].distinctId, NEW_ID);
});

test("telemetry rejects anything but status, on and off", async (t) => {
  const h = harness(t);
  await assert.rejects(api.telemetryCommand(h.agentDir, ["maybe"], h.context), /Usage: aiden telemetry/u);
  await assert.rejects(api.telemetryCommand(h.agentDir, ["on", "now"], h.context), /Usage: aiden telemetry/u);
});

test("turning it off from another process stops a running server at its next event or request", async (t) => {
  const server = harness(t, { state: allowed });
  server.context.createTransport = async (allowSend) => {
    server.allowSend = allowSend;
    return server.transport;
  };
  const run = started(server);
  await settle();
  assert.deepEqual(eventNames(server.sent), ["server_started"]);
  assert.equal(server.allowSend(), true);

  // Another `aiden telemetry off`, with its own transport.
  const other = harness(t, { agentDir: server.agentDir });
  await api.telemetryCommand(server.agentDir, ["off"], other.context);

  assert.equal(server.allowSend(), false, "the queued batch may no longer leave");
  assert.ok(server.calls.includes("revokeQueue"));
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  assert.deepEqual(eventNames(server.sent), ["server_started"]);

  // Turning it back on creates a new ID the old server does not own.
  await api.telemetryCommand(server.agentDir, ["on"], other.context);
  assert.equal(server.allowSend(), false);
  await run.finish();
});

test("an opt-out racing a server's first start stays off, and the server can't bring the old ID back", async (t) => {
  const h = harness(t, { state: allowed });
  const fixture = join(pkgDir, "tests", "fixtures", "analytics-opt-out.mjs");
  const starting = join(h.agentDir, "opt-out-starting");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const blockFor = (done, ms) => {
    for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) Atomics.wait(pause, 0, 0, 10);
  };
  let optOut;
  let output = "";
  // Runs between the server's read of the file and its write: the race itself.
  h.context.randomUUID = () => {
    optOut = spawn(process.execPath, [fixture, h.agentDir, h.appDir, starting], { stdio: ["ignore", "pipe", "inherit"] });
    optOut.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    blockFor(() => existsSync(starting), 30_000);
    assert.ok(existsSync(starting), "the opt-out process started");
    // Without the lock the opt-out finishes here, and this write then undoes it.
    blockFor(() => !readState(h.agentDir).enabled, 500);
    return NEW_ID;
  };
  h.context.createTransport = async (allowSend) => {
    h.allowSend = allowSend;
    return h.transport;
  };

  const run = started(h);
  await settle();
  assert.ok(optOut, "the server wrote an install ID");
  const [code] = await once(optOut, "close");
  assert.equal(code, 0);

  const saved = readState(h.agentDir);
  assert.equal(saved.enabled, false);
  assert.equal(saved.installId, undefined);
  assert.equal(JSON.parse(output).distinctId, NEW_ID, "the last event carries the ID the server had just saved");
  await run.finish();
  assert.equal(h.allowSend(), false);
});

test("an opt-out can't take the lock from a paused process, so its late write can't undo the opt-out", async (t) => {
  const h = harness(t, { state: allowed });
  const holder = await holdConsentLock(t, h.agentDir);

  await assert.rejects(api.telemetryCommand(h.agentDir, ["off"], h.context), /Another Aiden process/u);
  assert.equal(readState(h.agentDir).enabled, true, "a failed opt-out says so instead of claiming success");

  holder.resume();
  await holder.closed;
  assert.equal(readState(h.agentDir).installId, INSTALL_ID);

  await api.telemetryCommand(h.agentDir, ["off"], h.context);
  assert.equal(readState(h.agentDir).enabled, false);
  assert.equal(readState(h.agentDir).installId, undefined);
});

test("a process that died holding the consent lock can't stop the switch", async (t) => {
  const h = harness(t, { state: allowed });
  const holder = await holdConsentLock(t, h.agentDir);
  holder.kill();
  await holder.closed;

  await api.telemetryCommand(h.agentDir, ["off"], h.context);
  assert.equal(readState(h.agentDir).enabled, false);
  assert.equal(readState(h.agentDir).installId, undefined);
});

test("events shared services report reach the server's client, before and after it is ready", async (t) => {
  const h = harness(t, { state: allowed });
  const run = api.startServerAnalytics("foreground", h.context);
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  await settle();
  api.reportAnalyticsEvent("connector_added", { preset_id: "github", transport: "http", url: "https://private.example" });
  assert.deepEqual(eventNames(h.sent), ["web_search_used", "connector_added"]);
  assert.equal(h.sent[0].properties.surface, "server");
  assert.doesNotMatch(JSON.stringify(h.sent), /private\.example/u);

  await run.finish();
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  assert.equal(h.sent.length, 2, "a finished run reports nothing");
});

test("nothing is registered for shared events when the server may not send", async (t) => {
  const h = harness(t);
  await started(h).finish();
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  assert.equal(h.sent.length, 0);
});

test("starting never waits on the transport, and a hung client cannot hold a server's stop", async (t) => {
  const h = harness(t, { state: allowed, createTransport: () => new Promise(() => {}) });
  const began = Date.now();
  const run = started(h);
  assert.ok(Date.now() - began < 100, "starting returns at once");
  const stopping = Date.now();
  await run.finish();
  const took = Date.now() - stopping;
  assert.ok(took >= api.SERVE_EXIT_FLUSH_CAP_MS - 20 && took < api.SERVE_EXIT_FLUSH_CAP_MS + 500, `took ${took} ms`);
});

test("a shutdown flush that hangs is capped", async (t) => {
  const hanging = fakeTransport({ shutdown: () => new Promise(() => {}) });
  const h = harness(t, { state: allowed, transport: hanging });
  const began = Date.now();
  await started(h).finish();
  assert.ok(Date.now() - began < api.SERVE_EXIT_FLUSH_CAP_MS + 500);
});

test("a failing client leaves the server and the crash path as they were", async (t) => {
  const h = harness(t, { state: allowed, createTransport: async () => { throw new Error("no client"); } });
  const run = started(h);
  await settle();
  assert.equal(h.crashHost.listenerCount("uncaughtException"), 0, "without waiting for the server to stop");
  await run.finish();
});

test("an uncaught exception is sanitized, flushed with a cap, then rethrown", async (t) => {
  const hanging = fakeTransport({ flush: () => new Promise(() => {}) });
  const h = harness(t, { state: allowed, transport: hanging, crashFlushCapMs: 50 });
  started(h);
  await settle();

  const failure = new Error("failed for jane@example.com in /Users/jane/secret/project.ts with sk-abcdefghijklmnopqrstuvwxyz012345");
  h.crashHost.emit("uncaughtException", failure, "uncaughtException");
  // A second failure during the wait does not start a second report.
  h.crashHost.emit("uncaughtException", new Error("second"), "uncaughtException");
  await settle();
  assert.deepEqual(h.rethrown, [], "the report still has time");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(h.rethrown, [failure], "the original error ends the process");
  assert.equal(h.crashHost.listenerCount("uncaughtException"), 0, "the rethrow reaches Node's default handling");

  const report = h.sent.find((message) => message.event === "$exception");
  assert.equal(report.properties.source, "server");
  assert.equal(report.properties.level, "fatal");
  assert.equal(report.properties.process_type, "server");
  assert.equal(report.properties.origin, "uncaught_exception");
  assert.equal(h.sent.filter((message) => message.event === "$exception").length, 1);
  assert.doesNotMatch(JSON.stringify(report), /jane|sk-abc|\/Users/u);
});

test("a crash report keeps the error's type, frames and code, and never its message", async (t) => {
  const h = harness(t, { state: allowed, crashFlushCapMs: 20 });
  started(h);
  await settle();
  const value = (message) => message.properties.$exception_list.map((entry) => entry.value);

  const unreadable = Object.assign(new TypeError("EACCES: permission denied, open 'acme-merger-q3.md'"), { code: "EACCES" });
  unreadable.cause = new Error('Your prompt "fire Bob next Tuesday" was flagged by db.internal.acme.com');
  h.crashHost.emit("uncaughtException", unreadable, "uncaughtException");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const crash = h.sent.at(-1);
  assert.deepEqual(crash.properties.$exception_list.map((entry) => entry.type), ["TypeError", "Error"]);
  assert.deepEqual(value(crash), ["EACCES", ""]);
  assert.ok(crash.properties.$exception_list[0].stacktrace.frames.length > 0, "frames still say where it failed");
  assert.doesNotMatch(JSON.stringify(crash), /acme|Bob|prompt/u);

  const nested = harness(t, { state: allowed });
  started(nested);
  await settle();
  const outer = new Error("could not save acme-merger-q3.md");
  outer.cause = Object.assign(new Error("no room for acme-merger-q3.md"), { code: "ENOSPC" });
  api.reportServerRejection(outer);
  await settle();
  assert.deepEqual(value(nested.sent.at(-1)), ["", "ENOSPC"], "each code stays with its own error");

  const logged = harness(t, { state: allowed });
  started(logged);
  await settle();
  for (const reason of ["notes/board-minutes.pdf is gone", new Error("~/work/acme/plan.md failed"), Object.assign(new Error("hello my ssn"), { code: "not a code" })]) api.reportServerRejection(reason);
  await settle();
  const reports = logged.sent.filter((message) => message.event === "$exception");
  assert.equal(reports.length, 3);
  for (const report of reports) assert.deepEqual(value(report), [""]);
});

test("a crash during the stop still ends the process with the crash, not a clean exit", async (t) => {
  const slowStop = fakeTransport({ shutdown: () => new Promise((resolve) => setTimeout(resolve, 20)), flush: () => new Promise((resolve) => setTimeout(resolve, 60)) });
  const h = harness(t, { state: allowed, transport: slowStop, crashFlushCapMs: 500 });
  const run = started(h);
  await settle();
  let finished = false;
  void run.finish().then(() => { finished = true; });
  const failure = new Error("failed while stopping");
  // The stop has already passed its first look at the crash path.
  await Promise.resolve();
  h.crashHost.emit("uncaughtException", failure, "uncaughtException");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(h.rethrown, [failure]);
  assert.equal(finished, false, "a normal exit must not overtake the crash's exit code");
});

test("a fatal rejection is reported as one, and a stop in progress waits for the crash path", async (t) => {
  const h = harness(t, { state: allowed, crashFlushCapMs: 20 });
  const run = started(h);
  await settle();
  h.crashHost.emit("uncaughtException", new Error("rejected"), "unhandledRejection");
  let finished = false;
  void run.finish().then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.sent.at(-1).properties.origin, "unhandled_rejection");
  assert.equal(h.rethrown.length, 1);
  assert.equal(finished, false, "a normal exit must not overtake the crash's exit code");
});

test("when another listener owns uncaught exceptions the process keeps running", async (t) => {
  const h = harness(t, { state: allowed, crashFlushCapMs: 20 });
  const run = started(h);
  await settle();
  h.crashHost.on("uncaughtException", () => {});
  h.crashHost.emit("uncaughtException", new Error("survived"), "uncaughtException");
  // Stopping during the report still completes: this crash ends nothing.
  await run.finish();
  assert.deepEqual(h.rethrown, []);
  assert.equal(h.sent.at(-1).properties.level, "error");
  assert.equal(existsSync(join(h.agentDir, api.SERVER_CRASH_COUNT_FILE)), false, "only a crash that ends the process counts towards the budget");
});

test("a crash loop stops reporting for the day instead of flooding the project", async (t) => {
  const h = harness(t, { state: allowed, crashFlushCapMs: 10 });
  started(h);
  await settle();
  h.crashHost.emit("uncaughtException", new Error("loop"), "uncaughtException");
  await settle();
  const saved = JSON.parse(readFileSync(join(h.agentDir, api.SERVER_CRASH_COUNT_FILE), "utf8"));
  assert.equal(saved.count, 1);

  writeFileSync(join(h.agentDir, api.SERVER_CRASH_COUNT_FILE), JSON.stringify({ ...saved, count: api.MAX_CRASH_REPORTS_PER_DAY }));
  const restarted = harness(t, { agentDir: h.agentDir });
  await started(restarted).finish();
  assert.equal(restarted.created(), 0);
  assert.equal(restarted.crashHost.listenerCount("uncaughtException"), 0, "the crash path stays Node's own");

  const tomorrow = harness(t, { agentDir: h.agentDir, now: () => new Date(Date.now() + 86_400_000) });
  await started(tomorrow).finish();
  assert.deepEqual(eventNames(tomorrow.sent), ["server_started"]);
});

test("a rejection the server logged and survived is reported as an error, not a crash", async (t) => {
  const h = harness(t, { state: allowed });
  const run = started(h);
  await settle();
  api.reportServerRejection(new Error("turn failed in /Users/jane/project"));
  await settle();
  const report = h.sent.at(-1);
  assert.equal(report.event, "$exception");
  assert.equal(report.properties.level, "error");
  assert.equal(report.properties.origin, "unhandled_rejection");
  assert.deepEqual(h.rethrown, []);
  await run.finish();
  api.reportServerRejection(new Error("after the run"));
  await settle();
  assert.equal(h.sent.at(-1), report);
});

test("a keyed client reaches only PostHog, and stops the moment the switch is off", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: String(options.body ?? "") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const h = harness(t, { state: allowed, createTransport: undefined, buildConfig: { projectKey: KEY, channel: "release" } });
  const run = started(h);
  for (let waited = 0; requests.length === 0 && waited < 3_000; waited += 20) await settle();
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin, "https://us.i.posthog.com");

  // Queued before the switch, so stopping must take it back out of the queue.
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  writeFileSync(stateFile(h.agentDir), JSON.stringify({ enabled: false, noticeShownAt: SHOWN }));
  const printed = t.mock.method(console, "error", () => {});
  await run.finish();
  assert.equal(requests.length, 1);
  assert.equal(printed.mock.callCount(), 0, "turning it off leaves no stack trace in the server's log");
});

test("a keyed client starts a request only while it holds the consent lock, and sends nothing without it", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  let h;
  globalThis.fetch = async () => {
    let locked = false;
    try {
      api.updateServerAnalyticsState(h.agentDir, (state) => state);
    } catch {
      locked = true;
    }
    requests.push(locked);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  h = harness(t, { state: allowed, createTransport: undefined, buildConfig: { projectKey: KEY, channel: "release" } });
  const run = started(h);
  for (let waited = 0; requests.length === 0 && waited < 3_000; waited += 20) await settle();
  assert.deepEqual(requests, [true], "`telemetry off` can't land between the consent check and the request");

  // Another process is changing the switch, so this batch must not leave.
  const holder = await holdConsentLock(t, h.agentDir);
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  await run.finish();
  holder.kill();
  await holder.closed;
  assert.equal(requests.length, 1);
});

test("a keyed client delivers what is queued at exit while the switch stays on", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push(String(options.body ?? ""));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const h = harness(t, { state: allowed, createTransport: undefined, buildConfig: { projectKey: KEY, channel: "release" } });
  const run = started(h);
  api.reportAnalyticsEvent("web_search_used", { search_provider: "brave" });
  await run.finish();
  assert.ok(requests.length >= 1);
});

/** The real bundle, in a clean environment. Keyless, so AIDEN_ANALYTICS_DEBUG shows would-be events. */
function bundleEnv(agentDir, env = {}) {
  const clean = { ...process.env };
  for (const name of ["CI", "DO_NOT_TRACK", "AIDEN_ANALYTICS", "AIDEN_ANALYTICS_DEBUG", "INVOCATION_ID", "XPC_SERVICE_NAME"]) delete clean[name];
  return { ...clean, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env };
}

function runBundle(args, agentDir, env = {}, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, cli, ...args], { encoding: "utf8", timeout: 60_000, env: bundleEnv(agentDir, env) });
}

/** Runs `aiden serve` until `ready` appears on its output, then stops it with SIGTERM. */
async function serveUntil(t, agentDir, env, ready, whileRunning = () => {}) {
  const child = spawn(process.execPath, [cli, "serve", "--no-remote", "--no-pair"], { env: bundleEnv(agentDir, env), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (!ready.test(output)) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `serve did not reach ${ready}:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  whileRunning();
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  return { code, output };
}

test("a real server reports how it was started, and only when it may", async (t) => {
  const debug = { AIDEN_ANALYTICS_DEBUG: "1" };
  for (const [env, launch] of [[{}, "foreground"], [{ AIDEN_SERVE_DETACHED: "1" }, "daemon"], [{ INVOCATION_ID: "a1b2" }, "service"]]) {
    const agentDir = agentDirFor(t, allowed);
    const { code, output } = await serveUntil(t, agentDir, { ...debug, ...env }, /\[analytics debug\] server_started/u);
    assert.equal(code, 0, output);
    assert.match(output, new RegExp(`"launch":"${launch}"`, "u"));
    assert.match(output, /"surface":"server"/u);
    assert.ok(readState(agentDir).installId, "the first send creates the install ID");
  }
});

test("a real server with no terminal and no prior notice sends nothing, and neither does CI", async (t) => {
  const debug = { AIDEN_ANALYTICS_DEBUG: "1" };
  for (const [state, env] of [[undefined, {}], [allowed, { CI: "true" }], [allowed, { DO_NOT_TRACK: "1" }]]) {
    const { code, output } = await serveUntil(t, agentDirFor(t, state), { ...debug, ...env }, new RegExp(SERVER_READY, "u"));
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /analytics debug|anonymous usage/u);
  }
});

test("a server that fails to start is not counted", async (t) => {
  const agentDir = agentDirFor(t, allowed);
  const debug = { AIDEN_ANALYTICS_DEBUG: "1" };
  let second;
  await serveUntil(t, agentDir, debug, /\[analytics debug\] server_started/u, () => {
    second = runBundle(["serve", "--no-remote", "--no-pair"], agentDir, debug);
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Another Aiden process owns/u);
  assert.doesNotMatch(second.stderr, /server_started/u);
});

test("admin commands, help and version send nothing, even when a server would", (t) => {
  const debug = { AIDEN_ANALYTICS_DEBUG: "1" };
  const agentDir = agentDirFor(t, allowed);
  for (const args of [["workspace", "list"], ["schedule", "list"], ["serve", "status"], ["service", "status"], ["--version"], ["help"], ["serve", "--help"], ["service", "install", "--bogus"]]) {
    const result = runBundle(args, agentDir, debug);
    assert.doesNotMatch(result.stderr, /analytics debug|anonymous usage/u, args.join(" "));
  }
  assert.equal("installId" in readState(agentDir), false);
});

test("aiden telemetry works end to end through the bundle", (t) => {
  const agentDir = agentDirFor(t, { ...allowed, installId: INSTALL_ID });
  const debug = { AIDEN_ANALYTICS_DEBUG: "1" };
  const status = JSON.parse(runBundle(["telemetry", "status"], agentDir, debug).stdout);
  assert.equal(status.sending, true);
  assert.equal(status.file, stateFile(agentDir));

  const off = runBundle(["telemetry", "off"], agentDir, debug);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /\[analytics debug\] analytics_disabled /u);
  assert.equal(JSON.parse(off.stdout).enabled, false);
  assert.equal("installId" in readState(agentDir), false);

  assert.equal(JSON.parse(runBundle(["telemetry", "on"], agentDir).stdout).reason, "no_key");
  assert.match(runBundle(["help"], agentDir).stdout, /telemetry status\|on\|off/u);
  assert.notEqual(runBundle(["telemetry", "maybe"], agentDir).status, 0);
});

test("the analytics core and client are not evaluated outside a server that may send", (t) => {
  const chunks = join(pkgDir, "dist", "app", "chunks");
  const clientChunk = readdirSync(chunks).find((name) => readFileSync(join(chunks, name), "utf8").includes("us.i.posthog.com"));
  assert.ok(clientChunk, "the PostHog client sits in a chunk of its own");
  const hook = ["--import", join(pkgDir, "tests", "fixtures", "trace-loads.mjs")];

  const loaded = (args, env) => {
    const agentDir = agentDirFor(t, { ...allowed, installId: INSTALL_ID });
    const trace = join(agentDir, "loads.txt");
    const result = runBundle(args, agentDir, { AIDEN_TEST_LOAD_TRACE: trace, ...env }, hook);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(trace, "utf8");
  };

  for (const args of [["--version"], ["workspace", "list"], ["telemetry", "status"], ["telemetry", "off"]]) {
    const urls = loaded(args);
    assert.ok(!urls.includes(clientChunk), args.join(" "));
    assert.ok(!urls.includes("analytics-core"), args.join(" "));
  }
  // The trace can see a load: an opt-out with something to send loads the core.
  assert.ok(loaded(["telemetry", "off"], { AIDEN_ANALYTICS_DEBUG: "1" }).includes("analytics-core"));
});

function runCrashFixture(t, kind, mode) {
  const agentDir = agentDirFor(t, allowed);
  const appDir = mkdtempSync(join(tmpdir(), "aiden-crash-app-"));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
  const result = spawnSync(process.execPath, [join(pkgDir, "tests", "fixtures", "analytics-crash.mjs"), agentDir, appDir, kind, mode], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const ended = Date.now();
  const crashedAt = Number(/crashing (\d+)/u.exec(result.stdout)?.[1]);
  return { ...result, waited: ended - crashedAt };
}

test("a real crash keeps its exit code and message, and waits at most the flush cap", (t) => {
  for (const kind of ["exception", "rejection"]) {
    const plain = runCrashFixture(t, kind, "plain");
    const reported = runCrashFixture(t, kind, "analytics");
    assert.equal(reported.status, plain.status, kind);
    assert.equal(reported.status, 1, kind);
    assert.match(plain.stderr, /boom in/u);
    assert.match(reported.stderr, /boom in/u);
    assert.match(reported.stdout, /"\$exception"/u);
    assert.doesNotMatch(reported.stdout, /jane/u);
    assert.ok(reported.waited >= api.CRASH_FLUSH_CAP_MS - 50, `${kind} waited ${reported.waited} ms`);
    assert.ok(reported.waited < api.CRASH_FLUSH_CAP_MS + 1_500, `${kind} waited ${reported.waited} ms`);
  }
});
