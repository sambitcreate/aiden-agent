import type { Workspace } from "../types.js";

/** Normalize an optional persisted Telegram workspace selection. */
export function telegramWorkspaceSelectionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A Telegram project turn requires a workspace with a real folder root. */
export function isTelegramFolderWorkspace(
  workspace: Pick<Workspace, "folderPath"> | null | undefined,
): boolean {
  return Boolean(workspace?.folderPath);
}
