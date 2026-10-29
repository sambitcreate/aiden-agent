// The rows of the ⌘/ keyboard list: every command that has a key (as set in
// Settings) plus the built-in keys, grouped the way people look for them.

import {
  COMMANDS,
  prettyAcceleratorForPlatform,
  type CommandCategory,
  type CommandId,
  type KeyboardPlatform,
} from "../shared/keybindings";
import { BUILT_IN_KEYS, type BuiltInKeySection } from "../shared/built-in-keys";
import type { StudioFeature } from "../shared/studio-routes";

export interface ShortcutSheetRow {
  id: string;
  title: string;
  /** Built-in keys only: when the key applies. */
  description?: string;
  keys: readonly string[];
  alsoKeys?: readonly string[];
  /** The two keys are the ends of a run (⌘1 to ⌘9), not a pair. */
  range?: boolean;
}

export interface ShortcutSheetSection {
  title: string;
  rows: ShortcutSheetRow[];
}

const SECTION_ORDER = ["General", "Moving around", "In a chat", "Workspace"] as const;
type SheetSectionTitle = (typeof SECTION_ORDER)[number];

const CATEGORY_SECTION: Record<CommandCategory, SheetSectionTitle> = {
  Aiden: "General",
  Settings: "General",
  Navigate: "Moving around",
  Chat: "In a chat",
  Tools: "Workspace",
};

// Where people look for a key, where that differs from its catalog category.
const COMMAND_SECTION: Partial<Record<CommandId, SheetSectionTitle>> = {
  "commandPalette.toggle": "General",
  "chat.new": "General",
  "chat.newIn": "General",
  "chat.search": "General",
  "model.change": "General",
  "workspace.openFolder": "General",
  "workspace.openPreferredEditor": "General",
  "chat.previous": "Moving around",
  "chat.next": "Moving around",
};

const sectionOf = (id: CommandId, category: CommandCategory) =>
  COMMAND_SECTION[id] ?? (id.startsWith("chat.jump.") ? "Moving around" : CATEGORY_SECTION[category]);

const BUILT_IN_SECTION: Record<BuiltInKeySection, SheetSectionTitle> = {
  "Moving around": "Moving around",
  "In a chat": "In a chat",
};

const JUMP_IDS = Array.from({ length: 9 }, (_, index) => `chat.jump.${index + 1}` as CommandId);

export function shortcutSheet(
  bindings: Readonly<Record<CommandId, string | null>>,
  {
    capabilities = {},
    platform,
    query = "",
  }: {
    capabilities?: Partial<Record<StudioFeature, boolean>>;
    platform: KeyboardPlatform;
    query?: string;
  },
): ShortcutSheetSection[] {
  const rows = new Map<SheetSectionTitle, ShortcutSheetRow[]>(SECTION_ORDER.map((title) => [title, []]));
  const searchable = new Map<ShortcutSheetRow, string>();
  const add = (section: SheetSectionTitle, row: ShortcutSheetRow, words: readonly string[] = []) => {
    rows.get(section)!.push(row);
    const keys = [...row.keys, ...(row.alsoKeys ?? [])];
    searchable.set(
      row,
      [row.title, row.description, ...words, ...keys.map((key) => prettyAcceleratorForPlatform(key, platform))]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase(),
    );
  };

  // ⌘1 to ⌘9 read as one row while they're the usual keys.
  const jumpsAreDefault = JUMP_IDS.every((id, index) => bindings[id] === `Command+${index + 1}`);
  for (const command of COMMANDS) {
    const binding = bindings[command.id];
    if (!binding || !(command.showInPalette || command.showInSettings)) continue;
    if (command.requiresCapability && !capabilities[command.requiresCapability]) continue;
    if (jumpsAreDefault && JUMP_IDS.includes(command.id)) {
      if (command.id !== "chat.jump.1") continue;
      add(
        sectionOf(command.id, command.category),
        { id: "chat.jump", title: "Open a chat by its number", keys: ["Command+1", "Command+9"], range: true },
        ["jump", "number", "chat", "bot"],
      );
      continue;
    }
    add(sectionOf(command.id, command.category), { id: command.id, title: command.title, keys: [binding] }, command.keywords);
  }
  for (const key of BUILT_IN_KEYS) {
    add(BUILT_IN_SECTION[key.section], {
      id: `built-in.${key.id}`,
      title: key.title,
      description: key.description,
      keys: key.keys,
      ...(key.alsoKeys ? { alsoKeys: key.alsoKeys } : {}),
    });
  }

  const needle = query.trim().toLocaleLowerCase();
  return SECTION_ORDER.map((title) => ({
    title,
    rows: rows.get(title)!.filter((row) => !needle || searchable.get(row)!.includes(needle)),
  })).filter((section) => section.rows.length > 0);
}
