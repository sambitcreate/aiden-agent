/* global Buffer, console, process */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFile, getRawHeader, listPackage, statFile, uncache } from "@electron/asar";
import {
  AIDEN_APP_BUNDLE_ID,
  AIDEN_COMPUTER_USE_BUNDLE_ID,
  AIDEN_SIGNING_TEAM_ID,
  CUA_DRIVER_HELPER_EXECUTABLE,
  CUA_DRIVER_SHA256,
  CUA_DRIVER_SIGNING_IDENTIFIER,
  CUA_DRIVER_SIGNING_TEAM_ID,
  appleRequirement,
  assertCuaDriverArtifactProvenance,
  packagedComputerUsePaths,
} from "./computer-use-signing-pins.mjs";
import { verifyAidenFuses } from "./configure-electron-fuses.mjs";
import {
  MAX_MODELS_DEV_SNAPSHOT_BYTES,
  validateModelsDevSnapshot,
} from "./model-snapshot-core.mjs";
import {
  assertAmbientMusicCMakeProvenance,
  assertAmbientMusicNativeBuildInputs,
} from "./ambient-music-provenance.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const reviewedProvenancePath = path.join(
  repositoryRoot,
  "resources",
  "computer-use",
  "cua-driver-artifact.json",
);
const reviewedLicenseNoticePath = path.join(
  repositoryRoot,
  "resources",
  "computer-use",
  "LICENSE.cua-driver.md",
);
const reviewedHelperInfoPlistPath = path.join(
  repositoryRoot,
  "native",
  "computer-use-broker",
  "Info.plist",
);
const reviewedAmbientMusicRoot = path.join(repositoryRoot, "resources", "ambient-music");
const reviewedAmbientMusicPackageCollisionAllowlist = path.join(
  reviewedAmbientMusicRoot,
  "package-collision-allowlist.json",
);
const reviewedAmbientMusicInfoPlist = path.join(
  repositoryRoot,
  "native",
  "ambient-music",
  "Info.plist",
);
const reviewedAmbientMusicArtwork = path.join(repositoryRoot, "resources", "app-icon.png");
const reviewedAmbientMusicCMake = path.join(
  repositoryRoot,
  "native",
  "ambient-music",
  "CMakeLists.txt",
);
const PACKAGED_MODELS_DEV_ENTRY = "resources/model-capabilities.json";
const EXPECTED_COMPUTER_USE_HELPER_TREE = Object.freeze(
  [
    ["Contents", "directory"],
    [path.join("Contents", "Info.plist"), "file"],
    [path.join("Contents", "MacOS"), "directory"],
    [path.join("Contents", "MacOS", "aiden-cua-broker"), "file"],
    [path.join("Contents", "MacOS", "cua-driver"), "file"],
    [path.join("Contents", "Resources"), "directory"],
    [path.join("Contents", "Resources", "LICENSE.cua-driver.md"), "file"],
    [path.join("Contents", "Resources", "cua-driver-artifact.json"), "file"],
    [path.join("Contents", "_CodeSignature"), "directory"],
    [path.join("Contents", "_CodeSignature", "CodeResources"), "file"],
  ]
    .map(([relativePath, type]) => `${type}:${relativePath}`)
    .sort(),
);
const WORKTREE_REMOVER_EXECUTABLE = "aiden-worktree-remover";
const SUBAGENT_RUN_STORE_EXECUTABLE = "aiden-subagent-run-store";
const SUBAGENT_FILE_MUTATOR_EXECUTABLE = "aiden-subagent-file-mutator";
const SUBAGENT_SHELL_RUNNER_EXECUTABLE = "aiden-subagent-shell-runner";
const REQUIRED_UNIVERSAL_ARCHITECTURES = Object.freeze(["arm64", "x86_64"]);
const ELECTRON_HELPER_SUFFIXES = Object.freeze(["", " (GPU)", " (Plugin)", " (Renderer)"]);
const AMBIENT_MUSIC_HELPER_APP = "Aiden Ambient Music Helper.app";
const AMBIENT_MUSIC_EXECUTABLE = "aiden-ambient-music-helper";
const AMBIENT_MUSIC_BUNDLE_ID = "com.sambitcreate.aiden-agent.ambient-music";
const AMBIENT_MUSIC_LICENSE_FILES = Object.freeze([
  "LICENSE.magenta-realtime.txt",
  "LICENSE.mlx.txt",
  "LICENSE.mlx-acknowledgments.txt",
  "LICENSE.sentencepiece.txt",
  "LICENSE.tensorflow-lite.txt",
  "LICENSE.abseil.txt",
  "LICENSE.sentencepiece-abseil.txt",
  "LICENSE.sentencepiece-darts-clone.txt",
  "LICENSE.sentencepiece-protobuf-lite.txt",
  "LICENSE.cpuinfo.txt",
  "LICENSE.clog.txt",
  "LICENSE.eigen-summary.txt",
  "LICENSE.eigen-apache.txt",
  "LICENSE.eigen-bsd.txt",
  "LICENSE.eigen-minpack.txt",
  "LICENSE.eigen-mpl2.txt",
  "LICENSE.eigen-readme.txt",
  "LICENSE.farmhash.txt",
  "LICENSE.fft2d.txt",
  "LICENSE.flatbuffers.txt",
  "LICENSE.gemmlowp.txt",
  "LICENSE.ml-dtypes.txt",
  "LICENSE.ml-dtypes-eigen.txt",
  "LICENSE.protobuf.txt",
  "LICENSE.ruy.txt",
  "LICENSE.fmt.txt",
  "LICENSE.nlohmann-json.txt",
  "LICENSE.metal-cpp.txt",
]);
const AMBIENT_MUSIC_REVIEWED_FILES = Object.freeze([
  "MODEL_TERMS.md",
  "NOTICE.md",
  "asset-manifest.json",
  "source-provenance.json",
]);
const AMBIENT_MUSIC_LEGAL_FILES = Object.freeze([
  ...AMBIENT_MUSIC_LICENSE_FILES,
  ...AMBIENT_MUSIC_REVIEWED_FILES,
]);
const EXPECTED_AMBIENT_MUSIC_HELPER_TREE = Object.freeze(
  [
    ["Contents", "directory"],
    [path.join("Contents", "Info.plist"), "file"],
    [path.join("Contents", "MacOS"), "directory"],
    [path.join("Contents", "MacOS", AMBIENT_MUSIC_EXECUTABLE), "file"],
    [path.join("Contents", "MacOS", "mlx.metallib"), "file"],
    [path.join("Contents", "Resources"), "directory"],
    [path.join("Contents", "Resources", "AmbientMusicArtwork.png"), "file"],
    ...AMBIENT_MUSIC_LEGAL_FILES.map((file) => [path.join("Contents", "Resources", file), "file"]),
    [path.join("Contents", "_CodeSignature"), "directory"],
    [path.join("Contents", "_CodeSignature", "CodeResources"), "file"],
  ]
    .map(([relativePath, type]) => `${type}:${relativePath}`)
    .sort(),
);

