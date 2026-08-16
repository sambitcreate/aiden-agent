import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  InMemorySessionRepo,
  type AgentMessage,
  type AgentTool,
  type Session,
} from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { appendPiMessages } from "./pi-compaction-session-store.js";
import {
  PiAgentRuntimeExtensionRegistry,
  PiAgentRuntimeHarness,
  PiAgentRuntimeHostError,
  type PiAgentRuntimeHarnessOptions,
  type PiHarnessFault,
} from "./pi-agent-runtime-harness.js";

function testHarness(
  responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  options: Partial<ConstructorParameters<typeof PiAgentRuntimeHarness>[0]> = {},
) {
  const core = createFauxCore({
    provider: `aiden-harness-${Math.random().toString(36).slice(2)}`,
  });
  core.setResponses(responses);
  const model = core.getModel();
  const { initialState: initialStateOverride, ...runtimeOptions } = options;
  const harness = new PiAgentRuntimeHarness({
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
    streamFn: core.streamSimple,
    initialState: {
      systemPrompt: "Base prompt",
      thinkingLevel: "off",
      tools: [],
      messages: [],
      ...initialStateOverride,
      model,
    },
    ...runtimeOptions,
  });
  return { core, harness };
}

async function managedTestHarness(
  responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  options: {
    tools?: AgentTool[];
    appendMessages?: (session: Session, messages: readonly AgentMessage[]) => Promise<void>;
    appendInput?: (session: Session, message: AgentMessage) => Promise<void>;
    beforeToolCall?: PiAgentRuntimeHarnessOptions["beforeToolCall"];
    contextWindow?: number;
    retryDelayMs?: number;
  } = {},
) {
  const core = createFauxCore({
    provider: `aiden-managed-harness-${Math.random().toString(36).slice(2)}`,
    ...(options.contextWindow
      ? {
          models: [
            {
              id: "managed-model",
              contextWindow: options.contextWindow,
              maxTokens: Math.max(256, Math.floor(options.contextWindow / 4)),
            },
          ],
        }
      : {}),
  });
  core.setResponses(responses);
  const model = core.getModel();
  const session = await new InMemorySessionRepo().create({
    id: `managed-${Math.random().toString(36).slice(2)}`,
  });
  const harness = new PiAgentRuntimeHarness({
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
    streamFn: core.streamSimple,
    initialState: {
      systemPrompt: "Managed prompt",
      thinkingLevel: "off",
      tools: options.tools ?? [],
      messages: [],
      model,
    },
    beforeToolCall: options.beforeToolCall,
    durability: {
      session,
      appendMessages: options.appendMessages ?? appendPiMessages,
      appendInput: options.appendInput,
      compaction: {
        models: createModels(),
        model,
        thinkingLevel: "off",
        retryDelayMs: options.retryDelayMs,
      },
    },
  });
  return { core, harness, session };
}

test("Pi runtime harness preserves sequential execution for effectful tool batches", async () => {
  const trace: string[] = [];
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const makeTool = (name: string, waits: boolean): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      trace.push(`${name}:start`);
      if (waits) await wait;
      trace.push(`${name}:end`);
      return { content: [{ type: "text", text: "ok" }], details: null };
    },
  });
  const first = makeTool("first_effect", true);
  const second = makeTool("second_effect", false);
  const { harness } = testHarness(
    [
      fauxAssistantMessage([fauxToolCall(first.name, {}), fauxToolCall(second.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ],
    {
      initialState: {
        tools: [first, second],
      },
    },
  );

  const run = harness.prompt("run both");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, ["first_effect:start"]);
  release();
  await run;
  assert.deepEqual(trace, [
    "first_effect:start",
    "first_effect:end",
    "second_effect:start",
    "second_effect:end",
  ]);
});

test("extension observer failures are reported without corrupting the Pi turn", async () => {
  const faults: PiHarnessFault[] = [];
  const { harness } = testHarness([fauxAssistantMessage("still completed")], {
    extensions: [
      {
        id: "throwing-observer",
        onEvent: () => {
          throw new Error("observer failed");
        },
      },
    ],
    onFault: (fault) => faults.push(fault),
  });

  await assert.doesNotReject(harness.prompt("continue"));
  assert.equal(harness.state.messages[harness.state.messages.length - 1]?.role, "assistant");
  assert.ok(faults.length > 0);
  assert.ok(faults.every((fault) => fault.source === "extension_observer"));
});

