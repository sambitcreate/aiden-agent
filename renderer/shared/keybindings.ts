// Canonical command and keybinding contracts shared by Electron and the renderer.
// Keep this module dependency-free so the main process, React, and node:test can
// all use the exact same normalization and conflict rules.

export const COMMAND_IDS = [
  "composer.focus",
  "dictation.toggle",
  "assistant.open",
  "commandPalette.toggle",
  "chat.new",
  "chat.search",
  "chat.previous",
  "chat.next",
  "chat.jump.1",
  "chat.jump.2",
  "chat.jump.3",
  "chat.jump.4",
  "chat.jump.5",
  "chat.jump.6",
  "chat.jump.7",
  "chat.jump.8",
  "chat.jump.9",
  "model.change",
  "provider.manage",
  "settings.search",
  "settings.open",
  "workspace.openPreferredEditor",
  "sidebar.toggle",
  "terminal.toggle",
  "environment.toggle",
  "file.save",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
export type CommandCategory = "Aiden" | "Chat" | "Navigate" | "Tools" | "Settings";
export type CommandScope = "global" | "app" | "chat" | "fileEditor";

export interface CommandDefinition {
  id: CommandId;
  title: string;
  description: string;
  category: CommandCategory;
  keywords: string[];
  defaultBinding: string | null;
  defaultEnabled?: boolean;
  scope: CommandScope;
  global: boolean;
  allowInEditable?: boolean;
  allowRepeat?: boolean;
  nativeMenu?: boolean;
  showInPalette: boolean;
  showInSettings: boolean;
}

const command = (definition: CommandDefinition) => definition;

export const COMMANDS = [
  command({
    id: "composer.focus",
    title: "Focus composer",
    description: "Bring Aiden forward and focus the message composer.",
    category: "Aiden",
    keywords: ["write", "message", "input"],
    defaultBinding: "Command+Alt+Space",
    scope: "global",
    global: true,
    allowInEditable: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "dictation.toggle",
    title: "Start or stop dictation",
    description: "Dictate into the focused app.",
    category: "Aiden",
    keywords: ["voice", "microphone", "transcribe"],
    defaultBinding: "Command+Shift+D",
    defaultEnabled: false,
    scope: "global",
    global: true,
    allowInEditable: true,
    showInPalette: false,
    showInSettings: true,
  }),
  command({
    id: "assistant.open",
    title: "Open Aiden",
    description: "Open the docked Aiden assistant.",
    category: "Aiden",
    keywords: ["assistant", "companion", "dock"],
    defaultBinding: "Command+Alt+A",
    scope: "global",
    global: true,
    allowInEditable: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "commandPalette.toggle",
    title: "Open command palette",
    description: "Search commands, chats, models, providers, and settings.",
    category: "Navigate",
    keywords: ["search", "quick", "actions"],
    defaultBinding: "Command+K",
    scope: "app",
    global: false,
    allowInEditable: true,
    nativeMenu: true,
    showInPalette: false,
    showInSettings: true,
  }),
  command({
    id: "chat.new",
    title: "New chat",
    description: "Start a new chat in the active workspace.",
    category: "Chat",
    keywords: ["conversation", "compose"],
    defaultBinding: "Command+N",
    scope: "app",
    global: false,
    nativeMenu: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "chat.search",
    title: "Search chats",
    description: "Open the palette in chat search.",
    category: "Chat",
    keywords: ["history", "conversation", "find"],
    defaultBinding: "Command+Shift+F",
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "chat.previous",
    title: "Previous chat",
    description: "Open the previous chat in the sidebar.",
    category: "Chat",
    keywords: ["back", "older"],
    defaultBinding: "Command+Shift+[",
    scope: "chat",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "chat.next",
    title: "Next chat",
    description: "Open the next chat in the sidebar.",
    category: "Chat",
    keywords: ["forward", "newer"],
    defaultBinding: "Command+Shift+]",
    scope: "chat",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  ...Array.from({ length: 9 }, (_, index) =>
    command({
      id: `chat.jump.${index + 1}` as CommandId,
      title: `Open chat ${index + 1}`,
      description: `Open chat ${index + 1} in the sidebar.`,
      category: "Chat",
      keywords: ["recent", "sidebar"],
      defaultBinding: `Command+${index + 1}`,
      scope: "chat",
      global: false,
      showInPalette: false,
      showInSettings: true,
    }),
  ),
  command({
    id: "model.change",
    title: "Change model",
    description: "Choose the active provider and model.",
    category: "Navigate",
    keywords: ["llm", "provider", "select"],
    defaultBinding: null,
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "provider.manage",
    title: "Manage providers",
    description: "Review providers and refresh their model catalogs.",
    category: "Settings",
    keywords: ["api", "connection", "models"],
    defaultBinding: null,
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "settings.search",
    title: "Search settings",
    description: "Open quick settings search.",
    category: "Settings",
    keywords: ["preferences", "configure"],
    defaultBinding: null,
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "settings.open",
    title: "Open Settings",
    description: "Open Aiden settings.",
    category: "Settings",
    keywords: ["preferences", "configure"],
    defaultBinding: "Command+,",
    scope: "app",
    global: false,
    nativeMenu: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "workspace.openPreferredEditor",
    title: "Open workspace in preferred editor",
    description: "Open the active workspace in its preferred editor.",
    category: "Tools",
    keywords: ["vscode", "cursor", "finder", "folder"],
    defaultBinding: "Command+O",
    scope: "app",
    global: false,
    nativeMenu: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    description: "Show or hide the leading sidebar.",
    category: "Navigate",
    keywords: ["collapse", "navigation"],
    defaultBinding: "Command+B",
    scope: "app",
    global: false,
    allowInEditable: true,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "terminal.toggle",
    title: "Toggle terminal",
    description: "Show or hide the workspace terminal.",
    category: "Tools",
    keywords: ["shell", "console"],
    defaultBinding: "Command+J",
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "environment.toggle",
    title: "Toggle environment panel",
    description: "Show or hide files and Git tools.",
    category: "Tools",
    keywords: ["files", "git", "changes"],
    defaultBinding: "Command+Shift+E",
    scope: "app",
    global: false,
    showInPalette: true,
    showInSettings: true,
  }),
  command({
    id: "file.save",
    title: "Save file",
    description: "Save the active file editor.",
    category: "Tools",
    keywords: ["write", "editor"],
    defaultBinding: "Command+S",
    scope: "fileEditor",
    global: false,
    allowInEditable: true,
    showInPalette: false,
    showInSettings: true,
  }),
] satisfies CommandDefinition[];

export const COMMAND_BY_ID = Object.fromEntries(COMMANDS.map((item) => [item.id, item])) as Record<
  CommandId,
  CommandDefinition
>;

export interface KeybindingOverride {
  binding?: string | null;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface KeybindingOverridesV1 {
  version: 1;
  commands: Partial<Record<CommandId, KeybindingOverride>>;
  [key: string]: unknown;
}

export interface LegacyGlobalKeybindings {
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  assistant?: {
    hotkeyEnabled?: boolean;
    hotkeyAccelerator?: string;
  };
}

export type GlobalShortcutState = "active" | "disabled" | "unavailable";

export interface GlobalShortcutStatus {
  commandId: CommandId;
  binding: string | null;
  state: GlobalShortcutState;
  message?: string;
}

export interface KeybindingSnapshot {
  overrides: KeybindingOverridesV1;
  effective: Record<CommandId, string | null>;
  global: GlobalShortcutStatus[];
}

export type KeybindingMutation =
  | { commandId: CommandId; binding: string; replace?: boolean }
  | { commandId: CommandId; disabled: boolean }
  | { commandId: CommandId; reset: true };

export class KeybindingValidationError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "reserved" | "conflict" | "registration" | "future-version",
    readonly commandId?: CommandId,
  ) {
    super(message);
    this.name = "KeybindingValidationError";
  }
}

const MODIFIER_ALIASES: Record<string, "Command" | "Control" | "Alt" | "Shift"> = {
  command: "Command",
  commandorcontrol: "Command",
  cmd: "Command",
  meta: "Command",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  space: "Space",
  return: "Return",
  enter: "Return",
  escape: "Escape",
  esc: "Escape",
  arrowup: "Up",
  up: "Up",
  arrowdown: "Down",
  down: "Down",
  arrowleft: "Left",
  left: "Left",
  arrowright: "Right",
  right: "Right",
  comma: ",",
  bracketleft: "[",
  bracketright: "]",
};

const MODIFIER_ORDER = ["Command", "Control", "Alt", "Shift"] as const;

function normalizeBaseKey(raw: string): string | null {
  const lower = raw.trim().toLocaleLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if ([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"].includes(raw.trim()))
    return raw.trim();
  return null;
}

export function normalizeAccelerator(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;
  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLocaleLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key) return null;
    key = normalizeBaseKey(token);
    if (!key) return null;
  }
  if (!key || modifiers.size === 0) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function prettyAccelerator(value: string | null | undefined): string {
  if (!value) return "Unassigned";
  const normalized = normalizeAccelerator(value) ?? value;
  const symbols: Record<string, string> = {
    Command: "⌘",
    Control: "⌃",
    Alt: "⌥",
    Shift: "⇧",
    Space: "Space",
    Return: "↩",
    Escape: "Esc",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
  };
  return normalized
    .split("+")
    .map((part) => symbols[part] ?? part)
    .join("");
}

export function ariaKeyShortcut(value: string | null | undefined): string | undefined {
  const normalized = value ? normalizeAccelerator(value) : null;
  if (!normalized) return undefined;
  return normalized
    .replace("Command", "Meta")
    .replace("Control", "Control")
    .replace("Alt", "Alt")
    .replace("Shift", "Shift")
    .replace("Return", "Enter")
    .replace("Up", "ArrowUp")
    .replace("Down", "ArrowDown")
    .replace("Left", "ArrowLeft")
    .replace("Right", "ArrowRight");
}

export interface KeyboardEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function acceleratorFromKeyboardEvent(event: KeyboardEventLike): string | null {
  let key: string | null = null;
  if (event.code === "Space" || event.key === " ") key = "Space";
  else if (event.code?.startsWith("Key") && event.code.length === 4) key = event.code.slice(3);
  else if (event.code?.startsWith("Digit") && event.code.length === 6) key = event.code.slice(5);
  else if (event.code) {
    key =
      {
        BracketLeft: "[",
        BracketRight: "]",
        Comma: ",",
        Period: ".",
        Slash: "/",
        Semicolon: ";",
        Quote: "'",
        Backslash: "\\",
        Minus: "-",
        Equal: "=",
        Backquote: "`",
      }[event.code] ?? null;
  }
  if (!key) key = normalizeBaseKey(event.key);
  if (!key) return null;
  const modifiers = [
    event.metaKey ? "Command" : null,
    event.ctrlKey ? "Control" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter((part): part is string => Boolean(part));
  return modifiers.length > 0 ? [...modifiers, key].join("+") : null;
}

export function matchesAccelerator(event: KeyboardEventLike, accelerator: string): boolean {
  return acceleratorFromKeyboardEvent(event) === normalizeAccelerator(accelerator);
}

function futureKeybindingFields(
  item: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return item
    ? Object.fromEntries(
        Object.entries(item)
          .filter(([key]) => key !== "binding" && key !== "disabled")
          .map(([key, entry]) => [key, structuredClone(entry)]),
      )
    : {};
}

function futureKeybindingRootFields(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return record
    ? Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "version" && key !== "commands")
          .map(([key, entry]) => [key, structuredClone(entry)]),
      )
    : {};
}

export function normalizeKeybindingOverrides(value: unknown): KeybindingOverridesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, commands: {} };
  }
  const record = value as Record<string, unknown>;
  const result: KeybindingOverridesV1 = {
    ...futureKeybindingRootFields(record),
    version: 1,
    commands: {},
  };
  if (
    record.version !== 1 ||
    !record.commands ||
    typeof record.commands !== "object" ||
    Array.isArray(record.commands)
  )
    return result;
  for (const [id, raw] of Object.entries(record.commands as Record<string, unknown>)) {
    // A newer build may have written a command this build does not know yet.
    // Preserve that JSON value byte-for-byte at the object-property level so a
    // routine edit in an older build cannot erase the future preference.
    if (!isCommandId(id)) {
      Object.defineProperty(result.commands, id, {
        value: raw,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const binding = item.binding === null ? null : normalizeAccelerator(item.binding);
    const disabled = item.disabled === true;
    const futureFields = futureKeybindingFields(item);
    if (
      binding !== null ||
      item.binding === null ||
      disabled ||
      Object.keys(futureFields).length > 0
    ) {
      result.commands[id] = {
        ...futureFields,
        ...(binding !== null || item.binding === null ? { binding } : {}),
        ...(disabled ? { disabled: true } : {}),
      };
    }
  }
  return result;
}

function legacyBinding(
  commandId: CommandId,
  legacy: LegacyGlobalKeybindings | undefined,
): KeybindingOverride | undefined {
  if (!legacy) return undefined;
  if (commandId === "composer.focus") {
    const binding = normalizeAccelerator(legacy.shortcutAccelerator);
    return {
      ...(binding ? { binding } : {}),
      ...(legacy.shortcutEnabled === false ? { disabled: true } : {}),
    };
  }
  if (commandId === "dictation.toggle") {
    const binding = normalizeAccelerator(legacy.dictationAccelerator);
    return {
      ...(binding ? { binding } : {}),
      ...(legacy.dictationEnabled !== true ? { disabled: true } : {}),
    };
  }
  if (commandId === "assistant.open") {
    const binding = normalizeAccelerator(legacy.assistant?.hotkeyAccelerator);
    return {
      ...(binding ? { binding } : {}),
      ...(legacy.assistant?.hotkeyEnabled === false ? { disabled: true } : {}),
    };
  }
  return undefined;
}

export function hasCanonicalKeybindings(value: unknown): value is KeybindingOverridesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Boolean(record.commands) &&
    typeof record.commands === "object" &&
    !Array.isArray(record.commands)
  );
}

