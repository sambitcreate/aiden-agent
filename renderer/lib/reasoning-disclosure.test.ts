import assert from "node:assert/strict";
import test from "node:test";
import {
  REASONING_PREVIEW_MS,
  initialReasoningDisclosure,
  reasoningDisclosureLayout,
  reduceReasoningDisclosure,
} from "./reasoning-disclosure.js";

test("streaming reasoning previews for exactly one second before collapsing", () => {
  assert.equal(REASONING_PREVIEW_MS, 1_000);
  const preview = initialReasoningDisclosure(true);
  assert.deepEqual(preview, { expanded: true, userControlled: false });
  assert.deepEqual(reduceReasoningDisclosure(preview, { type: "preview-elapsed" }), {
    expanded: false,
    userControlled: false,
  });
});

test("stored reasoning starts collapsed and explicit disclosure intent always wins", () => {
  assert.deepEqual(initialReasoningDisclosure(false), {
    expanded: false,
    userControlled: false,
  });

  const explicitlyCollapsed = reduceReasoningDisclosure(initialReasoningDisclosure(true), {
    type: "toggle",
  });
  assert.deepEqual(explicitlyCollapsed, { expanded: false, userControlled: true });
  assert.equal(
    reduceReasoningDisclosure(explicitlyCollapsed, { type: "preview-elapsed" }),
    explicitlyCollapsed,
  );

  const explicitlyExpanded = reduceReasoningDisclosure(explicitlyCollapsed, { type: "toggle" });
  assert.deepEqual(explicitlyExpanded, { expanded: true, userControlled: true });
  assert.equal(
    reduceReasoningDisclosure(explicitlyExpanded, { type: "preview-elapsed" }),
    explicitlyExpanded,
  );
});

test("only a deliberately opened disclosure flows at full height", () => {
  const preview = initialReasoningDisclosure(true);
  assert.equal(reasoningDisclosureLayout(preview), "preview");
  assert.equal(
    reasoningDisclosureLayout(reduceReasoningDisclosure(preview, { type: "preview-elapsed" })),
    "collapsed",
  );

  const stored = initialReasoningDisclosure(false);
  assert.equal(reasoningDisclosureLayout(stored), "collapsed");
  const opened = reduceReasoningDisclosure(stored, { type: "toggle" });
  assert.equal(reasoningDisclosureLayout(opened), "full");
  // Reopening after dismissing the live preview is also explicit intent.
  const dismissed = reduceReasoningDisclosure(preview, { type: "toggle" });
  assert.equal(
    reasoningDisclosureLayout(reduceReasoningDisclosure(dismissed, { type: "toggle" })),
    "full",
  );
});
