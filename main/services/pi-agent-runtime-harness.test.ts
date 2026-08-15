import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  PiAgentRuntimeExtensionRegistry,
  PiAgentRuntimeHarness,
  PiAgentRuntimeHostError,
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
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult",
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
      fauxAssistantMessage(
        [fauxToolCall(first.name, {}), fauxToolCall(second.name, {})],
        {
          stopReason: "toolUse",
        },
      ),
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
  assert.equal(
    harness.state.messages[harness.state.messages.length - 1]?.role,
    "assistant",
  );
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
  assert.equal(
    faults.filter((fault) => fault.source === "lifecycle_subscriber").length,
    1,
  );
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
  assert.throws(
    () => registry.register({ id: "trusted-fixture" }),
    /identities must be unique/u,
  );
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
  const toolResult = harness.state.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(toolResult?.role, "toolResult");
  assert.equal(toolResult?.content[0]?.type, "text");
  assert.equal(
    toolResult?.content[0]?.type === "text"
      ? toolResult.content[0].text
      : undefined,
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
  const result = finalized.harness.state.messages.find(
    (message) => message.role === "toolResult",
  );
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
