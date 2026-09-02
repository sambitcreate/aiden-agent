export type DesignProjectConnectionState = "prototype-only" | "connected";
/** Storage namespace for backing conversations; never a filesystem authority. */
export const DESIGN_PROJECT_CHAT_WORKSPACE_ID = "design-projects";
export type DesignProjectFilter = "all" | "prototype" | "connected-app";
export type DesignProjectHealth = "ready" | "needs-repair";
export type DesignProjectInspectorTab = "preview" | "code" | "history";
export type DesignProjectViewport = "desktop" | "tablet" | "phone";
export type DesignProjectNodeKind = "artboard" | "reference-image" | "source-preview";
export type DesignProjectCanonicalOrigin =
  | "generated-artifact"
  | "connected-app"
  | "reference-asset";

export interface DesignProjectCanvasNodeV1 {
  id: string;
  kind: DesignProjectNodeKind;
  canonicalOrigin: DesignProjectCanonicalOrigin;
  x: number;
  y: number;
  lineageId?: string;
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
  version: 1;
  id: string;
  revision: number;
  title: string;
  chatId: string;
  workspaceId?: string;
  connectionState: DesignProjectConnectionState;
  createdAt: number;
  updatedAt: number;
  canvas: DesignProjectCanvasV1;
  referenceAssetIds: string[];
  designSystemBinding?: { id: string; revision: number };
  previewScriptId?: string;
}

export interface DesignProjectRecordSummaryV1 {
  id: string;
  revision: number;
  title: string;
  chatId: string;
  workspaceId?: string;
  connectionState: DesignProjectConnectionState;
  hasPrototypeArtboards: boolean;
  updatedAt: number;
  artboardCount: number;
  health: "ready" | "needs-repair";
  recoveryMessage?: string;
}

export type DesignProjectMutationResultV1 =
  | { status: "updated"; project: DesignProjectSnapshotV1 }
  | { status: "conflict"; current: DesignProjectSnapshotV1 };

export interface DesignProjectGenerationPreflightV1 {
  projectId: string;
  projectRevision: number;
  chatId: string;
  connectionState: DesignProjectConnectionState;
  workspaceId?: string;
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

export type DesignDirectEditV1 =
  | {
      kind: "spacing";
      property:
        | "margin"
        | "padding"
        | "gap"
        | "margin-top"
        | "margin-right"
        | "margin-bottom"
        | "margin-left"
        | "padding-top"
        | "padding-right"
        | "padding-bottom"
        | "padding-left"
        | "row-gap"
        | "column-gap";
      value: string;
    }
  | { kind: "size"; property: "width" | "height"; value: string }
  | {
      kind: "alignment";
      property: "align-items" | "justify-content" | "text-align";
      value:
        | "start"
        | "center"
        | "end"
        | "stretch"
        | "space-between"
        | "space-around"
        | "left"
        | "right";
    }
  | {
      kind: "color-token";
      property: "color" | "background-color" | "border-color";
      token: string;
    }
  | {
      kind: "radius";
      property:
        | "border-radius"
        | "border-top-left-radius"
        | "border-top-right-radius"
        | "border-bottom-right-radius"
        | "border-bottom-left-radius";
      value: string;
    }
  | { kind: "static-text"; text: string };

export interface DesignProjectSummary {
  id: string;
  title: string;
  connectionState: DesignProjectConnectionState;
  hasPrototypeArtboards: boolean;
  updatedAt: number;
  artboardCount: number;
  health: DesignProjectHealth;
  recoveryMessage?: string;
}

export interface DesignProjectSourceDocument {
  filename: string;
  language: string;
  content: string;
  byteSize: number;
  contentHash: string;
  revisionLabel: string;
  provenance: string;
  readOnly: boolean;
}

export interface DesignSystemProjectionV1 {
  version: 1;
  attachmentId: string;
  revision: number;
  state: "attached" | "detached";
  updatedAt: number;
  freshness: "current" | "changed" | "missing" | "detached";
  snapshot: null | {
    name: string;
    refreshedAt: number;
    contentHash: string;
    tokens: {
      colors: unknown[];
      spacing: unknown[];
      typography: unknown[];
      radii: unknown[];
      shadows: unknown[];
    };
    components: unknown[];
    icons: unknown[];
  };
}

export interface ManagedDesignHandoffPreviewV1 {
  kind: "managed-worktree";
  source: {
    workspaceId: string;
    workspaceLabel: string;
    repositoryLabel: string;
    branchLabel: string;
  };
  previewDigest: string;
  expectedCommittedHead: string;
  dirtyCheckout: boolean;
  requiredDirtyCheckoutAcknowledgement: string | null;
}

export interface ExistingDesignHandoffPreviewV1 {
  kind: "existing-workspace";
  target: {
    workspaceId: string;
    workspaceLabel: string;
    repositoryLabel: string;
    branchLabel: string;
  };
  previewDigest: string;
  requiredStrongWarningAcknowledgement: string;
}

export interface DesignHandoffRunResultV1 {
  status: "published" | "rolled-back" | "recoverable";
  record: {
    operationId: string;
    stage: string;
    recoveryReason?: string;
    linkage?: {
      projectId: string;
      workspaceId: string;
      chatId: string;
      taskId: string;
      branchLabel: string;
    };
  };
}

export interface DesignHandoffRecoveryViewV1 {
  operationId: string;
  stage:
    | "prepared"
    | "workspace-ready"
    | "chat-ready"
    | "context-ready"
    | "rolling-back"
    | "recoverable";
  targetKind: "managed-worktree" | "existing-workspace";
  workspaceLabel: string;
  branchLabel: string;
  recoveryReason?: string;
  updatedAt: number;
  canResume: boolean;
  canCancel: boolean;
  linkage?: {
    projectId: string;
    workspaceId: string;
    chatId: string;
    taskId: string;
    branchLabel: string;
  };
}

export interface DesignProjectRevisionSummary {
  id: string;
  lineageId: string;
  label: string;
  createdAt: number;
  provenance: string;
  model?: string;
  active?: boolean;
}

export interface DesignProjectDesignerActionSummary {
  id: string;
  label: string;
  createdAt: number;
  status: "pending" | "applied" | "rejected" | "stale" | "undone";
  fileLabel?: string;
}

export function designProjectOriginLabel(
  connectionState: DesignProjectConnectionState,
  hasPrototypeArtboards: boolean,
): string {
  if (connectionState === "prototype-only") return "Prototype";
  return hasPrototypeArtboards ? "Prototype + Connected App" : "Connected App";
}

export function designProjectArtboardLabel(count: number): string {
  return `${count} ${count === 1 ? "artboard" : "artboards"}`;
}

export function filterDesignProjects(
  projects: readonly DesignProjectSummary[],
  filter: DesignProjectFilter,
  query: string,
): DesignProjectSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return projects
    .filter((project) => {
      if (filter === "all") return true;
      if (filter === "prototype") return project.hasPrototypeArtboards;
      return project.connectionState === "connected";
    })
    .filter((project) => project.title.toLowerCase().includes(normalizedQuery))
    .sort(
      (left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title),
    );
}

export function designProjectSourceLines(content: string): string[] {
  return content.split("\n");
}

export function designProjectSourceMatchRanges(
  content: string,
  query: string,
): ReadonlyArray<readonly [start: number, end: number]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = content.toLowerCase();
  const ranges: Array<readonly [number, number]> = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) break;
    ranges.push([match, match + needle.length]);
    offset = match + needle.length;
  }
  return ranges;
}

export function countDesignProjectSourceMatches(content: string, query: string): number {
  return designProjectSourceMatchRanges(content, query).length;
}
