// Shared by the design core tests. Not a test file: it asserts, it does not run.
import assert from "node:assert/strict";
import { MAX_DESIGN_PROJECT_BYTES } from "../../../renderer/shared/design/limits.js";
import type { DesignProjectManifestV1 } from "../../../renderer/shared/design/types.js";
import { parseDesignProjectManifestV1 } from "./manifest-core.js";

/**
 * Every manifest a transition produces must be one the DS-1a.2 parser accepts
 * unchanged, and must satisfy the invariants the parser leaves to the store.
 */
export function check(manifest: DesignProjectManifestV1): DesignProjectManifestV1 {
  assert.deepEqual(parseDesignProjectManifestV1(JSON.parse(JSON.stringify(manifest))), manifest, "re-parses unchanged");
  let declared = 0;
  for (const revision of Object.values(manifest.revisions)) declared += revision.bytes;
  assert.ok(declared <= MAX_DESIGN_PROJECT_BYTES, "project bytes within the quota");
  for (const set of Object.values(manifest.directionSets)) {
    assert.ok(set.screenIds.length <= set.requestedCount, "a set never exceeds its requested count");
    const filling = Object.values(manifest.runs).some((run) => run.directionSetId === set.id && run.status === "running");
    assert.ok(set.screenIds.length > 0 || filling, "an empty set exists only while its run is running");
  }
  for (const run of Object.values(manifest.runs)) {
    if (run.status === "partial") {
      assert.ok(run.revisionIds.length >= 1 && run.endReason !== undefined, "a partial run has a design and a reason");
    }
    if (run.status === "complete") assert.ok(run.revisionIds.length >= 1, "a complete run has a design");
  }
  return manifest;
}
