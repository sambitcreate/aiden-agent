// Pure application of one renderer project operation (ADR-DS §6 designProjects:mutate),
// plus the project-level guards the store applies before deleting or duplicating.
import { own } from "../../../renderer/shared/design/own.js";
import { designResumeOffer } from "../../../renderer/shared/design/resume.js";
import type {
  DesignDeletePreview,
  DesignProjectManifestV1,
  DesignProjectOp,
} from "../../../renderer/shared/design/types.js";
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
      `A design run is in progress. Stop it before you ${action === "delete" ? "delete" : "duplicate"} this project.`,
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
