import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PANEL_WIDTH,
  INLINE_MIN_CONTAINER_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_PANEL_WIDTH,
  clampEnvironmentPanelWidth,
  resolveEnvironmentPanelLayout,
} from "./environment-panel-layout.js";

test("inline requires the minimum panel beside the conversation floor", () => {
  assert.equal(INLINE_MIN_CONTAINER_WIDTH, MIN_PANEL_WIDTH + MIN_CONVERSATION_WIDTH);
  assert.equal(INLINE_MIN_CONTAINER_WIDTH, 1040);
});

test("clamps panel width into the saved range and container gutter", () => {
  assert.equal(clampEnvironmentPanelWidth(DEFAULT_PANEL_WIDTH, 2000), DEFAULT_PANEL_WIDTH);
  assert.equal(clampEnvironmentPanelWidth(100, 2000), MIN_PANEL_WIDTH);
  assert.equal(clampEnvironmentPanelWidth(900, 2000), MAX_PANEL_WIDTH);
  assert.equal(clampEnvironmentPanelWidth(DEFAULT_PANEL_WIDTH, 500), 456);
});

test("stays inline by shrinking a wide preferred width before overlaying", () => {
  // Preferred 720 would leave only 380px for chat at 1100, but a 480px panel fits.
  const layout = resolveEnvironmentPanelLayout(720, 1100);
  assert.deepEqual(layout, { width: 540, inline: true });
});

test("uses the preferred width when side-by-side already fits", () => {
  assert.deepEqual(resolveEnvironmentPanelLayout(DEFAULT_PANEL_WIDTH, 1200), {
    width: DEFAULT_PANEL_WIDTH,
    inline: true,
  });
});

test("overlays only when even the minimum panel cannot leave a usable chat column", () => {
  // 700px is near the SplitView sidebar chrome breakpoint and the default
  // workbench width with a docked sidebar — too narrow for 480+560 side-by-side.
  assert.deepEqual(resolveEnvironmentPanelLayout(DEFAULT_PANEL_WIDTH, 700), {
    width: DEFAULT_PANEL_WIDTH,
    inline: false,
  });
  assert.deepEqual(resolveEnvironmentPanelLayout(MIN_PANEL_WIDTH, INLINE_MIN_CONTAINER_WIDTH - 1), {
    width: MIN_PANEL_WIDTH,
    inline: false,
  });
  assert.deepEqual(resolveEnvironmentPanelLayout(MIN_PANEL_WIDTH, INLINE_MIN_CONTAINER_WIDTH), {
    width: MIN_PANEL_WIDTH,
    inline: true,
  });
});

test("shrinks exactly to the minimum panel at the inline threshold", () => {
  assert.deepEqual(resolveEnvironmentPanelLayout(DEFAULT_PANEL_WIDTH, INLINE_MIN_CONTAINER_WIDTH), {
    width: MIN_PANEL_WIDTH,
    inline: true,
  });
});
