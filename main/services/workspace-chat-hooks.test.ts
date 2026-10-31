import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AfterToolCallContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  HookDispatchContext,
  HookDispatcher,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookScope,
} from "./hooks/hook-types.js";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { convertToLlm } from "./pi-legacy-harness.js";
import { PiAgentRuntimeHarness } from "./pi-agent-runtime-harness.js";
import {
  MAX_STOP_HOOK_CONTINUATIONS,
  MAX_TRACKED_HOOK_SESSIONS,
  createWorkspaceChatHooks,
  endWorkspaceChatSession,
  hookTurnContextText,
  markWorkspaceChatCompacted,
  markWorkspaceChatSessionStarted,
  preCompactSummaryInstructions,
  promptBlockedMessage,
  resetWorkspaceChatSessionsForTests,
  workspaceChatSessionStartSource,
} from "./workspace-chat-hooks.js";

interface Dispatched {
  event: HookEvent;
  payload: HookPayload;
  context: HookDispatchContext;
}

/** A dispatcher whose hooks are given per event; it records every dispatch. */
function fakeDispatcher(
  outcomes: Partial<Record<HookEvent, HookOutcome | ((payload: HookPayload) => HookOutcome)>>,
): { dispatcher: () => HookDispatcher; calls: Dispatched[] } {
  const calls: Dispatched[] = [];
  const dispatcher: HookDispatcher = {
    hasHooks: (event) => outcomes[event] !== undefined,
    async dispatch(event, payload, context) {
      calls.push({ event, payload, context });
      const outcome = outcomes[event];
      if (!outcome) return { ranHooks: [] };
      return typeof outcome === "function" ? outcome(payload) : outcome;
    },
  };
  return { dispatcher: () => dispatcher, calls };
}

const editTool: AgentTool = {
  name: "edit_file",
  label: "edit_file",
  description: "Edit a file",
  parameters: Type.Object({ path: Type.String(), old_text: Type.String(), new_text: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "edited" }], details: null }),
};

const fenced = (text: string) => `<<hook data>>${text}<</hook data>>`;

test("a folder chat runs global, workspace and chat hooks in its folder; a folderless one in the home folder", async () => {
  const { dispatcher, calls } = fakeDispatcher({ UserPromptSubmit: { ranHooks: ["audit"] } });
  await createWorkspaceChatHooks({ chatId: "chat-1", workspaceRoot: "/work/app" }, dispatcher).dispatch(
    "UserPromptSubmit",
    { prompt: "hi" },
  );
  await createWorkspaceChatHooks({ chatId: "chat-2" }, dispatcher).dispatch("UserPromptSubmit", { prompt: "hi" });

  const scopes = calls.map((call) => call.context.scopes);
  assert.deepEqual(scopes[0], [
    { kind: "global" },
    { kind: "workspace", workspaceRoot: "/work/app" },
    { kind: "chat", chatId: "chat-1" },
  ] satisfies HookScope[]);
  assert.deepEqual(scopes[1], [{ kind: "global" }, { kind: "chat", chatId: "chat-2" }] satisfies HookScope[]);
  assert.deepEqual(
    calls.map((call) => [call.payload.session_id, call.payload.cwd, call.payload.hook_event_name]),
    [
      ["chat-1", "/work/app", "UserPromptSubmit"],
      ["chat-2", os.homedir(), "UserPromptSubmit"],
    ],
  );
});

test("PreToolUse deny blocks with the hooks' names and reason; ask and allow are reported, no hook is none", async () => {
  const deny = fakeDispatcher({
    PreToolUse: { decision: "deny", reason: "no", reasonForModel: fenced("main is protected"), ranHooks: ["guard.sh", "lint"] },
  });
  const args = { path: "src/a.ts", old_text: "a", new_text: "b" };
  const blocked = await createWorkspaceChatHooks({ chatId: "c" }, deny.dispatcher).preToolUse({
    toolCallId: "call-1",
    toolName: "edit_file",
    args,
    tools: [editTool],
  });
  assert.deepEqual(blocked, { kind: "block", reason: `Blocked by hook guard.sh, lint: ${fenced("main is protected")}` });
  // Hooks see Claude Code's spelling of the tool and its input, keyed to the call.
  assert.equal(deny.calls[0]!.payload.tool_name, "Edit");
  assert.equal(deny.calls[0]!.payload.aiden_tool_name, "edit_file");
  assert.equal((deny.calls[0]!.payload.tool_input as Record<string, unknown>).file_path, "src/a.ts");
  assert.equal(deny.calls[0]!.context.idempotencyKey, "PreToolUse:c:call-1");

  const ask = fakeDispatcher({ PreToolUse: { decision: "ask", reason: "check the diff", ranHooks: ["review"] } });
  assert.deepEqual(
    await createWorkspaceChatHooks({ chatId: "c" }, ask.dispatcher).preToolUse({ toolCallId: "2", toolName: "edit_file", args }),
    { kind: "ask", reason: "Hook review: check the diff" },
  );
  const allow = fakeDispatcher({ PreToolUse: { decision: "allow", ranHooks: ["ok"] } });
  assert.deepEqual(
    await createWorkspaceChatHooks({ chatId: "c" }, allow.dispatcher).preToolUse({ toolCallId: "3", toolName: "edit_file", args }),
    { kind: "allow" },
  );
  const none = fakeDispatcher({});
  assert.deepEqual(
    await createWorkspaceChatHooks({ chatId: "c" }, none.dispatcher).preToolUse({ toolCallId: "4", toolName: "edit_file", args }),
    { kind: "none" },
  );
  assert.equal(none.calls.length, 0);
});

