import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvas,
} from "../../renderer/shared/design-canvas/schema.js";
import { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.js";
import { DesignGrantRegistry } from "../services/design-canvas/grants.js";
import { DesignMdReader } from "../services/design-canvas/design-md/reader.js";
import { DesignCanvasStore, DesignChatCanvases } from "../services/design-canvas/store.js";
import { DesignCanvasViews } from "../services/design-canvas/views.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { DesignAppStatus, DesignAppsSnapshot } from "../../renderer/shared/design-app.js";
import {
  DESIGN_CAPTURE_MAX_SIDE,
  DESIGN_SOURCE_MAX_BYTES,
  registerDesignCanvasHandlers,
  type DesignCanvasCaptureImage,
  type DesignCanvasCaptureWindow,
  type DesignCanvasChat,
  type DesignCanvasPickOptions,
  type DesignCanvasPlaceArtifactResult,
  type DesignCanvasSaveOptions,
  type DesignCanvasUpdated,
  type DesignAppRenderRequest,
  type DesignFrameRenderRequest,
} from "./design-canvas.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const note: DesignCanvas = {
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
      pageId: "page-1",
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
    windowFor?: (event: unknown) => DesignCanvasCaptureWindow | null;
    pickFile?: (event: unknown, options: DesignCanvasPickOptions) => Promise<string | null>;
    saveFile?: (options: DesignCanvasSaveOptions) => string | null;
    renderFrame?: (request: DesignFrameRenderRequest) => Promise<Uint8Array>;
    artifacts?: Record<string, string>;
    artifactHtml?: Record<string, string>;
    artifactTitles?: Record<string, string>;
    designMd?: Parameters<typeof registerDesignCanvasHandlers>[0]["designMd"];
    senderWindowShown?: Parameters<typeof registerDesignCanvasHandlers>[0]["senderWindowShown"];
    appFrames?: Parameters<typeof registerDesignCanvasHandlers>[0]["appFrames"];
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-canvas-handlers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let enabled = options.enabled ?? true;
  const handlers = new Map<string, Handler>();
  const broadcasts: DesignCanvasUpdated[] = [];
  const chats = options.chats ?? {
    "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
  };
  const workspaceStore = new DesignCanvasStore({ root: () => root });
  const store = new DesignChatCanvases({
    store: workspaceStore,
    workspaceIdOf: async (chatId) => (chats[chatId] ? persistedChatWorkspaceId(chats[chatId].workspaceId) : null),
  });
  const grants = new DesignGrantRegistry();
  const views = new DesignCanvasViews();
  const senderWatches: Array<{ event: unknown; reset: () => void }> = [];
  const focusSent: Array<{ event: unknown; request: unknown }> = [];
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
  const watched: Array<[string, string, string[]] | ["clear", string]> = [];
  const dialogs: DesignCanvasPickOptions[] = [];
  const saveDialogs: DesignCanvasSaveOptions[] = [];
  const renders: DesignFrameRenderRequest[] = [];
  const artifactExports: string[] = [];
  const artifactReads: string[] = [];
  const artifactThemes: unknown[] = [];
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
    views,
    whenSenderResets: (event, reset) => senderWatches.push({ event, reset }),
    ...(options.senderWindowShown ? { senderWindowShown: options.senderWindowShown } : {}),
    sendFocus: (event, request) => focusSent.push({ event, request }),
    workspaceRoot:
      options.workspaceRoot ?? (async (chat) => roots[chat.workspaceId ?? ""] ?? null),
    windowFor: options.windowFor ?? (() => null),
    watcher: {
      set: async (chatId, workspaceRoot, paths) => {
        watched.push([chatId, workspaceRoot, [...paths]]);
      },
      clear: (chatId) => {
        watched.push(["clear", chatId]);
      },
      ownWrite: () => () => undefined,
    },
    pickFile: async (event, pickOptions) => {
      dialogs.push(pickOptions);
      return options.pickFile ? options.pickFile(event, pickOptions) : null;
    },
    saveFile: async (_event, saveOptions) => {
      saveDialogs.push(saveOptions);
      return options.saveFile ? options.saveFile(saveOptions) : null;
    },
    renderFrame: async (request) => {
      renders.push(request);
      return options.renderFrame ? options.renderFrame(request) : new TextEncoder().encode(`${request.format}:${request.url}`);
    },
    artifactPreview: async (chatId, mediaId, theme) => {
      artifactReads.push(`preview ${chatId}/${mediaId}`);
      artifactThemes.push(theme);
      const src = options.artifacts?.[mediaId];
      return src ? { src } : undefined;
    },
    artifactHtml: async (chatId, mediaId) => {
      artifactReads.push(`html ${chatId}/${mediaId}`);
      return options.artifactHtml?.[mediaId];
    },
    artifactTitle: async (_chatId, mediaId) => options.artifactTitles?.[mediaId],
    newId: (() => {
      let next = 0;
      return () => `placed-${++next}`;
    })(),
    exportArtifactSource: async (_event, chatId, mediaId) => {
      artifactExports.push(`${chatId}/${mediaId}`);
      return { saved: true, canceled: false };
    },
    ...(options.designMd ? { designMd: options.designMd } : {}),
    ...(options.appFrames ? { appFrames: options.appFrames } : {}),
  });
  const invokeFrom = async (event: unknown, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} is not registered`);
    return handler(event, ...args);
  };
  // A save names the workspace whose canvas the renderer is on. Tests that
  // save from the chat's current workspace leave it out and it is filled in
  // here; `invokeFrom` sends exactly what it is given.
  const invoke = (channel: string, ...args: unknown[]) => {
    const [chatId, , , saveOptions] = args;
    if (
      channel === "designCanvas:save" &&
      typeof chatId === "string" &&
      chats[chatId] &&
      (saveOptions === undefined || (typeof saveOptions === "object" && saveOptions !== null && !("workspaceId" in saveOptions)))
    ) {
      args[3] = { ...(saveOptions as object | undefined), workspaceId: persistedChatWorkspaceId(chats[chatId]!.workspaceId) };
    }
    return invokeFrom({}, channel, ...args);
  };
  return {
    root,
    store,
    workspaceStore,
    views,
    senderWatches,
    focusSent,
    grants,
    issued,
    issuedGrants,
    chats,
    handlers,
    broadcasts,
    invoke,
    invokeFrom,
    watched,
    dialogs,
    saveDialogs,
    renders,
    artifactExports,
    artifactReads,
    artifactThemes,
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
  assert.equal(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).revision, 0);
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", note, 0), { ok: true, revision: 1 });
  assert.deepEqual(broadcasts, [{ workspaceId: "workspace-1", chatId: "chat-1", revision: 1 }]);
  const stored = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  assert.deepEqual(
    stored.frames.map((frame) => frame.id),
    ["n"],
  );
});

test("a save broadcasts the chat's workspace id", async (t) => {
  const { invoke, broadcasts } = await fixture(t, {
    chats: {
      "chat-a": { id: "chat-a", workspaceId: "ws-1", designMode: true },
      "chat-b": { id: "chat-b", workspaceId: "ws-1", designMode: true },
      legacy: { id: "legacy", designMode: true },
    },
  });
  await invoke("designCanvas:save", "chat-a", note, 0);
  assert.deepEqual(broadcasts, [{ workspaceId: "ws-1", chatId: "chat-a", revision: 1 }]);
  // Chat B is on the same workspace, so it reads chat A's save.
  assert.deepEqual(((await invoke("designCanvas:get", "chat-b")) as DesignCanvas).frames.map((frame) => frame.id), ["n"]);
  // A chat from before workspaces were explicit is on the default workspace.
  await invoke("designCanvas:save", "legacy", note, 0, { workspaceId: "default" });
  assert.deepEqual(broadcasts[1], { workspaceId: "default", chatId: "legacy", revision: 1 });
});

test("a save that names another workspace than the chat's is answered moved, and writes nothing", async (t) => {
  const { invoke, invokeFrom, broadcasts, workspaceStore } = await fixture(t, {
    chats: { "chat-1": { id: "chat-1", workspaceId: "ws-2", designMode: true } },
  });
  await workspaceStore.save("ws-2", { ...note, frames: [] }, 0);
  // The canvas was opened while the chat was in ws-1; the chat has since moved to ws-2.
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", note, 1, { workspaceId: "ws-1" }), {
    ok: false,
    reason: "moved",
    workspaceId: "ws-2",
  });
  assert.equal((await workspaceStore.get("ws-2")).revision, 1, "ws-2 is unchanged");
  assert.deepEqual((await workspaceStore.get("ws-1")).revision, 0, "ws-1 is untouched too");
  assert.deepEqual(broadcasts, []);
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, 1, { workspaceId: "../ws" }), /save options/u);
  // A save that does not say which workspace's canvas it is cannot replace any.
  await assert.rejects(invokeFrom({}, "designCanvas:save", "chat-1", note, 1), /save options/u);
  await assert.rejects(invokeFrom({}, "designCanvas:save", "chat-1", note, 1, { undone: [] }), /save options/u);
});

test("designCanvas:view stores a parsed view and refuses a malformed one", async (t) => {
  const { invoke, views } = await fixture(t);
  const report = (view: unknown, focusId: unknown = 0, workspaceId: unknown = "workspace-1") => ({ workspaceId, view, focusId });
  await invoke("designCanvas:view", "chat-1", report({ pageId: "p2", viewport: { x: 10, y: 20, zoom: 9 }, size: { w: 800, h: 600 } }));
  assert.deepEqual(await views.get("chat-1", "workspace-1"), { pageId: "p2", viewport: { x: 10, y: 20, zoom: 4 }, size: { w: 800, h: 600 } });
  assert.equal(views.mounted("workspace-1"), 1);
  const good = { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } };
  for (const bad of [
    report({ pageId: "p2" }),
    report({ pageId: "", viewport: { x: 0, y: 0, zoom: 1 } }),
    report(good, -1),
    report(good, 1.5),
    report(good, "1"),
    report(good, 0, "../ws"),
    { view: good, focusId: 0 },
    { mounted: true },
    "p2",
    null,
  ]) {
    await assert.rejects(invoke("designCanvas:view", "chat-1", bad), /Invalid canvas view/u, JSON.stringify(bad));
  }
  assert.equal((await views.get("chat-1", "workspace-1"))?.viewport.x, 10, "a refused report changes nothing");
  // The canvas reads the kept view back when it mounts.
  await invoke("designCanvas:view", "chat-1", { mounted: false });
  assert.equal(views.mounted("workspace-1"), 0);
  assert.deepEqual(await invoke("designCanvas:view:get", "chat-1"), {
    pageId: "p2",
    viewport: { x: 10, y: 20, zoom: 4 },
    focusId: 0,
    viewports: { p2: { x: 10, y: 20, zoom: 4 } },
  });
});

test("designCanvas:view accepts visible true and false, treats a missing visible as false, and refuses a non-boolean", async (t) => {
  const { invoke, views } = await fixture(t);
  const report = (visible?: unknown) => ({
    workspaceId: "workspace-1",
    view: { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } },
    focusId: 0,
    ...(visible === undefined ? {} : { visible }),
  });
  await invoke("designCanvas:view", "chat-1", report(true));
  assert.equal(views.visible("workspace-1"), 1);
  await invoke("designCanvas:view", "chat-1", report(false));
  assert.equal(views.visible("workspace-1"), 0);
  await invoke("designCanvas:view", "chat-1", report(true));
  await invoke("designCanvas:view", "chat-1", report());
  assert.equal(views.visible("workspace-1"), 0, "an older renderer never keeps a server alive");
  for (const bad of ["true", 1, null, {}]) {
    await assert.rejects(invoke("designCanvas:view", "chat-1", report(bad)), /Invalid canvas view/u, JSON.stringify(bad));
  }
  assert.equal(views.mounted("workspace-1"), 1);
});

test("a shown canvas in a minimized window isn't present, and restoring the window makes it present again", async (t) => {
  const window = { minimized: false, changed: () => undefined as void };
  const { invoke, views } = await fixture(t, {
    senderWindowShown: (_event, changed) => {
      window.changed = changed;
      return () => !window.minimized;
    },
  });
  const counts: number[] = [];
  views.onPresence((_workspaceId, count) => counts.push(count));
  await invoke("designCanvas:view", "chat-1", { workspaceId: "workspace-1", view: { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0, visible: true });
  assert.equal(views.visible("workspace-1"), 1);
  window.minimized = true;
  window.changed();
  assert.equal(views.visible("workspace-1"), 0);
  window.minimized = false;
  window.changed();
  assert.deepEqual(counts, [1, 0, 1]);
});

test("a canvas's last report and its unmount, sent back to back, leave it counted as closed", async (t) => {
  const { invoke, views } = await fixture(t);
  const last = invoke("designCanvas:view", "chat-1", { workspaceId: "workspace-1", view: { pageId: "p2", viewport: { x: 3, y: 0, zoom: 1 } }, focusId: 0 });
  const closed = invoke("designCanvas:view", "chat-1", { mounted: false });
  await Promise.all([last, closed]);
  assert.equal(views.mounted("workspace-1"), 0);
  assert.equal((await views.get("chat-1", "workspace-1"))?.viewport.x, 3, "the last report still counts");
});

test("designCanvas:view:get answers null for a chat with no kept view", async (t) => {
  const { invoke } = await fixture(t);
  assert.equal(await invoke("designCanvas:view:get", "chat-1"), null);
});

test("a view report naming the chat's old workspace is dropped", async (t) => {
  const { invoke, views, chats } = await fixture(t);
  await invoke("designCanvas:view", "chat-1", { workspaceId: "workspace-1", view: { pageId: "p1", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0 });
  chats["chat-1"]!.workspaceId = "workspace-2";
  await invoke("designCanvas:view", "chat-1", { workspaceId: "workspace-2", view: { pageId: "w2-page", viewport: { x: 7, y: 0, zoom: 1 } }, focusId: 0 });
  // A canvas still showing W1 reports late; W2's view stays as it was.
  await invoke("designCanvas:view", "chat-1", { workspaceId: "workspace-1", view: { pageId: "p1", viewport: { x: 99, y: 0, zoom: 1 } }, focusId: 0 });
  assert.deepEqual(await views.get("chat-1", "workspace-2"), { pageId: "w2-page", viewport: { x: 7, y: 0, zoom: 1 } });
  assert.equal((await views.get("chat-1", "workspace-1"))?.viewport.x, 0);
});

test("designCanvas:view refuses a Bot chat, but an unmount needs only a well-formed chat id", async (t) => {
  const { invoke, views, chats } = await fixture(t, {
    chats: {
      "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
      bot: { id: "bot", workspaceId: "workspace-1", botId: "b1" },
    },
  });
  const report = { workspaceId: "workspace-1", view: { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0 };
  await assert.rejects(invoke("designCanvas:view", "bot", report), /not available/u);
  await assert.rejects(invoke("designCanvas:view:get", "bot"), /not available/u);
  await assert.rejects(invoke("designCanvas:view", "missing", report), /no longer available/u);
  assert.equal(await views.get("bot", "workspace-1"), undefined);
  // The chat is deleted while its canvas is open; the unmount that follows still lands.
  await invoke("designCanvas:view", "chat-1", report);
  delete chats["chat-1"];
  await invoke("designCanvas:view", "chat-1", { mounted: false });
  assert.equal(views.mounted("workspace-1"), 0);
  await assert.rejects(invoke("designCanvas:view", "../x", { mounted: false }), /Invalid chat id/u);
});

test("when the window that reports views reloads, crashes or goes away, every canvas counts as closed", async (t) => {
  const { invokeFrom, views, senderWatches } = await fixture(t);
  const sender = { id: "window" };
  const report = { workspaceId: "workspace-1", view: { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0 };
  await invokeFrom(sender, "designCanvas:view", "chat-1", report);
  assert.equal(views.mounted("workspace-1"), 1);
  senderWatches.find((watch) => watch.event === sender)!.reset();
  assert.equal(views.mounted("workspace-1"), 0);
  assert.equal((await views.get("chat-1", "workspace-1"))?.pageId, "page-1", "the page is kept");
});

test("a page a save takes off is remembered as removed, unless the save says the person's undo took it off", async (t) => {
  const { invoke } = await fixture(t);
  const page = (path: string) => ({
    id: path,
    kind: "file" as const,
    title: path,
    path,
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    designWidth: 1280 as const,
    pageId: "page-1",
    createdBy: "aiden" as const,
  });
  await invoke("designCanvas:save", "chat-1", { ...note, frames: [...note.frames, page("design/a.html"), page("design/b.html")] }, 0);
  await invoke("designCanvas:save", "chat-1", { ...note, frames: [...note.frames, page("design/b.html")] }, 1, { undone: ["design/a.html"] });
  assert.equal(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).removedPagePaths, undefined);
  await invoke("designCanvas:save", "chat-1", note, 2);
  assert.deepEqual(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).removedPagePaths, ["design/b.html"]);
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
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, 0, { undone: "design/a.html" }), /save options/u);
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, 0, { undone: ["../outside.html"] }), /save options/u);
  await assert.rejects(invoke("designCanvas:save", "chat-1", note, 0, { undone: [42] }), /save options/u);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(broadcasts, []);
});

test("a chat that does not exist has no canvas to read or write", async (t) => {
  const { invoke, root } = await fixture(t);
  await assert.rejects(invoke("designCanvas:get", "missing"), /no longer available/u);
  await assert.rejects(invoke("designCanvas:save", "missing", note, 0, { workspaceId: "workspace-1" }), /no longer available/u);
  assert.deepEqual(await fs.readdir(root), []);
});

test("a Bot or feature-owned chat has no canvas to read or write", async (t) => {
  const { invoke, root, broadcasts } = await fixture(t, {
    chats: {
      bot: { id: "bot", workspaceId: "workspace-1", designMode: true, botId: "bot-1" },
      owned: {
        id: "owned",
        workspaceId: "workspace-1",
        owner: { kind: "routine" } as unknown as DesignCanvasChat["owner"],
      },
    },
  });
  for (const chatId of ["bot", "owned"]) {
    await assert.rejects(invoke("designCanvas:get", chatId), /Design mode is not available/u);
    await assert.rejects(
      invoke("designCanvas:save", chatId, note, 0),
      /Design mode is not available/u,
    );
  }
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(broadcasts, []);
});

test("a regular chat's last edit still saves after design mode turns off", async (t) => {
  // Turning design mode off unmounts the canvas, which flushes its pending edit;
  // that save may land after the chat's flag has already cleared.
  const { invoke } = await fixture(t, {
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
  });
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", note, 0), { ok: true, revision: 1 });
  assert.equal(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).revision, 1);
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

/** A stand-in for a window's page: records captures and reports pixel sizes like Electron. */
function fakeWindow(content: { width: number; height: number }, scale = 1, zoom = 1) {
  const captured: Array<{ x: number; y: number; width: number; height: number }> = [];
  const image = (width: number, height: number): DesignCanvasCaptureImage => ({
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (size) => {
      const ratio = size.width / width;
      return image(size.width, size.height ?? Math.round(height * ratio));
    },
    toDataURL: () => `data:image/png;base64,${width}x${height}`,
  });
  const window: DesignCanvasCaptureWindow = {
    getContentSize: () => [content.width, content.height],
    getZoomFactor: () => zoom,
    capturePage: async (rect) => {
      captured.push(rect);
      return image(Math.round(rect.width * scale), Math.round(rect.height * scale));
    },
  };
  return { window, captured };
}

test("a capture comes from the asking window, clamped to its content", async (t) => {
  const mine = fakeWindow({ width: 1200, height: 800 });
  const other = fakeWindow({ width: 1200, height: 800 });
  const sender = { sender: "main window" };
  const { invokeFrom } = await fixture(t, {
    windowFor: (event) => (event === sender ? mine.window : other.window),
  });
  const result = await invokeFrom(sender, "designCanvas:capture", { x: -40, y: 700, width: 400.6, height: 300 });
  assert.deepEqual(mine.captured, [{ x: 0, y: 700, width: 361, height: 100 }]);
  assert.deepEqual(other.captured, []);
  assert.deepEqual(result, { dataUrl: "data:image/png;base64,361x100" });
});

test("a zoomed-in page captures the frame it shows, not the area its page coordinates name", async (t) => {
  // The page's rectangles are CSS pixels; at 125% zoom each one covers 1.25 window points.
  const page = fakeWindow({ width: 1000, height: 800 }, 1, 1.25);
  const { invoke } = await fixture(t, { windowFor: () => page.window });
  await invoke("designCanvas:capture", { x: 100, y: 100, width: 200, height: 100 });
  await invoke("designCanvas:capture", { x: 700, y: 600, width: 200, height: 100 });
  assert.deepEqual(page.captured, [
    { x: 125, y: 125, width: 250, height: 125 },
    { x: 875, y: 750, width: 125, height: 50 },
  ]);
});

test("a capture is a PNG no larger than 1024 px on its longest side", async (t) => {
  const retina = fakeWindow({ width: 2000, height: 1200 }, 2);
  const { invoke } = await fixture(t, { windowFor: () => retina.window });
  const result = (await invoke("designCanvas:capture", { x: 0, y: 0, width: 1600, height: 400 })) as {
    dataUrl: string;
  };
  assert.equal(DESIGN_CAPTURE_MAX_SIDE, 1024);
  assert.equal(result.dataUrl, "data:image/png;base64,1024x256");
  const small = (await invoke("designCanvas:capture", { x: 0, y: 0, width: 300, height: 200 })) as {
    dataUrl: string;
  };
  assert.equal(small.dataUrl, "data:image/png;base64,600x400", "a small capture is not scaled up or down");
});

test("an empty, off-window or malformed rectangle captures nothing", async (t) => {
  const page = fakeWindow({ width: 1000, height: 800 });
  const { invoke } = await fixture(t, { windowFor: () => page.window });
  for (const rect of [
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 1200, y: 0, width: 100, height: 100 },
    { x: 0, y: -500, width: 100, height: 100 },
    { x: Number.NaN, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: Infinity, height: 100 },
    "0,0,100,100",
    null,
  ]) {
    assert.deepEqual(await invoke("designCanvas:capture", rect), { error: "unavailable" }, JSON.stringify(rect));
  }
  assert.deepEqual(page.captured, []);
});

test("a capture with no window behind the sender, or with the flag off, is refused", async (t) => {
  const { invoke } = await fixture(t);
  assert.deepEqual(await invoke("designCanvas:capture", { x: 0, y: 0, width: 10, height: 10 }), {
    error: "unavailable",
  });
  const page = fakeWindow({ width: 1000, height: 800 });
  const later = await fixture(t, { windowFor: () => page.window });
  later.disable();
  await assert.rejects(
    later.invoke("designCanvas:capture", { x: 0, y: 0, width: 10, height: 10 }),
    /Design mode is not available/u,
  );
  assert.deepEqual(page.captured, []);
});

test("watching replaces the chat's watched set under its own workspace folder", async (t) => {
  const { invoke, watched } = await fixture(t);
  await invoke("designCanvas:watch", "chat-1", ["design/hero.html", "design/about.html"]);
  await invoke("designCanvas:watch", "chat-1", []);
  assert.deepEqual(watched, [
    ["chat-1", "/work/site", ["design/hero.html", "design/about.html"]],
    ["chat-1", "/work/site", []],
  ]);
});

test("a chat that cannot frame workspace files stops being watched", async (t) => {
  const { invoke, watched } = await fixture(t, {
    chats: {
      off: { id: "off", workspaceId: "workspace-1" },
      bot: { id: "bot", workspaceId: "workspace-1", designMode: true, botId: "bot-1" },
      loose: { id: "loose", workspaceId: "nowhere", designMode: true },
    },
  });
  for (const chatId of ["off", "bot", "loose"]) {
    await invoke("designCanvas:watch", chatId, ["design/hero.html"]);
  }
  assert.deepEqual(watched, [
    ["clear", "off"],
    ["clear", "bot"],
    ["clear", "loose"],
  ]);
});

test("watching rejects malformed arguments and refuses with the flag off", async (t) => {
  const { invoke, watched, disable } = await fixture(t);
  await assert.rejects(invoke("designCanvas:watch", "chat-1", "design/hero.html"));
  await assert.rejects(invoke("designCanvas:watch", "chat-1", [42]));
  await assert.rejects(invoke("designCanvas:watch", "../chat", []));
  disable();
  await assert.rejects(invoke("designCanvas:watch", "chat-1", []), /Design mode is not available/u);
  assert.deepEqual(watched, []);
});

async function pickWorkspace(t: TestContext) {
  const site = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-pick-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-outside-"));
  t.after(() => fs.rm(site, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(site, "design", "img"), { recursive: true });
  await fs.writeFile(path.join(site, "design", "hero page.html"), "<p>hi</p>");
  await fs.writeFile(path.join(site, "design", "img", "logo.png"), "png");
  await fs.writeFile(path.join(site, "notes.md"), "# notes");
  await fs.writeFile(path.join(outside, "secret.html"), "<p>secret</p>");
  await fs.symlink(path.join(outside, "secret.html"), path.join(site, "design", "link.html"));
  return { site, outside };
}

test("picking a file opens the dialog in the workspace and returns its relative path", async (t) => {
  const { site } = await pickWorkspace(t);
  let choice: string | null = path.join(site, "design", "hero page.html");
  const { invoke, dialogs } = await fixture(t, {
    roots: { "workspace-1": site },
    pickFile: async () => choice,
  });
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "file"), { path: "design/hero page.html" });
  assert.equal(dialogs[0]?.defaultPath, site);
  assert.equal(dialogs[0]?.kind, "file");
  choice = path.join(site, "design", "img", "logo.png");
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "image"), { path: "design/img/logo.png" });
  choice = null;
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "file"), { cancelled: true });
});

test("a picked file of the wrong type is unsupported", async (t) => {
  const { site } = await pickWorkspace(t);
  let choice = path.join(site, "design", "img", "logo.png");
  const { invoke } = await fixture(t, { roots: { "workspace-1": site }, pickFile: async () => choice });
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "file"), { error: "unsupported" });
  choice = path.join(site, "notes.md");
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "image"), { error: "unsupported" });
  choice = path.join(site, "design", "hero page.html");
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "image"), { error: "unsupported" });
});

test("a picked file outside the workspace, or linked from outside it, is refused", async (t) => {
  const { site, outside } = await pickWorkspace(t);
  let choice = path.join(outside, "secret.html");
  const { invoke } = await fixture(t, { roots: { "workspace-1": site }, pickFile: async () => choice });
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "file"), { error: "outside-workspace" });
  choice = path.join(site, "design", "link.html");
  assert.deepEqual(await invoke("designCanvas:pickFile", "chat-1", "file"), { error: "outside-workspace" });
});

test("a chat that cannot frame workspace files never opens the dialog", async (t) => {
  const { invoke, dialogs } = await fixture(t, {
    chats: { off: { id: "off", workspaceId: "workspace-1" } },
    pickFile: async () => "/work/site/a.html",
  });
  assert.deepEqual(await invoke("designCanvas:pickFile", "off", "file"), { error: "unavailable" });
  await assert.rejects(invoke("designCanvas:pickFile", "off", "video"));
  assert.deepEqual(dialogs, []);
});

/** A canvas with a workspace page, an image, an artifact and a note, saved for chat-1. */
async function exportCanvas(
  t: TestContext,
  options: Parameters<typeof fixture>[1] = {},
): Promise<Awaited<ReturnType<typeof fixture>> & { site: string; out: string }> {
  const { site } = await pickWorkspace(t);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-export-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const harness = await fixture(t, { roots: { "workspace-1": site }, ...options });
  const frame = { x: 0, y: 0, w: 640, h: 436, pageId: "page-1", createdBy: "person" as const };
  const doc: DesignCanvas = {
    ...emptyDesignCanvas(),
    frames: [
      { ...frame, id: "page", kind: "file", title: "Hero: Pricing", path: "design/hero page.html", designWidth: 768, paper: "a4", printMode: "fixed" },
      { ...frame, id: "logo", kind: "image", title: "logo.png", path: "design/img/logo.png" },
      { ...frame, id: "chart", kind: "artifact", title: "Sales chart", mediaId: "media-1" },
      { ...frame, id: "gone", kind: "file", title: "Gone", path: "design/missing.html" },
      { ...frame, id: "n", kind: "note", title: "Note", text: "hi" },
    ],
  };
  assert.deepEqual(await harness.invoke("designCanvas:save", "chat-1", doc, 0), { ok: true, revision: 1 });
  return { ...harness, site, out };
}

test("a page downloads as a PNG or a PDF drawn from its own address, with its paper and layout", async (t) => {
  let destination = "";
  const harness = await exportCanvas(t, { saveFile: () => destination });
  const { invoke, out, renders, saveDialogs, issuedGrants } = harness;
  destination = path.join(out, "hero.png");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "png"), { saved: true });
  assert.equal(saveDialogs[0]?.defaultPath, "Hero-Pricing.png");
  assert.deepEqual(saveDialogs[0]?.filters, [{ name: "PNG image", extensions: ["png"] }]);
  const grant = issuedGrants[issuedGrants.length - 1];
  assert.deepEqual(renders[0], {
    url: `aiden-design://${grant}/design/hero%20page.html`,
    width: 768,
    format: "png",
    paper: "a4",
    printMode: "fixed",
  });
  assert.equal(await fs.readFile(destination, "utf8"), `png:aiden-design://${grant}/design/hero%20page.html`);

  destination = path.join(out, "hero.pdf");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "pdf"), { saved: true });
  assert.equal(renders[1]?.format, "pdf");
  assert.ok((await fs.readFile(destination, "utf8")).startsWith("pdf:"));
});

