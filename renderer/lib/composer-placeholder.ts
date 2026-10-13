export const NEW_CHAT_COMPOSER_PLACEHOLDERS = [
  "Let’s build…",
  "Let’s work on…",
  "My next idea is…",
  "Help me create…",
  "I want to explore…",
  "Can you help me…",
  "Let’s figure out…",
  "I’m ready to make…",
  "I want to improve…",
  "Let’s get started with…",
] as const;

export const FOLLOW_UP_COMPOSER_PLACEHOLDER = "Follow up";
export const UNAVAILABLE_COMPOSER_PLACEHOLDER = "Choose a chat model to start";
/** Readiness copy for a chat whose response is still running elsewhere. */
export const BACKGROUND_RESPONSE_READINESS_MESSAGE = "Response continues in the background…";
export const BACKGROUND_RESPONSE_COMPOSER_PLACEHOLDER = "Waiting for the response…";
/**
 * Short placeholder for any other blocked state. The composer already prints
 * the full readiness message once, in its status line, so the placeholder
 * must not repeat it.
 */
export const READINESS_COMPOSER_PLACEHOLDER = "Can’t send yet";
/**
 * Placeholder while the blocking state is still settling on its own, such as
 * "Loading chat…". Readiness copy ending in an ellipsis marks work in progress,
 * which should read as a short wait rather than as an error.
 */
export const PENDING_COMPOSER_PLACEHOLDER = "One moment…";

interface ComposerPlaceholderInput {
  ready: boolean;
  readinessMessage?: string;
  hasMessages: boolean;
  chatId: string;
}

function promptIndexForChat(chatId: string): number {
  let hash = 0;
  for (let index = 0; index < chatId.length; index += 1) {
    hash = (hash * 31 + chatId.charCodeAt(index)) >>> 0;
  }
  return hash % NEW_CHAT_COMPOSER_PLACEHOLDERS.length;
}

/**
 * Chooses a quiet, stable prompt for an empty chat and a single follow-up state
 * for active conversations. While a readiness message blocks sending, the
 * composer shows that message in its status line, so the placeholder stays a
 * short neutral cue instead of repeating it.
 */
export function composerPlaceholder({
  ready,
  readinessMessage,
  hasMessages,
  chatId,
}: ComposerPlaceholderInput): string {
  if (!ready) {
    if (!readinessMessage) return UNAVAILABLE_COMPOSER_PLACEHOLDER;
    if (readinessMessage === BACKGROUND_RESPONSE_READINESS_MESSAGE) {
      return BACKGROUND_RESPONSE_COMPOSER_PLACEHOLDER;
    }
    return readinessMessage.trimEnd().endsWith("…")
      ? PENDING_COMPOSER_PLACEHOLDER
      : READINESS_COMPOSER_PLACEHOLDER;
  }
  if (hasMessages) return FOLLOW_UP_COMPOSER_PLACEHOLDER;
  return NEW_CHAT_COMPOSER_PLACEHOLDERS[promptIndexForChat(chatId)];
}

interface ChatReadinessInput {
  loading: boolean;
  failed: boolean;
  missing: boolean;
  appendReconciliationRequired: boolean;
  /** A response for this chat is still running without a visible projection. */
  drainingWithoutProjection: boolean;
}

/** The chat-level reason a desktop chat cannot accept a message yet, if any. */
export function chatReadinessMessage({
  loading,
  failed,
  missing,
  appendReconciliationRequired,
  drainingWithoutProjection,
}: ChatReadinessInput): string | undefined {
  if (loading) return "Loading chat…";
  if (failed) return "This chat could not be loaded. Try again.";
  if (missing) return "This chat is no longer available. Start a new agent.";
  if (appendReconciliationRequired) {
    return "Message save status is unknown. Reload Aiden before sending another message.";
  }
  if (drainingWithoutProjection) return BACKGROUND_RESPONSE_READINESS_MESSAGE;
  return undefined;
}