test("a hook's updated input replaces the call's arguments after validation, but never a shell command's", async () => {
  const rewrite = fakeDispatcher({
    PreToolUse: { updatedInput: { file_path: "src/b.ts", old_text: "a", new_text: "c" }, ranHooks: ["redirect"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, rewrite.dispatcher);
  const args: Record<string, unknown> = { path: "src/a.ts", old_text: "a", new_text: "b" };
  assert.deepEqual(
    await hooks.preToolUse({ toolCallId: "1", toolName: "edit_file", args, tools: [editTool] }),
    { kind: "none" },
  );
  assert.deepEqual(args, { path: "src/b.ts", old_text: "a", new_text: "c" });

  const invalid = fakeDispatcher({ PreToolUse: { updatedInput: { file_path: 42 }, ranHooks: ["broken"] } });
  const original = { path: "src/a.ts", old_text: "a", new_text: "b" };
  const kept = { ...original };
  const result = await createWorkspaceChatHooks({ chatId: "c" }, invalid.dispatcher).preToolUse({
    toolCallId: "2",
    toolName: "edit_file",
    args: kept,
    tools: [editTool],
  });
  assert.equal(result.kind, "block");
  assert.match(result.kind === "block" ? result.reason : "", /^Blocked by hook broken: .*edit_file/);
  assert.deepEqual(kept, original);

  const shell = fakeDispatcher({ PreToolUse: { updatedInput: { command: "rm -rf /" }, ranHooks: ["sneaky"] } });
  const command = { command: "npm test" };
  assert.deepEqual(
    await createWorkspaceChatHooks({ chatId: "c" }, shell.dispatcher).preToolUse({
      toolCallId: "3",
      toolName: "run_command",
      args: command,
    }),
    { kind: "none" },
  );
  assert.deepEqual(command, { command: "npm test" });
});

test("a dispatcher that throws counts as no outcome", async () => {
  const throwing: HookDispatcher = {
    hasHooks: () => true,
    dispatch: async () => {
      throw new Error("runner crashed");
    },
  };
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, () => throwing);
  assert.deepEqual(await hooks.preToolUse({ toolCallId: "1", toolName: "edit_file", args: {} }), { kind: "none" });
  assert.equal(await hooks.dispatch("UserPromptSubmit", { prompt: "hi" }), undefined);
  assert.equal(
    await hooks.onStop({ finalMessage: {} as never, continuations: 0, maxContinuations: 8, signal: new AbortController().signal }),
    undefined,
  );
  const brokenLookup: HookDispatcher = {
    hasHooks: () => {
      throw new Error("store unreadable");
    },
    dispatch: async () => ({ ranHooks: [] }),
  };
  assert.deepEqual(
    await createWorkspaceChatHooks({ chatId: "c" }, () => brokenLookup).preToolUse({ toolCallId: "1", toolName: "edit_file", args: {} }),
    { kind: "none" },
  );
});

function afterToolContext(text: string): AfterToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "call-9", name: "run_command", arguments: { command: "npm test" } },
    args: { command: "npm test" },
    result: { content: [{ type: "text", text }], details: null },
    isError: false,
    context: { messages: [], tools: [] },
  } as unknown as AfterToolCallContext;
}

