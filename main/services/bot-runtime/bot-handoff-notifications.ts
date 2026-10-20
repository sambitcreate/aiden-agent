// The Mac notification for a hand-off card (plan §4.1, blueprint G24):
// "Ada needs you to: Enter the 2FA code for your bank". It is posted when a
// card opens while no Aiden window is focused, once per `waitId`, and clicking
// it opens that Bot's chat. There is no setting of its own: macOS
// notification permission decides whether it shows.
//
// Pure: the Electron `Notification`, window focus and navigation come in as
// dependencies (`bot-session-main.ts` wires them).

import type { BotPendingHandoff } from "../../../renderer/shared/bot-handoffs.js";

const BODY_MAX_CHARS = 120;
/** Wait ids already announced; old ones fall off so a long session stays bounded. */
const REMEMBERED_WAIT_IDS = 256;

export interface BotHandoffNotificationOptions {
  title: string;
  body: string;
  onClick(): void;
}

export interface BotHandoffNotifierDeps {
  /** Whether any Aiden window has focus; the card is in front of the person then. */
  isAppFocused(): boolean;
  /** Show one notification. A throw is reported, never raised. */
  show(notification: BotHandoffNotificationOptions): void;
  /** The Bot's display name, or undefined once it is gone. */
  botName(botId: string): string | undefined | Promise<string | undefined>;
  /** Open the Bot's chat (`/bots/<id>/chat`). */
  onClick(botId: string): void | Promise<void>;
  /** Whether the card still waits; checked again after the name is read. */
  isPending?(botId: string, waitId: string): boolean;
  onError?(stage: "delivery" | "navigation", error: unknown): void;
}

export interface BotHandoffNotifier {
  /** A card opened. Resolves true when a notification was shown for it. */
  opened(prompt: BotPendingHandoff): Promise<boolean>;
}

/** "Ada needs you to: <action>", on one line, at most 120 characters. */
export function botHandoffNotificationBody(botName: string, action: string): string {
  const body = `${botName} needs you to: ${action}`.replace(/\s+/gu, " ").trim();
  const points = [...body];
  return points.length > BODY_MAX_CHARS ? `${points.slice(0, BODY_MAX_CHARS - 1).join("").trimEnd()}…` : body;
}

export function createBotHandoffNotifier(deps: BotHandoffNotifierDeps): BotHandoffNotifier {
  const announced = new Set<string>();
  const report = (stage: "delivery" | "navigation", error: unknown) => {
    try {
      deps.onError?.(stage, error);
    } catch {
      // Diagnostics are best-effort; they never change the card.
    }
  };
  const remember = (waitId: string) => {
    announced.add(waitId);
    if (announced.size > REMEMBERED_WAIT_IDS) announced.delete(announced.values().next().value!);
  };

  return {
    async opened(prompt) {
      if (announced.has(prompt.waitId)) return false;
      // Claimed before any await, so two change events for one card post one notification.
      remember(prompt.waitId);
      try {
        if (deps.isAppFocused()) return false;
        const name = (await deps.botName(prompt.botId))?.trim();
        if (!name) return false;
        if (deps.isPending && !deps.isPending(prompt.botId, prompt.waitId)) return false;
        if (deps.isAppFocused()) return false;
        deps.show({
          title: name,
          body: botHandoffNotificationBody(name, prompt.action),
          onClick: () => {
            // Capture both synchronous throws and asynchronous navigation failures.
            void Promise.resolve()
              .then(() => deps.onClick(prompt.botId))
              .catch((error: unknown) => report("navigation", error));
          },
        });
        return true;
      } catch (error) {
        report("delivery", error);
        return false;
      }
    },
  };
}
