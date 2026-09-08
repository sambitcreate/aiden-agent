import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  type AppearanceScheme,
  type ThemeVariantConfig,
} from "./appearance";

const NORMAL_TEXT_TOKENS = [
  "--text-secondary",
  "--text-tertiary",
  "--text-quaternary",
  "--syntax-comment",
  "--syntax-keyword",
  "--syntax-string",
  "--syntax-number",
  "--syntax-title",
  "--syntax-variable",
  "--support-red",
  "--support-green",
  "--support-warning",
  "--terminal-foreground",
  "--terminal-black",
  "--terminal-red",
  "--terminal-green",
  "--terminal-yellow",
  "--terminal-blue",
  "--terminal-magenta",
  "--terminal-cyan",
  "--terminal-white",
] as const;

function mixHexForContrastTest(from: string, to: string, amount: number): string {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(channel(from, offset) + (channel(to, offset) - channel(from, offset)) * amount)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${mixed.join("")}`;
}

function compositeToken(base: string, overlay: string): string {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(overlay);
  assert.ok(match, `Expected an emitted alpha color, got ${overlay}`);
  const color = `#${match.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  return mixHexForContrastTest(base, color, Number(match[4]));
}

function actualSurfaces(tokens: Record<string, string>): string[] {
  return [tokens["--theme-canvas"], tokens["--theme-sidebar"], tokens["--surface-popover"],
    compositeToken(tokens["--theme-canvas"], tokens["--surface-control"]),
    compositeToken(tokens["--theme-canvas"], tokens["--surface-list-selection"]),
    compositeToken(tokens["--surface-popover"], tokens["--surface-well"])];
}

test("colored status labels remain readable on their actual fills across presets and contrast settings", () => {
  for (const preset of THEME_PRESETS) for (const scheme of ["light", "dark"] as const) {
    for (const contrast of [0, getPresetVariant(preset.id, scheme).contrast, 100]) for (const highContrast of [false, true]) {
      const tokens = resolveThemeTokens({ ...getPresetVariant(preset.id, scheme), contrast }, scheme, highContrast);
      for (const surface of actualSurfaces(tokens)) {
        for (const tone of ["accent", "red", "green", "warning"]) {
          const fill = compositeToken(surface, tokens[`--status-${tone}-surface`]);
          assert.ok(colorContrastRatio(tokens[`--status-${tone}`], fill) >= 4.75,
            `${preset.id}/${scheme}/${contrast}/${highContrast}: ${tone} on ${fill}`);
        }
        assert.ok(colorContrastRatio(tokens["--text-quaternary"], surface) >= 4.75);
      }
      assert.equal(tokens["--focus-ring"], tokens["--text-primary"], "keyboard focus is neutral");
      assert.notEqual(tokens["--status-green"], tokens["--status-red"], "statuses keep distinct colors");
    }
  }
});

test("the shared mobile appearance fixture exactly matches Electron presets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../protocol/aiden-appearance-v1.json", import.meta.url), "utf8"),
  ) as { version: number; presets: typeof THEME_PRESETS };
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.presets, THEME_PRESETS);
});

function assertSemanticContrast(
  variant: ThemeVariantConfig,
  scheme: AppearanceScheme,
  label: string,
  minimumTextRatio = 4.5,
  includeCompositeSurfaces = false,
): void {
  const tokens = resolveThemeTokens(variant, scheme);
  const surfaces = [
    tokens["--theme-canvas"],
    tokens["--theme-sidebar"],
    tokens["--surface-popover"],
  ] as const;
  const compositeSurfaces = actualSurfaces(tokens).slice(3);
  for (const role of NORMAL_TEXT_TOKENS) {
    const requiredRatio = role === "--terminal-foreground" ? 4.5 : minimumTextRatio;
    const evaluatedSurfaces = role === "--terminal-foreground" || !includeCompositeSurfaces
      ? surfaces
      : [...surfaces, ...compositeSurfaces];
    for (const surface of evaluatedSurfaces) {
      assert.ok(
        colorContrastRatio(tokens[role], surface) >= requiredRatio,
        `${label} ${role} remains readable at ${requiredRatio}:1 on ${surface}`,
      );
    }
  }
  for (const support of ["red", "green", "warning"] as const) {
    assert.ok(
      colorContrastRatio(
        tokens[`--support-${support}`],
        tokens[`--support-${support}-foreground`],
      ) >= 4.5,
      `${label} ${support} fill has readable content`,
    );
  }
  for (const state of ["--accent", "--accent-hover", "--accent-active"] as const) {
    assert.ok(
      colorContrastRatio(tokens[state], tokens["--accent-foreground"]) >= 4.5,
      `${label} ${state} has readable control content`,
    );
  }
  for (const surface of surfaces) {
    assert.ok(
      colorContrastRatio(tokens["--toolbar-icon"], surface) >= 3,
      `${label} toolbar icon remains visible on ${surface}`,
    );
    assert.ok(
      colorContrastRatio(tokens["--focus-ring"], surface) >= 3,
      `${label} focus ring remains visible on ${surface}`,
    );
  }
}