test("the original file of a page or an image is copied as it is on disk", async (t) => {
  let destination = "";
  const { invoke, out, site, renders, saveDialogs } = await exportCanvas(t, { saveFile: () => destination });
  destination = path.join(out, "copy.html");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "source"), { saved: true });
  assert.equal(saveDialogs[0]?.defaultPath, "hero page.html");
  assert.deepEqual(
    await fs.readFile(destination),
    await fs.readFile(path.join(site, "design", "hero page.html")),
  );
  destination = path.join(out, "logo.png");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "logo", "source"), { saved: true });
  assert.deepEqual(await fs.readFile(destination), await fs.readFile(path.join(site, "design", "img", "logo.png")));
  assert.deepEqual(renders, [], "copying never draws the page");
});

test("an artifact downloads from its preview, and its original goes through the artifact export", async (t) => {
  let destination = "";
  const { invoke, out, renders, artifactExports, saveDialogs } = await exportCanvas(t, {
    saveFile: () => destination,
    artifacts: { "media-1": "aiden-genui://preview/abc" },
  });
  destination = path.join(out, "chart.png");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "chart", "png"), { saved: true });
  assert.deepEqual(renders[0], { url: "aiden-genui://preview/abc", width: 640, format: "png" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "chart", "source"), { saved: true });
  assert.deepEqual(artifactExports, ["chat-1/media-1"]);
  assert.equal(saveDialogs.length, 1, "the artifact export shows its own dialog");
});