test("PostToolUse feedback and context are appended to the tool result the model reads", async () => {
  const { dispatcher, calls } = fakeDispatcher({
    PostToolUse: {
      flaggedResult: true,
      reasonForModel: fenced("2 tests failed"),
      additionalContext: fenced("coverage 81%"),
      ranHooks: ["ci-check"],
    },
  });
  const extension = createWorkspaceChatHooks({ chatId: "c" }, dispatcher).extension({
    promptTimestamp: () => undefined,
    turnContext: () => undefined,
  });
  const result = await extension.afterToolCall!(afterToolContext("ok"), undefined);
  const texts = (result?.content ?? []).map((block) => (block.type === "text" ? block.text : ""));
  assert.equal(texts[0], "ok");
  assert.match(texts[1]!, /Hook ci-check flagged this result\./);
  assert.ok(texts[1]!.includes(fenced("2 tests failed")));
  assert.ok(texts[1]!.includes(fenced("coverage 81%")));
  assert.deepEqual(calls[0]!.payload.tool_response, { content: "ok", is_error: false });
  assert.equal(calls[0]!.payload.tool_name, "Bash");
  assert.equal(calls[0]!.context.idempotencyKey, "PostToolUse:c:call-9");

  const quiet = createWorkspaceChatHooks({ chatId: "c" }, fakeDispatcher({ PostToolUse: { ranHooks: ["log"] } }).dispatcher);
  const unchanged = await quiet
    .extension({ promptTimestamp: () => undefined, turnContext: () => undefined })
    .afterToolCall!(afterToolContext("ok"), undefined);
  assert.equal(unchanged, undefined);
});

test("turn context rides after the current prompt only, never replacing the person's words", async () => {
  const extension = createWorkspaceChatHooks({ chatId: "c" }, fakeDispatcher({}).dispatcher).extension({
    promptTimestamp: () => 200,
    turnContext: () => hookTurnContextText([fenced("branch: main"), undefined, " "]),
  });
  const messages: AgentMessage[] = [
    { role: "user", content: "earlier", timestamp: 100 },
    { role: "user", content: "fix the bug", timestamp: 200 },
    { role: "user", content: [{ type: "text", text: "a later steer" }], timestamp: 300 },
  ];
  const transformed = await extension.transformContext!(messages, undefined);
  assert.deepEqual(transformed[0], messages[0]);
  assert.deepEqual(transformed[2], messages[2]);
  const prompt = transformed[1] as Extract<AgentMessage, { role: "user" }>;
  assert.deepEqual(prompt.content, [
    { type: "text", text: "fix the bug" },
    {
      type: "text",
      text: `[Aiden hook] Context from the person's hooks for this turn:\n\n${fenced("branch: main")}`,
    },
  ]);
  // The journal's copy is untouched.
  assert.equal(messages[1]!.role === "user" ? messages[1]!.content : undefined, "fix the bug");

  const silent = createWorkspaceChatHooks({ chatId: "c" }, fakeDispatcher({}).dispatcher).extension({
    promptTimestamp: () => 200,
    turnContext: () => hookTurnContextText([undefined]),
  });
  assert.equal(await silent.transformContext!(messages, undefined), messages);
});

test("a Stop hook keeps the turn going with its reason, marks continued turns, and respects the cap and stopTurn", async () => {
  const { dispatcher, calls } = fakeDispatcher({
    Stop: { continueTurn: true, reason: "run tests", reasonForModel: fenced("run tests"), ranHooks: ["verify"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, dispatcher);
  const event = (continuations: number) => ({
    finalMessage: {} as never,
    continuations,
    maxContinuations: MAX_STOP_HOOK_CONTINUATIONS,
    signal: new AbortController().signal,
  });
  const first = await hooks.onStop(event(0));
  assert.ok(first?.continueWith?.includes(fenced("run tests")));
  assert.match(first?.continueWith ?? "", /Stop hook verify/);
  await hooks.onStop(event(1));
  assert.deepEqual(calls.map((call) => call.payload.stop_hook_active), [false, true]);
  assert.equal(await hooks.onStop(event(MAX_STOP_HOOK_CONTINUATIONS)), undefined);
  assert.equal(calls.length, 2);

  const ended = fakeDispatcher({ Stop: { continueTurn: true, stopTurn: true, reason: "x", ranHooks: ["h"] } });
  assert.equal(await createWorkspaceChatHooks({ chatId: "c" }, ended.dispatcher).onStop(event(0)), undefined);
  const done = fakeDispatcher({ Stop: { ranHooks: ["h"] } });
  assert.equal(await createWorkspaceChatHooks({ chatId: "c" }, done.dispatcher).onStop(event(0)), undefined);
});

test("SessionStart sources follow the chat's life in this process, and deleting it ends the session once", async () => {
  resetWorkspaceChatSessionsForTests();
  const target = { chatId: "life", workspaceRoot: "/work/app" };
  assert.equal(workspaceChatSessionStartSource("life", false), "startup");
  markWorkspaceChatSessionStarted(target);
  assert.equal(workspaceChatSessionStartSource("life", true), undefined);
  markWorkspaceChatCompacted("life");
  assert.equal(workspaceChatSessionStartSource("life", true), "compact");
  markWorkspaceChatSessionStarted(target);
  assert.equal(workspaceChatSessionStartSource("life", true), undefined);
  // After a restart, a chat with history resumes; compaction before any start is not a session.
  markWorkspaceChatCompacted("old");
  assert.equal(workspaceChatSessionStartSource("old", true), "resume");

  const { dispatcher, calls } = fakeDispatcher({ SessionEnd: { ranHooks: ["cleanup"] } });
  endWorkspaceChatSession("life", dispatcher);
  endWorkspaceChatSession("life", dispatcher);
  endWorkspaceChatSession("never-started", dispatcher);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.event, call.payload.session_id, call.payload.cwd, call.payload.aiden_reason]),
    [["SessionEnd", "life", "/work/app", "chat_deleted"]],
  );
  resetWorkspaceChatSessionsForTests();
});

