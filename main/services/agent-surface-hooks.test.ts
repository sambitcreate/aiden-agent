import assert from "node:assert/strict";
import { test } from "node:test";
import { botSurfaceHooks, hookBlockText, hookPostToolAdditions, hookStopContinuation, runWorktreeCreateHooks } from "./agent-surface-hooks.js";
import type { HookDispatcher, HookOutcome } from "./hooks/hook-types.js";

const answering = (outcome: HookOutcome): HookDispatcher => ({ hasHooks: () => true, dispatch: async () => outcome });

test("a Bot's hooks run in its folder with global then Bot scopes, and the model never sees the raw reason", async () => {
  const seen: unknown[] = [];
  const hooks = botSurfaceHooks("bot-1", "/bots/bot-1", () => ({
    hasHooks: () => true,
    dispatch: async (event, payload, context) => {
      seen.push({ event, payload, context });
      return { ranHooks: ["guard"], decision: "deny", reason: "RAW reason", reasonForModel: "<fenced>reason</fenced>" };
    },
  }));
  const outcome = await hooks.dispatch("PreToolUse", { tool_name: "Bash" }, { idempotencyKey: "k" });
  assert.deepEqual(seen, [{
    event: "PreToolUse",
    payload: { tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "bot-1", cwd: "/bots/bot-1" },
    context: { scopes: [{ kind: "global" }, { kind: "bot", botId: "bot-1" }], cwd: "/bots/bot-1", sessionId: "bot-1", idempotencyKey: "k" },
  }]);
  assert.equal(hookBlockText(outcome!), "Blocked by hook guard: <fenced>reason</fenced>");
});

test("a dispatcher that throws or has no matching hook gives no outcome", async () => {
  const throwing = botSurfaceHooks("bot-1", "/bots/bot-1", () => ({
    hasHooks: () => true,
    dispatch: async () => { throw new Error("store gone"); },
  }));
  assert.equal(await throwing.dispatch("Stop", {}), undefined);
  let ran = false;
  const none = botSurfaceHooks("bot-1", "/bots/bot-1", () => ({
    hasHooks: () => false,
    dispatch: async () => { ran = true; return { ranHooks: [] }; },
  }));
  assert.equal(await none.dispatch("Stop", {}), undefined);
  assert.equal(ran, false);
});

test("a Stop hook keeps the run going only with an instruction, and a stop request wins", () => {
  assert.match(hookStopContinuation({ ranHooks: ["tests"], continueTurn: true, reasonForModel: "Run the tests" })!, /Stop hook tests asked you to keep going[\s\S]*Run the tests$/u);
  assert.equal(hookStopContinuation({ ranHooks: ["tests"], continueTurn: true, reasonForModel: "Run the tests", stopTurn: true }), undefined);
  assert.equal(hookStopContinuation({ ranHooks: ["tests"], continueTurn: true, reasonForModel: "  " }), undefined);
  assert.equal(hookStopContinuation(undefined), undefined);
});

test("PostToolUse adds a flagged line and hook context after the result, or nothing", () => {
  assert.equal(hookPostToolAdditions({ ranHooks: ["scan"] }), undefined);
  const text = hookPostToolAdditions({ ranHooks: ["scan"], flaggedResult: true, reasonForModel: "<fenced>secret</fenced>", additionalContext: "extra" })!;
  assert.equal(text, "Hook scan flagged this result.\n<fenced>secret</fenced>\n\nextra");
});

test("a WorktreeCreate hook that throws reports nothing instead of failing the worktree", async () => {
  const lines = await runWorktreeCreateHooks(
    { sourceFolderPath: "/src", sourceRoot: "/src", worktreePath: "/wt", workspacePath: "/wt", workspaceId: "ws", branch: "b" },
    () => ({ hasHooks: () => true, dispatch: async () => { throw new Error("boom"); } }),
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(
    await runWorktreeCreateHooks(
      { sourceFolderPath: "/src", sourceRoot: "/src", worktreePath: "/wt", workspacePath: "/wt", workspaceId: "ws", branch: "b" },
      () => answering({ ranHooks: ["setup"], notices: ["Hook setup timed out."] }),
    ),
    ["Hook setup timed out."],
  );
});
