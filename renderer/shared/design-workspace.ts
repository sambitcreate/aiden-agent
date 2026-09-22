import type { ChatMessage } from "../lib/types";
import type { ChatHtmlArtifactV1 } from "./chat-artifacts";
import type {
  DesignDirectEditV1,
  DesignProjectSnapshot as DesignProjectSnapshotV1,
} from "./design-projects";

export const DESIGN_ARTIFACT_MEDIA_ID_PREFIX = "design:" as const;
export const MAX_DESIGN_CONTEXT_BYTES = 128 * 1024;
export const DESIGN_ELEMENT_SELECTION_VERSION = 1 as const;
export const DESIGN_TURN_CONTEXT_VERSION = 1 as const;
export const DESIGN_PICKER_COMMAND = "aiden:design-picker/v1" as const;
export const DESIGN_PICKER_SELECTION = "aiden:design-element-selected/v1" as const;
export const MAX_DESIGN_SELECTION_BYTES = 2 * 1024;
export const MAX_DESIGN_TURN_TARGETS = 5;

const DESIGN_ARTIFACT_ID = /^[a-f0-9]{64}$/u;
const DESIGN_ELEMENT_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const DESIGN_TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

/** Serializes project-history recovery with generation preflight and admission. */
export class DesignOperationFence {
  private active?: symbol;

  tryAcquire(label: string): symbol | undefined {
    if (this.active) return undefined;
    const token = Symbol(label);
    this.active = token;
    return token;
  }

  release(token: symbol): void {
    if (this.active === token) this.active = undefined;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }
}

/** True when a parent refresh only advances record metadata, not canvas/runtime content. */
export function isDesignProjectMetadataOnlyUpdate(
  previous: DesignProjectSnapshotV1,
  next: DesignProjectSnapshotV1,
): boolean {
  if (
    previous.id !== next.id ||
    previous.chatId !== next.chatId ||
    previous.workspaceId !== next.workspaceId ||
    previous.connectionState !== next.connectionState ||
    previous.previewScriptId !== next.previewScriptId
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.canvas) === JSON.stringify(next.canvas) &&
    JSON.stringify(previous.referenceAssetIds) === JSON.stringify(next.referenceAssetIds) &&
    JSON.stringify(previous.designSystemBinding) === JSON.stringify(next.designSystemBinding)
  );
}

export interface DesignElementSelectionV1 {
  version: typeof DESIGN_ELEMENT_SELECTION_VERSION;
  tagName: string;
  label: string;
  selector: string;
  elementId?: string;
  role?: string;
  text?: string;
}

export interface DesignTurnTargetV1 {
  mediaId: string;
  artifactId: string;
  selection?: DesignElementSelectionV1;
}

export interface DesignPrototypeDirectEditRetryPayloadV1 {
  projectId: string;
  lineageId: string;
  mediaId: string;
  selection: DesignElementSelectionV1;
  edit: DesignDirectEditV1;
}

export interface DesignConnectedDirectEditRetryPayloadV1 {
  projectId: string;
  sourceSelectionId: string;
  edit: DesignDirectEditV1;
}

/** Stable canonical identity for exactly one renderer-owned prototype edit payload. */
export function designPrototypeDirectEditRetryKey(
  input: DesignPrototypeDirectEditRetryPayloadV1,
): string {
  return JSON.stringify([
    input.projectId,
    input.lineageId,
    input.mediaId,
    input.selection.version,
    input.selection.tagName,
    input.selection.label,
    input.selection.selector,
    input.selection.elementId ?? null,
    input.selection.role ?? null,
    input.selection.text ?? null,
    input.edit,
  ]);
}

/** Stable canonical identity for exactly one renderer-owned connected edit payload. */
export function designConnectedDirectEditRetryKey(
  input: DesignConnectedDirectEditRetryPayloadV1,
): string {
  return JSON.stringify([input.projectId, input.sourceSelectionId, input.edit]);
}

