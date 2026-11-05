import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvasV1, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import { placeArtifactFrames, placeArtifactsOnCanvas } from "./artifact-frames.js";
import { DesignCanvasStore } from "./store.js";

const ids = () => {
  let next = 0;
  return () => `frame-${++next}`;
};

function canvas(frames: DesignFrame[]): DesignCanvasV1 {
  return { ...emptyDesignCanvas(), frames };
}

test("a new visual lands beside what is in view, as Aiden's artifact frame", () => {
  const page: DesignFrame = { id: "p", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, createdBy: "person" };
  const { doc, changed } = placeArtifactFrames(canvas([page]), [{ mediaId: "m1", title: "Pricing table" }], ids());
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
  const moved: DesignCanvasV1 = { ...first, frames: [{ ...first.frames[0]!, x: 4000, y: -200, w: 900, h: 700 }] };
  const { doc, changed } = placeArtifactFrames(moved, [{ mediaId: "m2", title: "Chart" }], ids());
  assert.equal(changed, true);
  assert.equal(doc.frames.length, 1);
  assert.deepEqual(
    { id: doc.frames[0]!.id, mediaId: doc.frames[0]!.mediaId, x: doc.frames[0]!.x, y: doc.frames[0]!.y, w: doc.frames[0]!.w, h: doc.frames[0]!.h },
    { id: first.frames[0]!.id, mediaId: "m2", x: 4000, y: -200, w: 900, h: 700 },
  );
});

test("a person's frame with the same title is never swapped, and a visual already there changes nothing", () => {
  const mine: DesignFrame = { id: "mine", kind: "artifact", title: "Chart", mediaId: "m0", x: 0, y: 0, w: 640, h: 480, createdBy: "person" };
  const { doc } = placeArtifactFrames(canvas([mine]), [{ mediaId: "m1", title: "Chart" }], ids());
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frames[0]!.mediaId, "m0");

  const again = placeArtifactFrames(doc, [{ mediaId: "m1", title: "Chart" }], ids());
  assert.equal(again.changed, false);
  assert.equal(again.doc, doc);
});

test("several visuals in one reply land in a row without stacking", () => {
  const { doc } = placeArtifactFrames(
    canvas([]),
    [{ mediaId: "a", title: "A" }, { mediaId: "b", title: "B" }, { mediaId: "c", title: "C" }],
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
  assert.deepEqual(doc.frames.map((frame) => frame.mediaId), ["m2"]);
  assert.deepEqual(broadcasts, [1, 2]);
});
