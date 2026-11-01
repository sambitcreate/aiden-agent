import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvasV1,
} from "../../renderer/shared/design-canvas/schema.js";
import { DesignCanvasStore } from "../services/design-canvas/store.js";
import {
  registerDesignCanvasHandlers,
  type DesignCanvasChat,
  type DesignCanvasUpdated,
} from "./design-canvas.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const note: DesignCanvasV1 = {
  ...emptyDesignCanvas(),
  frames: [
    {
      id: "n",
      kind: "note",
      title: "Note",
      x: 0,
      y: 0,
      w: 200,
      h: 120,
      text: "hi",
      createdBy: "person",
    },
  ],
};

async function fixture(
  t: TestContext,
  options: { enabled?: boolean; chats?: Record<string, DesignCanvasChat> } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-canvas-handlers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let enabled = options.enabled ?? true;
  const handlers = new Map<string, Handler>();
  const broadcasts: DesignCanvasUpdated[] = [];
  const store = new DesignCanvasStore({ root: () => root });
  const chats = options.chats ?? {
    "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
  };
  registerDesignCanvasHandlers({
    enabled: () => enabled,
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `${channel} registered twice`);
      handlers.set(channel, handler as Handler);
    },
    store,
    broadcast: (update) => broadcasts.push(update),
    getChat: async (chatId) => chats[chatId] ?? null,
  });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} is not registered`);
    return handler({}, ...args);
  };
  return { root, store, handlers, broadcasts, invoke, disable: () => (enabled = false) };
}

test("with the flag off no designCanvas channel is registered", async (t) => {
  const { handlers } = await fixture(t, { enabled: false });
  assert.deepEqual(
    [...handlers.keys()].filter((channel) => channel.startsWith("designCanvas:")),
    [],
  );
});

test("a successful save broadcasts the new revision and get reads it back", async (t) => {
  const { invoke, broadcasts } = await fixture(t);
  assert.equal(((await invoke("designCanvas:get", "chat-1")) as DesignCanvasV1).revision, 0);
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", note, 0), { ok: true, revision: 1 });
  assert.deepEqual(broadcasts, [{ chatId: "chat-1", revision: 1 }]);
  const stored = (await invoke("designCanvas:get", "chat-1")) as DesignCanvasV1;
  assert.deepEqual(
    stored.frames.map((frame) => frame.id),
    ["n"],
  );
});

test("a conflicting or invalid save broadcasts nothing", async (t) => {
  const { invoke, broadcasts } = await fixture(t);
  await invoke("designCanvas:save", "chat-1", note, 0);
  const conflict = (await invoke("designCanvas:save", "chat-1", note, 0)) as {
    ok: boolean;
    reason?: string;
  };
  assert.equal(conflict.reason, "conflict");
  const invalid = (await invoke("designCanvas:save", "chat-1", { version: 9 }, 1)) as {
    reason?: string;
  };
  assert.equal(invalid.reason, "invalid");
  assert.equal(broadcasts.length, 1);
});

test("malformed parameters are rejected before the store is used", async (t) => {
  const { invoke, root, broadcasts } = await fixture(t);
  await assert.rejects(invoke("designCanvas:get", 42));
  await assert.rejects(invoke("designCanvas:get", "../escape"));
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, -1));
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, 1.5));
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, "0"));
  await assert.rejects(invoke("designCanvas:save", undefined, note, 0));
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(broadcasts, []);
});

test("a chat that does not exist has no canvas to read or write", async (t) => {
  const { invoke, root } = await fixture(t);
  await assert.rejects(invoke("designCanvas:get", "missing"), /no longer available/u);
  await assert.rejects(invoke("designCanvas:save", "missing", note, 0), /no longer available/u);
  assert.deepEqual(await fs.readdir(root), []);
});

test("every handler refuses once the flag turns off", async (t) => {
  const { invoke, disable, root } = await fixture(t);
  disable();
  await assert.rejects(invoke("designCanvas:get", "chat-1"), /Design mode is not available/u);
  await assert.rejects(
    invoke("designCanvas:save", "chat-1", note, 0),
    /Design mode is not available/u,
  );
  assert.deepEqual(await fs.readdir(root), []);
});
