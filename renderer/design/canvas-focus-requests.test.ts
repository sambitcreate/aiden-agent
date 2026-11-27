// Aiden's focus requests as the canvas receives them over IPC.

import assert from "node:assert/strict";
import test from "node:test";
import { canvasFocusFrom, focusYieldsToPerson, type CanvasFocusRequest } from "./canvas-focus-requests.js";

test("canvasFocusFrom keeps a string pageId and a focusId, and drops anything else", () => {
  const full = canvasFocusFrom({ chatId: "chat-1", pageId: "p2", frameIds: ["a", 7, "b"], focusId: 3 });
  assert.equal(full?.chatId, "chat-1");
  assert.deepEqual(
    { ids: full?.request.ids, pageId: full?.request.pageId, focusId: full?.request.focusId },
    { ids: ["a", "b"], pageId: "p2", focusId: 3 },
  );
  for (const [pageId, focusId] of [[42, "3"], ["", -1], [null, 1.5], [{ id: "p2" }, Number.NaN]] as const) {
    const parsed = canvasFocusFrom({ chatId: "chat-1", pageId, frameIds: [], focusId });
    assert.ok(parsed, "the request itself still stands");
    assert.equal("pageId" in parsed.request, false, JSON.stringify(pageId));
    assert.equal("focusId" in parsed.request, false, String(focusId));
  }
  assert.equal(canvasFocusFrom({ pageId: "p2", frameIds: [] }), null, "no chat, no request");
  assert.equal(canvasFocusFrom("p2"), null);
});

test("canvasFocusFrom marks a request as the person's own only for own: true", () => {
  assert.equal(canvasFocusFrom({ chatId: "chat-1", frameIds: ["a"], own: true })?.request.own, true);
  for (const own of [false, "true", 1, undefined]) {
    assert.equal("own" in canvasFocusFrom({ chatId: "chat-1", frameIds: ["a"], own })!.request, false, String(own));
  }
});

test("Aiden's focus waits out the person's recent canvas work; the person's own Add is shown at once", () => {
  const aiden: CanvasFocusRequest = { ids: ["a"], at: 0 };
  const own = { ids: ["a"], at: 0, own: true as const };
  const quiet = { gesture: false, sinceInteractionMs: 10_000, quietMs: 3_000 };
  const busy = { gesture: false, sinceInteractionMs: 200, quietMs: 3_000 };
  const dragging = { gesture: true, sinceInteractionMs: 10_000, quietMs: 3_000 };
  assert.deepEqual(
    [quiet, busy, dragging].map((person) => [focusYieldsToPerson(aiden, person), focusYieldsToPerson(own, person)]),
    [
      [false, false],
      [true, false],
      [true, false],
    ],
  );
});