/** A document from a newer Aiden must remain owned byte-for-byte by that version. */
export function hasFutureKeybindings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version > 1;
}

export function shouldPersistCanonicalKeybindings(
  stored: unknown,
  canonical: KeybindingOverridesV1,
): boolean {
  if (hasFutureKeybindings(stored)) return false;
  return (
    !hasCanonicalKeybindings(stored) ||
    JSON.stringify(normalizeKeybindingOverrides(stored)) !== JSON.stringify(canonical)
  );
}

function defaultBinding(commandId: CommandId): string | null {
  const definition = COMMAND_BY_ID[commandId];
  return definition.defaultEnabled === false ? null : definition.defaultBinding;
}

function effectiveBindingFromNormalized(
  commandId: CommandId,
  overrides: KeybindingOverridesV1 | undefined,
  legacy?: LegacyGlobalKeybindings,
): string | null {
  const override =
    overrides !== undefined ? overrides.commands[commandId] : legacyBinding(commandId, legacy);
  if (override?.disabled) return null;
  if (override && "binding" in override) return override.binding ?? null;
  if (override) return COMMAND_BY_ID[commandId].defaultBinding;
  return defaultBinding(commandId);
}

export function effectiveBinding(
  commandId: CommandId,
  overrides: unknown,
  legacy?: LegacyGlobalKeybindings,
): string | null {
  const normalized = hasCanonicalKeybindings(overrides)
    ? normalizeKeybindingOverrides(overrides)
    : undefined;
  return effectiveBindingFromNormalized(commandId, normalized, legacy);
}

