// Pure run lifecycle, artifact acceptance, quota and restart reconciliation
// for one project manifest. Every function returns a new manifest or mutates
// a clone its caller owns; nothing here touches the filesystem.
//
// The manifest parser checks cross references in both directions (Screen and
// direction set, revision and run), so every transition below changes both
// sides in the same update. The parser stays lenient about project bytes, set
// size and the revision counts of settled runs; this module is the authority.
import { isDeepStrictEqual } from "node:util";
import {
  MAX_DESIGN_MANIFEST_BYTES,
  MAX_DESIGN_PROJECT_BYTES,
  MAX_DESIGN_REVISION_BYTES,
  MAX_DESIGN_REVISIONS_PER_PROJECT,
  MAX_DESIGN_REVISIONS_PER_SCREEN,
  MAX_DESIGN_RUN_RECORDS,
  MAX_DESIGN_SCREENS_PER_PROJECT,
  MAX_DESIGN_TOTAL_BYTES,
} from "../../../renderer/shared/design/limits.js";
import { own } from "../../../renderer/shared/design/own.js";
import {
  designDirectionTitleKey,
  designResumeOffer,
  latestDesignRunForSet,
} from "../../../renderer/shared/design/resume.js";
import {
  DESIGN_FRAME_PRESETS,
  type DesignDeletePreview,
  type DesignDirectionSet,
  type DesignModelRef,
  type DesignProjectManifestV1,
  type DesignProjectSummary,
  type DesignRevision,
  type DesignRunEndReason,
  type DesignRunRecord,
  type DesignRunRequest,
  type DesignRunStatus,
  type DesignScreenFrame,
} from "../../../renderer/shared/design/types.js";
import { parseDesignProjectManifestV1 } from "./manifest-core.js";
import { parseDesignTitle } from "./ops-parse.js";

export type DesignStoreErrorCode = "invalid" | "quota" | "busy" | "not_found" | "stale" | "unavailable";

export class DesignStoreError extends Error {
  constructor(
    readonly code: DesignStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesignStoreError";
  }
}

export type DesignRunOutcome = "completed" | "cancelled" | "failed";

export interface DesignRunPlan {
  kind: "explore" | "refine";
  cap: number;
  baseRevisionId?: string;
  /** Present only for Resume: the set it fills, the titles already in it and the set's model. */
  directionSetId?: string;
  existingTitles?: string[];
  model?: DesignModelRef;
}

type ExploreRequest = Extract<DesignRunRequest, { op: "explore" }>;

export interface DesignArtifactAcceptance {
  runId: string;
  toolCallId: string;
  title: string;
  bytes: number;
  sha256: string;
  model: DesignModelRef;
  replacesRevisionId?: string;
}

export interface DesignAcceptanceIds {
  revisionId: string;
  screenId: string;
  nodeId: string;
}

export interface DesignStorageTotals {
  otherProjectsBytes: number;
  largestOtherProjectTitle?: string;
}

const SCREEN_GAP = 120;
const ROW_GAP = 240;
const SHA256 = /^[a-f0-9]{64}$/u;

const invalid = (message: string) => new DesignStoreError("invalid", message);
const quota = (message: string) => new DesignStoreError("quota", message);

/** Bump the compare-and-set revision of a clone the caller owns. */
export function touchDesignManifest(manifest: DesignProjectManifestV1, now: number): DesignProjectManifestV1 {
  manifest.revision += 1;
  manifest.updatedAt = Math.max(manifest.updatedAt, now);
  return manifest;
}

/**
 * The states the manifest parser leaves to the store: no project over its byte cap, no set
 * beyond the directions it asked for, no empty set unless its run is still filling it, and no
 * settled run without a design. Every transition above keeps them, so a violation is a bug.
 */
function assertDesignManifestInvariants(manifest: DesignProjectManifestV1): void {
  if (designProjectBytes(manifest) > MAX_DESIGN_PROJECT_BYTES) {
    throw invalid("This project declares more than its 64 MiB design limit.");
  }
  const runs = Object.values(manifest.runs);
  for (const set of Object.values(manifest.directionSets)) {
    if (set.screenIds.length > set.requestedCount) throw invalid("A direction set holds more Screens than it asked for.");
    const filling = runs.some((run) => run.directionSetId === set.id && run.status === "running");
    if (set.screenIds.length === 0 && !filling) throw invalid("A direction set has no Screens and no run filling it.");
  }
  for (const run of runs) {
    if (run.status === "partial" && (run.revisionIds.length === 0 || run.endReason === undefined)) {
      throw invalid("A partial run must keep a design and say why it stopped.");
    }
    if (run.status === "complete" && run.revisionIds.length === 0) throw invalid("A complete run must keep a design.");
  }
}

