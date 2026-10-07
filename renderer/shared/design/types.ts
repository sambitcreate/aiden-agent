// Design Studio contract shared by main and the renderer: types plus frame presets.
import type { GenerationThinkingLevel } from "../generation-thinking.js";

export type DesignFramePreset = "desktop" | "tablet" | "phone" | "custom";

export const DESIGN_FRAME_PRESETS = {
  desktop: { width: 1440, height: 1024 },
  tablet: { width: 834, height: 1194 },
  phone: { width: 390, height: 844 },
} as const;

export interface DesignScreenFrame {
  preset: DesignFramePreset;
  width: number;
  height: number;
}

export interface DesignViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DesignCanvasNode {
  id: string;
  kind: "screen";
  screenId: string;
  x: number;
  y: number;
}

export interface DesignScreen {
  id: string;
  title: string;
  frame: DesignScreenFrame;
  revisionIds: string[];
  activeRevisionId: string;
  directionSetId?: string;
  createdAt: number;
}

export type DesignRevisionState = "draft" | "published" | "missing";

export interface DesignModelRef {
  providerId: string;
  model: string;
}

export interface DesignRevision {
  id: string;
  screenId: string;
  parentRevisionId?: string;
  runId: string;
  toolCallId: string;
  title: string;
  bytes: number;
  sha256: string;
  state: DesignRevisionState;
  createdAt: number;
  model: DesignModelRef;
}

export type DesignExploreCount = 2 | 3 | 4;

export interface DesignDirectionSet {
  id: string;
  runId: string;
  requestedCount: DesignExploreCount;
  screenIds: string[];
  chosenScreenId?: string;
  archived: boolean;
}

export type DesignCreativeRange = "close" | "balanced" | "bold";
export type DesignAspect = "layout" | "color" | "typography" | "content";

export type DesignRunRequest =
  | {
      op: "explore";
      count: DesignExploreCount;
      creativeRange: DesignCreativeRange;
      aspects: DesignAspect[];
      baseRevisionId?: string;
      /**
       * Resume the newest run of an incomplete direction set: a new run and a new
       * turn on the same hidden chat, capped at the directions still missing.
       */
      resumeRunId?: string;
    }
  | { op: "refine"; screenId: string; baseRevisionId: string };

export type DesignRunStatus =
  | "running"
  | "complete"
  | "partial"
  | "cancelled"
  | "interrupted"
  | "failed";

/** Why a run that published fewer designs than its cap ended (owner decision 2026-10-07). */
export type DesignRunEndReason = "stopped" | "provider_failed" | "interrupted" | "short";

export interface DesignRunRecord {
  id: string;
  kind: "explore" | "refine";
  turnId: string;
  request: DesignRunRequest;
  /** How many designs this run may accept: Explore N (or the missing count on Resume), Refine 1. */
  outputCap: number;
  status: DesignRunStatus;
  /** Present only on a `partial` run. */
  endReason?: DesignRunEndReason;
  /** The direction set an Explore run fills: its own, or the one it resumes. */
  directionSetId?: string;
  /** The hidden-chat user message carrying this run's brief; a Resume repeats it. */
  promptMessageId?: string;
  revisionIds: string[];
  startedAt: number;
  endedAt?: number;
}

export interface DesignProjectManifestV1 {
  schema: 1;
  id: string;
  /** Compare-and-set revision; every committed write increments it. */
  revision: number;
  title: string;
  chatId: string;
  state: "active" | "deleting";
  createdAt: number;
  updatedAt: number;
  canvas: { viewport: DesignViewport; nodes: DesignCanvasNode[] };
  screens: Record<string, DesignScreen>;
  revisions: Record<string, DesignRevision>;
  directionSets: Record<string, DesignDirectionSet>;
  /** Newest 100 kept. */
  runs: Record<string, DesignRunRecord>;
}

/** The manifest projection the renderer reads. It never contains HTML. */
export type DesignProjectSnapshot = DesignProjectManifestV1;

export type DesignProjectHealth = "ok" | "unreadable" | "interrupted";

export interface DesignProjectSummary {
  id: string;
  title: string;
  updatedAt: number;
  screenCount: number;
  bytes: number;
  health: DesignProjectHealth;
}

export interface DesignElementSelection {
  tagName: string;
  label: string;
  selector: string;
  elementId?: string;
  role?: string;
  text?: string;
}

export type DesignContextChip =
  | { kind: "screen"; screenId: string; revisionId: string }
  | { kind: "element"; screenId: string; revisionId: string; element: DesignElementSelection };

/** DS-1 operations. DS-2 adds `applyDesignLanguage`; DS-3 adds `removeReference`. */
export type DesignProjectOp =
  | { op: "rename"; title: string }
  | { op: "setLayout"; viewport: DesignViewport; nodes: { id: string; x: number; y: number }[] }
  | { op: "setActiveRevision"; screenId: string; revisionId: string }
  | { op: "setScreenFrame"; screenId: string; frame: DesignScreenFrame }
  | { op: "chooseDirection"; directionSetId: string; screenId: string }
  | { op: "archiveDirectionSet"; directionSetId: string; archived: boolean }
  | { op: "deleteScreen"; screenId: string }
  /** Discard archives an incomplete set; nothing is deleted and no quota is freed. */
  | { op: "settleRun"; runId: string; decision: "discard" };

export type DesignMutateResult =
  | { ok: true; snapshot: DesignProjectSnapshot }
  | { ok: false; reason: "stale" | "quota" | "invalid" | "busy"; message: string; snapshot: DesignProjectSnapshot };

export interface DesignDeletePreview {
  screens: number;
  revisions: number;
  bytes: number;
  /** Studio-asset references; DS-3 adds them. */
  references: number;
  /** The manifest could not be read, so the counts above are unknown (zero) and the delete needs confirmation. */
  unreadable?: true;
}

export interface DesignPreviewTheme {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
}

export interface DesignRunStartRequest {
  projectId: string;
  streamId: string;
  request: DesignRunRequest;
  /** The brief. A Resume sends "" because it repeats the resumed run's brief. */
  prompt: string;
  chips: DesignContextChip[];
  /** Required, except on a Resume, which defaults to the model of the set it resumes. */
  providerId?: string;
  model?: string;
  thinkingLevel?: GenerationThinkingLevel;
}

export interface DesignRunStartResult {
  accepted: boolean;
  runId?: string;
  /** What the started run may render and the model it asks, for the cost disclosure. */
  outputCap?: number;
  model?: DesignModelRef;
  error?: string;
}

export interface DesignProjectsChangedEvent {
  projectId: string;
  revision: number;
}

export interface DesignRunChangedEvent {
  projectId: string;
  runId: string;
  status: DesignRunStatus;
  acceptedRevisionIds: string[];
}