class DesignDirectEditRetryState<Input> {
  private pending: { key: string; operationId: string } | undefined;

  constructor(
    private readonly keyFor: (input: Input) => string,
    private readonly createOperationId: () => string,
  ) {}

  operationIdFor(input: Input): string {
    const key = this.keyFor(input);
    if (this.pending?.key === key) return this.pending.operationId;
    const operationId = this.createOperationId();
    this.pending = { key, operationId };
    return operationId;
  }

  resetUnless(input: Input | undefined): void {
    if (!input || this.pending?.key !== this.keyFor(input)) this.pending = undefined;
  }

  complete(operationId: string): void {
    if (this.pending?.operationId === operationId) this.pending = undefined;
  }
}

/** Retains one operation ID across failures and clears it on payload change or success. */
export class DesignPrototypeDirectEditRetryState {
  private readonly state: DesignDirectEditRetryState<DesignPrototypeDirectEditRetryPayloadV1>;

  constructor(createOperationId: () => string = () => `gesture:${globalThis.crypto.randomUUID()}`) {
    this.state = new DesignDirectEditRetryState(
      designPrototypeDirectEditRetryKey,
      createOperationId,
    );
  }

  operationIdFor(input: DesignPrototypeDirectEditRetryPayloadV1): string {
    return this.state.operationIdFor(input);
  }

  resetUnless(input: DesignPrototypeDirectEditRetryPayloadV1 | undefined): void {
    this.state.resetUnless(input);
  }

  complete(operationId: string): void {
    this.state.complete(operationId);
  }
}

/** Retains one connected-edit operation ID through an ambiguous renderer retry. */
export class DesignConnectedDirectEditRetryState {
  private readonly state: DesignDirectEditRetryState<DesignConnectedDirectEditRetryPayloadV1>;

  constructor(createOperationId: () => string = () => `gesture:${globalThis.crypto.randomUUID()}`) {
    this.state = new DesignDirectEditRetryState(
      designConnectedDirectEditRetryKey,
      createOperationId,
    );
  }

  operationIdFor(input: DesignConnectedDirectEditRetryPayloadV1): string {
    return this.state.operationIdFor(input);
  }

  resetUnless(input: DesignConnectedDirectEditRetryPayloadV1 | undefined): void {
    this.state.resetUnless(input);
  }

  complete(operationId: string): void {
    this.state.complete(operationId);
  }
}

/** One exact renderer selection paired with the project revision durably saved by main. */
export interface DesignProjectPersistenceSnapshotV1 {
  project: DesignProjectSnapshotV1;
  targets: DesignTurnTargetV1[];
}

export function snapshotDesignTurnTargets(
  targets: readonly DesignTurnTargetV1[],
): DesignTurnTargetV1[] {
  return targets.map((target) => ({
    ...target,
    ...(target.selection ? { selection: { ...target.selection } } : {}),
  }));
}

