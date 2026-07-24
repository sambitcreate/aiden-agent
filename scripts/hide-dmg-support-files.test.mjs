import assert from "node:assert/strict";
import test from "node:test";
import { isDmgArtifact } from "./hide-dmg-support-files.mjs";

test("DMG metadata finalization runs only for DMG artifacts", () => {
  assert.equal(isDmgArtifact({ file: "/tmp/Aiden Agent.dmg" }), true);
  assert.equal(isDmgArtifact({ file: "/tmp/Aiden Agent.zip" }), false);
  assert.equal(isDmgArtifact({ file: 42 }), false);
  assert.equal(isDmgArtifact({}), false);
});