test("a dark, tweaked page exports with its tweaks on its address, and only a dark artifact takes the canvas's theme", async (t) => {
  let destination = "";
  const harness = await exportCanvas(t, {
    saveFile: () => destination,
    artifacts: { "media-1": "aiden-genui://preview/abc" },
  });
  const { invoke, out, renders, artifactThemes, issuedGrants } = harness;
  destination = path.join(out, "x.png");
  const theme = { colorScheme: "dark", vars: {} };
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "chart", "png", theme), { saved: true });
  assert.deepEqual(artifactThemes, [undefined], "a light artifact keeps the default theme");

  const stored = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  const doc: DesignCanvas = {
    ...stored,
    frames: stored.frames.map((frame) =>
      frame.id === "page"
        ? { ...frame, dark: true, tweaks: { "--accent": "#ff0055", "data-density": "compact" } }
        : frame.id === "chart"
          ? { ...frame, dark: true }
          : frame,
    ),
  };
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", doc, stored.revision), { ok: true, revision: stored.revision + 1 });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "chart", "png", theme), { saved: true });
  assert.deepEqual(artifactThemes[1], theme);
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "png"), { saved: true });
  const url = new URL(renders[renders.length - 1]!.url.replace(/^aiden-design:/u, "https:"));
  assert.equal(renders[renders.length - 1]!.url.startsWith(`aiden-design://${issuedGrants[issuedGrants.length - 1]}/design/hero%20page.html?`), true);
  assert.equal(url.searchParams.get("aiden-dark"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("aiden-tweaks")!), {
    vars: { "--accent": "#ff0055" },
    attrs: { "data-density": "compact" },
  });
});

