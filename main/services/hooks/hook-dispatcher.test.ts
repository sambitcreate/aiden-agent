import assert from "node:assert/strict";
import test from "node:test";
import { createHookDispatcher, type HookDispatcherSource, type HookRunFunction } from "./hook-dispatcher.js";
import type { HookRawRun } from "./hook-runner.js";
import type { HookDefinition, HookDispatchContext, HookPayload } from "./hook-types.js";

function hook(id: string, overrides: Partial<HookDefinition["handler"]> = {}, event: HookDefinition["event"] = "Stop"): HookDefinition {
  return {
    id,
    name: id,
    event,
    matcher: "",
    handler: { type: "command", command: `./${id}.sh`, ...overrides },
    scope: { kind: "global" },
    source: "settings",
    digest: `digest-${id}`,
  };
}

function source(hooks: () => HookDefinition[] | Promise<HookDefinition[]>): HookDispatcherSource {
  return { activeHooks: async () => hooks(), mayHaveActiveHooks: () => true };
}

function raw(overrides: Partial<HookRawRun> = {}): HookRawRun {
  return { startedAt: 0, durationMs: 1, exitCode: 0, timedOut: false, outputLimitExceeded: false, aborted: false, stdout: "", stderr: "", ...overrides };
}

const stop: HookPayload = { hook_event_name: "Stop", session_id: "chat-1", cwd: "/tmp" };
const preTool: HookPayload = { hook_event_name: "PreToolUse", session_id: "chat-1", cwd: "/tmp", aiden_tool_name: "run_command", tool_input: { command: "ls" } };

function context(overrides: Partial<HookDispatchContext> = {}): HookDispatchContext {
  return { scopes: [{ kind: "global" }], cwd: "/tmp", sessionId: "chat-1", ...overrides };
}

/** A run that stays open until the test releases it or its signal aborts. */
function gatedRun() {
  const started: string[] = [];
  const release = new Map<string, (run: HookRawRun) => void>();
  const run: HookRunFunction = (definition, _payload, runContext) =>
    new Promise((resolve) => {
      started.push(definition.id);
      release.set(definition.id, resolve);
      runContext.signal?.addEventListener("abort", () => resolve(raw({ aborted: true, exitCode: null })), { once: true });
    });
  return { run, started, release: (id: string, result = raw()) => release.get(id)?.(result) };
}

test("when hooks can't be loaded, a tool call is blocked and other events carry on with a notice", async () => {
  let fail = true;
  let runs = 0;
  const dispatcher = createHookDispatcher({
    source: source(() => {
      if (fail) throw new Error("hooks.json is unreadable");
      return [hook("guard", {}, "PreToolUse")];
    }),
    run: async () => {
      runs += 1;
      return raw();
    },
  });

  const blocked = await dispatcher.dispatch("PreToolUse", preTool, context({ idempotencyKey: "call-1" }));
  assert.equal(blocked.decision, "deny");
  assert.match(blocked.reason ?? "", /could not load your hooks, so it blocked this tool call: hooks\.json is unreadable/u);
  assert.match(blocked.notices?.[0] ?? "", /blocked this tool call/u);

  const carriedOn = await dispatcher.dispatch("Stop", stop, context());
  assert.equal(carriedOn.decision, undefined);
  assert.match(carriedOn.notices?.[0] ?? "", /could not load your hooks and continued without them: hooks\.json is unreadable/u);

  // Once they load again, a replay of the same call runs them instead of reusing the block.
  fail = false;
  const replay = await dispatcher.dispatch("PreToolUse", preTool, context({ idempotencyKey: "call-1" }));
  assert.equal(replay.decision, undefined);
  assert.deepEqual(replay.ranHooks, ["guard"]);
  assert.equal(runs, 1);
});

test("an async hook is not awaited, logs its run, and reports its message to the person", async () => {
  const gate = gatedRun();
  const reported: string[][] = [];
  const dispatcher = createHookDispatcher({ source: source(() => [hook("setup", { async: true })]), run: gate.run });

  const outcome = await dispatcher.dispatch("Stop", stop, context({ reportAsync: (lines) => reported.push(lines) }));
  assert.deepEqual(outcome.ranHooks, []);
  assert.deepEqual(gate.started, ["setup"]);
  assert.equal(dispatcher.backgroundHookCount(), 1);
  assert.equal(dispatcher.lastRun("setup"), undefined, "nothing logged until it finishes");

  gate.release("setup", raw({ stdout: JSON.stringify({ systemMessage: "Dependencies installed." }) }));
  await dispatcher.whenBackgroundIdle();
  assert.equal(dispatcher.lastRun("setup")?.result, "ok");
  assert.deepEqual(reported, [["setup: Dependencies installed."]]);
});

test("a failing async hook can't block, and its error reaches the person", async () => {
  const reported: string[][] = [];
  let exitCode = 2;
  const dispatcher = createHookDispatcher({
    source: source(() => [hook("lint", { async: true }, "PreToolUse")]),
    run: async () => raw({ exitCode, stderr: "nope" }),
  });
  const outcome = await dispatcher.dispatch("PreToolUse", preTool, context({ reportAsync: (lines) => reported.push(lines) }));
  assert.equal(outcome.decision, undefined, "exit 2 from a background hook does not block the call");
  await dispatcher.whenBackgroundIdle();
  assert.equal(dispatcher.lastRun("lint")?.result, "blocked");

  exitCode = 1;
  await dispatcher.dispatch("PreToolUse", preTool, context({ reportAsync: (lines) => reported.push(lines) }));
  await dispatcher.whenBackgroundIdle();
  assert.equal(reported.length, 1);
  assert.match(reported[0]?.[0] ?? "", /^Hook "lint" .* in the background\.$/u);
});

test("async hooks run a few at a time, a full queue skips new ones, and stopping clears them", async () => {
  const gate = gatedRun();
  const hooks = Array.from({ length: 5 }, (_, index) => hook(`h${index}`, { async: true }));
  const reported: string[] = [];
  const dispatcher = createHookDispatcher({ source: source(() => hooks), run: gate.run, asyncConcurrency: 2, asyncQueueLimit: 2 });

  await dispatcher.dispatch("Stop", stop, context({ reportAsync: (lines) => reported.push(...lines) }));
  assert.deepEqual(gate.started, ["h0", "h1"], "two run at once");
  assert.equal(dispatcher.backgroundHookCount(), 4, "two running and two waiting");
  assert.deepEqual(reported, ['Hook "h4" was skipped: too many background hooks are already waiting.']);

  gate.release("h0");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.started, ["h0", "h1", "h2"], "a waiting hook starts when one finishes");

  // A turn ending does not stop them; stopping does, and drops the waiting one.
  dispatcher.stopBackgroundHooks();
  await dispatcher.whenBackgroundIdle();
  assert.equal(dispatcher.backgroundHookCount(), 0);
  assert.deepEqual(gate.started, ["h0", "h1", "h2"], "h3 never starts");
});

test("the turn's own signal stops waited hooks but not background ones", async () => {
  const gate = gatedRun();
  const turn = new AbortController();
  const dispatcher = createHookDispatcher({ source: source(() => [hook("bg", { async: true }), hook("fg")]), run: gate.run });
  const pending = dispatcher.dispatch("Stop", stop, context({ signal: turn.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gate.started.sort(), ["bg", "fg"]);
  turn.abort();
  await pending;
  assert.equal(dispatcher.backgroundHookCount(), 1, "the background hook keeps running");
  gate.release("bg");
  await dispatcher.whenBackgroundIdle();
  assert.equal(dispatcher.lastRun("bg")?.result, "ok");
});
