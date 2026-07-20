// Pure policy shared by the Pi runtime. Keep this Electron-free so the
// keyless-provider and terminal-error contracts have fast, deterministic tests.

/**
 * Pi requires a non-empty credential even when a configured local endpoint does
 * not authenticate requests. This is intentionally non-secret and is never
 * persisted in Aiden's key store.
 */
export const NO_AUTH_API_KEY = "aiden-local-no-auth";

export function resolveRuntimeApiKey(
  provider: { needsKey: boolean },
  storedApiKey: string | null | undefined,
): string | undefined {
  if (!provider.needsKey) return NO_AUTH_API_KEY;
  const key = storedApiKey?.trim();
  return key || undefined;
}

type TerminalAssistantMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

/** Extract a Pi protocol-level terminal error from an Agent message. */
export function terminalGenerationError(message: TerminalAssistantMessage): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "The model couldn't complete this response.";
}

/** Pi reports user-initiated stops as a terminal assistant message as well. */
export function terminalGenerationWasAborted(message: TerminalAssistantMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

/** Return final text when a provider completes without emitting text deltas. */
export function terminalAssistantText(message: { role?: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/** Add terminal text only when this assistant turn did not already stream it. */
export function terminalAssistantTextFallback(
  message: { role?: string; content?: unknown },
  receivedTextDelta: boolean,
): string {
  return receivedTextDelta ? "" : terminalAssistantText(message);
}
