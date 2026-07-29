import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import {
  SubagentRuntimeRegistry,
  type SubagentRuntimeAuthority,
  type SubagentRuntimeChild,
} from "./child-agent-runtime.js";
import {
  assertSubagentHistoryEnabled,
  registerSubagentTool,
  SUBAGENT_HISTORY_DISABLED_ERROR,
  subagentsEnabled,
} from "./feature-flag.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deferred<T = void>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function providerMessage(
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  content = "",
): AssistantMessage {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: stopReason === "aborted" ? "Request was aborted" : undefined,
    timestamp: Date.now(),
  };
}

function runtimeFrom(
  model: Model<Api>,
  streamSimple: ResolvedModelRuntime["streams"]["streamSimple"],
  options: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    deployment?: "hosted" | "local";
  } = {},
): ResolvedModelRuntime {
  return {
    provider: {
      id: model.provider,
      kind: "openai",
      label: "Compatibility provider",
      baseUrl: model.baseUrl,
      models: [model.id],
      needsKey: Boolean(options.apiKey),
      deployment: options.deployment ?? "hosted",
    },
    model,
    apiKey: options.apiKey,
    headers: options.headers,
    streams: { streamSimple },
  };
}

function child(
  registry: SubagentRuntimeRegistry,
  runtime: ResolvedModelRuntime,
  tools: AgentTool[] = [],
  authority: SubagentRuntimeAuthority = {
    generationId: "compatibility-generation",
    chatId: "compatibility-chat",
    workspaceId: "compatibility-workspace",
  },
): SubagentRuntimeChild {
  return registry.create({
    authority,
    groupId: "compatibility",
    runtime,
    systemPrompt: "Complete one bounded child task.",
    tools,
  });
}

test("disabled registration never constructs or registers the subagent tool", () => {
  assert.equal(subagentsEnabled({}), false);
  const tools: AgentTool[] = [];
  let constructions = 0;
  const createTool = () => {
    constructions += 1;
    return {
      name: "subagent",
      label: "Subagent",
      description: "Delegate bounded work.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: null }),
    };
  };
  registerSubagentTool(tools, createTool, {});
  assert.equal(constructions, 0);
  assert.equal(tools.length, 0);
  assert.throws(
    () => registerSubagentTool(tools, undefined, { AIDEN_SUBAGENTS_ENABLED: "1" }),
    /construction is unavailable/,
  );
  registerSubagentTool(tools, createTool, { AIDEN_SUBAGENTS_ENABLED: "1" });
  assert.equal(constructions, 1);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["subagent"],
  );
});

test("disabled history requests fail with a stable error before any read can begin", () => {
  assert.throws(
    () => assertSubagentHistoryEnabled({}),
    (error: unknown) => error instanceof Error && error.message === SUBAGENT_HISTORY_DISABLED_ERROR,
  );
  assert.doesNotThrow(() => assertSubagentHistoryEnabled({ AIDEN_SUBAGENTS_ENABLED: "1" }));
});

test("production tool assembly reaches the feature-gated lazy factory", async () => {
  const source = await readFile(new URL("../tools.ts", import.meta.url), "utf-8");
  const builderStart = source.indexOf("export async function buildAgentTools");
  const registrationStart = source.indexOf(
    "registerSubagentTool(tools, ctx.createSubagentTool);",
    builderStart,
  );
  const builderEnd = source.indexOf("\n}", registrationStart);

  assert.ok(builderStart >= 0);
  assert.ok(registrationStart > builderStart);
  assert.ok(builderEnd > registrationStart);
});

