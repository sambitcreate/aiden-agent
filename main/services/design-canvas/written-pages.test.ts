import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import {
  createDesignPageScanner,
  DESIGN_WIDTH_HINT_BYTES,
  EARLIER_PAGES_LIMIT,
  inferDesignWidth,
  readDesignWidthHint,
  RECENT_WRITTEN_PAGES_LIMIT,
  RecentWrittenPages,
  pagesWrittenInChat,
  placeWrittenPageFrames,
  placeWrittenPagesOnCanvas,
  writtenPagePath,
} from "./written-pages.js";
import { DesignCanvasStore } from "./store.js";

const ids = () => {
  let next = 0;
  return () => `frame-${++next}`;
};

function canvas(frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), frames };
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
  );
  assert.equal(changed, true);
  assert.deepEqual(placedIds, ["frame-1"]);
  const placed = doc.frames.find((frame) => frame.id === "frame-1")!;
  assert.deepEqual(
    { kind: placed.kind, path: placed.path, title: placed.title, createdBy: placed.createdBy, pageId: placed.pageId },
    { kind: "file", path: "design/02-library.html", title: "02-library.html", createdBy: "aiden", pageId: "page-1" },
  );
  assert.ok(placed.x >= mine.x + mine.w, "it does not cover the person's page");

  const again = placeWrittenPageFrames(doc, ["design/02-library.html"], ids());
  assert.equal(again.changed, false);
  assert.equal(again.doc, doc);
});

test("several pages written in one reply land in a row without stacking", () => {
  const { doc } = placeWrittenPageFrames(canvas([]), ["design/a.html", "design/b.html", "design/c.html"], ids());
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

test("only pages that exist are placed, the canvas is saved once per change, and a filled canvas is not refilled on entry", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "home.html"), "<!doctype html><title>Home</title>");
  await fs.writeFile(path.join(workspaceRoot, "design", "notes.txt"), "not a page");
  const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  const broadcasts: number[] = [];
  const newId = ids();
  const place = (paths: string[], onlyIfEmpty = false) =>
    placeWrittenPagesOnCanvas({
      chatId: "chat-1",
      workspaceRoot,
      paths,
      store,
      broadcast: (update) => broadcasts.push(update.revision),
      newId,
      onlyIfEmpty,
    });

  assert.deepEqual(await place(["design/missing.html", "design/notes.txt"]), []);
  assert.deepEqual(await place(["design/home.html"]), ["frame-1"]);
  assert.deepEqual(await place(["design/home.html"]), [], "an edit to a page already there changes nothing");

  await fs.writeFile(path.join(workspaceRoot, "design", "library.html"), "<!doctype html><title>Library</title>");
  assert.deepEqual(await place(["design/library.html"], true), [], "entry leaves a canvas with frames alone");
  assert.deepEqual(await place(["design/library.html"]), ["frame-2"]);

  const doc = await store.get("chat-1");
  assert.deepEqual(doc.frames.map((frame) => frame.path), ["design/home.html", "design/library.html"]);
  assert.deepEqual(broadcasts, [1, 2]);
});