test("critical lifecycle failures abort and surface one typed host failure", async () => {
  const faults: PiHarnessFault[] = [];
  const { harness } = testHarness([fauxAssistantMessage("provider reply")], {
    onFault: (fault) => faults.push(fault),
  });
  harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      throw new Error("durable sink unavailable");
    }
  });

  await assert.rejects(
    harness.prompt("start"),
    (error: unknown) =>
      error instanceof PiAgentRuntimeHostError &&
      error.faultKind === "lifecycle" &&
      !JSON.stringify(error).includes("durable sink unavailable"),
  );
  assert.equal(harness.state.isStreaming, false);
  assert.equal(harness.signal, undefined);
  assert.equal(faults.filter((fault) => fault.source === "lifecycle_subscriber").length, 1);
});

test("trusted extension snapshots compose Pi tools and prompt resources exactly once", async () => {
  const registry = new PiAgentRuntimeExtensionRegistry();
  const extensionTool: AgentTool = {
    name: "extension_echo",
    label: "Extension echo",
    description: "Echo from a trusted extension.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "extension result" }],
      details: null,
    }),
  };
  registry.register({
    id: "trusted-fixture",
    systemPrompt: "Extension prompt",
    tools: [extensionTool],
  });
  const { harness } = testHarness(
    [
      fauxAssistantMessage([fauxToolCall("extension_echo", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("ok"),
    ],
    { extensions: registry.snapshot() },
  );
  extensionTool.name = "mutated_after_snapshot";

  assert.equal(harness.state.systemPrompt, "Base prompt\n\nExtension prompt");
  assert.deepEqual(
    harness.state.tools.map((tool) => tool.name),
    ["extension_echo"],
  );
  await assert.doesNotReject(harness.prompt("use extension tool"));
  assert.throws(() => registry.register({ id: "trusted-fixture" }), /identities must be unique/u);
});

test("passive observers cannot mutate tool results or delay Pi settlement", async () => {
  const tool: AgentTool = {
    name: "stable_result",
    label: "Stable result",
    description: "Return a stable result.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "original" }],
      details: null,
    }),
  };
  let observerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    observerStarted = resolve;
  });
  const { harness } = testHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ],
    {
      initialState: { tools: [tool] },
      extensions: [
        {
          id: "passive-observer",
          onEvent: async (event) => {
            if (event.type !== "tool_execution_end") return;
            event.result.content = [{ type: "text", text: "mutated" }];
            observerStarted();
            await new Promise<never>(() => undefined);
          },
        },
      ],
    },
  );

  await harness.prompt("run");
  await started;
  const toolResult = harness.state.messages.find((message) => message.role === "toolResult");
  assert.equal(toolResult?.role, "toolResult");
  assert.equal(toolResult?.content[0]?.type, "text");
  assert.equal(
    toolResult?.content[0]?.type === "text" ? toolResult.content[0].text : undefined,
    "original",
  );
});

test("active extension hooks fail closed before provider or tool-result continuation", async () => {
  const contextFaults: PiHarnessFault[] = [];
  const context = testHarness([fauxAssistantMessage("must not run")], {
    extensions: [
      {
        id: "context-policy",
        transformContext: async () => {
          throw new Error("private context failure");
        },
      },
    ],
    onFault: (fault) => contextFaults.push(fault),
  });
  await assert.rejects(context.harness.prompt("start"));
  assert.equal(context.core.state.callCount, 0);
  assert.equal(contextFaults[0]?.source, "extension_context");

  const tool: AgentTool = {
    name: "extension_finalize",
    label: "Extension finalize",
    description: "Exercise an after-tool policy.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "private raw result" }],
      details: null,
    }),
  };
  const finalized = testHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
    ],
    {
      initialState: { tools: [tool] },
      extensions: [
        {
          id: "result-policy",
          afterToolCall: async () => {
            throw new Error("private result failure");
          },
        },
      ],
    },
  );
  await assert.rejects(
    finalized.harness.prompt("run"),
    (error: unknown) => error instanceof PiAgentRuntimeHostError,
  );
  const result = finalized.harness.state.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  assert.equal(result?.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private raw|private result/u);
});