export function effectiveBindings(
  overrides: unknown,
  legacy?: LegacyGlobalKeybindings,
): Record<CommandId, string | null> {
  const normalized = hasCanonicalKeybindings(overrides)
    ? normalizeKeybindingOverrides(overrides)
    : undefined;
  return Object.fromEntries(
    COMMAND_IDS.map((id) => [id, effectiveBindingFromNormalized(id, normalized, legacy)]),
  ) as Record<CommandId, string | null>;
}

const RESERVED_BINDINGS = new Set([
  "Command+A",
  "Command+C",
  "Command+Q",
  "Command+H",
  "Command+Alt+H",
  "Command+Alt+I",
  "Command+M",
  "Command+W",
  "Command+X",
  "Command+V",
  "Command+Shift+V",
  "Command+Alt+Shift+V",
  "Command+Z",
  "Command+Shift+Z",
  "Command+0",
  "Command+=",
  "Command+Shift+=",
  "Command+-",
  "Command+R",
  "Command+Shift+R",
  "Command+Control+F",
  "Command+`",
]);

export function commandScopesOverlap(left: CommandDefinition, right: CommandDefinition): boolean {
  if (left.global || right.global) return true;
  // Electron menu accelerators are resolved before the renderer sees the key.
  // They cannot participate in the renderer's editable/file-editor scoping.
  if (left.nativeMenu || right.nativeMenu) return true;
  if (left.scope === right.scope) return true;

  const appCommand = left.scope === "app" ? left : right.scope === "app" ? right : null;
  const other = appCommand === left ? right : left;
  if (appCommand) {
    if (other.scope === "fileEditor") return appCommand.allowInEditable === true;
    return true;
  }

  const chatCommand = left.scope === "chat" ? left : right.scope === "chat" ? right : null;
  const fileCommand = chatCommand === left ? right : left;
  if (chatCommand && fileCommand.scope === "fileEditor")
    return chatCommand.allowInEditable === true;
  return false;
}

