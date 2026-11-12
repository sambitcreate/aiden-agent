// The global approval mode (docs/plans/bot-ux-simplification.md §3.1, §7).
//
// One mode for the whole Mac: Ask, Auto or Never ask. Every Bot follows it. A
// workspace follows it too, unless the person chose Customize in Workspace
// settings. Shared by the main process, the CLI daemon and the renderer.

export const APPROVAL_MODES = ["auto", "ask", "never"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === "auto" || value === "ask" || value === "never" ? value : undefined;
}

export const APPROVAL_MODE_LABELS: Readonly<Record<ApprovalMode, string>> = {
  auto: "Auto",
  ask: "Ask",
  never: "Never ask",
};

export const APPROVAL_MODE_HELP: Readonly<Record<ApprovalMode, string>> = {
  auto: "A model approves routine actions and asks you about the rest.",
  ask: "Asks before sending, spending or changing anything.",
  never: "Asks only before purchases, sharing your data and the first use of your Mac. Only Block rules apply.",
};

/** The parts of the person's Mac whose first use asks in every mode (§3.3). */
export const MAC_GRANT_CLASSES = ["shell", "files", "computer-use"] as const;
export type MacGrantClass = (typeof MAC_GRANT_CLASSES)[number];

export const MAC_GRANT_LABELS: Readonly<Record<MacGrantClass, string>> = {
  shell: "Run commands",
  files: "Change files",
  "computer-use": "Use your Mac with Computer Use",
};

/** A workspace's stored Mac grants: "Allowed in this workspace". Unknown keys are dropped. */
export type WorkspaceMacGrants = Partial<Record<MacGrantClass, true>>;

export function parseWorkspaceMacGrants(value: unknown): WorkspaceMacGrants | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const grants: WorkspaceMacGrants = {};
  for (const kind of MAC_GRANT_CLASSES) {
    if (Object.prototype.hasOwnProperty.call(record, kind) && record[kind] === true) grants[kind] = true;
  }
  return Object.keys(grants).length > 0 ? grants : undefined;
}

/** The global setting, before a model's availability is considered. */
export interface ApprovalModeSettings {
  approvalMode?: unknown;
}

/**
 * The mode this Mac runs in. A fresh install has no stored mode and gets Auto
 * once a usable model exists; an install upgraded from before modes existed
 * was given Ask at startup (`approvalModeAfterUpgrade`). Auto without a usable
 * model is Ask.
 */
export function effectiveApprovalMode(settings: ApprovalModeSettings | undefined, usableModel: boolean): ApprovalMode {
  const raw = settings?.approvalMode;
  // Unset follows a usable model to Auto; a value that isn't a mode is Ask.
  const mode = raw === undefined ? "auto" : (parseApprovalMode(raw) ?? "ask");
  return mode === "auto" && !usableModel ? "ask" : mode;
}

/**
 * Evidence from the profile on the first start of a release with modes, for
 * deviation (a): an existing user is never moved to Auto by an upgrade.
 */
export interface ApprovalModeMigrationEvidence {
  /** A mode is already stored. */
  stored: boolean;
  /** Settings or workspaces were written by an earlier release. */
  upgradedProfile: boolean;
  /** Any chat, non-default workspace or Bot exists. */
  inUse: boolean;
}

/**
 * The mode to write at startup, or `undefined` to leave a fresh install unset
 * (it follows a usable model to Auto). Never returns Auto.
 */
export function approvalModeAfterUpgrade(evidence: ApprovalModeMigrationEvidence): "ask" | undefined {
  if (evidence.stored) return undefined;
  return evidence.upgradedProfile || evidence.inUse ? "ask" : undefined;
}

/** The workspace fields that decide its approval policy. */
export interface ApprovalWorkspaceFields {
  /** Legacy access: "full" | "ask" | "none" ("none" is Chat only). */
  permission?: unknown;
  /** Present only when the person chose Customize. */
  approvalMode?: unknown;
  macGrants?: unknown;
}

export interface WorkspaceApprovalPolicy {
  mode: ApprovalMode;
  /** The workspace chose its own mode, so its composer shows the mode chip. */
  customized: boolean;
  /** Chat only: the agent cannot read or change the folder. */
  chatOnly: boolean;
  /** "Allowed in this workspace" Mac grants. */
  macGrants: ReadonlySet<MacGrantClass>;
  /**
   * A workspace stored as Full access by an earlier release that the person
   * has not changed since: customized Never ask with shell and files allowed,
   * the same reach as before (§7).
   */
  legacyFull: boolean;
}