test("a plain text change is written into the page's file only where it is found once, and never through a link out", async (t) => {
  const { invoke, site } = await exportCanvas(t);
  const file = path.join(site, "design", "hero page.html");
  await fs.writeFile(file, "<h1>Hi</h1>\n<p>Hi</p>\n<p>Plan &amp; ship</p>\n");
  assert.deepEqual(
    await invoke("designCanvas:editText", "chat-1", "page", [{ before: "Plan & ship", after: "Plan, build & ship" }]),
    { ok: true },
  );
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Hi</h1>\n<p>Hi</p>\n<p>Plan, build &amp; ship</p>\n");
  assert.deepEqual(await invoke("designCanvas:editText", "chat-1", "page", [{ before: "Hi", after: "Hey" }]), {
    ok: false,
    reason: "ambiguous",
  });
  assert.deepEqual(
    await invoke("designCanvas:editText", "chat-1", "page", [{ before: "Hi", after: "Hey" }], "design/hero page.html:2"),
    { ok: true },
    "the element's stamp picks the line",
  );
  assert.equal(await fs.readFile(file, "utf8"), "<h1>Hi</h1>\n<p>Hey</p>\n<p>Plan, build &amp; ship</p>\n");

  assert.deepEqual(await invoke("designCanvas:editText", "chat-1", "n", [{ before: "hi", after: "yo" }]), {
    ok: false,
    reason: "unavailable",
  });
  await assert.rejects(invoke("designCanvas:editText", "chat-1", "page", [{ before: 1, after: "x" }]));
  await assert.rejects(invoke("designCanvas:editText", "chat-1", "page", []));

  // A frame whose file is a link out of the workspace is never written.
  const stored = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  const linked: DesignCanvas = {
    ...stored,
    frames: [...stored.frames, { ...stored.frames[0]!, id: "link", path: "design/link.html" }],
  };
  assert.deepEqual(await invoke("designCanvas:save", "chat-1", linked, stored.revision), { ok: true, revision: stored.revision + 1 });
  assert.deepEqual(await invoke("designCanvas:editText", "chat-1", "link", [{ before: "secret", after: "mine" }]), {
    ok: false,
    reason: "missing",
  });
});