test("production generation carries parent read-tool exclusions into child capability assembly", async () => {
  const [generationSource, childSource, chatHandlerSource] = await Promise.all([
    readFile(new URL("../llm-client.ts", import.meta.url), "utf-8"),
    readFile(new URL("./subagent-child-runtime.ts", import.meta.url), "utf-8"),
    readFile(new URL("../../handlers/chat.ts", import.meta.url), "utf-8"),
  ]);
  assert.match(
    generationSource,
    /inheritedCeiling: inheritedSubagentReadToolCeiling\(options\.excludeToolNames\)/,
  );
  assert.match(
    childSource,
    /capabilityProfile:\s*\{\s*kind: "subagent",\s*role,\s*inheritedCeiling,/,
  );
  assert.match(chatHandlerSource, /allowSubagents: true,\s*usageSource: "chat",/);
});

test("Aiden child factory shares its resolved transport while generating isolated sessions", async () => {
  await within("shared transport compatibility", async () => {
    const allStarted = deferred();
    const release = deferred();
    const sessions = new Set<string>();
    let active = 0;
    let peak = 0;
    const core = createFauxCore({
      provider: "aiden-compat-hosted",
      models: [{ id: "compat-hosted" }],
    });
    core.setResponses(
      Array.from({ length: 3 }, () => async (_context, options) => {
        assert.equal(options?.apiKey, "resolved-secret");
        assert.deepEqual(options?.headers, {
          "X-Caller": "caller",
          Authorization: null,
          "X-Resolved": "yes",
        });
        assert.ok(options?.sessionId);
        sessions.add(options.sessionId);
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) allStarted.resolve();
        await release.promise;
        active -= 1;
        return fauxAssistantMessage("complete");
      }),
    );
    const runtime = runtimeFrom(core.getModel() as Model<Api>, core.streamSimple, {
      apiKey: "resolved-secret",
      headers: { Authorization: null, "X-Resolved": "yes" },
    });
    const originalStream = runtime.streams.streamSimple;
    runtime.streams.streamSimple = (model, context, options) =>
      originalStream(model, context, {
        ...options,
        headers: { "X-Caller": "caller", ...options?.headers },
      });
    const registry = new SubagentRuntimeRegistry();
    const children = Array.from({ length: 3 }, () => child(registry, runtime));
    assert.equal(new Set(children.map((entry) => entry.childId)).size, 3);
    assert.equal(new Set(children.map((entry) => entry.sessionId)).size, 3);
    const prompts = children.map((entry) => entry.prompt("Inspect one independent concern."));
    await allStarted.promise;
    assert.equal(core.state.callCount, 2);
    release.resolve();
    await Promise.all(prompts);

    assert.equal(peak, 2);
    assert.equal(sessions.size, 3);
    assert.equal(registry.activeCount, 0);
  });
});

test("provider response marks a child only after Pi crosses the actual request boundary", async () => {
  await within("provider abort compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-provider-abort",
      name: "Compatibility provider abort",
      api: "openai-completions",
      provider: "aiden-compat-provider-abort",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const deltaReached = deferred();
    let abortListeners = 0;
    const streamSimple = (
      requestModel: Model<Api>,
      _context: unknown,
      options?: SimpleStreamOptions,
    ) => {
      const stream = createAssistantMessageEventStream();
      void options?.onResponse?.({ status: 200, headers: {} }, requestModel);
      const partial = providerMessage(requestModel, "stop", "partial");
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...partial, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
        deltaReached.resolve();
      });
      const onAbort = () => {
        options?.signal?.removeEventListener("abort", onAbort);
        abortListeners -= 1;
        const aborted = providerMessage(requestModel, "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      abortListeners += 1;
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      return stream;
    };
    const registry = new SubagentRuntimeRegistry();
    const runningChild = child(registry, runtimeFrom(model, streamSimple));
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), false);
    const prompt = runningChild.prompt("Wait until cancelled.");
    await deltaReached.promise;
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), true);
    runningChild.cancel();
    await prompt;

    const terminal =
      runningChild.agent.state.messages[runningChild.agent.state.messages.length - 1];
    assert.equal(terminal?.role === "assistant" ? terminal.stopReason : undefined, "aborted");
    assert.equal(abortListeners, 0);
    assert.equal(runningChild.agent.signal, undefined);
    assert.equal(registry.activeCount, 0);
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), false);
  });
});

test("tool abort settles a genuinely running signal-aware tool", async () => {
  await within("tool abort compatibility", async () => {
    const toolStarted = deferred();
    let abortListeners = 0;
    const blockingTool: AgentTool = {
      name: "blocking_read",
      label: "Blocking read",
      description: "Compatibility-only blocking read.",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        toolStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            abortListeners -= 1;
            reject(signal?.reason ?? new Error("Tool cancelled."));
          };
          abortListeners += 1;
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return { content: [{ type: "text", text: "unexpected" }], details: null };
      },
    };
    const core = createFauxCore({
      provider: "aiden-compat-tool-abort",
      models: [{ id: "compat-tool-abort" }],
    });
    core.setResponses([
      fauxAssistantMessage(fauxToolCall("blocking_read", {}), { stopReason: "toolUse" }),
    ]);
    const runtime = runtimeFrom(core.getModel() as Model<Api>, core.streamSimple);
    const registry = new SubagentRuntimeRegistry();
    const runningChild = child(registry, runtime, [blockingTool]);
    const prompt = runningChild.prompt("Use the blocking read.");
    await toolStarted.promise;
    runningChild.cancel();
    await prompt;

    assert.equal(abortListeners, 0);
    assert.equal(runningChild.agent.state.pendingToolCalls.size, 0);
    assert.equal(runningChild.agent.signal, undefined);
    assert.equal(registry.activeCount, 0);
  });
});

