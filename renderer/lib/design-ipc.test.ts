import assert from "node:assert/strict";
import test from "node:test";
import { DesignIpcError, designProjectsApi } from "./design-ipc.js";

interface FakeBridge {
  calls: { channel: string; args: unknown[] }[];
  emit(channel: string, payload: unknown): void;
  respond(value: unknown): void;
  restore(): void;
}

function installFakeBridge(): FakeBridge {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: { channel: string; args: unknown[] }[] = [];
  let response: unknown = undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aidenAPI: {
        ipc: {
          invoke: async (channel: string, ...args: unknown[]) => {
            calls.push({ channel, args });
            return response;
          },
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
    calls,
    emit: (channel, payload) => {
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
    respond: (value) => {
      response = value;
    },
    restore: () => {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

test("project change notifications reach subscribers only when well formed", () => {
  const bridge = installFakeBridge();
  try {
    const seen: unknown[] = [];
    const unsubscribe = designProjectsApi.onChanged((event) => seen.push(event));
    bridge.emit("designProjects:changed", { projectId: "project-1", revision: 4 });
    bridge.emit("designProjects:changed", { projectId: "../escape", revision: 4 });
    bridge.emit("designProjects:changed", { projectId: "project-1", revision: -1 });
    bridge.emit("designProjects:changed", null);
    unsubscribe();
    bridge.emit("designProjects:changed", { projectId: "project-1", revision: 5 });
    assert.deepEqual(seen, [{ projectId: "project-1", revision: 4 }]);
  } finally {
    bridge.restore();
  }
});

test("run notifications drop unknown statuses and malformed revision lists", () => {
  const bridge = installFakeBridge();
  try {
    const seen: unknown[] = [];
    const unsubscribe = designProjectsApi.onRunChanged((event) => seen.push(event));
    const valid = { projectId: "project-1", runId: "run-1", status: "partial", acceptedRevisionIds: ["rev-1"] };
    bridge.emit("designProjects:run-changed", valid);
    bridge.emit("designProjects:run-changed", { ...valid, status: "exploding" });
    bridge.emit("designProjects:run-changed", { ...valid, acceptedRevisionIds: ["a", "b", "c", "d", "e"] });
    bridge.emit("designProjects:run-changed", { ...valid, acceptedRevisionIds: "rev-1" });
    unsubscribe();
    assert.deepEqual(seen, [valid]);
  } finally {
    bridge.restore();
  }
});

test("delete sends the revision or the unreadable marker on the same channel", async () => {
  const bridge = installFakeBridge();
  try {
    bridge.respond(undefined);
    await designProjectsApi.delete("project-1", 3);
    await designProjectsApi.deleteUnreadable("project-1");
    assert.deepEqual(bridge.calls, [
      { channel: "designProjects:delete", args: [{ projectId: "project-1", expectedRevision: 3 }] },
      { channel: "designProjects:delete", args: [{ projectId: "project-1", unreadable: true }] },
    ]);
  } finally {
    bridge.restore();
  }
});

test("a store refusal from main surfaces as a typed error, not a payload", async () => {
  const bridge = installFakeBridge();
  try {
    bridge.respond({ ok: false, reason: "not_found", message: "This design project no longer exists." });
    await assert.rejects(designProjectsApi.get("project-1"), (error: unknown) => {
      assert.ok(error instanceof DesignIpcError);
      assert.equal(error.reason, "not_found");
      assert.equal(error.message, "This design project no longer exists.");
      return true;
    });
  } finally {
    bridge.restore();
  }
});

test("an unknown response shape is rejected as an unexpected failure", async () => {
  const bridge = installFakeBridge();
  try {
    bridge.respond({ unexpected: true });
    await assert.rejects(designProjectsApi.list(), (error: unknown) => {
      assert.ok(error instanceof DesignIpcError);
      assert.equal(error.reason, "unexpected");
      return true;
    });
    bridge.respond([{ id: "../bad", title: "x" }]);
    await assert.rejects(designProjectsApi.list(), DesignIpcError);
  } finally {
    bridge.restore();
  }
});

test("a mutate refusal keeps the current snapshot for the caller to show", async () => {
  const bridge = installFakeBridge();
  const snapshot = {
    schema: 1,
    id: "project-1",
    revision: 7,
    title: "Studio",
    chatId: "chat-1",
    state: "active",
    createdAt: 1,
    updatedAt: 2,
    canvas: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] },
    screens: {},
    revisions: {},
    directionSets: {},
    runs: {},
  };
  try {
    bridge.respond({ ok: false, reason: "stale", message: "Changed elsewhere.", snapshot });
    const result = await designProjectsApi.mutate("project-1", 6, { op: "rename", title: "New" });
    assert.deepEqual(result, { ok: false, reason: "stale", message: "Changed elsewhere.", snapshot });
  } finally {
    bridge.restore();
  }
});
