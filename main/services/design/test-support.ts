// Shared by the design core tests. Not a test file: it asserts, it does not run.
import assert from "node:assert/strict";
import type { DesignProjectManifestV1 } from "../../../renderer/shared/design/types.js";
import { parseDesignProjectManifestV1 } from "./manifest-core.js";
import { assertDesignManifestWritable } from "./store-core.js";

/**
 * Every manifest a transition produces must be one the store would write: the DS-1a.2 parser
 * accepts it unchanged and the store invariants hold.
 */
export function check(manifest: DesignProjectManifestV1): DesignProjectManifestV1 {
  assert.deepEqual(parseDesignProjectManifestV1(JSON.parse(JSON.stringify(manifest))), manifest, "re-parses unchanged");
  assertDesignManifestWritable(manifest);
  return manifest;
}