test("a refused prompt names the hooks and their reason", () => {
  assert.equal(
    promptBlockedMessage({ blockPrompt: true, reason: "secrets in prompt", ranHooks: ["scan"] }),
    "Blocked by hook scan: secrets in prompt",
  );
  assert.equal(
    promptBlockedMessage({ stopTurn: true, stopReason: "quiet hours", reason: "ignored", ranHooks: [] }),
    "Blocked by a hook: quiet hours",
  );
});

test("PreCompact tells hooks the trigger and turns their context into summary instructions", async () => {
  const { dispatcher, calls } = fakeDispatcher({
    PreCompact: { ranHooks: ["keep-plan"], additionalContext: fenced("the migration plan"), systemMessages: ["saved"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "long", workspaceRoot: "/work/app" }, dispatcher);
  const signal = new AbortController().signal;

  const instructions = await preCompactSummaryInstructions(hooks, { trigger: "auto", reason: "overflow", signal });

  assert.ok(instructions?.includes(fenced("the migration plan")));
  assert.equal(instructions?.includes("saved"), false);
  assert.deepEqual(
    calls.map((call) => [call.event, call.payload.trigger, call.payload.aiden_reason, call.payload.session_id, call.context.signal]),
    [["PreCompact", "auto", "overflow", "long", signal]],
  );
});

test("PreCompact adds no instructions without hooks, without context, or when the dispatcher fails", async () => {
  const none = fakeDispatcher({});
  assert.equal(
    await preCompactSummaryInstructions(createWorkspaceChatHooks({ chatId: "c" }, none.dispatcher), { trigger: "manual", reason: "manual" }),
    undefined,
  );
  assert.equal(none.calls.length, 0);

  const quiet = fakeDispatcher({ PreCompact: { ranHooks: ["log"] } });
  assert.equal(
    await preCompactSummaryInstructions(createWorkspaceChatHooks({ chatId: "c" }, quiet.dispatcher), { trigger: "manual", reason: "manual" }),
    undefined,
  );
  assert.equal(quiet.calls[0]?.payload.trigger, "manual");

  const throwing: HookDispatcher = {
    hasHooks: () => true,
    dispatch: async () => {
      throw new Error("runner crashed");
    },
  };
  assert.equal(
    await preCompactSummaryInstructions(createWorkspaceChatHooks({ chatId: "c" }, () => throwing), { trigger: "auto", reason: "threshold" }),
    undefined,
  );
});

const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: null }),
};

/** One chat turn on a faux model: the hooks run in the host gate and the `aiden.hooks` extension, as in llm-client. */
async function runHookedTurn(hooks: ReturnType<typeof createWorkspaceChatHooks>) {
  const core = createFauxCore({ provider: `aiden-hooks-${Math.random().toString(36).slice(2)}` });
  core.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("all done"),
  ]);
  const harness = new PiAgentRuntimeHarness({
    convertToLlm,
    streamFn: core.streamSimple,
    initialState: { systemPrompt: "Base", thinkingLevel: "off", tools: [echoTool], messages: [], model: core.getModel() },
    beforeToolCall: async (context, signal) => {
      const hook = await hooks.preToolUse({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
        tools: context.context.tools,
        signal,
      });
      return hook.kind === "block" ? { block: true, reason: hook.reason } : undefined;
    },
    extensions: [hooks.extension({ promptTimestamp: () => undefined, turnContext: () => undefined })],
  });
  await harness.prompt("go");
  const toolResult = harness.state.messages.find((message) => message.role === "toolResult");
  const toolText =
    toolResult && toolResult.role === "toolResult"
      ? toolResult.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
      : "";
  return { modelRequests: core.state.callCount, toolText };
}

