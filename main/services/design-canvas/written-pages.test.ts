import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appRouteKey, DESIGN_CANVAS_LIMITS, emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import {
  createDesignPageScanner,
  createWrittenRouteTurn,
  DESIGN_WIDTH_HINT_BYTES,
  EARLIER_PAGES_LIMIT,
  inferDesignWidth,
  readDesignWidthHint,
  RECENT_WRITTEN_PAGES_LIMIT,
  RecentWrittenPages,
  pagesWrittenInChat,
  placeWrittenPageFrames,
  placeWrittenPagesOnCanvas,
  writtenAppRoute,
  writtenPagePath,
  writtenRouteData,
} from "./written-pages.js";
import type { DesignViewState } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import type { DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import { DesignCanvasStore, DesignChatCanvases } from "./store.js";
import { DesignCanvasViews, designTurnPages } from "./views.js";
import { placeArtifactsOnCanvas } from "./artifact-frames.js";
import { createDesignEntry } from "./entry.js";
import { createDesignTitleFollow } from "./title-follow.js";
import { PendingEntries } from "./written-pages.js";

const ids = () => {
  let next = 0;
  return () => `frame-${++next}`;
};

function canvas(frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), frames };
}

const onPage = (pageId: string): DesignChatView => ({ pageId, viewport: { x: 0, y: 0, zoom: 1 } });

/**
 * Canvases under `root`: chat-1 and chat-2 share workspace ws-1, any other
 * chat has a workspace of its own name, and "deleted-chat" is gone.
 */
function canvasesAt(root: string) {
  const workspaceStore = new DesignCanvasStore({ root: () => root });
  const workspaceOf = (chatId: string) => (chatId === "deleted-chat" ? null : chatId === "chat-1" || chatId === "chat-2" ? "ws-1" : chatId);
  const store = new DesignChatCanvases({ store: workspaceStore, workspaceIdOf: async (chatId) => workspaceOf(chatId) });
  const views = new DesignCanvasViews();
  const pages = (chatId: string, message?: DesignViewState) => designTurnPages({ views, chatId, ...(message ? { message } : {}) });
  /** What a placement for `chatId` reaches the canvas through. */
  const via = (chatId: string, message?: DesignViewState) => ({ chatId, store, pages: pages(chatId, message) });
  return { workspaceStore, store, views, pages, via };
}

const produced = (relativePath: string, operation: "written" | "edited" = "written") => ({
  kind: "file_line_changes",
  version: 1,
  additions: 3,
  deletions: 0,
  producedFile: { relativePath, operation, bytes: 120 },
});

test("only a first-party write or edit of a visible HTML page counts as a written page", () => {
  assert.equal(writtenPagePath("write_file", produced("design/home.html")), "design/home.html");
  assert.equal(writtenPagePath("edit_file", produced("design/Pricing.HTM", "edited")), "design/Pricing.HTM");
  assert.equal(writtenPagePath("write_file", produced("design/parsely.css")), undefined, "a stylesheet is not a page");
  assert.equal(writtenPagePath("write_file", produced(".agent/preview.html")), undefined, "hidden folders stay off the canvas");
  assert.equal(writtenPagePath("write_file", produced("node_modules/pkg/index.html")), undefined);
  assert.equal(writtenPagePath("write_file", produced("design/node_modules/pkg/index.html")), undefined);
  assert.equal(writtenPagePath("write_file", produced("index.html")), undefined, "a page outside design/ is not a design page");
  assert.equal(writtenPagePath("write_file", produced("site/design/home.html")), undefined, "design/ means the workspace's own design folder");
  assert.equal(writtenPagePath("write_file", produced("design/flows/checkout.html")), "design/flows/checkout.html");
  assert.equal(writtenPagePath("run_command", produced("design/home.html")), undefined, "only file tools report what they wrote");
  assert.equal(
    writtenPagePath("edit_file", produced("design/home.html", "written")),
    undefined,
    "the operation must match the tool",
  );
  assert.equal(writtenPagePath("write_file", { kind: "file_line_changes" }), undefined);
});

test("a new page lands beside what is in view as Aiden's file frame, and a page already there is left alone", () => {
  const mine: DesignFrame = { id: "mine", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "person" };
  const { doc, changed, placedIds } = placeWrittenPageFrames(
    canvas([mine]),
    ["design/home.html", "design/02-library.html"],
    ids(),
    new Map(),
    onPage("page-1"),
  );
  assert.equal(changed, true);
  assert.deepEqual(placedIds, ["frame-1"]);
  const placed = doc.frames.find((frame) => frame.id === "frame-1")!;
  assert.deepEqual(
    { kind: placed.kind, path: placed.path, title: placed.title, createdBy: placed.createdBy, pageId: placed.pageId },
    { kind: "file", path: "design/02-library.html", title: "02-library.html", createdBy: "aiden", pageId: "page-1" },
  );
  assert.ok(placed.x >= mine.x + mine.w, "it does not cover the person's page");

  const again = placeWrittenPageFrames(doc, ["design/02-library.html"], ids(), new Map(), onPage("page-1"));
  assert.equal(again.changed, false);
  assert.equal(again.doc, doc);
});