test("registry descriptors and critical faults remain operation-scoped snapshots", async () => {
  let originalEvents = 0;
  let mutatedEvents = 0;
  const extension = {
    id: "immutable-snapshot",
    onEvent: () => {
      originalEvents += 1;
    },
  };
  const registry = new PiAgentRuntimeExtensionRegistry();
  registry.register(extension);
  let reentry: Promise<unknown> | undefined;
  let harness!: PiAgentRuntimeHarness;
  const fixture = testHarness([fauxAssistantMessage("reply")], {
    extensions: registry.snapshot(),
    onFault: (fault) => {
      if (fault.source === "lifecycle_subscriber") {
        reentry = harness.prompt("reenter").catch((error: unknown) => error);
      }
    },
  });
  harness = fixture.harness;
  extension.onEvent = () => {
    mutatedEvents += 1;
  };
  harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      throw new Error("critical sink failed");
    }
  });

  await assert.rejects(
    harness.prompt("start"),
    (error: unknown) => error instanceof PiAgentRuntimeHostError,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(originalEvents > 0);
  assert.equal(mutatedEvents, 0);
  assert.ok((await reentry) instanceof Error);
});

test("cancelAndSettle waits through the harness operation boundary", async () => {
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tool: AgentTool = {
    name: "abortable_work",
    label: "Abortable work",
    description: "Wait until cancellation.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _args, signal) => {
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: [{ type: "text", text: "stopped" }], details: null };
    },
  };
  const { harness } = testHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
    ],
    { initialState: { tools: [tool] } },
  );
  const running = harness.prompt("start").catch((error: unknown) => error);
  await toolStarted;

  await harness.cancelAndSettle();
  assert.doesNotThrow(() => harness.reset());
  await running;
});

test("managed run journals its input exactly once before provider execution", async () => {
  const { core, harness, session } = await managedTestHarness([fauxAssistantMessage("done")]);
  const input: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "one durable request" }],
    timestamp: Date.now(),
  };

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: input,
  });

  assert.equal(outcome.kind, "completed");
  assert.equal(core.state.callCount, 1);
  const context = (await session.buildContext()).messages;
  assert.equal(
    context.filter(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("one durable request"),
    ).length,
    1,
  );
});

test("managed run commits an assistant tool plan before executing effects", async () => {
  const trace: string[] = [];
  let releasePlan!: () => void;
  const planMayCommit = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  let planAppendStarted!: () => void;
  const planAppend = new Promise<void>((resolve) => {
    planAppendStarted = resolve;
  });
  const tool: AgentTool = {
    name: "durable_effect",
    label: "Durable effect",
    description: "Record one effect.",
    parameters: Type.Object({}),
    execute: async () => {
      trace.push("tool");
      return { content: [{ type: "text", text: "effect done" }], details: null };
    },
  };
  const { harness } = await managedTestHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("complete"),
    ],
    {
      tools: [tool],
      appendMessages: async (session, messages) => {
        if (
          messages.some(
            (message) => message.role === "assistant" && message.stopReason === "toolUse",
          )
        ) {
          trace.push("plan-append");
          planAppendStarted();
          await planMayCommit;
        }
        await appendPiMessages(session, messages);
      },
    },
  );
  const running = harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "run the effect" }],
      timestamp: Date.now(),
    },
  });

  await planAppend;
  assert.deepEqual(trace, ["plan-append"]);
  releasePlan();
  const outcome = await running;
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(trace, ["plan-append", "tool"]);
});

test("managed run fails closed when a tool plan cannot become durable", async () => {
  let toolCalls = 0;
  const tool: AgentTool = {
    name: "must_not_run",
    label: "Must not run",
    description: "Must remain behind durability.",
    parameters: Type.Object({}),
    execute: async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "unsafe" }], details: null };
    },
  };
  const { harness } = await managedTestHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
    ],
    {
      tools: [tool],
      appendMessages: async (session, messages) => {
        if (messages.some((message) => message.role === "assistant")) {
          throw new Error("PRIVATE_JOURNAL_CANARY");
        }
        await appendPiMessages(session, messages);
      },
    },
  );

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "attempt effect" }],
      timestamp: Date.now(),
    },
  });

  assert.equal(outcome.kind, "host_failed");
  assert.equal(outcome.kind === "host_failed" ? outcome.faultKind : undefined, "session");
  assert.equal(toolCalls, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_JOURNAL_CANARY/u);
});

