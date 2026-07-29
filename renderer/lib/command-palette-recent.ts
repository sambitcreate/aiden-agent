import { isCommandId, type CommandId } from "../shared/keybindings";

export const COMMAND_PALETTE_RECENT_KEY = "aiden.command-palette.recent.v1";
export const COMMAND_PALETTE_RECENT_LIMIT = 12;

export function normalizeRecentCommands(value: unknown): CommandId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<CommandId>();
  const result: CommandId[] = [];
  for (const item of value) {
    if (!isCommandId(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length === COMMAND_PALETTE_RECENT_LIMIT) break;
  }
  return result;
}

export function recordRecentCommand(
  current: readonly CommandId[],
  commandId: CommandId,
): CommandId[] {
  return normalizeRecentCommands([
    commandId,
    ...current.filter((item) => item !== commandId),
  ]);
}

export function persistRecentCommands(
  storage: Pick<Storage, "setItem">,
  commands: readonly CommandId[],
): void {
  try {
    storage.setItem(COMMAND_PALETTE_RECENT_KEY, JSON.stringify(commands));
  } catch {
    // Recents are best-effort and must never block the selected command.
  }
}
