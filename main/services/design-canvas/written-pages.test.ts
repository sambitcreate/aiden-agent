import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import {
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
  for (let index = 0; index < 20; index += 1) recent.note("chat-1", `design/p${index}.html`);
  const merged = recent.merged("chat-1", ["design/old.html"]);
  assert.equal(merged.length, 12);
  assert.equal(merged[merged.length - 1], "design/p19.html");
  recent.forget("chat-1");
  assert.deepEqual(recent.merged("chat-1", ["design/old.html"]), ["design/old.html"]);
  assert.deepEqual(recent.merged("chat-2", []), ["design/other.html"]);
});
