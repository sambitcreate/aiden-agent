import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAppearanceConfig,
  getPresetVariant,
} from "../../renderer/shared/appearance.js";
import { AppearancePreviewState } from "./appearance-preview-core.js";

test("a newer appearance preview survives an older persistence completion", () => {
  const state = new AppearancePreviewState();
  const original = createDefaultAppearanceConfig();
  const first = {
    ...original,
    mode: "dark" as const,
  };
  const newer = {
    ...first,
    dark: getPresetVariant("moss", "dark"),
  };

  assert.deepEqual(state.effective(original), original);
  assert.deepEqual(state.preview(first), first);
  assert.deepEqual(state.effective(original), first);
  assert.deepEqual(state.preview(newer), newer);
  assert.deepEqual(state.persisted(first), newer);
  assert.deepEqual(state.persisted(newer), newer);
  assert.deepEqual(state.effective(original), original);
});

test("a failed save keeps the preview authoritative for reopened and reloaded readers", () => {
  const state = new AppearancePreviewState();
  const persisted = createDefaultAppearanceConfig();
  const preview = {
    ...persisted,
    mode: "dark" as const,
    dark: getPresetVariant("berry", "dark"),
  };

  state.preview(preview);
  assert.deepEqual(state.effective(persisted), preview, "Appearance page reopen");
  assert.deepEqual(state.effective(persisted), preview, "renderer theme reload");
  assert.deepEqual(state.snapshot(persisted), {
    appearance: preview,
    pending: true,
  });
  state.persisted(preview);
  assert.deepEqual(state.snapshot(preview), {
    appearance: preview,
    pending: false,
  });
});
