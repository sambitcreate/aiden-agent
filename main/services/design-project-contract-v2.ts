import type {
  DesignProjectCanvas,
  DesignProjectCanvasNodeV1,
  DesignProjectCanvasNodeV2,
  DesignProjectDatabaseV2,
  DesignProjectSnapshotV2,
  DesignProjectTitlePolicyV2,
  DesignProjectViewport,
  DesignScreenPresentationV2,
} from "../../renderer/shared/design-projects.js";
import {
  MAX_DESIGN_PROJECT_NODES,
  MAX_DESIGN_PROJECT_SNAPSHOT_BYTES,
  MAX_DESIGN_PROJECT_STORE_BYTES,
  MAX_DESIGN_PROJECTS,
  parseDesignProjectCanvasV1,
  parseDesignProjectDatabaseV1,
  parseDesignProjectSnapshotV1,
  type DesignProjectDatabaseV1,
  type DesignProjectCanvasV1,
  type DesignProjectSnapshotV1,
} from "./design-project-contract.js";
import {
  DEFAULT_BLANK_DESIGN_PROJECT_TITLE,
  migrateDesignProjectTitleStateFromV1,
  migrateDesignScreenPresentationFromViewport,
  normalizeDesignProjectTitlePolicyV2,
  normalizeDesignScreenPresentationV2,
} from "./design-project-v2-policy.js";

export const DESIGN_PROJECT_SNAPSHOT_VERSION_V2 = 2 as const;
export const DESIGN_PROJECT_DATABASE_VERSION_V2 = 2 as const;
const V2_METADATA_HEADROOM_PER_NODE = 128;
const V2_METADATA_HEADROOM_PER_PROJECT =
  MAX_DESIGN_PROJECT_NODES * V2_METADATA_HEADROOM_PER_NODE + 1_024;
export const MAX_DESIGN_PROJECT_SNAPSHOT_BYTES_V2 =
  MAX_DESIGN_PROJECT_SNAPSHOT_BYTES + V2_METADATA_HEADROOM_PER_PROJECT;
export const MAX_DESIGN_PROJECT_STORE_BYTES_V2 =
  MAX_DESIGN_PROJECT_STORE_BYTES + MAX_DESIGN_PROJECTS * V2_METADATA_HEADROOM_PER_PROJECT;

const SNAPSHOT_V2_KEYS = new Set([
  "version",
  "id",
  "revision",
  "title",
  "titlePolicy",
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
const REQUIRED_SNAPSHOT_V2_KEYS = new Set([
  "version",
  "id",
  "revision",
  "title",
  "titlePolicy",
  "chatId",
  "connectionState",
  "createdAt",
  "updatedAt",
  "canvas",
  "referenceAssetIds",
]);
const CANVAS_KEYS = new Set(["viewport", "flowViewport", "nodes"]);
const NODE_V2_KEYS = new Set([
  "id",
  "kind",
  "canonicalOrigin",
  "x",
  "y",
  "lineageId",
  "artifactMediaIds",
  "activeMediaId",
  "assetId",
  "presentation",
]);
const DATABASE_KEYS = new Set(["version", "revision", "projects"]);

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): boolean {
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function legacyNode(node: Record<string, unknown>): Record<string, unknown> {
  const { presentation: _presentation, ...legacy } = node;
  return legacy;
}

function legacySnapshot(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!value.canvas || typeof value.canvas !== "object" || Array.isArray(value.canvas)) {
    return undefined;
  }
  const canvas = value.canvas as Record<string, unknown>;
  if (!exactKeys(canvas, CANVAS_KEYS) || !Array.isArray(canvas.nodes)) return undefined;
  const { titlePolicy: _titlePolicy, ...legacyValue } = value;
  return {
    ...legacyValue,
    version: 1,
    canvas: {
      ...canvas,
      nodes: canvas.nodes.map((node) =>
        node && typeof node === "object" && !Array.isArray(node)
          ? legacyNode(node as Record<string, unknown>)
          : node,
      ),
    },
  };
}

export function parseDesignProjectCanvasV2(
  value: unknown,
): DesignProjectSnapshotV2["canvas"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const canvas = value as Record<string, unknown>;
  if (!exactKeys(canvas, CANVAS_KEYS) || !Array.isArray(canvas.nodes)) return undefined;
  const common = parseDesignProjectCanvasV1({
    ...canvas,
    nodes: canvas.nodes.map((node) =>
      node && typeof node === "object" && !Array.isArray(node)
        ? legacyNode(node as Record<string, unknown>)
        : node,
    ),
  });
  if (!common) return undefined;
  const nodes: DesignProjectCanvasNodeV2[] = [];
  for (let index = 0; index < canvas.nodes.length; index += 1) {
    const rawNode = canvas.nodes[index];
    const parsedNode = common.nodes[index];
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode) || !parsedNode) {
      return undefined;
    }
    const node = rawNode as Record<string, unknown>;
    if (!exactKeys(node, NODE_V2_KEYS, new Set(Object.keys(legacyNode(node))))) return undefined;
    if (parsedNode.kind !== "artboard") {
      if (node.presentation !== undefined) return undefined;
      nodes.push({ ...parsedNode } as DesignProjectCanvasNodeV2);
      continue;
    }
    const presentation = normalizeDesignScreenPresentationV2(node.presentation);
    if (!presentation) return undefined;
    nodes.push({ ...parsedNode, presentation } as DesignProjectCanvasNodeV2);
  }
  return { ...common, nodes };
}

