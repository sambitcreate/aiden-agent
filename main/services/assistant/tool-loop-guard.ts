import { createHash } from "node:crypto";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { AgentContext } from "@earendil-works/pi-agent-core";

export const MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS = 2;
export const ATTENDED_TOOL_FAILURE_RECOVERY_REPLY =
  "I couldn't complete that action. Review the requested details and permissions before trying again.";

export function attendedToolRecoveryMessage(): string {
  return [
    "[Aiden host guard] Tool recovery reached its failure or permission limit. Do not call or imitate any tool",
    `again in this response. Reply with exactly this text and nothing else: "${ATTENDED_TOOL_FAILURE_RECOVERY_REPLY}"`,
  ].join(" ");
}

export interface AttendedToolErrorState {
  failures: ReadonlyMap<string, number>;
  totalFailures: number;
  shouldStop: boolean;
}
export const MAX_ATTENDED_TOOL_FAILURES = 8;
const executedArguments = new WeakMap<object, string | undefined>();
function argumentDigest(value: unknown): string | undefined {
  const args = copyBoundedJson(value, { maxNodes: 2048, maxDepth: 24, maxSize: 16384, measure: utf8Size });
  if (args === undefined) return undefined;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return createHash("sha256").update(canonical(args)).digest("hex");
}
/** Called at Pi's validated-argument boundary, before approvals or execution. */
export function recordAttendedToolArguments(call: object, args: unknown): void {
  const digest = argumentDigest(args);
  executedArguments.set(call, digest);
}

/** Digests only; never retain tool arguments or provider error text. */
export function advanceAttendedToolErrorState(
  current: AttendedToolErrorState | undefined,
  toolResults: readonly { isError?: boolean; toolName?: string; toolCallId?: string; content?: unknown }[],
  calls: readonly { id: string; name: string; arguments: unknown }[] = [],
): AttendedToolErrorState {
  if (current?.shouldStop) return current;
  const failures = new Map(current?.failures);
  let totalFailures = current?.totalFailures ?? 0;
  let shouldStop = current?.shouldStop ?? false;
  for (const result of toolResults) {
    if (!result.isError) continue;
    totalFailures += 1;
    const call = calls.find((item) => item.id === result.toolCallId);
    const text = Array.isArray(result.content) ? result.content.filter((item) => item?.type === "text").map((item) => item.text).join(" ").slice(0, 4096) : "";
    // Closed categories only. Denial is terminal even if a provider changes arguments.
    const terminal = /user denied this action|user declined this automation|action was cancelled before approval|permission denied|authority.*revoked|approval.*cancelled|operation aborted/iu.test(text);
    const category = terminal ? "denied" : /invalid|validation|malformed/iu.test(text) ? "invalid" : "failed";
    const digest = call ? (executedArguments.has(call) ? executedArguments.get(call) : argumentDigest(call.arguments)) : "unknown";
    if (terminal || totalFailures >= MAX_ATTENDED_TOOL_FAILURES) shouldStop = true;
    // Oversized/unfingerprintable inputs count toward the total, never as an identical call.
    if (digest === undefined) { if (shouldStop) break; else continue; }
    const key = createHash("sha256").update(`${result.toolName ?? call?.name ?? "unknown"}\0${category}\0${digest}`).digest("hex");
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    if (terminal || count >= MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS || totalFailures >= MAX_ATTENDED_TOOL_FAILURES) shouldStop = true;
    if (shouldStop) break;
  }
  return { failures, totalFailures, shouldStop };
}

/**
 * Converts a repeated tool failure into one final text-only turn. Removing
 * every tool matters: some OpenAI-compatible local providers ignore a tool
 * error and emit the same invalid call again even when the system prompt
 * explicitly forbids it.
 */
export function recoverAttendedToolErrorContext(
  context: AgentContext,
  timestamp: number = Date.now(),
): AgentContext {
  return {
    ...context,
    messages: [
      ...context.messages,
      {
        role: "user",
        content: attendedToolRecoveryMessage(),
        timestamp,
      },
    ],
    tools: [],
  };
}