/** Ephemeral renderer-to-main context for one attended Design generation. */
export interface DesignTurnContextV1 {
  version: typeof DESIGN_TURN_CONTEXT_VERSION;
  targets: DesignTurnTargetV1[];
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function boundedPlainText(value: unknown, maxChars: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return undefined;
  if (value.trim() !== value) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

/** Parse guest-supplied element context. It is display/model context, never authority. */
export function parseDesignElementSelection(value: unknown): DesignElementSelectionV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(
      record,
      new Set(["version", "tagName", "label", "selector", "elementId", "role", "text"]),
    ) ||
    record.version !== DESIGN_ELEMENT_SELECTION_VERSION
  ) {
    return undefined;
  }
  const tagName = boundedPlainText(record.tagName, 32);
  const label = boundedPlainText(record.label, 160);
  const selector = boundedPlainText(record.selector, 512);
  const elementId = boundedPlainText(record.elementId, 120, true);
  const role = boundedPlainText(record.role, 64, true);
  const text = boundedPlainText(record.text, 240, true);
  if (!tagName || !DESIGN_TAG_NAME.test(tagName) || !label || !selector) return undefined;
  if (elementId !== undefined && !DESIGN_ELEMENT_ID.test(elementId)) return undefined;
  const parsed: DesignElementSelectionV1 = {
    version: DESIGN_ELEMENT_SELECTION_VERSION,
    tagName,
    label,
    selector,
    ...(elementId ? { elementId } : {}),
    ...(role ? { role } : {}),
    ...(text ? { text } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(parsed)).byteLength <= MAX_DESIGN_SELECTION_BYTES
    ? parsed
    : undefined;
}

export function parseDesignTurnContext(value: unknown): DesignTurnContextV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, new Set(["version", "targets"])) ||
    record.version !== DESIGN_TURN_CONTEXT_VERSION ||
    !Array.isArray(record.targets) ||
    record.targets.length === 0 ||
    record.targets.length > MAX_DESIGN_TURN_TARGETS
  ) {
    return undefined;
  }
  const targets: DesignTurnTargetV1[] = [];
  const seen = new Set<string>();
  for (const value of record.targets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const target = value as Record<string, unknown>;
    if (!exactKeys(target, new Set(["mediaId", "artifactId", "selection"]))) return undefined;
    if (
      typeof target.mediaId !== "string" ||
      !target.mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX) ||
      target.mediaId.length > 256 ||
      !/^[A-Za-z0-9._:-]+$/u.test(target.mediaId) ||
      typeof target.artifactId !== "string" ||
      !DESIGN_ARTIFACT_ID.test(target.artifactId) ||
      seen.has(target.mediaId)
    ) {
      return undefined;
    }
    const selection = parseDesignElementSelection(target.selection);
    if (target.selection !== undefined && !selection) return undefined;
    seen.add(target.mediaId);
    targets.push({
      mediaId: target.mediaId,
      artifactId: target.artifactId,
      ...(selection ? { selection } : {}),
    });
  }
  return { version: DESIGN_TURN_CONTEXT_VERSION, targets };
}

export function designSelectionDisplayLabel(selection: DesignElementSelectionV1): string {
  const tag =
    selection.tagName === "a"
      ? "Link"
      : `${selection.tagName[0]?.toUpperCase() ?? ""}${selection.tagName.slice(1)}`;
  return `${tag} · ${selection.label}`;
}

export interface DesignWorkspaceArtifactEntry {
  artifact: ChatHtmlArtifactV1;
  source: "persisted" | "live";
}

export interface DesignWorkspaceArtifactGroup {
  id: string;
  title: string;
  revisions: DesignWorkspaceArtifactEntry[];
}

export interface DesignWorkspaceMissingScreen {
  id: string;
  lineageId?: string;
  activeMediaId?: string;
  artifactMediaIds: readonly string[];
  x: number;
  y: number;
}

/** Durable Screens remain spatially visible even while every artifact descriptor is unavailable. */
export function missingDurableDesignWorkspaceScreens(
  project: DesignProjectSnapshotV1 | undefined,
  entries: readonly DesignWorkspaceArtifactEntry[],
): DesignWorkspaceMissingScreen[] {
  if (!project) return [];
  const available = new Set(entries.map(({ artifact }) => artifact.mediaId));
  return project.canvas.nodes.flatMap((node) => {
    if (node.kind !== "artboard") return [];
    const artifactMediaIds = node.artifactMediaIds ?? [];
    if (artifactMediaIds.some((mediaId) => available.has(mediaId))) return [];
    return [
      {
        id: node.id,
        ...(node.lineageId ? { lineageId: node.lineageId } : {}),
        ...(node.activeMediaId ? { activeMediaId: node.activeMediaId } : {}),
        artifactMediaIds,
        x: node.x,
        y: node.y,
      },
    ];
  });
}

export interface DesignCanvasPosition {
  x: number;
  y: number;
}