export function ambientMusicLicenseInventory(provenance) {
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    provenance.schemaVersion !== 2 ||
    !Array.isArray(provenance.packagedLicenseFiles)
  ) {
    throw new Error("Ambient Music source provenance has an unsupported legal schema.");
  }
  const licenses = new Map();
  for (const record of provenance.packagedLicenseFiles) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.packageFile !== "string" ||
      !/^LICENSE\.[A-Za-z0-9-]+\.txt$/u.test(record.packageFile) ||
      licenses.has(record.packageFile) ||
      (record.sourceRoot !== "repository" && record.sourceRoot !== "nativeBuild") ||
      typeof record.sourcePath !== "string" ||
      path.isAbsolute(record.sourcePath) ||
      record.sourcePath.split(/[\\/]/u).includes("..") ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      throw new Error("Ambient Music source provenance contains an invalid license record.");
    }
    licenses.set(record.packageFile, record);
  }
  const dependencyGroups = [
    provenance.nativeSources,
    provenance.compiledDependencies,
    provenance.headerDependencies,
    provenance.buildOnlyDependencies,
  ];
  const referenced = new Set();
  for (const group of dependencyGroups) {
    if (!Array.isArray(group)) {
      throw new Error("Ambient Music source provenance is missing a dependency group.");
    }
    for (const dependency of group) {
      if (!Array.isArray(dependency?.licenseFiles) || dependency.licenseFiles.length === 0) {
        throw new Error("Every Ambient Music dependency must name a packaged license file.");
      }
      for (const file of dependency.licenseFiles) {
        if (!licenses.has(file)) {
          throw new Error(`Ambient Music dependency references an unknown license file: ${file}.`);
        }
        referenced.add(file);
      }
    }
  }
  const actual = [...licenses.keys()].sort();
  const expected = [...AMBIENT_MUSIC_LICENSE_FILES].sort();
  if (referenced.size !== licenses.size || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Ambient Music packaged license inventory differs from the reviewed build graph.",
    );
  }
  return licenses;
}

async function run(command, args) {
  return executeFile(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertRegularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file) {
    throw new Error(`Expected a regular non-symlinked package file: ${file}`);
  }
  return info;
}

export function assertPackagedModelCatalogEntries(entries) {
  const normalized = new Set(entries.map((entry) => entry.replaceAll("\\", "/")));
  if (!normalized.has("/resources/model-capabilities.json")) {
    throw new Error("Packaged app.asar is missing the models.dev capability snapshot.");
  }
  if (
    [...normalized].some((entry) => entry.split("/").at(-1) === "artificial-analysis-models.json")
  ) {
    throw new Error("Packaged app.asar contains the obsolete Artificial Analysis snapshot.");
  }
}

export async function verifyPackagedModelCatalogResources(appAsar) {
  await assertRegularFile(appAsar);
  assertPackagedModelCatalogEntries(listPackage(appAsar, { isPack: false }));
  const entry = statFile(appAsar, PACKAGED_MODELS_DEV_ENTRY, false);
  if (
    !entry ||
    typeof entry.size !== "number" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    entry.size > MAX_MODELS_DEV_SNAPSHOT_BYTES ||
    typeof entry.offset !== "string" ||
    entry.unpacked === true ||
    "files" in entry ||
    "link" in entry
  ) {
    throw new Error(
      "Packaged models.dev capability snapshot must be a bounded packed regular file.",
    );
  }
  const bytes = extractFile(appAsar, PACKAGED_MODELS_DEV_ENTRY, false);
  if (bytes.byteLength !== entry.size) {
    throw new Error("Packaged models.dev capability snapshot size does not match its ASAR entry.");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Packaged models.dev capability snapshot is not valid JSON.");
  }
  validateModelsDevSnapshot(snapshot);
}

export function assertComputerUseExecutableMode(mode, file) {
  const permissions = mode & 0o777;
  if (permissions !== 0o755) {
    throw new Error(
      `Expected Computer Use executable mode 0755 for ${file}, received 0${permissions.toString(8)}`,
    );
  }
}

export function assertByteForByteMatch(actual, expected, file) {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    throw new Error(`Packaged Computer Use resource differs from the reviewed copy: ${file}`);
  }
}

export function assertComputerUseBundleExecutable(executable) {
  if (executable !== CUA_DRIVER_HELPER_EXECUTABLE) {
    throw new Error(
      `Unexpected Computer Use CFBundleExecutable: expected ${CUA_DRIVER_HELPER_EXECUTABLE}, received ${executable}`,
    );
  }
}

export function assertComputerUseMinimumSystemVersion(version) {
  if (version !== "14.4") {
    throw new Error(
      `Unexpected Computer Use minimum macOS version: expected 14.4, received ${version}`,
    );
  }
}

export function assertMatchingHostCodeHashes(bundleCdHash, executableCdHash) {
  const pattern = /^[0-9a-f]{40}$/;
  if (!pattern.test(bundleCdHash) || bundleCdHash !== executableCdHash) {
    throw new Error(
      "The signed Aiden bundle and its live host executable do not share one exact CDHash.",
    );
  }
}

export function assertHardenedRuntime(codeDisplay, target = "signed code") {
  if (!/^CodeDirectory .* flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/m.test(codeDisplay)) {
    throw new Error(`Hardened runtime is not enabled for ${target}`);
  }
}

export function assertDeveloperIdSignature(codeDisplay, target = "signed code") {
  if (
    !codeDisplay.includes("Authority=Developer ID Application:") ||
    !codeDisplay.includes(`TeamIdentifier=${AIDEN_SIGNING_TEAM_ID}`)
  ) {
    throw new Error(
      `Distribution code is not signed by Aiden's Developer ID Application identity: ${target}`,
    );
  }
}

