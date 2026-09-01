export const DESIGN_PROJECT_SNAPSHOT_VERSION = 1 as const;
export const DESIGN_PROJECT_DATABASE_VERSION = 1 as const;

export const MAX_DESIGN_PROJECTS = 250;
export const MAX_DESIGN_PROJECT_NODES = 250;
export const MAX_DESIGN_PROJECT_REFERENCE_ASSETS = 100;
export const MAX_DESIGN_PROJECT_ARTIFACT_REVISIONS_PER_ARTBOARD = 100;
export const MAX_DESIGN_PROJECT_TITLE_CHARS = 160;
export const MAX_DESIGN_PROJECT_TITLE_BYTES = 512;
export const MAX_DESIGN_PROJECT_ID_CHARS = 256;
export const MAX_DESIGN_PROJECT_COORDINATE = 1_000_000;
export const MAX_DESIGN_PROJECT_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_DESIGN_PROJECT_STORE_BYTES = 16 * 1024 * 1024;

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:@+-]+$/u;
const SNAPSHOT_KEYS = new Set([
  "version",
  "id",
  "revision",
  "title",
  "chatId",
  "workspaceId",
  "connectionState",
  "createdAt",
  "updatedAt",
  "canvas",
  "referenceAssetIds",
  "designSystemBinding",
  "previewScriptId",
]);
const REQUIRED_SNAPSHOT_KEYS = new Set([
  "version",
  "id",
  "revision",
  "title",
  "chatId",
  "connectionState",
  "createdAt",
  "updatedAt",
  "canvas",
  "referenceAssetIds",
]);
const CANVAS_KEYS = new Set(["viewport", "flowViewport", "nodes"]);
const FLOW_VIEWPORT_KEYS = new Set(["x", "y", "zoom"]);
const NODE_KEYS = new Set([
  "id",
  "kind",
  "canonicalOrigin",
  "x",
  "y",
  "lineageId",
  "artifactMediaIds",
  "activeMediaId",
  "assetId",
]);
const REQUIRED_NODE_KEYS = new Set(["id", "kind", "canonicalOrigin", "x", "y"]);
const BINDING_KEYS = new Set(["id", "revision"]);
const DATABASE_KEYS = new Set(["version", "revision", "projects"]);

export type DesignProjectConnectionState = "prototype-only" | "connected";
export type DesignProjectViewport = "desktop" | "tablet" | "phone";
export type DesignProjectNodeKind = "artboard" | "reference-image" | "source-preview";
export type DesignProjectCanonicalOrigin =
  | "generated-artifact"
  | "connected-app"
  | "reference-asset";

export interface DesignProjectCanvasNodeV1 {
  id: string;
  kind: DesignProjectNodeKind;
  /** Canonical data source only; never a grant of mutation authority. */
  canonicalOrigin: DesignProjectCanonicalOrigin;
  x: number;
  y: number;
  /** Stable history identity. Titles are display metadata and never lineage. */
  lineageId?: string;
  /** Chronological immutable revisions belonging to this artboard lineage. */
  artifactMediaIds?: string[];
  activeMediaId?: string;
  assetId?: string;
}

export interface DesignProjectCanvasV1 {
  viewport: DesignProjectViewport;
  flowViewport: { x: number; y: number; zoom: number };
  nodes: DesignProjectCanvasNodeV1[];
}

export interface DesignProjectSnapshotV1 {
  version: typeof DESIGN_PROJECT_SNAPSHOT_VERSION;
  id: string;
  revision: number;
  title: string;
  chatId: string;
  workspaceId?: string;
  /** Relationship fact only. Never grants filesystem or mutation authority. */
  connectionState: DesignProjectConnectionState;
  createdAt: number;
  updatedAt: number;
  canvas: DesignProjectCanvasV1;
  referenceAssetIds: string[];
  designSystemBinding?: {
    id: string;
    revision: number;
  };
  previewScriptId?: string;
}