test("make default writes a frame's values into its page, keeps words it can't place, and undoes only an untouched file", async (t) => {
  const { invoke, site } = await exportCanvas(t);
  const file = path.join(site, "design", "hero page.html");
  const page = `<html><head><script type="application/aiden-tweaks">[
  { "id": "radius", "type": "number", "min": 0, "max": 24, "unit": "px", "default": 8, "var": "--radius" },
  { "id": "title", "type": "text", "default": "Hi", "attr": "data-title" },
  { "id": "cta", "type": "text", "default": "Go", "attr": "data-cta" }
]</script></head><body><h1 data-aiden-text="title">Hi</h1><a data-aiden-text="cta"><i>Go</i></a><b>Go</b></body></html>`;
  await fs.writeFile(file, page);
  const values = { "--radius": "16px", "data-title": "Hello", "data-cta": "Start" };
  const bake = async (next: Record<string, string> | undefined) => {
    const answer = (await invoke("designCanvas:bakeTweaks", "chat-1", "page", next)) as {
      ok: boolean;
      written?: Record<string, string>;
      kept?: string[];
      undoId?: string;
    };
    if (answer.ok) assert.equal(typeof answer.undoId, "string");
    return answer;
  };
  const first = await bake(values);
  assert.deepEqual(first.kept, ["data-cta"]);
  assert.deepEqual(first.written, { "--radius": "16px", "data-title": "Hello" });
  const baked = await fs.readFile(file, "utf8");
  assert.match(baked, /<style data-aiden-tweaks>\n:root:root:root \{ --radius: 16px; \}/u);
  assert.match(baked, /<h1 data-aiden-text="title">Hello<\/h1>/u);
  assert.match(baked, /<a data-aiden-text="cta"><i>Go<\/i><\/a><b>Go<\/b>/u, "words that can't be placed stay for the frame to keep");
  assert.match(baked, /"default": "Go"/u, "and the file still says its old words");
  assert.doesNotMatch(baked, /data-cta=/u);
  assert.match(baked, /"default": 16/u);

  assert.deepEqual(await invoke("designCanvas:undoBakeTweaks", "chat-1", "page", first.undoId), { ok: true });
  assert.equal(await fs.readFile(file, "utf8"), page);
  assert.deepEqual(await invoke("designCanvas:undoBakeTweaks", "chat-1", "page", first.undoId), { ok: false, reason: "unchanged" }, "one undo per make default");

  // An older Make default's Undo leaves a later one alone; the later one's Undo still works.
  const older = await bake(values);
  const newer = await bake({ "--radius": "20px" });
  assert.match(await fs.readFile(file, "utf8"), /--radius: 20px;/u);
  assert.deepEqual(await invoke("designCanvas:undoBakeTweaks", "chat-1", "page", older.undoId), { ok: false, reason: "changed" });
  assert.match(await fs.readFile(file, "utf8"), /--radius: 20px;/u);
  assert.deepEqual(await invoke("designCanvas:undoBakeTweaks", "chat-1", "page", newer.undoId), { ok: true });
  assert.match(await fs.readFile(file, "utf8"), /--radius: 16px;/u);

  const again = await bake({ "--radius": "12px" });
  await fs.writeFile(file, `${await fs.readFile(file, "utf8")}<!-- edited -->`);
  assert.deepEqual(await invoke("designCanvas:undoBakeTweaks", "chat-1", "page", again.undoId), { ok: false, reason: "changed" }, "a file changed since is left alone");

  assert.deepEqual(await invoke("designCanvas:bakeTweaks", "chat-1", "page", undefined), { ok: false, reason: "unchanged" });
  await fs.writeFile(file, "<p>No tweaks here</p>");
  assert.deepEqual(await invoke("designCanvas:bakeTweaks", "chat-1", "page", values), { ok: false, reason: "not-found" });
  await assert.rejects(invoke("designCanvas:bakeTweaks", "chat-1", "page", { color: "red" }));
});

test("text edits of one page made at once all land in its file", async (t) => {
  const { invoke, site } = await exportCanvas(t);
  const file = path.join(site, "design", "hero page.html");
  const lines = Array.from({ length: 8 }, (_, index) => `<p>Line ${index} old</p>`);
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  const results = await Promise.all(
    lines.map((_, index) =>
      invoke("designCanvas:editText", "chat-1", "page", [{ before: `Line ${index} old`, after: `Line ${index} new` }]),
    ),
  );
  assert.deepEqual(results, lines.map(() => ({ ok: true })));
  assert.equal(
    await fs.readFile(file, "utf8"),
    `${lines.map((_, index) => `<p>Line ${index} new</p>`).join("\n")}\n`,
    "no edit overwrote another",
  );
});

test("nothing is saved when the dialog is cancelled, the file is gone, or drawing fails", async (t) => {
  let destination: string | null = null;
  const { invoke, out, renders } = await exportCanvas(t, {
    saveFile: () => destination,
    renderFrame: async () => {
      throw new Error("crashed");
    },
  });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "png"), { canceled: true });
  assert.deepEqual(renders, [], "a cancelled dialog draws nothing");
  destination = path.join(out, "x.png");
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "gone", "png"), { error: "missing" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "chart", "pdf"), { error: "missing" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "png"), { error: "failed" });
  await assert.rejects(fs.access(destination));
});

test("only a frame the stored canvas holds exports, and only in the formats its kind has", async (t) => {
  const { invoke, saveDialogs, chats } = await exportCanvas(t, { saveFile: () => "/nowhere" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "n", "png"), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "logo", "pdf"), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "nope", "png"), { error: "unavailable" });
  await assert.rejects(invoke("designCanvas:export", "chat-1", "page", "svg"));
  await assert.rejects(invoke("designCanvas:export", "chat-1", 7, "png"));
  // Out of design mode the workspace may no longer be framed, so its files stay put.
  chats["chat-1"] = { id: "chat-1", workspaceId: "workspace-1" };
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "page", "source"), { error: "unavailable" });
  assert.deepEqual(saveDialogs, []);
});

test("another chat's visual on the shared canvas previews, exports and shows its code through that chat, while it shares the workspace", async (t) => {
  let destination = "";
  const harness = await exportCanvas(t, {
    chats: {
      "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
      "chat-a": { id: "chat-a", workspaceId: "workspace-1" },
      "chat-x": { id: "chat-x", workspaceId: "workspace-2" },
      routine: { id: "routine", workspaceId: "workspace-1", owner: { kind: "routine", id: "r1" } as never },
    },
    saveFile: () => destination,
    artifacts: { "media-1": "aiden-genui://preview/abc" },
    artifactHtml: { "media-1": "<svg>chart</svg>" },
  });
  const { invoke, out, store, artifactReads, artifactExports } = harness;
  destination = path.join(out, "chart.png");
  const box = { x: 0, y: 0, w: 640, h: 436, pageId: "page-1", createdBy: "aiden" as const, kind: "artifact" as const, mediaId: "media-1" };
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      ...doc.frames,
      { ...box, id: "a-chart", title: "A's chart", chatId: "chat-a" },
      { ...box, id: "x-chart", title: "Moved chat's chart", chatId: "chat-x" },
      { ...box, id: "gone-chart", title: "Deleted chat's chart", chatId: "chat-deleted" },
      { ...box, id: "routine-chart", title: "A routine's chart", chatId: "routine" },
    ],
  }));

  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "a-chart", "png"), { saved: true });
  assert.deepEqual(await invoke("designCanvas:export", "chat-1", "a-chart", "source"), { saved: true });
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "a-chart"), { text: "<svg>chart</svg>", truncated: false });
  assert.deepEqual(artifactReads, ["preview chat-a/media-1", "html chat-a/media-1"]);
  assert.deepEqual(artifactExports, ["chat-a/media-1"]);

  // A chat now in another workspace, or deleted, no longer lends its visuals to this canvas,
  // and a routine's never does, even in the same workspace.
  for (const frameId of ["x-chart", "gone-chart", "routine-chart"]) {
    assert.deepEqual(await invoke("designCanvas:export", "chat-1", frameId, "png"), { error: "unavailable" });
    assert.deepEqual(await invoke("designCanvas:export", "chat-1", frameId, "source"), { error: "unavailable" });
    assert.deepEqual(await invoke("designCanvas:source", "chat-1", frameId), { error: "unavailable" });
  }
  assert.equal(artifactReads.length, 2, "nothing was read for them");
  assert.equal(artifactExports.length, 1);
});

