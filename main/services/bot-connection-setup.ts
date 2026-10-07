// Opens a Bot connection's setup on the desktop: a connect card, a paired phone's
// "Finish on your Mac" request, or any other Bot surface asks for it by plugin id.
// Only catalog plugins that have a setup entry are accepted.

import { ipcMain } from "../platform.js";
import { connectionSuggestionFor } from "../../renderer/shared/bot-connections.js";

export const BOT_CONNECTION_SETUP_CHANNEL = "bots:connections:setup";

/** Returns false, and sends nothing, for a plugin Aiden cannot set up. */
export function openConnectionSetup(pluginId: string): boolean {
  if (!connectionSuggestionFor(pluginId)) return false;
  ipcMain.broadcast(BOT_CONNECTION_SETUP_CHANNEL, { pluginId });
  return true;
}