/** Preserve a live node's position when publication replaces its provisional node identity. */
export function resolveDesignArtboardPosition(input: {
  groupId: string;
  revisionMediaIds: readonly string[];
  positionsByNodeId: ReadonlyMap<string, DesignCanvasPosition>;
  positionsByMediaId: ReadonlyMap<string, DesignCanvasPosition>;
  fallback: DesignCanvasPosition;
}): DesignCanvasPosition {
  const exact = input.positionsByNodeId.get(input.groupId);
  if (exact) return exact;
  for (const mediaId of input.revisionMediaIds) {
    const migrated = input.positionsByMediaId.get(mediaId);
    if (migrated) return migrated;
  }
  return input.fallback;
}

/** Serialize canvas writes so an explicit send barrier observes every earlier save. */
export class DesignProjectPersistenceBarrier<T> {
  private inFlight: Promise<T> | undefined;

  async flush(operation: () => Promise<T>): Promise<T> {
    while (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // A failed predecessor must not poison a queued retry. The owner
        // reconciles its state before the queued operation runs.
      }
    }
    const current = operation();
    this.inFlight = current;
    try {
      return await current;
    } finally {
      if (this.inFlight === current) this.inFlight = undefined;
    }
  }
}

export function isDesignHtmlArtifact(artifact: ChatHtmlArtifactV1): boolean {
  return artifact.mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX);
}

/** True only when the authoritative project snapshot owns every optimistic revision. */
export function designProjectClaimsArtifacts(
  project: DesignProjectSnapshotV1,
  artifacts: readonly ChatHtmlArtifactV1[],
): boolean {
  const ownedMediaIds = new Set(
    project.canvas.nodes.flatMap((node) =>
      node.kind === "artboard" ? (node.artifactMediaIds ?? []) : [],
    ),
  );
  return artifacts.every(
    (artifact) => !isDesignHtmlArtifact(artifact) || ownedMediaIds.has(artifact.mediaId),
  );
}

/**
 * Build one chronological revision list. A live same-identity replacement wins
 * over its persisted predecessor without mounting a second preview.
 */
export function designWorkspaceArtifactPlan(
  messages: readonly Pick<ChatMessage, "role" | "htmlArtifacts">[],
  liveArtifacts: readonly ChatHtmlArtifactV1[],
): DesignWorkspaceArtifactEntry[] {
  const liveByMediaId = new Map<string, ChatHtmlArtifactV1>();
  for (const artifact of liveArtifacts) {
    if (isDesignHtmlArtifact(artifact)) liveByMediaId.set(artifact.mediaId, artifact);
  }
  const entries: DesignWorkspaceArtifactEntry[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const artifact of message.htmlArtifacts ?? []) {
      if (!isDesignHtmlArtifact(artifact)) continue;
      const live = liveByMediaId.get(artifact.mediaId);
      entries.push({ artifact: live ?? artifact, source: live ? "live" : "persisted" });
      liveByMediaId.delete(artifact.mediaId);
    }
  }
  for (const artifact of liveArtifacts) {
    if (liveByMediaId.delete(artifact.mediaId)) entries.push({ artifact, source: "live" });
  }
  return entries;
}

/** Same-title artifacts are revisions of one spatial canvas design. */
export function groupDesignWorkspaceArtifacts(
  entries: readonly DesignWorkspaceArtifactEntry[],
): DesignWorkspaceArtifactGroup[] {
  const groups: DesignWorkspaceArtifactGroup[] = [];
  const byTitle = new Map<string, DesignWorkspaceArtifactGroup>();
  for (const entry of entries) {
    let group = byTitle.get(entry.artifact.title);
    if (!group) {
      group = {
        id: `design-artboard:${entry.artifact.mediaId}`,
        title: entry.artifact.title,
        revisions: [],
      };
      byTitle.set(entry.artifact.title, group);
      groups.push(group);
    }
    group.revisions.push(entry);
  }
  return groups;
}