test("the Code tab reads a page's file or an artifact's HTML, cut at 512 KiB, and nothing else", async (t) => {
  const harness = await exportCanvas(t, { artifactHtml: { "media-1": "<svg>chart</svg>" } });
  const { invoke, site } = harness;
  const page = path.join(site, "design/hero page.html");
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "page"), {
    text: await fs.readFile(page, "utf8"),
    truncated: false,
  });
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "chart"), { text: "<svg>chart</svg>", truncated: false });
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "gone"), { error: "missing" });
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "n"), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:source", "chat-1", "nowhere"), { error: "unavailable" });
  await assert.rejects(invoke("designCanvas:source", "chat-1", ""), /Invalid design frame/);

  await fs.writeFile(page, "a".repeat(DESIGN_SOURCE_MAX_BYTES + 10));
  const big = (await invoke("designCanvas:source", "chat-1", "page")) as { text: string; truncated: boolean };
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, DESIGN_SOURCE_MAX_BYTES);
});

test("Send to canvas puts a chat visual on the chat's page as the person's frame, once", async (t) => {
  const { invoke, broadcasts, focusSent } = await fixture(t, {
    // Not in design mode yet: the person's action turns it on after the frame lands.
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
    artifactTitles: { "media-1": "  Revenue mockup  " },
    artifactHtml: { "media-1": "<main><h1>Revenue</h1></main>" },
  });
  const placed = (await invoke("designCanvas:placeArtifact", "chat-1", "media-1")) as DesignCanvasPlaceArtifactResult;
  assert.deepEqual(placed, { status: "placed", frameId: "placed-1" });
  // Announced as the person's own step, so an open canvas can undo it.
  assert.deepEqual(broadcasts, [{ workspaceId: "workspace-1", chatId: "chat-1", revision: 1, step: "send-to-canvas:1" }]);
  const doc = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  const frame = doc.frames.find((entry) => entry.id === "placed-1");
  assert.ok(frame);
  assert.equal(frame.kind, "artifact");
  assert.equal(frame.title, "Revenue mockup");
  assert.equal(frame.createdBy, "person");
  assert.equal(frame.pageId, "page-1");
  assert.equal(frame.chatId, "chat-1", "the frame names the chat whose visual it shows");
  assert.ok(frame.kind === "artifact" && frame.mediaId === "media-1");

  // Sending it again shows the frame already there and changes nothing.
  assert.deepEqual(await invoke("designCanvas:placeArtifact", "chat-1", "media-1"), {
    status: "already",
    frameId: "placed-1",
  });
  assert.equal(broadcasts.length, 1);
  assert.equal(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).revision, 1);
  assert.deepEqual(focusSent.map((sent) => sent.request), [], "the frame is already on the page on screen");
});

test("Send to canvas lands on the chat's view page", async (t) => {
  const { invoke, store, views } = await fixture(t, {
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
    artifactTitles: { "media-1": "Chart" },
    artifactHtml: { "media-1": "<p>chart</p>" },
  });
  await store.update("chat-1", (current) => ({ ...current, pages: [...current.pages, { id: "page-2", name: "Ideas" }] }));
  await views.report("chat-1", "workspace-1", { pageId: "page-2", viewport: { x: 0, y: 0, zoom: 1 } }, 0);
  await invoke("designCanvas:placeArtifact", "chat-1", "media-1");
  const doc = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  assert.equal(doc.frames[0]?.pageId, "page-2");
});

test("Send to canvas centres a visual in the canvas the person sees, and focuses the page a sent visual is already on without changing the document", async (t) => {
  const marker = { id: "window" };
  const { invoke, invokeFrom, store, views, broadcasts, focusSent } = await fixture(t, {
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
    artifactTitles: { "media-1": "Wide", "media-2": "Default" },
    artifactHtml: { "media-1": "<p>wide</p>", "media-2": "<p>default</p>" },
  });
  // A 3000 x 2000 canvas on screen at zoom 1: the frame lands in its middle.
  await invoke("designCanvas:placeArtifact", "chat-1", "media-1", { viewSize: { w: 3000, h: 2000 } });
  // A size that does not parse is ignored, not refused.
  await invoke("designCanvas:placeArtifact", "chat-1", "media-2", { viewSize: { w: -5, h: "tall" } });
  let doc = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  const wide = doc.frames.find((frame) => frame.kind === "artifact" && frame.mediaId === "media-1");
  assert.ok(wide);
  assert.deepEqual([wide.x + wide.w / 2, wide.y + wide.h / 2], [1500, 1000]);
  assert.ok(doc.frames.some((frame) => frame.kind === "artifact" && frame.mediaId === "media-2"));

  // The person moves to another page; sending the visual again takes them back to it.
  await store.update("chat-1", (current) => ({ ...current, pages: [...current.pages, { id: "page-2", name: "Ideas" }] }));
  await views.report("chat-1", "workspace-1", { pageId: "page-2", viewport: { x: 0, y: 0, zoom: 1 } }, 0);
  const revision = ((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).revision;
  const before = broadcasts.length;
  assert.deepEqual(await invokeFrom(marker, "designCanvas:placeArtifact", "chat-1", "media-1"), {
    status: "already",
    frameId: wide.id,
    page: "Page 1",
  });
  doc = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
  assert.equal(doc.revision, revision, "the shared document is not changed");
  assert.equal(doc.frames.length, 2, "nothing new is placed");
  assert.equal(broadcasts.length, before, "nothing to announce");
  assert.deepEqual(focusSent, [{ event: marker, request: { chatId: "chat-1", pageId: "page-1", frameIds: [wide.id], focusId: 1 } }]);
  assert.equal((await views.get("chat-1", "workspace-1"))?.pageId, "page-1", "the chat's view is on that page at once");
});

test("Send to canvas refuses a visual the chat no longer has, or HTML that fails the visual checks", async (t) => {
  const { invoke, broadcasts } = await fixture(t, {
    artifactTitles: { "media-1": "Gone", "media-2": "Remote image" },
    artifactHtml: { "media-2": '<img src="https://evil.test/x.png">' },
  });
  assert.deepEqual(await invoke("designCanvas:placeArtifact", "chat-1", "media-1"), { error: "missing" });
  assert.deepEqual(await invoke("designCanvas:placeArtifact", "chat-1", "media-9"), { error: "missing" });
  assert.deepEqual(await invoke("designCanvas:placeArtifact", "chat-1", "media-2"), { error: "unsafe" });
  await assert.rejects(invoke("designCanvas:placeArtifact", "chat-1", "../media"), /Invalid visual/u);
  await assert.rejects(invoke("designCanvas:placeArtifact", "chat-1", 7), /Invalid visual/u);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(((await invoke("designCanvas:get", "chat-1")) as DesignCanvas).frames, []);
});

test("Send to canvas is refused in a Bot or routine chat and reports a full canvas", async (t) => {
  const { invoke, store } = await fixture(t, {
    chats: {
      "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
      bot: { id: "bot", workspaceId: "workspace-1", designMode: true, botId: "bot-1" },
      routine: { id: "routine", workspaceId: "workspace-1", designMode: true, owner: { kind: "routine" } as unknown as DesignCanvasChat["owner"] },
    },
    artifactTitles: { "media-1": "Chart" },
    artifactHtml: { "media-1": "<p>chart</p>" },
  });
  await assert.rejects(invoke("designCanvas:placeArtifact", "bot", "media-1"), /not available/u);
  await assert.rejects(invoke("designCanvas:placeArtifact", "routine", "media-1"), /not available/u);
  await assert.rejects(invoke("designCanvas:placeArtifact", "missing-chat", "media-1"), /no longer available/u);

  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: Array.from({ length: 400 }, (_, index) => ({
      id: `n${index}`,
      kind: "note" as const,
      title: "Note",
      x: index * 10,
      y: 0,
      w: 200,
      h: 120,
      text: "",
      pageId: doc.pages[0]!.id,
      createdBy: "person" as const,
    })),
  }));
  assert.deepEqual(await invoke("designCanvas:placeArtifact", "chat-1", "media-1"), { error: "full" });
});

/** A workspace folder holding the linter's valid fixture as its DESIGN.md, with an `apps/web` folder. */
async function designMdWorkspace(t: TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-md-ipc-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const valid = await fs.readFile(new URL("../services/design-canvas/design-md/fixtures/valid.md", import.meta.url), "utf8");
  await fs.writeFile(path.join(workspace, "DESIGN.md"), valid);
  await fs.mkdir(path.join(workspace, "apps", "web"), { recursive: true });
  return workspace;
}

/** A listing of every file under `folder` with its size and mtime, to show nothing was written. */
async function listing(folder: string): Promise<string[]> {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.map(async (entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const info = await fs.stat(full);
      return `${path.relative(folder, full)} ${info.size} ${info.mtimeMs}`;
    }),
  ).then((rows) => rows.sort());
}

