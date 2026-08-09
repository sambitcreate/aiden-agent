import assert from "node:assert/strict";
import test from "node:test";
import { startGeneration, subagentsApi, type StreamCallbacks } from "./ipc.js";
import {
  isDetachedLifecycleChatDraining,
  subscribeDetachedTerminalChats,
} from "./chat-terminal-sync.js";

interface FakeBridge {
  listeners: Map<string, Set<(payload: unknown) => void>>;
  invokes: Array<{ channel: string; args: unknown[] }>;
}

function installFakeBridge(options: { rejectStart?: boolean } = {}): {
  bridge: FakeBridge;
  restore: () => void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge: FakeBridge = {
    listeners: new Map(),
    invokes: [],
  };
  const fakeWindow = {
    aidenAPI: {
      ipc: {
        invoke: async (channel: string, ...args: unknown[]) => {
          bridge.invokes.push({ channel, args });
          if (channel === "chat:start" && options.rejectStart) {
            throw new Error("Generation start rejected.");
          }
          return channel === "chat:start" ? { streamId: args[0] } : undefined;
        },
        onNotification: (channel: string, handler: (payload: unknown) => void) => {
          const handlers = bridge.listeners.get(channel) ?? new Set();
          handlers.add(handler);
          bridge.listeners.set(channel, handlers);
          return () => handlers.delete(handler);
        },
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: fakeWindow,
  });
  return {
    bridge,
    restore: () => {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

function callbacks(): StreamCallbacks {
  return {
    onDelta: () => undefined,
    onDone: () => undefined,
    onError: () => undefined,
  };
}

function listenerCount(bridge: FakeBridge): number {
  return [...bridge.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
}

test("lifecycle cancellation releases every stream subscription immediately", async () => {
  const { bridge, restore } = installFakeBridge();
  try {
    const handle = startGeneration(
      {
        chatId: "chat-1",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
        messages: [],
      },
      callbacks(),
      "turn-1",
    );
    assert.equal(listenerCount(bridge), 8);
    assert.equal(bridge.listeners.has("chat:subagents"), false);

    handle.cancel("lifecycle");
    assert.equal(listenerCount(bridge), 0);
    await Promise.resolve();
    assert.ok(
      bridge.invokes.some(
        ({ channel, args }) =>
          channel === "chat:cancel" && args[0] === handle.streamId && args[1] === "lifecycle",
      ),
    );
  } finally {
    restore();
  }
});

test("subagent management sends no renderer-constructed authority tuple", async () => {
  const { bridge, restore } = installFakeBridge();
  try {
    await assert.rejects(
      subagentsApi.stop("chat-1", "run-1"),
      /invalid subagent control response/u,
    );
    const request = bridge.invokes.find(({ channel }) => channel === "subagents:manage");
    assert.deepEqual(request, {
      channel: "subagents:manage",
      args: ["chat-1", { version: 2, action: "stop", runId: "run-1" }],
    });
    assert.doesNotMatch(JSON.stringify(request), /authorityRevision|ownerDocumentId|workspaceId/u);
  } finally {
    restore();
  }
});

test("user Stop retains terminal delivery before releasing subscriptions", () => {
  const { bridge, restore } = installFakeBridge();
  try {
    const handle = startGeneration(
      {
        chatId: "chat-1",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
        messages: [],
      },
      callbacks(),
      "turn-2",
    );

    handle.cancel("user_stop");
    assert.equal(listenerCount(bridge), 8);
    assert.equal(bridge.listeners.has("chat:subagents"), false);
    for (const handler of bridge.listeners.get("chat:error") ?? []) {
      handler({ streamId: handle.streamId, message: "Stopped" });
    }
    assert.equal(listenerCount(bridge), 0);
  } finally {
    restore();
  }
});

test("live subagent notifications are subscribed only for enabled callbacks", () => {
  const { bridge, restore } = installFakeBridge();
  try {
    const disabled = startGeneration(
      {
        chatId: "chat-disabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
        messages: [],
      },
      callbacks(),
      "turn-disabled",
    );
    assert.equal(bridge.listeners.has("chat:subagents"), false);
    disabled.cancel("lifecycle");

    const enabled = startGeneration(
      {
        chatId: "chat-enabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
        messages: [],
      },
      {
        ...callbacks(),
        onSubagents: () => undefined,
      },
      "turn-enabled",
    );
    assert.equal(bridge.listeners.get("chat:subagents")?.size, 1);
    enabled.cancel("lifecycle");
    assert.equal(bridge.listeners.get("chat:subagents")?.size, 0);
  } finally {
    restore();
  }
});

test("approval details are forwarded only to their owning stream", () => {
  const { bridge, restore } = installFakeBridge();
  const received: unknown[] = [];
  try {
    const handle = startGeneration(
      {
        chatId: "chat-approval",
        workspaceId: "assistant",
        providerId: "provider-1",
        model: "model-1",
        mode: "assistant",
        messages: [],
      },
      {
        ...callbacks(),
        onApproval: (prompt) => received.push(prompt),
      },
      "turn-approval",
    );
    const payload = {
      streamId: handle.streamId,
      approvalId: "approval-1",
      toolCallId: "tool-1",
      toolName: "schedule_task",
      summary: "Create Morning brief",
      details: {
        kind: "assistant-automation",
        action: "create",
        name: "Morning brief",
        prompt: "Summarize updates.",
        cron: "0 9 * * *",
        timezone: "UTC",
        nextRunAt: 1_800_000_000_000,
        notify: true,
        mode: "llm",
        permission: "read-only",
        workspaceId: null,
        workspaceName: null,
        mcpServerIds: [],
        mcpServerNames: [],
        providerId: "local-provider",
        providerName: "Local Provider",
        model: "local-model",
        modelName: "Local Model",
        schedulerEnabled: true,
      },
    };
    for (const handler of bridge.listeners.get("chat:approval") ?? []) {
      handler({ ...payload, streamId: "another-stream" });
      handler(payload);
    }
    assert.deepEqual(received, [
      {
        approvalId: payload.approvalId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        summary: payload.summary,
        details: payload.details,
      },
    ]);
    handle.cancel("lifecycle");
  } finally {
    restore();
  }
});

test("a lifecycle-detached start rejection clears through authoritative fallback", async () => {
  const { bridge, restore } = installFakeBridge({ rejectStart: true });
  const fallbacks: string[] = [];
  const unsubscribe = subscribeDetachedTerminalChats(
    (channel, handler) => {
      const handlers = bridge.listeners.get(channel) ?? new Set();
      handlers.add(handler);
      bridge.listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    () => undefined,
    (owner) => {
      fallbacks.push(owner.streamId);
    },
  );
  let visibleErrors = 0;
  try {
    const handle = startGeneration(
      {
        chatId: "chat-rejected",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
        messages: [],
      },
      {
        ...callbacks(),
        onError: () => {
          visibleErrors += 1;
        },
      },
      "turn-rejected",
    );
    handle.cancel("lifecycle");
    assert.equal(isDetachedLifecycleChatDraining("chat-rejected", "workspace-1"), true);

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(fallbacks, [handle.streamId]);
    assert.equal(isDetachedLifecycleChatDraining("chat-rejected", "workspace-1"), false);
    assert.equal(visibleErrors, 0);
  } finally {
    unsubscribe();
    restore();
  }
});
