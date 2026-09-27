import assert from "node:assert/strict";
import test from "node:test";
import {
  chatRowState,
  isChatRowState,
  isChatUnread,
  parseChatReadMarkersSnapshot,
} from "./chat-row-state.js";

test("a blocking prompt outranks work even when the activity signal lags", () => {
  assert.equal(
    chatRowState({ active: true, needsApproval: true, needsInput: true }),
    "needs_approval",
  );
  assert.equal(
    chatRowState({ active: false, needsApproval: false, needsInput: true }),
    "needs_input",
  );
  assert.equal(chatRowState({ active: true, needsApproval: false, needsInput: false }), "working");
  assert.equal(chatRowState({ active: false, needsApproval: false, needsInput: false }), "idle");
  assert.equal(isChatRowState("working"), true);
  assert.equal(isChatRowState("active"), false);
});

test("unread requires assistant output newer than both the baseline and the last view", () => {
  const markers = { baselineAt: 100, readThrough: { seen: 300 } };
  assert.equal(isChatUnread(50, markers, "fresh"), false);
  assert.equal(isChatUnread(150, markers, "fresh"), true);
  assert.equal(isChatUnread(300, markers, "seen"), false);
  assert.equal(isChatUnread(301, markers, "seen"), true);
  assert.equal(isChatUnread(undefined, markers, "fresh"), false);
  assert.equal(isChatUnread(500, null, "fresh"), false);
});

test("read marker snapshots reject unsafe keys and malformed timestamps", () => {
  assert.deepEqual(
    parseChatReadMarkersSnapshot({ revision: 2, baselineAt: 5, readThrough: { a: 9 } }),
    { revision: 2, baselineAt: 5, readThrough: { a: 9 } },
  );
  for (const value of [
    null,
    { revision: 1, baselineAt: 5, readThrough: [] },
    { revision: 1, baselineAt: -5, readThrough: {} },
    { revision: 1, baselineAt: 5, readThrough: { "../a": 9 } },
    { revision: 1, baselineAt: 5, readThrough: { a: "9" } },
  ]) {
    assert.equal(parseChatReadMarkersSnapshot(value), null);
  }
});

test("snapshot message sequence survives parsing and rejects orphan or invalid positions", () => {
  const snapshot = {
    revision: 1,
    baselineAt: 1,
    readThrough: { a: 10 },
    readThroughSequence: { a: 2 },
  };
  assert.deepEqual(parseChatReadMarkersSnapshot(snapshot), snapshot);
  assert.equal(isChatUnread(10, snapshot, "a", 3), true);
  assert.equal(isChatUnread(10, snapshot, "a", 2), false);
  for (const readThroughSequence of [{ a: -1 }, { missing: 2 }, [], null]) {
    assert.equal(parseChatReadMarkersSnapshot({ ...snapshot, readThroughSequence }), null);
  }
});
