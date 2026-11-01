import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvasV1,
} from "../../renderer/shared/design-canvas/schema.js";
import { DesignGrantRegistry } from "../services/design-canvas/grants.js";
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
  options: {
    enabled?: boolean;
    chats?: Record<string, DesignCanvasChat>;
    roots?: Record<string, string | null>;
    workspaceRoot?: (chat: DesignCanvasChat) => Promise<string | null>;
  } = {},
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
  const grants = new DesignGrantRegistry();
  const issued: string[] = [];
  const issuedGrants: string[] = [];
  const issue = grants.issue.bind(grants);
  grants.issue = (chatId, workspaceRoot) => {
    issued.push(chatId);
    const grant = issue(chatId, workspaceRoot);
    issuedGrants.push(grant);
    return grant;
  };
  const roots = options.roots ?? { "workspace-1": "/work/site" };
  registerDesignCanvasHandlers({
    enabled: () => enabled,
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `${channel} registered twice`);
      handlers.set(channel, handler as Handler);
    },
    store,
    broadcast: (update) => broadcasts.push(update),
    getChat: async (chatId) => chats[chatId] ?? null,
    grants,
    workspaceRoot:
      options.workspaceRoot ?? (async (chat) => roots[chat.workspaceId ?? ""] ?? null),
  });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} is not registered`);
    return handler({}, ...args);
  };
  return {
    root,
    store,
    grants,
    issued,
    issuedGrants,
    chats,
    handlers,
    broadcasts,
    invoke,
    disable: () => (enabled = false),
  };
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

test("a design-mode chat in a folder workspace gets one stable grant for that folder", async (t) => {
  const { invoke, grants } = await fixture(t);
  const first = (await invoke("designCanvas:grant", "chat-1")) as { grant: string };
  assert.match(first.grant, /^[a-z2-7]{52}$/u);
  assert.deepEqual(await invoke("designCanvas:grant", "chat-1"), first);
  assert.deepEqual(grants.resolve(first.grant), { chatId: "chat-1", workspaceRoot: "/work/site" });
});

test("a chat that cannot frame workspace files gets no grant", async (t) => {
  const { invoke, issued } = await fixture(t, {
    chats: {
      off: { id: "off", workspaceId: "workspace-1" },
      bot: { id: "bot", workspaceId: "workspace-1", designMode: true, botId: "bot-1" },
      owned: {
        id: "owned",
        workspaceId: "workspace-1",
        designMode: true,
        owner: { kind: "routine" } as unknown as DesignCanvasChat["owner"],
      },
      loose: { id: "loose", workspaceId: "no-folder", designMode: true },
    },
    roots: { "workspace-1": "/work/site", "no-folder": null },
  });
  for (const chatId of ["off", "bot", "owned", "loose", "missing"]) {
    assert.deepEqual(await invoke("designCanvas:grant", chatId), { error: "unavailable" }, chatId);
  }
  assert.deepEqual(issued, []);
});

test("turning design mode off before the grant lands leaves no live grant", async (t) => {
  const { invoke, grants, chats } = await fixture(t);
  const issue = grants.issue.bind(grants);
  let issued = "";
  grants.issue = (chatId, root) => {
    issued = issue(chatId, root);
    chats["chat-1"] = { id: "chat-1", workspaceId: "workspace-1" };
    return issued;
  };
  assert.deepEqual(await invoke("designCanvas:grant", "chat-1"), { error: "unavailable" });
  assert.equal(grants.resolve(issued), null);
});

test("the grant handler refuses with the flag off and rejects malformed chat ids", async (t) => {
  const { invoke, disable, issued } = await fixture(t);
  await assert.rejects(invoke("designCanvas:grant", "../escape"), /Invalid chat id/u);
  await assert.rejects(invoke("designCanvas:grant", 7), /Invalid chat id/u);
  disable();
  await assert.rejects(invoke("designCanvas:grant", "chat-1"), /Design mode is not available/u);
  assert.deepEqual(issued, []);
});

test("a workspace removed or re-pointed while the grant is issued leaves no live grant", async (t) => {
  for (const later of [null, "/work/elsewhere"]) {
    const answers: Array<string | null> = ["/work/site", later];
    const { invoke, grants, issuedGrants } = await fixture(t, {
      workspaceRoot: async () => (answers.length > 1 ? answers.shift()! : answers[0]!),
    });
    assert.deepEqual(await invoke("designCanvas:grant", "chat-1"), { error: "unavailable" });
    assert.equal(issuedGrants.length, 1);
    assert.equal(grants.resolve(issuedGrants[0]!), null, String(later));
  }
});
