// The Bot chat's one status slot (docs/plans/bot-ux-simplification.md §4.7):
// below the transcript, at most one status card, the most important one.
// Each card keeps its own actions; the others come back once it clears.

export type BotStatusKind =
  | "model_error"
  | "spending_reached"
  | "paused"
  | "interrupted"
  | "usage_limit"
  | "saved_resume"
  | "spending_nearing"
  | "plan";

/**
 * Highest first. A model the Bot can't use and a spent limit stop everything,
 * so they come first; then the person's own pause, then an interrupted turn
 * (its Resume replays the same request, so a failed Resume stays on offer
 * there, and a saved Resume shows with it). A usage-limit wait clears by
 * itself; a saved Resume waiting for confirmation shows on its own once
 * nothing above applies. The nearing line is only a
 * heads-up, and an approved or ended plan is the quietest.
 */
export const BOT_STATUS_PRIORITY: readonly BotStatusKind[] = [
  "model_error",
  "spending_reached",
  "paused",
  "interrupted",
  "usage_limit",
  "saved_resume",
  "spending_nearing",
  "plan",
];

/** The one status to show from those that currently apply, or null. */
export function pickBotStatus(applies: Partial<Record<BotStatusKind, boolean>>): BotStatusKind | null {
  return BOT_STATUS_PRIORITY.find((kind) => applies[kind] === true) ?? null;
}
