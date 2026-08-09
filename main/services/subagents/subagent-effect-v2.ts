import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  isSafeSubagentIdentifier,
  type SubagentEffectActivityV1,
} from "../../../renderer/shared/subagent-runs.js";

export const MAX_DURABLE_SUBAGENT_EFFECTS = 512;
const DIGEST = /^[a-f0-9]{64}$/u;

export type DurableSubagentApprovalStateV2 = "prepared" | "authorized" | "consumed" | "cancelled";

export type DurableSubagentEffectStateV2 =
  | "prepared"
  | "authorized"
  | "dispatch_started"
  | "completed"
  | "remote_error"
  | "cancelled_before_dispatch"
  | "unknown";

export type DurableSubagentEffectTerminalStateV2 = Extract<
  DurableSubagentEffectStateV2,
  "completed" | "remote_error" | "cancelled_before_dispatch" | "unknown"
>;

export interface DurableSubagentApprovalV2 {
  version: 1;
  approvalId: string;
  effectId: string;
  runId: string;
  chatId: string;
  childId: string;
  toolCallId: string;
  toolName: string;
  state: DurableSubagentApprovalStateV2;
  argumentDigest: string;
  effectDigest: string;
  authorityDigest: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface DurableSubagentEffectV2 {
  version: 1;
  effectId: string;
  approvalId: string;
  runId: string;
  chatId: string;
  childId: string;
  toolCallId: string;
  toolName: string;
  effectKind: "mcp_mutation" | "shell";
  state: DurableSubagentEffectStateV2;
  argumentDigest: string;
  effectDigest: string;
  authorityDigest: string;
  preparedAt: number;
  updatedAt: number;
  terminalDigest?: string;
}

export interface PrepareDurableSubagentEffectV2Input {
  approvalId: string;
  effectId: string;
  runId: string;
  chatId: string;
  childId: string;
  toolCallId: string;
  toolName: string;
  effectKind: DurableSubagentEffectV2["effectKind"];
  argumentDigest: string;
  effectDigest: string;
  authorityDigest: string;
  expiresAt: number;
}

export interface DurableSubagentEffectOwnerV2 {
  effectId: string;
  approvalId: string;
  runId: string;
  chatId: string;
}

export interface FinishDurableSubagentEffectV2Input extends DurableSubagentEffectOwnerV2 {
  state: Exclude<DurableSubagentEffectTerminalStateV2, "cancelled_before_dispatch">;
  terminalDigest: string;
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    keys.length <= required.length + optional.length &&
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function identities(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isSafeSubagentIdentifier(value[key]));
}

export function parsePrepareDurableSubagentEffectV2Input(
  value: unknown,
): PrepareDurableSubagentEffectV2Input | undefined {
  const record = snapshotPlainRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "approvalId",
      "effectId",
      "runId",
      "chatId",
      "childId",
      "toolCallId",
      "toolName",
      "effectKind",
      "argumentDigest",
      "effectDigest",
      "authorityDigest",
      "expiresAt",
    ]) ||
    !identities(record, [
      "approvalId",
      "effectId",
      "runId",
      "chatId",
      "childId",
      "toolCallId",
      "toolName",
    ]) ||
    (record.effectKind !== "mcp_mutation" && record.effectKind !== "shell") ||
    !digest(record.argumentDigest) ||
    !digest(record.effectDigest) ||
    !digest(record.authorityDigest) ||
    !timestamp(record.expiresAt)
  ) {
    return undefined;
  }
  return record as unknown as PrepareDurableSubagentEffectV2Input;
}

export function parseDurableSubagentEffectOwnerV2(
  value: unknown,
): DurableSubagentEffectOwnerV2 | undefined {
  const record = snapshotPlainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["effectId", "approvalId", "runId", "chatId"]) ||
    !identities(record, ["effectId", "approvalId", "runId", "chatId"])
  ) {
    return undefined;
  }
  return record as unknown as DurableSubagentEffectOwnerV2;
}

export function parseFinishDurableSubagentEffectV2Input(
  value: unknown,
): FinishDurableSubagentEffectV2Input | undefined {
  const record = snapshotPlainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["effectId", "approvalId", "runId", "chatId", "state", "terminalDigest"]) ||
    !identities(record, ["effectId", "approvalId", "runId", "chatId"]) ||
    (record.state !== "completed" && record.state !== "remote_error" && record.state !== "unknown") ||
    !digest(record.terminalDigest)
  ) {
    return undefined;
  }
  return record as unknown as FinishDurableSubagentEffectV2Input;
}

export function parseDurableSubagentApprovalV2(
  value: unknown,
): DurableSubagentApprovalV2 | undefined {
  const record = snapshotPlainRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "version",
      "approvalId",
      "effectId",
      "runId",
      "chatId",
      "childId",
      "toolCallId",
      "toolName",
      "state",
      "argumentDigest",
      "effectDigest",
      "authorityDigest",
      "createdAt",
      "updatedAt",
      "expiresAt",
    ]) ||
    record.version !== 1 ||
    !identities(record, [
      "approvalId",
      "effectId",
      "runId",
      "chatId",
      "childId",
      "toolCallId",
      "toolName",
    ]) ||
    (record.state !== "prepared" && record.state !== "authorized" && record.state !== "consumed" && record.state !== "cancelled") ||
    !digest(record.argumentDigest) ||
    !digest(record.effectDigest) ||
    !digest(record.authorityDigest) ||
    !timestamp(record.createdAt) ||
    !timestamp(record.updatedAt) ||
    !timestamp(record.expiresAt) ||
    record.updatedAt < record.createdAt ||
    record.expiresAt < record.createdAt
  ) {
    return undefined;
  }
  return record as unknown as DurableSubagentApprovalV2;
}

