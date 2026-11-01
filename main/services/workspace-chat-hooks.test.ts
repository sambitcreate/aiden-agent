import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type, fauxProvider, type Api, type Model } from "@earendil-works/pi-ai";
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
import { createChatStore } from "./chat-store-core.js";
import { isHookBlockedPrompt } from "./hook-blocked-prompt.js";
import type { ChatMessage } from "./types.js";
import { PiCompactionSessionStore, syncChatMessagesToPiSession } from "./pi-compaction-session-store.js";
import { PiAgentRuntimeHarness } from "./pi-agent-runtime-harness.js";
import {
  MAX_STOP_HOOK_CONTINUATIONS,
  MAX_TRACKED_HOOK_SESSIONS,
  createRunInputContexts,
  createWorkspaceChatHooks,
  endWorkspaceChatSession,
  hookTurnContextText,
  markWorkspaceChatCompacted,
  markWorkspaceChatSessionStarted,
  preCompactSummaryInstructions,
  promptBlockedMessage,
  resetWorkspaceChatSessionsForTests,
  runPromptIntakeHooks,
  screenRunInputWithHooks,
  workspaceChatSessionStartSource,
} from "./workspace-chat-hooks.js";
import { createChatRunInputAdmission, type ChatRunInputGenerationRef } from "./chat-run-input-admission.js";

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
  assert.equal(deny.calls[0]!.payload.tool_use_id, "call-1");

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
  assert.equal(calls[0]!.payload.tool_use_id, "call-9");

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

  const { dispatcher, calls } = fakeDispatcher({
    SessionEnd: { ranHooks: ["cleanup"], systemMessages: ["Removed the scratch branch."] },
  });
  const shown: string[][] = [];
  endWorkspaceChatSession("life", dispatcher, { onMessages: (lines) => shown.push(lines) });
  endWorkspaceChatSession("life", dispatcher, { onMessages: (lines) => shown.push(lines) });
  endWorkspaceChatSession("never-started", dispatcher);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.event, call.payload.session_id, call.payload.cwd, call.payload.reason, call.payload.aiden_reason]),
    [["SessionEnd", "life", "/work/app", "other", "chat_deleted"]],
  );
  // The chat is gone, so its hook's message goes where the caller says, once.
  assert.deepEqual(shown, [["Hook cleanup: Removed the scratch branch."]]);
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
    Notification: { systemMessages: ["pinged your phone"], ranHooks: ["ping"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: "c" }, dispatcher, { onMessages: (lines) => messages.push(lines) });
  await hooks.dispatch("UserPromptSubmit", { prompt: "hi" });
  const { toolText } = await runHookedTurn(hooks);
  // An approval card's Notification (fire-and-forget) reports the same way.
  hooks.notify("Aiden needs your permission for a subagent", "permission_prompt");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [
    ["Hook audit: prompt logged"],
    ["Hook fmt: formatted 3 files", "A hook timed out and was skipped."],
    ["Hook ping: pinged your phone"],
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

/* Prompt intake: SessionStart, then UserPromptSubmit, before the model sees a turn. */

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function fauxModel(): Model<Api> {
  return fauxProvider({
    api: "openai-completions",
    provider: `hook-intake-${Math.random().toString(36).slice(2)}`,
    models: [{ id: "hook-intake-model", contextWindow: 8_000, maxTokens: 1_000 }],
  }).getModel() as Model<Api>;
}

test("a blocked prompt the person retries once the hook lets it through reaches the model before its reply", async (t) => {
  resetWorkspaceChatSessionsForTests();
  const chatsRoot = await tempDir(t, "aiden-hook-intake-chats-");
  const store = createChatStore(async () => chatsRoot);
  const chat = await store.create({ workspaceId: "workspace" });
  const appended = await store.appendMessage(chat.id, { role: "user", content: "Deploy the staging branch" });
  const promptId = appended.messages.slice(-1)[0]!.id;
  const errors: string[] = [];
  const intake = (dispatcher: () => HookDispatcher, prompt: Parameters<typeof runPromptIntakeHooks>[0]["prompt"], turn: string) =>
    runPromptIntakeHooks({
      target: { chatId: chat.id },
      dispatch: createWorkspaceChatHooks({ chatId: chat.id }, dispatcher).dispatch,
      hasPriorMessages: false,
      prompt,
      store,
      idempotencyKeys: { userPromptSubmit: `UserPromptSubmit:${chat.id}:${turn}` },
      onStoreError: (message) => errors.push(message),
    });

  const refusing = fakeDispatcher({ UserPromptSubmit: { blockPrompt: true, reason: "deploys are frozen", ranHooks: ["freeze"] } });
  await assert.rejects(intake(refusing.dispatcher, appended.messages.slice(-1)[0]!, "1"), /Blocked by hook freeze: deploys are frozen/u);
  assert.equal((await store.get(chat.id))!.messages.slice(-1)[0]!.hookBlocked?.reason, "Blocked by hook freeze: deploys are frozen");

  // The retry turn loads the stored prompt, mark and all, and the hook now passes it.
  const currentUser = (await store.get(chat.id))!.messages.find((message) => message.id === promptId)!;
  const passing = fakeDispatcher({ UserPromptSubmit: { ranHooks: ["freeze"] } });
  await intake(passing.dispatcher, currentUser, "2");
  assert.equal(currentUser.hookBlocked, undefined, "the turn's own copy is unmarked before the journal takes it");
  assert.equal((await store.get(chat.id))!.messages.slice(-1)[0]!.hookBlocked, undefined, "the stored mark is cleared");
  assert.deepEqual(errors, []);

  // The turn journals its prompt, then the reply, in that order.
  const model = fauxModel();
  const piRoot = await tempDir(t, "aiden-hook-intake-pi-");
  const sessions = new PiCompactionSessionStore({ root: async () => piRoot });
  const session = await sessions.openChat(chat.id);
  await syncChatMessagesToPiSession(session, [currentUser], model, false);
  const replied = await store.appendMessage(chat.id, { role: "assistant", content: "Staging is deploying now." });
  await syncChatMessagesToPiSession(session, replied.messages, model, false);
  const context = JSON.stringify(await session.buildContext());
  const promptAt = context.indexOf("Deploy the staging branch");
  assert.ok(promptAt >= 0, "the retried prompt reaches the model");
  assert.ok(context.indexOf("Staging is deploying now.") > promptAt, "and it comes before its reply");
});

test("a follow-up turn that starts from Aiden's own notice runs SessionStart but never screens the notice", async () => {
  resetWorkspaceChatSessionsForTests();
  let writes = 0;
  const store = {
    async setPromptHookBlock(): Promise<boolean> {
      writes += 1;
      return true;
    },
  };
  const { dispatcher, calls } = fakeDispatcher({
    SessionStart: { additionalContext: fenced("branch: main"), ranHooks: ["start"] },
    UserPromptSubmit: { blockPrompt: true, reason: "no prompts today", ranHooks: ["scan"] },
  });
  const context = await runPromptIntakeHooks({
    target: { chatId: "follow-up-notice" },
    dispatch: createWorkspaceChatHooks({ chatId: "follow-up-notice" }, dispatcher).dispatch,
    hasPriorMessages: false,
    prompt: { id: "notice-1", content: "The background task finished.", notice: { version: 1, kind: "task" } },
    store,
    idempotencyKeys: { userPromptSubmit: "UserPromptSubmit:follow-up-notice:1" },
    onStoreError: () => assert.fail("nothing is written"),
  });
  assert.deepEqual(calls.map((call) => call.event), ["SessionStart"]);
  assert.match(context ?? "", /branch: main/u);
  assert.equal(writes, 0, "the notice is never marked blocked");
});

test("a prompt stays out of the model's context when writing its blocked mark fails", async (t) => {
  resetWorkspaceChatSessionsForTests();
  let writes = 0;
  const failingStore = {
    async setPromptHookBlock(): Promise<boolean> {
      writes += 1;
      throw new Error("disk full");
    },
  };
  const errors: string[] = [];
  const prompt = { id: `prompt-${Math.random().toString(36).slice(2)}`, content: "ship it with key sk-live-FAILCLOSED" };
  const { dispatcher } = fakeDispatcher({ UserPromptSubmit: { blockPrompt: true, reason: "secret in prompt", ranHooks: ["scan"] } });
  await assert.rejects(
    runPromptIntakeHooks({
      target: { chatId: "fail-closed" },
      dispatch: createWorkspaceChatHooks({ chatId: "fail-closed" }, dispatcher).dispatch,
      hasPriorMessages: false,
      prompt,
      store: failingStore,
      idempotencyKeys: { userPromptSubmit: "UserPromptSubmit:fail-closed:1" },
      onStoreError: (message) => errors.push(message),
    }),
    /Blocked by hook scan: secret in prompt/u,
  );
  assert.equal(writes, 2, "the write is retried once");
  assert.deepEqual(errors, ["Could not mark a hook-blocked prompt."]);

  // The unmarked message, as the store still holds it, never reaches a journal.
  const stored = { ...prompt, role: "user" as const, createdAt: Date.now() };
  assert.equal(isHookBlockedPrompt(stored), true);
  const piRoot = await tempDir(t, "aiden-hook-failclosed-pi-");
  const sessions = new PiCompactionSessionStore({ root: async () => piRoot });
  const session = await sessions.openChat("fail-closed");
  await syncChatMessagesToPiSession(session, [stored], fauxModel(), false);
  assert.doesNotMatch(JSON.stringify(await session.buildContext()), /sk-live-FAILCLOSED/u);
});

test("a steer or follow-up sent mid-run is screened by UserPromptSubmit: refused input never reaches the model, and context rides that input only", async (t) => {
  resetWorkspaceChatSessionsForTests();
  const chatsRoot = await tempDir(t, "aiden-hook-run-input-chats-");
  const store = createChatStore(async () => chatsRoot);
  const chat = await store.create({ workspaceId: "workspace" });
  await store.appendMessage(chat.id, { role: "user", content: "Start the migration" });
  const { dispatcher, calls } = fakeDispatcher({
    UserPromptSubmit: (payload) =>
      String(payload.prompt).includes("sk-live")
        ? { blockPrompt: true, reason: "secret in prompt", ranHooks: ["scan"] }
        : { additionalContext: fenced("ticket: OPS-12"), ranHooks: ["scan"] },
  });
  const hooks = createWorkspaceChatHooks({ chatId: chat.id }, dispatcher);
  const contexts = createRunInputContexts();
  const queued: AgentMessage[] = [];
  const savedOnDisk: ChatMessage[] = [];
  let clock = 1_000;
  let ids = 0;
  const generation: ChatRunInputGenerationRef = {
    chatId: chat.id,
    owner: { documentId: "doc" },
    cancelRequested: false,
    inputHooks: {
      screen: ({ text, messageId }) =>
        screenRunInputWithHooks({ dispatch: hooks.dispatch, text, idempotencyKey: `UserPromptSubmit:${messageId}` }),
      attachContext: contexts.attach,
    },
    agent: {
      queueAdmissionBlocked: () => undefined,
      queueSteer: (message: AgentMessage) => (queued.push(message), { accepted: true, queue: "steer" }),
      queueFollowUp: (message: AgentMessage) => (queued.push(message), { accepted: true, queue: "follow-up" }),
    } as unknown as ChatRunInputGenerationRef["agent"],
  };
  const admission = createChatRunInputAdmission({
    active: new Map([["stream", generation]]),
    isChatDeleting: () => false,
    appendMessage: async (chatId, message, meta) => {
      const saved = await store.appendMessage(chatId, message, meta);
      // What a fresh process would read if Aiden quit right after this write.
      const reopened = await createChatStore(async () => chatsRoot).get(chatId);
      savedOnDisk.push(reopened!.messages.find((entry) => entry.id === message.id)!);
      return saved;
    },
    readChat: (chatId) => store.get(chatId),
    now: () => (clock += 1),
    newMessageId: () => `message_run_input_${(ids += 1)}`,
  });

  const refused = await admission.admit({ streamId: "stream", mode: "steer", text: "use key sk-live-STEERED" });
  assert.deepEqual(refused, { admitted: false, reason: "invalid", committed: true, messageId: "message_run_input_1" });
  const passed = await admission.admit({ streamId: "stream", mode: "queue", text: "then run the tests" });
  assert.equal(passed.admitted, true);
  assert.deepEqual(
    calls.map((call) => call.payload.prompt),
    ["use key sk-live-STEERED", "then run the tests"],
    "each input is screened as the person's prompt",
  );
  // A notice is Aiden's own words, so it is never screened.
  await admission.admit({
    streamId: "stream",
    mode: "queue",
    text: "A background task finished.",
    notice: { kind: "background_task" } as never,
  });
  assert.equal(calls.length, 2);

  // The refused steer is saved already marked, in the one write that saves
  // it, so quitting after that write can never leave an unmarked copy.
  assert.equal(savedOnDisk[0]?.content, "use key sk-live-STEERED");
  assert.equal(savedOnDisk[0]?.hookBlocked?.reason, "Blocked by hook scan: secret in prompt");
  assert.equal(savedOnDisk[1]?.hookBlocked, undefined, "accepted input is not marked");
  // The refused steer is kept, marked, and never queued.
  const stored = (await store.get(chat.id))!.messages;
  const blocked = stored.find((message) => message.content === "use key sk-live-STEERED")!;
  assert.equal(blocked.hookBlocked?.reason, "Blocked by hook scan: secret in prompt");
  assert.deepEqual(queued.map((message) => (message.role === "user" ? message.content : undefined)), [
    "then run the tests",
    "A background task finished.",
  ]);
  const model = fauxModel();
  const piRoot = await tempDir(t, "aiden-hook-run-input-pi-");
  const session = await new PiCompactionSessionStore({ root: async () => piRoot }).openChat(chat.id);
  await syncChatMessagesToPiSession(session, stored, model, false);
  assert.doesNotMatch(JSON.stringify(await session.buildContext()), /sk-live-STEERED/u);

  // The follow-up's hook context reaches the model on that message, not on the run's prompt.
  const extension = hooks.extension({
    promptTimestamp: () => 1,
    turnContext: () => undefined,
    inputContext: contexts.lookup,
  });
  const prompt: AgentMessage = { role: "user", content: "Start the migration", timestamp: 1 };
  const transformed = await extension.transformContext!([prompt, ...queued], undefined);
  assert.deepEqual(transformed[0], prompt);
  assert.deepEqual((transformed[1] as Extract<AgentMessage, { role: "user" }>).content, [
    { type: "text", text: "then run the tests" },
    { type: "text", text: `[Aiden hook] Context from the person's hooks for this message:\n\n${fenced("ticket: OPS-12")}` },
  ]);
  assert.deepEqual(transformed[2], queued[1]);
  assert.equal(queued[0]!.role === "user" ? queued[0]!.content : undefined, "then run the tests", "the queued copy is untouched");
});

test("SessionStart continue: false ends the turn before the prompt is checked, and the next message starts the session again", async () => {
  resetWorkspaceChatSessionsForTests();
  const { dispatcher, calls } = fakeDispatcher({
    SessionStart: { stopTurn: true, stopReason: "the repo is locked", ranHooks: ["gate"] },
    UserPromptSubmit: { ranHooks: ["audit"] },
  });
  let writes = 0;
  const hooks = createWorkspaceChatHooks({ chatId: "locked" }, dispatcher);
  await assert.rejects(
    runPromptIntakeHooks({
      target: { chatId: "locked" },
      dispatch: hooks.dispatch,
      hasPriorMessages: false,
      prompt: { id: "locked-prompt", content: "hello" },
      store: { setPromptHookBlock: async () => { writes += 1; return true; } },
      idempotencyKeys: { userPromptSubmit: "UserPromptSubmit:locked:1" },
      onStoreError: () => {},
    }),
    (error: Error) => error.message === "Stopped by hook gate: the repo is locked",
  );
  assert.deepEqual(calls.map((call) => call.event), ["SessionStart"], "UserPromptSubmit never runs");
  assert.equal(writes, 0, "the prompt is not marked blocked");
  assert.equal(isHookBlockedPrompt({ id: "locked-prompt", role: "user" }), false);
  assert.equal(workspaceChatSessionStartSource("locked", false), "startup", "the session did not start");
  resetWorkspaceChatSessionsForTests();
});
