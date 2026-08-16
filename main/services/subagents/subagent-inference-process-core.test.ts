import assert from "node:assert/strict";
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
  type SubagentInferenceStartMessage,
} from "./subagent-inference-protocol.js";

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
  pid: number | undefined = 42_001;
  sent: unknown[] = [];
  terminations = 0;
  hardKills = 0;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  terminate(): boolean {
    this.terminations += 1;
    return true;
  }
  killHard(pid: number): void {
    assert.equal(pid, 42_001);
    this.hardKills += 1;
    this.pid = undefined;
    this.emit("exit", 137);
  }
  isAlive(pid: number): boolean {
    assert.equal(pid, 42_001);
    return this.pid === pid;
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
  override killHard(pid: number): void {
    assert.equal(pid, 42_001);
    this.hardKills += 1;
  }

  override isAlive(pid: number): boolean {
    assert.equal(pid, 42_001);
    return true;
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamSettled, false);
  assert.equal(
    child.sent.some((message) => (message as { kind?: string }).kind === "terminal-ack"),
    true,
  );
  child.pid = undefined;
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