/**
 * The gate every manifest passes before it is written (and again when it is loaded): it must
 * fit the manifest size cap, re-parse through the same parser that loads it unchanged, and keep
 * the store invariants. A failure means nothing may be written.
 */
export function assertDesignManifestWritable(manifest: DesignProjectManifestV1): void {
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DESIGN_MANIFEST_BYTES) {
    throw quota("This project's manifest would exceed 1 MiB. Delete Screens to continue.");
  }
  const reread: unknown = JSON.parse(serialized);
  const parsed = parseDesignProjectManifestV1(reread);
  if (!parsed || !isDeepStrictEqual(parsed, reread)) {
    throw invalid("This change would leave the project in a state Aiden cannot reopen, so nothing was saved.");
  }
  assertDesignManifestInvariants(manifest);
}

/**
 * The bytes the project quota, the library summary and the delete preview all
 * report: every revision the manifest still lists, missing ones included. A file
 * that failed its size check may still sit on disk, and only deleting its Screen
 * releases it. Archiving a direction set frees nothing.
 */
export function designProjectBytes(manifest: DesignProjectManifestV1): number {
  let bytes = 0;
  for (const revision of Object.values(manifest.revisions)) bytes += revision.bytes;
  return bytes;
}

export function directionSetForRun(
  manifest: DesignProjectManifestV1,
  run: DesignRunRecord,
): DesignDirectionSet | undefined {
  return run.directionSetId === undefined ? undefined : own(manifest.directionSets, run.directionSetId);
}

/** A Resume repeats the request of the run it resumes; only resumeRunId differs. */
function sameExploreRequest(a: ExploreRequest, b: ExploreRequest): boolean {
  return (
    a.count === b.count &&
    a.creativeRange === b.creativeRange &&
    a.baseRevisionId === b.baseRevisionId &&
    a.aspects.length === b.aspects.length &&
    a.aspects.every((aspect, index) => aspect === b.aspects[index])
  );
}

function assertNoRunInProgress(manifest: DesignProjectManifestV1): void {
  if (Object.values(manifest.runs).some((run) => run.status === "running")) {
    throw new DesignStoreError("busy", "A design run is already in progress for this project.");
  }
}

export function planDesignRun(manifest: DesignProjectManifestV1, request: DesignRunRequest): DesignRunPlan {
  if (manifest.state !== "active") {
    throw new DesignStoreError("not_found", "This design project is being deleted.");
  }
  assertNoRunInProgress(manifest);
  if (request.op === "refine") {
    const screen = own(manifest.screens, request.screenId);
    const base = own(manifest.revisions, request.baseRevisionId);
    if (!screen || !base || base.screenId !== screen.id) {
      throw invalid("Choose a revision of this Screen to refine.");
    }
    if (base.state !== "published") throw invalid("Only a published revision can be refined.");
    return { kind: "refine", cap: 1, baseRevisionId: base.id };
  }
  if (
    request.baseRevisionId !== undefined &&
    own(manifest.revisions, request.baseRevisionId)?.state !== "published"
  ) {
    throw invalid("The base design is no longer available.");
  }
  const base = request.baseRevisionId === undefined ? {} : { baseRevisionId: request.baseRevisionId };
  if (request.resumeRunId === undefined) return { kind: "explore", cap: request.count, ...base };
  // Resume: a new run on the same set, capped at what is missing right now. The
  // busy check above is the fence that admits one of two concurrent Resumes.
  const offer = designResumeOffer(manifest, request.resumeRunId);
  if (!offer.ok) throw invalid(offer.reason);
  const resumed = own(manifest.runs, offer.runId)!.request;
  if (resumed.op !== "explore" || !sameExploreRequest(resumed, request)) {
    throw invalid("A Resume repeats the request of the run it resumes.");
  }
  return {
    kind: "explore",
    cap: offer.cap,
    directionSetId: offer.directionSetId,
    existingTitles: offer.existingTitles,
    ...(offer.model ? { model: offer.model } : {}),
    ...base,
  };
}

