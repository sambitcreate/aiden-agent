import { createHash } from "node:crypto";

export const DESIGN_HANDOFF_PACKET_VERSION = 1 as const;
export const DESIGN_HANDOFF_JOURNAL_VERSION = 1 as const;
export const DESIGN_HANDOFF_JOURNAL_LIMIT = 128;

const MAX_ID = 128;
const MAX_LABEL = 160;
const MAX_DECISIONS = 32;
const MAX_DECISION = 500;
const MAX_REFERENCES = 32;
const MAX_RESPONSIVE_STATES = 8;
const STRONG_WARNING = "I understand this handoff will use this existing workspace" as const;
const DIRTY_DISCLOSURE = "I understand uncommitted changes are not included" as const;

export type DesignResponsiveState = "desktop" | "tablet" | "phone";

export interface DesignHandoffPacketV1 {
  version: typeof DESIGN_HANDOFF_PACKET_VERSION;
  projectId: string;
  projectRevision: number;
  source: {
    bundleId: string;
    lineageId: string;
    revisionId: string;
    sha256: string;
    byteSize: number;
  };
  referenceAssetIds: string[];
  designDecisions: Array<{ id: string; summary: string }>;
  responsiveStates: Array<{
    viewport: DesignResponsiveState;
    width: number;
    height: number;
  }>;
}

export interface DesignHandoffTargetPreview {
  workspaceId: string;
  workspaceLabel: string;
  repositoryLabel: string;
  branchLabel: string;
}

export type DesignHandoffTarget =
  | {
      kind: "managed-worktree";
      source: DesignHandoffTargetPreview;
      previewDigest: string;
      expectedCommittedHead: string;
      dirtyCheckout: boolean;
      dirtyCheckoutAcknowledgement?: typeof DIRTY_DISCLOSURE;
    }
  | {
      kind: "existing-workspace";
      target: DesignHandoffTargetPreview;
      previewDigest: string;
      strongWarningAcknowledgement: typeof STRONG_WARNING;
    };

export interface DesignHandoffWorkspaceResult {
  workspaceId: string;
  workspaceLabel: string;
  branchLabel: string;
  managed: boolean;
  createdFromHead?: string;
}

export interface DesignHandoffChatResult {
  chatId: string;
  taskId: string;
}

export interface DesignHandoffLinkResult {
  projectId: string;
  workspaceId: string;
  chatId: string;
  taskId: string;
  branchLabel: string;
}

export type DesignHandoffStage =
  | "prepared"
  | "workspace-ready"
  | "chat-ready"
  | "context-ready"
  | "published"
  | "rolling-back"
  | "rolled-back"
  | "recoverable";

export interface DesignHandoffJournalRecordV1 {
  version: typeof DESIGN_HANDOFF_JOURNAL_VERSION;
  operationId: string;
  revision: number;
  stage: DesignHandoffStage;
  packet: DesignHandoffPacketV1;
  target: DesignHandoffTarget;
  workspace?: DesignHandoffWorkspaceResult;
  chat?: DesignHandoffChatResult;
  linkage?: DesignHandoffLinkResult;
  cancellationRequested: boolean;
  recoveryReason?: string;
  startedAt: number;
  updatedAt: number;
}

export interface DesignHandoffJournalDocumentV1 {
  version: typeof DESIGN_HANDOFF_JOURNAL_VERSION;
  operations: DesignHandoffJournalRecordV1[];
}

export class DesignHandoffValidationError extends Error {
  readonly name = "DesignHandoffValidationError";
}

function fail(message: string): never {
  throw new DesignHandoffValidationError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} contains unsupported fields.`);
  }
}

function safeId(value: unknown, name: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > MAX_ID ||
    value.normalize("NFKC") !== value || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) fail(`${name} is invalid.`);
  return value;
}

function safeLabel(value: unknown, name: string): string {
  const text = safeText(value, name, MAX_LABEL);
  if (/(?:^|\s)(?:\/\S+|~\/\S+|[A-Za-z]:\\\S*)/u.test(text) || /file:\/\//iu.test(text)) {
    fail(`${name} must not contain an absolute path.`);
  }
  return text;
}

function safeText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || value.normalize("NFKC") !== value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) fail(`${name} is invalid.`);
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${name} is invalid.`);
  return value;
}

