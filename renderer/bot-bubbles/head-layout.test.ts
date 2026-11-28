import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeTargetCentre,
  headX,
  isOverCloseTarget,
  miniChatPlacement,
  moveHeadWithKey,
  moveStackedHeadWithKey,
  peekPlacement,
  placeHeadInStack,
  releaseHead,
  shareToY,
  stackHeads,
  yToShare,
} from "./head-layout";

// A 1000×800 area: heads are 52px, 14px from the edges, so a right head's left
// edge is 934 and the lowest top edge is 734.
const AREA = { width: 1000, height: 800 };

test("heads sit 14px in from their side", () => {
  assert.equal(headX("left", AREA), 14);
  assert.equal(headX("right", AREA), 934);
});

test("a saved share maps to the head's top edge over the area height less one head; the stack keeps the margins", () => {
  assert.equal(shareToY(0.5, AREA), 374);
  assert.equal(shareToY(0, AREA), 0);
  assert.equal(shareToY(1, AREA), 748);
  const drawn = stackHeads(
    [
      { id: "top", side: "left", y: shareToY(0, AREA) },
      { id: "bottom", side: "right", y: shareToY(1, AREA) },
    ],
    AREA,
  );
  assert.equal(drawn.get("top")?.y, 14, "the top margin holds at share 0");
  assert.equal(drawn.get("bottom")?.y, 734, "the bottom margin holds at share 1");
  assert.equal(yToShare(374, AREA), 0.5);
  assert.equal(yToShare(5000, AREA), 1);
  // The same share lands proportionally lower on a taller display.
  assert.equal(shareToY(0.5, { width: 1000, height: 1052 }), 500);
});

test("heads on one side never overlap: a later head is pushed below with a 12px gap", () => {
  const placed = stackHeads(
    [
      { id: "a", side: "right", y: 100 },
      { id: "b", side: "right", y: 110 },
      { id: "c", side: "left", y: 110 },
    ],
    AREA,
  );
  assert.deepEqual(placed.get("a"), { x: 934, y: 100 });
  assert.deepEqual(placed.get("b"), { x: 934, y: 164 });
  assert.deepEqual(placed.get("c"), { x: 14, y: 110 }, "the other side is a separate stack");
});

test("a stack that runs past the bottom is pushed back up to fit", () => {
  const placed = stackHeads(
    [
      { id: "a", side: "right", y: 730 },
      { id: "b", side: "right", y: 730 },
      { id: "c", side: "right", y: 730 },
    ],
    AREA,
  );
  assert.deepEqual(
    ["a", "b", "c"].map((id) => placed.get(id)?.y),
    [606, 670, 734],
  );
});

test("a release picks the side from where the head is headed, and a flick throws it", () => {
  assert.deepEqual(releaseHead({ x: 600, y: 300 }, { x: 0, y: 0 }, AREA), {
    side: "right",
    y: 300,
  });
  // Centre at 626, thrown left at 1px/ms: 160px further it is at 466, past the middle.
  assert.deepEqual(releaseHead({ x: 600, y: 300 }, { x: -1, y: 0 }, AREA), {
    side: "left",
    y: 300,
  });
  // Carried 0.5px/ms × 120ms = 60px down.
  assert.deepEqual(releaseHead({ x: 100, y: 300 }, { x: 0, y: 0.5 }, AREA), {
    side: "left",
    y: 360,
  });
  // Thrown past the bottom it stays inside the area; the stack draws it on the margin.
  assert.deepEqual(releaseHead({ x: 100, y: 780 }, { x: 0, y: 2 }, AREA), { side: "left", y: 748 });
});

test("the × target sits centred 92px above the bottom and pulls a head within 84px", () => {
  assert.deepEqual(closeTargetCentre(AREA), { x: 500, y: 708 });
  assert.equal(isOverCloseTarget({ x: 474, y: 682 }, AREA), true, "centred on the target");
  assert.equal(isOverCloseTarget({ x: 474, y: 598 }, AREA), true, "84px above it");
  assert.equal(isOverCloseTarget({ x: 474, y: 597 }, AREA), false, "85px above it");
});

test("arrow keys switch sides or move a head 40px, never past the margins", () => {
  assert.deepEqual(moveHeadWithKey({ side: "right", y: 300 }, "ArrowLeft", AREA), {
    side: "left",
    y: 300,
  });
  assert.deepEqual(moveHeadWithKey({ side: "left", y: 300 }, "ArrowRight", AREA), {
    side: "right",
    y: 300,
  });
  assert.deepEqual(moveHeadWithKey({ side: "right", y: 300 }, "ArrowDown", AREA), {
    side: "right",
    y: 340,
  });
  assert.deepEqual(moveHeadWithKey({ side: "right", y: 30 }, "ArrowUp", AREA), {
    side: "right",
    y: 14,
  });
  assert.deepEqual(moveHeadWithKey({ side: "right", y: 720 }, "ArrowDown", AREA), {
    side: "right",
    y: 734,
  });
});

test("the mini chat opens beside a right head, toward the middle, with its pointer on the head's centre", () => {
  assert.deepEqual(miniChatPlacement({ x: 934, y: 300 }, "right", AREA), {
    x: 580,
    y: 272,
    width: 340,
    height: 440,
    caretSide: "right",
    caretY: 54,
  });
});

test("a mini chat near the bottom stays inside the area and its pointer still finds the head", () => {
  const placement = miniChatPlacement({ x: 934, y: 700 }, "right", AREA);
  assert.equal(placement.y, 346, "800 − 14 − 440");
  assert.equal(placement.caretY, 380, "the head's centre (726) less the chat's top");
});

