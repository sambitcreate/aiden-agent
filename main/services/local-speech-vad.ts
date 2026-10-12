// Pure planning of which sample ranges to decode after Silero VAD. Values
// follow Handy's SmoothedVad (450 ms pre/post roll) adapted to whole-clip
// decoding; window packing keeps Whisper/Moonshine/SenseVoice under 30 s.
// Padding never crosses the midpoint to a neighbouring region, so window
// seams fall in silence and every detected region lands in exactly one window.

export interface SampleRange { start: number; end: number }

const DEFAULT_RATE = 16_000;
export const VAD_PAD_SAMPLES = Math.round(0.45 * DEFAULT_RATE);
export const MAX_SEGMENT_SECONDS = 28;

/** Clip to the recording, sort, and merge overlapping or touching regions. */
function mergedRegions(regions: readonly SampleRange[], total: number): SampleRange[] {
  const sorted = [...regions]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: SampleRange[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push(region);
  }
  return merged;
}

function paddedBounds(regions: readonly SampleRange[], total: number, pad: number): SampleRange[] {
  const sorted = mergedRegions(regions, total);
  return sorted.map((region, index) => {
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    const start = previous
      ? Math.max(region.start - pad, Math.ceil((previous.end + region.start) / 2))
      : Math.max(0, region.start - pad);
    const end = next
      ? Math.min(region.end + pad, Math.floor((region.end + next.start) / 2))
      : Math.min(total, region.end + pad);
    return { start, end };
  });
}

/** Window length in samples: 2 s headroom under the model window, capped at 28 s, never below 1 s. */
function windowLimit(maxWindowSeconds: number, sampleRate: number): number {
  return Math.max(sampleRate, Math.floor(Math.min(maxWindowSeconds - 2, MAX_SEGMENT_SECONDS) * sampleRate));
}

function split(range: SampleRange, limit: number): SampleRange[] {
  const out: SampleRange[] = [];
  for (let start = range.start; start < range.end; start += limit) out.push({ start, end: Math.min(range.end, start + limit) });
  return out;
}

export function planSegments(
  regions: readonly SampleRange[],
  totalSamples: number,
  maxWindowSeconds: number | null,
  sampleRate = DEFAULT_RATE,
): SampleRange[] {
  const bounds = paddedBounds(regions, totalSamples, Math.round(VAD_PAD_SAMPLES * (sampleRate / DEFAULT_RATE)));
  if (bounds.length === 0) return [];
  if (maxWindowSeconds === null || !Number.isFinite(maxWindowSeconds)) return [{ start: bounds[0]!.start, end: bounds[bounds.length - 1]!.end }];
  const limit = windowLimit(maxWindowSeconds, sampleRate);
  const windows: SampleRange[] = [];
  for (const range of bounds.flatMap((r) => (r.end - r.start > limit ? split(r, limit) : [r]))) {
    const last = windows[windows.length - 1];
    if (last && range.end - last.start <= limit) last.end = range.end;
    else windows.push({ ...range });
  }
  return windows;
}

export function fixedChunks(totalSamples: number, maxWindowSeconds: number | null, sampleRate = DEFAULT_RATE): SampleRange[] {
  if (totalSamples <= 0) return [];
  if (maxWindowSeconds === null || !Number.isFinite(maxWindowSeconds)) return [{ start: 0, end: totalSamples }];
  return split({ start: 0, end: totalSamples }, windowLimit(maxWindowSeconds, sampleRate));
}