export function assertComputerUseMachOMinimum(buildDisplay) {
  const platforms = [...buildDisplay.matchAll(/^\s*platform\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const minimums = [...buildDisplay.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map((match) => match[1]);
  if (
    platforms.length !== 1 ||
    platforms[0] !== "MACOS" ||
    minimums.length !== 1 ||
    minimums[0] !== "14.4"
  ) {
    throw new Error(
      `Computer Use broker LC_BUILD_VERSION is not pinned to macOS 14.4: ${platforms.join(",")}/${minimums.join(",")}`,
    );
  }
}

export function assertExactUniversalArchitectures(architectureDisplay, target = "native helper") {
  const architectures = architectureDisplay.trim().split(/\s+/u).filter(Boolean);
  const architectureSet = new Set(architectures);
  if (
    architectures.length !== REQUIRED_UNIVERSAL_ARCHITECTURES.length ||
    architectureSet.size !== REQUIRED_UNIVERSAL_ARCHITECTURES.length ||
    REQUIRED_UNIVERSAL_ARCHITECTURES.some((architecture) => !architectureSet.has(architecture))
  ) {
    throw new Error(
      `${target} must contain exactly the arm64 and x86_64 architectures: ${architectures.join(",") || "(none)"}`,
    );
  }
}

export function assertMacOSArchitectureMinimum(
  buildDisplay,
  target = "native helper",
  architecture = "unknown",
) {
  const platforms = [...buildDisplay.matchAll(/^\s*platform\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const minimums = [...buildDisplay.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map((match) => match[1]);
  if (
    platforms.length !== 1 ||
    platforms[0] !== "MACOS" ||
    minimums.length !== 1 ||
    minimums[0] !== "14.4"
  ) {
    throw new Error(
      `${target} ${architecture} slice is not pinned to macOS 14.4: ${platforms.join(",")}/${minimums.join(",")}`,
    );
  }
}

export async function verifyUniversalMacOSHelper(file, target = "native helper") {
  const { stdout: architectureDisplay } = await run("/usr/bin/lipo", ["-archs", file]);
  assertExactUniversalArchitectures(architectureDisplay, target);
  for (const architecture of REQUIRED_UNIVERSAL_ARCHITECTURES) {
    const { stdout, stderr } = await run("/usr/bin/vtool", [
      "-arch",
      architecture,
      "-show-build",
      file,
    ]);
    assertMacOSArchitectureMinimum(`${stdout}\n${stderr}`, target, architecture);
  }
}

async function verifySignature(target, { deep = false, identifier, teamId }) {
  const args = ["--verify"];
  if (deep) args.push("--deep");
  args.push("--strict", "--verbose=2", `-R=${appleRequirement({ identifier, teamId })}`, target);
  await run("/usr/bin/codesign", args);
}

async function readEntitlements(target) {
  const { stdout } = await run("/usr/bin/codesign", [
    "--display",
    "--xml",
    "--entitlements",
    "/dev/stdout",
    target,
  ]);
  return stdout;
}

async function readCodeDisplay(target) {
  const result = await run("/usr/bin/codesign", ["--display", "--verbose=4", target]);
  return `${result.stdout}\n${result.stderr}`;
}

function cdHashFromCodeDisplay(display, target) {
  const match = display.match(/^CDHash=([0-9a-f]{40})$/m);
  if (!match) throw new Error(`Signed code omitted an exact SHA-1 CDHash: ${target}`);
  return match[1];
}

export async function packagedArtifactIdentity(appPath) {
  const resolvedApp = path.resolve(appPath);
  const infoPlist = path.join(resolvedApp, "Contents", "Info.plist");
  return {
    bundleIdentifier: await readInfoPlistValue(infoPlist, "CFBundleIdentifier"),
    bundleVersion: await readInfoPlistValue(infoPlist, "CFBundleVersion"),
    shortVersion: await readInfoPlistValue(infoPlist, "CFBundleShortVersionString"),
    cdHash: cdHashFromCodeDisplay(await readCodeDisplay(resolvedApp), resolvedApp),
    appAsarSha256: await sha256(path.join(resolvedApp, "Contents", "Resources", "app.asar")),
    codeResourcesSha256: await sha256(
      path.join(resolvedApp, "Contents", "_CodeSignature", "CodeResources"),
    ),
  };
}

function isPackagedArtifactIdentity(identity) {
  return (
    typeof identity === "object" &&
    identity !== null &&
    typeof identity.bundleIdentifier === "string" &&
    identity.bundleIdentifier.length > 0 &&
    typeof identity.bundleVersion === "string" &&
    identity.bundleVersion.length > 0 &&
    typeof identity.shortVersion === "string" &&
    identity.shortVersion.length > 0 &&
    typeof identity.cdHash === "string" &&
    /^[a-f0-9]{40}$/u.test(identity.cdHash) &&
    ["appAsarSha256", "codeResourcesSha256"].every(
      (field) => typeof identity[field] === "string" && /^[a-f0-9]{64}$/u.test(identity[field]),
    )
  );
}

export function assertSamePackagedArtifactIdentity(expected, actual, source) {
  if (!isPackagedArtifactIdentity(expected) || !isPackagedArtifactIdentity(actual)) {
    throw new Error(`${source} omitted the complete immutable package identity.`);
  }
  for (const field of [
    "bundleIdentifier",
    "bundleVersion",
    "shortVersion",
    "cdHash",
    "appAsarSha256",
    "codeResourcesSha256",
  ]) {
    if (actual?.[field] !== expected?.[field]) {
      throw new Error(`${source} does not contain the verified staging app (${field} mismatch).`);
    }
  }
}

export function assertMinimalComputerUseEntitlements(entitlements) {
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  if (keys.length > 0) {
    throw new Error(`Computer Use broker has unexpected entitlements: ${keys.join(", ")}`);
  }
}

function assertExactTrueEntitlements(entitlements, expectedKeys, description) {
  const expected = [...expectedKeys].sort();
  const actual = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
  const enabled = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)]
    .map((match) => match[1])
    .sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    JSON.stringify(enabled) !== JSON.stringify(expected)
  ) {
    throw new Error(`${description}: ${actual.join(", ")}`);
  }
}

export function assertElectronEntitlements(entitlements) {
  assertExactTrueEntitlements(
    entitlements,
    [
      "com.apple.security.automation.apple-events",
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.audio-input",
    ],
    "Electron executable entitlements differ from the pinned runtime set",
  );
}

export function assertElectronHelperEntitlements(entitlements) {
  assertExactTrueEntitlements(
    entitlements,
    [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.audio-input",
    ],
    "Electron helper entitlements differ from the pinned inherited set",
  );
}

async function readInfoPlistValue(infoPlist, key) {
  const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
  return stdout.trim();
}

async function verifyReviewedResource(packagedFile, reviewedFile) {
  await Promise.all([assertRegularFile(packagedFile), assertRegularFile(reviewedFile)]);
  const [packagedBytes, reviewedBytes] = await Promise.all([
    readFile(packagedFile),
    readFile(reviewedFile),
  ]);
  assertByteForByteMatch(packagedBytes, reviewedBytes, packagedFile);
}

export async function verifyReviewedComputerUseInfoPlist(
  packagedFile,
  reviewedFile = reviewedHelperInfoPlistPath,
) {
  await verifyReviewedResource(packagedFile, reviewedFile);
}

async function collectComputerUseHelperTree(root, directory = root, entries = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    const relativePath = path.relative(root, absolutePath);
    const type = info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "other";
    entries.push(`${type}:${relativePath}`);
    if (info.isDirectory()) {
      await collectComputerUseHelperTree(root, absolutePath, entries);
    }
  }
  return entries;
}

export async function verifyExactComputerUseHelperTree(helperApp) {
  const rootInfo = await lstat(helperApp);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (await realpath(helperApp)) !== helperApp
  ) {
    throw new Error(`Expected a regular non-symlinked Computer Use helper: ${helperApp}`);
  }
  const actual = (await collectComputerUseHelperTree(helperApp)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_COMPUTER_USE_HELPER_TREE)) {
    throw new Error(
      `Computer Use helper tree differs from the reviewed payload: ${actual.join(", ")}`,
    );
  }
}

export function assertAmbientMusicArchitecture(architectureDisplay) {
  const architectures = architectureDisplay.trim().split(/\s+/u).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(
      `Ambient Music helper must contain exactly arm64: ${architectures.join(",") || "(none)"}`,
    );
  }
}