test("a page the person takes off the canvas is not put back when Aiden writes it again, until Aiden places it or the person adds it", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  for (const name of ["home", "about"]) await fs.writeFile(path.join(workspaceRoot, "design", `${name}.html`), "<!doctype html><title>x</title>");
  const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  const removedSeen: string[][] = [];
  const newId = ids();
  const place = (paths: string[]) =>
    placeWrittenPagesOnCanvas({
      chatId: "chat-1",
      workspaceRoot,
      paths,
      store,
      broadcast: () => undefined,
      newId,
      onRemoved: (removed) => removedSeen.push([...removed]),
    });
  const [homeId] = await place(["design/home.html"]);
  const [aboutId] = await place(["design/about.html"]);

  // Aiden's own removal is not the person's: the page comes back on the next write.
  await store.update("chat-1", (doc) => ({ ...doc, frames: doc.frames.filter((frame) => frame.id !== aboutId) }));
  assert.equal((await place(["design/about.html"])).length, 1);

  // The person deletes home.html's frame on their canvas (a save), then Aiden edits the page twice.
  const before = await store.get("chat-1");
  const saved = await store.save("chat-1", { ...before, frames: before.frames.filter((frame) => frame.id !== homeId) }, before.revision);
  assert.equal(saved.ok, true);
  assert.deepEqual(await place(["design/home.html"]), []);
  assert.deepEqual(await place(["design/home.html"]), []);
  assert.deepEqual(removedSeen, [["design/home.html"], ["design/home.html"]]);
  assert.equal((await store.get("chat-1")).frames.some((frame) => frame.path === "design/home.html"), false);

  // Placing it on purpose (any frame showing it again) clears the memory, and later writes land as before.
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [...doc.frames, { id: "again", kind: "file", title: "home.html", path: "design/home.html", x: 0, y: 3000, w: 640, h: 436, designWidth: 1280, pageId: doc.activePageId, createdBy: "aiden" }],
  }));
  assert.equal((await store.get("chat-1")).removedPagePaths, undefined);
  const again = await store.get("chat-1");
  await store.save("chat-1", { ...again, frames: again.frames.filter((frame) => frame.id !== "again") }, again.revision);
  assert.deepEqual((await store.get("chat-1")).removedPagePaths, ["design/home.html"]);
  // The person adding it back, even through a canvas that never knew the list, clears it too.
  const cleared = await store.get("chat-1");
  const { removedPagePaths: _list, ...withoutList } = cleared;
  await store.save("chat-1", { ...withoutList, frames: [...cleared.frames, { ...again.frames.find((frame) => frame.id === "again")!, id: "mine", createdBy: "person" }] }, cleared.revision);
  assert.equal((await store.get("chat-1")).removedPagePaths, undefined);
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
  const store = new DesignCanvasStore({ root: () => canvasesDir });
  const broadcasts: string[] = [];

  // First simulate deleting the chat (or leaving design mode) before store.update runs.
  let canSave = false;
  const abortedIds = await placeWrittenPagesOnCanvas({
    chatId: "deleted-chat",
    workspaceRoot,
    paths: recent.merged("chat-1", saved),
    limit: EARLIER_PAGES_LIMIT,
    shouldSave: () => canSave,
    store,
    broadcast: (update) => broadcasts.push(`${update.chatId}:${update.revision}`),
    newId: ids(),
    onlyIfEmpty: true,
  });
  assert.deepEqual(abortedIds, [] as string[]);
  assert.deepEqual(broadcasts, [] as string[]);
  await assert.rejects(fs.stat(path.join(canvasesDir, "deleted-chat.json")), { code: "ENOENT" });

  // Now allow saving and verify all 12 surviving older pages land oldest-to-newest.
  canSave = true;
  const placedIds = await placeWrittenPagesOnCanvas({
    chatId: "chat-1",
    workspaceRoot,
    paths: recent.merged("chat-1", saved),
    limit: EARLIER_PAGES_LIMIT,
    shouldSave: () => canSave,
    store,
    broadcast: (update) => broadcasts.push(`${update.chatId}:${update.revision}`),
    newId: ids(),
    onlyIfEmpty: true,
  });
  assert.equal(placedIds.length, EARLIER_PAGES_LIMIT);
  const doc = await store.get("chat-1");
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
  const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  let designMode = true;
  const broadcasts: number[] = [];
  const placedIds = await placeWrittenPagesOnCanvas({
    chatId: "chat-1",
    workspaceRoot,
    paths: ["design/home.html"],
    // The person leaves design mode once the save is already under way.
    store: {
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
  assert.deepEqual(placedIds, [] as string[]);
  assert.deepEqual(broadcasts, [] as number[]);
  assert.deepEqual((await store.get("chat-1")).frames, []);
});

test("leaving design mode while the page's file is being written takes the frame back off, unless the mode is on again", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-written-pages-exit-write-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(path.join(workspaceRoot, "design"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "design", "home.html"), "<!doctype html><title>Home</title>");
  const run = async (chatId: string, backOnBeforeRetract: boolean) => {
    const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
    let designMode = true;
    let calls = 0;
    const broadcasts: number[] = [];
    const placedIds = await placeWrittenPagesOnCanvas({
      chatId,
      workspaceRoot,
      paths: ["design/home.html"],
      store: {
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
    return { placedIds, broadcasts, frames: (await store.get(chatId)).frames.map((frame) => frame.path) };
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
  const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  await placeWrittenPagesOnCanvas({
    chatId: "chat-1",
    workspaceRoot,
    paths: ["design/phone.html", "design/tablet.html", "design/desk.html"],
    store,
    broadcast: () => undefined,
    newId: ids(),
  });
  const doc = await store.get("chat-1");
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
