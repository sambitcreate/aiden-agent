import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";
import {
  AIDEN_FUSE_CONFIG,
  AIDEN_FUSE_VALUES,
  assertAidenFuseWire,
  makeSpawnHelpersExecutable,
  packagedElectronExecutable,
  packagedResourcesDirectory,
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

async function buildFakeAppWithHelper(helperMode) {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-"));
  const prebuilds = path.join(
    appDir,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
  );
  await mkdir(prebuilds, { recursive: true });
  const helper = path.join(prebuilds, "spawn-helper");
  const handle = await open(helper, "w", helperMode);
  await handle.close();
  return { appDir, helper };
}

test("makeSpawnHelpersExecutable chmods a non-executable spawn-helper to 0755", async () => {
  const { appDir, helper } = await buildFakeAppWithHelper(0o644);
  try {
    await makeSpawnHelpersExecutable(appDir);
    const { mode } = await stat(helper);
    assert.notEqual(mode & 0o111, 0, "helper should be executable after afterPack");
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("makeSpawnHelpersExecutable throws when no spawn-helper ships", async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-empty-"));
  const prebuilds = path.join(
    appDir,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
  );
  await mkdir(prebuilds, { recursive: true });
  try {
    await assert.rejects(makeSpawnHelpersExecutable(appDir), /No node-pty spawn-helper/u);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("makeSpawnHelpersExecutable is a no-op when node-pty is absent", async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-noop-"));
  try {
    // No app.asar.unpacked tree at all: must not throw.
    await makeSpawnHelpersExecutable(appDir);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("Linux package paths target the native executable and resources tree", () => {
  const context = {
    electronPlatformName: "linux",
    appOutDir: "/tmp/aiden/linux-unpacked",
    packager: {
      appInfo: { productFilename: "Aiden Agent" },
      config: { linux: { executableName: "aiden-agent" } },
      platformSpecificBuildOptions: { executableName: "aiden-agent" },
    },
  };
  assert.equal(
    packagedElectronExecutable(context),
    "/tmp/aiden/linux-unpacked/aiden-agent",
  );
  assert.equal(
    packagedResourcesDirectory(context.appOutDir, "linux"),
    "/tmp/aiden/linux-unpacked/resources",
  );
});

test("makeSpawnHelpersExecutable supports Linux's unpacked resource layout", async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-linux-"));
  const prebuilds = path.join(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    "linux-x64",
  );
  await mkdir(prebuilds, { recursive: true });
  const helper = path.join(prebuilds, "spawn-helper");
  const handle = await open(helper, "w", 0o644);
  await handle.close();
  try {
    await makeSpawnHelpersExecutable(appDir, "linux");
    assert.notEqual((await stat(helper)).mode & 0o111, 0);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("makeSpawnHelpersExecutable supports Linux node-gyp build output", async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-linux-build-"));
  const release = path.join(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  await mkdir(release, { recursive: true });
  const helper = path.join(release, "spawn-helper");
  const handle = await open(helper, "w", 0o644);
  await handle.close();
  try {
    await makeSpawnHelpersExecutable(appDir, "linux");
    assert.notEqual((await stat(helper)).mode & 0o111, 0);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

test("makeSpawnHelpersExecutable accepts Linux node-pty without a macOS-only helper", async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), "fuses-pty-linux-no-helper-"));
  const release = path.join(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  await mkdir(release, { recursive: true });
  const moduleHandle = await open(path.join(release, "pty.node"), "w", 0o644);
  await moduleHandle.close();
  try {
    await assert.doesNotReject(makeSpawnHelpersExecutable(appDir, "linux"));
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});
