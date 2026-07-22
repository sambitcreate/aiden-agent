import path from "node:path";
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

export async function configureElectronFuses(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await flipFuses(appPath, AIDEN_FUSE_CONFIG);
  await verifyAidenFuses(appPath);
}

export default configureElectronFuses;