test("runtime registry enforces local concurrency at one", async () => {
  await within("local concurrency compatibility", async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let active = 0;
    let peak = 0;
    const core = createFauxCore({
      provider: "aiden-compat-local",
      models: [{ id: "compat-local" }],
    });
    core.setResponses([
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        firstStarted.resolve();
        await releaseFirst.promise;
        active -= 1;
        return fauxAssistantMessage("first");
      },
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        secondStarted.resolve();
        await releaseSecond.promise;
        active -= 1;
        return fauxAssistantMessage("second");
      },
    ]);
    const runtime = runtimeFrom(core.getModel() as Model<Api>, core.streamSimple, {
      deployment: "local",
    });
    const recordedConcurrency: number[] = [];
    const registry = new SubagentRuntimeRegistry({
      started: (activeConcurrency) => recordedConcurrency.push(activeConcurrency),
      terminal: () => {},
      cleanupFailed: () => {},
    });
    const children = [child(registry, runtime), child(registry, runtime)];
    const prompts = children.map((entry) => entry.prompt("Run locally."));
    await firstStarted.promise;
    assert.equal(core.state.callCount, 1);
    releaseFirst.resolve();
    await secondStarted.promise;
    releaseSecond.resolve();
    await Promise.all(prompts);

    assert.equal(peak, 1);
    assert.deepEqual(recordedConcurrency, [1, 1]);
    assert.equal(registry.activeCount, 0);
  });
});

test("cancelling a queued child cannot start provider work later", async () => {
  await within("queued child cancellation", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const core = createFauxCore({
      provider: "aiden-compat-queued-cancel",
      models: [{ id: "compat-queued-cancel" }],
    });
    core.setResponses([
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("cancelled child must not reach this response"),
    ]);
    const runtime = runtimeFrom(core.getModel() as Model<Api>, core.streamSimple, {
      deployment: "local",
    });
    const recordedConcurrency: number[] = [];
    const registry = new SubagentRuntimeRegistry({
      started: (activeConcurrency) => recordedConcurrency.push(activeConcurrency),
      terminal: () => {},
      cleanupFailed: () => {},
    });
    const first = child(registry, runtime);
    const queued = child(registry, runtime);
    const firstPrompt = first.prompt("Hold the local slot.");
    const queuedPrompt = queued.prompt("Do not start after cancellation.");
    await firstStarted.promise;
    queued.cancel();
    const cancelled = assert.rejects(queuedPrompt, /Subagent task cancelled/);
    releaseFirst.resolve();
    await Promise.all([firstPrompt, cancelled]);

    assert.equal(core.state.callCount, 1);
    assert.deepEqual(recordedConcurrency, [1]);
    assert.equal(registry.activeCount, 0);
  });
});

test("cancelling a child before prompt prevents all provider work", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-pre-cancel",
    models: [{ id: "compat-pre-cancel" }],
  });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const registry = new SubagentRuntimeRegistry();
  const cancelled = child(registry, runtimeFrom(core.getModel() as Model<Api>, core.streamSimple));
  cancelled.cancel();

  await assert.rejects(cancelled.prompt("Never start."), /Subagent task cancelled/);
  assert.equal(core.state.callCount, 0);
  assert.equal(registry.activeCount, 0);
});

test("registry shutdown aborts every child and leaves no active Agent state", async () => {
  await within("subagent shutdown compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-shutdown",
      name: "Compatibility shutdown",
      api: "openai-completions",
      provider: "aiden-compat-shutdown",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const started = deferred();
    let live = 0;
    const streamSimple: ResolvedModelRuntime["streams"]["streamSimple"] = (
      requestModel,
      _context,
      options,
    ) => {
      const stream = createAssistantMessageEventStream();
      live += 1;
      if (live === 2) started.resolve();
      const onAbort = () => {
        options?.signal?.removeEventListener("abort", onAbort);
        live -= 1;
        const aborted = providerMessage(requestModel, "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      return stream;
    };
    const registry = new SubagentRuntimeRegistry();
    const children = [
      child(registry, runtimeFrom(model, streamSimple)),
      child(registry, runtimeFrom(model, streamSimple)),
    ];
    const prompts = children.map((entry) => entry.prompt("Wait for shutdown."));
    await started.promise;
    assert.equal(await registry.shutdown(500), true);
    await Promise.all(prompts);

    assert.equal(live, 0);
    assert.equal(registry.activeCount, 0);
    for (const entry of children) {
      assert.equal(entry.agent.state.isStreaming, false);
      assert.equal(entry.agent.state.pendingToolCalls.size, 0);
      assert.equal(entry.agent.signal, undefined);
      assert.deepEqual(entry.agent.state.messages, []);
    }
  });
});

test("shutdown rejects a child that was created but had not started", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-late-start",
    models: [{ id: "compat-late-start" }],
  });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const registry = new SubagentRuntimeRegistry();
  const pendingChild = child(
    registry,
    runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
  );

  assert.equal(await registry.shutdown(100), true);
  await assert.rejects(
    pendingChild.prompt("Start after shutdown."),
    /Subagent runtime is shutting down/,
  );
  assert.equal(core.state.callCount, 0);
  assert.equal(registry.activeCount, 0);
});

