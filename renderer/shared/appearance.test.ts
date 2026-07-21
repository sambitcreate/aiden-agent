import assert from "node:assert/strict";
import test from "node:test";
import {
  THEME_PRESETS,
  colorContrastRatio,
  createDefaultAppearanceConfig,
  getPresetVariant,
  normalizeAppearanceConfig,
  parseAppearanceConfig,
  parseThemeVariantJson,
  resolveThemeTokens,
  serializeThemeVariant,
  themeVariantSafetyIssues,
} from "./appearance";

test("the built-in theme pairs remain readable and avoid black dark canvases", () => {
  for (const preset of THEME_PRESETS) {
    assert.ok(colorContrastRatio(preset.light.canvas, preset.light.foreground) >= 7, `${preset.label} light contrast`);
    assert.ok(colorContrastRatio(preset.dark.canvas, preset.dark.foreground) >= 7, `${preset.label} dark contrast`);
    assert.notEqual(preset.dark.canvas, "#000000");
    assert.notEqual(preset.dark.raised, "#000000");
    assert.ok(colorContrastRatio(preset.light.accent, preset.light.raised) >= 4.5, `${preset.label} light accent contrast`);
    assert.ok(colorContrastRatio(preset.dark.accent, preset.dark.raised) >= 4.5, `${preset.label} dark accent contrast`);
  }
  assert.equal(THEME_PRESETS[0].dark.canvas, "#181B21");
});

test("appearance normalization safely clamps user-controlled values", () => {
  const normalized = normalizeAppearanceConfig({
    mode: "dark",
    light: { contrast: -12 },
    dark: { contrast: 112, accent: "not-a-color" },
    uiFontSize: 99,
    codeFontSize: 1,
    reduceMotion: "always",
  });
  assert.equal(normalized.mode, "dark");
  assert.equal(normalized.light.contrast, 0);
  assert.equal(normalized.dark.contrast, 100);
  assert.equal(normalized.dark.accent, "#409CFF");
  assert.equal(normalized.uiFontSize, 18);
  assert.equal(normalized.codeFontSize, 10);
  assert.equal(normalized.reduceMotion, "system");
});

test("strict appearance parsing rejects incomplete and unsafe IPC payloads", () => {
  assert.throws(() => parseAppearanceConfig({ mode: "dark" }), /incomplete/i);
  const invalid = createDefaultAppearanceConfig();
  invalid.dark.background = "black";
  assert.throws(() => parseAppearanceConfig(invalid), /background color/i);
  const unsupported = createDefaultAppearanceConfig();
  unsupported.dark.preset = "solarized" as never;
  assert.throws(() => parseAppearanceConfig(unsupported), /unsupported preset/i);
  const wrongToggle = { ...createDefaultAppearanceConfig(), pointerCursors: "yes" };
  assert.throws(() => parseAppearanceConfig(wrongToggle), /boolean/i);
  const unreadable = createDefaultAppearanceConfig();
  unreadable.light.foreground = unreadable.light.background;
  assert.throws(() => parseAppearanceConfig(unreadable), /4\.5:1 contrast/i);
});

test("per-scheme theme JSON round-trips without losing editable fields", () => {
  const original = {
    ...getPresetVariant("berry", "dark"),
    preset: "custom" as const,
    accent: "#A18FFF",
    contrast: 73,
    translucentSidebar: false,
  };
  const parsed = parseThemeVariantJson(serializeThemeVariant(original, "dark"), "dark");
  assert.deepEqual(parsed, original);
  assert.throws(
    () => parseThemeVariantJson(serializeThemeVariant(original, "dark"), "light"),
    /not a light theme/i,
  );
  assert.throws(
    () => parseThemeVariantJson(JSON.stringify({ version: 2, scheme: "dark", theme: original }), "dark"),
    /unsupported version/i,
  );
  assert.throws(
    () => parseThemeVariantJson(JSON.stringify({ accent: "#7C5CFC", background: "#20242C", foreground: "#FFFFFF" }), "dark"),
    /font selection/i,
  );

  const mismatchedPreset = { ...getPresetVariant("aiden", "dark"), accent: "#A18FFF" };
  assert.equal(
    parseThemeVariantJson(JSON.stringify(mismatchedPreset), "dark").preset,
    "custom",
  );
});

test("resolved dark tokens use the selected graphite canvas and accent", () => {
  const variant = {
    ...getPresetVariant("aiden", "dark"),
    background: "#20242C",
    accent: "#7C5CFC",
    preset: "custom" as const,
  };
  const tokens = resolveThemeTokens(variant, "dark");
  assert.equal(tokens["--accent"], "#7C5CFC");
  assert.ok(colorContrastRatio(tokens["--accent"], tokens["--accent-foreground"]) >= 4.5);
  assert.match(tokens["--surface-background"], /^rgb\(32 36 44/);
  assert.notEqual(tokens["--surface-popover"], "#000000");
});

test("unsafe custom theme drafts report recovery guidance", () => {
  const variant = {
    ...getPresetVariant("aiden", "light"),
    preset: "custom" as const,
    foreground: "#FFFFFF",
    background: "#FFFFFF",
    accent: "#FDFDFD",
  };
  const issues = themeVariantSafetyIssues(variant, "light");
  assert.equal(issues.length, 2);
  assert.match(issues.join(" "), /foreground and background/i);
  assert.match(issues.join(" "), /accent/i);
});
