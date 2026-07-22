export const CHAT_CANCEL_ORIGINS = ["lifecycle", "user_stop"] as const;

export type ChatCancelOrigin = (typeof CHAT_CANCEL_ORIGINS)[number];

/** Only the visible Stop control may produce packaged-acceptance Stop evidence. */
export function isExplicitUserStop(value: unknown): value is "user_stop" {
  return value === "user_stop";
}