function commit(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    fail("expectedCommittedHead is invalid.");
  }
  return value;
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(`${name} is invalid.`);
  }
  return value as number;
}

function safeContext(value: unknown): string {
  const text = safeText(value, "design decision", MAX_DECISION);
  if (
    /(?:^|\s)(?:\/\S+|~\/\S+|[A-Za-z]:\\\S*)/u.test(text) || /file:\/\//iu.test(text) ||
    /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|authorization\s*:|bearer\s+)/iu.test(text) ||
    ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))
  ) fail("design decision may contain a path, credential, or internal JSON.");
  return text;
}

export function designHandoffTargetPreviewDigest(preview: DesignHandoffTargetPreview): string {
  const parsed = parsePreview(preview);
  return createHash("sha256")
    .update(JSON.stringify([
      parsed.workspaceId,
      parsed.workspaceLabel,
      parsed.repositoryLabel,
      parsed.branchLabel,
    ]))
    .digest("hex");
}

function parsePreview(value: unknown): DesignHandoffTargetPreview {
  const input = record(value, "target preview");
  exact(input, ["workspaceId", "workspaceLabel", "repositoryLabel", "branchLabel"], "target preview");
  return {
    workspaceId: safeId(input.workspaceId, "workspaceId"),
    workspaceLabel: safeLabel(input.workspaceLabel, "workspaceLabel"),
    repositoryLabel: safeLabel(input.repositoryLabel, "repositoryLabel"),
    branchLabel: safeLabel(input.branchLabel, "branchLabel"),
  };
}

export function parseDesignHandoffPacket(value: unknown): DesignHandoffPacketV1 {
  const input = record(value, "handoff packet");
  exact(input, ["version", "projectId", "projectRevision", "source", "referenceAssetIds", "designDecisions", "responsiveStates"], "handoff packet");
  if (input.version !== DESIGN_HANDOFF_PACKET_VERSION) fail("Unsupported handoff packet version.");
  const source = record(input.source, "source");
  exact(source, ["bundleId", "lineageId", "revisionId", "sha256", "byteSize"], "source");
  if (!Array.isArray(input.referenceAssetIds) || input.referenceAssetIds.length > MAX_REFERENCES) {
    fail("referenceAssetIds is invalid.");
  }
  const referenceAssetIds = input.referenceAssetIds.map((id) => safeId(id, "reference asset ID"));
  if (new Set(referenceAssetIds).size !== referenceAssetIds.length) fail("referenceAssetIds contains duplicates.");
  if (!Array.isArray(input.designDecisions) || input.designDecisions.length > MAX_DECISIONS) {
    fail("designDecisions is invalid.");
  }
  const designDecisions = input.designDecisions.map((raw) => {
    const decision = record(raw, "design decision");
    exact(decision, ["id", "summary"], "design decision");
    return { id: safeId(decision.id, "design decision ID"), summary: safeContext(decision.summary) };
  });
  if (new Set(designDecisions.map(({ id }) => id)).size !== designDecisions.length) fail("designDecisions contains duplicate IDs.");
  if (!Array.isArray(input.responsiveStates) || input.responsiveStates.length < 1 || input.responsiveStates.length > MAX_RESPONSIVE_STATES) {
    fail("responsiveStates is invalid.");
  }
  const responsiveStates = input.responsiveStates.map((raw) => {
    const state = record(raw, "responsive state");
    exact(state, ["viewport", "width", "height"], "responsive state");
    if (state.viewport !== "desktop" && state.viewport !== "tablet" && state.viewport !== "phone") {
      fail("responsive viewport is invalid.");
    }
    return {
      viewport: state.viewport as DesignResponsiveState,
      width: integer(state.width, "responsive width", 8192),
      height: integer(state.height, "responsive height", 8192),
    };
  });
  if (responsiveStates.some(({ width, height }) => width === 0 || height === 0)) fail("responsive dimensions must be positive.");
  if (new Set(responsiveStates.map(({ viewport }) => viewport)).size !== responsiveStates.length) fail("responsiveStates contains duplicate viewports.");
  return {
    version: DESIGN_HANDOFF_PACKET_VERSION,
    projectId: safeId(input.projectId, "projectId"),
    projectRevision: integer(input.projectRevision, "projectRevision"),
    source: {
      bundleId: safeId(source.bundleId, "bundleId"),
      lineageId: safeId(source.lineageId, "lineageId"),
      revisionId: safeId(source.revisionId, "revisionId"),
      sha256: sha256(source.sha256, "source sha256"),
      byteSize: integer(source.byteSize, "source byteSize", 16 * 1024 * 1024),
    },
    referenceAssetIds,
    designDecisions,
    responsiveStates,
  };
}

