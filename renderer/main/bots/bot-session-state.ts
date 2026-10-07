import type { BotSessionState } from "../../../main/services/bot-runtime/bot-session-service";

export type { BotSessionState };

export const BOT_PAUSED_ROW_LABEL = "Paused — tap to resume";
export const BOT_NEEDS_MODEL_LABEL = "Needs an AI model";
export const BOT_UNAVAILABLE_LABEL = "Bots are open in another Aiden window.";

/** The one plain-language status a Bot list row shows instead of its preview. */
export function botRowStatusLabel(state: BotSessionState | undefined): string | null {
  switch (state?.kind) {
    case "interrupted":
      return BOT_PAUSED_ROW_LABEL;
    case "needs_model":
      return BOT_NEEDS_MODEL_LABEL;
    case "unavailable":
      return BOT_UNAVAILABLE_LABEL;
    default:
      return null;
  }
}
