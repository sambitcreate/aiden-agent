import type { ChatMessage } from "../lib/types";
import type { ChatHtmlArtifactV1 } from "./chat-artifacts";
import type { DesignProjectSnapshotV1 } from "./design-projects";

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

export function isDesignHtmlArtifact(artifact: ChatHtmlArtifactV1): boolean {
  return artifact.mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX);
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