/** Accepts legacy layout payloads during rollout; semantic V2 facts are merged by the store. */
export function parseDesignProjectCanvasForV2Update(
  value: unknown,
): DesignProjectCanvas | undefined {
  return parseDesignProjectCanvasV2(value) ?? parseDesignProjectCanvasV1(value);
}

export function parseDesignProjectSnapshotV2(value: unknown): DesignProjectSnapshotV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (
    !exactKeys(snapshot, SNAPSHOT_V2_KEYS, REQUIRED_SNAPSHOT_V2_KEYS) ||
    snapshot.version !== DESIGN_PROJECT_SNAPSHOT_VERSION_V2
  ) {
    return undefined;
  }
  const titlePolicy = normalizeDesignProjectTitlePolicyV2(snapshot.titlePolicy);
  const downgraded = legacySnapshot(snapshot);
  if (!titlePolicy || !downgraded) return undefined;
  delete downgraded.titlePolicy;
  const common = parseDesignProjectSnapshotV1(downgraded);
  if (!common) return undefined;
  const parsedCanvas = parseDesignProjectCanvasV2(snapshot.canvas);
  if (!parsedCanvas) return undefined;
  const parsed: DesignProjectSnapshotV2 = {
    ...common,
    version: DESIGN_PROJECT_SNAPSHOT_VERSION_V2,
    titlePolicy,
    canvas: parsedCanvas,
  };
  if (
    titlePolicy.state === "auto-eligible" &&
    parsed.title !== DEFAULT_BLANK_DESIGN_PROJECT_TITLE
  ) {
    return undefined;
  }
  if (titlePolicy.state === "auto-applied") {
    const source = parsedCanvas.nodes.find(
      (node) =>
        node.kind === "artboard" &&
        node.lineageId === titlePolicy.sourceLineageId &&
        node.artifactMediaIds?.includes(titlePolicy.sourceMediaId) === true,
    );
    if (!source) return undefined;
  }
  return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= MAX_DESIGN_PROJECT_SNAPSHOT_BYTES_V2
    ? parsed
    : undefined;
}

export interface DesignProjectV2MigrationPolicy {
  titlePolicy(title: string): DesignProjectTitlePolicyV2;
  screenPresentation(viewport: DesignProjectViewport): DesignScreenPresentationV2;
}

export const DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY: DesignProjectV2MigrationPolicy = {
  titlePolicy: (title) => migrateDesignProjectTitleStateFromV1(title).titlePolicy,
  screenPresentation: migrateDesignScreenPresentationFromViewport,
};

export function migrateDesignProjectSnapshotV1ToV2(
  value: unknown,
  policy: DesignProjectV2MigrationPolicy = DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY,
): DesignProjectSnapshotV2 | undefined {
  const legacy = parseDesignProjectSnapshotV1(value);
  if (!legacy || legacy.version !== 1) return undefined;
  return parseDesignProjectSnapshotV2({
    ...legacy,
    version: DESIGN_PROJECT_SNAPSHOT_VERSION_V2,
    titlePolicy: policy.titlePolicy(legacy.title),
    canvas: {
      ...legacy.canvas,
      nodes: legacy.canvas.nodes.map((node: DesignProjectCanvasNodeV1) =>
        node.kind === "artboard"
          ? { ...node, presentation: policy.screenPresentation(legacy.canvas.viewport) }
          : node,
      ),
    },
  });
}

