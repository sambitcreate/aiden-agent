// Pure application of one renderer project operation (ADR-DS §6 designProjects:mutate),
// plus the project-level guards the store applies before deleting or duplicating.
import { MAX_DESIGN_PROJECT_TITLE_CHARS } from "../../../renderer/shared/design/limits.js";
import { own } from "../../../renderer/shared/design/own.js";
import { designResumeOffer } from "../../../renderer/shared/design/resume.js";
import type {
  DesignDeletePreview,
  DesignProjectManifestV1,
  DesignProjectOp,
  DesignRunRecord,
  DesignRunRequest,
} from "../../../renderer/shared/design/types.js";
import { createDesignProjectManifest } from "./manifest-core.js";
import { DesignStoreError, removeDesignScreen, touchDesignManifest } from "./store-core.js";

const invalid = (message: string) => new DesignStoreError("invalid", message);

/**
 * Deleting or duplicating a project while a run renders would race the run's writes
 * (and a delete would deadlock against the run's own cancel), so both wait for it.
 */
export function assertDesignProjectIdle(manifest: DesignProjectManifestV1, action: "delete" | "duplicate"): void {
  if (Object.values(manifest.runs).some((run) => run.status === "running")) {
    throw new DesignStoreError(
      "busy",
      `A design run is in progress. Stop it before you ${action} this project.`,
    );
  }
}

/** What the library shows before it deletes a project whose manifest cannot be read. */
export function unreadableDesignDeletePreview(): DesignDeletePreview {
  return { screens: 0, revisions: 0, bytes: 0, references: 0, unreadable: true };
}

export function applyDesignProjectOp(
  manifest: DesignProjectManifestV1,
  op: DesignProjectOp,
  now: number,
): { manifest: DesignProjectManifestV1; deletedRevisionIds: string[] } {
  if (manifest.state !== "active") {
    throw new DesignStoreError("not_found", "This design project is being deleted.");
  }
  const next = structuredClone(manifest);
  let deletedRevisionIds: string[] = [];
  switch (op.op) {
    case "rename":
      next.title = op.title;
      break;
    case "setLayout": {
      next.canvas.viewport = { ...op.viewport };
      for (const update of op.nodes) {
        const node = next.canvas.nodes.find((candidate) => candidate.id === update.id);
        if (!node) throw invalid("A moved Screen no longer exists.");
        node.x = update.x;
        node.y = update.y;
      }
      break;
    }
    case "setActiveRevision": {
      const screen = own(next.screens, op.screenId);
      const revision = own(next.revisions, op.revisionId);
      if (!screen || !revision || revision.screenId !== screen.id) {
        throw invalid("That revision does not belong to this Screen.");
      }
      if (revision.state !== "published") {
        throw invalid(
          revision.state === "missing"
            ? "That revision's file is missing."
            : "This draft is still being generated. Wait for the design run to finish.",
        );
      }
      screen.activeRevisionId = revision.id;
      break;
    }
    case "setScreenFrame": {
      const screen = own(next.screens, op.screenId);
      if (!screen) throw invalid("That Screen no longer exists.");
      screen.frame = { ...op.frame };
      break;
    }
    case "chooseDirection": {
      const set = own(next.directionSets, op.directionSetId);
      if (!set || !set.screenIds.includes(op.screenId)) {
        throw invalid("That Screen is not part of this direction set.");
      }
      set.chosenScreenId = op.screenId;
      break;
    }
    case "archiveDirectionSet": {
      const set = own(next.directionSets, op.directionSetId);
      if (!set) throw invalid("That direction set no longer exists.");
      // Archive only hides; it never frees quota (owner decision 4).
      set.archived = op.archived;
      break;
    }
    case "deleteScreen":
      // removeDesignScreen owns the busy refusal and the set, run and canvas cleanup.
      deletedRevisionIds = removeDesignScreen(next, op.screenId);
      if (deletedRevisionIds.length === 0) throw invalid("That Screen no longer exists.");
      break;
    case "settleRun": {
      // Discard gives up on Resume: the incomplete set is archived, its published
      // directions stay, nothing is deleted and no quota is freed (owner decisions
      // of 2026-10-07). The same offer rules as Resume decide what can be discarded.
      const offer = designResumeOffer(next, op.runId);
      if (!offer.ok) throw invalid(offer.reason);
      own(next.directionSets, offer.directionSetId)!.archived = true;
      break;
    }
  }
  return { manifest: touchDesignManifest(next, now), deletedRevisionIds };
}

