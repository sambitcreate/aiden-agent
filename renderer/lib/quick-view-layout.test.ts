import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_QUICK_VIEW_LAYOUT,
  dragTargetIndex,
  moveSection,
  parseQuickViewLayout,
  quickViewVisibleSections,
  serializeQuickViewLayout,
  toggleSectionExpanded,
  type QuickViewLayout,
  type QuickViewSectionId,
  type QuickViewVisibilityInput,
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

test("a hidden section at the front stays at the front when visible cards reorder", () => {
  const start: QuickViewLayout = { order: ["subagents", "environment", "changes", "context"], expanded: {} };
  const visible: readonly QuickViewSectionId[] = ["environment", "changes", "context"];
  const next = moveSection(start, "context", 0, visible);
  assert.deepEqual(next.order, ["subagents", "context", "environment", "changes"]);
});

test("a hidden section in the middle stays after the visible card it followed", () => {
  // Subagents follows Changes; moving Environment to the bottom keeps it right behind Changes.
  const start: QuickViewLayout = { order: ["environment", "changes", "subagents", "context"], expanded: {} };
  const visible: readonly QuickViewSectionId[] = ["environment", "changes", "context"];
  const next = moveSection(start, "environment", 2, visible);
  assert.deepEqual(next.order, ["changes", "subagents", "context", "environment"]);
});

test("dropping a card at its own visible index leaves the order unchanged", () => {
  const start: QuickViewLayout = { order: ["environment", "subagents", "changes", "context"], expanded: {} };
  const visible: readonly QuickViewSectionId[] = ["environment", "changes", "context"];
  assert.deepEqual(moveSection(start, "changes", 1, visible).order, start.order);
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

const NOTHING_TO_SHOW: QuickViewVisibilityInput = {
  changesVisible: false,
  changesHeld: false,
  changesWasShown: false,
  hasContextPressure: false,
  subagentsEnabled: true,
  subagentRunCount: 0,
};
const ALL_ORDER: QuickViewSectionId[] = ["subagents", "context", "changes", "environment"];
const visibleWith = (input: Partial<QuickViewVisibilityInput>) =>
  quickViewVisibleSections(ALL_ORDER, { ...NOTHING_TO_SHOW, ...input });

test("Environment is the only card while nothing else has something to show", () => {
  assert.deepEqual(visibleWith({}), ["environment"]);
});

test("visible cards keep the saved order", () => {
  assert.deepEqual(
    visibleWith({ changesVisible: true, hasContextPressure: true, subagentRunCount: 1 }),
    ["subagents", "context", "changes", "environment"],
  );
});

test("Context appears only once the chat has a context projection", () => {
  assert.deepEqual(visibleWith({ hasContextPressure: true }), ["context", "environment"]);
});

test("Subagents needs the feature enabled and at least one run in this chat", () => {
  assert.deepEqual(visibleWith({ subagentRunCount: 2 }), ["subagents", "environment"]);
  assert.deepEqual(visibleWith({ subagentRunCount: 2, subagentsEnabled: false }), ["environment"]);
  assert.deepEqual(visibleWith({ subagentRunCount: 0 }), ["environment"]);
});

test("Changes shows per its rule, and an open dialog or Git operation only keeps a card already shown", () => {
  assert.deepEqual(visibleWith({ changesVisible: true }), ["changes", "environment"]);
  // A commit that just cleaned the tree keeps the card that owns its dialog.
  assert.deepEqual(visibleWith({ changesHeld: true, changesWasShown: true }), ["changes", "environment"]);
  // Holding never brings in a card that was not on screen.
  assert.deepEqual(visibleWith({ changesHeld: true, changesWasShown: false }), ["environment"]);
  // Once the dialog closes and the operation ends, the lapsed rule removes it.
  assert.deepEqual(visibleWith({ changesHeld: false, changesWasShown: true }), ["environment"]);
});
