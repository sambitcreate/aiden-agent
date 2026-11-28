import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvas,
  type DesignFrame,
} from "../../../renderer/shared/design-canvas/schema.js";
import {
  placeArtifactFrames,
  placeArtifactsOnCanvas,
  placeImageFrames,
  placeImagesOnCanvas,
} from "./artifact-frames.js";
import { DesignCanvasStore } from "./store.js";

const ids = () => {
  let next = 0;
  return () => `frame-${++next}`;
};

function canvas(frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), frames };
}

test("a new visual lands beside what is in view, as Aiden's artifact frame", () => {
  const page: DesignFrame = {
    id: "p",
    kind: "file",
    title: "Home",
    path: "design/home.html",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    designWidth: 1280,
    pageId: "page-1",
    createdBy: "person",
  };
  const { doc, changed } = placeArtifactFrames(
    canvas([page]),
    [{ mediaId: "m1", title: "Pricing table" }],
    ids(),
  );
  assert.equal(changed, true);
  const placed = doc.frames[1]!;
  assert.equal(placed.kind, "artifact");
  assert.equal(placed.mediaId, "m1");
  assert.equal(placed.title, "Pricing table");
  assert.equal(placed.createdBy, "aiden");
  assert.ok(placed.x >= page.x + page.w, "it does not cover the person's page");
});

test("drawing a visual again under the same title swaps its media and keeps where the person put it", () => {
  const first = placeArtifactFrames(canvas([]), [{ mediaId: "m1", title: "Chart" }], ids()).doc;
  const moved: DesignCanvas = {
    ...first,
    frames: [{ ...first.frames[0]!, x: 4000, y: -200, w: 900, h: 700 }],
  };
  const { doc, changed } = placeArtifactFrames(moved, [{ mediaId: "m2", title: "Chart" }], ids());
  assert.equal(changed, true);
  assert.equal(doc.frames.length, 1);
  assert.deepEqual(
    {
      id: doc.frames[0]!.id,
      mediaId: doc.frames[0]!.mediaId,
      x: doc.frames[0]!.x,
      y: doc.frames[0]!.y,
      w: doc.frames[0]!.w,
      h: doc.frames[0]!.h,
    },
    { id: first.frames[0]!.id, mediaId: "m2", x: 4000, y: -200, w: 900, h: 700 },
  );
});

test("a person's frame with the same title is never swapped, and a visual already there changes nothing", () => {
  const mine: DesignFrame = {
    id: "mine",
    kind: "artifact",
    title: "Chart",
    mediaId: "m0",
    x: 0,
    y: 0,
    w: 640,
    h: 480,
    pageId: "page-1",
    createdBy: "person",
  };
  const { doc } = placeArtifactFrames(canvas([mine]), [{ mediaId: "m1", title: "Chart" }], ids());
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frames[0]!.mediaId, "m0");

  const again = placeArtifactFrames(doc, [{ mediaId: "m1", title: "Chart" }], ids());
  assert.equal(again.changed, false);
  assert.equal(again.doc, doc);
});

test("a locked frame or one on another page keeps its visual, and two visuals of one reply never share a frame", () => {
  const aiden = (id: string, extra: Partial<DesignFrame> = {}): DesignFrame => ({
    id,
    kind: "artifact",
    title: "Chart",
    mediaId: `old-${id}`,
    x: 0,
    y: 0,
    w: 640,
    h: 480,
    pageId: "page-1",
    createdBy: "aiden",
    ...extra,
  });
  const withPages = (frames: DesignFrame[]): DesignCanvas => ({
    ...canvas(frames),
    pages: [
      ...emptyDesignCanvas().pages,
      { id: "page-2", name: "Archive", viewport: { x: 0, y: 0, zoom: 1 } },
    ],
  });

  const locked = placeArtifactFrames(
    withPages([aiden("pinned", { locked: true })]),
    [{ mediaId: "m1", title: "Chart" }],
    ids(),
  ).doc;
  assert.equal(locked.frames.find((frame) => frame.id === "pinned")!.mediaId, "old-pinned");
  assert.equal(
    locked.frames.filter((frame) => frame.mediaId === "m1").length,
    1,
    "the new visual gets its own frame",
  );

  const elsewhere = placeArtifactFrames(
    withPages([aiden("archived", { pageId: "page-2" })]),
    [{ mediaId: "m1", title: "Chart" }],
    ids(),
  ).doc;
  assert.equal(elsewhere.frames.find((frame) => frame.id === "archived")!.mediaId, "old-archived");
  assert.equal(
    elsewhere.frames.find((frame) => frame.mediaId === "m1")!.pageId,
    "page-1",
    "it lands on the page on screen",
  );

  // One earlier frame titled Chart, then two new visuals titled Chart in one reply: the first swaps in, the second is new.
  const twice = placeArtifactFrames(
    withPages([aiden("earlier")]),
    [
      { mediaId: "a", title: "Chart" },
      { mediaId: "b", title: "Chart" },
    ],
    ids(),
  ).doc;
  assert.deepEqual(twice.frames.map((frame) => frame.mediaId).sort(), ["a", "b"]);
  assert.equal(twice.frames.find((frame) => frame.id === "earlier")!.mediaId, "a");

  // On a fresh canvas, two same-titled visuals of one reply land in two frames.
  const fresh = placeArtifactFrames(
    canvas([]),
    [
      { mediaId: "a", title: "Chart" },
      { mediaId: "b", title: "Chart" },
    ],
    ids(),
  ).doc;
  assert.equal(fresh.frames.length, 2);
});