export function parseDesignHandoffTarget(value: unknown): DesignHandoffTarget {
  const input = record(value, "handoff target");
  if (input.kind === "managed-worktree") {
    const keys = ["kind", "source", "previewDigest", "expectedCommittedHead", "dirtyCheckout"];
    if (input.dirtyCheckoutAcknowledgement !== undefined) keys.push("dirtyCheckoutAcknowledgement");
    exact(input, keys, "managed-worktree target");
    const source = parsePreview(input.source);
    if (sha256(input.previewDigest, "previewDigest") !== designHandoffTargetPreviewDigest(source)) fail("target preview digest does not match.");
    if (typeof input.dirtyCheckout !== "boolean") fail("dirtyCheckout is invalid.");
    if (input.dirtyCheckout && input.dirtyCheckoutAcknowledgement !== DIRTY_DISCLOSURE) fail("Dirty-checkout disclosure was not acknowledged.");
    if (!input.dirtyCheckout && input.dirtyCheckoutAcknowledgement !== undefined) fail("Dirty-checkout acknowledgement is unexpected.");
    return {
      kind: "managed-worktree", source,
      previewDigest: input.previewDigest as string,
      expectedCommittedHead: commit(input.expectedCommittedHead),
      dirtyCheckout: input.dirtyCheckout,
      ...(input.dirtyCheckout ? { dirtyCheckoutAcknowledgement: DIRTY_DISCLOSURE } : {}),
    };
  }
  if (input.kind === "existing-workspace") {
    exact(input, ["kind", "target", "previewDigest", "strongWarningAcknowledgement"], "existing-workspace target");
    const target = parsePreview(input.target);
    if (sha256(input.previewDigest, "previewDigest") !== designHandoffTargetPreviewDigest(target)) fail("target preview digest does not match.");
    if (input.strongWarningAcknowledgement !== STRONG_WARNING) fail("Existing-workspace warning was not acknowledged.");
    return { kind: "existing-workspace", target, previewDigest: input.previewDigest as string, strongWarningAcknowledgement: STRONG_WARNING };
  }
  fail("Unknown handoff target kind.");
}

function parseWorkspace(value: unknown): DesignHandoffWorkspaceResult {
  const input = record(value, "workspace result");
  const keys = ["workspaceId", "workspaceLabel", "branchLabel", "managed"];
  if (input.createdFromHead !== undefined) keys.push("createdFromHead");
  exact(input, keys, "workspace result");
  if (typeof input.managed !== "boolean") fail("workspace managed flag is invalid.");
  const result: DesignHandoffWorkspaceResult = {
    workspaceId: safeId(input.workspaceId, "workspaceId"),
    workspaceLabel: safeLabel(input.workspaceLabel, "workspaceLabel"),
    branchLabel: safeLabel(input.branchLabel, "branchLabel"),
    managed: input.managed,
  };
  if (input.managed) result.createdFromHead = commit(input.createdFromHead);
  else if (input.createdFromHead !== undefined) fail("Existing workspace cannot have createdFromHead.");
  return result;
}

function parseChat(value: unknown): DesignHandoffChatResult {
  const input = record(value, "chat result");
  exact(input, ["chatId", "taskId"], "chat result");
  return { chatId: safeId(input.chatId, "chatId"), taskId: safeId(input.taskId, "taskId") };
}

function parseLink(value: unknown): DesignHandoffLinkResult {
  const input = record(value, "linkage");
  exact(input, ["projectId", "workspaceId", "chatId", "taskId", "branchLabel"], "linkage");
  return {
    projectId: safeId(input.projectId, "projectId"), workspaceId: safeId(input.workspaceId, "workspaceId"),
    chatId: safeId(input.chatId, "chatId"), taskId: safeId(input.taskId, "taskId"),
    branchLabel: safeLabel(input.branchLabel, "branchLabel"),
  };
}