/**
 * Materialize the three legacy global preferences into the canonical V1 map.
 * Legacy values win over newly introduced local defaults; colliding local
 * commands are disabled so an upgrade cannot take every global registration
 * down. The result is idempotent and stops consulting legacy fields.
 */
export function migrateLegacyKeybindings(
  currentValue: unknown,
  legacy?: LegacyGlobalKeybindings,
): KeybindingOverridesV1 {
  if (hasCanonicalKeybindings(currentValue)) return repairKeybindingOverrides(currentValue);

  const next = normalizeKeybindingOverrides(currentValue);
  const claimed = new Map<string, CommandId>();
  for (const definition of COMMANDS.filter((item) => item.global)) {
    let binding = effectiveBindingFromNormalized(definition.id, undefined, legacy);
    if (binding && (RESERVED_BINDINGS.has(binding) || claimed.has(binding))) {
      const fallback = defaultBinding(definition.id);
      binding =
        fallback && !RESERVED_BINDINGS.has(fallback) && !claimed.has(fallback) ? fallback : null;
    }
    next.commands[definition.id] = binding ? { binding, disabled: false } : { disabled: true };
    if (binding) claimed.set(binding, definition.id);
  }

  for (const definition of COMMANDS.filter((item) => !item.global)) {
    const binding = defaultBinding(definition.id);
    if (binding && claimed.has(binding)) next.commands[definition.id] = { disabled: true };
  }
  validateEffectiveBindings(effectiveBindings(next));
  return next;
}

