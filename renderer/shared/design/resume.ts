// Resume of an incomplete direction set (owner decision 2026-10-07). Shared so
// main's planDesignRun and the renderer's cost disclosure compute the same cap,
// existing titles and default model from one manifest.
import type {
  DesignModelRef,
  DesignProjectManifestV1,
  DesignRunRecord,
  DesignRunStatus,
} from "./types.js";

/** Runs that may be resumed or discarded when they are the newest run of an incomplete set. */
const RESUMABLE: ReadonlySet<DesignRunStatus> = new Set(["partial", "interrupted", "cancelled", "failed"]);

/** Ids are untrusted keys: "constructor" is a valid id and must never resolve to an inherited member. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Direction titles compare without case or whitespace. */
export function designDirectionTitleKey(title: string): string {
  return title.replace(/\s+/gu, "").toLowerCase();
}

/** The newest run that fills a direction set: its original Explore or the last Resume. */
export function latestDesignRunForSet(
  manifest: DesignProjectManifestV1,
  directionSetId: string,
): DesignRunRecord | undefined {
  let latest: DesignRunRecord | undefined;
  for (const run of Object.values(manifest.runs)) {
    // Ties keep insertion order: a run record is always added after the runs before it.
    if (run.directionSetId === directionSetId && (!latest || run.startedAt >= latest.startedAt)) latest = run;
  }
  return latest;
}

export type DesignResumeOffer =
  | {
      ok: true;
      runId: string;
      directionSetId: string;
      /** requestedCount − screenIds.length, read from the manifest when asked. */
      cap: number;
      existingTitles: string[];
      /** The model that rendered the set's newest direction; a Resume defaults to it. */
      model?: DesignModelRef;
    }
  | { ok: false; reason: string };

export function designResumeOffer(manifest: DesignProjectManifestV1, runId: string): DesignResumeOffer {
  const run = own(manifest.runs, runId);
  const set = run?.directionSetId === undefined ? undefined : own(manifest.directionSets, run.directionSetId);
  if (!run || run.kind !== "explore" || !set) {
    return { ok: false, reason: "Only an Explore run that kept at least one direction can be resumed or discarded." };
  }
  if (set.archived) return { ok: false, reason: "This direction set was discarded." };
  if (latestDesignRunForSet(manifest, set.id)?.id !== run.id) {
    return { ok: false, reason: "Only the newest run of a direction set can be resumed or discarded." };
  }
  if (run.status === "running") return { ok: false, reason: "Wait for the design run to finish." };
  const cap = set.requestedCount - set.screenIds.length;
  if (cap < 1) return { ok: false, reason: "Every requested direction already exists." };
  if (!RESUMABLE.has(run.status)) return { ok: false, reason: "This run already completed." };
  const existingTitles: string[] = [];
  let model: DesignModelRef | undefined;
  let newest = Number.NEGATIVE_INFINITY;
  for (const screenId of set.screenIds) {
    const screen = own(manifest.screens, screenId);
    if (!screen) continue;
    existingTitles.push(screen.title);
    // A direction's first revision is the one Explore rendered; later ones are Refines.
    const direction = own(manifest.revisions, screen.revisionIds[0]!);
    if (direction && direction.createdAt >= newest) {
      newest = direction.createdAt;
      model = { ...direction.model };
    }
  }
  return { ok: true, runId: run.id, directionSetId: set.id, cap, existingTitles, ...(model ? { model } : {}) };
}
