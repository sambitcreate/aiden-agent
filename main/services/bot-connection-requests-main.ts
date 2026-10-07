import { Notification, ipcMain, logger } from "../platform.js";

export interface BotConnectionRequest {
  botId: string;
  pluginId: string;
  name: string;
}

/**
 * A paired phone asked to finish connecting an app for a Bot. The Mac shows a
 * notification whose click reopens the Bot's setup; the renderer receives the
 * same request on `bots:connection-request` either way.
 */
export async function raiseBotConnectionRequest(request: BotConnectionRequest): Promise<void> {
  const payload = { botId: request.botId, pluginId: request.pluginId };
  ipcMain.broadcast("bots:connection-request", payload);
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: `Connect ${request.name}`,
      body: "Finish connecting this app on your Mac for your Bot.",
    });
    notification.on("click", () => ipcMain.broadcast("bots:connection-request", payload));
    notification.show();
  } catch (error) {
    logger.warn("bots", "Could not show the connection notification.", error);
  }
}
