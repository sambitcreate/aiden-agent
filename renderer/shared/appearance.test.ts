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
    assert.deepEqual(themeVariantSafetyIssues(getPresetVariant(preset.id, "light"), "light"), []);
    assert.deepEqual(themeVariantSafetyIssues(getPresetVariant(preset.id, "dark"), "dark"), []);
  }
  assert.equal(THEME_PRESETS[0].dark.canvas, "#181B21");
});

test("built-in themes keep light neutrals softer and dark neutrals calmer", () => {
  const foregrounds = {
    aiden: { light: "#3D3F41", dark: "#D1D4DA" },
    slate: { light: "#3A434E", dark: "#D1D6DE" },
    berry: { light: "#443F4A", dark: "#D5CFD6" },
    moss: { light: "#3F4943", dark: "#D1D6D3" },
  } as const;
  const darkAccents = {
    aiden: "#3E97F6",
    slate: "#21A9BE",
    berry: "#22B69B",
    moss: "#42B596",
  } as const;

  for (const preset of THEME_PRESETS) {
    const expected = foregrounds[preset.id];
    assert.equal(preset.light.foreground, expected.light, `${preset.label} light foreground`);
    assert.equal(preset.dark.foreground, expected.dark, `${preset.label} dark foreground`);
    assert.equal(preset.dark.accent, darkAccents[preset.id], `${preset.label} dark accent`);
  }

  const light = resolveThemeTokens(getPresetVariant("aiden", "light"), "light");
  const dark = resolveThemeTokens(getPresetVariant("aiden", "dark"), "dark");
  assert.equal(light["--text-primary"], "#3D3F41");
  assert.equal(light["--surface-control"], "rgb(61 63 65 / 0.084)");
  assert.equal(dark["--text-primary"], "#D1D4DA");
  assert.equal(dark["--surface-control"], "rgb(209 212 218 / 0.094)");
  assert.equal(dark["--accent"], "#3E97F6");
});

test("appearance normalization refreshes named presets without overwriting custom themes", () => {
  const stale = createDefaultAppearanceConfig();
  stale.light = {
    ...getPresetVariant("slate", "light"),
    accent: "#087F8C",
  };
  stale.dark = {
    ...getPresetVariant("aiden", "dark"),
    accent: "#0A84FF",
    background: "#0E1116",
  };

  const normalized = normalizeAppearanceConfig(stale);
  assert.deepEqual(normalized.light, getPresetVariant("slate", "light"));
  assert.deepEqual(normalized.dark, getPresetVariant("aiden", "dark"));

  const custom = {
    ...getPresetVariant("aiden", "dark"),
    preset: "custom" as const,
    accent: "#A18FFF",
    background: "#20242C",
  };
  assert.deepEqual(normalizeAppearanceConfig({ dark: custom }).dark, custom);
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
  assert.equal(normalized.dark.accent, "#3E97F6");
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
  unreadable.light.preset = "custom";
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
  assert.equal(tokens["--surface-context-bar"], "rgb(41 45 53 / 0.800)");
  assert.notEqual(tokens["--surface-popover"], "#000000");
});

test("composer context surfaces keep the darker theme tint at eighty percent opacity", () => {
  const light = resolveThemeTokens(getPresetVariant("slate", "light"), "light");
  const dark = resolveThemeTokens(getPresetVariant("aiden", "dark"), "dark");

  assert.equal(light["--surface-context-bar"], "rgb(230 235 242 / 0.800)");
  assert.equal(dark["--surface-context-bar"], "rgb(32 36 44 / 0.800)");
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
