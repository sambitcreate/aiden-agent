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
  tag: "cua-driver-rs-v0.34.1",
  sourceCommit: "0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc",
  version: "0.34.1",
  platform: "darwin",
  architecture: "universal",
  asset: "cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.1/cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz",
  sha256: "52de49b5046df19245ad02ff9aa89ce9caf69e84988e1d0fac677611dd83e48c",
  binarySha256: "56bc881744bfb956d44386e6f6ccb2f6fc7f5cef47be25cc056e08265cdf4c7d",
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

// Per-slice SHA-256 CodeDirectory hashes (truncated to 20 bytes, as
// `codesign -dvvv --arch <arch>` prints `CDHash=`). The broker pins the slice
// it runs, and scripts/generate-cua-launch-requirement.mjs embeds both in the
// kernel launch constraint. Order is significant for byte-exact DER output.
export const CUA_DRIVER_CDHASHES = Object.freeze({
  arm64: "6553145ad98e84d4b70d223c94a74403f389dc99",
  x86_64: "17dcdcfd6ed7084835d9d16c36192a488c92c850",
});

// Upstream publishes a cosign (Sigstore) bundle next to each release asset.
// The archive SHA-256 above is the authority; this bundle is checked only by
// the explicit, optional `--verify-sigstore` vendor step (requires `cosign`).
export const CUA_DRIVER_SIGSTORE_BUNDLE = Object.freeze({
  url: `${CUA_DRIVER_ARTIFACT_PROVENANCE.url}.sigstore.json`,
  sha256: "414237a66ee436df0947420d026f103a2a3a8426daf71120b7e7d39d44e8f0f2",
  certificateIdentity: `https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${CUA_DRIVER_ARTIFACT_PROVENANCE.tag}`,
  certificateOidcIssuer: "https://token.actions.githubusercontent.com",
});

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