function duplicateTitle(title: string): string {
  const suffix = " copy";
  let head = title.slice(0, MAX_DESIGN_PROJECT_TITLE_CHARS - suffix.length);
  // Never cut a surrogate pair in half: a lone surrogate is not a title the parser accepts.
  if (/[\ud800-\udbff]$/u.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}${suffix}`;
}

export interface DesignProjectCopy {
  manifest: DesignProjectManifestV1;
  /** Source revision id to the copy's revision id. The store copies the file of each one the copy does not mark missing. */
  revisionIds: ReadonlyMap<string, string>;
}

/**
 * Build the manifest of a duplicated project (ADR-DS §2), purely. The copy is its own project:
 * the project, its hidden chat, and every Screen, revision, direction set, run, canvas node and
 * turn get fresh ids, so it shares no identity or run state with its source. The source must be
 * idle, so no running run is copied. A revision whose file the store could not verify
 * (`intactRevisionIds`) is copied as missing rather than carrying damage forward.
 *
 * Known limitation: Resume is not offered on a copy. A Resume repeats the brief held in the
 * source's hidden chat, which a copy does not have, so the runs that filled a set that is still
 * short of its directions are detached from it. The copy keeps those directions and shows no
 * Resume or interrupted notice for them.
 */
export function buildDesignProjectCopy(
  source: DesignProjectManifestV1,
  input: { newId: () => string; now: number; intactRevisionIds: ReadonlySet<string> },
): DesignProjectCopy {
  if (source.state !== "active") throw new DesignStoreError("not_found", "This design project is being deleted.");
  assertDesignProjectIdle(source, "duplicate");
  const screens = new Map<string, string>();
  const revisions = new Map<string, string>();
  const sets = new Map<string, string>();
  const runs = new Map<string, string>();
  const nodes = new Map<string, string>();
  for (const [ids, record] of [
    [screens, source.screens],
    [revisions, source.revisions],
    [sets, source.directionSets],
    [runs, source.runs],
  ] as const) {
    for (const id of Object.keys(record)) ids.set(id, input.newId());
  }
  for (const node of source.canvas.nodes) nodes.set(node.id, input.newId());
  // Ids a trimmed run or a deleted base left dangling keep their old spelling: lineage tolerates a missing target.
  const remap = (ids: ReadonlyMap<string, string>, id: string) => ids.get(id) ?? id;

  const copy = createDesignProjectManifest({
    id: input.newId(),
    chatId: input.newId(),
    title: duplicateTitle(source.title),
    now: input.now,
  });
  copy.canvas.viewport = { ...source.canvas.viewport };
  copy.canvas.nodes = source.canvas.nodes.map((node) => ({
    ...node,
    id: remap(nodes, node.id),
    screenId: remap(screens, node.screenId),
  }));
  for (const screen of Object.values(source.screens)) {
    const id = remap(screens, screen.id);
    copy.screens[id] = {
      ...structuredClone(screen),
      id,
      revisionIds: screen.revisionIds.map((revisionId) => remap(revisions, revisionId)),
      activeRevisionId: remap(revisions, screen.activeRevisionId),
      ...(screen.directionSetId === undefined ? {} : { directionSetId: remap(sets, screen.directionSetId) }),
    };
  }
  for (const revision of Object.values(source.revisions)) {
    const id = remap(revisions, revision.id);
    const intact = revision.state !== "missing" && input.intactRevisionIds.has(revision.id);
    copy.revisions[id] = {
      ...structuredClone(revision),
      id,
      screenId: remap(screens, revision.screenId),
      runId: remap(runs, revision.runId),
      ...(revision.parentRevisionId === undefined ? {} : { parentRevisionId: remap(revisions, revision.parentRevisionId) }),
      state: intact ? revision.state : "missing",
    };
  }
  for (const set of Object.values(source.directionSets)) {
    const id = remap(sets, set.id);
    copy.directionSets[id] = {
      ...structuredClone(set),
      id,
      runId: remap(runs, set.runId),
      screenIds: set.screenIds.map((screenId) => remap(screens, screenId)),
      ...(set.chosenScreenId === undefined ? {} : { chosenScreenId: remap(screens, set.chosenScreenId) }),
    };
  }
  for (const run of Object.values(source.runs)) {
    const id = remap(runs, run.id);
    const set = run.directionSetId === undefined ? undefined : own(source.directionSets, run.directionSetId);
    const copied: DesignRunRecord = {
      ...structuredClone(run),
      id,
      turnId: input.newId(),
      request: remapRunRequest(run.request, { screens, revisions, runs }),
      revisionIds: run.revisionIds.map((revisionId) => remap(revisions, revisionId)),
    };
    // The brief lives in the source's chat, so the copy keeps no pointer to it.
    delete copied.promptMessageId;
    if (set && set.screenIds.length >= set.requestedCount) copied.directionSetId = remap(sets, set.id);
    else delete copied.directionSetId;
    copy.runs[id] = copied;
  }
  return { manifest: copy, revisionIds: revisions };
}

function remapRunRequest(
  request: DesignRunRequest,
  ids: { screens: ReadonlyMap<string, string>; revisions: ReadonlyMap<string, string>; runs: ReadonlyMap<string, string> },
): DesignRunRequest {
  if (request.op === "refine") {
    return {
      ...request,
      screenId: ids.screens.get(request.screenId) ?? request.screenId,
      baseRevisionId: ids.revisions.get(request.baseRevisionId) ?? request.baseRevisionId,
    };
  }
  const next = structuredClone(request);
  if (next.baseRevisionId !== undefined) next.baseRevisionId = ids.revisions.get(next.baseRevisionId) ?? next.baseRevisionId;
  if (next.resumeRunId !== undefined) next.resumeRunId = ids.runs.get(next.resumeRunId) ?? next.resumeRunId;
  return next;
}
