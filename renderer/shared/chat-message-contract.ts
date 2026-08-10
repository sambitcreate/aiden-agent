export const MAX_CHAT_MESSAGE_CONTENT_BYTES = 1024 * 1024;

// Renderer-owned selectors cross an IPC trust boundary and can remain alive
// for the duration of persistence or provider startup. Keep their character
// and encoded-byte limits explicit so non-ASCII input cannot bypass admission.
export const MAX_CHAT_ID_CHARS = 256;
export const MAX_CHAT_ID_BYTES = 1024;
export const MAX_WORKSPACE_ID_CHARS = 256;
export const MAX_WORKSPACE_ID_BYTES = 1024;
export const MAX_PROVIDER_ID_CHARS = 256;
export const MAX_PROVIDER_ID_BYTES = 1024;
export const MAX_MODEL_ID_CHARS = 512;
export const MAX_MODEL_ID_BYTES = 2048;

export const APPEND_RECONCILIATION_REQUIRED = "AIDEN_APPEND_RECONCILIATION_REQUIRED";
export const APPEND_RECONCILIATION_BLOCKED = "AIDEN_APPEND_RECONCILIATION_BLOCKED";

export type AppendReconciliationFailureKind = "current" | "blocked";

const APPEND_RECONCILIATION_REQUIRED_MESSAGE = `${APPEND_RECONCILIATION_REQUIRED}: Message save status is unknown. Reload Aiden before sending again.`;
const APPEND_RECONCILIATION_BLOCKED_MESSAGE = `${APPEND_RECONCILIATION_BLOCKED}: Reload Aiden before creating or sending another message.`;

export function appendReconciliationFailureMessage(
  kind: AppendReconciliationFailureKind,
): string {
  return kind === "current"
    ? APPEND_RECONCILIATION_REQUIRED_MESSAGE
    : APPEND_RECONCILIATION_BLOCKED_MESSAGE;
}

export function appendReconciliationFailureKind(
  error: unknown,
): AppendReconciliationFailureKind | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith(APPEND_RECONCILIATION_REQUIRED_MESSAGE)) return "current";
  if (message.endsWith(APPEND_RECONCILIATION_BLOCKED_MESSAGE)) return "blocked";
  return null;
}

export function isAppendReconciliationRequired(error: unknown): boolean {
  return appendReconciliationFailureKind(error) !== null;
}
