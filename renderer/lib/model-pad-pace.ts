import type { ModelPaceSummary } from "../shared/model-pace";
import type { ModelPadPlacements } from "../shared/model-pad-preferences";
import {
  modelPadGridSizeForPlacements,
  placedVisibleModelPadValues,
  reflowVisibleModelPadPlacements,
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

/** Stable code-unit order for model keys, the tie-break wherever scores are equal. */
function compareValues(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Percentiles of ascending scores (0 = lowest), with average ranks for ties; one score is 0.5. */
function scorePercentiles(scores: ReadonlyArray<{ value: string; score: number }>): Map<string, number> {
  const rows = [...scores].sort(
    (left, right) => left.score - right.score || compareValues(left.value, right.value),
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

/**
 * Give targets (in pace order, so non-decreasing) distinct columns from `free`
 * (ascending), keeping their order, with the least total distance. Equal-cost
 * choices lean right. `free` always has at least as many columns as targets.
 */
function orderedColumns(targets: readonly number[], free: readonly number[]): number[] {
  const count = targets.length;
  const slots = free.length;
  // cost[i][j]: best total for the first i targets using only the first j free columns.
  const cost = Array.from({ length: count + 1 }, (_, i) =>
    Array.from({ length: slots + 1 }, () => (i === 0 ? 0 : Number.POSITIVE_INFINITY)),
  );
  for (let i = 1; i <= count; i += 1) {
    for (let j = i; j <= slots; j += 1) {
      cost[i][j] = Math.min(
        cost[i][j - 1],
        cost[i - 1][j - 1] + Math.abs(free[j - 1] - targets[i - 1]),
      );
    }
  }
  const columns: number[] = [];
  for (let i = count, j = slots; i > 0; j -= 1) {
    if (cost[i][j] === cost[i - 1][j - 1] + Math.abs(free[j - 1] - targets[i - 1])) {
      columns[i - 1] = free[j - 1];
      i -= 1;
    }
  }
  return columns;
}

export interface MeasuredPaceResult {
  /** The new layout; the very same object as the input when nothing would change. */
  placements: ModelPadPlacements;
  /** Placed, visible models whose pace comes from their measured speed. */
  updated: string[];
  /** Placed, visible models with too few measured responses; left where they were. */
  lacking: string[];
  /** Placed, visible models with enough responses but no usable speed; left where they were. */
  unscored: string[];
}

function samePlacements(left: ModelPadPlacements, right: ModelPadPlacements): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const a = left[key];
      const b = right[key];
      return (
        b !== undefined &&
        a.x === b.x &&
        a.y === b.y &&
        a.xSource === b.xSource &&
        a.ySource === b.ySource
      );
    })
  );
}

/**
 * Set the pace (X) of every placed, visible model with at least `minSamples`
 * measured responses from where its pace score ranks among them: fastest at the
 * left edge, slowest at the right. Height and its source stay, and each model
 * stays in its row: models in a row take the free columns nearest their
 * targets in pace order, so a faster model is never right of a slower one in
 * the same row and the result is collision-free on the Pad's grid. Hidden
 * placements stay as saved; other models stay where the Pad shows them.
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
  const unscored: string[] = [];
  for (const value of placed) {
    const summary = summaries[value];
    if (!summary || summary.sampleCount < minSamples) {
      lacking.push(value);
      continue;
    }
    const score = paceScoreMs(summary);
    if (score === undefined) unscored.push(value);
    else scores.push({ value, score });
  }
  if (scores.length === 0) return { placements, updated: [], lacking, unscored };

  const gridSize = modelPadGridSizeForPlacements(placements, visibleValues);
  const divisions = gridSize - 1;
  const reflowed = reflowVisibleModelPadPlacements(placements, visibleValues, gridSize);
  const percentiles = scorePercentiles(scores);
  const rowOf = (value: string) => Math.round(reflowed[value].y * divisions);
  const columnOf = (value: string) => Math.round(reflowed[value].x * divisions);
  // Models keeping their spot hold their dots; measured models give theirs up.
  const heldByRow = new Map<number, Set<number>>();
  for (const value of [...lacking, ...unscored]) {
    const held = heldByRow.get(rowOf(value)) ?? new Set<number>();
    held.add(columnOf(value));
    heldByRow.set(rowOf(value), held);
  }
  const ordered = [...percentiles].sort(
    ([leftValue, left], [rightValue, right]) => left - right || compareValues(leftValue, rightValue),
  );
  const measuredByRow = new Map<number, string[]>();
  for (const [value] of ordered) {
    measuredByRow.set(rowOf(value), [...(measuredByRow.get(rowOf(value)) ?? []), value]);
  }

  const next: ModelPadPlacements = { ...reflowed };
  for (const [row, values] of measuredByRow) {
    const held = heldByRow.get(row);
    const free = Array.from({ length: gridSize }, (_, column) => column).filter(
      (column) => !held?.has(column),
    );
    const targets = values.map((value) => Math.round((percentiles.get(value) ?? 0.5) * divisions));
    orderedColumns(targets, free).forEach((column, index) => {
      const value = values[index];
      next[value] = { ...reflowed[value], x: column / divisions, xSource: "measured" };
    });
  }
  return {
    placements: samePlacements(next, placements) ? placements : next,
    updated: ordered.map(([value]) => value),
    lacking,
    unscored,
  };
}