test("in a small area the mini chat shrinks to fit beside a left head", () => {
  assert.deepEqual(miniChatPlacement({ x: 14, y: 14 }, "left", { width: 400, height: 300 }), {
    x: 80,
    y: 14,
    width: 306,
    height: 272,
    caretSide: "left",
    caretY: 26,
  });
});

test("the peek sits 10px inside a head, centred on it, at most 230px wide", () => {
  assert.deepEqual(peekPlacement({ x: 934, y: 300 }, "right", AREA), {
    side: "right",
    x: 924,
    y: 326,
    maxWidth: 230,
  });
  assert.deepEqual(peekPlacement({ x: 14, y: 14 }, "left", { width: 200, height: 300 }), {
    side: "left",
    x: 76,
    y: 40,
    maxWidth: 110,
  });
});

test("Up and Down on a stacked head step past its neighbour instead of sticking behind it", () => {
  const heads = [
    { id: "a", side: "right" as const, y: 100 },
    { id: "b", side: "right" as const, y: 110 },
  ];
  // b shows at 164, under a at 100: 40px up would land on a, so it jumps above it.
  const up = moveStackedHeadWithKey(heads, "b", "ArrowUp", AREA)!;
  assert.deepEqual(up, { side: "right", y: 36 });
  const swapped = stackHeads([heads[0]!, { id: "b", ...up }], AREA);
  assert.deepEqual([swapped.get("b")?.y, swapped.get("a")?.y], [36, 100]);
  // a at 100 moving down jumps below b (164 + 64).
  assert.deepEqual(moveStackedHeadWithKey(heads, "a", "ArrowDown", AREA), {
    side: "right",
    y: 228,
  });
  // With room, a plain 40px step.
  assert.deepEqual(
    moveStackedHeadWithKey([{ id: "c", side: "left", y: 300 }], "c", "ArrowUp", AREA),
    { side: "left", y: 260 },
  );
});

test("at the top margin, Up still moves a head ahead of the one above it", () => {
  const heads = [
    { id: "a", side: "right" as const, y: 14 },
    { id: "b", side: "right" as const, y: 30 },
  ];
  const up = moveStackedHeadWithKey(heads, "b", "ArrowUp", AREA)!;
  const placed = stackHeads([heads[0]!, { id: "b", ...up }], AREA);
  assert.deepEqual([placed.get("b")?.y, placed.get("a")?.y], [14, 78]);
});

type Head = { id: string; side: "left" | "right"; y: number };

/** What main saves and sends back: a share of the area height less one head. */
function roundTrip(heads: Head[]): Head[] {
  return heads.map((head) => ({ ...head, y: shareToY(yToShare(head.y, AREA), AREA) }));
}

function drawnOrder(heads: Head[]) {
  const drawn = stackHeads(heads, AREA);
  return [...drawn.entries()].sort((a, b) => a[1].y - b[1].y).map(([id, at]) => `${id}@${at.y}`);
}

test("a head moved above a neighbour on the top margin stays above it once saved", () => {
  // a was put first, on the top margin; b shows under it.
  let heads: Head[] = [
    { id: "a", side: "right", y: 14 },
    { id: "b", side: "right", y: 30 },
  ];
  const up = moveStackedHeadWithKey(heads, "b", "ArrowUp", AREA)!;
  heads = roundTrip([heads[0]!, { id: "b", ...up }]);
  assert.deepEqual(drawnOrder(heads), ["b@14", "a@78"]);
  // A third head stepped up one place at a time ends up on top too.
  heads = [...heads, { id: "c", side: "right", y: 300 }];
  const pressUp = () => {
    const next = moveStackedHeadWithKey(heads, "c", "ArrowUp", AREA)!;
    heads = roundTrip(heads.map((head) => (head.id === "c" ? { id: "c", ...next } : head)));
  };
  for (let press = 0; press < 4; press += 1) pressUp(); // 260, 220, 180, then past a
  assert.deepEqual(drawnOrder(heads), ["b@14", "c@78", "a@142"]);
  pressUp();
  assert.deepEqual(drawnOrder(heads), ["c@14", "b@78", "a@142"]);
});

test("a head moved below a neighbour on the bottom margin stays below it once saved", () => {
  let heads: Head[] = [
    { id: "a", side: "left", y: 734 },
    { id: "b", side: "left", y: 700 },
  ];
  assert.deepEqual(drawnOrder(heads), ["b@670", "a@734"]);
  const down = moveStackedHeadWithKey(heads, "b", "ArrowDown", AREA)!;
  heads = roundTrip([heads[0]!, { id: "b", ...down }]);
  assert.deepEqual(drawnOrder(heads), ["a@670", "b@734"]);
});

test("heads dropped one after another past the top edge stack newest first, and keep that order once saved", () => {
  let heads: Head[] = [
    { id: "a", side: "right", y: 400 },
    { id: "b", side: "right", y: 500 },
  ];
  for (const id of ["a", "b"]) {
    const spot = placeHeadInStack(
      heads,
      id,
      releaseHead({ x: 934, y: -40 }, { x: 0, y: 0 }, AREA),
      AREA,
    );
    heads = roundTrip(heads.map((head) => (head.id === id ? { id, ...spot } : head)));
  }
  assert.deepEqual(drawnOrder(heads), ["b@14", "a@78"]);
  // A drop in open space keeps exactly where it was put.
  assert.deepEqual(placeHeadInStack(heads, "a", { side: "right", y: 300 }, AREA), {
    side: "right",
    y: 300,
  });
});
