/** Host admission is not evidence that the model consumed a queued instruction. */
export const CHAT_RUN_INPUT_FEATURE = "chat-run-input-v1";
export const MAX_CHAT_RUN_INPUT_BYTES = 16 * 1024;
export interface ChatRunInputRequest {
  requestId: string;
  mode: "steer" | "queue";
  text: string;
}
export type ChatRunInputReceipt = {
  requestId: string;
  streamId: string;
  mode: ChatRunInputRequest["mode"];
} & (
  | { accepted: true; admission: "queued"; messageId: string }
  | { accepted: false; reason: "not-active" | "cancelled" | "capacity" }
);
export function parseChatRunInput(value: unknown): ChatRunInputRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run input.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 ||
    typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId) ||
    (input.mode !== "steer" && input.mode !== "queue") ||
    typeof input.text !== "string" || !input.text.trim() ||
    new TextEncoder().encode(input.text).byteLength > MAX_CHAT_RUN_INPUT_BYTES) {
    throw new Error("Invalid run input.");
  }
  return { requestId: input.requestId.toLowerCase(), mode: input.mode, text: input.text };
}