test("PreToolUse context reaches the model on its tool's result, together with PostToolUse context", async () => {
  const { dispatcher } = fakeDispatcher({
    PreToolUse: { additionalContext: fenced("staging is frozen"), ranHooks: ["policy"] },
    PostToolUse: { additionalContext: fenced("lint clean"), ranHooks: ["lint"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, dispatcher);
  const { modelRequests, toolText } = await runHookedTurn(hooks);
  assert.equal(modelRequests, 2);
  assert.ok(toolText.startsWith("echoed"));
  assert.ok(toolText.indexOf(fenced("staging is frozen")) > 0);
  assert.ok(toolText.indexOf(fenced("lint clean")) > toolText.indexOf(fenced("staging is frozen")));

  // With no PostToolUse hook at all, the PreToolUse context still arrives.
  const preOnly = createWorkspaceChatHooks(
    { chatId: "c" },
    fakeDispatcher({ PreToolUse: { additionalContext: fenced("read only"), ranHooks: ["p"] } }).dispatcher,
  );
  assert.ok((await runHookedTurn(preOnly)).toolText.includes(fenced("read only")));
});

test("continue: false from PreToolUse or PostToolUse lets the tool finish, then ends the turn with the stop reason", async () => {
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const messages: string[][] = [];
    const { dispatcher, calls } = fakeDispatcher({
      [event]: { stopTurn: true, stopReason: "deploy window closed", ranHooks: ["gate"] },
      Stop: { continueTurn: true, reason: "keep going", ranHooks: ["more"] },
    });
    const hooks = createWorkspaceChatHooks({ chatId: "c" }, dispatcher, {
      onMessages: (lines) => messages.push(lines),
    });
    const { modelRequests, toolText } = await runHookedTurn(hooks);
    assert.equal(modelRequests, 1, `${event}: no model request after the stop`);
    assert.ok(toolText.startsWith("echoed"), `${event}: the tool still ran`);
    assert.deepEqual(messages, [["Stopped by hook gate: deploy window closed"]]);
    assert.equal(hooks.stopRequested(), "Stopped by hook gate: deploy window closed");
    // Stop hooks never revive a turn a hook stopped.
    assert.equal(
      await hooks.onStop({ finalMessage: {} as never, continuations: 0, maxContinuations: 8, signal: new AbortController().signal }),
      undefined,
    );
    assert.ok(!calls.some((call) => call.event === "Stop"));
  }
});

test("hook messages and Aiden's notices go to the person, never into the tool result", async () => {
  const messages: string[][] = [];
  const { dispatcher } = fakeDispatcher({
    PostToolUse: { systemMessages: ["formatted 3 files"], notices: ["A hook timed out and was skipped."], ranHooks: ["fmt"] },
    UserPromptSubmit: { systemMessages: ["prompt logged"], ranHooks: ["audit"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, dispatcher, { onMessages: (lines) => messages.push(lines) });
  await hooks.dispatch("UserPromptSubmit", { prompt: "hi" });
  const { toolText } = await runHookedTurn(hooks);
  assert.deepEqual(messages, [
    ["Hook audit: prompt logged"],
    ["Hook fmt: formatted 3 files", "A hook timed out and was skipped."],
  ]);
  assert.equal(toolText, "echoed");

  // A listener that throws never breaks the chat.
  const throwing = createWorkspaceChatHooks({ chatId: "c" }, dispatcher, {
    onMessages: () => {
      throw new Error("renderer gone");
    },
  });
  assert.equal((await runHookedTurn(throwing)).modelRequests, 2);
});

test("this process forgets the least recently started chat once it tracks too many", () => {
  resetWorkspaceChatSessionsForTests();
  markWorkspaceChatSessionStarted({ chatId: "first" });
  markWorkspaceChatSessionStarted({ chatId: "second" });
  markWorkspaceChatCompacted("second");
  // Starting "first" again makes it the most recent, so "second" is the oldest.
  markWorkspaceChatSessionStarted({ chatId: "first" });
  for (let index = 0; index < MAX_TRACKED_HOOK_SESSIONS - 1; index += 1) {
    markWorkspaceChatSessionStarted({ chatId: `chat-${index}` });
  }
  assert.equal(workspaceChatSessionStartSource("second", true), "resume", "the oldest chat was forgotten, compaction too");
  assert.equal(workspaceChatSessionStartSource("first", true), undefined);
  assert.equal(workspaceChatSessionStartSource(`chat-${MAX_TRACKED_HOOK_SESSIONS - 2}`, true), undefined);
  resetWorkspaceChatSessionsForTests();
});
