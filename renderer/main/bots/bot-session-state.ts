/**
 * Mirrors `BotSessionState` from the durable Bot runtime
 * (`main/services/bot-runtime/bot-session-service.ts`, plan Task 1.3).
 * TEMPORARY local copy: replace this declaration with an import of the
 * runtime's exported type once it lands, and keep the shapes identical.
 */
export type BotSessionState =
  | { kind: "idle" } | { kind: "running"; submissionId: string }
  | { kind: "interrupted"; submissionId: string } | { kind: "needs_model" } | { kind: "unavailable"; reason: "held_by_live_process" };

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
