import path from "node:path";
import { chmod, readdir, stat } from "node:fs/promises";
import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

export const AIDEN_FUSE_VALUES = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Electron 43 ships only the shared v8_context_snapshot. Enabling this fuse
  // without a separately generated browser_v8_context_snapshot makes the app
  // fail before JavaScript starts; it is not a model-facing Node capability.
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // Production currently loads its renderer from file://. Keep only the
  // compatibility privileges that path requires until it moves to a custom
  // protocol; all model-controlled Node entry points are disabled above.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  // Explicit bounds checks are slower and do not harden Aiden's Node entry
  // points. Retain Electron's supported trap handler on 64-bit macOS.
  [FuseV1Options.WasmTrapHandlers]: true,
});

export const AIDEN_FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: false,
  ...AIDEN_FUSE_VALUES,
});

export function assertAidenFuseWire(wire) {
  if (wire.version !== FuseVersion.V1) {
    throw new Error(`Unexpected Electron fuse version: ${String(wire.version)}`);
  }
  const configuredIndexes = Object.keys(AIDEN_FUSE_VALUES)
    .map(Number)
    .sort((a, b) => a - b);
  const actualIndexes = Object.keys(wire)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((a, b) => a - b);
  if (JSON.stringify(actualIndexes) !== JSON.stringify(configuredIndexes)) {
    throw new Error(
      `Electron fuse schema drifted: expected [${configuredIndexes}], received [${actualIndexes}]`,
    );
  }
  for (const [index, enabled] of Object.entries(AIDEN_FUSE_VALUES)) {
    const expectedState = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (wire[index] !== expectedState) {
      throw new Error(
        `${FuseV1Options[Number(index)]} has state ${String(wire[index])}; expected ${String(expectedState)}`,
      );
    }
  }
}

export async function verifyAidenFuses(appPath) {
  const wire = await getCurrentFuseWire(appPath);
  assertAidenFuseWire(wire);
}

/**
 * Make node-pty's `spawn-helper` executable inside a packaged macOS app.
 *
 * node-pty 1.1.0's npm prebuilt tarball restores the helper without its
 * execute bit, and `posix_spawn` of a non-executable file is exactly what
 * surfaces to users as `posix_spawnp failed.` the first time they open the
 * terminal drawer. electron-builder unpacks node-pty (`asarUnpack`) into
 * `app.asar.unpacked`, so we walk that tree, chmod each helper, and verify.
 * A broken build must fail here in CI rather than at the user's first PTY.
 */
export async function makeSpawnHelpersExecutable(appPath) {
  const nodePtyPrebuilds = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  let archDirs;
  try {
    archDirs = await readdir(nodePtyPrebuilds, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return; // No node-pty in this package layout.
    throw error;
  }
  let fixedAny = false;
  for (const entry of archDirs) {
    if (!entry.isDirectory()) continue;
    const helper = path.join(nodePtyPrebuilds, entry.name, "spawn-helper");
    let info;
    try {
      info = await stat(helper);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // This prebuild ships no helper.
      throw error;
    }
    if (!info.isFile()) continue;
    if ((info.mode & 0o111) === 0) {
      await chmod(helper, 0o755);
    }
    const after = await stat(helper);
    if ((after.mode & 0o111) === 0) {
      throw new Error(
        `node-pty spawn-helper is not executable after packaging (${helper}). The prebuilt archive may be corrupt; reinstall node-pty.`,
      );
    }
    fixedAny = true;
  }
  if (!fixedAny) {
    throw new Error(
      `No node-pty spawn-helper was found under ${nodePtyPrebuilds}. Terminal creation will fail with "posix_spawnp failed." unless node-pty ships a helper.`,
    );
  }
}

export async function configureElectronFuses(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await flipFuses(appPath, AIDEN_FUSE_CONFIG);
  await verifyAidenFuses(appPath);
  await makeSpawnHelpersExecutable(appPath);
}

export default configureElectronFuses;
