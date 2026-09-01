export const PI_UPGRADE_REPLAY_CASE_IDS = [
  "long_coding_chat",
  "tool_heavy_turn",
  "attachment_heavy_first_prompt",
  "repeated_compaction",
  "provider_model_switch",
  "bot_mac_telegram_alternation",
  "child_initial_fork",
] as const;

export type PiUpgradeReplayCaseId = typeof PI_UPGRADE_REPLAY_CASE_IDS[number];

export interface PiUpgradeReplayMeasurement {
  caseId: PiUpgradeReplayCaseId;
  continuationCorrect: boolean;
  pendingReferencesExpected: number;
  pendingReferencesRetained: number;
  tokensBefore: number;
  tokensAfter: number;
  durationMs: number;
  costMicros: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turnsUntilNextCompaction: number;
  emergencyProjections: number;
  noOpAttempts: number;
  migrationFailures: number;
}

export const PI_UPGRADE_QUALITY_THRESHOLDS = Object.freeze({
  minimumTokenReductionRatio: 0.25,
  minimumTurnsUntilNextCompaction: 2,
  maximumEmergencyProjectionRatio: 0.15,
  maximumMigrationFailures: 0,
  maximumNoOpAttempts: 0,
});

export interface PiUpgradeEvaluationReport {
  version: 1;
  passed: boolean;
  caseCount: number;
  continuationCorrectRatio: number;
  pendingReferenceRetentionRatio: number;
  tokenReductionRatio: number;
  emergencyProjectionRatio: number;
  totalDurationMs: number;
  totalCostMicros: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  minimumTurnsUntilNextCompaction: number;
  noOpAttempts: number;
  migrationFailures: number;
  failures: string[];
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label} measurement.`);
  return value;
}

const MEASUREMENT_KEYS = [
  "caseId", "continuationCorrect", "pendingReferencesExpected", "pendingReferencesRetained",
  "tokensBefore", "tokensAfter", "durationMs", "costMicros", "cacheReadTokens",
  "cacheWriteTokens", "turnsUntilNextCompaction", "emergencyProjections", "noOpAttempts",
  "migrationFailures",
] as const;

const INTEGER_MEASUREMENT_KEYS = [
  "pendingReferencesExpected", "pendingReferencesRetained", "tokensBefore", "tokensAfter",
  "costMicros", "cacheReadTokens", "cacheWriteTokens", "turnsUntilNextCompaction",
  "emergencyProjections", "noOpAttempts", "migrationFailures",
] as const satisfies readonly (keyof PiUpgradeReplayMeasurement)[];

function validateMeasurement(measurement: PiUpgradeReplayMeasurement): void {
  if (!measurement || typeof measurement !== "object" || Array.isArray(measurement)) {
    throw new Error("Invalid replay measurement object.");
  }
  const actualKeys = Object.keys(measurement).sort();
  const expectedKeys = [...MEASUREMENT_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Replay measurement does not match the required schema.");
  }
  if (!PI_UPGRADE_REPLAY_CASE_IDS.includes(measurement.caseId)) {
    throw new Error(`Unknown replay case: ${String(measurement.caseId)}.`);
  }
  if (typeof measurement.continuationCorrect !== "boolean") {
    throw new Error(`Invalid continuation result for ${measurement.caseId}.`);
  }
  for (const [label, value] of Object.entries(measurement)) {
    if (label !== "caseId" && label !== "continuationCorrect") {
      finiteNonNegative(value as number, label);
    }
  }
  for (const key of INTEGER_MEASUREMENT_KEYS) {
    if (!Number.isSafeInteger(measurement[key])) {
      throw new Error(`Invalid integer ${key} measurement.`);
    }
  }
  if (measurement.tokensBefore <= 0 || measurement.durationMs <= 0) {
    throw new Error(`Replay case ${measurement.caseId} lacks executable measurements.`);
  }
  if (measurement.caseId !== "attachment_heavy_first_prompt" && measurement.pendingReferencesExpected < 1) {
    throw new Error(`Replay case ${measurement.caseId} lacks a pending-reference assertion.`);
  }
}

export function evaluatePiUpgradeReplay(
  measurements: readonly PiUpgradeReplayMeasurement[],
): PiUpgradeEvaluationReport {
  const byId = new Map<PiUpgradeReplayCaseId, PiUpgradeReplayMeasurement>();
  for (const measurement of measurements) {
    validateMeasurement(measurement);
    if (byId.has(measurement.caseId)) throw new Error(`Duplicate replay case: ${measurement.caseId}.`);
    if (measurement.tokensAfter > measurement.tokensBefore) {
      throw new Error(`Replay case ${measurement.caseId} increased its token projection.`);
    }
    if (measurement.pendingReferencesRetained > measurement.pendingReferencesExpected) {
      throw new Error(`Replay case ${measurement.caseId} retained impossible references.`);
    }
    byId.set(measurement.caseId, measurement);
  }
  const failures: string[] = [];
  for (const caseId of PI_UPGRADE_REPLAY_CASE_IDS) {
    if (!byId.has(caseId)) failures.push(`missing:${caseId}`);
  }
  const rows = [...byId.values()];
  const sum = (select: (row: PiUpgradeReplayMeasurement) => number) =>
    rows.reduce((total, row) => total + select(row), 0);
  const tokensBefore = sum(({ tokensBefore }) => tokensBefore);
  const tokensAfter = sum(({ tokensAfter }) => tokensAfter);
  const expectedReferences = sum(({ pendingReferencesExpected }) => pendingReferencesExpected);
  const retainedReferences = sum(({ pendingReferencesRetained }) => pendingReferencesRetained);
  const continuationCorrectRatio = rows.length === 0
    ? 0
    : sum(({ continuationCorrect }) => continuationCorrect ? 1 : 0) / rows.length;
  const pendingReferenceRetentionRatio = expectedReferences === 0
    ? 1
    : retainedReferences / expectedReferences;
  const tokenReductionRatio = tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore;
  const emergencyProjectionRatio = rows.length === 0
    ? 1
    : sum(({ emergencyProjections }) => emergencyProjections) / rows.length;
  const minimumTurnsUntilNextCompaction = rows.length === 0
    ? 0
    : Math.min(...rows.map(({ turnsUntilNextCompaction }) => turnsUntilNextCompaction));
  const noOpAttempts = sum(({ noOpAttempts }) => noOpAttempts);
  const migrationFailures = sum(({ migrationFailures }) => migrationFailures);
  if (continuationCorrectRatio !== 1) failures.push("continuation_correctness");
  if (pendingReferenceRetentionRatio !== 1) failures.push("pending_reference_retention");
  if (tokenReductionRatio < PI_UPGRADE_QUALITY_THRESHOLDS.minimumTokenReductionRatio) {
    failures.push("token_reduction");
  }
  if (rows.some((row) =>
    (row.tokensBefore - row.tokensAfter) / row.tokensBefore <
      PI_UPGRADE_QUALITY_THRESHOLDS.minimumTokenReductionRatio
  )) failures.push("per_case_token_reduction");
  if (emergencyProjectionRatio > PI_UPGRADE_QUALITY_THRESHOLDS.maximumEmergencyProjectionRatio) {
    failures.push("emergency_projection_frequency");
  }
  if (minimumTurnsUntilNextCompaction < PI_UPGRADE_QUALITY_THRESHOLDS.minimumTurnsUntilNextCompaction) {
    failures.push("recompaction_interval");
  }
  if (noOpAttempts > PI_UPGRADE_QUALITY_THRESHOLDS.maximumNoOpAttempts) failures.push("no_op_attempts");
  if (migrationFailures > PI_UPGRADE_QUALITY_THRESHOLDS.maximumMigrationFailures) failures.push("migration_failures");
  return {
    version: 1,
    passed: failures.length === 0,
    caseCount: rows.length,
    continuationCorrectRatio,
    pendingReferenceRetentionRatio,
    tokenReductionRatio,
    emergencyProjectionRatio,
    totalDurationMs: sum(({ durationMs }) => durationMs),
    totalCostMicros: sum(({ costMicros }) => costMicros),
    totalCacheReadTokens: sum(({ cacheReadTokens }) => cacheReadTokens),
    totalCacheWriteTokens: sum(({ cacheWriteTokens }) => cacheWriteTokens),
    minimumTurnsUntilNextCompaction,
    noOpAttempts,
    migrationFailures,
    failures,
  };
}
