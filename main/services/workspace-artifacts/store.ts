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
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactRefreshV1,
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

function emptyArtifacts(): WorkspaceArtifactsDocument {
  return { version: 1, artifacts: [] };
}

function emptySnapshots(): WorkspaceArtifactSnapshotsDocument {
  return { version: 1, snapshots: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  /** The person approved these commands (the chat approval card under Ask). */
  approved?: boolean;
  chatId?: string;
}

export interface WorkspaceArtifactStoreOptions {
  /** Directory holding the per-workspace files; defaults to `<userData>/workspace-artifacts`. */
  root?: () => string;
  now?: () => number;
  newId?: () => string;
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
  private readonly root: () => string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: WorkspaceArtifactStoreOptions = {}) {
    this.root =
      options.root ??
      (() => {
        throw new Error("WorkspaceArtifactStore needs a root directory.");
      });
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
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
      if (draft.artifacts.some((artifact) => artifact.visual.title === content.title)) {
        throw new Error(`An artifact named "${content.title}" already exists here. Update it instead.`);
      }
      const id = requireArtifactId(this.newId());
      const now = this.now();
      const artifact: WorkspaceArtifactV1 = {
        version: 1,
        id,
        workspaceId,
        ...(content.description ? { description: content.description } : {}),
        visual: { ...content.visual, id, title: content.title },
        sources: content.sources,
        actions: content.actions,
        refresh: content.refresh,
        ...(options.approved ? { approvedDigest: workspaceArtifactDigest(content.sources, content.actions) } : {}),
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
    const id = requireArtifactId(artifactId);
    if (!isWorkspaceArtifactTitle(content.title)) throw new Error(TITLE_RULE);
    return this.artifacts(workspaceId).update((draft) => {
      const index = draft.artifacts.findIndex((artifact) => artifact.id === id);
      if (index < 0) notFound();
      if (draft.artifacts.some((artifact) => artifact.id !== id && artifact.visual.title === content.title)) {
        throw new Error(`Another artifact here is already named "${content.title}".`);
      }
      const previous = draft.artifacts[index]!;
      const digest = workspaceArtifactDigest(content.sources, content.actions);
      const approvedDigest = options.approved ? digest : previous.approvedDigest === digest ? digest : undefined;
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
      return checked;
    });
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
    await Promise.all([
      fs.rm(path.join(root, `${id}.json`), { force: true }),
      fs.rm(path.join(root, `${id}.snapshots.json`), { force: true }),
    ]);
  }
}