function designMdDeps(options: { live?: () => boolean; events?: unknown[] } = {}) {
  return {
    enabled: options.live ?? (() => true),
    reader: new DesignMdReader({ report: (event, props) => options.events?.push({ event, props }) }),
    appRoots: async () => ({ roots: ["."], more: 0 }),
  };
}

test("designSystem answers for an attended workspace chat with the flag on", async (t) => {
  const workspace = await designMdWorkspace(t);
  const { invoke } = await fixture(t, { roots: { "workspace-1": workspace }, designMd: designMdDeps() });
  const answer = (await invoke("designCanvas:designSystem", { chatId: "chat-1" })) as Record<string, any>;
  assert.equal(answer.status, "ok");
  assert.equal(answer.path, "DESIGN.md");
  assert.equal(answer.appRoot, ".");
  assert.equal(answer.summary.errors, 0);
  assert.equal(answer.sections[0], "Overview");
  assert.ok(Array.isArray(answer.findings) && answer.findings.length <= 50);
  const nested = (await invoke("designCanvas:designSystem", { chatId: "chat-1", appRoot: "apps/web" })) as Record<string, any>;
  assert.equal(nested.status, "ok");
  assert.equal(nested.appRoot, "apps/web");
  assert.equal(nested.path, "DESIGN.md", "an app without its own DESIGN.md uses the workspace's");
});

test("designSystem refuses with the flag off, for an unknown, Bot, owner or folderless chat, and for an unsafe appRoot", async (t) => {
  const workspace = await designMdWorkspace(t);
  let live = false;
  const { invoke } = await fixture(t, {
    chats: {
      "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true },
      bot: { id: "bot", workspaceId: "workspace-1", designMode: true, botId: "bot-1" },
      owned: { id: "owned", workspaceId: "workspace-1", owner: { kind: "routine" } as unknown as DesignCanvasChat["owner"] },
      folderless: { id: "folderless", workspaceId: "workspace-2", designMode: true },
    },
    roots: { "workspace-1": workspace, "workspace-2": null },
    designMd: designMdDeps({ live: () => live }),
  });
  const unavailable = { error: "unavailable" };
  assert.deepEqual(await invoke("designCanvas:designSystem", { chatId: "chat-1" }), unavailable, "the live flag is off");
  live = true;
  for (const chatId of ["missing", "bot", "owned", "folderless"]) {
    assert.deepEqual(await invoke("designCanvas:designSystem", { chatId }), unavailable, chatId);
  }
  for (const appRoot of ["../outside", "/etc", "apps/missing", "DESIGN.md", 'a"b', 7]) {
    assert.deepEqual(await invoke("designCanvas:designSystem", { chatId: "chat-1", appRoot }), unavailable, String(appRoot));
  }
  for (const request of [null, "chat-1", [], { chatId: 3 }]) {
    await assert.rejects(Promise.resolve().then(() => invoke("designCanvas:designSystem", request)), /Invalid|chat/iu);
  }
});

test("designSystem works with design mode off, writes nothing, and sends no analytics event", async (t) => {
  const workspace = await designMdWorkspace(t);
  const events: unknown[] = [];
  const { invoke } = await fixture(t, {
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
    roots: { "workspace-1": workspace },
    designMd: designMdDeps({ events }),
  });
  const before = await listing(workspace);
  const answer = (await invoke("designCanvas:designSystem", { chatId: "chat-1" })) as Record<string, any>;
  assert.equal(answer.status, "ok");
  assert.deepEqual(await listing(workspace), before);
  assert.deepEqual(events, []);
});

// ---- designCanvas:appFrameMount (design mode v2 Phase 3a, D2, D16) ----

const MOUNT_TOKEN = "abcdefghijklmnop";
const appPage: DesignCanvas = {
  ...emptyDesignCanvas(),
  frames: [
    ...note.frames,
    {
      id: "app-1",
      kind: "app",
      title: "Pricing",
      appRoot: "web",
      route: "/pricing",
      viewport: { width: 1280, height: 800 },
      scale: 0.5,
      x: 0,
      y: 0,
      w: 640,
      h: 436,
      pageId: "page-1",
      createdBy: "aiden",
    },
  ],
};

function appStatus(workspaceId: string, appRoot: string, phase: DesignAppStatus["phase"], origin?: string): DesignAppStatus {
  return { workspaceId, appRoot, source: "started", frameworkLabel: "Vite", phase, since: 0, revision: 1, ...(origin ? { origin, port: Number(new URL(origin).port) } : {}) };
}

async function mountFixture(
  t: TestContext,
  options: {
    live?: boolean;
    apps?: DesignAppStatus[];
    owners?: Record<string, { workspaceId: string; appRoot: string }>;
    cap?: number;
    saveFile?: (options: DesignCanvasSaveOptions) => string | null;
    page?: DesignCanvas;
    chats?: Record<string, DesignCanvasChat>;
    /** Runs while main awaits the app snapshot. */
    onSnapshot?: () => void;
    /** Main's wait for a pending service-worker clear of an origin (S76). */
    clearSettled?: (origin: string) => Promise<void>;
  } = {},
) {
  const registry = new AppFrameRegistry({ mainContents: () => ({}), liveIds: () => new Set<number>(), cap: options.cap });
  const snapshots: string[] = [];
  const appRenders: DesignAppRenderRequest[] = [];
  const result = await fixture(t, {
    ...(options.saveFile ? { saveFile: options.saveFile } : {}),
    ...(options.chats ? { chats: options.chats } : {}),
    appFrames: {
      renderApp: async (request) => {
        appRenders.push(request);
        return new TextEncoder().encode(`${request.format}:${request.url}`);
      },
      enabled: () => options.live ?? true,
      registry: () => registry,
      ...(options.clearSettled ? { clearSettled: options.clearSettled } : {}),
      apps: {
        snapshot: async (workspaceId): Promise<DesignAppsSnapshot> => {
          snapshots.push(workspaceId);
          options.onSnapshot?.();
          return {
            workspaceId,
            target: "single",
            apps: (options.apps ?? []).filter((app) => app.workspaceId === workspaceId),
            candidates: [],
            chosen: [],
          };
        },
        appForOrigin: (origin) => options.owners?.[origin],
      },
    },
  });
  await result.invoke("designCanvas:save", "chat-1", options.page ?? appPage, 0);
  return { ...result, registry, snapshots, appRenders };
}

const RUNNING = "http://127.0.0.1:5173";

test("appFrameMount with live apps off answers live-off and records nothing", async (t) => {
  const { invoke, snapshots } = await mountFixture(t, { live: false, apps: [appStatus("workspace-1", "web", "running", RUNNING)] });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "live-off" });
  assert.deepEqual(snapshots, []);
});

test("appFrameMount for a frame that isn't an app frame, or a bad token, is unavailable", async (t) => {
  const { invoke } = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "running", RUNNING)] });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "n", mountToken: MOUNT_TOKEN }), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "gone", mountToken: MOUNT_TOKEN }), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: "short" }), { error: "unavailable" });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", null), { error: "unavailable" });
});

test("appFrameMount needs the frame's app root running in the chat's own workspace", async (t) => {
  const stopped = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "starting")] });
  assert.deepEqual(await stopped.invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "app-not-running" });

  const elsewhere = await mountFixture(t, {
    apps: [appStatus("workspace-2", "web", "running", RUNNING), appStatus("workspace-1", "site", "running", "http://127.0.0.1:5174")],
    owners: { [RUNNING]: { workspaceId: "workspace-2", appRoot: "web" } },
  });
  assert.deepEqual(await elsewhere.invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "app-not-running" });
  assert.deepEqual(elsewhere.snapshots, ["workspace-1"]);
});

test("appFrameMount waits for a pending service-worker clear of the app's origin before the frame may load", async (t) => {
  let release!: () => void;
  const clearing = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  let waited!: () => void;
  const waiting = new Promise<void>((resolve) => (waited = resolve));
  const { invoke, registry } = await mountFixture(t, {
    apps: [appStatus("workspace-1", "web", "running", RUNNING)],
    owners: { [RUNNING]: { workspaceId: "workspace-1", appRoot: "web" } },
    clearSettled: (origin) => {
      asked.push(origin);
      waited();
      return clearing;
    },
  });
  let reply: unknown;
  const mounting = invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }).then((value) => (reply = value));
  await Promise.race([waiting, mounting]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [RUNNING]);
  assert.equal(reply, undefined, "the renderer gets no origin while the clear runs, so the iframe doesn't load");
  const navigation = {
    frame: { frameTreeNodeId: 7, name: `aiden-app:app-1:${MOUNT_TOKEN}`, url: "about:blank" },
    targetUrl: `${RUNNING}/pricing`,
    isDirectChild: true,
    initiator: "main-frame" as const,
    designFrame: false,
  };
  assert.equal(registry.admit(navigation), "refused", "and no placement is waiting to admit it");
  release();
  await mounting;
  assert.deepEqual(reply, { origin: RUNNING });
  assert.equal(registry.admit(navigation), "app");
});

