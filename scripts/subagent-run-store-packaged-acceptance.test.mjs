import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRebootMigrationFixture } from "./subagent-run-store-packaged-acceptance.mjs";

test("packaged reboot fixture binds unchanged V1 bytes to a deliberately stale native generation", () => {
  const fixture = createRebootMigrationFixture();
  const v1 = JSON.parse(fixture.v1);
  const v2 = JSON.parse(fixture.v2);

  assert.deepEqual(v1, { version: 1, runs: [], pendingChatDeletions: [] });
  assert.equal(v2.migration.status, "committed");
  assert.equal(v2.migration.source, "v1");
  assert.equal(v2.migration.sourceGeneration, fixture.mismatchedGeneration);
  assert.match(fixture.mismatchedGeneration, /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u);
  assert.equal(v2.migration.sourceSha256, createHash("sha256").update(fixture.v1).digest("hex"));
});