function trimDesignRuns(manifest: DesignProjectManifestV1): void {
  const runs = Object.values(manifest.runs);
  if (runs.length <= MAX_DESIGN_RUN_RECORDS) return;
  // The newest run of a set is what Resume and Discard act on; it outlives older runs.
  const newest = new Set<string>();
  for (const set of Object.values(manifest.directionSets)) {
    const latest = latestDesignRunForSet(manifest, set.id);
    if (latest) newest.add(latest.id);
  }
  const removable = runs
    .filter(
      (run) =>
        run.status !== "running" &&
        !newest.has(run.id) &&
        !run.revisionIds.some((id) => own(manifest.revisions, id)?.state === "draft"),
    )
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const run of removable.slice(0, runs.length - MAX_DESIGN_RUN_RECORDS)) {
    delete manifest.runs[run.id];
  }
}

export function beginDesignRun(
  manifest: DesignProjectManifestV1,
  input: {
    runId: string;
    turnId: string;
    request: DesignRunRequest;
    plan: DesignRunPlan;
    /** The id of a new set; a Resume fills plan.directionSetId instead. */
    directionSetId: string;
    now: number;
    promptMessageId?: string;
  },
): DesignProjectManifestV1 {
  if (own(manifest.runs, input.runId)) throw invalid("This design run already exists.");
  assertNoRunInProgress(manifest);
  const resumedSetId = input.plan.directionSetId;
  const directionSetId = resumedSetId ?? input.directionSetId;
  if (input.request.op === "explore") {
    const exists = own(manifest.directionSets, directionSetId) !== undefined;
    if (resumedSetId === undefined ? exists : !exists) {
      throw invalid(resumedSetId === undefined ? "This direction set already exists." : "The direction set to resume no longer exists.");
    }
  }
  // A Resume must rank as its set's newest run even if the clock ran backwards.
  let startedAt = input.now;
  if (resumedSetId !== undefined) {
    const previous = latestDesignRunForSet(manifest, resumedSetId);
    if (previous) startedAt = Math.max(startedAt, previous.startedAt + 1);
  }
  const next = structuredClone(manifest);
  next.runs[input.runId] = {
    id: input.runId,
    kind: input.plan.kind,
    turnId: input.turnId,
    request: structuredClone(input.request),
    outputCap: input.plan.cap,
    status: "running",
    ...(input.request.op === "explore" ? { directionSetId } : {}),
    ...(input.promptMessageId === undefined ? {} : { promptMessageId: input.promptMessageId }),
    revisionIds: [],
    startedAt,
  };
  if (input.request.op === "explore" && resumedSetId === undefined) {
    next.directionSets[directionSetId] = {
      id: directionSetId,
      runId: input.runId,
      requestedCount: input.request.count,
      screenIds: [],
      archived: false,
    };
  }
  trimDesignRuns(next);
  return touchDesignManifest(next, input.now);
}

function nextScreenPosition(manifest: DesignProjectManifestV1, set: DesignDirectionSet): { x: number; y: number } {
  const placed = set.screenIds.flatMap((screenId) => {
    const node = manifest.canvas.nodes.find((candidate) => candidate.screenId === screenId);
    const screen = own(manifest.screens, screenId);
    return node && screen ? [{ node, screen }] : [];
  });
  if (placed.length > 0) {
    const right = Math.max(...placed.map(({ node, screen }) => node.x + screen.frame.width));
    return { x: right + SCREEN_GAP, y: placed[0]!.node.y };
  }
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of manifest.canvas.nodes) {
    const screen = own(manifest.screens, node.screenId);
    if (screen) bottom = Math.max(bottom, node.y + screen.frame.height);
  }
  return { x: 0, y: Number.isFinite(bottom) ? bottom + ROW_GAP : 0 };
}

/** The store is the authority on titles; the render extension refuses the same call first. */
function assertDirectionTitleFree(
  manifest: DesignProjectManifestV1,
  set: DesignDirectionSet,
  title: string,
  exceptScreenId?: string,
): void {
  const titleKey = designDirectionTitleKey(title);
  const duplicate = set.screenIds.some((screenId) => {
    const existing = screenId === exceptScreenId ? undefined : own(manifest.screens, screenId);
    return existing !== undefined && designDirectionTitleKey(existing.title) === titleKey;
  });
  if (duplicate) {
    throw invalid(`A direction titled "${title}" already exists in this set. Render a different direction.`);
  }
}

