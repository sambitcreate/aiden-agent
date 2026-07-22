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
 * Chooses a quiet, stable prompt for an empty chat while retaining actionable
 * configuration guidance and a single follow-up state for active conversations.
 */
export function composerPlaceholder({
  ready,
  readinessMessage,
  hasMessages,
  chatId,
}: ComposerPlaceholderInput): string {
  if (!ready) return readinessMessage ?? UNAVAILABLE_COMPOSER_PLACEHOLDER;
  if (hasMessages) return FOLLOW_UP_COMPOSER_PLACEHOLDER;
  return NEW_CHAT_COMPOSER_PLACEHOLDERS[promptIndexForChat(chatId)];
}
