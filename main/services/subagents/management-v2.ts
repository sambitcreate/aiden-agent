import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import { SUBAGENT_AUTHORITY_VERSION } from "./authority-v2.js";

export const MAX_SUBAGENT_MANAGEMENT_WAIT_MS = 30_000;
export const MAX_SUBAGENT_STEERING_CHARS = 8_000;

export type SubagentManagementRequestV2 =
  | { version: 2; action: "status" | "stop" | "retry"; runId: string }
  | { version: 2; action: "wait"; runId: string; timeoutMs: number }
  | { version: 2; action: "steer"; runId: string; instruction: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function base(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.version !== SUBAGENT_AUTHORITY_VERSION ||
    !isSafeSubagentIdentifier(value.runId)
  ) {
    throw new Error("Invalid subagent management request.");
  }
  return value;
}

export function parseSubagentManagementRequestV2(value: unknown): SubagentManagementRequestV2 {
  const request = base(value);
  if (
    (request.action === "status" || request.action === "stop" || request.action === "retry") &&
    exactKeys(request, ["version", "action", "runId"])
  ) {
    return {
      version: SUBAGENT_AUTHORITY_VERSION,
      action: request.action,
      runId: request.runId as string,
    };
  }
  if (
    request.action === "wait" &&
    exactKeys(request, ["version", "action", "runId", "timeoutMs"]) &&
    Number.isSafeInteger(request.timeoutMs) &&
    (request.timeoutMs as number) >= 0 &&
    (request.timeoutMs as number) <= MAX_SUBAGENT_MANAGEMENT_WAIT_MS
  ) {
    return {
      version: SUBAGENT_AUTHORITY_VERSION,
      action: "wait",
      runId: request.runId as string,
      timeoutMs: request.timeoutMs as number,
    };
  }
  if (
    request.action === "steer" &&
    exactKeys(request, ["version", "action", "runId", "instruction"]) &&
    typeof request.instruction === "string" &&
    request.instruction.trim().length > 0 &&
    request.instruction.length <= MAX_SUBAGENT_STEERING_CHARS &&
    !request.instruction.includes("\0")
  ) {
    return {
      version: SUBAGENT_AUTHORITY_VERSION,
      action: "steer",
      runId: request.runId as string,
      instruction: request.instruction,
    };
  }
  throw new Error("Invalid subagent management request fields.");
}
