import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DataStore } from "./data-store.js";
import {
  DESIGN_PROJECT_SNAPSHOT_VERSION,
  MAX_DESIGN_PROJECTS,
  MAX_DESIGN_PROJECT_STORE_BYTES,
  emptyDesignProjectDatabase,
  isDesignProjectOpaqueId,
  normalizeDesignProjectTitle,
  parseDesignProjectDatabaseV1,
  parseDesignProjectSnapshotV1,
  type DesignProjectCanvasV1,
  type DesignProjectDatabaseV1,
  type DesignProjectConnectionState,
  type DesignProjectSnapshotV1,
} from "./design-project-contract.js";
import {
  generatedDesignNodeId,
  type OwnedDesignGeneratedRevisionV1,
} from "./design-generated-revision-contract.js";

const STORE_FILE = "design-projects.json";
const LEGACY_ARTIFACT_PREFIX = "design:";
const LEGACY_ARTBOARD_WIDTH = 1_200;
const LEGACY_ARTBOARD_GAP = 120;

export class DesignProjectUnavailableError extends Error {
  constructor(message = "Design Project storage is unavailable.") {
    super(message);
    this.name = "DesignProjectUnavailableError";
  }
}

export class DesignProjectNotFoundError extends Error {
  constructor() {
    super("Design Project was not found.");
    this.name = "DesignProjectNotFoundError";
  }
}

export class DesignProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignProjectConflictError";
  }
}

export class DesignProjectRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Design Project changed since it was opened.");
    this.name = "DesignProjectRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class DesignProjectMigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignProjectMigrationBlockedError";
  }
}

/**
 * The project file may contain the requested row, but a failed fresh read made
 * that publication impossible to classify. Callers must retain any prepared
 * backing data for startup recovery instead of deleting a possibly live owner.
 */
export class DesignProjectPublicationUncertainError extends Error {
  constructor(cause: unknown) {
    super("Design Project publication could not be reconciled safely.");
    this.name = "DesignProjectPublicationUncertainError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface DesignProjectSummaryV1 {
  id: string;
  revision: number;
  title: string;
  chatId: string;
  workspaceId?: string;
  connectionState: DesignProjectConnectionState;
  createdAt: number;
  updatedAt: number;
  artboardCount: number;
  referenceCount: number;
}

export interface CreateDesignProjectInput {
  chatId: string;
  title: string;
  connectionState: DesignProjectConnectionState;
  workspaceId?: string;
  canvas?: DesignProjectCanvasV1;
  referenceAssetIds?: readonly string[];
  designSystemBinding?: DesignProjectSnapshotV1["designSystemBinding"];
  previewScriptId?: string;
}

export interface UpdateDesignProjectInput {
  id: string;
  expectedRevision: number;
  connectionState: DesignProjectConnectionState;
  workspaceId?: string;
  canvas: DesignProjectCanvasV1;
  referenceAssetIds: readonly string[];
  designSystemBinding?: DesignProjectSnapshotV1["designSystemBinding"];
  previewScriptId?: string;
}

export interface ConnectDesignProjectInput {
  id: string;
  expectedRevision: number;
  workspaceId: string;
}

export interface PublishDesignGeneratedRevisionsInput {
  projectId: string;
  chatId: string;
  revisions: readonly OwnedDesignGeneratedRevisionV1[];
}

export interface RemoveMissingGeneratedArtboardInput {
  projectId: string;
  expectedRevision: number;
  lineageId: string;
  activeMediaId: string;
}

export interface RemoveMissingGeneratedRevisionInput {
  projectId: string;
  expectedRevision: number;
  lineageId: string;
  missingMediaId: string;
  expectedActiveMediaId: string;
}

export interface RemoveMissingReferenceAssetInput {
  projectId: string;
  expectedRevision: number;
  assetId: string;
}

export type DesignProjectDeletePublicationState = "deleted" | "present" | "uncertain";

export interface LegacyDesignArtifactFact {
  mediaId: string;
}

export interface LegacyDesignChatFacts {
  chatId: string;
  title: string;
  connectionState: DesignProjectConnectionState;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
  isDesignChat: boolean;
  artifactState: "available" | "corrupt";
  /** Chronological, committed artifacts only. */
  committedArtifacts: readonly LegacyDesignArtifactFact[];
}

export interface LegacyDesignProjectSource {
  loadDesignChatFacts(chatId: string): Promise<LegacyDesignChatFacts | undefined>;
}

export interface DesignProjectDuplicateMapping {
  from: string;
  to: string;
}

export interface PreparedDesignProjectDuplicate {
  targetChatId: string;
  artifactMediaIds: readonly DesignProjectDuplicateMapping[];
  referenceAssetIds: readonly DesignProjectDuplicateMapping[];
  rollback(): Promise<void>;
}

export interface DesignProjectDuplicatePort {
  /**
   * Prepare chat, artifact, and immutable asset copies before the project row
   * becomes visible. The returned rollback must remove only this preparation.
   */
  prepareDuplicate(input: {
    source: DesignProjectSnapshotV1;
    targetProjectId: string;
    targetTitle: string;
  }): Promise<PreparedDesignProjectDuplicate>;
}

export interface DesignProjectCascadeFacts {
  commentIds?: readonly string[];
  designerActionIds?: readonly string[];
}

export interface DesignProjectCascadePlanner {
  inspect(snapshot: DesignProjectSnapshotV1): Promise<DesignProjectCascadeFacts>;
}

export interface DesignProjectDeletePlanV1 {
  version: 1;
  projectId: string;
  expectedRevision: number;
  expectedDatabaseRevision: number;
  chatId: string;
  artifactMediaIds: string[];
  detachedReferenceAssetIds: string[];
  unreferencedReferenceAssetIds: string[];
  commentIds: string[];
  designerActionIds: string[];
}

export interface DesignProjectStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  mintProjectId?: () => string;
  dataStore?: DataStore<DesignProjectDatabaseV1>;
  legacySource?: LegacyDesignProjectSource;
  duplicatePort?: DesignProjectDuplicatePort;
  cascadePlanner?: DesignProjectCascadePlanner;
}