export interface DesignProjectDatabaseV1 {
  version: typeof DESIGN_PROJECT_DATABASE_VERSION;
  revision: number;
  projects: DesignProjectSnapshotV1[];
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): boolean {
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    [...required].every((key) => key in value)
  );
}

export function isDesignProjectOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DESIGN_PROJECT_ID_CHARS &&
    value.normalize("NFKC") === value &&
    SAFE_OPAQUE_ID.test(value)
  );
}

export function normalizeDesignProjectTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.normalize("NFKC").trim();
  if (
    title.length === 0 ||
    Array.from(title).length > MAX_DESIGN_PROJECT_TITLE_CHARS ||
    Buffer.byteLength(title, "utf8") > MAX_DESIGN_PROJECT_TITLE_BYTES
  ) {
    return undefined;
  }
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return title;
}

function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function safeTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DATE_MILLISECONDS
  );
}

/**
 * Coordinates are persisted at millipixel precision. Values outside the
 * bounded canvas are rejected instead of silently moving crafted renderer
 * input back into range.
 */
export function normalizeDesignProjectCoordinate(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_DESIGN_PROJECT_COORDINATE
  ) {
    return undefined;
  }
  const normalized = Math.round(value * 1_000) / 1_000;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function parseNode(value: unknown): DesignProjectCanvasNodeV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  if (!exactKeys(node, NODE_KEYS, REQUIRED_NODE_KEYS)) return undefined;
  if (
    !isDesignProjectOpaqueId(node.id) ||
    (node.kind !== "artboard" &&
      node.kind !== "reference-image" &&
      node.kind !== "source-preview") ||
    (node.canonicalOrigin !== "generated-artifact" &&
      node.canonicalOrigin !== "connected-app" &&
      node.canonicalOrigin !== "reference-asset")
  ) {
    return undefined;
  }
  const x = normalizeDesignProjectCoordinate(node.x);
  const y = normalizeDesignProjectCoordinate(node.y);
  if (x === undefined || y === undefined) return undefined;
  const activeMediaId =
    node.activeMediaId === undefined
      ? undefined
      : isDesignProjectOpaqueId(node.activeMediaId)
        ? node.activeMediaId
        : undefined;
  const assetId =
    node.assetId === undefined
      ? undefined
      : isDesignProjectOpaqueId(node.assetId)
        ? node.assetId
        : undefined;
  const lineageId =
    node.lineageId === undefined
      ? undefined
      : isDesignProjectOpaqueId(node.lineageId)
        ? node.lineageId
        : undefined;
  const artifactMediaIds = Array.isArray(node.artifactMediaIds)
    ? node.artifactMediaIds.filter(isDesignProjectOpaqueId)
    : undefined;
  if (
    (node.activeMediaId !== undefined && activeMediaId === undefined) ||
    (node.assetId !== undefined && assetId === undefined) ||
    (node.lineageId !== undefined && lineageId === undefined) ||
    (node.artifactMediaIds !== undefined && artifactMediaIds === undefined)
  ) {
    return undefined;
  }
  if (
    node.kind === "artboard" &&
    (node.canonicalOrigin !== "generated-artifact" ||
      !lineageId ||
      !artifactMediaIds ||
      artifactMediaIds.length === 0 ||
      artifactMediaIds.length > MAX_DESIGN_PROJECT_ARTIFACT_REVISIONS_PER_ARTBOARD ||
      new Set(artifactMediaIds).size !== artifactMediaIds.length ||
      !activeMediaId ||
      !artifactMediaIds.includes(activeMediaId) ||
      assetId)
  ) {
    return undefined;
  }
  if (
    node.kind === "reference-image" &&
    (node.canonicalOrigin !== "reference-asset" ||
      !assetId ||
      activeMediaId ||
      lineageId ||
      artifactMediaIds)
  ) {
    return undefined;
  }
  if (
    node.kind === "source-preview" &&
    (node.canonicalOrigin !== "connected-app" ||
      assetId ||
      activeMediaId ||
      lineageId ||
      artifactMediaIds)
  ) {
    return undefined;
  }
  return {
    id: node.id,
    kind: node.kind,
    canonicalOrigin: node.canonicalOrigin,
    x,
    y,
    ...(lineageId ? { lineageId } : {}),
    ...(artifactMediaIds ? { artifactMediaIds } : {}),
    ...(activeMediaId ? { activeMediaId } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

export function parseDesignProjectCanvasV1(value: unknown): DesignProjectCanvasV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const canvas = value as Record<string, unknown>;
  if (
    !exactKeys(canvas, CANVAS_KEYS) ||
    (canvas.viewport !== "desktop" &&
      canvas.viewport !== "tablet" &&
      canvas.viewport !== "phone") ||
    !canvas.flowViewport ||
    typeof canvas.flowViewport !== "object" ||
    Array.isArray(canvas.flowViewport) ||
    !exactKeys(canvas.flowViewport as Record<string, unknown>, FLOW_VIEWPORT_KEYS) ||
    !Array.isArray(canvas.nodes) ||
    canvas.nodes.length > MAX_DESIGN_PROJECT_NODES
  ) {
    return undefined;
  }
  const rawFlow = canvas.flowViewport as Record<string, unknown>;
  const flowX = normalizeDesignProjectCoordinate(rawFlow.x);
  const flowY = normalizeDesignProjectCoordinate(rawFlow.y);
  const zoom =
    typeof rawFlow.zoom === "number" &&
    Number.isFinite(rawFlow.zoom) &&
    rawFlow.zoom >= 0.05 &&
    rawFlow.zoom <= 4
      ? Math.round(rawFlow.zoom * 10_000) / 10_000
      : undefined;
  if (flowX === undefined || flowY === undefined || zoom === undefined) return undefined;
  const nodes = canvas.nodes.map(parseNode);
  if (nodes.some((node) => !node)) return undefined;
  const parsed = nodes as DesignProjectCanvasNodeV1[];
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) return undefined;
  const artboards = parsed.filter(({ kind }) => kind === "artboard");
  const lineageIds = artboards.flatMap(({ lineageId }) => (lineageId ? [lineageId] : []));
  const artifactMediaIds = artboards.flatMap((node) => node.artifactMediaIds ?? []);
  if (
    new Set(lineageIds).size !== lineageIds.length ||
    new Set(artifactMediaIds).size !== artifactMediaIds.length
  ) {
    return undefined;
  }
  return {
    viewport: canvas.viewport,
    flowViewport: { x: flowX, y: flowY, zoom },
    nodes: parsed,
  };
}

