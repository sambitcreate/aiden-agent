import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";
import {
  AIDEN_FUSE_CONFIG,
  AIDEN_FUSE_VALUES,
  assertAidenFuseWire,
} from "./configure-electron-fuses.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("strict Electron fuse config closes model-controlled Node entry points", () => {
  assert.equal(AIDEN_FUSE_CONFIG.strictlyRequireAllFuses, true);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.RunAsNode], false);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot], false);
  assert.equal(AIDEN_FUSE_VALUES[FuseV1Options.WasmTrapHandlers], true);
  assert.equal(packageJson.build.electronFuses.loadBrowserProcessSpecificV8Snapshot, false);
});

test("fuse verifier rejects missing, added, and incorrectly flipped fuses", () => {
  const wire = { version: FuseVersion.V1 };
  for (const [index, enabled] of Object.entries(AIDEN_FUSE_VALUES)) {
    wire[index] = enabled ? FuseState.ENABLE : FuseState.DISABLE;
  }
  assert.doesNotThrow(() => assertAidenFuseWire(wire));
  assert.throws(() =>
    assertAidenFuseWire({ ...wire, [FuseV1Options.RunAsNode]: FuseState.ENABLE }),
  );
  const missing = { ...wire };
  delete missing[FuseV1Options.WasmTrapHandlers];
  assert.throws(() => assertAidenFuseWire(missing), /schema drifted/);
  assert.throws(() => assertAidenFuseWire({ ...wire, 9: FuseState.ENABLE }), /schema drifted/);
});
