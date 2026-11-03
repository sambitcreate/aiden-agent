import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DataStore } from "../data-store.js";
import type { ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import {
  isWorkspaceArtifactId,
  isWorkspaceArtifactTitle,
  isWorkspaceArtifactWorkspaceId,
  parseWorkspaceArtifactSnapshotV1,
  parseWorkspaceArtifactV1,
  WORKSPACE_ARTIFACT_LIMITS,
  workspaceArtifactCommandsNeedApproval,
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactRefreshV1,
  type WorkspaceArtifactRevisionSummary,
  type WorkspaceArtifactSnapshotV1,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactSourceV1,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactView,
} from "../../../renderer/shared/workspace-artifacts.js";

/**
 * Device-local storage for workspace artifacts: one definitions file and one
 * snapshot file per workspace under `<userData>/workspace-artifacts/`. Pages
 * change rarely; snapshots change on every refresh, so they are kept apart.
 */

export interface WorkspaceArtifactsDocument {
  version: 1;
  artifacts: WorkspaceArtifactV1[];
  /**
   * Entries this version cannot read (edited by hand, or written under looser
   * limits), kept verbatim rather than lost on the next write.
   */
  unreadable?: unknown[];
}

export interface WorkspaceArtifactSnapshotsDocument {
  version: 1;
  snapshots: Record<string, WorkspaceArtifactSnapshotV1>;
}

const ARTIFACTS_MAX_BYTES = 12 * 1024 * 1024;
const UNREADABLE_LIMIT = WORKSPACE_ARTIFACT_LIMITS.perWorkspace * 2;
const TITLE_RULE = `The artifact title must be 1–${WORKSPACE_ARTIFACT_LIMITS.titleChars} characters on one line.`;
const SNAPSHOTS_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_MAX_BYTES = 24 * 1024 * 1024;

/**
 * One earlier version of a page, as it was before an update replaced it. The
 * approval is deliberately not kept: a restore earns it again unless its
 * commands equal the ones currently approved.
 */
export interface WorkspaceArtifactRevisionV1 {
  revision: number;
  savedAt: number;
  description?: string;
  visual: ChatUiVisualV1;
  sources: WorkspaceArtifactSourceV1[];
  actions: WorkspaceArtifactActionV1[];
  refresh: WorkspaceArtifactRefreshV1;
}

export interface WorkspaceArtifactHistoryDocument {
  version: 1;
  /** Earlier versions by artifact id, oldest first. */
  revisions: Record<string, WorkspaceArtifactRevisionV1[]>;
}

function emptyArtifacts(): WorkspaceArtifactsDocument {
  return { version: 1, artifacts: [] };
}

function emptySnapshots(): WorkspaceArtifactSnapshotsDocument {
  return { version: 1, snapshots: {} };
}

function emptyHistory(): WorkspaceArtifactHistoryDocument {
  return { version: 1, revisions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates one stored earlier version with the same limits as a live page, by
 * reading it back as a full artifact. Anything that does not fit is dropped.
 */
function parseRevision(workspaceId: string, artifactId: string, value: unknown): WorkspaceArtifactRevisionV1 | undefined {
  if (!isRecord(value)) return undefined;
  const savedAt = value.savedAt;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) return undefined;
  const artifact = parseWorkspaceArtifactV1({
    version: 1,
    id: artifactId,
    workspaceId,
    ...(value.description !== undefined ? { description: value.description } : {}),
    visual: value.visual,
    sources: value.sources,
    actions: value.actions,
    refresh: value.refresh,
    revision: value.revision,
    createdAt: savedAt,
    updatedAt: savedAt,
  });
  if (!artifact) return undefined;
  return historyEntryOf(artifact, savedAt);
}

function historyEntryOf(artifact: WorkspaceArtifactV1, savedAt: number): WorkspaceArtifactRevisionV1 {
  return {
    revision: artifact.revision,
    savedAt,
    ...(artifact.description ? { description: artifact.description } : {}),
    visual: artifact.visual,
    sources: artifact.sources,
    actions: artifact.actions,
    refresh: artifact.refresh,
  };
}

export function normalizeWorkspaceArtifactHistoryDocument(workspaceId: string) {
  return (value: unknown): WorkspaceArtifactHistoryDocument => {
    if (!isRecord(value) || !isRecord(value.revisions)) return emptyHistory();
    const revisions: Record<string, WorkspaceArtifactRevisionV1[]> = {};
    for (const [id, entries] of Object.entries(value.revisions).slice(0, WORKSPACE_ARTIFACT_LIMITS.perWorkspace * 2)) {
      if (!isWorkspaceArtifactId(id) || !Array.isArray(entries)) continue;
      const kept: WorkspaceArtifactRevisionV1[] = [];
      for (const entry of entries.slice(-WORKSPACE_ARTIFACT_LIMITS.history)) {
        const revision = parseRevision(workspaceId, id, entry);
        if (revision && !kept.some((other) => other.revision === revision.revision)) kept.push(revision);
      }
      if (kept.length) revisions[id] = kept;
    }
    return { version: 1, revisions };
  };
}

/**
 * Drops the oldest earlier versions, across pages, until the document fits
 * `maxBytes`, so recording history never fails a write for its size.
 */
function trimHistoryToFit(draft: WorkspaceArtifactHistoryDocument, maxBytes: number): void {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  // Measured once; each removal subtracts exactly what it takes out of the
  // compact JSON. The +1 is the trailing newline the store writes.
  let size = bytes(draft) + 1;
  while (size > maxBytes) {
    let oldest: { id: string; savedAt: number } | undefined;
    for (const [id, entries] of Object.entries(draft.revisions)) {
      const first = entries[0];
      if (first && (!oldest || first.savedAt < oldest.savedAt)) oldest = { id, savedAt: first.savedAt };
    }
    if (!oldest) return;
    const entries = draft.revisions[oldest.id]!;
    // The entry, plus the comma that separated it from the next one.
    size -= bytes(entries.shift()) + (entries.length > 0 ? 1 : 0);
    if (entries.length === 0) {
      const keys = Object.keys(draft.revisions).length;
      // `"id":[]`, plus its separating comma when other pages remain.
      size -= bytes(oldest.id) + 3 + (keys > 1 ? 1 : 0);
      delete draft.revisions[oldest.id];
    }
  }
}

export function normalizeWorkspaceArtifactsDocument(workspaceId: string) {
  return (value: unknown): WorkspaceArtifactsDocument => {
    if (!isRecord(value) || !Array.isArray(value.artifacts)) return emptyArtifacts();
    const seen = new Set<string>();
    const artifacts: WorkspaceArtifactV1[] = [];
    const unreadable: unknown[] = Array.isArray(value.unreadable) ? value.unreadable.slice(0, UNREADABLE_LIMIT) : [];
    for (const entry of value.artifacts) {
      const artifact = parseWorkspaceArtifactV1(entry);
      if (artifact && seen.has(artifact.id)) continue;
      if (!artifact || artifact.workspaceId !== workspaceId || artifacts.length >= WORKSPACE_ARTIFACT_LIMITS.perWorkspace) {
        if (unreadable.length < UNREADABLE_LIMIT) unreadable.push(entry);
        continue;
      }
      seen.add(artifact.id);
      artifacts.push(artifact);
    }
    return { version: 1, artifacts, ...(unreadable.length ? { unreadable } : {}) };
  };
}

export function normalizeWorkspaceArtifactSnapshotsDocument(value: unknown): WorkspaceArtifactSnapshotsDocument {
  if (!isRecord(value) || !isRecord(value.snapshots)) return emptySnapshots();
  const snapshots: Record<string, WorkspaceArtifactSnapshotV1> = {};
  for (const [id, entry] of Object.entries(value.snapshots).slice(0, WORKSPACE_ARTIFACT_LIMITS.perWorkspace * 2)) {
    if (!isWorkspaceArtifactId(id)) continue;
    const snapshot = parseWorkspaceArtifactSnapshotV1(entry);
    if (snapshot) snapshots[id] = snapshot;
  }
  return { version: 1, snapshots };
}

/** What an approval covers: every command the artifact can run, exactly as written. */
export function workspaceArtifactDigest(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): string {
  return createHash("sha256").update(JSON.stringify({ sources, actions })).digest("hex");
}

export interface WorkspaceArtifactContent {
  title: string;
  description?: string;
  /** Compiled page; its id and title are replaced by the store. */
  visual: ChatUiVisualV1;
  sources: WorkspaceArtifactSourceV1[];
  actions: WorkspaceArtifactActionV1[];
  refresh: WorkspaceArtifactRefreshV1;
}

export interface WorkspaceArtifactWriteOptions {
  /**
   * The command digest an approval card the person allowed showed. It
   * approves the save only when it equals the digest of the commands saved,
   * checked inside the write.
   */
  approvedDigest?: string;
  chatId?: string;
  /**
   * Create only: a title another page here already has becomes the first free
   * "Title (2)", "Title (3)"… instead of failing, as an import needs.
   */
  uniqueTitle?: boolean;
}

/** `title`, or the first "Title (n)" no page in `taken` has, within the title limit. */
export function freeWorkspaceArtifactTitle(title: string, taken: ReadonlySet<string>): string {
  if (!taken.has(title)) return title;
  for (let index = 2; index <= taken.size + 1; index += 1) {
    const suffix = ` (${index})`;
    let base = Array.from(title);
    while (base.join("").length + suffix.length > WORKSPACE_ARTIFACT_LIMITS.titleChars) base = base.slice(0, -1);
    const candidate = `${base.join("").trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable: n titles always leave one of n + 1 candidates free.
  throw new Error(`An artifact named "${title}" already exists here.`);
}

/** Thrown inside a history write whose workspace was removed, so nothing is written. */
class HistoryDetachedError extends Error {}

export interface WorkspaceArtifactStoreOptions {
  /** Directory holding the per-workspace files; defaults to `<userData>/workspace-artifacts`. */
  root?: () => string;
  now?: () => number;
  newId?: () => string;
  /** Size cap of one workspace's history file; the oldest versions go first. */
  historyMaxBytes?: number;
  /**
   * Reports a failure to record an earlier version. The page itself is saved
   * by then, so the update still succeeds.
   */
  onHistoryError?: (error: unknown) => void;
}

function requireWorkspaceId(value: string): string {
  if (!isWorkspaceArtifactWorkspaceId(value)) throw new Error("The workspace identifier is invalid.");
  return value;
}

function requireArtifactId(value: string): string {
  if (!isWorkspaceArtifactId(value)) throw new Error("The artifact identifier is invalid.");
  return value;
}

function notFound(): never {
  throw new Error("That artifact no longer exists in this workspace.");
}

export class WorkspaceArtifactStore {
  private readonly artifactStores = new Map<string, DataStore<WorkspaceArtifactsDocument>>();
  private readonly snapshotStores = new Map<string, DataStore<WorkspaceArtifactSnapshotsDocument>>();
  private readonly historyStores = new Map<string, DataStore<WorkspaceArtifactHistoryDocument>>();
  private readonly root: () => string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly historyMaxBytes: number;
  private readonly onHistoryError: (error: unknown) => void;

  constructor(options: WorkspaceArtifactStoreOptions = {}) {
    this.root =
      options.root ??
      (() => {
        throw new Error("WorkspaceArtifactStore needs a root directory.");
      });
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.historyMaxBytes = options.historyMaxBytes ?? HISTORY_MAX_BYTES;
    // The Electron binding (main.ts) logs it; stores built without one (tests) ignore it.
    this.onHistoryError = options.onHistoryError ?? (() => undefined);
  }

  private artifacts(workspaceId: string): DataStore<WorkspaceArtifactsDocument> {
    const id = requireWorkspaceId(workspaceId);
    let store = this.artifactStores.get(id);
    if (!store) {
      store = new DataStore<WorkspaceArtifactsDocument>(`${id}.json`, emptyArtifacts(), this.root, {
        maxBytes: ARTIFACTS_MAX_BYTES,
        fileMode: 0o600,
        compact: true,
        normalize: normalizeWorkspaceArtifactsDocument(id),
      });
      this.artifactStores.set(id, store);
    }
    return store;
  }

  private snapshots(workspaceId: string): DataStore<WorkspaceArtifactSnapshotsDocument> {
    const id = requireWorkspaceId(workspaceId);
    let store = this.snapshotStores.get(id);
    if (!store) {
      // Snapshots are a regenerable cache: a bad file is replaced, not rescued.
      store = new DataStore<WorkspaceArtifactSnapshotsDocument>(`${id}.snapshots.json`, emptySnapshots(), this.root, {
        maxBytes: SNAPSHOTS_MAX_BYTES,
        fileMode: 0o600,
        compact: true,
        preserveCorruptFile: false,
        normalize: normalizeWorkspaceArtifactSnapshotsDocument,
      });
      this.snapshotStores.set(id, store);
    }
    return store;
  }

  private historyStore(workspaceId: string): DataStore<WorkspaceArtifactHistoryDocument> {
    const id = requireWorkspaceId(workspaceId);
    let store = this.historyStores.get(id);
    if (!store) {
      // History is a convenience: a bad file is replaced, not rescued.
      store = new DataStore<WorkspaceArtifactHistoryDocument>(`${id}.history.json`, emptyHistory(), this.root, {
        maxBytes: this.historyMaxBytes,
        fileMode: 0o600,
        compact: true,
        preserveCorruptFile: false,
        normalize: normalizeWorkspaceArtifactHistoryDocument(id),
      });
      this.historyStores.set(id, store);
    }
    return store;
  }

  /** Keeps the version an update replaced; never fails the update that called it. */
  private async recordRevision(
    workspaceId: string,
    pages: DataStore<WorkspaceArtifactsDocument>,
    previous: WorkspaceArtifactV1,
  ): Promise<void> {
    const history = this.historyStore(workspaceId);
    try {
      await history.update(async (draft) => {
        // A workspace removed meanwhile must not get its history file back.
        if (this.artifactStores.get(workspaceId) !== pages || this.historyStores.get(workspaceId) !== history) {
          throw new HistoryDetachedError();
        }
        // Pages deleted meanwhile (their delete may have run first) keep no history.
        const live = new Set((await pages.load()).artifacts.map((artifact) => artifact.id));
        for (const id of Object.keys(draft.revisions)) {
          if (!live.has(id)) delete draft.revisions[id];
        }
        if (!live.has(previous.id)) return;
        const entries = (draft.revisions[previous.id] ?? []).filter((entry) => entry.revision !== previous.revision);
        entries.push(historyEntryOf(previous, this.now()));
        entries.sort((a, b) => a.revision - b.revision);
        draft.revisions[previous.id] = entries.slice(-WORKSPACE_ARTIFACT_LIMITS.history);
        trimHistoryToFit(draft, this.historyMaxBytes);
      });
    } catch (error) {
      if (!(error instanceof HistoryDetachedError)) this.onHistoryError(error);
    }
  }

  /** The earlier versions kept for a page, newest first. */
  async history(workspaceId: string, artifactId: string): Promise<WorkspaceArtifactRevisionSummary[]> {
    const id = requireArtifactId(artifactId);
    const [view, { revisions }] = await Promise.all([this.get(workspaceId, id), this.historyStore(workspaceId).load()]);
    if (!view) notFound();
    return (revisions[id] ?? [])
      .map((entry) => ({
        revision: entry.revision,
        savedAt: entry.savedAt,
        title: entry.visual.title,
        needsApproval: workspaceArtifactCommandsNeedApproval(
          entry.sources,
          entry.actions,
          workspaceArtifactDigest(entry.sources, entry.actions),
          view.artifact.approvedDigest,
        ),
      }))
      .reverse();
  }

  /** Every page's kept revision numbers, newest first, for pages that have any. */
  async earlierRevisions(workspaceId: string): Promise<Record<string, number[]>> {
    const { revisions } = await this.historyStore(workspaceId).load();
    const result: Record<string, number[]> = {};
    for (const [id, entries] of Object.entries(revisions)) {
      if (entries.length) result[id] = entries.map((entry) => entry.revision).reverse();
    }
    return result;
  }

  /** One kept earlier version, or undefined once it has been dropped. */
  async revision(workspaceId: string, artifactId: string, revision: number): Promise<WorkspaceArtifactRevisionV1 | undefined> {
    const id = requireArtifactId(artifactId);
    const { revisions } = await this.historyStore(workspaceId).load();
    return revisions[id]?.find((entry) => entry.revision === revision);
  }

  /**
   * Brings back an earlier version as a new revision, through the same rules
   * as an update: the current version becomes undoable in turn, and an
   * approval carries over only for the exact commands already approved. The
   * page keeps its current name.
   */
  async restore(
    workspaceId: string,
    artifactId: string,
    revision: number,
    options: WorkspaceArtifactWriteOptions = {},
  ): Promise<WorkspaceArtifactV1> {
    const id = requireArtifactId(artifactId);
    const entry = await this.revision(workspaceId, id, revision);
    if (!entry) throw new Error(`Revision ${revision} of this artifact is no longer kept.`);
    return this.replaceWith(
      workspaceId,
      id,
      (previous) => ({
        title: previous.visual.title,
        ...(entry.description ? { description: entry.description } : {}),
        visual: entry.visual,
        sources: entry.sources,
        actions: entry.actions,
        refresh: entry.refresh,
      }),
      options,
    );
  }

  async list(workspaceId: string): Promise<WorkspaceArtifactView[]> {
    const [{ artifacts }, { snapshots }] = await Promise.all([
      this.artifacts(workspaceId).load(),
      this.snapshots(workspaceId).load(),
    ]);
    return artifacts.map((artifact) => {
      const snapshot = snapshots[artifact.id];
      const digest = workspaceArtifactDigest(artifact.sources, artifact.actions);
      return snapshot ? { artifact, snapshot, digest } : { artifact, digest };
    });
  }

  async get(workspaceId: string, artifactId: string): Promise<WorkspaceArtifactView | undefined> {
    const id = requireArtifactId(artifactId);
    return (await this.list(workspaceId)).find((view) => view.artifact.id === id);
  }

  async create(
    workspaceId: string,
    content: WorkspaceArtifactContent,
    options: WorkspaceArtifactWriteOptions = {},
  ): Promise<WorkspaceArtifactV1> {
    if (!isWorkspaceArtifactTitle(content.title)) throw new Error(TITLE_RULE);
    return this.artifacts(workspaceId).update((draft) => {
      if (draft.artifacts.length >= WORKSPACE_ARTIFACT_LIMITS.perWorkspace) {
        throw new Error(
          `This workspace already has ${WORKSPACE_ARTIFACT_LIMITS.perWorkspace} artifacts. Update or delete one first.`,
        );
      }
      const title = options.uniqueTitle
        ? freeWorkspaceArtifactTitle(content.title, new Set(draft.artifacts.map((artifact) => artifact.visual.title)))
        : content.title;
      if (draft.artifacts.some((artifact) => artifact.visual.title === title)) {
        throw new Error(`An artifact named "${title}" already exists here. Update it instead.`);
      }
      const id = requireArtifactId(this.newId());
      const now = this.now();
      const artifact: WorkspaceArtifactV1 = {
        version: 1,
        id,
        workspaceId,
        ...(content.description ? { description: content.description } : {}),
        visual: { ...content.visual, id, title },
        sources: content.sources,
        actions: content.actions,
        refresh: content.refresh,
        ...(options.approvedDigest !== undefined &&
        options.approvedDigest === workspaceArtifactDigest(content.sources, content.actions)
          ? { approvedDigest: options.approvedDigest }
          : {}),
        ...(options.chatId ? { createdByChatId: options.chatId } : {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const checked = parseWorkspaceArtifactV1(artifact);
      if (!checked) throw new Error("The artifact could not be saved because its page is too large or invalid.");
      draft.artifacts.push(checked);
      return checked;
    });
  }

  /** Replaces the page and everything it runs; a changed command needs a fresh approval. */
  async replace(
    workspaceId: string,
    artifactId: string,
    content: WorkspaceArtifactContent,
    options: WorkspaceArtifactWriteOptions = {},
  ): Promise<WorkspaceArtifactV1> {
    return this.replaceWith(workspaceId, artifactId, () => content, options);
  }

  /**
   * Replaces a page with content derived from its current version, then keeps
   * that version in the page's history.
   */
  private async replaceWith(
    workspaceId: string,
    artifactId: string,
    contentFor: (previous: WorkspaceArtifactV1) => WorkspaceArtifactContent,
    options: WorkspaceArtifactWriteOptions,
  ): Promise<WorkspaceArtifactV1> {
    const id = requireArtifactId(artifactId);
    const pages = this.artifacts(workspaceId);
    const { saved, replaced } = await pages.update((draft) => {
      const index = draft.artifacts.findIndex((artifact) => artifact.id === id);
      if (index < 0) notFound();
      const previous = draft.artifacts[index]!;
      const content = contentFor(previous);
      if (!isWorkspaceArtifactTitle(content.title)) throw new Error(TITLE_RULE);
      if (draft.artifacts.some((artifact) => artifact.id !== id && artifact.visual.title === content.title)) {
        throw new Error(`Another artifact here is already named "${content.title}".`);
      }
      const digest = workspaceArtifactDigest(content.sources, content.actions);
      // Only a card that showed exactly these commands approves them;
      // otherwise an unchanged set keeps the approval it had.
      const approvedDigest =
        options.approvedDigest === digest || previous.approvedDigest === digest ? digest : undefined;
      const next: WorkspaceArtifactV1 = {
        version: 1,
        id,
        workspaceId,
        ...(content.description ? { description: content.description } : {}),
        visual: { ...content.visual, id, title: content.title },
        sources: content.sources,
        actions: content.actions,
        refresh: content.refresh,
        ...(approvedDigest ? { approvedDigest } : {}),
        ...(previous.createdByChatId ? { createdByChatId: previous.createdByChatId } : {}),
        revision: previous.revision + 1,
        createdAt: previous.createdAt,
        updatedAt: this.now(),
      };
      const checked = parseWorkspaceArtifactV1(next);
      if (!checked) throw new Error("The artifact could not be saved because its page is too large or invalid.");
      draft.artifacts[index] = checked;
      return { saved: checked, replaced: structuredClone(previous) };
    });
    await this.recordRevision(workspaceId, pages, replaced);
    return saved;
  }

  async rename(workspaceId: string, artifactId: string, title: string): Promise<WorkspaceArtifactV1> {
    const id = requireArtifactId(artifactId);
    const trimmed = title.trim();
    if (!isWorkspaceArtifactTitle(trimmed)) throw new Error(TITLE_RULE);
    return this.artifacts(workspaceId).update((draft) => {
      const artifact = draft.artifacts.find((entry) => entry.id === id) ?? notFound();
      if (draft.artifacts.some((entry) => entry.id !== id && entry.visual.title === trimmed)) {
        throw new Error(`Another artifact here is already named "${trimmed}".`);
      }
      artifact.visual = { ...artifact.visual, title: trimmed };
      artifact.updatedAt = this.now();
      return artifact;
    });
  }

  /** Records the person's approval, but only for the exact commands they saw. */
  async approve(workspaceId: string, artifactId: string, digest: string): Promise<WorkspaceArtifactV1> {
    const id = requireArtifactId(artifactId);
    return this.artifacts(workspaceId).update((draft) => {
      const artifact = draft.artifacts.find((entry) => entry.id === id) ?? notFound();
      if (workspaceArtifactDigest(artifact.sources, artifact.actions) !== digest) {
        throw new Error("This artifact changed after you looked at it. Review its commands again.");
      }
      artifact.approvedDigest = digest;
      return artifact;
    });
  }

  async saveState(workspaceId: string, artifactId: string, state: Record<string, unknown>): Promise<void> {
    const id = requireArtifactId(artifactId);
    await this.artifacts(workspaceId).update((draft) => {
      const artifact = draft.artifacts.find((entry) => entry.id === id) ?? notFound();
      const next = parseWorkspaceArtifactV1({ ...artifact, visual: { ...artifact.visual, state } });
      if (!next) throw new Error("The artifact's state is too large or uses a reserved key name.");
      artifact.visual = next.visual;
    });
  }

  async delete(workspaceId: string, artifactId: string): Promise<boolean> {
    const id = requireArtifactId(artifactId);
    const removed = await this.artifacts(workspaceId).update((draft) => {
      const before = draft.artifacts.length;
      draft.artifacts = draft.artifacts.filter((artifact) => artifact.id !== id);
      return draft.artifacts.length !== before;
    });
    await this.snapshots(workspaceId).update((draft) => {
      delete draft.snapshots[id];
    });
    // History is a convenience: failing to forget it never fails the delete,
    // and a later history write prunes ids that are no longer pages.
    try {
      await this.historyStore(workspaceId).update((draft) => {
        delete draft.revisions[id];
      });
    } catch (error) {
      this.onHistoryError(error);
    }
    return removed;
  }

  /**
   * Merges one refresh into the saved snapshot. A failing source keeps its
   * last good data; sources the artifact no longer declares are dropped.
   */
  async saveSnapshot(
    workspaceId: string,
    artifact: Pick<WorkspaceArtifactV1, "id" | "revision" | "sources">,
    results: Record<string, WorkspaceArtifactSourceResultV1>,
  ): Promise<WorkspaceArtifactSnapshotV1> {
    const id = requireArtifactId(artifact.id);
    return this.snapshots(workspaceId).update((draft) => {
      const previous = draft.snapshots[id];
      const sources: Record<string, WorkspaceArtifactSourceResultV1> = {};
      for (const source of artifact.sources) {
        const result = results[source.name];
        const before = previous?.sources[source.name];
        if (!result) {
          if (before) sources[source.name] = before;
          continue;
        }
        if (result.status === "ok") {
          sources[source.name] = result;
          continue;
        }
        sources[source.name] = {
          ...result,
          ...(before?.dataJson !== undefined && result.dataJson === undefined ? { dataJson: before.dataJson } : {}),
        };
      }
      const snapshot: WorkspaceArtifactSnapshotV1 = { revision: artifact.revision, refreshedAt: this.now(), sources };
      draft.snapshots[id] = snapshot;
      return snapshot;
    });
  }

  /** Forgets every artifact of a workspace that no longer exists. */
  async removeWorkspace(workspaceId: string): Promise<void> {
    const id = requireWorkspaceId(workspaceId);
    const root = this.root();
    this.artifactStores.delete(id);
    this.snapshotStores.delete(id);
    const history = this.historyStores.get(id);
    this.historyStores.delete(id);
    // Waits out a history write already queued; queued ones see the store
    // detached and write nothing, so the file is not recreated after the rm.
    await history
      ?.update(() => {
        throw new HistoryDetachedError();
      })
      .catch(() => undefined);
    await Promise.all([
      fs.rm(path.join(root, `${id}.json`), { force: true }),
      fs.rm(path.join(root, `${id}.snapshots.json`), { force: true }),
      fs.rm(path.join(root, `${id}.history.json`), { force: true }),
    ]);
  }
}