export function assertAmbientMusicMachOMinimum(buildDisplay) {
  const platforms = [...buildDisplay.matchAll(/^\s*platform\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const minimums = [...buildDisplay.matchAll(/^\s*minos\s+(\S+)\s*$/gm)].map((match) => match[1]);
  if (
    platforms.length !== 1 ||
    platforms[0] !== "MACOS" ||
    minimums.length !== 1 ||
    minimums[0] !== "14.0"
  ) {
    throw new Error(
      `Ambient Music helper LC_BUILD_VERSION is not pinned to macOS 14.0: ${platforms.join(",")}/${minimums.join(",")}`,
    );
  }
}

export async function verifyExactAmbientMusicHelperTree(helperApp) {
  const rootInfo = await lstat(helperApp);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (await realpath(helperApp)) !== helperApp
  ) {
    throw new Error(`Expected a regular non-symlinked Ambient Music helper: ${helperApp}`);
  }
  const actual = (await collectComputerUseHelperTree(helperApp)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_AMBIENT_MUSIC_HELPER_TREE)) {
    throw new Error(
      `Ambient Music helper tree differs from the reviewed payload: ${actual.join(", ")}`,
    );
  }
}

function isAmbientMusicModelAsset(relativePath) {
  const normalized = relativePath.split(path.sep).join("/").toLowerCase();
  const basename = path.posix.basename(normalized);
  return (
    normalized.includes("/models/mrt2_small/") ||
    normalized.includes("/models/mrt2_base/") ||
    normalized.includes("/resources/musiccoca/") ||
    normalized.includes("/resources/spectrostream/") ||
    basename.endsWith(".mlxfn") ||
    basename.endsWith(".safetensors") ||
    basename.endsWith(".tflite") ||
    basename === "spm.model"
  );
}

export function ambientMusicModelFingerprints(manifest) {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.version !== 1 ||
    manifest.bundled !== false ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("Ambient Music asset manifest is invalid.");
  }
  const fingerprints = new Map();
  for (const asset of manifest.files) {
    if (
      typeof asset !== "object" ||
      asset === null ||
      typeof asset.relativePath !== "string" ||
      path.isAbsolute(asset.relativePath) ||
      asset.relativePath.split(/[\\/]/u).includes("..") ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new Error("Ambient Music asset manifest contains an invalid file fingerprint.");
    }
    const hashes = fingerprints.get(asset.size) ?? new Set();
    if (hashes.has(asset.sha256)) {
      throw new Error("Ambient Music asset manifest contains a duplicate file fingerprint.");
    }
    hashes.add(asset.sha256);
    fingerprints.set(asset.size, hashes);
  }
  return fingerprints;
}

const ASAR_PREFIX_BYTES = 17;
const MAX_NESTED_ASAR_BYTES = 512 * 1024 * 1024;
const MAX_MODEL_WRAPPER_BYTES = 1024 * 1024;
const CONTAINER_SCAN_BYTES = MAX_MODEL_WRAPPER_BYTES + 512;
const PACKAGE_COLLISION_REASONS = Object.freeze(["model-size-collision", "embedded-container"]);

export function ambientMusicPackageCollisionAllowlist(document, fingerprints) {
  if (
    typeof document !== "object" ||
    document === null ||
    document.schemaVersion !== 1 ||
    document.maxWrapperBytes !== MAX_MODEL_WRAPPER_BYTES ||
    !Array.isArray(document.records) ||
    document.records.length === 0
  ) {
    throw new Error("Ambient Music package collision allowlist is invalid.");
  }
  const records = new Map();
  let previousPath = "";
  for (const record of document.records) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      record.path.includes("\\") ||
      record.path.includes("\0") ||
      path.posix.isAbsolute(record.path) ||
      record.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      record.path.localeCompare(previousPath) <= 0 ||
      !Array.isArray(record.reasons) ||
      record.reasons.length === 0 ||
      JSON.stringify(record.reasons) !==
        JSON.stringify(
          PACKAGE_COLLISION_REASONS.filter((reason) => record.reasons.includes(reason)),
        )
    ) {
      throw new Error("Ambient Music package collision allowlist contains an invalid record.");
    }
    const hasSizeCollision = [...fingerprints.keys()].some((size) => {
      const wrapperBytes = record.size - size;
      return wrapperBytes > 0 && wrapperBytes <= MAX_MODEL_WRAPPER_BYTES;
    });
    if (record.reasons.includes("model-size-collision") !== hasSizeCollision) {
      throw new Error("Ambient Music package collision allowlist contains an invalid record.");
    }
    previousPath = record.path;
    records.set(record.path, Object.freeze({ ...record }));
  }
  return records;
}

export function ambientMusicPackageIdentityReceipt(document) {
  const identity = document?.packageIdentity;
  if (!isPackagedArtifactIdentity(identity) || identity.bundleIdentifier !== AIDEN_APP_BUNDLE_ID) {
    throw new Error("Ambient Music package identity receipt is invalid.");
  }
  return Object.freeze({ ...identity });
}

function looksLikeAsarPrefix(prefix, totalSize) {
  if (prefix.byteLength < ASAR_PREFIX_BYTES || totalSize < ASAR_PREFIX_BYTES) return false;
  const headerSize = prefix.readUInt32LE(4);
  return (
    prefix.readUInt32LE(0) === 4 &&
    headerSize >= 8 &&
    headerSize <= totalSize - 8 &&
    prefix.readUInt32LE(8) === headerSize - 4 &&
    prefix.readUInt32LE(12) <= headerSize - 8 &&
    prefix[16] === 0x7b
  );
}

