import assert from "node:assert/strict";
import test from "node:test";
import { subscribeGenerationStream } from "./generation-stream.js";

function installFakeBridge() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aidenAPI: {
        ipc: {
          invoke: async () => undefined,
          onNotification: (channel: string, handler: (payload: unknown) => void) => {
            const set = listeners.get(channel) ?? new Set();
            set.add(handler);
            listeners.set(channel, set);
            return () => set.delete(handler);
          },
        },
      },
    },
  });
  return {
    emit: (channel: string, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    restore: () => {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

test("a subscriber sees only its own stream and releases every listener at the terminal event", async () => {
  const bridge = installFakeBridge();
  try {
    const deltas: string[] = [];
    let done: string | undefined;
    const stream = subscribeGenerationStream("design-stream-1", { chatId: "chat-1" }, {
      onDelta: (delta) => deltas.push(delta),
      onDone: (content) => {
        done = content;
      },
      onError: (message) => assert.fail(message),
    });
    assert.ok(bridge.listenerCount() > 0, "listeners exist before any invoke");
    bridge.emit("chat:delta", { streamId: "another-stream", delta: "ignored" });
    bridge.emit("chat:delta", { streamId: "design-stream-1", delta: "Hel" });
    bridge.emit("chat:delta", { streamId: "design-stream-1", delta: "lo" });
    assert.equal(stream.projection().content, "Hello");
    bridge.emit("chat:done", { streamId: "design-stream-1", content: "Hello" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(done, "Hello");
    assert.equal(bridge.listenerCount(), 0);
  } finally {
    bridge.restore();
  }
});

function subagentSnapshot(generationId: string) {
  return {
    version: 1,
    runId: "run-1",
    groupId: "group-1",
    generationId,
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review the authority boundary.",
    state: "completed",
    finishedAt: 2_000,
    terminalMarkdown: "Complete.",
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 2,
    tools: 3,
    tokens: 100,
    warnings: [],
  };
}

test("a subagent snapshot reaches the projection only for its own generation", () => {
  const bridge = installFakeBridge();
  try {
    const received: unknown[] = [];
    const stream = subscribeGenerationStream("generation-1", { chatId: "chat-1", workspaceId: "workspace-1" }, {
      onDelta: () => assert.fail("no text expected"),
      onDone: () => assert.fail("no terminal expected"),
      onError: (message) => assert.fail(message),
      onSubagents: (snapshot) => received.push(snapshot),
    });
    const own = subagentSnapshot("generation-1");
    bridge.emit("chat:subagents", { streamId: "generation-1", snapshot: own });
    bridge.emit("chat:subagents", { streamId: "generation-1", snapshot: subagentSnapshot("generation-2") });
    bridge.emit("chat:subagents", { streamId: "generation-2", snapshot: own });
    assert.deepEqual(received, [own]);
    assert.deepEqual(
      stream.projection().subagents.map((snapshot) => snapshot.runId),
      ["run-1"],
    );
    stream.dispose();
  } finally {
    bridge.restore();
  }
});

test("dispose stops delivery before any terminal event", () => {
  const bridge = installFakeBridge();
  try {
    const deltas: string[] = [];
    const stream = subscribeGenerationStream("design-stream-2", { chatId: "chat-2" }, {
      onDelta: (delta) => deltas.push(delta),
      onDone: () => assert.fail("no terminal expected"),
      onError: (message) => assert.fail(message),
    });
    stream.dispose();
    bridge.emit("chat:delta", { streamId: "design-stream-2", delta: "late" });
    assert.deepEqual(deltas, []);
    assert.equal(bridge.listenerCount(), 0);
  } finally {
    bridge.restore();
  }
});

test("native visuals ride the stream projection so a detached view keeps them", () => {
  const bridge = installFakeBridge();
  try {
    const stream = subscribeGenerationStream("generation-ui", { chatId: "chat-1" }, {
      onDelta: () => undefined,
      onDone: () => undefined,
      onError: (message) => assert.fail(message),
      onArtifactEvent: () => undefined,
    });
    const visual = {
      version: 1,
      kind: "ui",
      id: "ui-1",
      toolCallId: "call-1",
      title: "Board",
      catalogVersion: 1,
      tree: { t: "Visual", k: "0" },
      fallbackText: "Board",
    };
    bridge.emit("chat:artifact", { streamId: "generation-ui", event: { version: 1, operation: "ui", visual } });
    bridge.emit("chat:artifact", { streamId: "generation-ui", event: { version: 1, operation: "ui", visual: { ...visual, fallbackText: "Revised" } } });
    assert.deepEqual(stream.projection().uiVisuals?.map((entry) => entry.fallbackText), ["Revised"]);
    bridge.emit("chat:artifact", { streamId: "generation-ui", event: { version: 1, operation: "reset" } });
    assert.deepEqual(stream.projection().uiVisuals, []);
    stream.dispose();
  } finally {
    bridge.restore();
  }
});
