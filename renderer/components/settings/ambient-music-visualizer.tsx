import * as React from "react";

import { AMBIENT_MUSIC_VISUALIZER_BAND_COUNT } from "../../shared/ambient-music";

type VisualizerStyle = React.CSSProperties & {
  "--ambient-spectrum-level": number;
  "--ambient-spectrum-inset": string;
};

function hasValidTelemetry(bands: number[] | undefined): bands is number[] {
  return bands?.length === AMBIENT_MUSIC_VISUALIZER_BAND_COUNT && bands.every(
    (band) => Number.isFinite(band) && band >= 0 && band <= 1,
  );
}

function visualizerLevels(playing: boolean, bands: number[] | undefined): number[] {
  if (!playing || !hasValidTelemetry(bands)) {
    return Array.from({ length: AMBIENT_MUSIC_VISUALIZER_BAND_COUNT }, () => 0.06);
  }
  return bands.map((band) => Math.max(0.06, band));
}

export function AmbientMusicVisualizer({
  playing,
  bands,
}: {
  playing: boolean;
  bands?: number[];
}) {
  const telemetryLive = playing && hasValidTelemetry(bands);
  const levels = visualizerLevels(playing, bands);

  return (
    <div
      className="ambient-music-visualizer"
      data-playing={playing}
      data-telemetry={telemetryLive ? "live" : "unavailable"}
      aria-hidden="true"
    >
      <div className="ambient-music-visualizer-grid">
        {levels.map((level, index) => (
          <span
            // The native filter-bank order is stable, so an index key preserves
            // each column while React receives the next 2 Hz energy snapshot.
            key={index}
            className="ambient-music-visualizer-band"
            data-band={index + 1}
            style={{
              "--ambient-spectrum-level": level,
              "--ambient-spectrum-inset": `${(1 - level) * 100}%`,
            } as VisualizerStyle}
          />
        ))}
      </div>
    </div>
  );
}
