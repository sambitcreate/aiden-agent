import type { CommandId } from "./keybindings";
import type { SettingsSection } from "./settings-section";

export const SLASH_LIMITS = Object.freeze({
  queryCharacters: 256,
  catalogEntries: 500,
  visibleResults: 100,
  safeNameCharacters: 80,
  safeDescriptionCharacters: 240,
  unavailableReasonCharacters: 160,
  invocationIdCharacters: 47,
  instructionBytes: 256 * 1024,
  formattedInvocationBytes: 1024 * 1024,
});

export const SKILL_SOURCES = ["configured", "workspace", "global"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillCatalogEntry {
  invocationId: string;
  name: string;
  description: string;
  source: SkillSource;
  available: boolean;
  unavailableReason?: string;
}

export interface SkillInvocationV1 {
  version: 1;
  invocationId: string;
  displayName: string;
  source: SkillSource;
}

/** Safe historical marker. The opaque, live invocation lease is deliberately not persisted. */
export interface SkillProvenanceV1 {
  version: 1;
  name: string;
  source: SkillSource;
}

export type SkillInvocationErrorCode =
  | "invalid_reference"
  | "skill_unavailable"
  | "skill_changed"
  | "workspace_changed"
  | "instructions_too_large"
  | "turn_unavailable";

export class SkillInvocationError extends Error {
  constructor(
    readonly code: SkillInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillInvocationError";
  }
}

export type SlashCommandIcon =
  | "access"
  | "appearance"
  | "assistant"
  | "chat"
  | "copy"
  | "clone"
  | "editor"
  | "environment"
  | "export"
  | "fork"
  | "hotkeys"
  | "mcp"
  | "model"
  | "new"
  | "logout"
  | "providers"
  | "rename"
  | "review"
  | "settings"
  | "sidebar"
  | "skills"
  | "session"
  | "terminal"
  | "worktree";

export type SlashCommandAction =
  | { kind: "command"; commandId: CommandId }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "chat"; action: "copy-latest" | "rename" }
  | { kind: "environment"; destination: "review" }
  | { kind: "composer-control"; control: "access" }
  | {
      kind: "session";
      action: "fork" | "clone" | "export" | "details" | "logout" | "worktree";
    };

export type SlashCommandAvailability =
  | "always"
  | "chat-required"
  | "idle-chat-navigation"
  | "latest-assistant-response"
  | "idle-chat-session"
  | "authenticated-provider"
  | "workspace-required"
  | "workspace-terminal"
  | "workspace-environment"
  | "workspace-worktree";

export interface SlashCommandDefinition {
  name: string;
  aliases: readonly string[];
  title: string;
  description: string;
  keywords: readonly string[];
  icon: SlashCommandIcon;
  action: SlashCommandAction;
  behavior: "immediate" | "picker" | "argument" | "navigation";
  availability: SlashCommandAvailability;
  argument: "none" | "optional-title" | "optional-branch";
  /** Commands such as New chat cannot silently discard meaningful composer state. */
  draftPolicy: "preserve" | "require-empty";
}

const define = (definition: SlashCommandDefinition): SlashCommandDefinition =>
  Object.freeze({
    ...definition,
    aliases: Object.freeze([...definition.aliases]),
    keywords: Object.freeze([...definition.keywords]),
    action: Object.freeze({ ...definition.action }),
  });