export function acceptDesignArtifact(
  manifest: DesignProjectManifestV1,
  input: DesignArtifactAcceptance,
  ids: DesignAcceptanceIds,
  totals: DesignStorageTotals,
  now: number,
): { manifest: DesignProjectManifestV1; deletedRevisionIds: string[] } {
  const run = own(manifest.runs, input.runId);
  if (manifest.state !== "active" || !run || run.status !== "running") {
    throw invalid("This design run is no longer accepting designs.");
  }
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_DESIGN_REVISION_BYTES) {
    throw quota(
      `A design can be at most ${MAX_DESIGN_REVISION_BYTES / 1024} KiB; this one is ${Math.ceil(input.bytes / 1024)} KiB.`,
    );
  }
  // Stored titles are trimmed and free of control characters, as the manifest parser requires.
  const title = parseDesignTitle(input.title);
  if (title === undefined) throw invalid("This design has an unusable title.");
  if (!SHA256.test(input.sha256)) throw invalid("This design has an unusable checksum.");
  if (
    own(manifest.revisions, ids.revisionId) ||
    own(manifest.screens, ids.screenId) ||
    manifest.canvas.nodes.some((node) => node.id === ids.nodeId)
  ) {
    throw invalid("These design ids are already in use.");
  }
  if (input.replacesRevisionId === undefined && run.revisionIds.length >= run.outputCap) {
    throw invalid(`This run may render at most ${run.outputCap} design${run.outputCap === 1 ? "" : "s"}.`);
  }
  const next = structuredClone(manifest);
  const nextRun = next.runs[run.id]!;
  const base = run.request.baseRevisionId;
  const revision: DesignRevision = {
    id: ids.revisionId,
    screenId: "",
    ...(base === undefined ? {} : { parentRevisionId: base }),
    runId: run.id,
    toolCallId: input.toolCallId,
    title,
    bytes: input.bytes,
    sha256: input.sha256,
    state: "draft",
    createdAt: now,
    model: { ...input.model },
  };
  const deletedRevisionIds: string[] = [];
  if (input.replacesRevisionId !== undefined) {
    const replaced = own(next.revisions, input.replacesRevisionId);
    const screen = replaced === undefined ? undefined : own(next.screens, replaced.screenId);
    if (!replaced || !screen || replaced.runId !== run.id || replaced.state !== "draft") {
      throw invalid("Only a draft from this run can be replaced.");
    }
    if (run.kind === "explore") {
      const set = directionSetForRun(next, nextRun);
      if (set) assertDirectionTitleFree(next, set, title, screen.id);
      screen.title = title;
    }
    revision.screenId = screen.id;
    screen.revisionIds = screen.revisionIds.map((id) => (id === replaced.id ? revision.id : id));
    if (screen.activeRevisionId === replaced.id) screen.activeRevisionId = revision.id;
    nextRun.revisionIds = nextRun.revisionIds.map((id) => (id === replaced.id ? revision.id : id));
    delete next.revisions[replaced.id];
    deletedRevisionIds.push(replaced.id);
  } else {
    if (Object.keys(next.revisions).length >= MAX_DESIGN_REVISIONS_PER_PROJECT) {
      throw quota(`This project has reached its ${MAX_DESIGN_REVISIONS_PER_PROJECT}-revision limit. Delete Screens to free space.`);
    }
    if (run.request.op === "refine") {
      const screen = own(next.screens, run.request.screenId);
      if (!screen) throw invalid("The Screen being refined was deleted.");
      if (screen.revisionIds.length >= MAX_DESIGN_REVISIONS_PER_SCREEN) {
        throw quota(`"${screen.title}" has reached its ${MAX_DESIGN_REVISIONS_PER_SCREEN}-revision limit.`);
      }
      revision.screenId = screen.id;
      screen.revisionIds.push(revision.id);
    } else {
      if (Object.keys(next.screens).length >= MAX_DESIGN_SCREENS_PER_PROJECT) {
        throw quota(`This project has reached its ${MAX_DESIGN_SCREENS_PER_PROJECT}-Screen limit. Delete a Screen to add another.`);
      }
      const set = directionSetForRun(next, nextRun);
      if (!set) throw invalid("This run's direction set no longer exists.");
      if (set.screenIds.length >= set.requestedCount) {
        throw invalid(`This direction set already holds its ${set.requestedCount} directions.`);
      }
      assertDirectionTitleFree(next, set, title);
      const baseScreenId = base === undefined ? undefined : own(next.revisions, base)?.screenId;
      const baseScreen = baseScreenId === undefined ? undefined : own(next.screens, baseScreenId);
      const frame: DesignScreenFrame = baseScreen
        ? { ...baseScreen.frame }
        : { preset: "desktop", ...DESIGN_FRAME_PRESETS.desktop };
      const position = nextScreenPosition(next, set);
      next.screens[ids.screenId] = {
        id: ids.screenId,
        title,
        frame,
        revisionIds: [revision.id],
        activeRevisionId: revision.id,
        directionSetId: set.id,
        createdAt: now,
      };
      next.canvas.nodes.push({ id: ids.nodeId, kind: "screen", screenId: ids.screenId, ...position });
      set.screenIds.push(ids.screenId);
      revision.screenId = ids.screenId;
    }
    nextRun.revisionIds.push(revision.id);
  }
  next.revisions[revision.id] = revision;
  if (designProjectBytes(next) > MAX_DESIGN_PROJECT_BYTES) {
    throw quota("This project has reached its 64 MiB design limit. Delete Screens to free space.");
  }
  if (totals.otherProjectsBytes + designProjectBytes(next) > MAX_DESIGN_TOTAL_BYTES) {
    throw quota(
      totals.largestOtherProjectTitle === undefined
        ? "Design projects have used all 2 GiB of storage. Delete Screens or projects to continue."
        : `Design projects have used all 2 GiB of storage. Delete Screens or projects, starting with "${totals.largestOtherProjectTitle}", to continue.`,
    );
  }
  return { manifest: touchDesignManifest(next, now), deletedRevisionIds };
}