test("managed before-tool policy faults stop before another provider request", async () => {
  let toolCalls = 0;
  const tool: AgentTool = {
    name: "policy_guarded_tool",
    label: "Policy guarded tool",
    description: "Must not run after a host policy fault.",
    parameters: Type.Object({}),
    execute: async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "unsafe" }], details: null };
    },
  };
  const { core, harness } = await managedTestHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("must not receive a second request"),
    ],
    {
      tools: [tool],
      beforeToolCall: async () => {
        throw new Error("PRIVATE_POLICY_CANARY");
      },
    },
  );

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "test the policy boundary" }],
      timestamp: Date.now(),
    },
  });

  assert.equal(outcome.kind, "host_failed");
  assert.equal(outcome.kind === "host_failed" ? outcome.faultKind : undefined, "policy");
  assert.equal(toolCalls, 0);
  assert.equal(core.state.callCount, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_POLICY_CANARY/u);
});

test("managed run starts no second provider step when a tool result cannot persist", async () => {
  let toolCalls = 0;
  const tool: AgentTool = {
    name: "one_durable_tool",
    label: "One durable tool",
    description: "Run once before the injected result failure.",
    parameters: Type.Object({}),
    execute: async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "result" }], details: null };
    },
  };
  const { core, harness } = await managedTestHarness(
    [
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("must not run"),
    ],
    {
      tools: [tool],
      appendMessages: async (session, messages) => {
        if (messages.some((message) => message.role === "toolResult")) {
          throw new Error("PRIVATE_RESULT_CANARY");
        }
        await appendPiMessages(session, messages);
      },
    },
  );

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "run once" }],
      timestamp: Date.now(),
    },
  });

  assert.equal(outcome.kind, "host_failed");
  assert.equal(outcome.kind === "host_failed" ? outcome.faultKind : undefined, "session");
  assert.equal(toolCalls, 1);
  assert.equal(core.state.callCount, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_RESULT_CANARY/u);
});

test("managed cancellation owns retry hooks and prevents post-stop provider work", async () => {
  let retryStarted!: () => void;
  const atRetry = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  const { core, harness } = await managedTestHarness(
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 service unavailable",
      }),
      fauxAssistantMessage("must not run"),
    ],
    { retryDelayMs: 500 },
  );
  const running = harness.runManaged(
    {
      kind: "append-and-run",
      message: {
        role: "user",
        content: [{ type: "text", text: "retry once" }],
        timestamp: Date.now(),
      },
    },
    {
      onRetry: async () => {
        retryStarted();
        await new Promise<never>(() => undefined);
      },
    },
  );
  await atRetry;
  assert.throws(() => harness.reset(), /busy/u);
  await assert.rejects(harness.runManaged({ kind: "continue-durable-tail" }), /busy/u);

  const settled = await harness.cancelAndSettle();
  const outcome = await running;
  assert.equal(outcome.kind, "app_cancelled");
  assert.equal(settled?.kind, "app_cancelled");
  assert.equal(core.state.callCount, 1);
});

test("managed outcomes keep provider failure details behind the private journal", async () => {
  const { harness } = await managedTestHarness([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "503 PRIVATE_PROVIDER_CANARY",
    }),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "network error PRIVATE_PROVIDER_CANARY",
    }),
  ]);

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "complete safely" }],
      timestamp: Date.now(),
    },
  });

  assert.equal(outcome.kind, "provider_failed");
  assert.equal(outcome.attempts, 2);
  assert.equal(
    outcome.kind === "provider_failed" ? outcome.finalMessageWasAbandoned : undefined,
    true,
  );
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_PROVIDER_CANARY/u);
});

