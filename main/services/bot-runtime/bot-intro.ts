// The one-time self-intro a Bot posts when it is genuinely created (spec §4.3).
//
// It is a hidden-prompt turn: the person sees only the Bot's reply. The turn
// offers no tools (`currentTools` returns none for an intro request), and its
// request id is fixed per Bot, so a repeat — a second Start Chat, a retry, a
// restart — is deduped by the runtime and never asks the model twice.

import type { BotSessionService } from "./bot-session-service.js";

export const BOT_INTRO_REQUEST_PREFIX = "intro:";

export const BOT_INTRO_PROMPT = [
  "Introduce yourself to me for the first time, in two or three short sentences.",
  "Say what you understand your job to be from your instructions, then ask what I need from you first.",
  "End with up to five short replies I can tap, one per line, written exactly like:",
  "A) First choice",
  "B) Second choice",
  "Don't use any tools.",
].join("\n");

export function botIntroRequestId(botId: string): string {
  return `${BOT_INTRO_REQUEST_PREFIX}${botId}`;
}

export function isBotIntroRequest(requestId: string | undefined): boolean {
  return requestId?.startsWith(BOT_INTRO_REQUEST_PREFIX) ?? false;
}

/**
 * Ask a new Bot to introduce itself. Returns false, and sends nothing, when the
 * Bot has no AI model or Bots are held by another window.
 */
export async function sendBotIntro(
  service: Pick<BotSessionService, "send" | "state">,
  botId: string,
): Promise<boolean> {
  const state = await service.state(botId);
  if (state.kind === "needs_model" || state.kind === "unavailable") return false;
  await service.send(botId, { text: BOT_INTRO_PROMPT, requestId: botIntroRequestId(botId), hidden: true });
  return true;
}
