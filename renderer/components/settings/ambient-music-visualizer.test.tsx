import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AMBIENT_MUSIC_VISUALIZER_BAND_COUNT } from "../../shared/ambient-music.js";
import { AmbientMusicVisualizer } from "./ambient-music-visualizer.js";

test("renders one bounded segmented column for every native filter band", () => {
  const bands = Array.from(
    { length: AMBIENT_MUSIC_VISUALIZER_BAND_COUNT },
    (_, index) => index / (AMBIENT_MUSIC_VISUALIZER_BAND_COUNT - 1),
  );
  const markup = renderToStaticMarkup(<AmbientMusicVisualizer playing bands={bands} />);

  assert.match(markup, /aria-hidden="true"/u);
  assert.match(markup, /data-playing="true"/u);
  assert.match(markup, /data-telemetry="live"/u);
  assert.equal(markup.match(/ambient-music-visualizer-band/gu)?.length, AMBIENT_MUSIC_VISUALIZER_BAND_COUNT);
  assert.match(markup, /--ambient-spectrum-level:0\.06/u, "zero energy keeps one quiet baseline segment");
  assert.match(markup, /--ambient-spectrum-level:1/u);
});

test("paused or unavailable telemetry stays honestly flattened", () => {
  const unavailable = renderToStaticMarkup(<AmbientMusicVisualizer playing />);
  assert.match(unavailable, /data-telemetry="unavailable"/u);
  assert.equal(
    unavailable.match(/--ambient-spectrum-level:0\.06/gu)?.length,
    AMBIENT_MUSIC_VISUALIZER_BAND_COUNT,
  );

  const paused = renderToStaticMarkup(
    <AmbientMusicVisualizer
      playing={false}
      bands={Array.from({ length: AMBIENT_MUSIC_VISUALIZER_BAND_COUNT }, () => 0.8)}
    />,
  );
  assert.match(paused, /data-playing="false"/u);
  assert.match(paused, /data-telemetry="unavailable"/u);
  assert.equal(paused.match(/--ambient-spectrum-level:0\.06/gu)?.length, AMBIENT_MUSIC_VISUALIZER_BAND_COUNT);

  const invalid = Array.from({ length: AMBIENT_MUSIC_VISUALIZER_BAND_COUNT }, () => 0.5);
  invalid[4] = Number.NaN;
  const bounded = renderToStaticMarkup(<AmbientMusicVisualizer playing bands={invalid} />);
  assert.match(bounded, /data-telemetry="unavailable"/u);
  assert.match(bounded, /data-band="5" style="--ambient-spectrum-level:0\.06;/u);
});

test("visualizer styling uses Aiden theme colors and flattens motion", () => {
  const component = readFileSync(new URL("./ambient-music-visualizer.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

  assert.doesNotMatch(component, /#[\da-f]{3,8}/iu);
  assert.match(styles, /\.ambient-music-visualizer-band:nth-child[\s\S]*?var\(--syntax-title\)/u);
  assert.match(styles, /var\(--support-warning\)/u);
  assert.match(styles, /var\(--support-green\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ambient-music-visualizer-band::after/u);
  assert.match(styles, /@media \(max-width: 540px\)[\s\S]*?\.ambient-music-visualizer/u);
  assert.match(styles, /clip-path: inset\(var\(--ambient-spectrum-inset\)/u);
  const fillRule = [...styles.matchAll(/\.ambient-music-visualizer-band::after\s*\{([^}]*)\}/gu)]
    .map((match) => match[1] ?? "")
    .find((rule) => rule.includes("clip-path")) ?? "";
  assert.doesNotMatch(fillRule, /height\s*:/u);
  assert.match(fillRule, /transition:\s*clip-path/u);
});