function validateDatabaseOwnership(projects: readonly DesignProjectSnapshotV2[]): boolean {
  const artifactMediaIds = projects.flatMap((project) =>
    project.canvas.nodes.flatMap((node) => node.artifactMediaIds ?? []),
  );
  return (
    new Set(projects.map(({ id }) => id)).size === projects.length &&
    new Set(projects.map(({ chatId }) => chatId)).size === projects.length &&
    new Set(artifactMediaIds).size === artifactMediaIds.length
  );
}

function serializedBytesAtMost(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

export function parseDesignProjectDatabaseV2(value: unknown): DesignProjectDatabaseV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!serializedBytesAtMost(value, MAX_DESIGN_PROJECT_STORE_BYTES_V2)) return undefined;
  const database = value as Record<string, unknown>;
  if (
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== DESIGN_PROJECT_DATABASE_VERSION_V2 ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.projects) ||
    database.projects.length > MAX_DESIGN_PROJECTS
  ) {
    return undefined;
  }
  const projects = database.projects.map(parseDesignProjectSnapshotV2);
  if (projects.some((project) => !project)) return undefined;
  const parsed = projects as DesignProjectSnapshotV2[];
  if (!validateDatabaseOwnership(parsed)) return undefined;
  return {
    version: DESIGN_PROJECT_DATABASE_VERSION_V2,
    revision: database.revision as number,
    projects: parsed,
  };
}

export function migrateDesignProjectDatabaseV1ToV2(
  value: unknown,
  policy: DesignProjectV2MigrationPolicy = DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY,
): DesignProjectDatabaseV2 | undefined {
  if (!serializedBytesAtMost(value, MAX_DESIGN_PROJECT_STORE_BYTES)) return undefined;
  const legacy = parseDesignProjectDatabaseV1(value);
  if (!legacy || legacy.version !== 1) return undefined;
  const projects = legacy.projects.map((project) =>
    migrateDesignProjectSnapshotV1ToV2(project, policy),
  );
  if (projects.some((project) => !project)) return undefined;
  return parseDesignProjectDatabaseV2({
    version: DESIGN_PROJECT_DATABASE_VERSION_V2,
    revision: legacy.revision,
    projects,
  });
}

export type DesignProjectDatabaseV2ReadResult =
  | { sourceVersion: 2; migrated: false; database: DesignProjectDatabaseV2 }
  | { sourceVersion: 1; migrated: true; database: DesignProjectDatabaseV2 };

/** Strict dual reader used by store plumbing; unknown and future versions fail closed. */
export function readDesignProjectDatabaseV2(
  value: unknown,
  policy: DesignProjectV2MigrationPolicy = DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY,
): DesignProjectDatabaseV2ReadResult | undefined {
  const current = parseDesignProjectDatabaseV2(value);
  if (current) return { sourceVersion: 2, migrated: false, database: current };
  const migrated = migrateDesignProjectDatabaseV1ToV2(value, policy);
  return migrated ? { sourceVersion: 1, migrated: true, database: migrated } : undefined;
}

/** Canonical normalization hook for a V2 DataStore. */
export function normalizeDesignProjectDatabaseV2(
  value: unknown,
  policy: DesignProjectV2MigrationPolicy = DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY,
): DesignProjectDatabaseV2 | undefined {
  return readDesignProjectDatabaseV2(value, policy)?.database;
}

export function emptyDesignProjectDatabaseV2(): DesignProjectDatabaseV2 {
  return { version: DESIGN_PROJECT_DATABASE_VERSION_V2, revision: 0, projects: [] };
}

/** Reusable DataStore hooks: V1 is safe to read and the next write is canonical V2. */
export function designProjectDatabaseV2StorePolicy(
  policy: DesignProjectV2MigrationPolicy = DEFAULT_DESIGN_PROJECT_V2_MIGRATION_POLICY,
): {
  normalize: (value: unknown) => DesignProjectDatabaseV2;
  isSafe: (value: unknown) => boolean;
} {
  return {
    normalize: (value) =>
      normalizeDesignProjectDatabaseV2(value, policy) ?? emptyDesignProjectDatabaseV2(),
    isSafe: (value) => readDesignProjectDatabaseV2(value, policy) !== undefined,
  };
}

export type {
  DesignProjectCanvasV1,
  DesignProjectCanvasNodeV2,
  DesignProjectDatabaseV1,
  DesignProjectDatabaseV2,
  DesignProjectSnapshotV1,
  DesignProjectSnapshotV2,
  DesignProjectTitlePolicyV2,
  DesignScreenPresentationV2,
};