function parseBinding(value: unknown): DesignProjectSnapshotV1["designSystemBinding"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const binding = value as Record<string, unknown>;
  if (!exactKeys(binding, BINDING_KEYS)) return undefined;
  if (!isDesignProjectOpaqueId(binding.id) || !safeRevision(binding.revision)) return undefined;
  return { id: binding.id, revision: binding.revision };
}

export function parseDesignProjectSnapshotV1(value: unknown): DesignProjectSnapshotV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (
    !exactKeys(snapshot, SNAPSHOT_KEYS, REQUIRED_SNAPSHOT_KEYS) ||
    snapshot.version !== DESIGN_PROJECT_SNAPSHOT_VERSION ||
    !isDesignProjectOpaqueId(snapshot.id) ||
    !safeRevision(snapshot.revision) ||
    !isDesignProjectOpaqueId(snapshot.chatId) ||
    (snapshot.workspaceId !== undefined && !isDesignProjectOpaqueId(snapshot.workspaceId)) ||
    (snapshot.previewScriptId !== undefined && !isDesignProjectOpaqueId(snapshot.previewScriptId)) ||
    (snapshot.connectionState !== "prototype-only" && snapshot.connectionState !== "connected") ||
    !safeTimestamp(snapshot.createdAt) ||
    !safeTimestamp(snapshot.updatedAt) ||
    (snapshot.updatedAt as number) < (snapshot.createdAt as number) ||
    !Array.isArray(snapshot.referenceAssetIds) ||
    snapshot.referenceAssetIds.length > MAX_DESIGN_PROJECT_REFERENCE_ASSETS
  ) {
    return undefined;
  }
  if (
    (snapshot.connectionState === "prototype-only" && snapshot.workspaceId !== undefined) ||
    (snapshot.connectionState === "prototype-only" && snapshot.previewScriptId !== undefined) ||
    (snapshot.connectionState === "connected" && snapshot.workspaceId === undefined)
  ) {
    return undefined;
  }
  const title = normalizeDesignProjectTitle(snapshot.title);
  if (!title || title !== snapshot.title) return undefined;
  const canvas = parseDesignProjectCanvasV1(snapshot.canvas);
  if (!canvas) return undefined;
  const hasConnectedSource = canvas.nodes.some(({ kind }) => kind === "source-preview");
  if (hasConnectedSource && snapshot.connectionState !== "connected") {
    return undefined;
  }
  const referenceAssetIds = snapshot.referenceAssetIds.filter(isDesignProjectOpaqueId);
  if (
    referenceAssetIds.length !== snapshot.referenceAssetIds.length ||
    new Set(referenceAssetIds).size !== referenceAssetIds.length
  ) {
    return undefined;
  }
  const usedAssets = new Set(
    canvas.nodes.flatMap((node) =>
      node.kind === "reference-image" && node.assetId ? [node.assetId] : [],
    ),
  );
  if (
    usedAssets.size !== referenceAssetIds.length ||
    referenceAssetIds.some((assetId) => !usedAssets.has(assetId))
  ) {
    return undefined;
  }
  const designSystemBinding =
    snapshot.designSystemBinding === undefined
      ? undefined
      : parseBinding(snapshot.designSystemBinding);
  if (snapshot.designSystemBinding !== undefined && !designSystemBinding) return undefined;
  const parsed: DesignProjectSnapshotV1 = {
    version: DESIGN_PROJECT_SNAPSHOT_VERSION,
    id: snapshot.id,
    revision: snapshot.revision,
    title,
    chatId: snapshot.chatId,
    ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }),
    connectionState: snapshot.connectionState,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    canvas,
    referenceAssetIds,
    ...(designSystemBinding ? { designSystemBinding } : {}),
    ...(snapshot.previewScriptId === undefined
      ? {}
      : { previewScriptId: snapshot.previewScriptId as string }),
  };
  return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= MAX_DESIGN_PROJECT_SNAPSHOT_BYTES
    ? parsed
    : undefined;
}