test("shutdown timeout preserves ownership until non-cooperative work actually settles", async () => {
  await within("non-cooperative shutdown compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-non-cooperative",
      name: "Compatibility non-cooperative",
      api: "openai-completions",
      provider: "aiden-compat-non-cooperative",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const started = deferred();
    const release = deferred();
    const streamSimple: ResolvedModelRuntime["streams"]["streamSimple"] = (requestModel) => {
      const stream = createAssistantMessageEventStream();
      started.resolve();
      void release.promise.then(() => {
        const completed = providerMessage(requestModel, "stop", "late completion");
        stream.push({ type: "done", reason: "stop", message: completed });
        stream.end(completed);
      });
      return stream;
    };
    let cleanupFailures = 0;
    const registry = new SubagentRuntimeRegistry({
      started: () => {},
      terminal: () => {},
      cleanupFailed: () => {
        cleanupFailures += 1;
      },
    });
    const runningChild = child(registry, runtimeFrom(model, streamSimple));
    const prompt = runningChild.prompt("Ignore abort temporarily.");
    await started.promise;

    assert.equal(registry.hasGenerationChildren("compatibility-generation"), true);
    assert.equal(registry.hasChatChildren("compatibility-chat"), true);
    assert.equal(registry.hasWorkspaceChildren("compatibility-workspace"), true);
    registry.abortWorkspace("another-workspace");
    assert.equal(runningChild.agent.state.isStreaming, true);
    registry.abortWorkspace("compatibility-workspace");
    registry.abortChat("compatibility-chat");
    assert.equal(registry.activeCount, 1);
    assert.equal(registry.hasWorkspaceChildren("compatibility-workspace"), true);

    assert.equal(await registry.shutdown(10), false);
    assert.equal(cleanupFailures, 1);
    assert.equal(registry.activeCount, 1);
    assert.equal(runningChild.agent.state.isStreaming, true);
    release.resolve();
    await prompt;
    assert.equal(registry.activeCount, 0);
    assert.equal(runningChild.agent.state.isStreaming, false);
  });
});

test("main-process shutdown continues to application quit after the subagent deadline", async () => {
  const source = await readFile(new URL("../../index.ts", import.meta.url), "utf-8");
  const parentAbortStart = source.indexOf(
    "llmClient.abortAll();",
    source.indexOf("async function shutdownAndQuit"),
  );
  const settlementStart = source.indexOf(
    "const subagentsSettled = await subagentRuntimeRegistry.shutdown();",
  );
  const parentSettlementStart = source.indexOf("await llmClient.shutdown();", parentAbortStart);
  const cleanupStart = source.indexOf("cleanupApplication();", settlementStart);
  const receiptFinalizationStart = source.indexOf(
    "await tryFinalizeSubagentPackagedSoakQuitReceipt(",
    settlementStart,
  );
  const forceQuitStart = source.indexOf("forceAppQuit = true;", cleanupStart);
  const appQuitStart = source.indexOf("app.quit();", forceQuitStart);
  const failureExitStart = source.indexOf("app.exit(1);", receiptFinalizationStart);

  assert.ok(parentAbortStart >= 0);
  assert.ok(parentSettlementStart > parentAbortStart);
  assert.ok(settlementStart > parentAbortStart);
  assert.ok(settlementStart > parentSettlementStart);
  assert.ok(settlementStart >= 0);
  assert.ok(receiptFinalizationStart > settlementStart);
  assert.ok(failureExitStart > receiptFinalizationStart);
  assert.ok(failureExitStart < cleanupStart);
  assert.ok(cleanupStart > receiptFinalizationStart);
  assert.ok(cleanupStart > settlementStart);
  assert.ok(forceQuitStart > cleanupStart);
  assert.ok(appQuitStart > forceQuitStart);
  assert.match(
    source.slice(receiptFinalizationStart, cleanupStart),
    /requiresSubagentPackagedSoakFailureExit\(session, quitReceiptFinalization\)[\s\S]*app\.exit\(1\);[\s\S]*return;/u,
  );
  assert.match(
    source.slice(settlementStart, cleanupStart),
    /Subagent work did not settle before the shutdown deadline; forcing application shutdown/,
  );
});

test("all shutdown paths abort parent generations before the child registry", async () => {
  const source = await readFile(new URL("../../index.ts", import.meta.url), "utf-8");
  const cleanupStart = source.indexOf("function cleanupApplication");
  const cleanupEnd = source.indexOf("\n}", cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);

  assert.ok(cleanup.indexOf("llmClient.abortAll()") >= 0);
  assert.ok(
    cleanup.indexOf("subagentRuntimeRegistry.abortAll()") > cleanup.indexOf("llmClient.abortAll()"),
  );
});
