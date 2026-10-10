import type { ModelPaceSummary } from "../shared/model-pace";
import type { ModelPadPlacements } from "../shared/model-pad-preferences";
import {
  modelPadGridSizeForPlacements,
  modelPadPointKey,
  nearestAvailableModelPadPoint,
  placedVisibleModelPadValues,
  reflowVisibleModelPadPlacements,
  type ModelPadPoint,
} from "./model-pad-layout";

/** A model needs this many measured chat responses before its speed sets its pace. */
export const MODEL_PACE_MIN_SAMPLES = 3;

/** The answer length pace compares models on, in output tokens. */
const PACE_ANSWER_TOKENS = 500;

/**
 * Time to a 500-token answer in milliseconds: the median wait for the first token
 * plus streaming 500 tokens at the median rate. Undefined without a positive rate.
 */
export function paceScoreMs(summary: ModelPaceSummary): number | undefined {
  const { medianTtftMs, medianTokensPerSecond } = summary;
  if (!Number.isFinite(medianTtftMs) || medianTtftMs < 0) return undefined;
  if (!Number.isFinite(medianTokensPerSecond) || medianTokensPerSecond <= 0) return undefined;
  return medianTtftMs + (PACE_ANSWER_TOKENS / medianTokensPerSecond) * 1_000;
}

/** "0.4 s first token · 62 tok/s": one decimal under ten seconds, whole seconds above. */
export function formatModelPace(summary: ModelPaceSummary): string {
  const seconds = summary.medianTtftMs / 1_000;
  const ttft = Number(seconds.toFixed(1)) < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `${ttft} s first token · ${Math.round(summary.medianTokensPerSecond)} tok/s`;
}

/** Percentiles of ascending scores (0 = lowest), with average ranks for ties; one score is 0.5. */
function scorePercentiles(scores: ReadonlyArray<{ value: string; score: number }>): Map<string, number> {
  const rows = [...scores].sort(
    (left, right) =>
      left.score - right.score || (left.value < right.value ? -1 : left.value > right.value ? 1 : 0),
  );
  const result = new Map<string, number>();
  if (rows.length === 1) result.set(rows[0].value, 0.5);
  for (let start = 0; rows.length > 1 && start < rows.length; ) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1].score === rows[start].score) end += 1;
    const percentile = (start + end) / 2 / (rows.length - 1);
    for (let index = start; index <= end; index += 1) result.set(rows[index].value, percentile);
    start = end + 1;
  }
  return result;
}

export interface MeasuredPaceResult {
  placements: ModelPadPlacements;
  /** Placed, visible models whose pace now comes from their measured speed. */
  updated: string[];
  /** Placed, visible models without enough measured responses; left where they were. */
  lacking: string[];
}

/**
 * Set the pace (X) of every placed, visible model with at least `minSamples`
 * measured responses from where its pace score ranks among them: fastest at the
 * left edge, slowest at the right. Height and its source stay. Each model lands
 * on its target dot, or the nearest free dot in its own row when that is taken,
 * so the result is already collision-free on the Pad's grid. Hidden placements
 * stay as saved; other models stay where the Pad shows them.
 */
export function measuredPacePlacements(
  placements: ModelPadPlacements,
  visibleValues: readonly string[],
  summaries: Readonly<Record<string, ModelPaceSummary | undefined>>,
  { minSamples = MODEL_PACE_MIN_SAMPLES }: { minSamples?: number } = {},
): MeasuredPaceResult {
  const placed = placedVisibleModelPadValues(placements, visibleValues);
  const scores: Array<{ value: string; score: number }> = [];
  const lacking: string[] = [];
  for (const value of placed) {
    const summary = summaries[value];
    const score = summary && summary.sampleCount >= minSamples ? paceScoreMs(summary) : undefined;
    if (score === undefined) lacking.push(value);
    else scores.push({ value, score });
  }
  if (scores.length === 0) return { placements, updated: [], lacking };

  const gridSize = modelPadGridSizeForPlacements(placements, visibleValues);
  const divisions = gridSize - 1;
  const reflowed = reflowVisibleModelPadPlacements(placements, visibleValues, gridSize);
  const percentiles = scorePercentiles(scores);
  // Models keeping their spot hold it; measured models leave theirs and are
  // placed fastest first, so models sharing a crowded row keep their pace order.
  const occupied: ModelPadPoint[] = lacking.map((value) => reflowed[value]);
  const occupiedKeys = new Set(occupied.map((point) => modelPadPointKey(point, gridSize)));
  const next: ModelPadPlacements = { ...reflowed };
  const ordered = [...percentiles].sort(
    ([leftValue, left], [rightValue, right]) =>
      left - right || (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0),
  );
  for (const [value, percentile] of ordered) {
    const current = reflowed[value];
    const target = Math.round(percentile * divisions);
    const freeColumns = Array.from({ length: gridSize }, (_, column) => column).filter(
      (column) => !occupiedKeys.has(modelPadPointKey({ x: column / divisions, y: current.y }, gridSize)),
    );
    // Ties in distance go right: slower models are placed after faster ones.
    const column = freeColumns.sort(
      (left, right) => Math.abs(left - target) - Math.abs(right - target) || right - left,
    )[0];
    // Unreachable while each measured model frees a dot in its own row; kept as a guard.
    const point =
      column === undefined
        ? nearestAvailableModelPadPoint({ x: target / divisions, y: current.y }, gridSize, occupied)
        : { x: column / divisions, y: current.y };
    occupied.push(point);
    occupiedKeys.add(modelPadPointKey(point, gridSize));
    next[value] = { ...current, ...point, xSource: "measured" };
  }
  return { placements: next, updated: ordered.map(([value]) => value), lacking };
}