/** How a workspace decides approvals under the global mode (§3.1, §7). */
export function workspaceApprovalPolicy(
  workspace: ApprovalWorkspaceFields | undefined,
  globalMode: ApprovalMode,
): WorkspaceApprovalPolicy {
  const own = parseApprovalMode(workspace?.approvalMode);
  const grants = new Set<MacGrantClass>(Object.keys(parseWorkspaceMacGrants(workspace?.macGrants) ?? {}) as MacGrantClass[]);
  const chatOnly = workspace?.permission === "none";
  if (own === undefined && workspace?.permission === "full") {
    grants.add("shell");
    grants.add("files");
    return { mode: "never", customized: true, chatOnly, macGrants: grants, legacyFull: true };
  }
  return { mode: own ?? globalMode, customized: own !== undefined, chatOnly, macGrants: grants, legacyFull: false };
}

/**
 * The workspace fields to write when the person changes its mode or grants.
 * A legacy Full workspace keeps its reach as explicit grants, and its stored
 * access drops to "ask" so an earlier release reads it as Ask (narrower, never
 * wider). `mode: undefined` means "Use the global mode".
 */
export function workspaceApprovalPatch(
  workspace: ApprovalWorkspaceFields,
  change: { mode?: ApprovalMode | null; revokeMac?: MacGrantClass; grantMac?: MacGrantClass },
): { permission?: "ask"; approvalMode?: ApprovalMode | null; macGrants: WorkspaceMacGrants | null } {
  const current = workspaceApprovalPolicy(workspace, "ask");
  const grants = new Set(current.macGrants);
  if (change.revokeMac) grants.delete(change.revokeMac);
  if (change.grantMac) grants.add(change.grantMac);
  const macGrants: WorkspaceMacGrants = {};
  for (const kind of MAC_GRANT_CLASSES) if (grants.has(kind)) macGrants[kind] = true;
  const mode = change.mode === undefined ? (current.legacyFull ? "never" : parseApprovalMode(workspace.approvalMode) ?? null) : change.mode;
  return {
    ...(current.legacyFull ? { permission: "ask" as const } : {}),
    approvalMode: mode,
    macGrants: Object.keys(macGrants).length > 0 ? macGrants : null,
  };
}

/** The approval settings a Settings write may change. */
export interface ApprovalSettingsPatch {
  approvalMode?: ApprovalMode;
  approvalChangesSeen?: true;
  /** `undefined` (present) clears it: the judge uses the chat's own model. */
  approvalModel?: { providerId: string; model: string } | undefined;
}

const MAX_APPROVAL_MODEL_ID = 512;

/**
 * Validate the approval fields of a Settings patch. Only present keys are
 * returned; anything malformed throws. `approvalModeOrigin` is never writable.
 */
export function parseApprovalSettingsPatch(patch: Readonly<Record<string, unknown>>): ApprovalSettingsPatch {
  const next: ApprovalSettingsPatch = {};
  if (patch.approvalMode !== undefined) {
    const mode = parseApprovalMode(patch.approvalMode);
    if (!mode) throw new Error("Invalid approval mode.");
    next.approvalMode = mode;
  }
  if (patch.approvalChangesSeen !== undefined) {
    if (patch.approvalChangesSeen !== true) throw new Error("Invalid approvals note setting.");
    next.approvalChangesSeen = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "approvalModel")) {
    const value = patch.approvalModel;
    if (value === null || value === undefined) next.approvalModel = undefined;
    else if (
      typeof value === "object" &&
      typeof (value as { providerId?: unknown }).providerId === "string" &&
      typeof (value as { model?: unknown }).model === "string" &&
      (value as { providerId: string }).providerId.length > 0 &&
      (value as { providerId: string }).providerId.length <= MAX_APPROVAL_MODEL_ID &&
      (value as { model: string }).model.length > 0 &&
      (value as { model: string }).model.length <= MAX_APPROVAL_MODEL_ID
    ) {
      next.approvalModel = { providerId: (value as { providerId: string }).providerId, model: (value as { model: string }).model };
    } else throw new Error("Invalid approval model.");
  }
  return next;
}

/** The stored approval model, when it is well formed. */
export function parseApprovalModel(value: unknown): { providerId: string; model: string } | undefined {
  try {
    return parseApprovalSettingsPatch({ approvalModel: value }).approvalModel;
  } catch {
    return undefined;
  }
}