test("the built-in theme pairs remain readable and avoid black dark canvases", () => {
  for (const preset of THEME_PRESETS) {
    assert.ok(colorContrastRatio(preset.light.canvas, preset.light.foreground) >= 7, `${preset.label} light contrast`);
    assert.ok(colorContrastRatio(preset.dark.canvas, preset.dark.foreground) >= 7, `${preset.label} dark contrast`);
    assert.notEqual(preset.dark.canvas, "#000000");
    assert.notEqual(preset.dark.raised, "#000000");
    for (const surface of ["canvas", "sidebar", "raised"] as const) {
      assert.ok(
        colorContrastRatio(preset.light.accent, preset.light[surface]) >= 4.5,
        `${preset.label} light accent contrast on ${surface}`,
      );
      assert.ok(
        colorContrastRatio(preset.dark.accent, preset.dark[surface]) >= 4.5,
        `${preset.label} dark accent contrast on ${surface}`,
      );
    }
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
    berry: "#E8629F",
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
  assert.equal(light["--text-secondary"], "#545963");
  assert.equal(light["--text-quaternary"], "#5D6370");
  assert.equal(light["--surface-control"], "rgb(61 63 65 / 0.084)");
  assert.equal(dark["--text-primary"], "#D1D4DA");
  assert.equal(dark["--text-secondary"], "#A9B1BA");
  assert.equal(dark["--text-quaternary"], "#9AA3AE");
  assert.equal(dark["--surface-control"], "rgb(209 212 218 / 0.094)");
  assert.equal(dark["--accent"], "#3E97F6");
});

test("every built-in theme keeps semantic foregrounds above 4.75 on base and composite surfaces", () => {
  for (const preset of THEME_PRESETS) {
    assertSemanticContrast(
      getPresetVariant(preset.id, "light"),
      "light",
      `${preset.label} light`,
      4.75,
      true,
    );
    assertSemanticContrast(
      getPresetVariant(preset.id, "dark"),
      "dark",
      `${preset.label} dark`,
      4.75,
      true,
    );
  }
});

test("custom themes clash-correct semantic colors without rejecting safe primitives", () => {
  const collision = {
    ...getPresetVariant("aiden", "dark"),
    preset: "custom" as const,
    background: "#FF5E57",
    foreground: "#000000",
    accent: "#000000",
  };
  assert.deepEqual(themeVariantSafetyIssues(collision, "dark"), []);
  assertSemanticContrast(collision, "dark", "danger-collision custom dark");

  const boundaryAccent = {
    ...getPresetVariant("aiden", "light"),
    preset: "custom" as const,
    background: "#FFFFFF",
    foreground: "#000000",
    accent: "#6E6E6E",
  };
  assert.deepEqual(themeVariantSafetyIssues(boundaryAccent, "light"), []);
  assertSemanticContrast(boundaryAccent, "light", "boundary-accent custom light");

  const toolbarCollision = {
    ...getPresetVariant("aiden", "light"),
    preset: "custom" as const,
    background: "#7B7B7B",
    foreground: "#000000",
    accent: "#000000",
    contrast: 0,
  };
  assert.deepEqual(themeVariantSafetyIssues(toolbarCollision, "light"), []);
  assertSemanticContrast(toolbarCollision, "light", "toolbar-collision custom light");

  const sidebarCollision = {
    ...getPresetVariant("aiden", "light"),
    preset: "custom" as const,
    background: "#FFFFFF",
    foreground: "#767676",
    accent: "#000000",
    contrast: 100,
  };
  assert.match(
    themeVariantSafetyIssues(sidebarCollision, "light").join(" "),
    /foreground needs at least 4\.5:1 contrast against its surfaces/i,
  );
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
  assert.equal(createDefaultAppearanceConfig().diffMarkers, "symbols");
  assert.equal(normalizeAppearanceConfig({}).diffMarkers, "symbols");
});

test("composer context auto-hide defaults on and preserves explicit saved preferences", () => {
  assert.equal(createDefaultAppearanceConfig().autoHideComposerContext, true);
  assert.equal(normalizeAppearanceConfig({}).autoHideComposerContext, true);
  assert.equal(normalizeAppearanceConfig({ autoHideComposerContext: "false" }).autoHideComposerContext, true);
  for (const enabled of [false, true]) {
    const stored = { ...createDefaultAppearanceConfig(), autoHideComposerContext: enabled };
    assert.equal(parseAppearanceConfig(JSON.parse(JSON.stringify(stored))).autoHideComposerContext, enabled);
  }
  const legacy: Record<string, unknown> = { ...createDefaultAppearanceConfig() };
  delete legacy.autoHideComposerContext;
  assert.equal(parseAppearanceConfig(legacy).autoHideComposerContext, true);
  assert.throws(() => parseAppearanceConfig({ ...legacy, autoHideComposerContext: "yes" }), /boolean/u);
});

test("the shared focus treatment separates text entry from non-text keyboard focus", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
  const assistantBubble = readFileSync(
    new URL("../components/assistant/assistant-bubble.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /:root :where\(input, textarea\):focus-visible\s*\{\s*outline: none !important;\s*\}/u,
  );
  assert.match(
    styles,
    /:root :where\(button,[^}]+\):focus-visible\s*\{\s*outline: 2px solid var\(--focus-ring\) !important;\s*outline-offset: var\(--keyboard-focus-offset, 2px\) !important;/u,
  );
  assert.doesNotMatch(styles, /:root :where\(\*\):focus/u);
  assert.match(
    styles,
    /--color-support-red-foreground: var\(--support-red-foreground\);/u,
  );
  assert.match(
    styles,
    /--color-support-green-foreground: var\(--support-green-foreground\);/u,
  );
  assert.match(
    styles,
    /--color-support-warning-foreground: var\(--support-warning-foreground\);/u,
  );
  assert.match(
    ui,
    /bg-red text-red-foreground[\s\S]*?hover:bg-red[\s\S]*?active:bg-red[\s\S]*?focus-visible:bg-red/u,
  );
  assert.match(
    ui,
    /SwitchPrimitive\.Thumb className="[^"]*bg-white[^"]*data-\[state=checked\]:bg-accent-foreground[^"]*"/u,
  );
  assert.match(assistantBubble, /bg-support-red[\s\S]*?text-support-red-foreground/u);
});