const STAGES = new Set<DesignHandoffStage>(["prepared", "workspace-ready", "chat-ready", "context-ready", "published", "rolling-back", "rolled-back", "recoverable"]);

export function parseDesignHandoffJournalRecord(value: unknown): DesignHandoffJournalRecordV1 {
  const input = record(value, "handoff journal record");
  const keys = ["version", "operationId", "revision", "stage", "packet", "target", "cancellationRequested", "startedAt", "updatedAt"];
  if (input.workspace !== undefined) keys.push("workspace");
  if (input.chat !== undefined) keys.push("chat");
  if (input.linkage !== undefined) keys.push("linkage");
  if (input.recoveryReason !== undefined) keys.push("recoveryReason");
  exact(input, keys, "handoff journal record");
  if (input.version !== DESIGN_HANDOFF_JOURNAL_VERSION) fail("Unsupported handoff journal version.");
  if (typeof input.stage !== "string" || !STAGES.has(input.stage as DesignHandoffStage)) fail("Unknown handoff stage.");
  if (typeof input.cancellationRequested !== "boolean") fail("Invalid cancellation state.");
  const stage = input.stage as DesignHandoffStage;
  const workspace = input.workspace === undefined ? undefined : parseWorkspace(input.workspace);
  const chat = input.chat === undefined ? undefined : parseChat(input.chat);
  const linkage = input.linkage === undefined ? undefined : parseLink(input.linkage);
  if (["workspace-ready", "chat-ready", "context-ready", "published"].includes(stage) && !workspace) fail("Handoff stage requires workspace identity.");
  if (["chat-ready", "context-ready", "published"].includes(stage) && !chat) fail("Handoff stage requires chat identity.");
  if (stage === "published" && !linkage) fail("Published handoff requires linkage.");
  if (linkage && stage !== "published" && stage !== "recoverable") fail("Unpublished handoff cannot contain linkage.");
  if (
    linkage && (
      linkage.projectId !== parseDesignHandoffPacket(input.packet).projectId ||
      (workspace && (linkage.workspaceId !== workspace.workspaceId || linkage.branchLabel !== workspace.branchLabel)) ||
      (chat && (linkage.chatId !== chat.chatId || linkage.taskId !== chat.taskId))
    )
  ) fail("Handoff linkage does not match its project, workspace, or task identity.");
  if ((stage === "recoverable") !== (input.recoveryReason !== undefined)) fail("Recoverable handoff requires one recovery reason only.");
  return {
    version: DESIGN_HANDOFF_JOURNAL_VERSION,
    operationId: safeId(input.operationId, "operationId"), revision: integer(input.revision, "revision"), stage,
    packet: parseDesignHandoffPacket(input.packet), target: parseDesignHandoffTarget(input.target),
    ...(workspace ? { workspace } : {}), ...(chat ? { chat } : {}), ...(linkage ? { linkage } : {}),
    cancellationRequested: input.cancellationRequested,
    ...(input.recoveryReason !== undefined ? {
      recoveryReason: (() => {
        const reason = safeContext(input.recoveryReason);
        if (reason.length > MAX_LABEL) fail("recoveryReason is too long.");
        return reason;
      })(),
    } : {}),
    startedAt: integer(input.startedAt, "startedAt"), updatedAt: integer(input.updatedAt, "updatedAt"),
  };
}

export function parseDesignHandoffJournalDocument(value: unknown): DesignHandoffJournalDocumentV1 {
  const input = record(value, "handoff journal");
  exact(input, ["version", "operations"], "handoff journal");
  if (input.version !== DESIGN_HANDOFF_JOURNAL_VERSION || !Array.isArray(input.operations) || input.operations.length > DESIGN_HANDOFF_JOURNAL_LIMIT) {
    fail("Handoff journal is unsupported or exceeds its bound.");
  }
  const operations = input.operations.map(parseDesignHandoffJournalRecord);
  if (new Set(operations.map(({ operationId }) => operationId)).size !== operations.length) fail("Handoff journal contains duplicate operation IDs.");
  return { version: DESIGN_HANDOFF_JOURNAL_VERSION, operations };
}

export const DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT = STRONG_WARNING;
export const DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT = DIRTY_DISCLOSURE;