/**
 * Resolve durable project lineage before falling back to legacy title grouping.
 * A main-validated artifact hint bridges the crash-safe gap between transcript
 * commit and the renderer's next canvas revision.
 */
export function durableDesignWorkspaceArtifactGroups(
  project: DesignProjectSnapshotV1 | undefined,
  entries: readonly DesignWorkspaceArtifactEntry[],
): DesignWorkspaceArtifactGroup[] {
  if (!project) return groupDesignWorkspaceArtifacts(entries);
  const byMediaId = new Map(entries.map((entry) => [entry.artifact.mediaId, entry]));
  const claimed = new Set<string>();
  const groupByMediaId = new Map<string, DesignWorkspaceArtifactGroup>();
  const groups: DesignWorkspaceArtifactGroup[] = [];
  for (const node of project.canvas.nodes) {
    if (node.kind !== "artboard" || !node.artifactMediaIds) continue;
    const revisions = node.artifactMediaIds.flatMap((mediaId) => {
      const entry = byMediaId.get(mediaId);
      if (!entry) return [];
      claimed.add(mediaId);
      return [entry];
    });
    if (revisions.length === 0) continue;
    const active = revisions.find(({ artifact }) => artifact.mediaId === node.activeMediaId);
    groups.push({
      id: node.id,
      title: active?.artifact.title ?? revisions[revisions.length - 1]!.artifact.title,
      revisions,
    });
    const group = groups[groups.length - 1]!;
    for (const revision of revisions) groupByMediaId.set(revision.artifact.mediaId, group);
  }
  for (const entry of entries) {
    if (claimed.has(entry.artifact.mediaId)) continue;
    // Persisted Design artifacts become visible only through the main-owned
    // project snapshot. Failed, cancelled, stale-CAS, and crash-orphaned rows
    // may remain in the backing transcript for audit/recovery, but they are not
    // project history. Live entries may render optimistically until main
    // publishes and the renderer refreshes the project revision.
    if (entry.source !== "live") continue;
    const group = entry.artifact.revisionOfMediaId
      ? groupByMediaId.get(entry.artifact.revisionOfMediaId)
      : undefined;
    if (group) {
      group.revisions.push(entry);
      claimed.add(entry.artifact.mediaId);
      groupByMediaId.set(entry.artifact.mediaId, group);
      continue;
    }
    // Legacy artifacts have no immutable lineage fact. Never infer one from a
    // mutable title; unmatched output starts as its own durable artboard.
    const created = {
      id: `design-artboard:${entry.artifact.id}`,
      title: entry.artifact.title,
      revisions: [entry],
    };
    groups.push(created);
    groupByMediaId.set(entry.artifact.mediaId, created);
  }
  return groups;
}

/** Follow new revisions until the user deliberately pins an older one. */
export function resolveDesignWorkspaceSelection(
  selectedMediaId: string | null,
  previousLatestMediaId: string | null,
  entries: readonly DesignWorkspaceArtifactEntry[],
): string | null {
  const latest = entries[entries.length - 1]?.artifact.mediaId ?? null;
  if (!selectedMediaId || selectedMediaId === previousLatestMediaId) return latest;
  return entries.some((entry) => entry.artifact.mediaId === selectedMediaId)
    ? selectedMediaId
    : latest;
}

/** Preserve main-owned active identity unless a requested replacement belongs to the lineage. */
export function resolveDurableDesignActiveMediaId({
  artifactMediaIds,
  priorActiveMediaId,
  requestedActiveMediaId,
}: {
  artifactMediaIds: readonly string[] | undefined;
  priorActiveMediaId: string | undefined;
  requestedActiveMediaId: string | undefined;
}): string | undefined {
  if (requestedActiveMediaId && artifactMediaIds?.includes(requestedActiveMediaId)) {
    return requestedActiveMediaId;
  }
  return priorActiveMediaId;
}
