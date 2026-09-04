import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PANEL_WIDTH,
  INLINE_MIN_CONTAINER_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_EDGE_GUTTER,
  clampEnvironmentPanelWidth,
  resolveEnvironmentPanelLayout,
  resolveEnvironmentPanelResizeBounds,
  resolveQuickViewLayout,
} from "./environment-panel-layout.js";

const COMPACT_TABS_BREAKPOINT = 520;
const SUBAGENTS_COMPACT_BREAKPOINT = 620;

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

test("resolves the exact narrow overlay matrix", () => {
  const cases = [
    { containerWidth: 320, expectedWidth: 276 },
    { containerWidth: 390, expectedWidth: 346 },
    { containerWidth: 400, expectedWidth: 356 },
    { containerWidth: 500, expectedWidth: 456 },
    { containerWidth: 520, expectedWidth: 476 },
  ];

  for (const { containerWidth, expectedWidth } of cases) {
    assert.deepEqual(resolveEnvironmentPanelLayout(DEFAULT_PANEL_WIDTH, containerWidth), {
      width: expectedWidth,
      inline: false,
    });
    assert.equal(expectedWidth, containerWidth - PANEL_EDGE_GUTTER);
    assert.ok(expectedWidth < COMPACT_TABS_BREAKPOINT);
    assert.ok(expectedWidth < SUBAGENTS_COMPACT_BREAKPOINT);
  }
});

test("keeps icon-only and Subagents compact breakpoints exact at their boundaries", () => {
  const iconOnlyBoundary = resolveEnvironmentPanelLayout(
    DEFAULT_PANEL_WIDTH,
    PANEL_EDGE_GUTTER + COMPACT_TABS_BREAKPOINT,
  );
  assert.deepEqual(iconOnlyBoundary, {
    width: COMPACT_TABS_BREAKPOINT,
    inline: false,
  });
  assert.equal(iconOnlyBoundary.width < COMPACT_TABS_BREAKPOINT, false);

  const compactBoundary = resolveEnvironmentPanelLayout(
    MAX_PANEL_WIDTH,
    PANEL_EDGE_GUTTER + SUBAGENTS_COMPACT_BREAKPOINT,
  );
  assert.deepEqual(compactBoundary, {
    width: SUBAGENTS_COMPACT_BREAKPOINT,
    inline: false,
  });
  assert.equal(compactBoundary.width < SUBAGENTS_COMPACT_BREAKPOINT, false);

  assert.ok(
    resolveEnvironmentPanelLayout(
      DEFAULT_PANEL_WIDTH,
      PANEL_EDGE_GUTTER + COMPACT_TABS_BREAKPOINT - 1,
    ).width < COMPACT_TABS_BREAKPOINT,
  );
  assert.ok(
    resolveEnvironmentPanelLayout(
      MAX_PANEL_WIDTH,
      PANEL_EDGE_GUTTER + SUBAGENTS_COMPACT_BREAKPOINT - 1,
    ).width < SUBAGENTS_COMPACT_BREAKPOINT,
  );
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
  assert.deepEqual(resolveEnvironmentPanelLayout(DEFAULT_PANEL_WIDTH, 1039), {
    width: DEFAULT_PANEL_WIDTH,
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

test("places Quick View beside Environment when the measured workbench fits both", () => {
  assert.deepEqual(resolveQuickViewLayout(1200, true, 560, true), {
    width: 380,
    right: 572,
    alongsideTools: true,
  });
  assert.deepEqual(resolveQuickViewLayout(1040, true, 480, true), {
    width: 380,
    right: 492,
    alongsideTools: true,
  });
});

test("preserves detached Quick View geometry for automatic narrow stacking", () => {
  assert.deepEqual(resolveQuickViewLayout(700, true, 560, false), {
    width: 380,
    right: 12,
    alongsideTools: false,
  });
  assert.deepEqual(resolveQuickViewLayout(390, true, 346, false), {
    width: 366,
    right: 12,
    alongsideTools: false,
  });
});

test("reports only achievable keyboard resize bounds", () => {
  assert.deepEqual(resolveEnvironmentPanelResizeBounds(1040, true), { min: 480, max: 480 });
  assert.deepEqual(resolveEnvironmentPanelResizeBounds(1200, true), { min: 480, max: 640 });
  assert.deepEqual(resolveEnvironmentPanelResizeBounds(700, false), { min: 480, max: 656 });
});