const TERMINAL_EFFECT_STATES = new Set<DurableSubagentEffectStateV2>([
  "completed",
  "remote_error",
  "cancelled_before_dispatch",
  "unknown",
]);

export function parseDurableSubagentEffectV2(value: unknown): DurableSubagentEffectV2 | undefined {
  const record = snapshotPlainRecord(value);
  if (
    !record ||
    !exactKeys(
      record,
      [
        "version",
        "effectId",
        "approvalId",
        "runId",
        "chatId",
        "childId",
        "toolCallId",
        "toolName",
        "effectKind",
        "state",
        "argumentDigest",
        "effectDigest",
        "authorityDigest",
        "preparedAt",
        "updatedAt",
      ],
      ["terminalDigest"],
    ) ||
    record.version !== 1 ||
    !identities(record, [
      "effectId",
      "approvalId",
      "runId",
      "chatId",
      "childId",
      "toolCallId",
      "toolName",
    ]) ||
    (record.effectKind !== "mcp_mutation" && record.effectKind !== "shell") ||
    (record.state !== "prepared" &&
      record.state !== "authorized" &&
      record.state !== "dispatch_started" &&
      record.state !== "completed" &&
      record.state !== "remote_error" &&
      record.state !== "cancelled_before_dispatch" &&
      record.state !== "unknown") ||
    !digest(record.argumentDigest) ||
    !digest(record.effectDigest) ||
    !digest(record.authorityDigest) ||
    !timestamp(record.preparedAt) ||
    !timestamp(record.updatedAt) ||
    record.updatedAt < record.preparedAt
  ) {
    return undefined;
  }
  const terminal = TERMINAL_EFFECT_STATES.has(record.state as DurableSubagentEffectStateV2);
  if (
    (terminal && !digest(record.terminalDigest)) ||
    (!terminal && record.terminalDigest !== undefined)
  ) {
    return undefined;
  }
  return record as unknown as DurableSubagentEffectV2;
}

export function durableSubagentEffectRecordsMatchV2(
  approval: DurableSubagentApprovalV2,
  effect: DurableSubagentEffectV2,
): boolean {
  const pairedState =
    (effect.state === "prepared" && approval.state === "prepared") ||
    (effect.state === "authorized" && approval.state === "authorized") ||
    (effect.state === "cancelled_before_dispatch" && approval.state === "cancelled") ||
    (["dispatch_started", "completed", "remote_error", "unknown"].includes(effect.state) &&
      approval.state === "consumed");
  return (
    pairedState &&
    approval.approvalId === effect.approvalId &&
    approval.effectId === effect.effectId &&
    approval.runId === effect.runId &&
    approval.chatId === effect.chatId &&
    approval.childId === effect.childId &&
    approval.toolCallId === effect.toolCallId &&
    approval.toolName === effect.toolName &&
    approval.argumentDigest === effect.argumentDigest &&
    approval.effectDigest === effect.effectDigest &&
    approval.authorityDigest === effect.authorityDigest &&
    approval.createdAt === effect.preparedAt &&
    approval.updatedAt === effect.updatedAt
  );
}

export function subagentEffectEvidenceDigestV2(label: string): string {
  return createHash("sha256")
    .update("aiden-subagent-effect-evidence-v1\0", "utf8")
    .update(label, "utf8")
    .digest("hex");
}

export function isDurableSubagentEffectTerminalV2(
  state: DurableSubagentEffectStateV2,
): state is DurableSubagentEffectTerminalStateV2 {
  return TERMINAL_EFFECT_STATES.has(state);
}

const EFFECT_ACTIVITY_LABELS: Record<
  DurableSubagentEffectV2["effectKind"],
  Record<DurableSubagentEffectStateV2, string>
> = {
  mcp_mutation: {
    prepared: "Remote change prepared",
    authorized: "Remote change authorized",
    dispatch_started: "Remote change sent",
    completed: "Remote change completed",
    remote_error: "Remote change failed",
    cancelled_before_dispatch: "Remote change cancelled before sending",
    unknown: "Remote change outcome unknown. Check the remote system before retrying.",
  },
  shell: {
    prepared: "Command prepared",
    authorized: "Command authorized",
    dispatch_started: "Command started",
    completed: "Command completed",
    remote_error: "Command failed",
    cancelled_before_dispatch: "Command cancelled before starting",
    unknown: "Command outcome unknown. Check the workspace before retrying.",
  },
};

export function projectDurableSubagentEffectActivityV1(
  effect: DurableSubagentEffectV2,
): SubagentEffectActivityV1 {
  return {
    version: 1,
    kind: effect.effectKind,
    state: effect.state,
    label: EFFECT_ACTIVITY_LABELS[effect.effectKind][effect.state],
    updatedAt: effect.updatedAt,
  };
}
