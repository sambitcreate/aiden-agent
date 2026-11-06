import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvas,
} from "../../renderer/shared/design-canvas/schema.js";
import { DesignGrantRegistry } from "../services/design-canvas/grants.js";
import { DesignCanvasStore } from "../services/design-canvas/store.js";
import {
  DESIGN_CAPTURE_MAX_SIDE,
  DESIGN_SOURCE_MAX_BYTES,
  registerDesignCanvasHandlers,
  type DesignCanvasCaptureImage,
  type DesignCanvasCaptureWindow,
  type DesignCanvasChat,
  type DesignCanvasPickOptions,
  type DesignCanvasSaveOptions,
  type DesignCanvasUpdated,
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
  const watched: Array<[string, string, string[]] | ["clear", string]> = [];
  const dialogs: DesignCanvasPickOptions[] = [];
  const saveDialogs: DesignCanvasSaveOptions[] = [];
  const renders: DesignFrameRenderRequest[] = [];
  const artifactExports: string[] = [];
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
    artifactPreview: async (_chatId, mediaId, theme) => {
      artifactThemes.push(theme);
      const src = options.artifacts?.[mediaId];
      return src ? { src } : undefined;
    },
    artifactHtml: async (_chatId, mediaId) => options.artifactHtml?.[mediaId],
    exportArtifactSource: async (_event, chatId, mediaId) => {
      artifactExports.push(`${chatId}/${mediaId}`);
      return { saved: true, canceled: false };
    },
  });
  const invokeFrom = async (event: unknown, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} is not registered`);
    return handler(event, ...args);
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom({}, channel, ...args);
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
    invokeFrom,
    watched,
    dialogs,
    saveDialogs,
    renders,
    artifactExports,
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
  assert.deepEqual(broadcasts, [{ chatId: "chat-1", revision: 1 }]);
  const stored = (await invoke("designCanvas:get", "chat-1")) as DesignCanvas;
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
