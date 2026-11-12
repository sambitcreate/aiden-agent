import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import {
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