/** Drop a direction set and make every run that named it forget it. */
function dropDirectionSet(manifest: DesignProjectManifestV1, setId: string): void {
  delete manifest.directionSets[setId];
  for (const run of Object.values(manifest.runs)) {
    if (run.directionSetId === setId) delete run.directionSetId;
  }
}

/**
 * Remove a Screen with all of its revisions from a clone; returns the deleted revision ids.
 * Refused as "busy" (nothing changes) while a run is rendering into the Screen: it holds a
 * draft of a running run, or a running Refine targets it. A direction set left without
 * Screens is dropped (a set an in-progress run is still filling stays), and a settled run
 * that no longer has any design is dropped too: complete and partial runs always keep at
 * least one revision.
 */
export function removeDesignScreen(manifest: DesignProjectManifestV1, screenId: string): string[] {
  const screen = own(manifest.screens, screenId);
  if (!screen) return [];
  const runs = Object.values(manifest.runs);
  const rendering = runs.some(
    (run) =>
      run.status === "running" &&
      ((run.request.op === "refine" && run.request.screenId === screenId) ||
        run.revisionIds.some((id) => screen.revisionIds.includes(id))),
  );
  if (rendering) {
    throw new DesignStoreError("busy", `"${screen.title}" is being rendered. Wait for the design run to finish, or stop it first.`);
  }
  const deleted = [...screen.revisionIds];
  const deletedIds = new Set(deleted);
  for (const id of deleted) delete manifest.revisions[id];
  delete manifest.screens[screenId];
  manifest.canvas.nodes = manifest.canvas.nodes.filter((node) => node.screenId !== screenId);
  for (const set of Object.values(manifest.directionSets)) {
    set.screenIds = set.screenIds.filter((id) => id !== screenId);
    if (set.chosenScreenId === screenId) delete set.chosenScreenId;
  }
  for (const run of runs) run.revisionIds = run.revisionIds.filter((id) => !deletedIds.has(id));
  const set = screen.directionSetId === undefined ? undefined : own(manifest.directionSets, screen.directionSetId);
  if (set && set.screenIds.length === 0) {
    const filling = runs.some((run) => run.directionSetId === set.id && run.status === "running");
    if (!filling) dropDirectionSet(manifest, set.id);
  }
  for (const run of runs) {
    if ((run.status === "complete" || run.status === "partial") && run.revisionIds.length === 0) {
      delete manifest.runs[run.id];
    }
  }
  return deleted;
}

/** A run that ends with no design leaves no empty set behind, whichever run created it. */
function dropEmptyDirectionSet(manifest: DesignProjectManifestV1, run: DesignRunRecord): void {
  const set = directionSetForRun(manifest, run);
  if (set && set.screenIds.length === 0) dropDirectionSet(manifest, set.id);
}

export function publishRunDrafts(manifest: DesignProjectManifestV1, run: DesignRunRecord): void {
  let latest: string | undefined;
  for (const id of run.revisionIds) {
    const revision = own(manifest.revisions, id);
    if (revision?.state === "draft") revision.state = "published";
    if (revision?.state === "published") latest = id;
  }
  if (run.request.op === "refine" && latest !== undefined) {
    const screen = own(manifest.screens, run.request.screenId);
    if (screen?.revisionIds.includes(latest)) screen.activeRevisionId = latest;
  }
}

