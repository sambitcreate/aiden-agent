import { toast } from "../components/ui";
import { applyBotBubbleChange, botBubblesApi } from "../lib/bot-bubbles-api";
import { userFacingErrorMessage } from "../lib/ipc-error";
import type { BotBubbleRect } from "../shared/bot-bubbles";

export function reportBubbleError(change: Promise<unknown>, fallback: string): void {
  void change.catch((error: unknown) => toast.error(userFacingErrorMessage(error, fallback)));
}

export function openBubble(botId: string | null): void {
  reportBubbleError(applyBotBubbleChange(botBubblesApi.open(botId)), "Aiden couldn’t open that chat.");
}

export function tuckBubble(ifOpen?: string): void {
  reportBubbleError(
    applyBotBubbleChange(
      ifOpen === undefined ? botBubblesApi.open(null) : botBubblesApi.open(null, { ifOpen }),
    ),
    "Aiden couldn’t tuck that chat away.",
  );
}

export function closeBubble(botId: string): void {
  reportBubbleError(applyBotBubbleChange(botBubblesApi.close(botId)), "Aiden couldn’t close that bubble.");
}

export function bringBubbleBack(
  botId: string,
  options: { rect?: BotBubbleRect; fallback: string },
): void {
  reportBubbleError(applyBotBubbleChange(botBubblesApi.bringBack(botId, options.rect)), options.fallback);
}
