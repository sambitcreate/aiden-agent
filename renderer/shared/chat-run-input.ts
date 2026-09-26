/**
 * Shared foreground run-input admission contract (Remote Slice 2). The Remote
 * API `POST /streams/{streamId}/inputs` route and the desktop `chat:admitRunInput`
 * IPC surface both resolve to this result shape through the Mac-owned admission
 * boundary in main/services/chat-run-input-admission.ts.
 */

export type ChatRunInputMode = "steer" | "queue";

export type ChatRunInputRejectionReason =
  | "run_not_active"
  | "cancelled"
  | "capacity"
  | "invalid";

export interface ChatRunInputAdmissionResult {
  admitted: boolean;
  queue?: "steer" | "follow-up";
  reason?: ChatRunInputRejectionReason;
  /** True once the user message is durable in the chat transcript. */
  committed: boolean;
  messageId?: string;
}

const MAX_RUN_INPUT_TEXT = 200_000;

/** Validate a desktop IPC run-input payload ({mode, text}). */
export function parseChatRunInput(value: unknown): { mode: ChatRunInputMode; text: string } {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    Object.keys(record).some((key) => key !== "mode" && key !== "text") ||
    (record.mode !== "steer" && record.mode !== "queue") ||
    typeof record.text !== "string" ||
    record.text.length === 0 ||
    record.text.length > MAX_RUN_INPUT_TEXT
  ) {
    throw new Error("Invalid chat run input.");
  }
  return { mode: record.mode, text: record.text };
}
