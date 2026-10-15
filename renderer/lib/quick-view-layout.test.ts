import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_QUICK_VIEW_LAYOUT,
  dragTargetIndex,
  moveSection,
  parseQuickViewLayout,
  serializeQuickViewLayout,
  toggleSectionExpanded,
  type QuickViewLayout,
  type QuickViewSectionId,
} from "./quick-view-layout.js";

test("missing or corrupt storage falls back to the default layout", () => {
  assert.deepEqual(parseQuickViewLayout(null), DEFAULT_QUICK_VIEW_LAYOUT);
  assert.deepEqual(parseQuickViewLayout("{not json"), DEFAULT_QUICK_VIEW_LAYOUT);
  assert.deepEqual(parseQuickViewLayout('"a string"'), DEFAULT_QUICK_VIEW_LAYOUT);
});

test("unknown ids are dropped, duplicates collapse, and missing sections are appended", () => {
  const layout = parseQuickViewLayout(
    JSON.stringify({ order: ["changes", "mcp", "changes"], expanded: { changes: true, mcp: true } }),
  );
  assert.deepEqual(layout.order, ["changes", "environment", "context", "subagents"]);
  assert.deepEqual(layout.expanded, { changes: true });
});

test("a saved layout round-trips", () => {
  const layout: QuickViewLayout = {
    order: ["context", "environment", "changes", "subagents"],
    expanded: { environment: true },
  };
  assert.deepEqual(parseQuickViewLayout(serializeQuickViewLayout(layout)), layout);
});

test("moving within visible sections keeps a hidden section's place", () => {
  // Subagents is hidden (no runs); drag Context to the top.
  const start: QuickViewLayout = { order: ["environment", "changes", "subagents", "context"], expanded: {} };
  const visible: readonly QuickViewSectionId[] = ["environment", "changes", "context"];
  const next = moveSection(start, "context", 0, visible);
  assert.deepEqual(next.order, ["context", "environment", "changes", "subagents"]);
  assert.equal(next.order.length, 4);
});

test("every section starts collapsed and opening one leaves the rest closed", () => {
  assert.deepEqual(DEFAULT_QUICK_VIEW_LAYOUT.expanded, {});
  const once = toggleSectionExpanded(DEFAULT_QUICK_VIEW_LAYOUT, "changes");
  assert.deepEqual(once.expanded, { changes: true });
  assert.deepEqual(toggleSectionExpanded(once, "changes").expanded, {});
});

test("a tall card dragged up passes a short card once its top edge crosses the short card's midpoint", () => {
  const rects = [{ top: 0, height: 80 }, { top: 88, height: 160 }];
  assert.equal(dragTargetIndex(rects, 1, -40), 1); // top at 48 > midpoint 40
  assert.equal(dragTargetIndex(rects, 1, -50), 0); // top at 38 < 40
});

test("a card dragged down uses its bottom edge", () => {
  const rects = [{ top: 0, height: 160 }, { top: 168, height: 80 }, { top: 256, height: 80 }];
  assert.equal(dragTargetIndex(rects, 0, 40), 0); // bottom 200 < 208
  assert.equal(dragTargetIndex(rects, 0, 50), 1); // bottom 210 > 208
  assert.equal(dragTargetIndex(rects, 0, 500), 2);
});