test("several pages written in one reply land in a row without stacking", () => {
  const { doc } = placeWrittenPageFrames(canvas([]), ["design/a.html", "design/b.html", "design/c.html"], ids(), new Map(), onPage("page-1"));
  assert.equal(doc.frames.length, 3);
  for (let i = 0; i < doc.frames.length; i += 1) {
    for (let j = i + 1; j < doc.frames.length; j += 1) {
      const [a, b] = [doc.frames[i]!, doc.frames[j]!];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.title} and ${b.title} overlap`);
    }
  }
});

test("the pages a chat wrote are read from its saved activity, newest last and each once", () => {
  const step = (toolName: string, relativePath: string, status = "completed") => ({
    kind: "tool",
    toolName,
    status,
    producedFile: { relativePath, operation: toolName === "write_file" ? "written" : "edited", bytes: 10 },
  });
  const pages = pagesWrittenInChat([
    { timeline: null },
    { timeline: { steps: [step("write_file", "design/home.html"), step("write_file", "design/library.html")] } },
    {
      timeline: {
        steps: [
          { kind: "thinking" },
          step("edit_file", "design/home.html"),
          step("write_file", "design/failed.html", "failed"),
          step("edit_file", "design/parsely.css"),
        ],
      },
    },
  ]);
  assert.deepEqual(pages, ["design/library.html", "design/home.html"]);
});

test("only pages that exist are placed, and the canvas is saved once per change", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "home.html"), "<!doctype html><title>Home</title>");
  await fs.writeFile(path.join(workspaceRoot, "design", "notes.txt"), "not a page");
  const { workspaceStore, via } = canvasesAt(path.join(base, "canvases"));
  const broadcasts: number[] = [];
  const newId = ids();
  const place = async (paths: string[]) =>
    (
      await placeWrittenPagesOnCanvas({
        ...via("chat-1"),
        workspaceRoot,
        paths,
        broadcast: (update) => broadcasts.push(update.revision),
        newId,
      })
    ).frameIds;

  assert.deepEqual(await place(["design/missing.html", "design/notes.txt"]), []);
  assert.deepEqual(await place(["design/home.html"]), ["frame-1"]);
  assert.deepEqual(await place(["design/home.html"]), [], "an edit to a page already there changes nothing");

  await fs.writeFile(path.join(workspaceRoot, "design", "library.html"), "<!doctype html><title>Library</title>");
  assert.deepEqual(await place(["design/library.html"]), ["frame-2"]);

  const doc = await workspaceStore.get("ws-1");
  assert.deepEqual(doc.frames.map((frame) => frame.path), ["design/home.html", "design/library.html"]);
  assert.deepEqual(broadcasts, [1, 2]);
});

test("a page the person takes off the canvas is not put back when Aiden writes it again, until Aiden places it or the person adds it", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  for (const name of ["home", "about"]) await fs.writeFile(path.join(workspaceRoot, "design", `${name}.html`), "<!doctype html><title>x</title>");
  const { workspaceStore: store, via } = canvasesAt(path.join(base, "canvases"));
  const removedSeen: string[][] = [];
  const newId = ids();
  const place = async (paths: string[]) =>
    (
      await placeWrittenPagesOnCanvas({
        ...via("chat-1"),
        workspaceRoot,
        paths,
        broadcast: () => undefined,
        newId,
        onRemoved: (removed) => removedSeen.push([...removed]),
      })
    ).frameIds;
  const [homeId] = await place(["design/home.html"]);
  const [aboutId] = await place(["design/about.html"]);

  // Aiden's own removal is not the person's: the page comes back on the next write.
  await store.update("ws-1", (doc) => ({ ...doc, frames: doc.frames.filter((frame) => frame.id !== aboutId) }));
  assert.equal((await place(["design/about.html"])).length, 1);

  // The person deletes home.html's frame on their canvas (a save), then Aiden edits the page twice.
  const before = await store.get("ws-1");
  const saved = await store.save("ws-1", { ...before, frames: before.frames.filter((frame) => frame.id !== homeId) }, before.revision);
  assert.equal(saved.ok, true);
  assert.deepEqual(await place(["design/home.html"]), []);
  assert.deepEqual(await place(["design/home.html"]), []);
  assert.deepEqual(removedSeen, [["design/home.html"], ["design/home.html"]]);
  assert.equal((await store.get("ws-1")).frames.some((frame) => frame.path === "design/home.html"), false);

  // Placing it on purpose (any frame showing it again) clears the memory, and later writes land as before.
  await store.update("ws-1", (doc) => ({
    ...doc,
    frames: [...doc.frames, { id: "again", kind: "file", title: "home.html", path: "design/home.html", x: 0, y: 3000, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "aiden" }],
  }));
  assert.equal((await store.get("ws-1")).removedPagePaths, undefined);
  const again = await store.get("ws-1");
  await store.save("ws-1", { ...again, frames: again.frames.filter((frame) => frame.id !== "again") }, again.revision);
  assert.deepEqual((await store.get("ws-1")).removedPagePaths, ["design/home.html"]);
  // The person adding it back, even through a canvas that never knew the list, clears it too.
  const cleared = await store.get("ws-1");
  const { removedPagePaths: _list, ...withoutList } = cleared;
  await store.save("ws-1", { ...withoutList, frames: [...cleared.frames, { ...again.frames.find((frame) => frame.id === "again")!, id: "mine", createdBy: "person" }] }, cleared.revision);
  assert.equal((await store.get("ws-1")).removedPagePaths, undefined);

  // The person undoing the reply that placed about.html takes it off, but that is no removal of theirs:
  // the next write puts it back.
  const placed = await store.get("ws-1");
  const undoneSave = await store.save(
    "ws-1",
    { ...placed, frames: placed.frames.filter((frame) => frame.path !== "design/about.html") },
    placed.revision,
    { undone: ["design/about.html"] },
  );
  assert.equal(undoneSave.ok, true);
  assert.equal((await store.get("ws-1")).removedPagePaths, undefined);
  assert.equal((await place(["design/about.html"])).length, 1);
});

test("after each command, the design/ pages it made or changed are found, and nothing else", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-command-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const design = path.join(workspaceRoot, "design");
  await fs.mkdir(design, { recursive: true });
  await fs.writeFile(path.join(design, "home.html"), "<!doctype html><title>Home</title>");
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(path.join(design, "home.html"), anHourAgo, anHourAgo);
  await fs.writeFile(path.join(workspaceRoot, "index.html"), "<!doctype html>");
  const scanner = createDesignPageScanner(workspaceRoot);

  // As if `cp`, a build script or a heredoc wrote them.
  await fs.mkdir(path.join(design, "flows"));
  await fs.writeFile(path.join(design, "flows", "checkout.html"), "<!doctype html><title>Checkout</title>");
  await fs.writeFile(path.join(design, "tokens.css"), ":root{}");
  await fs.mkdir(path.join(design, ".cache"));
  await fs.writeFile(path.join(design, ".cache", "draft.html"), "<!doctype html>");
  await fs.writeFile(path.join(workspaceRoot, "about.html"), "<!doctype html>");
  await fs.symlink(path.join(workspaceRoot, "about.html"), path.join(design, "linked.html"));
  assert.deepEqual(await scanner.changedSinceLastLook(), ["design/flows/checkout.html"], "the page existing before the turn is not news");

  assert.deepEqual(await scanner.changedSinceLastLook(), [], "a command that wrote nothing places nothing");

  await fs.writeFile(path.join(design, "home.html"), "<!doctype html><title>Home, edited by sed</title>");
  assert.deepEqual(await scanner.changedSinceLastLook(), ["design/home.html"]);
});

test("a page the first command writes while the scanner takes its first look is still found", async () => {
  // The first look is not awaited before the command starts, so it can
  // already see what the command wrote.
  const start = 1_000_000;
  const scans: Array<Map<string, { mtimeMs: number; size: number }>> = [
    new Map([
      ["design/old.html", { mtimeMs: start - 60_000, size: 10 }],
      ["design/raced.html", { mtimeMs: start + 5, size: 20 }],
    ]),
  ];
  scans.push(new Map(scans[0]));
  scans.push(new Map(scans[0]));
  const scanner = createDesignPageScanner("/workspace", async () => scans.shift() ?? new Map(), () => start);
  assert.deepEqual(await scanner.changedSinceLastLook(), ["design/raced.html"], "the page edited before the turn is not news");
  assert.deepEqual(await scanner.changedSinceLastLook(), [], "a page is found once");
});

test("a workspace without a design folder has no command pages", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-command-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const scanner = createDesignPageScanner(base);
  await fs.writeFile(path.join(base, "index.html"), "<!doctype html>");
  assert.deepEqual(await scanner.changedSinceLastLook(), []);
  await fs.mkdir(path.join(base, "design"));
  await fs.writeFile(path.join(base, "design", "first.html"), "<!doctype html>");
  assert.deepEqual(await scanner.changedSinceLastLook(), ["design/first.html"], "a design folder a command creates counts");
});

test("pages a running reply wrote join the saved ones for design mode's entry, newest last and bounded", () => {
  const recent = new RecentWrittenPages();
  recent.note("chat-1", "design/a.html");
  recent.note("chat-1", "design/b.html");
  recent.note("chat-1", "design/a.html");
  recent.note("chat-2", "design/other.html");
  assert.deepEqual(
    recent.merged("chat-1", ["design/old.html", "design/b.html"]),
    ["design/old.html", "design/b.html", "design/a.html"],
    "a page saved and written again counts once, at its newest place",
  );
  for (let index = 0; index < RECENT_WRITTEN_PAGES_LIMIT + 5; index += 1) {
    recent.note("chat-1", `design/p${index}.html`);
  }
  const merged = recent.merged("chat-1", ["design/old.html"]);
  assert.equal(merged.length, RECENT_WRITTEN_PAGES_LIMIT + 1, "merged keeps saved + bounded recent pages so deleted newest pages do not starve older ones");
  assert.equal(merged[0], "design/old.html");
  assert.equal(merged[merged.length - 1], `design/p${RECENT_WRITTEN_PAGES_LIMIT + 4}.html`);
  recent.forget("chat-1");
  assert.deepEqual(recent.merged("chat-1", ["design/old.html"]), ["design/old.html"]);
  assert.deepEqual(recent.merged("chat-2", []), ["design/other.html"]);
});

test("deleted newest pages do not starve older surviving pages under limit, and shouldSave prevents recreating a deleted chat's canvas", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-race-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const canvasesDir = path.join(base, "canvases");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  const recent = new RecentWrittenPages();
  const saved: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    const relativePath = `design/page-${String(index).padStart(2, "0")}.html`;
    if (index < 12) {
      await fs.writeFile(path.join(workspaceRoot, relativePath), `<!doctype html><title>${index}</title>`);
    }
    if (index < 6) saved.push(relativePath);
    else recent.note("chat-1", relativePath);
  }
  // Pages 12..15 were noted most recently and then deleted before entry.
  // Pages 00..11 still exist on disk and should all 12 land in chronological order.
  const canvases = canvasesAt(canvasesDir);
  const { workspaceStore: store, via } = canvases;
  const broadcasts: string[] = [];
  const entry = entryFor(canvases, "chat-1", "Landing");

  // A deleted chat places nothing and writes no canvas.
  let canSave = false;
  const gone = await placeWrittenPagesOnCanvas({
    ...via("deleted-chat"),
    workspaceRoot,
    paths: recent.merged("chat-1", saved),
    limit: EARLIER_PAGES_LIMIT,
    shouldSave: () => true,
    broadcast: (update) => broadcasts.push(`${update.chatId}:${update.revision}`),
    newId: ids(),
    entry,
  });
  assert.deepEqual(gone.frameIds, [] as string[]);
  // Leaving design mode (or deleting the chat) before the save keeps the canvas unwritten.
  const aborted = await placeWrittenPagesOnCanvas({
    ...via("chat-1"),
    workspaceRoot,
    paths: recent.merged("chat-1", saved),
    limit: EARLIER_PAGES_LIMIT,
    shouldSave: () => canSave,
    broadcast: (update) => broadcasts.push(`${update.chatId}:${update.revision}`),
    newId: ids(),
    entry,
  });
  assert.deepEqual(aborted.frameIds, [] as string[]);
  assert.deepEqual(broadcasts, [] as string[]);
  await assert.rejects(fs.stat(path.join(canvasesDir, "ws-1.json")), { code: "ENOENT" });

  // Now allow saving and verify all 12 surviving older pages land oldest-to-newest.
  canSave = true;
  const placed = await placeWrittenPagesOnCanvas({
    ...via("chat-1"),
    workspaceRoot,
    paths: recent.merged("chat-1", saved),
    limit: EARLIER_PAGES_LIMIT,
    shouldSave: () => canSave,
    broadcast: (update) => broadcasts.push(`${update.chatId}:${update.revision}`),
    newId: ids(),
    entry,
  });
  assert.equal(placed.frameIds.length, EARLIER_PAGES_LIMIT);
  const doc = await store.get("ws-1");
  assert.deepEqual(
    doc.frames.map((frame) => frame.path),
    Array.from({ length: 12 }, (_, index) => `design/page-${String(index).padStart(2, "0")}.html`),
  );
  assert.deepEqual(broadcasts, ["chat-1:1"]);
});

test("leaving design mode while the page's save waits keeps the frame off the stored canvas", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-exit-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "home.html"), "<!doctype html><title>Home</title>");
  const { workspaceStore, store, via } = canvasesAt(path.join(base, "canvases"));
  let designMode = true;
  const broadcasts: number[] = [];
  const placed = await placeWrittenPagesOnCanvas({
    ...via("chat-1"),
    workspaceRoot,
    paths: ["design/home.html"],
    // The person leaves design mode once the save is already under way.
    store: {
      get: (chatId, options) => store.get(chatId, options),
      workspaceIdOf: (chatId) => store.workspaceIdOf(chatId),
      update: (chatId, mutate, options) =>
        store.update(
          chatId,
          (doc) => {
            designMode = false;
            return mutate(doc);
          },
          options,
        ),
    },
    shouldSave: () => designMode,
    broadcast: (update) => broadcasts.push(update.revision),
    newId: ids(),
  });
  assert.deepEqual(placed.frameIds, [] as string[]);
  assert.deepEqual(broadcasts, [] as number[]);
  assert.deepEqual((await workspaceStore.get("ws-1")).frames, []);
});

test("leaving design mode while the page's file is being written takes the frame back off, unless the mode is on again", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-exit-write-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "home.html"), "<!doctype html><title>Home</title>");
  const run = async (chatId: string, backOnBeforeRetract: boolean) => {
    const { workspaceStore, store, via } = canvasesAt(path.join(base, "canvases"));
    let designMode = true;
    let calls = 0;
    const broadcasts: number[] = [];
    const placed = await placeWrittenPagesOnCanvas({
      ...via(chatId),
      workspaceRoot,
      paths: ["design/home.html"],
      store: {
        get: (id, options) => store.get(id, options),
        workspaceIdOf: (id) => store.workspaceIdOf(id),
        update: async (id, mutate, options) => {
          calls += 1;
          // The person enters design mode again before the take-back runs.
          if (calls === 2 && backOnBeforeRetract) designMode = true;
          const saved = await store.update(id, mutate, options);
          // The exit commits after the pre-write check passed, while the file was written.
          if (calls === 1) designMode = false;
          return saved;
        },
      },
      shouldSave: () => designMode,
      broadcast: (update) => broadcasts.push(update.revision),
      newId: ids(),
    });
    return { placedIds: placed.frameIds, broadcasts, frames: (await workspaceStore.get(chatId)).frames.map((frame) => frame.path) };
  };

  const exited = await run("chat-exit", false);
  assert.deepEqual(exited.placedIds, [] as string[]);
  assert.deepEqual(exited.frames, [] as string[]);
  assert.deepEqual(exited.broadcasts, [2], "open canvases hear about the take-back");

  const reentered = await run("chat-reenter", true);
  assert.deepEqual(reentered.frames, ["design/home.html"], "a canvas the person opened again keeps the page");
});

test("a page's own width hint picks its design width; pages that do not say stay at 1280", () => {
  assert.equal(inferDesignWidth('<head><meta name="aiden-design-width" content="390"></head>'), 390);
  assert.equal(inferDesignWidth("<meta content='1440' name='aiden-design-width'>"), 1440);
  assert.equal(inferDesignWidth('<meta name="viewport" content="width=375, initial-scale=1">'), 390);
  assert.equal(inferDesignWidth('<meta name="viewport" content="width=820">'), 768);
  assert.equal(inferDesignWidth('<meta name="viewport" content="width=1440">'), 1440);
  assert.equal(inferDesignWidth('<meta name="viewport" content="width=device-width, initial-scale=1">'), undefined);
  assert.equal(inferDesignWidth("<style>.phone{width:390px;height:844px}</style>"), 390);
  assert.equal(inferDesignWidth("<style>body { margin: 0; max-width: 768px }</style>"), 768);
  assert.equal(
    inferDesignWidth("<style>.phone{width:390px} .screen{max-width:1200px}</style>"),
    undefined,
    "shell widths that disagree say nothing",
  );
  assert.equal(
    inferDesignWidth("<style>.container{max-width:1200px} .phone{width:390px;height:844px}</style>"),
    undefined,
    "a desktop page showcasing an embedded phone preview stays desktop",
  );
  assert.equal(
    inferDesignWidth("<style>.hero{padding:64px} @media (max-width: 640px) { body { max-width: 390px } }</style>"),
    undefined,
    "responsive mobile media queries do not turn a desktop page into a phone frame",
  );
  assert.equal(
    inferDesignWidth("<style>/* .phone { width: 390px } */</style><p>.phone { width: 390px }</p>"),
    undefined,
    "CSS comments and HTML prose are ignored",
  );
  assert.equal(inferDesignWidth("<style>.card{width:390px}</style>"), undefined, "a card is not a phone shell");
  assert.equal(inferDesignWidth("<!doctype html><title>Plain</title>"), undefined);
});

test("written pages land at the width they ask for, with that width's box", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-widths-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "phone.html"), '<!doctype html><meta name="aiden-design-width" content="390"><title>Phone</title>');
  await fs.writeFile(path.join(workspaceRoot, "design", "tablet.html"), '<!doctype html><meta name="viewport" content="width=768"><title>Tablet</title>');
  await fs.writeFile(path.join(workspaceRoot, "design", "desk.html"), "<!doctype html><title>Desk</title>");
  const { workspaceStore, via } = canvasesAt(path.join(base, "canvases"));
  await placeWrittenPagesOnCanvas({
    ...via("chat-1"),
    workspaceRoot,
    paths: ["design/phone.html", "design/tablet.html", "design/desk.html"],
    broadcast: () => undefined,
    newId: ids(),
  });
  const doc = await workspaceStore.get("ws-1");
  assert.deepEqual(
    doc.frames.map((frame) => [frame.path, frame.designWidth, frame.w, frame.h]),
    [
      ["design/phone.html", 390, 390, 844],
      ["design/tablet.html", 768, 576, 768],
      ["design/desk.html", 1280, 640, 436],
    ],
  );
});

test("the width hint is read only from a regular file, never through a symbolic link", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-hint-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const real = path.join(base, "real.html");
  await fs.writeFile(real, '<meta name="aiden-design-width" content="390">');
  await fs.symlink(real, path.join(base, "link.html"));
  assert.equal(await readDesignWidthHint(real), 390);
  assert.equal(await readDesignWidthHint(path.join(base, "link.html")), undefined);
  assert.equal(await readDesignWidthHint(base), undefined, "a folder is not a page");
  // Only the start of a page is read.
  await fs.writeFile(real, `${" ".repeat(DESIGN_WIDTH_HINT_BYTES)}<meta name="aiden-design-width" content="390">`);
  assert.equal(await readDesignWidthHint(real), undefined);
});

/** A workspace folder with these design/ pages. */
async function workspaceWith(t: test.TestContext, names: string[]) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-chat-page-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  for (const name of names) await fs.writeFile(path.join(workspaceRoot, "design", name), `<!doctype html><title>${name}</title>`);
  return { workspaceRoot, canvases: canvasesAt(path.join(base, "canvases")) };
}

const fileFrame = (id: string, relativePath: string, pageId: string): DesignFrame => ({
  id, kind: "file", title: relativePath, path: relativePath, x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId, createdBy: "aiden",
});

test("a written page dedupes only against the chat's view page", () => {
  const elsewhere: DesignCanvas = {
    ...canvas([fileFrame("on-p2", "design/home.html", "p2")]),
    pages: [...emptyDesignCanvas().pages, { id: "p2", name: "Pricing" }],
  };
  const placed = placeWrittenPageFrames(elsewhere, ["design/home.html"], ids(), new Map(), onPage("page-1"));
  assert.deepEqual(placed.placedIds, ["frame-1"], "another page's frame of the file does not count");
  assert.equal(placed.doc.frames.find((frame) => frame.id === "frame-1")?.pageId, "page-1");
  const again = placeWrittenPageFrames(placed.doc, ["design/home.html"], ids(), new Map(), onPage("p2"));
  assert.equal(again.changed, false, "on p2 the page is already there");
});

test("a written page auto-placed in a turn claims for a chat with none", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html"]);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, pages: [...doc.pages, { id: "p2", name: "Pricing" }] }));
  await canvases.views.report("chat-1", "ws-1", onPage("p2"), 0);
  await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: ["design/home.html"],
    broadcast: () => undefined,
    newId: ids(),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(doc.revision, 2, "the claim rides on the placement's write");
  assert.deepEqual(doc.chatPages, { "chat-1": "p2" });
});

test("a turn's message page beats the chat's kept page for a page written mid-turn", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html"]);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, pages: [...doc.pages, { id: "p2", name: "Pricing" }] }));
  await canvases.views.report("chat-1", "ws-1", onPage("p2"), 0);
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1", { selection: [], pageId: "page-1" }),
    workspaceRoot,
    paths: ["design/home.html"],
    broadcast: () => undefined,
    newId: ids(),
  });
  assert.equal(placed.pageId, "page-1");
  assert.equal((await canvases.workspaceStore.get("ws-1")).frames[0]?.pageId, "page-1");
});

/** Design-mode entry for `chatId`: other chats' views from `views`, and every chat live unless `gone` names it. */
function entryFor(
  canvases: ReturnType<typeof canvasesAt>,
  chatId: string,
  pageName: string,
  gone: readonly string[] = [],
) {
  return {
    pageName,
    otherViews: (workspaceId: string) => canvases.views.pageIdsOf(workspaceId, chatId),
    isLive: async (chatIds: string[]) => new Set(chatIds.filter((id) => !gone.includes(id))),
  };
}

test("the first chat on a fresh canvas claims Page 1 without renaming it, adds no page, and shows it", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-1", "Northwind landing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages, [{ id: "page-1", name: "Page 1" }]);
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1" });
  assert.deepEqual(placed.frameIds, []);
  assert.equal(placed.pageId, "page-1");
  assert.equal(placed.focusId, 1, "the claimed page is shown");
  assert.equal((await canvases.views.get("chat-1", "ws-1"))?.pageId, "page-1");
});

test("chat B entering a workspace whose first page is chat A's gets a page named after B, claimed and shown", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  // Page 1 is A's, and empty: an empty page another chat claims is not shared.
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: { "chat-1": "page-1" } }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Pricing table"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1", "Pricing table"]);
  const page = doc.pages[1]!;
  assert.equal(page.namedFor, "chat-2");
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1", "chat-2": page.id });
  assert.equal(placed.pageId, page.id);
  assert.equal(placed.focusId, 1);
  assert.equal((await canvases.views.get("chat-2", "ws-1"))?.pageId, page.id);
});

test("chat B's earlier pages go on the page made for it when the first page is chat A's", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["b-home.html", "b-about.html"]);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    chatPages: { "chat-1": "page-1" },
    frames: [fileFrame("a-home", "design/a-home.html", "page-1")],
  }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: ["design/b-home.html", "design/b-about.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Brand refresh"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  const page = doc.pages.find((entry) => entry.name === "Brand refresh");
  assert.ok(page, "a page named after chat B");
  assert.equal(placed.pageId, page.id);
  assert.deepEqual(
    doc.frames.filter((frame) => frame.pageId === page.id).map((frame) => frame.path),
    ["design/b-home.html", "design/b-about.html"],
  );
  assert.equal(doc.frames.find((frame) => frame.id === "a-home")?.pageId, "page-1", "chat A's page is left alone");
});

test("a page with frames that another chat's kept view is on is not taken; B gets its own page", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, frames: [fileFrame("a-home", "design/a-home.html", "page-1")] }));
  await canvases.views.report("chat-1", "ws-1", onPage("page-1"), 0);
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Brand refresh"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1", "Brand refresh"]);
  assert.deepEqual(doc.chatPages, { "chat-2": doc.pages[1]!.id });
  assert.equal(placed.pageId, doc.pages[1]!.id);
});

test("a page with frames that only this chat has looked at is claimed as it is", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["mine.html"]);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, frames: [fileFrame("other", "design/other.html", "page-1")] }));
  await canvases.views.report("chat-1", "ws-1", onPage("page-1"), 0);
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: ["design/mine.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-1", "Landing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages, [{ id: "page-1", name: "Page 1" }]);
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1" });
  assert.equal(placed.pageId, "page-1");
  assert.equal(doc.frames.find((frame) => frame.path === "design/mine.html")?.pageId, "page-1");
});

test("a claim of a chat that no longer exists does not stop the page being claimed", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: { "chat-gone": "page-1" } }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Pricing table", ["chat-gone"]),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(doc.pages.length, 1);
  assert.equal(placed.pageId, "page-1");
  // The gone chat's entry is dropped in the same write.
  assert.deepEqual(doc.chatPages, { "chat-2": "page-1" });
});

test("a page named for another chat is never taken by rule 3", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, pages: [{ id: "page-1", name: "Landing", namedFor: "chat-1" }] }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Pricing table"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages.map((page) => [page.name, page.namedFor]), [["Landing", "chat-1"], ["Pricing table", "chat-2"]]);
  assert.equal(placed.pageId, doc.pages[1]!.id);
});

test("a page named for a chat that no longer exists is taken by rule 3, and the mark goes in the same write", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, pages: [{ id: "page-1", name: "Landing", namedFor: "chat-gone" }] }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Pricing table", ["chat-gone"]),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages, [{ id: "page-1", name: "Landing" }]);
  assert.equal(placed.pageId, "page-1");
  assert.deepEqual(doc.chatPages, { "chat-2": "page-1" });
});

test("a chat entering again keeps its claim, adds no page and still shows it", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html", "about.html"]);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    pages: [...doc.pages, { id: "p2", name: "Flows" }],
    chatPages: { "chat-1": "p2" },
    frames: [fileFrame("home", "design/home.html", "page-1"), fileFrame("about", "design/about.html", "page-1")],
  }));
  // The chat last looked at page 1; its claim is still p2.
  await canvases.views.report("chat-1", "ws-1", onPage("page-1"), 0);
  const before = await canvases.workspaceStore.get("ws-1");
  const broadcasts: unknown[] = [];
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: ["design/home.html", "design/about.html"],
    broadcast: (update) => broadcasts.push(update),
    newId: ids(),
    entry: entryFor(canvases, "chat-1", "Landing"),
  });
  assert.deepEqual(placed.frameIds, []);
  assert.deepEqual(await canvases.workspaceStore.get("ws-1"), before, "the canvas is untouched");
  assert.deepEqual(broadcasts, []);
  assert.equal(placed.pageId, "p2");
  assert.equal(placed.focusId, 1);
  assert.equal((await canvases.views.get("chat-1", "ws-1"))?.pageId, "p2");
});

test("the chat's earlier pages already on the canvas make the page holding most of them its claim", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["a.html", "b.html", "c.html"]);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    pages: [...doc.pages, { id: "p2", name: "Flows" }],
    frames: [fileFrame("a", "design/a.html", "p2"), fileFrame("b", "design/b.html", "p2")],
  }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: ["design/a.html", "design/b.html", "design/c.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-1", "Landing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(doc.pages.length, 2, "no new page");
  assert.deepEqual(doc.chatPages, { "chat-1": "p2" });
  assert.equal(placed.pageId, "p2");
  assert.deepEqual(placed.frameIds.map((id) => doc.frames.find((frame) => frame.id === id)?.path), ["design/c.html"]);
  assert.equal(doc.frames.find((frame) => frame.path === "design/c.html")?.pageId, "p2");
  assert.equal((await canvases.views.get("chat-1", "ws-1"))?.pageId, "p2");
});

test("a page another live chat claims does not count toward the chat's earlier pages", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["index.html"]);
  // A's page holds design/index.html; B wrote the same file in its own replies.
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    chatPages: { "chat-1": "page-1" },
    frames: [fileFrame("a-index", "design/index.html", "page-1")],
  }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: ["design/index.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Pricing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.notEqual(placed.pageId, "page-1");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1", "Pricing"]);
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1", "chat-2": placed.pageId });
});

test("two chats entering a fresh canvas at once end on Page 1 and a new page", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const enter = (chatId: string, title: string) =>
    placeWrittenPagesOnCanvas({
      ...canvases.via(chatId),
      workspaceRoot,
      paths: [],
      broadcast: () => undefined,
      newId: () => `page-${chatId}`,
      entry: entryFor(canvases, chatId, title),
    });
  const [a, b] = await Promise.all([enter("chat-1", "Landing"), enter("chat-2", "Pricing")]);
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(doc.pages.length, 2);
  assert.notEqual(a.pageId, b.pageId);
  assert.deepEqual(new Set(Object.values(doc.chatPages)), new Set(doc.pages.map((page) => page.id)));
  assert.deepEqual(doc.chatPages, { "chat-1": a.pageId, "chat-2": b.pageId });
  assert.equal(doc.pages[0]!.name, "Page 1");
  const made = doc.pages[1]!;
  assert.equal(doc.chatPages[made.namedFor!], made.id, "the new page is named for the chat that claimed it");
});

test("B's new page is numbered when a page already has B's title", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    pages: [...doc.pages, { id: "p2", name: "Pricing" }],
    chatPages: { "chat-1": "page-1" },
  }));
  await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: () => "page-b",
    entry: entryFor(canvases, "chat-2", "pricing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1", "pricing 2", "Pricing"]);
  assert.equal(doc.chatPages["chat-2"], "page-b");
});

test("at the page limit, a chat whose page is taken shares it", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    pages: Array.from({ length: DESIGN_CANVAS_LIMITS.pages }, (_, index) => ({ id: `page-${index + 1}`, name: `Page ${index + 1}` })),
    chatPages: { "chat-1": "page-1" },
  }));
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    workspaceRoot,
    paths: [],
    broadcast: () => undefined,
    newId: () => "page-b",
    entry: entryFor(canvases, "chat-2", "Pricing"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(doc.pages.length, DESIGN_CANVAS_LIMITS.pages);
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1", "chat-2": "page-1" });
  assert.equal(placed.pageId, "page-1");
});

test("leaving design mode while entry's file is being written takes back the added page and the claim on it", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["b-home.html"]);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    chatPages: { "chat-1": "page-1" },
    frames: [fileFrame("a-home", "design/a-home.html", "page-1")],
  }));
  let designMode = true;
  let calls = 0;
  const via = canvases.via("chat-2");
  const placed = await placeWrittenPagesOnCanvas({
    ...via,
    store: {
      get: (id, options) => canvases.store.get(id, options),
      workspaceIdOf: (id) => canvases.store.workspaceIdOf(id),
      update: async (id, mutate, options) => {
        calls += 1;
        const saved = await canvases.store.update(id, mutate, options);
        if (calls === 1) designMode = false;
        return saved;
      },
    },
    shouldSave: () => designMode,
    workspaceRoot,
    paths: ["design/b-home.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Brand refresh"),
  });
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.pages.map((page) => page.name), ["Page 1"], "no empty page is left on the shared canvas");
  assert.deepEqual(doc.frames.map((frame) => frame.id), ["a-home"]);
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1" });
  assert.equal(placed.focusId, undefined, "nothing is shown");
});

test("with design mode turned off before the write, no claim is made and nothing is shown", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["b-home.html"]);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: { "chat-1": "page-1" } }));
  const before = await canvases.workspaceStore.get("ws-1");
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-2"),
    shouldSave: () => false,
    workspaceRoot,
    paths: ["design/b-home.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: entryFor(canvases, "chat-2", "Brand refresh"),
  });
  assert.deepEqual(await canvases.workspaceStore.get("ws-1"), before);
  assert.deepEqual(placed.frameIds, []);
  assert.equal(placed.focusId, undefined);
  assert.equal(await canvases.views.get("chat-2", "ws-1"), undefined);
});

test("an entry still running when its chat moves to another workspace writes nothing back to the canvas it left", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["b-home.html"]);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: { "chat-1": "page-1" } }));
  const before = await canvases.workspaceStore.get("ws-1");
  // chat-2 starts in ws-1; the move points it at ws-2 while entry waits.
  const workspaces = new Map([["chat-1", "ws-1"], ["chat-2", "ws-1"]]);
  const store = new DesignChatCanvases({
    store: canvases.workspaceStore,
    workspaceIdOf: async (chatId) => workspaces.get(chatId) ?? null,
  });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const entry = placeWrittenPagesOnCanvas({
    chatId: "chat-2",
    store,
    pages: canvases.pages("chat-2"),
    shouldSave: () => true,
    workspaceRoot,
    paths: ["design/b-home.html"],
    broadcast: () => undefined,
    newId: ids(),
    entry: {
      ...entryFor(canvases, "chat-2", "Brand refresh"),
      isLive: async (chatIds: string[]) => {
        reached();
        await held;
        return new Set(chatIds);
      },
    },
  });
  await waiting;
  // The move commits, then the old canvas's cleanup finds nothing of chat-2's.
  workspaces.set("chat-2", "ws-2");
  release();
  const placed = await entry;
  assert.deepEqual(await canvases.workspaceStore.get("ws-1"), before, "no claim, named page or frames come back to ws-1");
  assert.deepEqual(placed.frameIds, []);
  assert.equal(placed.focusId, undefined);
});

test("a chat that moves while its turn's claim asks which chats are live claims nothing there, and gets no focus", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html"]);
  // chatPages is full, so the claim waits on liveness after the save.
  const others = Array.from({ length: DESIGN_CANVAS_LIMITS.chatPages }, (_, index) => `old-${index}`);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: Object.fromEntries(others.map((id) => [id, "page-1"])) }));
  const workspaces = new Map([["chat-2", "ws-1"]]);
  const store = new DesignChatCanvases({ store: canvases.workspaceStore, workspaceIdOf: async (chatId) => workspaces.get(chatId) ?? null });
  let asked = 0;
  const placed = await placeWrittenPagesOnCanvas({
    chatId: "chat-2",
    store,
    pages: canvases.pages("chat-2"),
    workspaceRoot,
    paths: ["design/home.html"],
    broadcast: () => undefined,
    newId: ids(),
    isLive: async () => {
      asked += 1;
      // The move commits while the claim waits; every old chat is gone, so there would be room.
      workspaces.set("chat-2", "ws-2");
      return new Set<string>();
    },
  });
  assert.equal(asked, 1, "the claim asked which chats are live");
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.equal(Object.prototype.hasOwnProperty.call(doc.chatPages, "chat-2"), false, "no claim in the workspace it left");
  assert.deepEqual([placed.frameIds, placed.pageId, placed.focusId], [[], undefined, undefined], "no focus for the old page");
});

test("a turn's write while design mode's entry runs waits for it, lands on the chat's new page, and the page takes the newest title", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, chatPages: { "chat-1": "page-1" } }));
  const pending = new PendingEntries();
  // The auto-title lands while entry runs.
  const titles = new Map([["chat-2", "Pricing table"]]);
  const focused: { chatId: string; pageId: string; focusId?: number }[] = [];
  const enter = createDesignEntry({
    store: canvases.store,
    views: canvases.views,
    recent: new RecentWrittenPages(),
    pending,
    titleFollow: createDesignTitleFollow({ canvases: canvases.store, titleOf: async (chatId) => titles.get(chatId), broadcast: () => undefined }),
    isLive: async (chatIds) => new Set(chatIds),
    designModeOn: async () => true,
    broadcast: () => undefined,
    focus: (request) => focused.push(request),
    newId: () => "page-chat-2",
  });
  const entered = enter({ id: "chat-2", title: "New chat", messages: [] }, workspaceRoot);
  // The turn places a visual right away.
  const placed = placeArtifactsOnCanvas({
    ...canvases.via("chat-2"),
    broadcast: () => undefined,
    newId: () => "frame-visual",
    artifacts: [{ mediaId: "m1", title: "Chart" }],
    pendingEntry: () => pending.wait("chat-2"),
  });
  await Promise.all([entered, placed]);
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.chatPages, { "chat-1": "page-1", "chat-2": "page-chat-2" });
  assert.deepEqual(doc.pages.find((page) => page.id === "page-chat-2"), { id: "page-chat-2", name: "Pricing table", namedFor: "chat-2" });
  assert.equal(doc.frames.find((frame) => frame.id === "frame-visual")?.pageId, "page-chat-2");
  assert.deepEqual(focused.map(({ chatId, pageId }) => [chatId, pageId]), [["chat-2", "page-chat-2"]]);
  assert.equal(typeof focused[0]?.focusId, "number");
});

// ── 3b (S83): route files Aiden writes land as live app frames ──

const nextApp = (appRoot = ".", framework: "next" | "vite" = "next") => ({ appRoot, framework, frameworkLabel: framework });
const routeData = (candidates: ReturnType<typeof nextApp>[], params: Record<string, Record<string, string[]>> = {}) =>
  writtenRouteData(
    { apps: [], candidates },
    { version: 1, apps: Object.entries(params).map(([root, values]) => ({ root, params: values })) },
  );
const appFramesOf = (doc: DesignCanvas) =>
  doc.frames.filter((frame) => frame.kind === "app").map((frame) => ({ appRoot: frame.appRoot, route: frame.route, pageId: frame.pageId }));

/** A turn of route writes, one placement call each, as llm-client runs them; returns each call's `added`. */
async function writeRoutes(
  canvases: ReturnType<typeof canvasesAt>,
  workspaceRoot: string,
  files: string[],
  options: { data?: ReturnType<typeof routeData>; chatId?: string; newId?: () => string; loads?: { count: number } } = {},
) {
  const turn = createWrittenRouteTurn({
    load: async () => {
      if (options.loads) options.loads.count += 1;
      return options.data ?? routeData([nextApp()]);
    },
  });
  const added: number[][] = [];
  const newId = options.newId ?? ids();
  for (const file of files) {
    const route = await turn.routeFor(file);
    if (!route || turn.room() === 0) continue;
    const placed = await placeWrittenPagesOnCanvas({
      ...canvases.via(options.chatId ?? "chat-1"),
      workspaceRoot,
      paths: [],
      routes: [route],
      broadcast: () => undefined,
      newId,
    });
    turn.placed(placed.added.length);
    added.push(placed.added);
  }
  return added;
}

test("3b: a written Next route file lands once as a live frame on the turn's page", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/pricing/page.tsx"]), [[1280]]);
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(appFramesOf(doc), [{ appRoot: ".", route: "/pricing", pageId: "page-1" }]);
  const frame = doc.frames.find((entry) => entry.kind === "app")!;
  assert.deepEqual([frame.viewport, frame.scale, frame.createdBy], [{ width: 1280, height: 800 }, 0.5, "aiden"]);

  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/pricing/page.tsx", "app/pricing/page.tsx"]), [[], []], "an edit, now or next turn, adds nothing");
  assert.equal(appFramesOf(await canvases.workspaceStore.get("ws-1")).length, 1);
});

test("3b: a frame the person placed for the route counts, and non-route files place nothing", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({
    ...doc,
    frames: [{ id: "mine", kind: "app", title: "/pricing", appRoot: ".", route: "/pricing", viewport: { width: 390, height: 844 }, scale: 0.5, x: 0, y: 0, w: 195, h: 458, pageId: "page-1", createdBy: "person" }],
  }));
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/pricing/page.tsx", "app/pricing/PriceCard.tsx", "app/layout.tsx"]), [[]]);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")).map((frame) => frame.route), ["/pricing"]);
});

test("3b: a dynamic route lands only with canvas.json's first value for it", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/blog/[slug]/page.tsx"]), []);
  const data = routeData([nextApp()], { ".": { "/blog/[slug]": ["hello-world", "second"] } });
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/blog/[slug]/page.tsx"], { data }), [[1280]]);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")).map((frame) => frame.route), ["/blog/hello-world"]);
});

test("3b: a route the person took off the canvas isn't put back", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await writeRoutes(canvases, workspaceRoot, ["app/pricing/page.tsx"]);
  const placed = await canvases.workspaceStore.get("ws-1");
  await canvases.workspaceStore.save("ws-1", { ...placed, frames: [] }, placed.revision);
  assert.deepEqual((await canvases.workspaceStore.get("ws-1")).removedAppRoutes, [appRouteKey(".", "/pricing")]);
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["app/pricing/page.tsx"]), [[]]);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")), []);
});

test("3b: chat A's route lands on A's page while chat B looks at its own", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  await canvases.store.update("chat-1", (doc) => ({ ...doc, pages: [...doc.pages, { id: "p2", name: "B" }] }));
  await canvases.views.report("chat-2", "ws-1", onPage("p2"), 0);
  await canvases.views.report("chat-1", "ws-1", onPage("page-1"), 0);
  await writeRoutes(canvases, workspaceRoot, ["app/about/page.tsx"], { chatId: "chat-1" });
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")).map((frame) => frame.pageId), ["page-1"]);
});

test("3b: a turn writing a design/ page and a route file places both kinds", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html"]);
  const placed = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: ["design/home.html"],
    routes: [{ appRoot: ".", route: "/" }],
    broadcast: () => undefined,
    newId: ids(),
  });
  assert.equal(placed.frameIds.length, 2);
  assert.deepEqual(placed.added, [1280], "only the app frame is reported");
  const kinds = (await canvases.workspaceStore.get("ws-1")).frames.map((frame) => frame.kind).sort();
  assert.deepEqual(kinds, ["app", "file"]);
});

test("3b: a route file belongs to the deepest app root holding it; no root or no convention is nothing", async () => {
  const data = routeData([nextApp("."), nextApp("apps/web"), nextApp("apps/site", "vite")]);
  assert.deepEqual(writtenAppRoute("apps/web/app/pricing/page.tsx", data), { appRoot: "apps/web", route: "/pricing" });
  assert.deepEqual(writtenAppRoute("app/page.tsx", data), { appRoot: ".", route: "/" });
  assert.equal(writtenAppRoute("apps/site/src/pages/about.tsx", data), null, "a Vite app has no route convention");
  const rootless = routeData([nextApp("apps/web")]);
  assert.equal(writtenAppRoute("docs/app/page.tsx", rootless), null, "a file under no root");
  assert.equal(writtenAppRoute("design/home.html", routeData([nextApp()])), null);
});

test("3d: a route written into a mock app is placed", async (t) => {
  const mock = { appRoot: "design-app", framework: "vite" as const, frameworkLabel: "Vite", mock: true as const };
  const data = writtenRouteData({ apps: [], candidates: [mock] }, null);
  assert.deepEqual(data.owners, [{ appRoot: "design-app", framework: "vite", mock: true }]);
  assert.deepEqual(writtenAppRoute("design-app/src/routes/settings.tsx", data), { appRoot: "design-app", route: "/settings" });
  assert.deepEqual(writtenAppRoute("design-app/src/routes/settings-v2.tsx", data), { appRoot: "design-app", route: "/settings-v2" });
  assert.deepEqual(writtenAppRoute("design-app/src/routes/index.tsx", data), { appRoot: "design-app", route: "/" });
  assert.equal(writtenAppRoute("design-app/src/routes/$slug.tsx", data), null, "no dynamic routes in a mock");
  assert.equal(writtenAppRoute("design-app/src/App.tsx", data), null);
  // The same app without the marker is an ordinary Vite app, with no route convention.
  const plain = writtenRouteData({ apps: [], candidates: [{ ...mock, mock: undefined }] }, null);
  assert.equal(writtenAppRoute("design-app/src/routes/settings.tsx", plain), null);
  // The marker on a running app's status counts too.
  const running = writtenRouteData({ candidates: [], apps: [{ workspaceId: "ws-1", appRoot: "design-app", source: "started", framework: "vite", frameworkLabel: "Vite", phase: "running", since: 0, revision: 1, mock: true }] }, null);
  assert.deepEqual(writtenAppRoute("design-app/src/routes/settings.tsx", running), { appRoot: "design-app", route: "/settings" });

  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  assert.deepEqual(await writeRoutes(canvases, workspaceRoot, ["design-app/src/routes/settings.tsx"], { data }), [[1280]]);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")), [{ appRoot: "design-app", route: "/settings", pageId: "page-1" }]);
});

test("3b: a turn reads the app snapshot and canvas.json once, however many writes race", async () => {
  const loads = { count: 0 };
  const turn = createWrittenRouteTurn({
    load: async () => {
      loads.count += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return routeData([nextApp()]);
    },
  });
  const routes = await Promise.all(["app/a/page.tsx", "app/b/page.tsx", "app/c/page.tsx"].map((file) => turn.routeFor(file)));
  assert.deepEqual(routes.map((route) => route?.route), ["/a", "/b", "/c"]);
  assert.equal(loads.count, 1);
  assert.equal(await turn.routeFor("design/home.html"), null);
  assert.equal(loads.count, 1);
});

test("3b: a turn places at most 12 route frames", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const files = Array.from({ length: 13 }, (_, index) => `app/p${index}/page.tsx`);
  const added = await writeRoutes(canvases, workspaceRoot, files);
  assert.equal(added.flat().length, EARLIER_PAGES_LIMIT);
  assert.equal(appFramesOf(await canvases.workspaceStore.get("ws-1")).length, 12);
  assert.ok(!appFramesOf(await canvases.workspaceStore.get("ws-1")).some((frame) => frame.route === "/p12"), "the 13th places nothing");
});

test("3b: a route placement refused or taken back reports nothing", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const refused = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: [],
    routes: [{ appRoot: ".", route: "/" }],
    shouldSave: () => false,
    broadcast: () => undefined,
    newId: ids(),
  });
  assert.deepEqual(refused.added, []);

  let designMode = true;
  let calls = 0;
  const { store } = canvases;
  const retracted = await placeWrittenPagesOnCanvas({
    ...canvases.via("chat-1"),
    workspaceRoot,
    paths: [],
    routes: [{ appRoot: ".", route: "/" }],
    store: {
      get: (id, options) => store.get(id, options),
      workspaceIdOf: (id) => store.workspaceIdOf(id),
      update: async (id, mutate, options) => {
        calls += 1;
        const saved = await store.update(id, mutate, options);
        if (calls === 1) designMode = false;
        return saved;
      },
    },
    shouldSave: () => designMode,
    broadcast: () => undefined,
    newId: ids(),
  });
  assert.deepEqual(retracted.added, []);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")), [], "the app frame is taken back off like a page");
});

test("3b: route files join a chat's written timeline only when asked", () => {
  const step = (toolName: string, relativePath: string) => ({
    kind: "tool",
    toolName,
    status: "completed",
    producedFile: { relativePath, operation: toolName === "write_file" ? "written" : "edited", bytes: 1 },
  });
  const messages = [{ timeline: { steps: [step("write_file", "app/pricing/page.tsx"), step("write_file", "design/home.html"), step("edit_file", "app/pricing/page.tsx")] } }];
  assert.deepEqual(pagesWrittenInChat(messages), ["design/home.html"], "flag off: today's list");
  const isRouteFile = (file: string) => writtenAppRoute(file, routeData([nextApp()])) !== null;
  assert.deepEqual(pagesWrittenInChat(messages, { isRouteFile }), ["design/home.html", "app/pricing/page.tsx"]);
});

// ── 3b (S83): design-mode entry shows the chat's routes, or the app's home ──

const toolStep = (relativePath: string) => ({
  kind: "tool",
  toolName: "write_file",
  status: "completed",
  producedFile: { relativePath, operation: "written", bytes: 1 },
});
const wrote = (...files: string[]) => [{ timeline: { steps: files.map(toolStep) } }];

function liveEntry(
  canvases: ReturnType<typeof canvasesAt>,
  options: {
    target?: "single" | "choose" | "none";
    candidates?: ReturnType<typeof nextApp>[];
    recent?: RecentWrittenPages;
    live?: boolean;
    newId?: () => string;
    /** Runs while entry reads the apps snapshot, as a person acting meanwhile. */
    onSnapshot?: () => void;
  } = {},
) {
  const reported: number[] = [];
  const candidates = options.candidates ?? [nextApp()];
  const enter = createDesignEntry({
    store: canvases.store,
    views: canvases.views,
    recent: options.recent ?? new RecentWrittenPages(),
    pending: new PendingEntries(),
    titleFollow: { follow: async () => undefined },
    isLive: async (chatIds) => new Set(chatIds),
    designModeOn: async () => true,
    broadcast: () => undefined,
    focus: () => undefined,
    newId: options.newId ?? ids(),
    ...(options.live === false
      ? {}
      : {
          live: {
            snapshot: async (workspaceId: string) => {
              options.onSnapshot?.();
              return { workspaceId, target: options.target ?? "single", apps: [], candidates, chosen: [] };
            },
            readConfig: async () => null,
            onAppFrameAdded: (width: number) => reported.push(width),
          },
        }),
  });
  return { enter, reported };
}

test("3b: entry places the chat's route files beside its pages", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, ["home.html"]);
  const { enter, reported } = liveEntry(canvases);
  await enter({ id: "chat-1", title: "Chat", messages: wrote("app/pricing/page.tsx", "design/home.html") }, workspaceRoot);
  const doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(doc.frames.map((frame) => frame.kind).sort(), ["app", "file"]);
  assert.deepEqual(appFramesOf(doc).map((frame) => frame.route), ["/pricing"]);
  assert.deepEqual(reported, [1280]);
});

test("3b: a chat that moves while entry reads its apps places nothing from the workspace it left, in either canvas", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  let workspace = "ws-1";
  const store = new DesignChatCanvases({ store: canvases.workspaceStore, workspaceIdOf: async () => workspace });
  const moving = { ...canvases, store };
  const { enter, reported } = liveEntry(moving, { onSnapshot: () => (workspace = "ws-2") });
  await enter({ id: "chat-1", title: "Chat", messages: wrote("app/pricing/page.tsx") }, workspaceRoot);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")), [], "nothing in the canvas it left");
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-2")), [], "nor ws-1's routes in the canvas it moved to");
  assert.deepEqual(reported, []);
});

test("3b: entry takes the newest 12 of one timeline of pages and routes", async (t) => {
  const pages = Array.from({ length: 10 }, (_, index) => `p${index}.html`);
  const { workspaceRoot, canvases } = await workspaceWith(t, pages);
  // Oldest first: p0 r0 p1 p2 r1 p3 p4 r2 p5 p6 r3 p7 p8 r4 p9.
  const timeline = ["p0", "r0", "p1", "p2", "r1", "p3", "p4", "r2", "p5", "p6", "r3", "p7", "p8", "r4", "p9"].map((name) =>
    name.startsWith("p") ? `design/${name}.html` : `app/${name}/page.tsx`,
  );
  const { enter } = liveEntry(canvases);
  await enter({ id: "chat-1", title: "Chat", messages: wrote(...timeline) }, workspaceRoot);
  const doc = await canvases.workspaceStore.get("ws-1");
  const shown = doc.frames.map((frame) => (frame.kind === "app" ? frame.route : frame.path)).sort();
  assert.deepEqual(
    shown,
    ["/r1", "/r2", "/r3", "/r4", ...["p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"].map((name) => `design/${name}.html`)].sort(),
    "p0, r0 and p1 are the three oldest and stay off",
  );
});

test("3b: a chat that wrote nothing in a single-app workspace gets the app's / on its empty page", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const first = liveEntry(canvases);
  await first.enter({ id: "chat-1", title: "A", messages: [] }, workspaceRoot);
  let doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(appFramesOf(doc), [{ appRoot: ".", route: "/", pageId: "page-1" }]);
  assert.deepEqual(first.reported, [1280]);

  // Chat B gets a page of its own, and its own /, though A's page shows / already.
  const second = liveEntry(canvases, { newId: () => "page-b" });
  await second.enter({ id: "chat-2", title: "B", messages: [] }, workspaceRoot);
  doc = await canvases.workspaceStore.get("ws-1");
  assert.deepEqual(appFramesOf(doc).map((frame) => frame.pageId).sort(), ["page-1", "page-b"]);

  // Entering again with a frame already there adds nothing.
  await liveEntry(canvases).enter({ id: "chat-1", title: "A", messages: [] }, workspaceRoot);
  assert.equal(appFramesOf(await canvases.workspaceStore.get("ws-1")).length, 2);
});

test("3b: no / when the page holds a note, the app has several roots or none, or the person removed it", async (t) => {
  const noted = await workspaceWith(t, []);
  await noted.canvases.store.update("chat-1", (doc) => withNoteFrame(doc));
  await liveEntry(noted.canvases).enter({ id: "chat-1", title: "A", messages: [] }, noted.workspaceRoot);
  assert.deepEqual(appFramesOf(await noted.canvases.workspaceStore.get("ws-1")), []);

  for (const target of ["choose", "none"] as const) {
    const other = await workspaceWith(t, []);
    await liveEntry(other.canvases, { target, candidates: [nextApp("apps/a"), nextApp("apps/b")] }).enter({ id: "chat-1", title: "A", messages: [] }, other.workspaceRoot);
    assert.deepEqual(appFramesOf(await other.canvases.workspaceStore.get("ws-1")), [], target);
  }

  const removed = await workspaceWith(t, []);
  await liveEntry(removed.canvases).enter({ id: "chat-1", title: "A", messages: [] }, removed.workspaceRoot);
  const placed = await removed.canvases.workspaceStore.get("ws-1");
  await removed.canvases.workspaceStore.save("ws-1", { ...placed, frames: [] }, placed.revision);
  await liveEntry(removed.canvases).enter({ id: "chat-1", title: "A", messages: [] }, removed.workspaceRoot);
  assert.deepEqual(appFramesOf(await removed.canvases.workspaceStore.get("ws-1")), []);
});

test("3b: a forgotten run's route files aren't placed; flag off, route files never are", async (t) => {
  const { workspaceRoot, canvases } = await workspaceWith(t, []);
  const recent = new RecentWrittenPages();
  recent.note("chat-1", "app/pricing/page.tsx");
  recent.forget("chat-1");
  // A note keeps the page non-empty, so no / fallback hides the answer.
  await canvases.store.update("chat-1", (doc) => withNoteFrame(doc));
  await liveEntry(canvases, { recent }).enter({ id: "chat-1", title: "A", messages: [] }, workspaceRoot);
  assert.deepEqual(appFramesOf(await canvases.workspaceStore.get("ws-1")), []);

  const off = await workspaceWith(t, []);
  await liveEntry(off.canvases, { live: false }).enter({ id: "chat-1", title: "A", messages: wrote("app/pricing/page.tsx") }, off.workspaceRoot);
  assert.deepEqual(appFramesOf(await off.canvases.workspaceStore.get("ws-1")), []);
});

function withNoteFrame(doc: DesignCanvas): DesignCanvas {
  return { ...doc, frames: [...doc.frames, { id: "note", kind: "note", title: "Note", text: "hi", x: 0, y: 0, w: 200, h: 120, pageId: "page-1", createdBy: "person" }] };
}
