import { aidenAppNavigation } from "../services/aiden-app-navigation.js";
import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { chatStore } from "../services/chat-store.js";
import { appControlsService } from "../services/app-controls-main.js";
import { isAppControlTopic, parseAppControlPanels } from "../../renderer/shared/app-controls.js";
import type { AppControlContext } from "../services/app-controls-core.js";

async function ownedPanel(event: Electron.IpcMainInvokeEvent, chatId: unknown, panelId: unknown) {
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Controls require the active app document."),
  );
  if (typeof chatId !== "string" || chatId.length > 128 || typeof panelId !== "string")
    throw new Error("Invalid panel reference.");
  const chat = await chatStore.get(chatId);
  const panel = chat?.messages
    .flatMap((message) => parseAppControlPanels(message.appPanels) ?? [])
    .find((panel) => panel.id === panelId);
  if (
    !chat ||
    chat.botId ||
    !panel ||
    owner.isDestroyed() ||
    !isAppControlTopic(panel.topic) ||
    panel.workspaceId !== chat.workspaceId
  )
    throw new Error("This control panel is unavailable.");
  const context: AppControlContext = {
    actor: "desktop",
    workspaceId: chat.workspaceId,
    target: "This desktop",
    humanGesture: true,
    isCurrent: () => !owner.isDestroyed(),
    authorize: async () => {
      const current = await chatStore.get(chatId);
      if (
        !current ||
        current.botId ||
        current.workspaceId !== panel.workspaceId ||
        !current.messages.some((message) =>
          message.appPanels?.some((entry) => entry.id === panelId),
        )
      )
        throw new Error("This panel's chat target changed. Ask for fresh controls.");
    },
  };
  return { panel, context };
}
export function registerAppControlHandlers(): void {
  ipcMain.handle("settings:controls:navigation-ack", (event, requestId: unknown, status: unknown) =>
    aidenAppNavigation.acknowledge(
      requestId,
      status,
      rendererDocumentOwner(event, () => new Error("Active renderer required.")),
    ),
  );
  ipcMain.handle("settings:controls:get", async (event, chatId: unknown, panelId: unknown) => {
    const { panel, context } = await ownedPanel(event, chatId, panelId);
    return appControlsService.snapshot(panel.topic, context);
  });
  ipcMain.handle(
    "settings:controls:apply",
    async (event, chatId: unknown, panelId: unknown, operation: unknown) => {
      const { panel, context } = await ownedPanel(event, chatId, panelId);
      const snapshot = await appControlsService.snapshot(panel.topic, context);
      context.allowedControls = new Set(snapshot.rows.map((row) => row.id));
      return appControlsService.apply(operation, context);
    },
  );
}
