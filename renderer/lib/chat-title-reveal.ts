export const CHAT_TITLE_FADE_OUT_MS = 200;
export const CHAT_TITLE_CHARACTER_DURATION_MS = 160;
export const CHAT_TITLE_STAGGER_WINDOW_MS = 340;
export const CHAT_TITLE_MAX_STAGGER_MS = 40;
export const CHAT_TITLE_REVEAL_DURATION_MS =
  CHAT_TITLE_STAGGER_WINDOW_MS + CHAT_TITLE_CHARACTER_DURATION_MS;

export interface ChatTitleRevealEvent {
  chatId: string;
  version: number;
  previousTitle: string;
}

export interface ChatTitleRevealCharacter {
  value: string;
  delayMs: number;
}

/** Keep the whole character sweep quick even when a generated title is long. */
export function createChatTitleReveal(title: string): ChatTitleRevealCharacter[] {
  const characters = Array.from(title);
  const stepMs =
    characters.length > 1
      ? Math.min(CHAT_TITLE_MAX_STAGGER_MS, CHAT_TITLE_STAGGER_WINDOW_MS / (characters.length - 1))
      : 0;

  return characters.map((value, index) => ({
    value,
    delayMs: Math.round(index * stepMs),
  }));
}
