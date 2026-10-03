import { configStore } from "./config-store.js";
import { chatStore } from "./chat-store.js";
import { appControlsService } from "./app-controls-main.js";
import {
  parseAppControlPanels,
  parseAppControlOperation,
  type AppControlId,
} from "../../renderer/shared/app-controls.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
export interface RemoteAppControlAuthority {
  deviceId: string;
  current(): boolean;
  capabilities: ReadonlySet<AidenRemoteCapability>;
  authorize(): Promise<void>;
}
async function target(authority: RemoteAppControlAuthority, chatId: string, panelId: string) {
  await authority.authorize();
  if (!authority.current() || (await configStore.getSettings()).remoteAppControlsEnabled !== true)
    throw new AidenRemoteServiceError(
      "capability_denied",
      "Allow paired-device chat controls in desktop Appearance settings first.",
      403,
    );
  const chat = await chatStore.get(chatId);
  const panel = chat?.messages
    .flatMap((message) => parseAppControlPanels(message.appPanels) ?? [])
    .find((panel) => panel.id === panelId);
  if (
    !chat ||
    chat.botId ||
    !panel ||
    panel.workspaceId !== chat.workspaceId ||
    !authority.current()
  )
    throw new AidenRemoteServiceError("not_found", "This settings panel is unavailable.", 404);
  const context = {
    actor: `remote:${authority.deviceId}`,
    workspaceId: chat.workspaceId,
    target: "Paired host",
    remote: true,
    humanGesture: true,
    isCurrent: authority.current,
    authorize: async () => {
      await authority.authorize();
      const current = await chatStore.get(chatId);
      if (
        !current ||
        current.botId ||
        current.workspaceId !== panel.workspaceId ||
        (await configStore.getSettings()).remoteAppControlsEnabled !== true
      )
        throw new Error("This control target is no longer authorized.");
    },
  };
  return { panel, context };
}
export const remoteAppControls = {
  async enabled() {
    return (await configStore.getSettings()).remoteAppControlsEnabled === true;
  },
  async get(authority: RemoteAppControlAuthority, chatId: string, panelId: string) {
    const { panel, context } = await target(authority, chatId, panelId);
    if (panel.topic === "memory" && !authority.capabilities.has("workspace:read"))
      throw new AidenRemoteServiceError(
        "capability_denied",
        "Memory controls require workspace read access.",
        403,
      );
    const snapshot = await appControlsService.snapshot(panel.topic, context);
    for (const row of snapshot.rows) {
      if (
        !authority.capabilities.has("app-controls:respond") ||
        (row.id.startsWith("memory.") && !authority.capabilities.has("workspace:manage"))
      ) {
        row.disabledReason = "This device does not have permission to change this setting.";
      }
    }
    return snapshot;
  },
  async apply(
    authority: RemoteAppControlAuthority,
    chatId: string,
    panelId: string,
    input: unknown,
  ) {
    let operation;
    try {
      operation = parseAppControlOperation(input);
    } catch {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "Invalid or unsupported control operation.",
        400,
      );
    }
    const { context } = await target(authority, chatId, panelId);
    const snapshot = await this.get(authority, chatId, panelId);
    const allowedControls = new Set<AppControlId>(
      snapshot.rows.filter((row) => !row.disabledReason).map((row) => row.id),
    );
    try {
      return await appControlsService.apply(operation, { ...context, allowedControls });
    } catch (error) {
      const denied =
        error instanceof Error &&
        /not authorized|disabled|authority changed|no longer|permission/iu.test(error.message);
      throw new AidenRemoteServiceError(
        denied ? "capability_denied" : "revision_conflict",
        denied
          ? "This control is no longer authorized. Refresh the host's current permissions."
          : "Control change could not be confirmed. Refresh its current value or check the original operation.",
        denied ? 403 : 409,
      );
    }
  },
};
