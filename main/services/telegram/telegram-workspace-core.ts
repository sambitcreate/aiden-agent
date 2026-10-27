import type { Workspace } from "../types.js";

/** Normalize an optional persisted Telegram workspace selection. */
export function telegramWorkspaceSelectionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A Telegram project turn requires a workspace with a real folder root. */
export function isTelegramFolderWorkspace(
  workspace: Pick<Workspace, "folderPath"> | null | undefined,
): workspace is Pick<Workspace, "folderPath"> & { folderPath: string } {
  return Boolean(workspace?.folderPath);
}

export class TelegramWorkspaceAccessError extends Error {
  constructor() {
    super("The Telegram workspace is unavailable or has No Access. Choose an accessible folder workspace in Aiden Settings or use /workspace off.");
    this.name = "TelegramWorkspaceAccessError";
  }
}

/** Ask is an explicitly disclosed unattended Full grant; No Access remains a ceiling. */
export function isTelegramAutomationWorkspace(
  workspace: Pick<Workspace, "folderPath" | "permission"> | null | undefined,
): workspace is Pick<Workspace, "folderPath" | "permission"> & { folderPath: string } {
  return isTelegramFolderWorkspace(workspace) && workspace.permission !== "none";
}

export function assertTelegramWorkspaceAccess<T extends Pick<Workspace, "folderPath" | "permission">>(
  workspace: T | null | undefined,
): asserts workspace is T & { folderPath: string } {
  if (!isTelegramAutomationWorkspace(workspace)) {
    throw new TelegramWorkspaceAccessError();
  }
}

/** Keep existing folder topics for separately authorized Bot bindings; never create denied ordinary topics. */
export function telegramThreadWorkspacePlan<T extends Pick<Workspace, "id" | "folderPath" | "permission">>(workspaces: readonly T[]) {
  return {
    retain: new Set(workspaces.filter(isTelegramFolderWorkspace).map(({ id }) => id)),
    provision: workspaces.filter(isTelegramAutomationWorkspace),
  };
}