export function emptyDesignProjectDatabase(): DesignProjectDatabaseV1 {
  return { version: DESIGN_PROJECT_DATABASE_VERSION, revision: 0, projects: [] };
}

export function parseDesignProjectDatabaseV1(value: unknown): DesignProjectDatabaseV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const database = value as Record<string, unknown>;
  if (
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== DESIGN_PROJECT_DATABASE_VERSION ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.projects) ||
    database.projects.length > MAX_DESIGN_PROJECTS
  ) {
    return undefined;
  }
  const projects = database.projects.map(parseDesignProjectSnapshotV1);
  if (projects.some((project) => !project)) return undefined;
  const parsed = projects as DesignProjectSnapshotV1[];
  const artifactMediaIds = parsed.flatMap((project) =>
    project.canvas.nodes.flatMap((node) => node.artifactMediaIds ?? []),
  );
  if (
    new Set(parsed.map(({ id }) => id)).size !== parsed.length ||
    new Set(parsed.map(({ chatId }) => chatId)).size !== parsed.length ||
    new Set(artifactMediaIds).size !== artifactMediaIds.length
  ) {
    return undefined;
  }
  return {
    version: DESIGN_PROJECT_DATABASE_VERSION,
    revision: database.revision as number,
    projects: parsed,
  };
}

export function assertDesignProjectSnapshotV1(value: unknown): DesignProjectSnapshotV1 {
  const parsed = parseDesignProjectSnapshotV1(value);
  if (!parsed) throw new Error("Invalid Design Project snapshot.");
  return parsed;
}