/**
 * Repair persisted V1 values whose semantics became unsafe as more command
 * consumers moved into Electron's context-free native menu. Defaults and
 * global commands win; a conflicting custom local binding resets to its
 * catalog default, while a conflicting default local command is disabled.
 */
export function repairKeybindingOverrides(value: unknown): KeybindingOverridesV1 {
  const next = normalizeKeybindingOverrides(value);
  const resetOrDisable = (commandId: CommandId, binding: string): void => {
    if (binding !== defaultBinding(commandId)) {
      const futureFields = futureKeybindingFields(next.commands[commandId]);
      if (Object.keys(futureFields).length > 0) {
        next.commands[commandId] = futureFields;
      } else {
        delete next.commands[commandId];
      }
    } else {
      const previous = next.commands[commandId] ?? {};
      next.commands[commandId] = { ...previous, disabled: true };
    }
  };

  for (let pass = 0; pass < COMMAND_IDS.length * 2; pass += 1) {
    const bindings = effectiveBindings(next);
    const reserved = COMMAND_IDS.find((id) => {
      const binding = bindings[id];
      return binding !== null && RESERVED_BINDINGS.has(binding);
    });
    if (reserved) {
      resetOrDisable(reserved, bindings[reserved] as string);
      continue;
    }

    let conflict: [CommandId, CommandId] | null = null;
    for (let leftIndex = 0; leftIndex < COMMAND_IDS.length; leftIndex += 1) {
      const leftId = COMMAND_IDS[leftIndex];
      const leftBinding = bindings[leftId];
      if (!leftBinding) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < COMMAND_IDS.length; rightIndex += 1) {
        const rightId = COMMAND_IDS[rightIndex];
        if (
          bindings[rightId] === leftBinding &&
          commandScopesOverlap(COMMAND_BY_ID[leftId], COMMAND_BY_ID[rightId])
        ) {
          conflict = [leftId, rightId];
          break;
        }
      }
      if (conflict) break;
    }
    if (!conflict) {
      validateEffectiveBindings(bindings);
      return next;
    }

    const [leftId, rightId] = conflict;
    const leftBinding = bindings[leftId] as string;
    const rightBinding = bindings[rightId] as string;
    const leftGlobal = COMMAND_BY_ID[leftId].global;
    const rightGlobal = COMMAND_BY_ID[rightId].global;
    const leftCustom = leftBinding !== defaultBinding(leftId);
    const rightCustom = rightBinding !== defaultBinding(rightId);
    const loser =
      leftGlobal !== rightGlobal
        ? leftGlobal
          ? rightId
          : leftId
        : leftCustom !== rightCustom
          ? leftCustom
            ? leftId
            : rightId
          : rightId;
    resetOrDisable(loser, bindings[loser] as string);
  }

  throw new KeybindingValidationError("Saved shortcuts could not be repaired safely.", "conflict");
}

