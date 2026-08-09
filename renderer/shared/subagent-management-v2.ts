import {
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV2,
} from "./subagent-runs";

export type SubagentManagementRequestV2 =
  | { version: 2; action: "status" | "stop" | "retry"; runId: string }
  | { version: 2; action: "wait"; runId: string; timeoutMs: number }
  | { version: 2; action: "steer"; runId: string; instruction: string };

export type SubagentManagementResultV2 =
  | { version: 2; action: "status"; snapshot: SubagentRunSnapshotV2 }
  | {
      version: 2;
      action: "wait";
      snapshot: SubagentRunSnapshotV2;
      timedOut: boolean;
    }
  | {
      version: 2;
      action: "stop";
      snapshot: SubagentRunSnapshotV2;
      changed: boolean;
    }
  | {
      version: 2;
      action: "retry";
      sourceSnapshot: SubagentRunSnapshotV2;
      snapshot: SubagentRunSnapshotV2;
    }
  | { version: 2; action: "steer"; snapshot: SubagentRunSnapshotV2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** Parse every main response again before it enters renderer state. */
export function parseSubagentManagementResultV2(
  value: unknown,
): SubagentManagementResultV2 | undefined {
  if (!isRecord(value) || value.version !== 2 || typeof value.action !== "string") {
    return undefined;
  }
  const snapshot = parseSubagentRunSnapshotV2(value.snapshot);
  if (!snapshot) return undefined;
  if (
    (value.action === "status" || value.action === "steer") &&
    exactKeys(value, ["version", "action", "snapshot"])
  ) {
    return { version: 2, action: value.action, snapshot };
  }
  if (
    value.action === "wait" &&
    exactKeys(value, ["version", "action", "snapshot", "timedOut"]) &&
    typeof value.timedOut === "boolean"
  ) {
    return { version: 2, action: "wait", snapshot, timedOut: value.timedOut };
  }
  if (
    value.action === "stop" &&
    exactKeys(value, ["version", "action", "snapshot", "changed"]) &&
    typeof value.changed === "boolean"
  ) {
    return { version: 2, action: "stop", snapshot, changed: value.changed };
  }
  if (
    value.action === "retry" &&
    exactKeys(value, ["version", "action", "sourceSnapshot", "snapshot"])
  ) {
    const sourceSnapshot = parseSubagentRunSnapshotV2(value.sourceSnapshot);
    if (
      !sourceSnapshot ||
      snapshot.retryOfRunId !== sourceSnapshot.runId ||
      snapshot.chatId !== sourceSnapshot.chatId ||
      snapshot.workspaceId !== sourceSnapshot.workspaceId
    ) {
      return undefined;
    }
    return { version: 2, action: "retry", sourceSnapshot, snapshot };
  }
  return undefined;
}