const OUTCOME_END_REASON: Record<DesignRunOutcome, DesignRunEndReason> = {
  completed: "short",
  cancelled: "stopped",
  failed: "provider_failed",
};

const NOTHING_ACCEPTED_STATUS: Record<DesignRunEndReason, DesignRunStatus> = {
  short: "failed",
  stopped: "cancelled",
  provider_failed: "failed",
  interrupted: "interrupted",
};

/**
 * End a running run inside a clone (owner decision 2026-10-07). Accepted designs
 * are always published: a run at its cap is complete and any other run with
 * designs is partial with its end reason. A run with none keeps no direction
 * set of its own.
 */
function endDesignRun(
  manifest: DesignProjectManifestV1,
  run: DesignRunRecord,
  reason: DesignRunEndReason,
  now: number,
): void {
  const accepted = run.revisionIds.length;
  delete run.endReason;
  if (accepted >= run.outputCap) {
    publishRunDrafts(manifest, run);
    run.status = "complete";
  } else if (accepted > 0) {
    publishRunDrafts(manifest, run);
    run.status = "partial";
    run.endReason = reason;
  } else {
    run.status = NOTHING_ACCEPTED_STATUS[reason];
    dropEmptyDirectionSet(manifest, run);
  }
  run.endedAt = Math.max(now, run.startedAt);
}

export function finishDesignRun(
  manifest: DesignProjectManifestV1,
  runId: string,
  outcome: DesignRunOutcome,
  now: number,
): DesignProjectManifestV1 | undefined {
  if (own(manifest.runs, runId)?.status !== "running") return undefined;
  const next = structuredClone(manifest);
  endDesignRun(next, next.runs[runId]!, OUTCOME_END_REASON[outcome], now);
  return touchDesignManifest(next, now);
}

export function reconcileDesignManifest(
  manifest: DesignProjectManifestV1,
  files: ReadonlyMap<string, number>,
  now: number,
): { manifest: DesignProjectManifestV1; changed: boolean } {
  const next = structuredClone(manifest);
  let changed = false;
  // Missing files first, so ending a run never publishes a design whose file is gone.
  for (const revision of Object.values(next.revisions)) {
    if (revision.state !== "missing" && files.get(revision.id) !== revision.bytes) {
      revision.state = "missing";
      changed = true;
    }
  }
  for (const run of Object.values(next.runs)) {
    if (run.status !== "running") continue;
    // Published as partial and never resubmitted: Resume is an explicit new run.
    endDesignRun(next, run, "interrupted", now);
    changed = true;
  }
  return changed ? { manifest: touchDesignManifest(next, now), changed } : { manifest, changed };
}

export function orphanRevisionIds(manifest: DesignProjectManifestV1, files: ReadonlyMap<string, number>): string[] {
  return [...files.keys()].filter((id) => !own(manifest.revisions, id)).sort();
}

export function markDesignRevisionMissing(
  manifest: DesignProjectManifestV1,
  revisionId: string,
  now: number,
): DesignProjectManifestV1 {
  const next = structuredClone(manifest);
  const revision = own(next.revisions, revisionId);
  if (revision) revision.state = "missing";
  return touchDesignManifest(next, now);
}

export function revisionIdForToolCall(manifest: DesignProjectManifestV1, toolCallId: string): string | undefined {
  for (const revision of Object.values(manifest.revisions)) {
    if (revision.toolCallId === toolCallId) return revision.id;
  }
  return undefined;
}

export function designProjectSummary(manifest: DesignProjectManifestV1): DesignProjectSummary {
  // A set that a restart left incomplete; Resume or Discard clears it.
  const interrupted = Object.values(manifest.directionSets).some((set) => {
    const latest = latestDesignRunForSet(manifest, set.id);
    return (
      latest !== undefined &&
      (latest.status === "interrupted" || latest.endReason === "interrupted") &&
      designResumeOffer(manifest, latest.id).ok
    );
  });
  return {
    id: manifest.id,
    title: manifest.title,
    updatedAt: manifest.updatedAt,
    screenCount: Object.keys(manifest.screens).length,
    bytes: designProjectBytes(manifest),
    health: interrupted ? "interrupted" : "ok",
  };
}

export function designDeletePreview(manifest: DesignProjectManifestV1): DesignDeletePreview {
  return {
    screens: Object.keys(manifest.screens).length,
    revisions: Object.keys(manifest.revisions).length,
    bytes: designProjectBytes(manifest),
    references: 0,
  };
}
