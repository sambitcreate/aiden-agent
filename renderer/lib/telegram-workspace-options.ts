import type { Workspace } from "./types";

export const TELEGRAM_ASSISTANT_ONLY_VALUE = "__none__";

export interface TelegramWorkspaceOption {
  value: string;
  label: string;
  unavailable?: boolean;
}

export function telegramWorkspaceOptions(
  workspaces: readonly Workspace[],
  selectedId: string | undefined,
): TelegramWorkspaceOption[] {
  const options: TelegramWorkspaceOption[] = [
    { value: TELEGRAM_ASSISTANT_ONLY_VALUE, label: "Assistant-only mode" },
    ...workspaces
      .filter((workspace) => workspace.folderPath)
      .map((workspace) => ({
        value: workspace.id,
        label: `${workspace.name} — ${workspace.folderPath}`,
      })),
  ];

  if (selectedId && !options.some((option) => option.value === selectedId)) {
    options.push({
      value: selectedId,
      label: "Selected workspace is unavailable",
      unavailable: true,
    });
  }

  return options;
}
