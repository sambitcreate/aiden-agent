import { createHash } from "node:crypto";
import type {
  DurableJobCheckpoint,
  DurableJobInput,
  DurableJobRecovery,
  DurableJobSnapshot,
} from "../../../renderer/shared/durable-jobs.js";

export const JOB_LIMITS = Object.freeze({
  unresolvedJobs: 1_000,
  unresolvedControls: 4_096,
  eventsPerJob: 64,
  attemptsPerJob: 64,
  recordBytes: 32_768,
});
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const JOB_STATES = [
  "admitting",
  "queued",
  "running",
  "pause_requested",
  "paused",
  "interrupted",
  "needs_attention",
  "waiting_approval",
  "waiting_input",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;
export const RECOVERY_KINDS = [
  "not_started",
  "checkpoint",
  "completed",
  "failed_safe",
  "waiting_approval",
  "waiting_input",
  "interrupted",
  "unknown",
  "missing",
  "stale_authority",
  "unsettled",
] as const;
export const terminal = (state: DurableJobSnapshot["state"]) =>
  state === "succeeded" || state === "cancelled";

export class JobError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "conflict"
      | "capacity"
      | "lost_lease"
      | "unsafe"
      | "closed",
    message: string = code,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new JobError("invalid");
}
export function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new JobError("invalid");
}
export function record(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new JobError("invalid");
  for (const key of keys) {
    if (!("value" in Object.getOwnPropertyDescriptor(value, key)!))
      throw new JobError("invalid");
  }
}
const inputKeys = [
  "profileId",
  "botId",
  "workspaceId",
  "chatId",
  "messageId",
  "turnId",
  "inputRef",
  "inputDigest",
  "providerId",
  "modelId",
  "authorityRevision",
  "audienceId",
];
export function parseInput(value: unknown): DurableJobInput {
  record(value, inputKeys);
  for (const key of inputKeys) identifier(value[key]);
  if (!/^[a-f0-9]{64}$/u.test(value.inputDigest as string))
    throw new JobError("invalid");
  return Object.fromEntries(
    inputKeys.map((key) => [key, value[key]]),
  ) as unknown as DurableJobInput;
}
export function parseCheckpoint(value: unknown): DurableJobCheckpoint {
  record(value, [
    "sessionId",
    "headId",
    "inputMessageId",
    "operationIds",
    "childRunIds",
  ]);
  for (const key of ["sessionId", "headId", "inputMessageId"])
    identifier(value[key]);
  for (const key of ["operationIds", "childRunIds"]) {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      list.length > 64 ||
      new Set(list).size !== list.length
    )
      throw new JobError("invalid");
    list.forEach(identifier);
  }
  return {
    sessionId: value.sessionId as string,
    headId: value.headId as string,
    inputMessageId: value.inputMessageId as string,
    operationIds: [...(value.operationIds as string[])],
    childRunIds: [...(value.childRunIds as string[])],
  };
}
export function parseSnapshot(value: unknown): DurableJobSnapshot {
  record(value, [
    "version",
    "id",
    "input",
    "state",
    "intent",
    "revision",
    "createdAt",
    "updatedAt",
    "recovery",
    "checkpoint",
    "resultRef",
    "waitId",
    "dispatched",
    "executionCount",
    "attemptId",
    "continuation",
    "pendingReconciliation",
  ]);
  if (
    value.version !== 1 ||
    !JOB_STATES.includes(value.state as never) ||
    !["none", "pause", "stop", "cancel"].includes(value.intent as string) ||
    !RECOVERY_KINDS.includes(value.recovery as never) ||
    !["none", "resume", "retry"].includes(value.continuation as string)
  )
    throw new JobError("invalid");
  identifier(value.id);
  parseInput(value.input);
  for (const key of ["revision", "createdAt", "updatedAt", "executionCount"])
    integer(value[key]);
  for (const key of ["resultRef", "waitId", "attemptId"])
    if (value[key] !== null) identifier(value[key]);
  if (value.checkpoint !== null) {
    const checkpoint = parseCheckpoint(value.checkpoint);
    if (
      checkpoint.inputMessageId !== (value.input as DurableJobInput).messageId
    )
      throw new JobError("invalid");
  }
  if (
    typeof value.dispatched !== "boolean" ||
    typeof value.pendingReconciliation !== "boolean" ||
    JSON.stringify(value).length > JOB_LIMITS.recordBytes
  )
    throw new JobError("invalid");
  if (
    (value.createdAt as number) > (value.updatedAt as number) ||
    (value.executionCount as number) > JOB_LIMITS.attemptsPerJob ||
    value.dispatched !== (value.executionCount as number) > 0 ||
    (value.attemptId !== null) !== value.dispatched ||
    (value.state === "succeeded" && value.resultRef === null) ||
    ((value.state === "waiting_approval" || value.state === "waiting_input") &&
      value.waitId === null)
  )
    throw new JobError("invalid");
  return {
    ...structuredClone(value),
    input: parseInput(value.input),
    checkpoint:
      value.checkpoint === null ? null : parseCheckpoint(value.checkpoint),
  } as unknown as DurableJobSnapshot;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Trusted host evidence, never a renderer/Remote-supplied assertion. */
export interface RecoveryEvidence {
  kind: DurableJobRecovery;
  checkpoint: DurableJobCheckpoint | null;
  resultRef: string | null;
  waitId: string | null;
}
export function parseEvidence(value: unknown): RecoveryEvidence {
  record(value, ["kind", "checkpoint", "resultRef", "waitId"]);
  if (!RECOVERY_KINDS.includes(value.kind as never))
    throw new JobError("invalid");
  if (value.checkpoint !== null) parseCheckpoint(value.checkpoint);
  if (value.resultRef !== null) identifier(value.resultRef);
  if (value.waitId !== null) identifier(value.waitId);
  if (
    (value.kind === "checkpoint" || value.kind === "failed_safe") &&
    !value.checkpoint
  )
    throw new JobError("invalid");
  if (value.kind === "completed" && !value.resultRef)
    throw new JobError("invalid");
  if (
    (value.kind === "waiting_approval" || value.kind === "waiting_input") &&
    !value.waitId
  )
    throw new JobError("invalid");
  return {
    kind: value.kind as DurableJobRecovery,
    checkpoint:
      value.checkpoint === null ? null : parseCheckpoint(value.checkpoint),
    resultRef: value.resultRef as string | null,
    waitId: value.waitId as string | null,
  };
}
