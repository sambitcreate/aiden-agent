import path from "node:path";

export const AIDEN_APP_BUNDLE_ID = "com.sambitcreate.aiden-agent";
export const AIDEN_COMPUTER_USE_BUNDLE_ID = "com.sambitcreate.aiden-agent.cua-driver";
export const AIDEN_SIGNING_TEAM_ID = "5WP229CBB8";
export const CUA_DRIVER_HELPER_EXECUTABLE = "aiden-cua-broker";

// The checked-in JSON file is human-readable provenance only. These reviewed
// constants remain the authority for every byte that may be downloaded or
// executed during packaging.
export const CUA_DRIVER_ARTIFACT_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  upstream: "https://github.com/trycua/cua",
  tag: "cua-driver-rs-v0.8.3",
  sourceCommit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f",
  version: "0.8.3",
  platform: "darwin",
  architecture: "universal",
  asset: "cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz",
  sha256: "a2a29f3ccbd45989819df639d60fa68ac6f28b844f74d7d2b0a1495e4359c6a1",
  binarySha256: "c1c015ccceda4880b9e171dc438700a8276af0eeecfdf0bb4b3fb23298ae7305",
  upstreamSigningIdentifier: "cua-driver",
  upstreamSigningTeamId: "YCK386LBJ7",
  license: "MIT",
  releaseChannel: "pre-release",
});

export const CUA_DRIVER_ARTIFACT_KEYS = Object.freeze(Object.keys(CUA_DRIVER_ARTIFACT_PROVENANCE));
export const CUA_DRIVER_SHA256 = CUA_DRIVER_ARTIFACT_PROVENANCE.binarySha256;
export const CUA_DRIVER_SIGNING_IDENTIFIER =
  CUA_DRIVER_ARTIFACT_PROVENANCE.upstreamSigningIdentifier;
export const CUA_DRIVER_SIGNING_TEAM_ID = CUA_DRIVER_ARTIFACT_PROVENANCE.upstreamSigningTeamId;

export function assertCuaDriverArtifactProvenance(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("The cua-driver provenance must be a JSON object.");
  }
  const actualKeys = Object.keys(artifact).sort();
  const expectedKeys = [...CUA_DRIVER_ARTIFACT_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `The cua-driver provenance keys differ from the compiled set: ${actualKeys.join(", ")}`,
    );
  }
  for (const field of CUA_DRIVER_ARTIFACT_KEYS) {
    if (artifact[field] !== CUA_DRIVER_ARTIFACT_PROVENANCE[field]) {
      throw new Error(`The cua-driver provenance field '${field}' differs from its compiled pin.`);
    }
  }
  return CUA_DRIVER_ARTIFACT_PROVENANCE;
}

export function packagedComputerUsePaths(appPath) {
  const resolvedApp = path.resolve(appPath);
  const helperApp = path.join(resolvedApp, "Contents", "Helpers", "CuaDriver.app");
  return Object.freeze({
    app: resolvedApp,
    helperApp,
    helperInfoPlist: path.join(helperApp, "Contents", "Info.plist"),
    broker: path.join(helperApp, "Contents", "MacOS", CUA_DRIVER_HELPER_EXECUTABLE),
    driver: path.join(helperApp, "Contents", "MacOS", "cua-driver"),
    helperProvenance: path.join(helperApp, "Contents", "Resources", "cua-driver-artifact.json"),
    helperLicenseNotice: path.join(helperApp, "Contents", "Resources", "LICENSE.cua-driver.md"),
    outerProvenance: path.join(
      resolvedApp,
      "Contents",
      "Resources",
      "computer-use",
      "cua-driver-artifact.json",
    ),
    outerLicenseNotice: path.join(
      resolvedApp,
      "Contents",
      "Resources",
      "computer-use",
      "LICENSE.cua-driver.md",
    ),
    electronExecutable: path.join(resolvedApp, "Contents", "MacOS", "Aiden Agent"),
  });
}

export function appleRequirement({ identifier, teamId }) {
  const identifierClause = identifier ? ` and identifier "${identifier}"` : "";
  return `anchor apple generic${identifierClause} and certificate leaf[subject.OU] = "${teamId}"`;
}
