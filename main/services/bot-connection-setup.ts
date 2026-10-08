// Opens a Bot connection's setup on the desktop: a connect card, a paired phone's
// "Finish on your Mac" request, or any other Bot surface asks for it by plugin id.
// Only catalog plugins that have a setup entry are accepted. The request goes to
// one window (focused, else most recently focused), so only one dialog opens.

import { BrowserWindow, app } from "electron";
import { logger } from "../platform.js";
import { connectionSuggestionFor } from "../../renderer/shared/bot-connections.js";
import { connectionSetupTarget, createFocusHistory } from "./bot-connection-setup-core.js";

export const BOT_CONNECTION_SETUP_CHANNEL = "bots:connections:setup";

const focusHistory = createFocusHistory();
let tracking = false;

/** Start following window focus. Called once the app is ready. */
export function trackConnectionSetupFocus(): void {
  if (tracking) return;
  tracking = true;
  app.on("browser-window-focus", (_event, window) => {
    const id = window.id;
    focusHistory.focused(id);
    window.once("closed", () => focusHistory.closed(id));
  });
}

/** Returns false, and sends nothing, for a plugin Aiden cannot set up. */
export function openConnectionSetup(pluginId: string): boolean {
  if (!connectionSuggestionFor(pluginId)) return false;
  trackConnectionSetupFocus();
  const target = connectionSetupTarget({
    all: () =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        isFocused: () => window.isFocused(),
        send: (channel: string, payload: unknown) => window.webContents.send(channel, payload),
      })),
    focusHistory: () => focusHistory.list(),
  });
  try {
    target?.send(BOT_CONNECTION_SETUP_CHANNEL, { pluginId });
  } catch (error) {
    logger.warn("bots", "Could not open connection setup.", error);
  }
  return true;
}