test("audited UI components retain semantic typography, radii, colors, and radio selection", () => {
  const readRenderer = (relativePath: string) =>
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const typographySources = [
    "components/assistant/assistant-panel.tsx",
    "components/assistant/assistant-bubble.tsx",
    "components/model-picker.tsx",
    "components/review-panel.tsx",
    "components/onboarding-flow.tsx",
    "components/ui.tsx",
    "components/settings/provider-model-visibility.tsx",
    "components/settings/model-pad-settings.tsx",
    "components/assistant/assistant-recent.tsx",
    "components/assistant/assistant-thread.tsx",
    "components/settings/telegram-settings.tsx",
  ].map(readRenderer);
  const radiusSources = [
    "components/ask-user-question-composer.tsx",
    "components/btw-card.tsx",
    "components/command-palette.tsx",
    "components/composer-slash-palette.tsx",
    "components/environment-panel.tsx",
    "components/review-panel.tsx",
    "components/terminal-drawer.tsx",
    "components/ui.tsx",
    "components/usage/profile-share-card.tsx",
  ].map(readRenderer);
  const geminiVoice = readRenderer("components/settings/gemini-voice-setup-dialog.tsx");
  const modelManager = readRenderer("components/settings/model-manager-view.tsx");
  const styles = readRenderer("styles.css");
  const previewStyles = styles.slice(
    styles.indexOf(".appearance-mode-preview {"),
    styles.indexOf(".appearance-code-preview {"),
  );

  for (const source of typographySources) {
    assert.doesNotMatch(source, /(?:^|[\s"'`])text-(?:xs|sm)(?=[\s"'`]|$)/u);
    assert.doesNotMatch(source, /text-\[(?:10px|11px|12px|13px|14px|20px)\]/u);
  }
  for (const source of radiusSources) {
    assert.doesNotMatch(source, /rounded-\[(?:9px|10px|11px|18px|22px|24px)\]/u);
  }
  assert.match(styles, /--radius-menu: 8px;/u);
  assert.match(styles, /--radius-sheet: 24px;/u);
  assert.doesNotMatch(previewStyles, /#[0-9a-f]{3,8}\b/iu);
  assert.match(styles, /scrollbar-gutter: stable;/u);
  assert.match(geminiVoice, /<RadioGroupItem/u);
  assert.match(geminiVoice, /selected \? "bg-list-selection"/u);
  assert.doesNotMatch(geminiVoice, /border-accent|has-\[:focus-visible\]/u);
  assert.match(modelManager, /border border-field bg-popover[\s\S]*?active && "bg-list-selection"/u);
  assert.doesNotMatch(modelManager, /active \? "border-accent"/u);
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

  const unreadablePopover = createDefaultAppearanceConfig();
  unreadablePopover.light = {
    ...unreadablePopover.light,
    preset: "custom",
    background: "#767676",
    foreground: "#FFFFFF",
    accent: "#000000",
  };
  assert.throws(
    () => parseAppearanceConfig(unreadablePopover),
    /foreground needs at least 4\.5:1 contrast against its surfaces/i,
  );
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
  assert.match(issues.join(" "), /foreground needs at least 4\.5:1 contrast against its surfaces/i);
  assert.match(issues.join(" "), /accent/i);
});


test("status primitives keep semantic fills and icons without decorative edges", () => {
  const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
  const badge = ui.slice(ui.indexOf("export function Badge"), ui.indexOf("export function Callout"));
  for (const tone of ["accent", "green", "red"]) {
    assert.match(badge, new RegExp(`bg-status-${tone}-surface text-status-${tone}`, "u"));
  }
  assert.match(badge, /aria-hidden="true"/u);
  const callout = ui.slice(ui.indexOf("export function Callout"), ui.indexOf("export function EmptyState"));
  assert.ok(callout.includes("[&_.text-red]:text-status-red"), "nested red labels use the tinted-surface foreground");
  assert.ok(callout.includes("[&_.text-support-red]:text-status-red"));
  const radio = ui.slice(ui.indexOf("export const RadioGroupItem"), ui.indexOf("export const Command ="));
  assert.match(radio, /bg-tertiary[\s\S]*hover:bg-secondary/u);
  assert.match(radio, /data-\[state=checked\]:bg-accent/u);
  assert.match(radio, /Indicator className="size-1.5 rounded-full bg-accent-foreground"/u);
  assert.doesNotMatch(badge, /(?:border|ring|outline)-(?:accent|red|green|support)/u);
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const scheme of ["light", "dark"] as const) {
    const tokens = resolveThemeTokens(getPresetVariant("aiden", scheme), scheme);
    const start = styles.indexOf(scheme === "light" ? ":root {" : ":root.dark {");
    const fallback = styles.slice(start, styles.indexOf("\n}", start));
    for (const [token, value] of Object.entries(tokens).filter(([name]) => ["--status-", "--text-", "--syntax-", "--support-"].some(prefix => name.startsWith(prefix)))) {
      assert.ok(fallback.includes(`${token}: ${value};`), `${scheme} fallback ${token} matches the resolver`);
    }
  }
});