function createDataStore(options: DesignProjectStoreOptions): DataStore<DesignProjectDatabaseV1> {
  return new DataStore(options.filename ?? STORE_FILE, emptyDesignProjectDatabase(), options.root, {
    maxBytes: MAX_DESIGN_PROJECT_STORE_BYTES,
    fileMode: 0o600,
    normalize: (value) => parseDesignProjectDatabaseV1(value) ?? emptyDesignProjectDatabase(),
    isSafe: (value) => parseDesignProjectDatabaseV1(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
    rejectExternalChanges: true,
    reloadBeforeWrite: true,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function monotonicTimestamp(now: () => number, previous = -1): number {
  const current = Math.floor(now());
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Design Project clock returned an invalid timestamp.");
  }
  return Math.max(current, previous + 1);
}

function requireIdentity(value: unknown, label: string): string {
  if (!isDesignProjectOpaqueId(value)) throw new Error(`Invalid Design Project ${label}.`);
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid Design Project revision.");
  }
  return value as number;
}

function requireTitle(value: unknown): string {
  const title = normalizeDesignProjectTitle(value);
  if (!title) throw new Error("Invalid Design Project title.");
  return title;
}

function requireSnapshot(value: unknown): DesignProjectSnapshotV1 {
  const parsed = parseDesignProjectSnapshotV1(value);
  if (!parsed) throw new Error("Invalid Design Project snapshot.");
  return parsed;
}

function requireCurrent(
  database: DesignProjectDatabaseV1,
  id: string,
  expectedRevision: number,
): { index: number; project: DesignProjectSnapshotV1 } {
  const index = database.projects.findIndex((project) => project.id === id);
  const project = database.projects[index];
  if (!project) throw new DesignProjectNotFoundError();
  if (project.revision !== expectedRevision) {
    throw new DesignProjectRevisionConflictError(project.revision);
  }
  return { index, project };
}

function assertImmutableArtboardOwnership(
  current: DesignProjectCanvasV1,
  requested: DesignProjectCanvasV1,
): void {
  const currentArtboards = current.nodes.filter((node) => node.kind === "artboard");
  const requestedArtboards = requested.nodes.filter((node) => node.kind === "artboard");
  if (currentArtboards.length !== requestedArtboards.length) {
    throw new DesignProjectConflictError(
      "Generated artboards can be changed only by a main-owned Design operation.",
    );
  }
  const requestedById = new Map(requestedArtboards.map((node) => [node.id, node]));
  for (const existing of currentArtboards) {
    const next = requestedById.get(existing.id);
    if (
      !next ||
      next.canonicalOrigin !== existing.canonicalOrigin ||
      next.lineageId !== existing.lineageId ||
      JSON.stringify(next.artifactMediaIds) !== JSON.stringify(existing.artifactMediaIds)
    ) {
      throw new DesignProjectConflictError(
        "Generated artboard lineage is immutable outside a main-owned Design operation.",
      );
    }
  }
}

function summary(project: DesignProjectSnapshotV1): DesignProjectSummaryV1 {
  return {
    id: project.id,
    revision: project.revision,
    title: project.title,
    chatId: project.chatId,
    ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
    connectionState: project.connectionState,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    artboardCount: project.canvas.nodes.filter(({ kind }) => kind === "artboard").length,
    referenceCount: project.referenceAssetIds.length,
  };
}

function mappingMap(
  values: readonly DesignProjectDuplicateMapping[],
  expectedSources: ReadonlySet<string>,
  label: string,
  allowIdentity: boolean,
): Map<string, string> {
  const result = new Map<string, string>();
  const targets = new Set<string>();
  for (const value of values) {
    if (
      !value ||
      !isDesignProjectOpaqueId(value.from) ||
      !isDesignProjectOpaqueId(value.to) ||
      !expectedSources.has(value.from) ||
      result.has(value.from) ||
      targets.has(value.to) ||
      (!allowIdentity && value.from === value.to)
    ) {
      throw new Error(`Invalid Design Project ${label} duplicate mapping.`);
    }
    result.set(value.from, value.to);
    targets.add(value.to);
  }
  if (result.size !== expectedSources.size) {
    throw new Error(`Incomplete Design Project ${label} duplicate mapping.`);
  }
  return result;
}

function remappedNodeId(projectId: string, nodeId: string): string {
  return `node:${createHash("sha256").update(`${projectId}\0${nodeId}`).digest("hex")}`;
}

function remappedLineageId(projectId: string, lineageId: string): string {
  return `lineage:${createHash("sha256").update(`${projectId}\0${lineageId}`).digest("hex")}`;
}

function deterministicMigratedProjectId(chatId: string): string {
  return `project:${createHash("sha256").update(`legacy-design-chat\0${chatId}`).digest("hex")}`;
}

function deterministicMigratedNodeId(mediaId: string): string {
  return `node:${createHash("sha256").update(`legacy-design-artboard\0${mediaId}`).digest("hex")}`;
}

function deterministicMigratedLineageId(mediaId: string): string {
  return `lineage:${createHash("sha256").update(`legacy-design-lineage\0${mediaId}`).digest("hex")}`;
}

function migrationTitle(value: string): string {
  const withoutControls = Array.from(value.normalize("NFKC"), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized).slice(0, 160);
  while (characters.length > 0) {
    const candidate = characters.join("");
    const title = normalizeDesignProjectTitle(candidate);
    if (title) return title;
    characters.pop();
  }
  return "Untitled Design";
}

function migratedSnapshot(facts: LegacyDesignChatFacts): DesignProjectSnapshotV1 {
  if (
    !isDesignProjectOpaqueId(facts.chatId) ||
    typeof facts.title !== "string" ||
    facts.title.length > 4_096 ||
    (facts.connectionState !== "prototype-only" && facts.connectionState !== "connected") ||
    (facts.workspaceId !== undefined && !isDesignProjectOpaqueId(facts.workspaceId)) ||
    !Number.isSafeInteger(facts.createdAt) ||
    facts.createdAt < 0 ||
    !Number.isSafeInteger(facts.updatedAt) ||
    facts.updatedAt < facts.createdAt ||
    typeof facts.isDesignChat !== "boolean" ||
    (facts.artifactState !== "available" && facts.artifactState !== "corrupt") ||
    !Array.isArray(facts.committedArtifacts)
  ) {
    throw new DesignProjectMigrationBlockedError("Legacy Design chat facts are invalid.");
  }
  if (facts.artifactState === "corrupt") {
    throw new DesignProjectMigrationBlockedError(
      "Legacy Design artifacts are unreadable; the original store was left untouched.",
    );
  }
  const seenMedia = new Set<string>();
  const artifacts: LegacyDesignArtifactFact[] = [];
  for (const artifact of facts.committedArtifacts) {
    if (
      !artifact ||
      !isDesignProjectOpaqueId(artifact.mediaId) ||
      !artifact.mediaId.startsWith(LEGACY_ARTIFACT_PREFIX) ||
      seenMedia.has(artifact.mediaId)
    ) {
      throw new DesignProjectMigrationBlockedError("Legacy Design artifact facts are invalid.");
    }
    seenMedia.add(artifact.mediaId);
    artifacts.push(artifact);
  }
  if (!facts.isDesignChat && artifacts.length === 0) {
    throw new DesignProjectMigrationBlockedError("The chat is not a legacy Design chat.");
  }
  const createdAt = facts.createdAt;
  const updatedAt = Math.max(facts.updatedAt, createdAt);
  const nodes = artifacts.map((artifact, index) => {
    return {
      id: deterministicMigratedNodeId(artifact.mediaId),
      kind: "artboard" as const,
      canonicalOrigin: "generated-artifact" as const,
      x: index * (LEGACY_ARTBOARD_WIDTH + LEGACY_ARTBOARD_GAP),
      y: 0,
      lineageId: deterministicMigratedLineageId(artifact.mediaId),
      artifactMediaIds: [artifact.mediaId],
      activeMediaId: artifact.mediaId,
    };
  });
  const candidate = {
    version: DESIGN_PROJECT_SNAPSHOT_VERSION,
    id: deterministicMigratedProjectId(facts.chatId),
    revision: 1,
    title: migrationTitle(facts.title),
    chatId: facts.chatId,
    ...(facts.workspaceId === undefined ? {} : { workspaceId: facts.workspaceId }),
    connectionState: facts.connectionState,
    createdAt,
    updatedAt,
    canvas: {
      viewport: "desktop" as const,
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes,
    },
    referenceAssetIds: [],
  };
  // Validate connection/workspace relationships, counts, coordinate bounds, and
  // serialized size through the same path used for every ordinary write.
  const parsed = parseDesignProjectSnapshotV1(candidate);
  if (!parsed) {
    throw new DesignProjectMigrationBlockedError(
      "Legacy Design chat facts cannot produce a safe project snapshot.",
    );
  }
  return parsed;
}

function safeCascadeIds(values: readonly string[] | undefined, label: string): string[] {
  if (!values) return [];
  if (values.length > 10_000) throw new Error(`Design Project ${label} cascade is too large.`);
  const parsed = values.filter(isDesignProjectOpaqueId);
  if (parsed.length !== values.length || new Set(parsed).size !== parsed.length) {
    throw new Error(`Invalid Design Project ${label} cascade.`);
  }
  return [...parsed].sort();
}

export class DesignProjectStore {
  private readonly data: DataStore<DesignProjectDatabaseV1>;
  private readonly now: () => number;
  private readonly mintProjectId: () => string;
  private readonly legacySource: LegacyDesignProjectSource | undefined;
  private readonly duplicatePort: DesignProjectDuplicatePort | undefined;
  private readonly cascadePlanner: DesignProjectCascadePlanner | undefined;
  private initialized = false;
  private unavailableReason: string | null = null;

  constructor(options: DesignProjectStoreOptions = {}) {
    this.data = options.dataStore ?? createDataStore(options);
    this.now = options.now ?? Date.now;
    this.mintProjectId = options.mintProjectId ?? (() => `project:${randomUUID()}`);
    this.legacySource = options.legacySource;
    this.duplicatePort = options.duplicatePort;
    this.cascadePlanner = options.cascadePlanner;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      this.unavailableReason = "Design Project storage is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      this.unavailableReason = "Design Project storage has an unsupported shape.";
    }
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new DesignProjectUnavailableError("Design Project storage is not initialized.");
    }
  }

  private requireAvailable(): void {
    this.requireInitialized();
    if (this.unavailableReason) throw new DesignProjectUnavailableError(this.unavailableReason);
  }

  availability(): { available: true } | { available: false; reason: string } {
    this.requireInitialized();
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  private async reconcilePublishedSnapshot(
    expected: DesignProjectSnapshotV1,
  ): Promise<"installed" | "absent" | "uncertain"> {
    try {
      await this.data.reload();
      if ((await this.data.loadedFromCorruptFile()) || (await this.data.loadedFromUnsafeFile())) {
        return "uncertain";
      }
      const database = await this.data.load();
      const sameIdentity = database.projects.find((project) => project.id === expected.id);
      if (sameIdentity && isDeepStrictEqual(sameIdentity, expected)) return "installed";
      const sameChat = database.projects.find((project) => project.chatId === expected.chatId);
      return sameIdentity || sameChat ? "uncertain" : "absent";
    } catch {
      return "uncertain";
    }
  }

  async list(): Promise<DesignProjectSummaryV1[]> {
    this.requireAvailable();
    return (await this.data.load()).projects
      .map(summary)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<DesignProjectSnapshotV1 | undefined> {
    this.requireAvailable();
    if (!isDesignProjectOpaqueId(id)) return undefined;
    const project = (await this.data.load()).projects.find((candidate) => candidate.id === id);
    return project ? clone(project) : undefined;
  }

  async getByChatId(chatId: string): Promise<DesignProjectSnapshotV1 | undefined> {
    this.requireAvailable();
    if (!isDesignProjectOpaqueId(chatId)) return undefined;
    const project = (await this.data.load()).projects.find(
      (candidate) => candidate.chatId === chatId,
    );
    return project ? clone(project) : undefined;
  }

  async create(input: CreateDesignProjectInput): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const id = requireIdentity(this.mintProjectId(), "identity");
    const timestamp = monotonicTimestamp(this.now);
    const snapshot = requireSnapshot({
      version: DESIGN_PROJECT_SNAPSHOT_VERSION,
      id,
      revision: 1,
      title: requireTitle(input.title),
      chatId: requireIdentity(input.chatId, "chat identity"),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      connectionState: input.connectionState,
      createdAt: timestamp,
      updatedAt: timestamp,
      canvas: input.canvas ?? {
        viewport: "desktop",
        flowViewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
      },
      referenceAssetIds: [...(input.referenceAssetIds ?? [])],
      ...(input.designSystemBinding ? { designSystemBinding: input.designSystemBinding } : {}),
      ...(input.previewScriptId ? { previewScriptId: input.previewScriptId } : {}),
    });
    try {
      return await this.data.update((database) => {
      if (database.projects.length >= MAX_DESIGN_PROJECTS) {
        throw new DesignProjectConflictError("Design Project storage is at capacity.");
      }
      if (database.projects.some((project) => project.id === snapshot.id)) {
        throw new DesignProjectConflictError("Design Project identity was reused.");
      }
      if (database.projects.some((project) => project.chatId === snapshot.chatId)) {
        throw new DesignProjectConflictError("This chat already owns a Design Project.");
      }
      database.projects.push(snapshot);
      database.revision += 1;
      return clone(snapshot);
    });
    } catch (error) {
      if (error instanceof DesignProjectConflictError) throw error;
      const publication = await this.reconcilePublishedSnapshot(snapshot);
      if (publication !== "absent") {
        throw new DesignProjectPublicationUncertainError(error);
      }
      throw error;
    }
  }

  async update(input: UpdateDesignProjectInput): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const id = requireIdentity(input.id, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, id, expectedRevision);
      assertImmutableArtboardOwnership(project.canvas, input.canvas);
      const base: Record<string, unknown> = { ...project };
      delete base.workspaceId;
      delete base.designSystemBinding;
      delete base.previewScriptId;
      const updated = requireSnapshot({
        ...base,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        connectionState: input.connectionState,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        canvas: input.canvas,
        referenceAssetIds: [...input.referenceAssetIds],
        ...(input.designSystemBinding === undefined
          ? {}
          : { designSystemBinding: input.designSystemBinding }),
        ...(input.connectionState === "connected" &&
        (input.previewScriptId ?? project.previewScriptId)
          ? {
              previewScriptId: input.previewScriptId ?? project.previewScriptId,
            }
          : {}),
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  /**
   * Remove one exact generated artboard after a main-owned caller has proven
   * that none of its revision bytes remain usable. Renderer canvas updates are
   * deliberately unable to perform this ownership mutation.
   */
  async removeMissingGeneratedArtboard(
    input: RemoveMissingGeneratedArtboardInput,
  ): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const projectId = requireIdentity(input.projectId, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const lineageId = requireIdentity(input.lineageId, "lineage identity");
    const activeMediaId = requireIdentity(input.activeMediaId, "artifact identity");
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, projectId, expectedRevision);
      const matches = project.canvas.nodes.filter(
        (node) =>
          node.kind === "artboard" &&
          node.canonicalOrigin === "generated-artifact" &&
          node.lineageId === lineageId &&
          node.activeMediaId === activeMediaId &&
          node.artifactMediaIds?.includes(activeMediaId) === true,
      );
      if (matches.length !== 1) {
        throw new DesignProjectConflictError(
          "The missing generated artboard changed before it could be removed.",
        );
      }
      const updated = requireSnapshot({
        ...project,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.filter((node) => node !== matches[0]),
        },
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  /**
   * Prune one exact non-active media identity whose bytes are gone while
   * retaining the lineage's valid active revision and every extant artifact.
   * This is main-only ownership repair; generic canvas updates cannot remove
   * generated history.
   */
  async removeMissingGeneratedRevision(
    input: RemoveMissingGeneratedRevisionInput,
  ): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const projectId = requireIdentity(input.projectId, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const lineageId = requireIdentity(input.lineageId, "lineage identity");
    const missingMediaId = requireIdentity(input.missingMediaId, "missing artifact identity");
    const expectedActiveMediaId = requireIdentity(
      input.expectedActiveMediaId,
      "active artifact identity",
    );
    if (missingMediaId === expectedActiveMediaId) {
      throw new DesignProjectConflictError("An active generated revision cannot be pruned.");
    }
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, projectId, expectedRevision);
      const matches = project.canvas.nodes.filter(
        (node) =>
          node.kind === "artboard" &&
          node.canonicalOrigin === "generated-artifact" &&
          node.lineageId === lineageId &&
          node.activeMediaId === expectedActiveMediaId &&
          node.artifactMediaIds?.includes(expectedActiveMediaId) === true &&
          node.artifactMediaIds.filter((mediaId) => mediaId === missingMediaId).length === 1,
      );
      if (matches.length !== 1) {
        throw new DesignProjectConflictError(
          "The missing generated revision changed before it could be pruned.",
        );
      }
      const target = matches[0]!;
      const updated = requireSnapshot({
        ...project,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.map((node) =>
            node === target
              ? {
                  ...node,
                  artifactMediaIds: node.artifactMediaIds!.filter(
                    (mediaId) => mediaId !== missingMediaId,
                  ),
                }
              : node,
          ),
        },
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  /**
   * Remove every canvas node for one exact missing reference identity. The
   * caller must prove the immutable asset is absent before entering this CAS.
   */
  async removeMissingReferenceAsset(
    input: RemoveMissingReferenceAssetInput,
  ): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const projectId = requireIdentity(input.projectId, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const assetId = requireIdentity(input.assetId, "reference asset identity");
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, projectId, expectedRevision);
      const matches = project.canvas.nodes.filter(
        (node) =>
          node.kind === "reference-image" &&
          node.canonicalOrigin === "reference-asset" &&
          node.assetId === assetId,
      );
      if (matches.length === 0 || !project.referenceAssetIds.includes(assetId)) {
        throw new DesignProjectConflictError(
          "The missing reference image changed before it could be removed.",
        );
      }
      const nodes = project.canvas.nodes.filter((node) => !matches.includes(node));
      const referenceAssetIds = [
        ...new Set(
          nodes.flatMap((node) =>
            node.kind === "reference-image" && node.assetId ? [node.assetId] : [],
          ),
        ),
      ];
      const updated = requireSnapshot({
        ...project,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        canvas: { ...project.canvas, nodes },
        referenceAssetIds,
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  /**
   * Publish immutable generated bytes into their main-owned project lineages.
   * This mutation is semantic-CAS: a revision may advance only while its exact
   * base remains active. Retrying an already-published identity is idempotent
   * and never rolls an artboard back from a newer active revision.
   */
  async publishGeneratedRevisions(
    input: PublishDesignGeneratedRevisionsInput,
  ): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const projectId = requireIdentity(input.projectId, "identity");
    const chatId = requireIdentity(input.chatId, "chat identity");
    if (input.revisions.length === 0) {
      throw new DesignProjectConflictError("No generated Design revisions were provided.");
    }
    const mediaIds = new Set<string>();
    const lineageIds = new Set<string>();
    for (const revision of input.revisions) {
      requireIdentity(revision.mediaId, "artifact identity");
      requireIdentity(revision.ownership.projectId, "artifact project identity");
      requireIdentity(revision.ownership.lineageId, "artifact lineage identity");
      if (
        !revision.mediaId.startsWith(LEGACY_ARTIFACT_PREFIX) ||
        revision.ownership.projectId !== projectId ||
        mediaIds.has(revision.mediaId) ||
        lineageIds.has(revision.ownership.lineageId)
      ) {
        throw new DesignProjectConflictError("Generated Design revision ownership is invalid.");
      }
      if (revision.ownership.kind === "revision") {
        requireIdentity(revision.ownership.baseMediaId, "base artifact identity");
        if (!revision.ownership.baseMediaId.startsWith(LEGACY_ARTIFACT_PREFIX)) {
          throw new DesignProjectConflictError("Generated Design revision base is invalid.");
        }
      }
      mediaIds.add(revision.mediaId);
      lineageIds.add(revision.ownership.lineageId);
    }
    return this.data.update((database) => {
      const index = database.projects.findIndex((project) => project.id === projectId);
      const project = database.projects[index];
      if (!project) throw new DesignProjectNotFoundError();
      if (project.chatId !== chatId) {
        throw new DesignProjectConflictError(
          "Generated Design revisions do not belong to this project chat.",
        );
      }
      for (const revision of input.revisions) {
        const mediaOwner = database.projects.flatMap((candidate) =>
          candidate.canvas.nodes.filter(
            (node) => node.artifactMediaIds?.includes(revision.mediaId) === true,
          ),
        );
        if (mediaOwner.length > 0) {
          const exact = project.canvas.nodes.find(
            (node) =>
              node.kind === "artboard" &&
              node.lineageId === revision.ownership.lineageId &&
              node.artifactMediaIds?.includes(revision.mediaId) === true,
          );
          if (!exact || mediaOwner.length !== 1) {
            throw new DesignProjectConflictError(
              "Generated Design revision identity is already owned elsewhere.",
            );
          }
        }
      }
      let changed = false;
      const nodes = clone(project.canvas.nodes);
      for (const revision of input.revisions) {
        const alreadyPublished = nodes.find(
          (node) =>
            node.kind === "artboard" &&
            node.lineageId === revision.ownership.lineageId &&
            node.artifactMediaIds?.includes(revision.mediaId) === true,
        );
        if (alreadyPublished) continue;
        const lineage = nodes.find(
          (node) => node.kind === "artboard" && node.lineageId === revision.ownership.lineageId,
        );
        if (revision.ownership.kind === "revision") {
          if (
            !lineage ||
            lineage.activeMediaId !== revision.ownership.baseMediaId ||
            lineage.artifactMediaIds?.includes(revision.ownership.baseMediaId) !== true
          ) {
            throw new DesignProjectRevisionConflictError(project.revision);
          }
          lineage.artifactMediaIds = [...(lineage.artifactMediaIds ?? []), revision.mediaId];
          lineage.activeMediaId = revision.mediaId;
          changed = true;
          continue;
        }
        if (lineage) {
          throw new DesignProjectConflictError("Generated Design lineage identity was reused.");
        }
        const artboardIndex = nodes.filter((node) => node.kind === "artboard").length;
        nodes.push({
          id: generatedDesignNodeId(project.id, revision.ownership.lineageId),
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: artboardIndex * (LEGACY_ARTBOARD_WIDTH + LEGACY_ARTBOARD_GAP),
          y: 0,
          lineageId: revision.ownership.lineageId,
          artifactMediaIds: [revision.mediaId],
          activeMediaId: revision.mediaId,
        });
        changed = true;
      }
      if (!changed) return clone(project);
      const updated = requireSnapshot({
        ...project,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        canvas: { ...project.canvas, nodes },
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  /**
   * Convert a Prototype to a Connected App without rewriting its conversation,
   * canvas, immutable artifact history, references, or project identity.
   * Workspace eligibility is intentionally checked by the main-owned
   * connection service immediately before this CAS mutation.
   */
  async connect(input: ConnectDesignProjectInput): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const id = requireIdentity(input.id, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const workspaceId = requireIdentity(input.workspaceId, "workspace identity");
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, id, expectedRevision);
      if (project.connectionState === "connected" && project.workspaceId === workspaceId) {
        throw new DesignProjectConflictError("This Design Project is already connected.");
      }
      if (project.connectionState !== "prototype-only" && project.connectionState !== "connected") {
        throw new DesignProjectConflictError("This Design Project cannot be connected.");
      }
      const base: Record<string, unknown> = { ...project };
      // These records are proven against one exact workspace authority. A
      // rebind preserves prototype history but must not carry any old source
      // capability, preview command, or design-system attachment into W2.
      delete base.designSystemBinding;
      delete base.previewScriptId;
      const connected = requireSnapshot({
        ...base,
        revision: project.revision + 1,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
        connectionState: "connected",
        workspaceId,
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.filter(({ kind }) => kind !== "source-preview"),
        },
      });
      database.projects[index] = connected;
      database.revision += 1;
      return clone(connected);
    });
  }

  async rename(input: {
    id: string;
    expectedRevision: number;
    title: string;
  }): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    const id = requireIdentity(input.id, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const title = requireTitle(input.title);
    return this.data.update((database) => {
      const { index, project } = requireCurrent(database, id, expectedRevision);
      const updated = requireSnapshot({
        ...project,
        revision: project.revision + 1,
        title,
        updatedAt: monotonicTimestamp(this.now, project.updatedAt),
      });
      database.projects[index] = updated;
      database.revision += 1;
      return clone(updated);
    });
  }

  async duplicate(input: {
    id: string;
    expectedRevision: number;
    title?: string;
  }): Promise<DesignProjectSnapshotV1> {
    this.requireAvailable();
    if (!this.duplicatePort) {
      throw new DesignProjectUnavailableError("Design Project duplication is not configured.");
    }
    const id = requireIdentity(input.id, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const source = await this.get(id);
    if (!source) throw new DesignProjectNotFoundError();
    if (source.revision !== expectedRevision) {
      throw new DesignProjectRevisionConflictError(source.revision);
    }
    const targetProjectId = requireIdentity(this.mintProjectId(), "identity");
    const targetTitle = requireTitle(input.title ?? `${source.title} Copy`);
    const prepared = await this.duplicatePort.prepareDuplicate({
      source: clone(source),
      targetProjectId,
      targetTitle,
    });
    let rollback = true;
    try {
      const targetChatId = requireIdentity(prepared.targetChatId, "duplicate chat identity");
      const artifactSources = new Set(
        source.canvas.nodes.flatMap((node) => node.artifactMediaIds ?? []),
      );
      const assetSources = new Set(source.referenceAssetIds);
      const artifactMap = mappingMap(prepared.artifactMediaIds, artifactSources, "artifact", false);
      const assetMap = mappingMap(prepared.referenceAssetIds, assetSources, "asset", true);
      const timestamp = monotonicTimestamp(this.now);
      const duplicate = requireSnapshot({
        ...source,
        id: targetProjectId,
        revision: 1,
        title: targetTitle,
        chatId: targetChatId,
        createdAt: timestamp,
        updatedAt: timestamp,
        canvas: {
          ...source.canvas,
          nodes: source.canvas.nodes.map((node) => ({
            ...node,
            id: remappedNodeId(targetProjectId, node.id),
            ...(node.lineageId
              ? {
                  lineageId: remappedLineageId(targetProjectId, node.lineageId),
                }
              : {}),
            ...(node.artifactMediaIds
              ? {
                  artifactMediaIds: node.artifactMediaIds.map((mediaId) =>
                    artifactMap.get(mediaId),
                  ),
                }
              : {}),
            ...(node.activeMediaId ? { activeMediaId: artifactMap.get(node.activeMediaId) } : {}),
            ...(node.assetId ? { assetId: assetMap.get(node.assetId) } : {}),
          })),
        },
        referenceAssetIds: source.referenceAssetIds.map((assetId) => assetMap.get(assetId)),
      });
      try {
      const installed = await this.data.update((database) => {
        requireCurrent(database, id, expectedRevision);
        if (database.projects.length >= MAX_DESIGN_PROJECTS) {
          throw new DesignProjectConflictError("Design Project storage is at capacity.");
        }
        if (database.projects.some((project) => project.id === duplicate.id)) {
          throw new DesignProjectConflictError("Design Project identity was reused.");
        }
        if (database.projects.some((project) => project.chatId === duplicate.chatId)) {
          throw new DesignProjectConflictError("Duplicate chat already owns a Design Project.");
        }
        database.projects.push(duplicate);
        database.revision += 1;
        return clone(duplicate);
      });
        rollback = false;
      return installed;
      } catch (error) {
        if (
          error instanceof DesignProjectConflictError ||
          error instanceof DesignProjectRevisionConflictError
        ) {
          throw error;
        }
        const publication = await this.reconcilePublishedSnapshot(duplicate);
        if (publication !== "absent") {
          rollback = false;
          throw new DesignProjectPublicationUncertainError(error);
        }
        throw error;
      }
    } finally {
      if (rollback) await prepared.rollback();
    }
  }

  async planDelete(input: {
    id: string;
    expectedRevision: number;
  }): Promise<DesignProjectDeletePlanV1> {
    this.requireAvailable();
    const id = requireIdentity(input.id, "identity");
    const expectedRevision = requireRevision(input.expectedRevision);
    const database = await this.data.load();
    const project = database.projects.find((candidate) => candidate.id === id);
    if (!project) throw new DesignProjectNotFoundError();
    if (project.revision !== expectedRevision) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    const related = (await this.cascadePlanner?.inspect(clone(project))) ?? {};
    const referencesInOtherProjects = new Set(
      database.projects
        .filter((candidate) => candidate.id !== project.id)
        .flatMap((candidate) => candidate.referenceAssetIds),
    );
    return {
      version: 1,
      projectId: project.id,
      expectedRevision: project.revision,
      expectedDatabaseRevision: database.revision,
      chatId: project.chatId,
      artifactMediaIds: [
        ...new Set(project.canvas.nodes.flatMap((node) => node.artifactMediaIds ?? [])),
      ].sort(),
      detachedReferenceAssetIds: [...project.referenceAssetIds].sort(),
      unreferencedReferenceAssetIds: project.referenceAssetIds
        .filter((assetId) => !referencesInOtherProjects.has(assetId))
        .sort(),
      commentIds: safeCascadeIds(related.commentIds, "comment"),
      designerActionIds: safeCascadeIds(related.designerActionIds, "Designer Action"),
    };
  }

  /**
   * Resolve an unknown delete response from a fresh disk snapshot. The exact
   * database revision proves that an absent row came from this one planned
   * deletion; every other absent outcome retains lifecycle recovery authority.
   */
  async reconcileDeletePublication(
    plan: DesignProjectDeletePlanV1,
  ): Promise<DesignProjectDeletePublicationState> {
    this.requireAvailable();
    const projectId = requireIdentity(plan.projectId, "identity");
    const chatId = requireIdentity(plan.chatId, "chat identity");
    if (!Number.isSafeInteger(plan.expectedDatabaseRevision) || plan.expectedDatabaseRevision < 0) {
      throw new Error("Invalid Design Project database revision.");
    }
    try {
      await this.data.reload();
      if ((await this.data.loadedFromCorruptFile()) || (await this.data.loadedFromUnsafeFile())) {
        return "uncertain";
      }
      const database = await this.data.load();
      if (database.projects.some((project) => project.id === projectId)) return "present";
      if (
        database.revision !== plan.expectedDatabaseRevision + 1 ||
        database.projects.some((project) => project.chatId === chatId)
      ) {
        return "uncertain";
      }
      return "deleted";
    } catch {
      return "uncertain";
    }
  }

  /**
   * Remove only the project row and return the exact cascade plan. A main-owned
   * recoverable coordinator must durably journal and execute the cross-store
   * deletion around this method.
   */
  async delete(plan: DesignProjectDeletePlanV1): Promise<DesignProjectDeletePlanV1> {
    this.requireAvailable();
    const currentPlan = await this.planDelete({
      id: plan.projectId,
      expectedRevision: plan.expectedRevision,
    });
    if (JSON.stringify(plan) !== JSON.stringify(currentPlan)) {
      throw new DesignProjectConflictError("Design Project deletion plan changed.");
    }
    return this.data.update((database) => {
      if (database.revision !== plan.expectedDatabaseRevision) {
        throw new DesignProjectConflictError("Design Project deletion plan changed.");
      }
      const { index } = requireCurrent(database, plan.projectId, plan.expectedRevision);
      database.projects.splice(index, 1);
      database.revision += 1;
      return clone(plan);
    });
  }

  /** Lazy, deterministic migration for the compatibility `/design/$chatId` route. */
  async getOrMigrateLegacyChat(chatId: string): Promise<DesignProjectSnapshotV1 | undefined> {
    this.requireAvailable();
    const safeChatId = requireIdentity(chatId, "chat identity");
    const existing = await this.getByChatId(safeChatId);
    if (existing) return existing;
    if (!this.legacySource) {
      throw new DesignProjectUnavailableError("Legacy Design migration is not configured.");
    }
    const facts = await this.legacySource.loadDesignChatFacts(safeChatId);
    if (!facts) return undefined;
    if (facts.chatId !== safeChatId) {
      throw new DesignProjectMigrationBlockedError("Legacy Design chat identity changed.");
    }
    const migrated = migratedSnapshot(facts);
    return this.data.update((database) => {
      const installed = database.projects.find((project) => project.chatId === safeChatId);
      if (installed) return clone(installed);
      if (database.projects.length >= MAX_DESIGN_PROJECTS) {
        throw new DesignProjectConflictError("Design Project storage is at capacity.");
      }
      const collision = database.projects.find((project) => project.id === migrated.id);
      if (collision) {
        throw new DesignProjectConflictError("Migrated Design Project identity collided.");
      }
      database.projects.push(migrated);
      database.revision += 1;
      return clone(migrated);
    });
  }
}
