import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./model-pad-settings.tsx", import.meta.url), "utf8");
const modelDataSource = readFileSync(new URL("./model-data-settings.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

test("Model Pad owns the OpenRouter benchmark-key flow and explains catalog isolation", () => {
  assert.match(source, /label="OpenRouter key for Model Pad"/u);
  assert.match(source, /modelInsightsApi\.connect\(key\)/u);
  assert.match(source, /modelInsightsApi\.disconnect\(\)/u);
  assert.match(source, /This key is separate from OpenRouter chat providers/u);
  assert.match(source, /will not add OpenRouter’s 500\+ models to your model list/u);
  assert.match(source, /fixed OpenRouter benchmark endpoint/u);
  assert.doesNotMatch(source, /section: "providers"/u);
});

test("Model Pad never renders a saved API key back into its password field", () => {
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="off"/u);
  assert.match(source, /setKeyDraft\(""\)/u);
  assert.doesNotMatch(source, /value=\{status\?\.(?:key|apiKey)/u);
});

test("dense Model Pad markers reveal identity contextually without permanent name pills", () => {
  assert.equal(source.match(/className="model-pad-axis-label/g)?.length, 2);
  assert.match(styles, /\.model-pad-axis-label\s*\{[\s\S]*font-size: var\(--text-strong\)/u);
  assert.match(styles, /\.model-pad-axis-label\s*\{[\s\S]*font-weight: 600/u);
  assert.match(source, /model-pad-chip model-pad-marker/u);
  assert.match(source, /aria-pressed=\{selected\}/u);
  assert.match(source, /data-placement-source=\{personalPlacement/u);
  assert.match(source, /data-selected=\{selected \? "true" : "false"\}/u);
  assert.match(source, /model-pad-marker group absolute z-10 grid size-6/u);
  assert.match(source, /model-pad-marker-visual block size-3 rounded-full/u);
  assert.match(source, /placementSourceDescription/u);
  assert.match(source, /\? "Placed by you"\s*: "Benchmark-assisted"/u);
  assert.match(source, /className="model-pad-marker-label"/u);
  assert.match(
    source,
    /event\.key === "Escape"[\s\S]*setActiveValue\(undefined\)[\s\S]*event\.currentTarget\.blur\(\)/u,
  );
  assert.match(source, /Hover, focus, or select a marker to see its model/u);
  assert.match(source, /Pace unmeasured; horizontal spread is for readability/u);
  assert.doesNotMatch(source, /title=\{`\$\{entry\.label\} · \$\{entry\.providerLabel\}`\}/u);
  assert.match(
    styles,
    /\.model-pad-marker:hover \.model-pad-marker-label,[\s\S]*\.model-pad-marker:focus-visible \.model-pad-marker-label,[\s\S]*\.model-pad-marker\[data-selected="true"\] \.model-pad-marker-label/u,
  );
  assert.match(styles, /:root\[data-reduce-motion="true"\] \.model-pad-marker-label/u);
  assert.match(
    styles,
    /\.model-pad-marker\[data-placement-source="benchmark"\] \.model-pad-marker-visual\s*\{\s*background: var\(--accent\)/u,
  );
  assert.match(
    styles,
    /\.model-pad-marker\[data-placement-source="personal"\] \.model-pad-marker-visual\s*\{\s*background: color-mix\(in srgb, var\(--accent\) 38%, var\(--surface-popover\)\)/u,
  );
  assert.match(
    styles,
    /\.model-pad-legend-marker\[data-source="benchmark"\]\s*\{\s*background: var\(--accent\)/u,
  );
  assert.doesNotMatch(styles, /\.model-pad-legend-marker::after/u);
});

test("capability-only suggestions use honest collision-free horizontal packing", () => {
  assert.match(source, /distributeCapabilityOnlyModelPadSuggestions/u);
  assert.match(source, /horizontal spread is only for readability until you rate pace/u);
  assert.doesNotMatch(source, /useArtificialAnalysisStatus/u);
  assert.doesNotMatch(source, /entry\.ranking\.responseTimePercentile/u);
});

test("Model Pad progressively discloses supporting and advanced controls", () => {
  assert.match(source, /className="model-pad-fieldset"/u);
  assert.match(source, /className="model-pad-field"/u);
  assert.match(source, /className="settings-model-pad-grid grid gap-4"/u);
  assert.match(source, />\s*Browse models\s*</u);
  assert.match(source, />\s*Benchmark insights\s*</u);
  assert.match(source, /activePanel === "models"/u);
  assert.match(source, /activePanel === "insights"/u);
  assert.match(source, /document\.startViewTransition/u);
  assert.match(source, /panelTransitionRef\.current\?\.skipTransition\(\)/u);
  assert.match(source, /event\.detail > 0/u);
  assert.match(source, /prefers-reduced-motion: reduce/u);
  assert.match(source, /providerId="openrouter"/u);
  assert.doesNotMatch(source, /Sparkles/u);
  assert.match(source, /hidden=\{activePanel !== "models"\}/u);
  assert.match(source, /hidden=\{activePanel !== "insights"\}/u);
  assert.match(source, />\s*Pad management\s*</u);
  assert.match(source, /model-pad-catalog/u);
  assert.match(source, /model-pad-browser-count/u);
  assert.match(source, />\{entries\.length\} models</u);
  assert.match(source, /catalogScrollState\.hasMoreBelow/u);
  assert.match(source, /Scroll down to more available models/u);
  assert.match(source, /More models below/u);
  assert.match(source, /Scroll down to the model list/u);
  assert.match(source, /Model list below/u);
  assert.match(source, /enlarge the window to view it beside the Pad/u);
  assert.match(source, /scrollIntoView/u);
  assert.match(source, /dataset\.reduceMotion === "true"/u);
  assert.match(
    styles,
    /--model-pad-fieldset-width: max\(100%, min\(64rem, calc\(100vw - 19rem\)\)\)/u,
  );
  assert.match(styles, /\.model-pad-field\s*\{\s*padding: 1\.5rem/u);
  assert.match(
    styles,
    /\.settings-model-pad-grid\[data-panel-open="true"\]\s*\{\s*grid-template-columns: minmax\(28rem, 40rem\) minmax\(16rem, 18rem\)/u,
  );
  assert.match(styles, /\.model-pad-canvas\s*\{\s*width: min\(100%, 40rem\)/u);
  assert.match(styles, /@container model-pad-fieldset \(max-width: 760px\)/u);
  assert.match(
    styles,
    /\.model-pad-catalog\s*\{\s*max-height: min\(48rem, calc\(100vh - 12rem\)\)/u,
  );
  assert.match(styles, /\.model-pad-catalog-shell\[data-more-below="true"\]::after/u);
  assert.match(styles, /\.model-pad-catalog-more/u);
  assert.match(styles, /view-transition-name: model-pad-canvas/u);
  assert.match(styles, /view-transition-name: model-pad-browser/u);
  assert.match(styles, /view-transition-name: model-pad-insights/u);
  assert.match(styles, /model-pad-browser-in 180ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/u);
  assert.match(styles, /model-pad-insights-in 180ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/u);
  assert.match(
    styles,
    /\.model-pad-disclosure\s*\{\s*margin-top: 1\.5rem;\s*border: 0;\s*box-shadow: none;/u,
  );
  assert.match(styles, /\.model-pad-management\s*\{\s*margin-top: 1\.5rem/u);
  assert.match(
    styles,
    /@container model-pad-fieldset \(max-width: 760px\)[\s\S]*\.model-pad-panel-below\s*\{\s*display: flex/u,
  );
});

test("legacy direct Artificial Analysis settings are retired", () => {
  assert.match(modelDataSource, /return <ModelPadSettings \/>/u);
  assert.doesNotMatch(modelDataSource, /artificialAnalysisApi/u);
  assert.doesNotMatch(modelDataSource, /Legacy direct benchmark source/u);
  assert.doesNotMatch(source, /useArtificialAnalysisStatus/u);
});
