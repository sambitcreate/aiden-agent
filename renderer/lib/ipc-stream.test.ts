import assert from "node:assert/strict";
import test from "node:test";
import { startGeneration, subagentsApi, type StreamCallbacks } from "./ipc.js";
import {
  detachedLifecycleChatProjection,
  isDetachedLifecycleChatDraining,
  subscribeDetachedTerminalChats,
} from "./chat-terminal-sync.js";

interface FakeBridge {
  listeners: Map<string, Set<(payload: unknown) => void>>;
  invokes: Array<{ channel: string; args: unknown[] }>;
}

function installFakeBridge(
  options: {
    rejectStart?: boolean;
    startResponse?: { accepted: boolean; started: boolean; error?: string };
  } = {},
): {
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
          return channel === "chat:start"
            ? {
                streamId: args[0],
                accepted: true,
                started: true,
                ...options.startResponse,
              }
            : undefined;
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

test("lifecycle detachment releases subscriptions and notifies main exactly once", async () => {
  const { bridge, restore } = installFakeBridge();
  try {
    const handle = startGeneration(
      {
        chatId: "chat-1",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      callbacks(),
      "turn-1",
    );
    assert.equal(listenerCount(bridge), 9);
    assert.equal(bridge.listeners.has("chat:subagents"), false);
    for (const listener of bridge.listeners.get("chat:delta") ?? []) {
      listener({ streamId: handle.streamId, delta: "Visible before navigation" });
    }

    handle.cancel("lifecycle");
    handle.cancel("lifecycle");
    assert.equal(listenerCount(bridge), 0);
    assert.equal(
      detachedLifecycleChatProjection("chat-1", "workspace-1")?.content,
      "Visible before navigation",
    );
    assert.equal(
      typeof detachedLifecycleChatProjection("chat-1", "workspace-1")?.lastTextDeltaAt,
      "number",
    );
    await Promise.resolve();
    assert.equal(
      bridge.invokes.filter(
        ({ channel, args }) =>
          channel === "chat:cancel" && args[0] === handle.streamId && args[1] === "lifecycle",
      ).length,
      1,
    );
  } finally {
    restore();
  }
});

test("generation exposes a non-rejecting authoritative start result", async () => {
  const accepted = installFakeBridge();
  try {
    const handle = startGeneration(
      {
        chatId: "chat-accepted",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      callbacks(),
      "turn-accepted",
    );
    assert.deepEqual(await handle.started, { ok: true });
    handle.cancel("lifecycle");
  } finally {
    accepted.restore();
  }

  const rejected = installFakeBridge({ rejectStart: true });
  try {
    const handle = startGeneration(
      {
        chatId: "chat-rejected-result",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      callbacks(),
      "turn-rejected-result",
    );
    const result = await handle.started;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /start rejected/iu);
  } finally {
    rejected.restore();
  }
});

test("a post-handoff setup failure reports the error but keeps the committed send accepted", async () => {
  const failure = installFakeBridge({
    startResponse: {
      accepted: true,
      started: false,
      error: "Provider setup failed.",
    },
  });
  const errors: string[] = [];
  try {
    const handle = startGeneration(
      {
        chatId: "chat-accepted-failure",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      { ...callbacks(), onError: (message) => errors.push(message) },
      "turn-accepted-failure",
    );
    assert.deepEqual(await handle.started, { ok: true });
    assert.deepEqual(errors, ["Provider setup failed."]);
    assert.equal(listenerCount(failure.bridge), 0);
  } finally {
    failure.restore();
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
      },
      callbacks(),
      "turn-2",
    );

    handle.cancel("user_stop");
    assert.equal(listenerCount(bridge), 9);
    assert.equal(bridge.listeners.has("chat:subagents"), false);
    for (const handler of bridge.listeners.get("chat:error") ?? []) {
      handler({ streamId: handle.streamId, message: "Stopped" });
    }
    assert.equal(listenerCount(bridge), 0);
  } finally {
    restore();
  }
});

test("terminal Design publication state is forwarded without turning suppression into retry", () => {
  const { bridge, restore } = installFakeBridge();
  const publicationStates: Array<"retryable" | "suppressed" | undefined> = [];
  try {
    const handle = startGeneration(
      {
        chatId: "chat-design-conflict",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      {
        ...callbacks(),
        onError: (_message, _content, _timeline, _chat, _reasoning, designPublication) => {
          publicationStates.push(designPublication);
        },
      },
      "turn-design-conflict",
    );

    for (const handler of bridge.listeners.get("chat:error") ?? []) {
      handler({
        streamId: handle.streamId,
        message: "The Design revision conflicted with newer project history.",
        designPublication: "suppressed",
      });
    }
    assert.deepEqual(publicationStates, ["suppressed"]);
    assert.equal(listenerCount(bridge), 0);
  } finally {
    restore();
  }
});

test("overflow retry reset is routed separately from text deltas", () => {
  const { bridge, restore } = installFakeBridge();
  const deltas: string[] = [];
  let resets = 0;
  try {
    const handle = startGeneration(
      {
        chatId: "chat-reset",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      {
        ...callbacks(),
        onDelta: (delta) => deltas.push(delta),
        onReset: () => {
          resets += 1;
        },
      },
      "turn-reset",
    );

    for (const handler of bridge.listeners.get("chat:delta") ?? []) {
      handler({ streamId: "other", delta: "ignored" });
      handler({ streamId: handle.streamId, delta: "failed-attempt" });
      handler({ streamId: handle.streamId, delta: "", reset: true });
      handler({ streamId: handle.streamId, delta: "retry" });
    }

    assert.deepEqual(deltas, ["failed-attempt", "retry"]);
    assert.equal(resets, 1);
    handle.cancel("lifecycle");
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

test("todo notifications are validated and scoped to their owning stream and chat", () => {
  const { bridge, restore } = installFakeBridge();
  const received: unknown[] = [];
  try {
    const disabled = startGeneration(
      {
        chatId: "chat-todo-disabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      callbacks(),
      "turn-todo-disabled",
    );
    assert.equal(bridge.listeners.has("chat:todo"), false);
    disabled.cancel("lifecycle");

    const enabled = startGeneration(
      {
        chatId: "chat-todo-enabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      { ...callbacks(), onTodo: (snapshot) => received.push(snapshot) },
      "turn-todo-enabled",
    );
    const snapshot = {
      version: 1,
      chatId: "chat-todo-enabled",
      availability: "ready",
      tasks: [{ id: 1, subject: "Verify IPC", status: "in_progress" }],
    };
    for (const handler of bridge.listeners.get("chat:todo") ?? []) {
      handler({ streamId: "other-stream", snapshot });
      handler({ streamId: enabled.streamId, snapshot: { ...snapshot, version: 2 } });
      handler({
        streamId: enabled.streamId,
        snapshot: { ...snapshot, chatId: "another-chat" },
      });
      handler({ streamId: enabled.streamId, snapshot });
    }
    assert.deepEqual(received, [snapshot]);
    enabled.cancel("lifecycle");
    assert.equal(bridge.listeners.get("chat:todo")?.size, 0);
  } finally {
    restore();
  }
});

test("GUI artifact notifications are validated and scoped to their owning stream", () => {
  const { bridge, restore } = installFakeBridge();
  const received: unknown[] = [];
  try {
    const disabled = startGeneration(
      {
        chatId: "chat-artifact-disabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      callbacks(),
      "turn-artifact-disabled",
    );
    assert.equal(bridge.listeners.has("chat:artifact"), false);
    disabled.cancel("lifecycle");

    const enabled = startGeneration(
      {
        chatId: "chat-artifact-enabled",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      { ...callbacks(), onArtifactEvent: (event) => received.push(event) },
      "turn-artifact-enabled",
    );
    const artifact = {
      version: 1,
      kind: "image",
      attachment: {
        id: "att-1",
        name: "preview.png",
        mimeType: "image/png",
        kind: "image",
        size: 1,
        data: "AA==",
      },
    };
    const present = { version: 1, operation: "present", artifact };
    const reset = { version: 1, operation: "reset" };
    for (const handler of bridge.listeners.get("chat:artifact") ?? []) {
      handler({ streamId: "other-stream", event: present });
      handler({
        streamId: enabled.streamId,
        event: { ...present, version: 2 },
      });
      handler({ streamId: enabled.streamId, event: present });
      handler({ streamId: enabled.streamId, event: reset });
    }
    assert.deepEqual(received, [present, reset]);
    enabled.cancel("lifecycle");
    assert.equal(bridge.listeners.get("chat:artifact")?.size, 0);
  } finally {
    restore();
  }
});

test("HTML GUI artifact present events are accepted without inline HTML bytes", () => {
  const { bridge, restore } = installFakeBridge();
  const received: unknown[] = [];
  try {
    const enabled = startGeneration(
      {
        chatId: "chat-html-artifact",
        workspaceId: "workspace-1",
        providerId: "provider-1",
        model: "model-1",
      },
      { ...callbacks(), onArtifactEvent: (event) => received.push(event) },
      "turn-html-artifact",
    );
    const artifact = {
      version: 1,
      kind: "html",
      id: "html-1",
      title: "Dependencies",
      mimeType: "text/html",
      size: 12,
      mediaId: "media-1",
    };
    const present = { version: 1, operation: "present", artifact };
    const rejected = {
      version: 1,
      operation: "present",
      artifact: { ...artifact, html: "<script>fetch('https://evil.test')</script>" },
    };
    for (const handler of bridge.listeners.get("chat:artifact") ?? []) {
      handler({ streamId: enabled.streamId, event: rejected });
      handler({ streamId: enabled.streamId, event: present });
    }
    assert.deepEqual(received, [present]);
    enabled.cancel("lifecycle");
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