test("several visuals in one reply land in a row without stacking", () => {
  const { doc } = placeArtifactFrames(
    canvas([]),
    [
      { mediaId: "a", title: "A" },
      { mediaId: "b", title: "B" },
      { mediaId: "c", title: "C" },
    ],
    ids(),
  );
  const boxes = doc.frames.map(({ x, y, w, h }) => ({ x, y, w, h }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i]!, boxes[j]!];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${doc.frames[i]!.title} and ${doc.frames[j]!.title} overlap`);
    }
  }
});

test("the stored canvas is saved and announced only when a visual actually changed it", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-frames-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new DesignCanvasStore({ root: () => base });
  const broadcasts: number[] = [];
  const place = (mediaId: string, title: string) =>
    placeArtifactsOnCanvas({
      chatId: "chat-1",
      artifacts: [{ mediaId, title }],
      store,
      broadcast: (update) => broadcasts.push(update.revision),
      newId: ids(),
    });

  assert.equal(await place("m1", "Chart"), true);
  assert.equal(await place("m1", "Chart"), false);
  assert.equal(await place("m2", "Chart"), true);
  const doc = await store.get("chat-1");
  assert.deepEqual(
    doc.frames.map((frame) => frame.mediaId),
    ["m2"],
  );
  assert.deepEqual(broadcasts, [1, 2]);
});

test("a saved image lands in its own image frame with the image's shape, and the same file keeps its frame", () => {
  const page: DesignFrame = {
    id: "p",
    kind: "file",
    title: "Home",
    path: "design/home.html",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    designWidth: 1280,
    pageId: "page-1",
    createdBy: "person",
  };
  const wide = placeImageFrames(
    canvas([page]),
    [
      { path: "design/assets/hero.png", width: 1536, height: 1024 },
      { path: "design/assets/hero-2.png", width: 1024, height: 1536 },
    ],
    ids(),
  );
  assert.equal(wide.changed, true);
  assert.deepEqual(wide.frameIds, ["frame-1", "frame-2"]);
  const [landscape, portrait] = [wide.doc.frames[1]!, wide.doc.frames[2]!];
  assert.equal(landscape.kind, "image");
  assert.equal(landscape.path, "design/assets/hero.png");
  assert.equal(landscape.title, "hero.png");
  assert.equal(landscape.createdBy, "aiden");
  assert.ok(
    landscape.w > landscape.h && portrait.h > portrait.w,
    "each frame keeps its image's orientation",
  );
  assert.ok(Math.abs(landscape.w / landscape.h - 1.5) < 0.02);
  assert.ok(
    landscape.x >= page.x + page.w || landscape.y >= page.y + page.h,
    "it does not cover the person's page",
  );

  // Generating hero.png again replaces the file; its frame stays where the person put it.
  const moved: DesignCanvas = {
    ...wide.doc,
    frames: wide.doc.frames.map((frame) =>
      frame.id === "frame-1" ? { ...frame, x: 3000 } : frame,
    ),
  };
  const again = placeImageFrames(
    moved,
    [{ path: "design/assets/hero.png", width: 1536, height: 1024 }],
    ids(),
  );
  assert.equal(again.changed, false);
  assert.deepEqual(again.frameIds, ["frame-1"]);
  assert.equal(again.doc.frames.find((frame) => frame.id === "frame-1")!.x, 3000);
});

test("saved images are placed on the stored canvas only while the late check still allows it", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-frames-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new DesignCanvasStore({ root: () => base });
  const broadcasts: number[] = [];
  let designModeOn = false;
  const place = () =>
    placeImagesOnCanvas({
      chatId: "chat-1",
      images: [{ path: "design/assets/logo.webp", width: 512, height: 512 }],
      store,
      broadcast: (update) => broadcasts.push(update.revision),
      newId: ids(),
      shouldSave: async () => designModeOn,
    });

  assert.equal(await place(), null);
  assert.deepEqual((await store.get("chat-1")).frames, []);
  designModeOn = true;
  assert.deepEqual(await place(), ["frame-1"]);
  assert.deepEqual(await place(), ["frame-1"], "the same file is not placed twice");
  assert.deepEqual(broadcasts, [1]);
  const [frame] = (await store.get("chat-1")).frames;
  assert.equal(frame!.w, frame!.h);
});
