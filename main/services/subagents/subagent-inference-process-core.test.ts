import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  type KillableInferenceProcess,
  SubagentInferenceProcessOwner,
} from "./subagent-inference-process-core.js";
import {
  isSubagentInferenceWorkerMessage,
  isSubagentInferenceParentMessage,
  compactAssistantMessageEvent,
  expandAssistantMessageEvent,
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
  SubagentInferenceOutboundBudget,
  type SubagentInferenceStartMessage,
} from "./subagent-inference-protocol.js";
import { ambientProviderEnv } from "./subagent-inference-process.js";

const model: Model<"openai-completions"> = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const request: SubagentInferenceStartMessage = {
  kind: "start",
  version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
  requestId: "request-1",
  model,
  context: { messages: [] },
  options: {},
};

class FakeProcess extends EventEmitter implements KillableInferenceProcess {
  alive = true;
  sent: unknown[] = [];
  terminations = 0;
  hardKills = 0;

  isLaunchVerified(): boolean {
    return true;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  terminate(): boolean {
    this.terminations += 1;
    return true;
  }
  killHard(): void {
    this.hardKills += 1;
    this.alive = false;
    this.emit("exit", 137);
  }
  hasExited(): boolean {
    return !this.alive;
  }
  onMessage(listener: (message: unknown) => void): () => void {
    this.on("message", listener);
    return () => this.off("message", listener);
  }
  onExit(listener: (code: number | null) => void): () => void {
    this.on("exit", listener);
    return () => this.off("exit", listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.on("process-error", listener);
    return () => this.off("process-error", listener);
  }
}

class StubbornProcess extends FakeProcess {
  override killHard(): void {
    this.hardKills += 1;
  }

  override hasExited(): boolean {
    return false;
  }
}

class AckThrowProcess extends FakeProcess {
  override postMessage(message: unknown): void {
    if ((message as { kind?: unknown }).kind === "terminal-ack") {
      throw new Error("IPC channel closed");
    }
    super.postMessage(message);
  }
}

class IndeterminateProcess extends StubbornProcess {
  override hasExited(): boolean {
    throw new Error("process identity unavailable");
  }
}

class UnverifiedLaunchProcess extends FakeProcess {
  override isLaunchVerified(): boolean {
    return false;
  }
}

test("worker protocol rejects unknown fields and malformed sequences", () => {
  assert.equal(isSubagentInferenceParentMessage(request), true);
  assert.equal(isSubagentInferenceParentMessage({ ...request, extra: true }), false);
  const valid = {
    kind: "failure",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: "r",
    message: "failed",
  };
  assert.equal(isSubagentInferenceWorkerMessage(valid), true);
  assert.equal(isSubagentInferenceWorkerMessage({ ...valid, secret: "leak" }), false);
  assert.equal(
    isSubagentInferenceWorkerMessage({ ...valid, kind: "event", sequence: -1, event: {} }),
    false,
  );
});

test("worker subprocess lockdown updates later ESM named imports", () => {
  const script = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const blocked = () => "blocked";
    Object.defineProperty(childProcess, "spawn", {
      value: blocked, configurable: false, enumerable: true, writable: false,
    });
    syncBuiltinESMExports();
    const named = await import("node:child_process");
    if (named.spawn !== blocked || named.spawn() !== "blocked") process.exit(2);
  `;
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 2_000,
      stdio: "ignore",
    }),
  );
});

test("text deltas cross IPC without repeated partial snapshots", () => {
  const partial = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  const compact = compactAssistantMessageEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: " world",
    partial,
  });
  assert.equal("partial" in compact, false);
  const expanded = expandAssistantMessageEvent(compact, partial);
  assert.equal(expanded.event.type, "text_delta");
  assert.equal(expanded.partial?.content[0]?.type, "text");
  assert.equal((expanded.partial?.content[0] as { text: string }).text, "hello world");
});

test("tool-call deltas omit growing partial snapshots and reconstruct at the terminal block", () => {
  const partial = {
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id: "call", name: "write_file", arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
  const compactDelta = compactAssistantMessageEvent({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: '{"path":"large.txt"}',
    partial,
  });
  assert.equal("partial" in compactDelta, false);
  const finalToolCall = {
    type: "toolCall" as const,
    id: "call",
    name: "write_file",
    arguments: { path: "large.txt" },
  };
  const compactEnd = compactAssistantMessageEvent({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: finalToolCall,
    partial,
  });
  assert.equal("partial" in compactEnd, false);
  const expanded = expandAssistantMessageEvent(compactEnd, partial);
  assert.deepEqual(expanded.partial?.content[0], finalToolCall);
});

test("worker-side IPC accounting rejects a frame or aggregate before postMessage", () => {
  const frameBudget = new SubagentInferenceOutboundBudget(32);
  assert.throws(() => frameBudget.consume({ payload: "x".repeat(64) }), /IPC budget/u);
  const aggregateBudget = new SubagentInferenceOutboundBudget(64);
  aggregateBudget.consume({ payload: "first" });
  assert.throws(() => aggregateBudget.consume({ payload: "x".repeat(64) }), /IPC budget/u);
});

test("isolated built-in provider environments preserve only reviewed parity variables", () => {
  const source = {
    AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
    AZURE_OPENAI_RESOURCE_NAME: "resource",
    AZURE_OPENAI_API_VERSION: "2025-01-01",
    AWS_BEARER_TOKEN_BEDROCK: "bearer",
    AWS_BEDROCK_FORCE_HTTP1: "1",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
    AWS_CONTAINER_AUTHORIZATION_TOKEN: "ecs-token",
    AWS_PROFILE: "must-not-enable-process-credentials",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_GATEWAY_ID: "gateway",
    PI_CACHE_RETENTION: "long",
    HTTPS_PROXY: "https://proxy.example",
    PRIVATE_UNRELATED_SECRET: "must-not-cross",
  };
  assert.deepEqual(ambientProviderEnv("azure-openai-responses", source), {
    AZURE_OPENAI_BASE_URL: source.AZURE_OPENAI_BASE_URL,
    AZURE_OPENAI_RESOURCE_NAME: source.AZURE_OPENAI_RESOURCE_NAME,
    AZURE_OPENAI_API_VERSION: source.AZURE_OPENAI_API_VERSION,
    PI_CACHE_RETENTION: source.PI_CACHE_RETENTION,
  });
  assert.deepEqual(ambientProviderEnv("amazon-bedrock", source), {
    AWS_BEARER_TOKEN_BEDROCK: source.AWS_BEARER_TOKEN_BEDROCK,
    AWS_BEDROCK_FORCE_HTTP1: source.AWS_BEDROCK_FORCE_HTTP1,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: source.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    AWS_CONTAINER_AUTHORIZATION_TOKEN: source.AWS_CONTAINER_AUTHORIZATION_TOKEN,
    AWS_PROFILE: source.AWS_PROFILE,
    PI_CACHE_RETENTION: source.PI_CACHE_RETENTION,
    HTTPS_PROXY: source.HTTPS_PROXY,
  });
  assert.deepEqual(ambientProviderEnv("anthropic", source), {
    PI_CACHE_RETENTION: source.PI_CACHE_RETENTION,
  });
  assert.deepEqual(ambientProviderEnv("cloudflare-ai-gateway", source), {
    CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_GATEWAY_ID: source.CLOUDFLARE_GATEWAY_ID,
    PI_CACHE_RETENTION: source.PI_CACHE_RETENTION,
  });
});

test("abort escalates from cooperative cancel to TERM and verified hard kill", async () => {
  const child = new FakeProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const cancellation = new AbortController();
  const stream = owner.stream(request, { model }, cancellation.signal);
  const events = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event);
    return seen;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort(new Error("cancel"));
  const seen = await events;
  assert.equal(child.terminations, 1);
  assert.equal(child.hardKills, 1);
  assert.equal(
    child.sent.some((message) => (message as { kind?: string }).kind === "cancel"),
    true,
  );
  assert.equal(seen[seen.length - 1]?.type, "error");
  assert.equal(await owner.shutdown(), true);
});

test("an unverified launch never receives provider request data", async () => {
  const child = new UnverifiedLaunchProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const events = [];
  for await (const event of owner.stream(request, { model })) events.push(event);
  assert.equal(
    child.sent.some((message) => (message as { kind?: string }).kind === "start"),
    false,
  );
  assert.equal(events[events.length - 1]?.type, "error");
  assert.equal(await owner.shutdown(), true);
});

test("a provider terminal frame racing cancellation cannot become success", async () => {
  const child = new FakeProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const cancellation = new AbortController();
  const stream = owner.stream(request, { model }, cancellation.signal);
  const eventsPromise = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event);
    return seen;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort(new Error("stop"));
  child.emit("message", {
    kind: "event",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: request.requestId,
    sequence: 0,
    event: {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  });
  const events = await eventsPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") assert.equal(events[0].reason, "aborted");
});

test("unverified hard-kill cleanup stays owned and makes shutdown fail closed", async () => {
  const child = new StubbornProcess();
  let cleanupFailures = 0;
  const owner = new SubagentInferenceProcessOwner(
    async () => child,
    { termGraceMs: 2, killGraceMs: 2 },
    () => {
      cleanupFailures += 1;
    },
  );
  const cancellation = new AbortController();
  owner.stream(request, { model }, cancellation.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort();
  assert.equal(await owner.shutdown(), false);
  assert.equal(child.terminations, 1);
  assert.equal(child.hardKills, 1);
  assert.equal(cleanupFailures, 1);
});

test("indeterminate exit verification fails closed", async () => {
  const child = new IndeterminateProcess();
  let cleanupFailures = 0;
  const owner = new SubagentInferenceProcessOwner(
    async () => child,
    { termGraceMs: 2, killGraceMs: 2 },
    () => {
      cleanupFailures += 1;
    },
  );
  const cancellation = new AbortController();
  owner.stream(request, { model }, cancellation.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort();
  assert.equal(await owner.shutdown(), false);
  assert.equal(cleanupFailures, 1);
});

test("terminal acknowledgement failures become a bounded provider error", async () => {
  const child = new AckThrowProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const stream = owner.stream(request, { model });
  const eventsPromise = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event);
    return seen;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("message", {
    kind: "event",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: request.requestId,
    sequence: 0,
    event: {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  });
  const events = await eventsPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
});

test("terminal provider event is delivered only through an exited owned process", async () => {
  const child = new FakeProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const stream = owner.stream(request, { model });
  const eventsPromise = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event);
    return seen;
  })();
  let streamSettled = false;
  void eventsPromise.then(() => {
    streamSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("message", {
    kind: "event",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: request.requestId,
    sequence: 0,
    event: {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  });
  child.emit("message", {
    kind: "event",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: request.requestId,
    sequence: 1,
    event: { type: "text_delta", contentIndex: 0, delta: "late" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamSettled, false);
  assert.equal(
    child.sent.some((message) => (message as { kind?: string }).kind === "terminal-ack"),
    true,
  );
  child.alive = false;
  child.emit("exit", 0);
  const events = await eventsPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "done");
  assert.equal(child.terminations, 0);
  assert.equal(child.hardKills, 0);
});

test("a worker that lingers after terminal ACK is still terminated and verified", async () => {
  const child = new FakeProcess();
  const owner = new SubagentInferenceProcessOwner(async () => child, {
    termGraceMs: 2,
    killGraceMs: 2,
  });
  const stream = owner.stream(request, { model });
  const eventsPromise = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event);
    return seen;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("message", {
    kind: "event",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId: request.requestId,
    sequence: 0,
    event: {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  });

  const events = await eventsPromise;
  assert.equal(events[events.length - 1]?.type, "done");
  assert.equal(child.terminations, 1);
  assert.equal(child.hardKills, 1);
  assert.equal(await owner.shutdown(), true);
});