test("critical lifecycle faults outrank a concurrent app cancellation", async () => {
  const { harness } = await managedTestHarness([fauxAssistantMessage("terminal")]);
  harness.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") {
      return;
    }
    harness.abort();
    throw new Error("PRIVATE_LIFECYCLE_CANARY");
  });

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "race cancellation" }],
      timestamp: Date.now(),
    },
  });

  assert.equal(outcome.kind, "host_failed");
  assert.equal(outcome.kind === "host_failed" ? outcome.faultKind : undefined, "lifecycle");
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_LIFECYCLE_CANARY/u);
});

test("managed cancellation settles while session opening is still pending", async () => {
  const core = createFauxCore({ provider: "aiden-managed-pending-session" });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const model = core.getModel();
  let resolveSession!: (session: Session) => void;
  const pendingSession = new Promise<Session>((resolve) => {
    resolveSession = resolve;
  });
  let appends = 0;
  const harness = new PiAgentRuntimeHarness({
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
    streamFn: core.streamSimple,
    initialState: {
      systemPrompt: "Pending session",
      thinkingLevel: "off",
      tools: [],
      messages: [],
      model,
    },
    durability: {
      session: pendingSession,
      appendMessages: async (session, messages) => {
        appends += 1;
        await appendPiMessages(session, messages);
      },
      compaction: {
        models: createModels(),
        model,
        thinkingLevel: "off",
      },
    },
  });
  const running = harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "do not start" }],
      timestamp: Date.now(),
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const settled = await harness.cancelAndSettle();
  const outcome = await running;
  assert.equal(settled?.kind, "app_cancelled");
  assert.equal(outcome.kind, "app_cancelled");
  assert.equal(outcome.attempts, 0);
  assert.equal(core.state.callCount, 0);
  assert.equal(appends, 0);

  resolveSession(await new InMemorySessionRepo().create({ id: "late-managed-session" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(appends, 0);
});

test("managed cancellation settles while input journaling is still pending", async () => {
  let inputAppendStarted!: () => void;
  const atInputAppend = new Promise<void>((resolve) => {
    inputAppendStarted = resolve;
  });
  const { core, harness } = await managedTestHarness([fauxAssistantMessage("must not run")], {
    appendInput: async () => {
      inputAppendStarted();
      await new Promise<never>(() => undefined);
    },
  });
  const running = harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "cancel the blocked append" }],
      timestamp: Date.now(),
    },
  });
  await atInputAppend;

  const settled = await harness.cancelAndSettle();
  const outcome = await running;
  assert.equal(settled?.kind, "app_cancelled");
  assert.equal(outcome.kind, "app_cancelled");
  assert.equal(core.state.callCount, 0);
});

test("managed cancellation exposes a detached prior-tail repair for quarantine", async () => {
  const { core, harness, session } = await managedTestHarness([
    fauxAssistantMessage("must not run"),
  ]);
  const model = harness.state.model;
  await appendPiMessages(session, [
    {
      role: "user",
      content: [{ type: "text", text: "old request" }],
      timestamp: 10,
    },
    {
      ...fauxAssistantMessage("old partial", {
        stopReason: "error",
        errorMessage: "503 old failure",
        timestamp: 20,
      }),
      api: model.api,
      provider: model.provider,
      model: model.id,
    },
  ]);
  let moveStarted!: () => void;
  let releaseMove!: () => void;
  const atMove = new Promise<void>((resolve) => {
    moveStarted = resolve;
  });
  const moveGate = new Promise<void>((resolve) => {
    releaseMove = resolve;
  });
  const originalMoveTo = session.moveTo.bind(session);
  session.moveTo = async (entryId) => {
    moveStarted();
    await moveGate;
    return originalMoveTo(entryId);
  };

  const running = harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "new request" }],
      timestamp: 30,
    },
  });
  await atMove;
  const outcome = await harness.cancelAndSettle();
  const finalOutcome = await running;
  assert.equal(outcome?.kind, "app_cancelled");
  assert.equal(finalOutcome.kind, "app_cancelled");
  const detached = harness.pendingDurabilitySettlement();
  assert.ok(detached);
  assert.equal(core.state.callCount, 0);

  releaseMove();
  await detached;
  assert.equal(harness.pendingDurabilitySettlement(), undefined);
  assert.deepEqual(
    (await session.buildContext()).messages.map((message) => message.role),
    ["user"],
  );
});