test("appFrameMount refuses a running entry whose origin main can't tie to that app (a lost holder)", async (t) => {
  const { invoke } = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "running", RUNNING)], owners: {} });
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "app-not-running" });
});

test("appFrameMount answers the app's origin and leaves a record the registry admits once, ignoring any url in the payload", async (t) => {
  const { invoke, registry } = await mountFixture(t, {
    apps: [appStatus("workspace-1", "web", "running", RUNNING)],
    owners: { [RUNNING]: { workspaceId: "workspace-1", appRoot: "web" } },
  });
  const reply = await invoke("designCanvas:appFrameMount", "chat-1", {
    frameId: "app-1",
    mountToken: MOUNT_TOKEN,
    url: "http://127.0.0.1:9999/",
    origin: "http://127.0.0.1:9999",
  });
  assert.deepEqual(reply, { origin: RUNNING });
  const navigation = (targetUrl: string) => ({
    frame: { frameTreeNodeId: 7, name: `aiden-app:app-1:${MOUNT_TOKEN}`, url: "about:blank" },
    targetUrl,
    isDirectChild: true,
    initiator: "main-frame" as const,
    designFrame: false,
  });
  assert.equal(registry.admit(navigation("http://127.0.0.1:9999/")), "refused", "the payload's origin is never the expected one");
  await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN });
  assert.equal(registry.admit(navigation(`${RUNNING}/pricing`)), "app");
});

test("appFrameMount needs design mode on, before and after it looks for the app", async (t) => {
  const admitted = (registry: AppFrameRegistry) =>
    registry.admit({
      frame: { frameTreeNodeId: 7, name: `aiden-app:app-1:${MOUNT_TOKEN}`, url: "about:blank" },
      targetUrl: `${RUNNING}/pricing`,
      isDirectChild: true,
      initiator: "main-frame",
      designFrame: false,
    });
  const apps = [appStatus("workspace-1", "web", "running", RUNNING)];
  const off = await mountFixture(t, {
    apps,
    owners: WEB_OWNER,
    chats: { "chat-1": { id: "chat-1", workspaceId: "workspace-1" } },
  });
  assert.deepEqual(await off.invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "unavailable" });
  assert.equal(admitted(off.registry), "refused", "no placement was recorded");

  const chats: Record<string, DesignCanvasChat> = { "chat-1": { id: "chat-1", workspaceId: "workspace-1", designMode: true } };
  const turnedOff = await mountFixture(t, {
    apps,
    owners: WEB_OWNER,
    chats,
    onSnapshot: () => {
      chats["chat-1"] = { id: "chat-1", workspaceId: "workspace-1" };
    },
  });
  assert.deepEqual(await turnedOff.invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "unavailable" });
  assert.equal(admitted(turnedOff.registry), "refused", "turned off while main looked: no placement");

  const moved = await mountFixture(t, {
    apps,
    owners: WEB_OWNER,
    chats,
    onSnapshot: () => {
      chats["chat-1"] = { id: "chat-1", workspaceId: "workspace-2", designMode: true };
    },
  });
  chats["chat-1"] = { id: "chat-1", workspaceId: "workspace-1", designMode: true };
  assert.deepEqual(await moved.invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "unavailable" });
  assert.equal(admitted(moved.registry), "refused", "the chat moved to another workspace while main looked");
});

test("appFrameMount with a full registry answers too-many-frames", async (t) => {
  const { invoke, registry } = await mountFixture(t, {
    apps: [appStatus("workspace-1", "web", "running", RUNNING)],
    owners: { [RUNNING]: { workspaceId: "workspace-1", appRoot: "web" } },
    cap: 0,
  });
  assert.equal(registry.expectPlacement({ frameId: "x", mountToken: MOUNT_TOKEN, expectedOrigin: RUNNING }), "too-many-frames");
  assert.deepEqual(await invoke("designCanvas:appFrameMount", "chat-1", { frameId: "app-1", mountToken: MOUNT_TOKEN }), { error: "too-many-frames" });
});

// ---- Export of live app frames (design mode v2 Phase 3a, D18, S73) ----------

const WEB_OWNER = { [RUNNING]: { workspaceId: "workspace-1", appRoot: "web" } };

test("an app frame's PNG is drawn from its running app at its viewport and scheme, then written where the person chose", async (t) => {
  const darkPage: DesignCanvas = { ...appPage, frames: appPage.frames.map((frame) => (frame.id === "app-1" ? { ...frame, colorScheme: "dark" as const } : frame)) };
  let target = "";
  const s = await mountFixture(t, {
    apps: [appStatus("workspace-1", "web", "running", RUNNING)],
    owners: WEB_OWNER,
    saveFile: () => target,
    page: darkPage,
  });
  target = path.join(s.root, "pricing.png");
  assert.deepEqual(await s.invoke("designCanvas:export", "chat-1", "app-1", "png"), { saved: true });
  assert.deepEqual(s.appRenders, [{ url: `${RUNNING}/pricing`, origin: RUNNING, width: 1280, height: 800, format: "png", colorScheme: "dark" }]);
  assert.equal(await fs.readFile(path.join(s.root, "pricing.png"), "utf8"), `png:${RUNNING}/pricing`);
  assert.deepEqual(s.renders, [], "file and artifact rendering isn't used");
  assert.equal(s.saveDialogs.length, 1);
  target = path.join(s.root, "pricing.pdf");
  assert.deepEqual(await s.invoke("designCanvas:export", "chat-1", "app-1", "pdf"), { saved: true });
  assert.equal(s.appRenders[1]?.format, "pdf");
  assert.equal(await fs.readFile(target, "utf8"), `pdf:${RUNNING}/pricing`);
});

test("an app frame whose app isn't running here answers app-not-running before any Save dialog", async (t) => {
  const elsewhere = await mountFixture(t, {
    apps: [appStatus("workspace-2", "web", "running", RUNNING)],
    owners: { [RUNNING]: { workspaceId: "workspace-2", appRoot: "web" } },
    saveFile: () => "/never",
  });
  assert.deepEqual(await elsewhere.invoke("designCanvas:export", "chat-1", "app-1", "png"), { error: "app-not-running" });
  const stopped = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "starting")], saveFile: () => "/never" });
  assert.deepEqual(await stopped.invoke("designCanvas:export", "chat-1", "app-1", "pdf"), { error: "app-not-running" });
  const lost = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "running", RUNNING)], owners: {}, saveFile: () => "/never" });
  assert.deepEqual(await lost.invoke("designCanvas:export", "chat-1", "app-1", "png"), { error: "app-not-running" });
  for (const s of [elsewhere, stopped, lost]) {
    assert.deepEqual(s.saveDialogs, [], "saveFile was never called");
    assert.deepEqual(s.appRenders, []);
  }
});

test("an app that stops while the Save dialog is open is never drawn", async (t) => {
  const apps = [appStatus("workspace-1", "web", "running", RUNNING)];
  const s = await mountFixture(t, {
    apps,
    owners: WEB_OWNER,
    saveFile: () => {
      // The person takes a while to choose; meanwhile the app stops.
      apps.length = 0;
      return path.join(s.root, "pricing.png");
    },
  });
  assert.deepEqual(await s.invoke("designCanvas:export", "chat-1", "app-1", "png"), { error: "app-not-running" });
  assert.deepEqual(s.appRenders, []);
  await assert.rejects(fs.access(path.join(s.root, "pricing.png")), "nothing was written");
});

test("with live apps off an app frame answers live-off, and its source is unavailable either way", async (t) => {
  const off = await mountFixture(t, { live: false, apps: [appStatus("workspace-1", "web", "running", RUNNING)], owners: WEB_OWNER, saveFile: () => "/never" });
  assert.deepEqual(await off.invoke("designCanvas:export", "chat-1", "app-1", "png"), { error: "live-off" });
  assert.deepEqual(off.saveDialogs, []);
  const on = await mountFixture(t, { apps: [appStatus("workspace-1", "web", "running", RUNNING)], owners: WEB_OWNER, saveFile: () => "/never" });
  assert.deepEqual(await on.invoke("designCanvas:export", "chat-1", "app-1", "source"), { error: "unavailable" });
  assert.deepEqual(await on.invoke("designCanvas:source", "chat-1", "app-1"), { error: "unavailable" });
  assert.deepEqual(on.saveDialogs, []);
});