async function readPrefix(file, position, size) {
  const length = Math.min(CONTAINER_SCAN_BYTES, size);
  const bytes = Buffer.alloc(length);
  const handle = await open(file, "r");
  try {
    const { bytesRead } = await handle.read(bytes, 0, length, position);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sha256Range(file, start, size) {
  const hash = createHash("sha256");
  const stream = createReadStream(file, { start, end: start + size - 1 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function rejectFingerprint(label) {
  throw new Error(`Packaged artifact contains Ambient Music model bytes: ${label}`);
}

function magicOffsets(bytes, magic) {
  const offsets = [];
  for (let offset = bytes.indexOf(magic); offset >= 0; offset = bytes.indexOf(magic, offset + 1)) {
    offsets.push(offset);
  }
  return offsets;
}

function opaqueContainerLocation(bytes, totalSize) {
  const candidates = [];
  for (const offset of magicOffsets(bytes, Buffer.from([4, 0, 0, 0]))) {
    if (
      looksLikeAsarPrefix(bytes.subarray(offset, offset + ASAR_PREFIX_BYTES), totalSize - offset)
    ) {
      candidates.push({ kind: "asar", offset });
    }
  }
  for (const offset of magicOffsets(bytes, Buffer.from([0x1f, 0x8b, 0x08]))) {
    if (offset + 3 < bytes.byteLength && (bytes[offset + 3] & 0xe0) === 0) {
      candidates.push({ kind: "gzip", offset });
    }
  }
  for (const magic of [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x50, 0x4b, 0x07, 0x08]),
  ]) {
    for (const offset of magicOffsets(bytes, magic)) candidates.push({ kind: "zip", offset });
  }
  for (const [kind, magic] of [
    ["xz", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
    ["zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd])],
    ["7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ["rar", Buffer.from("Rar!\x1a\x07\x00", "binary")],
    ["xar", Buffer.from("xar!", "ascii")],
  ]) {
    for (const offset of magicOffsets(bytes, magic)) candidates.push({ kind, offset });
  }
  for (const offset of magicOffsets(bytes, Buffer.from("BZh", "ascii"))) {
    if (offset + 3 < bytes.byteLength && bytes[offset + 3] >= 0x31 && bytes[offset + 3] <= 0x39) {
      candidates.push({ kind: "bzip2", offset });
    }
  }
  for (const marker of magicOffsets(bytes, Buffer.from("ustar", "ascii"))) {
    if (marker >= 257) candidates.push({ kind: "tar", offset: marker - 257 });
  }
  return candidates.sort((left, right) => left.offset - right.offset)[0];
}

function packageCollisionReasons(size, prefix, fingerprints) {
  const reasons = [];
  if (
    [...fingerprints.keys()].some((assetSize) => {
      const wrapperBytes = size - assetSize;
      return wrapperBytes > 0 && wrapperBytes <= MAX_MODEL_WRAPPER_BYTES;
    })
  ) {
    reasons.push("model-size-collision");
  }
  const container = opaqueContainerLocation(prefix, size);
  if (container && (container.kind !== "asar" || container.offset !== 0)) {
    reasons.push("embedded-container");
  }
  return reasons;
}

function rejectOpaqueContainer(bytes, totalSize, label, reviewedExactFile = false) {
  const container = opaqueContainerLocation(bytes, totalSize);
  if (!container) return undefined;
  if (container.offset > 0 && reviewedExactFile) return undefined;
  if (container.kind !== "asar" || container.offset !== 0) {
    throw new Error(
      `Packaged artifact contains an unreviewed ${container.kind} container: ${label}`,
    );
  }
  return container.kind;
}

async function inspectFingerprint(
  file,
  start,
  size,
  fingerprints,
  label,
  reviewedExactFile = false,
) {
  const hashes = fingerprints.get(size);
  if (hashes?.has(await sha256Range(file, start, size))) rejectFingerprint(label);
  for (const [assetSize, assetHashes] of fingerprints) {
    const wrapperBytes = size - assetSize;
    if (wrapperBytes <= 0 || wrapperBytes > MAX_MODEL_WRAPPER_BYTES) continue;
    if (assetHashes.has(await sha256Range(file, start, assetSize))) rejectFingerprint(label);
    if (assetHashes.has(await sha256Range(file, start + wrapperBytes, assetSize))) {
      rejectFingerprint(label);
    }
    if (!reviewedExactFile) rejectFingerprint(label);
  }
}

function inspectBufferFingerprint(bytes, fingerprints, label, reviewedExactFile = false) {
  const hashes = fingerprints.get(bytes.byteLength);
  if (hashes?.has(createHash("sha256").update(bytes).digest("hex"))) {
    rejectFingerprint(label);
  }
  for (const [assetSize, assetHashes] of fingerprints) {
    const wrapperBytes = bytes.byteLength - assetSize;
    if (wrapperBytes <= 0 || wrapperBytes > MAX_MODEL_WRAPPER_BYTES) continue;
    const prefixHash = createHash("sha256").update(bytes.subarray(0, assetSize)).digest("hex");
    const suffixHash = createHash("sha256")
      .update(bytes.subarray(wrapperBytes, wrapperBytes + assetSize))
      .digest("hex");
    if (assetHashes.has(prefixHash) || assetHashes.has(suffixHash)) rejectFingerprint(label);
    if (!reviewedExactFile) rejectFingerprint(label);
  }
}

async function reviewedFileMatches(label, size, reasons, hash, review) {
  if (review.collecting) {
    if (reasons.length === 0) return false;
    if (review.seen.has(label)) {
      throw new Error(`Ambient Music package collision path was consumed twice: ${label}`);
    }
    review.seen.add(label);
    review.generated.push({ path: label, size, sha256: await hash(), reasons });
    return true;
  }
  const record = review.records.get(label);
  if (!record) return false;
  if (review.seen.has(label)) {
    throw new Error(`Ambient Music package collision allowlist path was consumed twice: ${label}`);
  }
  if (
    record.size !== size ||
    JSON.stringify(record.reasons) !== JSON.stringify(reasons) ||
    record.sha256 !== (await hash())
  ) {
    throw new Error(`Packaged artifact differs from reviewed collision receipt: ${label}`);
  }
  review.seen.add(label);
  return true;
}

function parsedAsarHeader(bytes, label) {
  if (!looksLikeAsarPrefix(bytes.subarray(0, ASAR_PREFIX_BYTES), bytes.byteLength)) {
    throw new Error(`Packaged artifact contains a malformed nested ASAR: ${label}`);
  }
  const headerSize = bytes.readUInt32LE(4);
  const stringSize = bytes.readUInt32LE(12);
  let header;
  try {
    header = JSON.parse(bytes.subarray(16, 16 + stringSize).toString("utf8"));
  } catch {
    throw new Error(`Packaged artifact contains a malformed nested ASAR: ${label}`);
  }
  if (typeof header !== "object" || header === null || typeof header.files !== "object") {
    throw new Error(`Packaged artifact contains a malformed nested ASAR: ${label}`);
  }
  return { dataOffset: 8 + headerSize, files: header.files };
}

function scanNestedAsar(bytes, fingerprints, label, review, depth = 1) {
  if (depth > 8) throw new Error(`Packaged artifact nests ASAR containers too deeply: ${label}`);
  const { dataOffset, files } = parsedAsarHeader(bytes, label);
  const walk = (nodes, parent) => {
    for (const [name, node] of Object.entries(nodes)) {
      const entryLabel = `${parent}/${name}`;
      if (isAmbientMusicModelAsset(entryLabel)) {
        throw new Error(`Packaged artifact contains an Ambient Music model asset: ${entryLabel}`);
      }
      if (typeof node !== "object" || node === null) {
        throw new Error(`Packaged artifact contains a malformed nested ASAR: ${entryLabel}`);
      }
      if ("files" in node) {
        if (typeof node.files !== "object" || node.files === null) {
          throw new Error(`Packaged artifact contains a malformed nested ASAR: ${entryLabel}`);
        }
        walk(node.files, entryLabel);
        continue;
      }
      if ("link" in node) continue;
      if (node.unpacked === true) {
        throw new Error(`Nested ASAR contains an unverifiable unpacked entry: ${entryLabel}`);
      }
      const size = node.size;
      const offset = Number(node.offset);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof node.offset !== "string" ||
        !/^\d+$/u.test(node.offset) ||
        !Number.isSafeInteger(offset) ||
        dataOffset + offset + size > bytes.byteLength
      ) {
        throw new Error(`Packaged artifact contains a malformed nested ASAR: ${entryLabel}`);
      }
      const content = bytes.subarray(dataOffset + offset, dataOffset + offset + size);
      const prefix = content.subarray(0, CONTAINER_SCAN_BYTES);
      const reasons = packageCollisionReasons(size, prefix, fingerprints);
      const reviewedExactFile = (() => {
        if (review.collecting) {
          if (reasons.length === 0) return false;
          if (review.seen.has(entryLabel)) {
            throw new Error(
              `Ambient Music package collision path was consumed twice: ${entryLabel}`,
            );
          }
          review.seen.add(entryLabel);
          review.generated.push({
            path: entryLabel,
            size,
            sha256: createHash("sha256").update(content).digest("hex"),
            reasons,
          });
          return true;
        }
        const record = review.records.get(entryLabel);
        if (!record) return false;
        if (review.seen.has(entryLabel)) {
          throw new Error(
            `Ambient Music package collision allowlist path was consumed twice: ${entryLabel}`,
          );
        }
        const digest = createHash("sha256").update(content).digest("hex");
        if (
          record.size !== size ||
          JSON.stringify(record.reasons) !== JSON.stringify(reasons) ||
          record.sha256 !== digest
        ) {
          throw new Error(
            `Packaged artifact differs from reviewed collision receipt: ${entryLabel}`,
          );
        }
        review.seen.add(entryLabel);
        return true;
      })();
      const kind = rejectOpaqueContainer(prefix, content.byteLength, entryLabel, reviewedExactFile);
      inspectBufferFingerprint(content, fingerprints, entryLabel, reviewedExactFile);
      if (kind === "asar") {
        scanNestedAsar(content, fingerprints, entryLabel, review, depth + 1);
      }
    }
  };
  walk(files, label);
}

async function scanAsarFile(file, relative, fingerprints, review) {
  let header;
  try {
    header = getRawHeader(file);
  } catch {
    throw new Error(`Packaged artifact contains a malformed ASAR container: ${relative}`);
  }
  const handle = await open(file, "r");
  try {
    for (const asarEntry of listPackage(file, { isPack: false })) {
      const normalizedEntry = asarEntry.replace(/^\/+/, "");
      const label = `${relative}:${normalizedEntry}`;
      if (isAmbientMusicModelAsset(normalizedEntry)) {
        throw new Error(`Packaged artifact contains an Ambient Music model asset: ${label}`);
      }
      const info = statFile(file, normalizedEntry, false);
      if (!info || "files" in info || "link" in info || info.unpacked === true) continue;
      if (
        !Number.isSafeInteger(info.size) ||
        info.size < 0 ||
        typeof info.offset !== "string" ||
        !/^\d+$/u.test(info.offset)
      ) {
        throw new Error(`Packaged artifact contains a malformed ASAR entry: ${label}`);
      }
      const offset = 8 + header.headerSize + Number(info.offset);
      const prefix = Buffer.alloc(Math.min(CONTAINER_SCAN_BYTES, info.size));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, offset);
      const inspectedPrefix = prefix.subarray(0, bytesRead);
      const reviewedExactFile = await reviewedFileMatches(
        label,
        info.size,
        packageCollisionReasons(info.size, inspectedPrefix, fingerprints),
        () => sha256Range(file, offset, info.size),
        review,
      );
      const kind = rejectOpaqueContainer(inspectedPrefix, info.size, label, reviewedExactFile);
      await inspectFingerprint(file, offset, info.size, fingerprints, label, reviewedExactFile);
      if (info.size < ASAR_PREFIX_BYTES) continue;
      if (kind !== "asar") continue;
      if (info.size > MAX_NESTED_ASAR_BYTES) {
        throw new Error(`Packaged artifact contains an oversized nested ASAR: ${label}`);
      }
      scanNestedAsar(extractFile(file, normalizedEntry, false), fingerprints, label, review, 1);
    }
  } finally {
    await handle.close();
    uncache(file);
  }
}

export async function assertNoAmbientMusicModelAssets(root, manifest, options = {}) {
  const reviewedManifest =
    manifest ??
    JSON.parse(await readFile(path.join(reviewedAmbientMusicRoot, "asset-manifest.json"), "utf8"));
  const fingerprints = ambientMusicModelFingerprints(reviewedManifest);
  if (options.collisionAllowlist && options.collectCollisionAllowlist) {
    throw new Error("Ambient Music package scan cannot verify and collect a receipt together.");
  }
  const records = options.collisionAllowlist
    ? ambientMusicPackageCollisionAllowlist(options.collisionAllowlist, fingerprints)
    : new Map();
  const review = {
    collecting: options.collectCollisionAllowlist === true,
    generated: [],
    records,
    seen: new Set(),
  };
  const resolvedRoot = path.resolve(root);
  const excludedDirectory = options.excludedDirectory
    ? path.resolve(options.excludedDirectory)
    : undefined;
  if (
    excludedDirectory &&
    (path.dirname(excludedDirectory) !== resolvedRoot || excludedDirectory === resolvedRoot)
  ) {
    throw new Error("Ambient Music package scan exclusion must be a direct child of the root.");
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (candidate === excludedDirectory) continue;
      const relative = path.relative(resolvedRoot, candidate);
      if (isAmbientMusicModelAsset(relative)) {
        throw new Error(`Packaged artifact contains an Ambient Music model asset: ${relative}`);
      }
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) {
        await assertRegularFile(candidate);
        const prefix = await readPrefix(candidate, 0, info.size);
        const reviewedExactFile = await reviewedFileMatches(
          relative,
          info.size,
          packageCollisionReasons(info.size, prefix, fingerprints),
          () => sha256(candidate),
          review,
        );
        const kind = rejectOpaqueContainer(prefix, info.size, relative, reviewedExactFile);
        await inspectFingerprint(
          candidate,
          0,
          info.size,
          fingerprints,
          relative,
          reviewedExactFile,
        );
        if (kind === "asar") {
          await scanAsarFile(candidate, relative, fingerprints, review);
        }
      }
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(candidate);
    }
  }
  await walk(resolvedRoot);
  const missing = [...records.keys()].filter((label) => !review.seen.has(label));
  if (missing.length > 0) {
    throw new Error(`Packaged artifact is missing reviewed collision receipt: ${missing[0]}`);
  }
  if (review.collecting) {
    return {
      schemaVersion: 1,
      maxWrapperBytes: MAX_MODEL_WRAPPER_BYTES,
      records: review.generated.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
}

export async function createAmbientMusicPackageCollisionAllowlist(root, manifest) {
  const collisions = await assertNoAmbientMusicModelAssets(root, manifest, {
    collectCollisionAllowlist: true,
  });
  return {
    schemaVersion: collisions.schemaVersion,
    maxWrapperBytes: collisions.maxWrapperBytes,
    packageIdentity: await packagedArtifactIdentity(root),
    records: collisions.records,
  };
}

export async function assertNoAmbientMusicModelAssetsOutsideDirectory(
  root,
  excludedDirectory,
  manifest,
) {
  const info = await lstat(excludedDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Ambient Music package scan exclusion must be a regular directory.");
  }
  return assertNoAmbientMusicModelAssets(root, manifest, { excludedDirectory });
}

async function verifyAmbientMusicPackage(appPath) {
  const helperApp = path.join(appPath, "Contents", "Helpers", AMBIENT_MUSIC_HELPER_APP);
  const contents = path.join(helperApp, "Contents");
  const executable = path.join(contents, "MacOS", AMBIENT_MUSIC_EXECUTABLE);
  const metallib = path.join(contents, "MacOS", "mlx.metallib");
  const infoPlist = path.join(contents, "Info.plist");
  const helperResources = path.join(contents, "Resources");
  const outerResources = path.join(appPath, "Contents", "Resources", "ambient-music");
  await verifyExactAmbientMusicHelperTree(helperApp);
  const executableInfo = await assertRegularFile(executable);
  const metallibInfo = await assertRegularFile(metallib);
  if ((executableInfo.mode & 0o777) !== 0o755) {
    throw new Error("Ambient Music helper executable mode must be exactly 0755.");
  }
  if (metallibInfo.size <= 0) throw new Error("Ambient Music mlx.metallib is empty.");
  await verifyReviewedResource(infoPlist, reviewedAmbientMusicInfoPlist);
  await verifyReviewedResource(
    path.join(helperResources, "AmbientMusicArtwork.png"),
    reviewedAmbientMusicArtwork,
  );
  for (const file of AMBIENT_MUSIC_REVIEWED_FILES) {
    const reviewed = path.join(reviewedAmbientMusicRoot, file);
    await verifyReviewedResource(path.join(helperResources, file), reviewed);
    await verifyReviewedResource(path.join(outerResources, file), reviewed);
  }
  const provenance = JSON.parse(
    await readFile(path.join(reviewedAmbientMusicRoot, "source-provenance.json"), "utf8"),
  );
  assertAmbientMusicNativeBuildInputs(provenance, repositoryRoot);
  assertAmbientMusicCMakeProvenance(provenance, await readFile(reviewedAmbientMusicCMake, "utf8"));
  const licenseInventory = ambientMusicLicenseInventory(provenance);
  for (const [file, record] of licenseInventory) {
    const helperLicense = path.join(helperResources, file);
    const outerLicense = path.join(outerResources, file);
    await assertRegularFile(helperLicense);
    await assertRegularFile(outerLicense);
    const [helperHash, outerHash] = await Promise.all([
      sha256(helperLicense),
      sha256(outerLicense),
    ]);
    if (helperHash !== record.sha256 || outerHash !== record.sha256) {
      throw new Error(`Ambient Music packaged license differs from provenance: ${file}`);
    }
    if (record.sourceRoot === "repository") {
      const reviewedSource = path.join(repositoryRoot, record.sourcePath);
      await assertRegularFile(reviewedSource);
      if ((await sha256(reviewedSource)) !== record.sha256) {
        throw new Error(`Ambient Music reviewed license hash is stale: ${file}`);
      }
    }
  }
  if ((await readInfoPlistValue(infoPlist, "CFBundleIdentifier")) !== AMBIENT_MUSIC_BUNDLE_ID) {
    throw new Error("Unexpected Ambient Music helper bundle identifier.");
  }
  if ((await readInfoPlistValue(infoPlist, "CFBundleExecutable")) !== AMBIENT_MUSIC_EXECUTABLE) {
    throw new Error("Unexpected Ambient Music helper executable name.");
  }
  if ((await readInfoPlistValue(infoPlist, "LSMinimumSystemVersion")) !== "14.0") {
    throw new Error("Unexpected Ambient Music minimum macOS version.");
  }
  if ((await readInfoPlistValue(infoPlist, "LSUIElement")) !== "true") {
    throw new Error("Ambient Music helper must remain background-only.");
  }
  const { stdout: architectures } = await run("/usr/bin/lipo", ["-archs", executable]);
  assertAmbientMusicArchitecture(architectures);
  const { stdout: build, stderr: buildErrors } = await run("/usr/bin/vtool", [
    "-show-build",
    executable,
  ]);
  assertAmbientMusicMachOMinimum(`${build}\n${buildErrors}`);
  await verifySignature(helperApp, {
    deep: true,
    identifier: AMBIENT_MUSIC_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(executable, {
    identifier: AMBIENT_MUSIC_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", metallib]);
  for (const target of [helperApp, executable, metallib]) {
    const display = await readCodeDisplay(target);
    if (!display.includes(`TeamIdentifier=${AIDEN_SIGNING_TEAM_ID}`)) {
      throw new Error(`Ambient Music code has an unexpected signing team: ${target}`);
    }
    assertHardenedRuntime(display, target);
    assertMinimalComputerUseEntitlements(await readEntitlements(target));
  }
}

export async function verifyMacPackage(appPath) {
  if (process.platform !== "darwin") {
    throw new Error("Packaged macOS verification can only run on macOS.");
  }
  const paths = packagedComputerUsePaths(appPath);
  const ambientMusicPackageReceipt = JSON.parse(
    await readFile(reviewedAmbientMusicPackageCollisionAllowlist, "utf8"),
  );
  const expectedPackageIdentity = ambientMusicPackageIdentityReceipt(ambientMusicPackageReceipt);
  await verifyAmbientMusicPackage(paths.app);
  const appAsar = path.join(paths.app, "Contents", "Resources", "app.asar");
  const worktreeRemover = path.join(paths.app, "Contents", "Helpers", WORKTREE_REMOVER_EXECUTABLE);
  const subagentRunStore = path.join(
    paths.app,
    "Contents",
    "Helpers",
    SUBAGENT_RUN_STORE_EXECUTABLE,
  );
  const subagentFileMutator = path.join(
    paths.app,
    "Contents",
    "Helpers",
    SUBAGENT_FILE_MUTATOR_EXECUTABLE,
  );
  const subagentShellRunner = path.join(
    paths.app,
    "Contents",
    "Helpers",
    SUBAGENT_SHELL_RUNNER_EXECUTABLE,
  );
  const electronHelpers = ELECTRON_HELPER_SUFFIXES.map((suffix) =>
    path.join(
      paths.app,
      "Contents",
      "Frameworks",
      `Aiden Agent Helper${suffix}.app`,
      "Contents",
      "MacOS",
      `Aiden Agent Helper${suffix}`,
    ),
  );
  for (const file of [
    paths.broker,
    paths.driver,
    paths.helperInfoPlist,
    paths.helperProvenance,
    paths.helperLicenseNotice,
    paths.outerProvenance,
    paths.outerLicenseNotice,
    paths.electronExecutable,
    ...electronHelpers,
    worktreeRemover,
    subagentRunStore,
    subagentFileMutator,
    subagentShellRunner,
    appAsar,
  ]) {
    await assertRegularFile(file);
  }
  await verifyPackagedModelCatalogResources(appAsar);
  await verifyExactComputerUseHelperTree(paths.helperApp);
  assertComputerUseExecutableMode((await lstat(paths.broker)).mode, paths.broker);
  assertComputerUseExecutableMode((await lstat(paths.driver)).mode, paths.driver);
  assertComputerUseExecutableMode((await lstat(worktreeRemover)).mode, worktreeRemover);
  assertComputerUseExecutableMode((await lstat(subagentRunStore)).mode, subagentRunStore);
  assertComputerUseExecutableMode((await lstat(subagentFileMutator)).mode, subagentFileMutator);
  assertComputerUseExecutableMode((await lstat(subagentShellRunner)).mode, subagentShellRunner);
  if (
    (await readInfoPlistValue(paths.helperInfoPlist, "CFBundleIdentifier")) !==
    AIDEN_COMPUTER_USE_BUNDLE_ID
  ) {
    throw new Error(`Unexpected Computer Use helper bundle identifier in ${paths.helperInfoPlist}`);
  }
  assertComputerUseBundleExecutable(
    await readInfoPlistValue(paths.helperInfoPlist, "CFBundleExecutable"),
  );
  assertComputerUseMinimumSystemVersion(
    await readInfoPlistValue(paths.helperInfoPlist, "LSMinimumSystemVersion"),
  );

  const reviewedProvenance = await readFile(reviewedProvenancePath, "utf8");
  assertCuaDriverArtifactProvenance(JSON.parse(reviewedProvenance));
  await Promise.all([
    verifyReviewedComputerUseInfoPlist(paths.helperInfoPlist),
    verifyReviewedResource(paths.helperProvenance, reviewedProvenancePath),
    verifyReviewedResource(paths.outerProvenance, reviewedProvenancePath),
    verifyReviewedResource(paths.helperLicenseNotice, reviewedLicenseNoticePath),
    verifyReviewedResource(paths.outerLicenseNotice, reviewedLicenseNoticePath),
  ]);

  await verifySignature(paths.app, {
    deep: true,
    identifier: AIDEN_APP_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(paths.helperApp, {
    deep: true,
    identifier: AIDEN_COMPUTER_USE_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(paths.broker, {
    identifier: AIDEN_COMPUTER_USE_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(worktreeRemover, {
    identifier: WORKTREE_REMOVER_EXECUTABLE,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(subagentRunStore, {
    identifier: SUBAGENT_RUN_STORE_EXECUTABLE,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(subagentFileMutator, {
    identifier: SUBAGENT_FILE_MUTATOR_EXECUTABLE,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  await verifySignature(subagentShellRunner, {
    identifier: SUBAGENT_SHELL_RUNNER_EXECUTABLE,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  const codeDisplays = new Map(
    await Promise.all(
      [
        paths.app,
        paths.helperApp,
        paths.broker,
        paths.driver,
        paths.electronExecutable,
        ...electronHelpers,
        worktreeRemover,
        subagentRunStore,
        subagentFileMutator,
        subagentShellRunner,
      ].map(async (target) => [target, await readCodeDisplay(target)]),
    ),
  );
  for (const [target, display] of codeDisplays) assertHardenedRuntime(display, target);
  assertMatchingHostCodeHashes(
    cdHashFromCodeDisplay(codeDisplays.get(paths.app), paths.app),
    cdHashFromCodeDisplay(codeDisplays.get(paths.electronExecutable), paths.electronExecutable),
  );
  const { stdout: brokerBuild, stderr: brokerBuildErrors } = await run("/usr/bin/vtool", [
    "-show-build",
    paths.broker,
  ]);
  assertComputerUseMachOMinimum(`${brokerBuild}\n${brokerBuildErrors}`);
  await verifyUniversalMacOSHelper(worktreeRemover, "Managed worktree remover");
  await verifyUniversalMacOSHelper(subagentRunStore, "Private subagent run store");
  await verifyUniversalMacOSHelper(subagentFileMutator, "Subagent file mutator");
  await verifyUniversalMacOSHelper(subagentShellRunner, "Subagent shell runner");

  const driverHash = await sha256(paths.driver);
  if (driverHash !== CUA_DRIVER_SHA256) {
    throw new Error(
      `Packaged cua-driver hash mismatch: expected ${CUA_DRIVER_SHA256}, received ${driverHash}`,
    );
  }
  await verifySignature(paths.driver, {
    identifier: CUA_DRIVER_SIGNING_IDENTIFIER,
    teamId: CUA_DRIVER_SIGNING_TEAM_ID,
  });

  assertMinimalComputerUseEntitlements(await readEntitlements(paths.helperApp));
  assertMinimalComputerUseEntitlements(await readEntitlements(paths.broker));
  assertMinimalComputerUseEntitlements(await readEntitlements(worktreeRemover));
  assertMinimalComputerUseEntitlements(await readEntitlements(subagentRunStore));
  assertMinimalComputerUseEntitlements(await readEntitlements(subagentFileMutator));
  assertElectronEntitlements(await readEntitlements(paths.electronExecutable));
  for (const electronHelper of electronHelpers) {
    assertElectronHelperEntitlements(await readEntitlements(electronHelper));
  }
  await verifyAidenFuses(paths.app);
  // Scan after package-structure validation, and accept a size collision only
  // when its exact path, size, and digest match review.
  await assertNoAmbientMusicModelAssets(paths.app, undefined, {
    collisionAllowlist: ambientMusicPackageReceipt,
  });
  // Revalidate the enclosing signature after the byte scan, then make the
  // exact sealed identity the final semantic check.
  await verifySignature(paths.app, {
    deep: true,
    identifier: AIDEN_APP_BUNDLE_ID,
    teamId: AIDEN_SIGNING_TEAM_ID,
  });
  assertSamePackagedArtifactIdentity(
    expectedPackageIdentity,
    await packagedArtifactIdentity(paths.app),
    "Packaged application",
  );
  console.log(`Verified hardened macOS package: ${paths.app}`);
}

export async function verifyNotarizedMacPackage(appPath) {
  const resolvedApp = path.resolve(appPath);
  assertDeveloperIdSignature(await readCodeDisplay(resolvedApp), resolvedApp);
  await run("/usr/bin/xcrun", ["stapler", "validate", resolvedApp]);
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", resolvedApp]);
  console.log(`Verified notarized Developer ID package: ${resolvedApp}`);
}

export function requiresReleaseVerification(type) {
  return type !== "development";
}

export async function discoverPackagedApp(
  releaseDirectory = path.join(repositoryRoot, "release", "development"),
) {
  const candidates = [];
  for (const entry of await readdir(releaseDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;
    const candidate = path.join(releaseDirectory, entry.name, "Aiden Agent.app");
    try {
      if ((await lstat(candidate)).isDirectory()) candidates.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked Aiden macOS package, found ${candidates.length}. Pass an explicit .app path.`,
    );
  }
  return candidates[0];
}

export async function verifyAfterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await verifyMacPackage(appPath);
  if (requiresReleaseVerification(context.packager.platformSpecificBuildOptions.type)) {
    await verifyNotarizedMacPackage(appPath);
  }
}

export default verifyAfterSign;

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const mode = process.argv[2];
  const release = mode === "--release";
  const development = mode === "--development";
  const explicitPath = release || development ? process.argv[3] : process.argv[2];
  const output = release ? "distribution" : "development";
  const appPath = explicitPath
    ? path.resolve(explicitPath)
    : await discoverPackagedApp(path.join(repositoryRoot, "release", output));
  await verifyMacPackage(appPath);
  if (release) await verifyNotarizedMacPackage(appPath);
}