test("managed run removes a prior retryable assistant before the new provider context", async () => {
  let observedRoles: string[] = [];
  let observedText = "";
  const { harness, session } = await managedTestHarness([
    (context) => {
      observedRoles = context.messages.map((message) => message.role);
      observedText = JSON.stringify(context.messages);
      return fauxAssistantMessage("recovered");
    },
  ]);
  await appendPiMessages(session, [
    {
      role: "user",
      content: [{ type: "text", text: "old request" }],
      timestamp: 10,
    },
    {
      ...fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 PRIVATE_PRIOR_FAILURE",
        timestamp: 20,
      }),
      api: harness.state.model.api,
      provider: harness.state.model.provider,
      model: harness.state.model.id,
    },
  ]);

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "new request" }],
      timestamp: 30,
    },
  });

  assert.equal(outcome.kind, "completed");
  assert.deepEqual(observedRoles, ["user", "user"]);
  assert.doesNotMatch(observedText, /PRIVATE_PRIOR_FAILURE/u);
});

test("required preflight compaction failure starts no provider request", async () => {
  const { core, harness, session } = await managedTestHarness(
    [fauxAssistantMessage("must not run")],
    { contextWindow: 2_048 },
  );
  const model = harness.state.model;
  await appendPiMessages(session, [
    {
      role: "user",
      content: [{ type: "text", text: `old one ${"a".repeat(3_000)}` }],
      timestamp: 10,
    },
    {
      ...fauxAssistantMessage("old answer one", { timestamp: 20 }),
      api: model.api,
      provider: model.provider,
      model: model.id,
    },
    {
      role: "user",
      content: [{ type: "text", text: `old two ${"b".repeat(3_000)}` }],
      timestamp: 30,
    },
    {
      ...fauxAssistantMessage("old answer two", { timestamp: 40 }),
      api: model.api,
      provider: model.provider,
      model: model.id,
    },
  ]);

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "new request" }],
      timestamp: 50,
    },
  });

  assert.equal(outcome.kind, "provider_failed");
  assert.equal(
    outcome.kind === "provider_failed" ? outcome.reason : undefined,
    "compaction-failed",
  );
  assert.equal(outcome.attempts, 0);
  assert.equal(core.state.callCount, 0);
});

test("managed cancellation during immediate compaction stays app-cancelled", async () => {
  const provider = `aiden-immediate-compaction-${Math.random().toString(36).slice(2)}`;
  const api = `aiden-immediate-compaction-api-${Math.random().toString(36).slice(2)}`;
  const core = createFauxCore({ api, provider });
  const model = core.getModel();
  const summaryProvider = fauxProvider({
    api,
    provider,
    models: [
      {
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
  const models = createModels();
  models.setProvider(summaryProvider.provider);
  let summaryStarted!: () => void;
  const atSummary = new Promise<void>((resolve) => {
    summaryStarted = resolve;
  });
  summaryProvider.setResponses([
    async (_context, options) => {
      summaryStarted();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("cancelled summary");
    },
  ]);
  const tool: AgentTool = {
    name: "large_result",
    label: "Large result",
    description: "Produce a result that requires immediate compaction.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "x".repeat(140_000) }],
      details: null,
    }),
  };
  core.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("must not run"),
  ]);
  const session = await new InMemorySessionRepo().create({
    id: `immediate-compaction-${Math.random().toString(36).slice(2)}`,
  });
  const harness = new PiAgentRuntimeHarness({
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
    streamFn: core.streamSimple,
    initialState: {
      systemPrompt: "Immediate compaction cancellation",
      thinkingLevel: "off",
      tools: [tool],
      messages: [],
      model,
    },
    durability: {
      session,
      appendMessages: appendPiMessages,
      compaction: { models, model, thinkingLevel: "off" },
    },
  });
  const running = harness.runManaged({
    kind: "append-and-run",
    message: {
      role: "user",
      content: [{ type: "text", text: "produce the large result" }],
      timestamp: Date.now(),
    },
  });
  await atSummary;

  const settled = await harness.cancelAndSettle();
  const outcome = await running;
  assert.equal(settled?.kind, "app_cancelled");
  assert.equal(outcome.kind, "app_cancelled");
  assert.equal(core.state.callCount, 1);
});
