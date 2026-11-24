import path from "node:path";
import { appleRequirement } from "./computer-use-signing-pins.mjs";

// The checked-in resources/bot-computers/lume-artifact.json is human-readable
// provenance only. These reviewed constants are the authority for every byte
// packaging may download, extract, or run. The runtime copy of the security
// values is compiled into main/services/bot-computers/lume-binary.ts, and
// lume-binary.test.ts fails when the two drift.
export const LUME_ARTIFACT_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  upstream: "https://github.com/trycua/cua",
  tag: "lume-v0.8.0",
  sourceCommit: "7812985eb6b45eed6fd44a347bc431780ed61542",
  version: "0.8.0",
  platform: "darwin",
  architecture: "arm64",
  asset: "lume-0.8.0-darwin-arm64.tar.gz",
  url: "https://github.com/trycua/cua/releases/download/lume-v0.8.0/lume-0.8.0-darwin-arm64.tar.gz",
  sha256: "65e695febc92284960b87ffabffaf5f1fba75c3a5bdf756439648abcaeeb0049",
  maxArchiveBytes: 67_108_864,
  appBundle: "lume.app",
  bundleIdentifier: "com.trycua.lume",
  bundleVersion: "0.8.0",
  binaryPath: "lume.app/Contents/MacOS/lume",
  binarySha256: "0a51a37a11b94f82f431f259cf4437f2b2fac52881b16c44de94e081c8e98955",
  binaryBytes: 21_890_832,
  upstreamSigningTeamId: "YCK386LBJ7",
  license: "MIT",
  releaseChannel: "stable",
});

export const LUME_ARTIFACT_KEYS = Object.freeze(Object.keys(LUME_ARTIFACT_PROVENANCE));

/** The 67-byte `sh` wrapper beside the bundle. It is listed but never extracted. */
export const LUME_WRAPPER_MEMBER = "lume";

/**
 * Exact `tar -tzf` listing of the pinned release archive (order-insensitive).
 * Directories carry their trailing slash as stored. Anything else is refused.
 */
export const LUME_ARCHIVE_MEMBERS = Object.freeze([
  "lume",
  "lume.app/",
  "lume.app/Contents/",
  "lume.app/Contents/CodeResources",
  "lume.app/Contents/_CodeSignature/",
  "lume.app/Contents/MacOS/",
  "lume.app/Contents/Resources/",
  "lume.app/Contents/embedded.provisionprofile",
  "lume.app/Contents/Info.plist",
  "lume.app/Contents/Resources/AppIcon.icns",
  "lume.app/Contents/Resources/lume_lume.bundle/",
  "lume.app/Contents/Resources/lume_lume.bundle/unattended-presets/",
  "lume.app/Contents/Resources/lume_lume.bundle/unattended-presets/tahoe.yml",
  "lume.app/Contents/Resources/lume_lume.bundle/unattended-presets/sequoia.yml",
  "lume.app/Contents/MacOS/lume",
  "lume.app/Contents/_CodeSignature/CodeResources",
]);

/** `type:relative/path` entries of the extracted bundle, relative to lume.app, sorted. */
export const LUME_APP_TREE = Object.freeze(
  LUME_ARCHIVE_MEMBERS.filter((member) => member.startsWith(`${LUME_ARTIFACT_PROVENANCE.appBundle}/`))
    .map((member) => member.slice(LUME_ARTIFACT_PROVENANCE.appBundle.length + 1))
    .filter((member) => member.length > 0)
    .map((member) =>
      member.endsWith("/")
        ? `directory:${member.slice(0, -1).split("/").join(path.sep)}`
        : `file:${member.split("/").join(path.sep)}`,
    )
    .sort(),
);

/**
 * Entitlements the upstream signature carries. `virtualization` lets it run
 * VMs; `vm.networking` is the restricted entitlement its embedded provisioning
 * profile authorizes. Re-signing with Aiden's identity would drop both.
 */
export const LUME_ENTITLEMENTS = Object.freeze([
  "com.apple.security.virtualization",
  "com.apple.vm.networking",
]);

/** Environment every Lume child gets, in packaging and at runtime. */
export const LUME_PRIVACY_ENVIRONMENT = Object.freeze({
  LUME_TELEMETRY_ENABLED: "false",
  LUME_UPDATE_CHECK: "false",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
});

export function lumeRequirement() {
  return appleRequirement({
    identifier: LUME_ARTIFACT_PROVENANCE.bundleIdentifier,
    teamId: LUME_ARTIFACT_PROVENANCE.upstreamSigningTeamId,
  });
}

export function assertLumeArtifactProvenance(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("The Lume provenance must be a JSON object.");
  }
  const actualKeys = Object.keys(artifact).sort();
  const expectedKeys = [...LUME_ARTIFACT_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`The Lume provenance keys differ from the compiled set: ${actualKeys.join(", ")}`);
  }
  for (const field of LUME_ARTIFACT_KEYS) {
    if (artifact[field] !== LUME_ARTIFACT_PROVENANCE[field]) {
      throw new Error(`The Lume provenance field '${field}' differs from its compiled pin.`);
    }
  }
  return LUME_ARTIFACT_PROVENANCE;
}

/** Where packaging places Lume inside Aiden Agent.app. */
export function packagedLumePaths(appPath) {
  const resolvedApp = path.resolve(appPath);
  const lumeApp = path.join(resolvedApp, "Contents", "Helpers", LUME_ARTIFACT_PROVENANCE.appBundle);
  const resources = path.join(resolvedApp, "Contents", "Resources", "bot-computers");
  return Object.freeze({
    app: resolvedApp,
    lumeApp,
    infoPlist: path.join(lumeApp, "Contents", "Info.plist"),
    binary: path.join(lumeApp, "Contents", "MacOS", "lume"),
    provisioningProfile: path.join(lumeApp, "Contents", "embedded.provisionprofile"),
    outerProvenance: path.join(resources, "lume-artifact.json"),
    outerLicenseNotice: path.join(resources, "LICENSE.lume.md"),
  });
}

/** True for the Lume bundle and everything inside it: packaging must never re-sign them. */
export function isPackagedLumePath(appPath, file) {
  const { lumeApp } = packagedLumePaths(appPath);
  const resolved = path.resolve(file);
  return resolved === lumeApp || resolved.startsWith(`${lumeApp}${path.sep}`);
}
