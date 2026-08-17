import assert from "node:assert/strict";
import test from "node:test";
import {
  REASONING_PREVIEW_MS,
  initialReasoningDisclosure,
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
