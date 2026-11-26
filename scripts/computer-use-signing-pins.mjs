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
  tag: "cua-driver-rs-v0.38.0",
  sourceCommit: "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19",
  version: "0.38.0",
  platform: "darwin",
  architecture: "universal",
  asset: "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
  archiveBytes: 53_208_248,
  sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
  binaryBytes: 80_571_376,
  binarySha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
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

// Linux arm64 guest driver pin for Bot computers (Debian 13 arm64 in Lume).
// Same upstream tag and source commit as the macOS universal artifact above.
export const CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  upstream: "https://github.com/trycua/cua",
  tag: "cua-driver-rs-v0.38.0",
  sourceCommit: "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19",
  version: "0.38.0",
  platform: "linux",
  architecture: "arm64",
  asset: "cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
  archiveBytes: 36_674_648,
  sha256: "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
  binaryBytes: 56_512_184,
  binarySha256: "26e9eee8165e9ce7b614b5e3d68e5d963231385a82b65236406718b5ce1ff936",
  license: "MIT",
  releaseChannel: "pre-release",
});

export const CUA_DRIVER_LINUX_ARM64_ARTIFACT_KEYS = Object.freeze(
  Object.keys(CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE),
);
export const CUA_DRIVER_LINUX_ARM64_SHA256 =
  CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE.binarySha256;

// Per-slice SHA-256 CodeDirectory hashes (truncated to 20 bytes, as
// `codesign -dvvv --arch <arch>` prints `CDHash=`). The broker pins the slice
// it runs, and scripts/generate-cua-launch-requirement.mjs embeds both in the
// kernel launch constraint. Order is significant for byte-exact DER output.
export const CUA_DRIVER_CDHASHES = Object.freeze({
  arm64: "b067c86ef1ca3e63a8c86eba9fe29d61bd00ad68",
  x86_64: "a273d47d66883acc9583285e0089b65478e21434",
});

// Upstream publishes a cosign (Sigstore) bundle next to each release asset.
// The archive SHA-256 above is the authority; this bundle is checked only by
// the explicit, optional `--verify-sigstore` vendor step (requires `cosign`).
export const CUA_DRIVER_SIGSTORE_BUNDLE = Object.freeze({
  url: `${CUA_DRIVER_ARTIFACT_PROVENANCE.url}.sigstore.json`,
  sha256: "8f43c122bcc719f8d95478265e286195fa0b6407a68457e21f7deefcd7488085",
  certificateIdentity: `https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${CUA_DRIVER_ARTIFACT_PROVENANCE.tag}`,
  certificateOidcIssuer: "https://token.actions.githubusercontent.com",
});

export const CUA_DRIVER_LINUX_ARM64_SIGSTORE_BUNDLE = Object.freeze({
  url: `${CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE.url}.sigstore.json`,
  sha256: "d6c0d3cfc225a04ea466eb0fa00c5cba6b6ee23644035903e749bd6b8304fb92",
  certificateIdentity: `https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE.tag}`,
  certificateOidcIssuer: "https://token.actions.githubusercontent.com",
});

function assertProvenanceMatch(artifact, expected, keys, label) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`The ${label} provenance must be a JSON object.`);
  }
  const actualKeys = Object.keys(artifact).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `The ${label} provenance keys differ from the compiled set: ${actualKeys.join(", ")}`,
    );
  }
  for (const field of keys) {
    if (artifact[field] !== expected[field]) {
      throw new Error(`The ${label} provenance field '${field}' differs from its compiled pin.`);
    }
  }
  return expected;
}

export function assertCuaDriverArtifactProvenance(artifact) {
  return assertProvenanceMatch(
    artifact,
    CUA_DRIVER_ARTIFACT_PROVENANCE,
    CUA_DRIVER_ARTIFACT_KEYS,
    "cua-driver",
  );
}

export function assertCuaDriverLinuxArm64ArtifactProvenance(artifact) {
  return assertProvenanceMatch(
    artifact,
    CUA_DRIVER_LINUX_ARM64_ARTIFACT_PROVENANCE,
    CUA_DRIVER_LINUX_ARM64_ARTIFACT_KEYS,
    "cua-driver linux-arm64",
  );
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