export const SLASH_COMMANDS = Object.freeze([
  define({
    name: "new",
    aliases: [],
    title: "New chat",
    description: "Start a new chat in this workspace.",
    keywords: ["conversation", "compose"],
    icon: "new",
    action: { kind: "command", commandId: "chat.new" },
    behavior: "immediate",
    availability: "idle-chat-navigation",
    argument: "none",
    draftPolicy: "require-empty",
  }),
  define({
    name: "model",
    aliases: ["models"],
    title: "Choose model",
    description: "Open the current model selector.",
    keywords: ["provider", "llm"],
    icon: "model",
    action: { kind: "command", commandId: "model.change" },
    behavior: "picker",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "settings",
    aliases: [],
    title: "Open Settings",
    description: "Open Aiden settings.",
    keywords: ["preferences", "configure"],
    icon: "settings",
    action: { kind: "command", commandId: "settings.open" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "hotkeys",
    aliases: ["shortcuts"],
    title: "Keyboard shortcuts",
    description: "Review and customize keyboard shortcuts.",
    keywords: ["keys", "bindings"],
    icon: "hotkeys",
    action: { kind: "settings", section: "shortcut" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "name",
    aliases: ["rename"],
    title: "Rename chat",
    description: "Rename the current chat.",
    keywords: ["title"],
    icon: "rename",
    action: { kind: "chat", action: "rename" },
    behavior: "argument",
    availability: "chat-required",
    argument: "optional-title",
    draftPolicy: "preserve",
  }),
  define({
    name: "copy",
    aliases: [],
    title: "Copy latest response",
    description: "Copy the latest assistant response.",
    keywords: ["clipboard", "answer"],
    icon: "copy",
    action: { kind: "chat", action: "copy-latest" },
    behavior: "immediate",
    availability: "latest-assistant-response",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "fork",
    aliases: [],
    title: "Fork from a turn",
    description: "Start a new chat from a completed turn.",
    keywords: ["branch", "conversation", "copy"],
    icon: "fork",
    action: { kind: "session", action: "fork" },
    behavior: "picker",
    availability: "idle-chat-session",
    argument: "none",
    draftPolicy: "require-empty",
  }),
  define({
    name: "clone",
    aliases: [],
    title: "Clone chat",
    description: "Copy this visible conversation into a new chat.",
    keywords: ["duplicate", "conversation"],
    icon: "clone",
    action: { kind: "session", action: "clone" },
    behavior: "immediate",
    availability: "idle-chat-session",
    argument: "none",
    draftPolicy: "require-empty",
  }),
  define({
    name: "export",
    aliases: [],
    title: "Export chat",
    description: "Save a versioned Aiden chat file.",
    keywords: ["download", "json", "backup"],
    icon: "export",
    action: { kind: "session", action: "export" },
    behavior: "immediate",
    availability: "idle-chat-session",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "session",
    aliases: ["details"],
    title: "Session details",
    description: "Review stored details for this Aiden chat.",
    keywords: ["info", "metadata", "summary"],
    icon: "session",
    action: { kind: "session", action: "details" },
    behavior: "picker",
    availability: "chat-required",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "resume",
    aliases: ["chats"],
    title: "Search chats",
    description: "Open chat search and history.",
    keywords: ["history", "conversation"],
    icon: "chat",
    action: { kind: "command", commandId: "chat.search" },
    behavior: "picker",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "login",
    aliases: [],
    title: "Connect a provider",
    description: "Open provider connections.",
    keywords: ["sign in", "account", "oauth"],
    icon: "providers",
    action: { kind: "settings", section: "providers" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "logout",
    aliases: ["signout"],
    title: "Sign out of a provider",
    description: "Choose an authenticated provider to disconnect.",
    keywords: ["account", "disconnect", "oauth"],
    icon: "logout",
    action: { kind: "session", action: "logout" },
    behavior: "picker",
    availability: "authenticated-provider",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "providers",
    aliases: [],
    title: "Manage providers",
    description: "Review providers and model catalogs.",
    keywords: ["connections", "models"],
    icon: "providers",
    action: { kind: "settings", section: "providers" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "assistant",
    aliases: [],
    title: "Open Aiden",
    description: "Open the Aiden assistant dock.",
    keywords: ["companion", "dock"],
    icon: "assistant",
    action: { kind: "command", commandId: "assistant.open" },
    behavior: "immediate",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "terminal",
    aliases: [],
    title: "Toggle terminal",
    description: "Show or hide the workspace terminal.",
    keywords: ["shell", "console"],
    icon: "terminal",
    action: { kind: "command", commandId: "terminal.toggle" },
    behavior: "immediate",
    availability: "workspace-terminal",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "environment",
    aliases: [],
    title: "Toggle environment",
    description: "Show or hide files and Git tools.",
    keywords: ["files", "git"],
    icon: "environment",
    action: { kind: "command", commandId: "environment.toggle" },
    behavior: "immediate",
    availability: "workspace-environment",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "review",
    aliases: ["code-review"],
    title: "Open code review",
    description: "Open the workspace Review destination.",
    keywords: ["diff", "changes", "git"],
    icon: "review",
    action: { kind: "environment", destination: "review" },
    behavior: "navigation",
    availability: "workspace-environment",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "sidebar",
    aliases: [],
    title: "Toggle sidebar",
    description: "Show or hide chat navigation.",
    keywords: ["navigation", "chats"],
    icon: "sidebar",
    action: { kind: "command", commandId: "sidebar.toggle" },
    behavior: "immediate",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "editor",
    aliases: [],
    title: "Open in editor",
    description: "Open this workspace in the preferred editor.",
    keywords: ["vscode", "cursor", "folder"],
    icon: "editor",
    action: { kind: "command", commandId: "workspace.openPreferredEditor" },
    behavior: "immediate",
    availability: "workspace-required",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "worktree",
    aliases: [],
    title: "New isolated worktree",
    description: "Create an Aiden-managed Git worktree and workspace.",
    keywords: ["git", "branch", "workspace", "isolated"],
    icon: "worktree",
    action: { kind: "session", action: "worktree" },
    behavior: "argument",
    availability: "workspace-worktree",
    argument: "optional-branch",
    draftPolicy: "preserve",
  }),
  define({
    name: "access",
    aliases: ["permissions"],
    title: "Workspace access",
    description: "Review the current workspace access mode.",
    keywords: ["full", "ask", "none"],
    icon: "access",
    action: { kind: "composer-control", control: "access" },
    behavior: "picker",
    availability: "workspace-required",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "mcp",
    aliases: [],
    title: "MCP servers",
    description: "Open MCP settings and connection status.",
    keywords: ["tools", "connectors", "servers"],
    icon: "mcp",
    action: { kind: "settings", section: "mcp" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "skills",
    aliases: [],
    title: "Manage skills",
    description: "Open configured and discovered skills.",
    keywords: ["instructions", "workflows"],
    icon: "skills",
    action: { kind: "settings", section: "skills" },
    behavior: "navigation",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
  define({
    name: "theme",
    aliases: ["appearance"],
    title: "Change appearance",
    description: "Open Aiden appearance choices.",
    keywords: ["light", "dark", "color"],
    icon: "appearance",
    action: { kind: "command", commandId: "settings.search" },
    behavior: "picker",
    availability: "always",
    argument: "none",
    draftPolicy: "preserve",
  }),
] satisfies readonly SlashCommandDefinition[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const OPAQUE_SKILL_INVOCATION_ID = /^sk1_[A-Za-z0-9_-]{43}$/u;

const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

function hasUnsafeDisplayCharacter(value: string): boolean {
  return UNSAFE_DISPLAY_CHARACTER.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedKeys = new Set(expected);
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > expected.length || !expectedKeys.has(key)) return false;
  }
  if (count !== expected.length) return false;
  return expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function normalizeSafeSkillText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maximum * 8 || hasUnsafeDisplayCharacter(value)) {
    throw new SkillInvocationError("invalid_reference", `Invalid ${label}.`);
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if ((!allowEmpty && !normalized) || Array.from(normalized).length > maximum) {
    throw new SkillInvocationError("invalid_reference", `Invalid ${label}.`);
  }
  return normalized;
}

export function isOpaqueSkillInvocationId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_SKILL_INVOCATION_ID.test(value);
}

export function isSkillSource(value: unknown): value is SkillSource {
  return typeof value === "string" && SKILL_SOURCES.includes(value as SkillSource);
}

export function parseSkillInvocationV1(value: unknown): SkillInvocationV1 {
  if (!isRecord(value) || value.version !== 1 || !isSkillSource(value.source)) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill invocation reference.");
  }
  if (!exactKeys(value, ["displayName", "invocationId", "source", "version"])) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill invocation fields.");
  }
  if (!isOpaqueSkillInvocationId(value.invocationId)) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill invocation ID.");
  }
  return {
    version: 1,
    invocationId: value.invocationId,
    displayName: normalizeSafeSkillText(
      value.displayName,
      "skill display name",
      SLASH_LIMITS.safeNameCharacters,
    ),
    source: value.source,
  };
}

export function parseSkillCatalogEntry(value: unknown): SkillCatalogEntry {
  if (!isRecord(value) || !isSkillSource(value.source) || typeof value.available !== "boolean") {
    throw new SkillInvocationError("invalid_reference", "Invalid skill catalog entry.");
  }
  const expected = ["available", "description", "invocationId", "name", "source"];
  if (value.unavailableReason !== undefined) expected.push("unavailableReason");
  if (!exactKeys(value, expected) || !isOpaqueSkillInvocationId(value.invocationId)) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill catalog fields.");
  }
  if (value.available && value.unavailableReason !== undefined) {
    throw new SkillInvocationError(
      "invalid_reference",
      "Available skills cannot have an unavailable reason.",
    );
  }
  if (!value.available && value.unavailableReason === undefined) {
    throw new SkillInvocationError("invalid_reference", "Unavailable skills require a reason.");
  }
  return {
    invocationId: value.invocationId,
    name: normalizeSafeSkillText(value.name, "skill name", SLASH_LIMITS.safeNameCharacters),
    description: normalizeSafeSkillText(
      value.description,
      "skill description",
      SLASH_LIMITS.safeDescriptionCharacters,
      true,
    ),
    source: value.source,
    available: value.available,
    ...(value.unavailableReason === undefined
      ? {}
      : {
          unavailableReason: normalizeSafeSkillText(
            value.unavailableReason,
            "skill unavailable reason",
            SLASH_LIMITS.unavailableReasonCharacters,
          ),
        }),
  };
}

export function parseSkillCatalog(value: unknown): SkillCatalogEntry[] {
  if (!Array.isArray(value) || value.length > SLASH_LIMITS.catalogEntries) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill catalog.");
  }
  const entries = value.map(parseSkillCatalogEntry);
  if (new Set(entries.map((entry) => entry.invocationId)).size !== entries.length) {
    throw new SkillInvocationError("invalid_reference", "Duplicate skill invocation ID.");
  }
  return entries;
}

export function skillProvenance(name: string, source: SkillSource): SkillProvenanceV1 {
  return {
    version: 1,
    name: normalizeSafeSkillText(name, "skill name", SLASH_LIMITS.safeNameCharacters),
    source,
  };
}

export function parseSkillProvenanceV1(value: unknown): SkillProvenanceV1 | undefined {
  if (!isRecord(value) || value.version !== 1 || !isSkillSource(value.source)) return undefined;
  if (!exactKeys(value, ["name", "source", "version"])) return undefined;
  try {
    return skillProvenance(value.name as string, value.source);
  } catch {
    return undefined;
  }
}