export function validateEffectiveBindings(bindings: Record<CommandId, string | null>): void {
  const owners = new Map<string, CommandId[]>();
  for (const id of COMMAND_IDS) {
    const binding = bindings[id];
    if (!binding) continue;
    const normalized = normalizeAccelerator(binding);
    if (!normalized) {
      throw new KeybindingValidationError(`“${binding}” is not a valid shortcut.`, "invalid", id);
    }
    if (RESERVED_BINDINGS.has(normalized)) {
      throw new KeybindingValidationError(
        `${prettyAccelerator(normalized)} is reserved by Aiden or macOS.`,
        "reserved",
        id,
      );
    }
    const conflicting = (owners.get(normalized) ?? []).find((existing) =>
      commandScopesOverlap(COMMAND_BY_ID[id], COMMAND_BY_ID[existing]),
    );
    if (conflicting) {
      throw new KeybindingValidationError(
        `${prettyAccelerator(normalized)} is already used by ${COMMAND_BY_ID[conflicting].title}.`,
        "conflict",
        id,
      );
    }
    owners.set(normalized, [...(owners.get(normalized) ?? []), id]);
  }
}

export function applyKeybindingMutation(
  currentValue: unknown,
  mutation: KeybindingMutation,
  legacy?: LegacyGlobalKeybindings,
): KeybindingOverridesV1 {
  if (hasFutureKeybindings(currentValue)) {
    throw new KeybindingValidationError(
      "This shortcut document was created by a newer Aiden version and cannot be edited safely.",
      "future-version",
      mutation.commandId,
    );
  }
  const current = migrateLegacyKeybindings(currentValue, legacy);
  const next: KeybindingOverridesV1 = {
    ...current,
    version: 1,
    commands: { ...current.commands },
  };
  if ("reset" in mutation) {
    const futureFields = futureKeybindingFields(next.commands[mutation.commandId]);
    if (Object.keys(futureFields).length > 0) {
      next.commands[mutation.commandId] = futureFields;
    } else {
      delete next.commands[mutation.commandId];
    }
  } else if ("binding" in mutation) {
    const binding = normalizeAccelerator(mutation.binding);
    if (!binding) {
      throw new KeybindingValidationError(
        "Use at least one modifier and one letter, number, function key, arrow, Return, or Space.",
        "invalid",
        mutation.commandId,
      );
    }
    if (mutation.replace) {
      for (const id of COMMAND_IDS) {
        if (
          id !== mutation.commandId &&
          effectiveBindingFromNormalized(id, next) === binding &&
          commandScopesOverlap(COMMAND_BY_ID[mutation.commandId], COMMAND_BY_ID[id])
        ) {
          const previous = next.commands[id] ?? {};
          next.commands[id] = { ...previous, disabled: true };
        }
      }
    }
    next.commands[mutation.commandId] = {
      ...(next.commands[mutation.commandId] ?? {}),
      binding,
      disabled: false,
    };
  } else {
    const previous = next.commands[mutation.commandId] ?? {};
    const definition = COMMAND_BY_ID[mutation.commandId];
    next.commands[mutation.commandId] = {
      ...previous,
      ...(mutation.disabled === false && previous.binding == null && definition.defaultBinding
        ? { binding: definition.defaultBinding }
        : {}),
      disabled: mutation.disabled,
    };
  }
  validateEffectiveBindings(effectiveBindings(next));
  return next;
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && (COMMAND_IDS as readonly string[]).includes(value);
}
