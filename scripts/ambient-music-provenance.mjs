/* global process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEPENDENCY_GROUPS = Object.freeze([
  "nativeSources",
  "compiledDependencies",
  "headerDependencies",
  "buildOnlyDependencies",
]);

const EXPECTED_NATIVE_BUILD_INPUTS = Object.freeze([
  "native/ambient-music/CMakeLists.txt",
  "native/ambient-music/Info.plist",
  "native/ambient-music/patches/mlx-header-paths.patch",
  "native/ambient-music/patches/tflite-flatbuffers-pin.patch",
  "native/ambient-music/src/main.mm",
  "resources/app-icon.png",
]);

const EXPECTED_IDENTITIES = Object.freeze({
  "Magenta RealTime": "https://github.com/magenta/magenta-realtime.git",
  MLX: "https://github.com/ml-explore/mlx.git",
  "TensorFlow Lite": "https://github.com/tensorflow/tensorflow.git",
  SentencePiece: "https://github.com/google/sentencepiece.git",
  "MLX vendored PocketFFT": "https://gitlab.mpcdf.mpg.de/mtr/pocketfft.git",
  Abseil: "https://github.com/abseil/abseil-cpp.git",
  "SentencePiece vendored Abseil flags": "https://github.com/google/sentencepiece.git",
  "SentencePiece vendored Darts-clone": "https://github.com/s-yata/darts-clone.git",
  "SentencePiece vendored Protocol Buffers Lite": "https://github.com/google/sentencepiece.git",
  "cpuinfo and CLOG": "https://github.com/pytorch/cpuinfo.git",
  FarmHash: "https://github.com/google/farmhash.git",
  "Ooura FFT2D": "https://www.kurims.kyoto-u.ac.jp/~ooura/fft.html",
  FlatBuffers: "https://github.com/google/flatbuffers.git",
  gemmlowp: "https://github.com/google/gemmlowp.git",
  Ruy: "https://github.com/google/ruy.git",
  Eigen: "https://gitlab.com/libeigen/eigen.git",
  ml_dtypes: "https://github.com/jax-ml/ml_dtypes.git",
  fmt: "https://github.com/fmtlib/fmt.git",
  "nlohmann/json": "https://github.com/nlohmann/json.git",
  "Apple metal-cpp": "https://developer.apple.com/metal/cpp/",
  "Protocol Buffers": "https://github.com/protocolbuffers/protobuf.git",
});

const FETCHED_GIT_SOURCES = Object.freeze([
  ["Magenta RealTime", "_deps/magenta-realtime-src"],
  ["MLX", "_deps/mlx-src"],
  ["TensorFlow Lite", "_deps/tensorflow-lite-src"],
  ["SentencePiece", "_deps/sentencepiece-src"],
  ["Abseil", "abseil-cpp"],
  ["cpuinfo and CLOG", "cpuinfo"],
  ["FarmHash", "farmhash"],
  ["FlatBuffers", "flatbuffers"],
  ["gemmlowp", "gemmlowp"],
  ["Ruy", "ruy"],
  ["Eigen", "eigen"],
  ["ml_dtypes", "ml_dtypes"],
  ["fmt", "_deps/fmt-src"],
  ["Protocol Buffers", "protobuf"],
]);

const VENDORED_SOURCES = Object.freeze([
  ["MLX vendored PocketFFT", "MLX", "_deps/mlx-src/mlx/3rdparty/pocketfft.h"],
  [
    "SentencePiece vendored Abseil flags",
    "SentencePiece",
    "_deps/sentencepiece-src/third_party/absl/flags/flag.cc",
  ],
  [
    "SentencePiece vendored Darts-clone",
    "SentencePiece",
    "_deps/sentencepiece-src/third_party/darts_clone/darts.h",
  ],
  [
    "SentencePiece vendored Protocol Buffers Lite",
    "SentencePiece",
    "_deps/sentencepiece-src/third_party/protobuf-lite",
  ],
]);

const ARCHIVE_SOURCES = Object.freeze([
  ["Ooura FFT2D", "fft2d"],
  ["nlohmann/json", "_deps/json-src"],
  ["Apple metal-cpp", "_deps/metal_cpp-src"],
]);

const EXPECTED_CONFIGURED_MUTATIONS = Object.freeze([
  "Eigen:bench/spbench/CMakeLists.txt",
  "Eigen:cmake/language_support.cmake",
  "Eigen:doc/CMakeLists.txt",
  "Eigen:unsupported/doc/CMakeLists.txt",
  "MLX:mlx/backend/metal/make_compiled_preamble.sh",
  "TensorFlow Lite:tensorflow/lite/tools/cmake/modules/flatbuffers.cmake",
]);

const EXPECTED_FETCHED_SUBMODULES = Object.freeze([
  "Magenta RealTime:magenta_rt/_vendor/sequence-layers",
  "Protocol Buffers:third_party/benchmark",
  "Protocol Buffers:third_party/googletest",
  "Ruy:third_party/cpuinfo",
  "Ruy:third_party/googletest",
  "ml_dtypes:third_party/eigen",
]);

const EXPECTED_FETCHCONTENT_SOURCE_DIRS = Object.freeze([
  "_deps/fmt-src",
  "_deps/json-src",
  "_deps/magenta-realtime-src",
  "_deps/metal_cpp-src",
  "_deps/mlx-src",
  "_deps/sentencepiece-src",
  "_deps/tensorflow-lite-src",
]);

const FORBIDDEN_CONFIGURED_CACHE_KEYS = Object.freeze([
  "CMAKE_C_COMPILER_LAUNCHER",
  "CMAKE_CXX_COMPILER_LAUNCHER",
  "CMAKE_MODULE_PATH",
  "CMAKE_OBJCXX_COMPILER_LAUNCHER",
  "CMAKE_PREFIX_PATH",
  "CMAKE_PROJECT_INCLUDE",
  "CMAKE_PROJECT_INCLUDE_BEFORE",
  "CMAKE_PROJECT_TOP_LEVEL_INCLUDES",
  "CMAKE_TOOLCHAIN_FILE",
]);

const DIRECT_GIT_FETCHES = Object.freeze([
  ["Magenta RealTime", "magenta-realtime"],
  ["MLX", "mlx"],
  ["TensorFlow Lite", "tensorflow-lite"],
  ["SentencePiece", "sentencepiece"],
  ["fmt", "fmt"],
]);

const DIRECT_ARCHIVE_FETCHES = Object.freeze([
  [
    "nlohmann/json",
    "json",
    "https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz",
  ],
  ["Apple metal-cpp", "metal_cpp", "https://developer.apple.com/metal/cpp/files/metal-cpp_26.zip"],
]);

function dependencyMap(provenance) {
  if (provenance?.schemaVersion !== 2) {
    throw new Error("Ambient Music source provenance has an unsupported schema.");
  }
  const dependencies = new Map();
  for (const groupName of DEPENDENCY_GROUPS) {
    const group = provenance[groupName];
    if (!Array.isArray(group)) {
      throw new Error(`Ambient Music source provenance is missing ${groupName}.`);
    }
    for (const dependency of group) {
      if (
        typeof dependency !== "object" ||
        dependency === null ||
        typeof dependency.name !== "string" ||
        dependencies.has(dependency.name) ||
        typeof dependency.repository !== "string" ||
        EXPECTED_IDENTITIES[dependency.name] !== dependency.repository ||
        (typeof dependency.revision !== "string" && typeof dependency.archiveSha256 !== "string")
      ) {
        throw new Error(
          "Ambient Music source provenance contains an unknown or invalid dependency.",
        );
      }
      if (dependency.revision !== undefined && !/^[a-f0-9]{40}$/u.test(dependency.revision)) {
        throw new Error(`Ambient Music dependency has an invalid revision: ${dependency.name}.`);
      }
      if (
        dependency.archiveSha256 !== undefined &&
        !/^[a-f0-9]{64}$/u.test(dependency.archiveSha256)
      ) {
        throw new Error(
          `Ambient Music dependency has an invalid archive digest: ${dependency.name}.`,
        );
      }
      dependencies.set(dependency.name, dependency);
    }
  }
  const expectedNames = Object.keys(EXPECTED_IDENTITIES).sort();
  const actualNames = [...dependencies.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Ambient Music provenance differs from the exact reviewed dependency graph.");
  }
  for (const [name, ownerName] of VENDORED_SOURCES) {
    const dependency = dependencies.get(name);
    const owner = dependencies.get(ownerName);
    if (
      dependency.revision !== owner.revision ||
      dependency.revisionScope !== `${ownerName} vendored tree`
    ) {
      throw new Error(`Ambient Music vendored dependency is not bound to ${ownerName}: ${name}.`);
    }
  }
  return dependencies;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fetchBlock(cmakeSource, fetchName) {
  const match = cmakeSource.match(
    new RegExp(`FetchContent_Declare\\(\\s*${escapeRegExp(fetchName)}\\b[\\s\\S]*?\\n\\s*\\)`, "u"),
  );
  if (!match) throw new Error(`Ambient Music CMake is missing FetchContent pin: ${fetchName}.`);
  return match[0];
}

/**
 * Binds the reviewed identity/pin document to the build file that selects the
 * direct graph. Transitive source identities are checked after CMake fetches
 * them by verifyAmbientMusicFetchedGraph.
 */
export function assertAmbientMusicCMakeProvenance(provenance, cmakeSource) {
  const dependencies = dependencyMap(provenance);
  for (const [name, fetchName] of DIRECT_GIT_FETCHES) {
    const dependency = dependencies.get(name);
    const block = fetchBlock(cmakeSource, fetchName);
    if (
      !block.includes(`GIT_REPOSITORY ${dependency.repository}`) ||
      !block.includes(`GIT_TAG ${dependency.revision}`) ||
      !block.includes("GIT_SHALLOW OFF")
    ) {
      throw new Error(`Ambient Music CMake git pin differs from provenance: ${name}.`);
    }
  }
  for (const [name, fetchName, url] of DIRECT_ARCHIVE_FETCHES) {
    const dependency = dependencies.get(name);
    const block = fetchBlock(cmakeSource, fetchName);
    if (
      !block.includes(`URL ${url}`) ||
      !block.includes(`URL_HASH SHA256=${dependency.archiveSha256}`)
    ) {
      throw new Error(`Ambient Music CMake archive pin differs from provenance: ${name}.`);
    }
  }
  if (
    !cmakeSource.includes("patches/mlx-header-paths.patch") ||
    !cmakeSource.includes("patches/tflite-flatbuffers-pin.patch")
  ) {
    throw new Error("Ambient Music CMake does not apply the reviewed dependency patches.");
  }
  return dependencies;
}

export function assertAmbientMusicNativeBuildInputs(
  provenance,
  repositoryRoot,
  overrides = new Map(),
) {
  if (!Array.isArray(provenance?.nativeBuildInputs)) {
    throw new Error("Ambient Music provenance is missing native build inputs.");
  }
  const records = new Map();
  for (const record of provenance.nativeBuildInputs) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.path !== "string" ||
      path.isAbsolute(record.path) ||
      record.path.split(/[\\/]/u).includes("..") ||
      records.has(record.path) ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      throw new Error("Ambient Music provenance contains an invalid native build input.");
    }
    records.set(record.path, record.sha256);
  }
  if (
    JSON.stringify([...records.keys()].sort()) !==
    JSON.stringify([...EXPECTED_NATIVE_BUILD_INPUTS].sort())
  ) {
    throw new Error("Ambient Music provenance differs from the exact native build input set.");
  }
  for (const [relativePath, expectedHash] of records) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    let bytes;
    try {
      bytes = overrides.has(relativePath)
        ? overrides.get(relativePath)
        : fs.readFileSync(absolutePath);
    } catch {
      throw new Error(`Ambient Music native build input is missing: ${relativePath}.`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new Error(`Ambient Music native build input differs from provenance: ${relativePath}.`);
    }
  }
}

function assertBoundPath(buildRoot, relativePath, expectedType) {
  const candidate = path.join(buildRoot, relativePath);
  let info;
  try {
    info = fs.lstatSync(candidate);
  } catch {
    throw new Error(`Ambient Music fetched source is missing: ${relativePath}.`);
  }
  if (
    info.isSymbolicLink() ||
    (expectedType === "directory" ? !info.isDirectory() : !info.isFile()) ||
    fs.realpathSync(candidate) !== candidate
  ) {
    throw new Error(
      `Ambient Music fetched source is not a bound ${expectedType}: ${relativePath}.`,
    );
  }
  return candidate;
}

function runGit(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LC_ALL: "C",
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not verify Ambient Music fetched git source: ${path.basename(directory)}.`,
    );
  }
  return result.stdout.trimEnd();
}

function normalizedRepository(repository) {
  return repository.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function ambientMusicSourceTreeDigest(root) {
  const hash = createHash("sha256");
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      const info = fs.lstatSync(candidate);
      if (info.isSymbolicLink()) {
        throw new Error(`Ambient Music archive source contains a symlink: ${relative}.`);
      }
      if (info.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        walk(candidate);
      } else if (info.isFile()) {
        hash.update(`f\0${relative}\0${info.size}\0`);
        hash.update(fs.readFileSync(candidate));
      } else {
        throw new Error(`Ambient Music archive source contains an unsupported entry: ${relative}.`);
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

export function assertAmbientMusicReviewedGitState(
  source,
  name,
  expectedRecords = [],
  expectedSubmodules = [],
) {
  const actualStatus = runGit(source, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
  const expectedStatus = expectedRecords
    .map((record) => `${record.status === "modified" ? " M" : "??"} ${record.path}`)
    .sort();
  if (JSON.stringify(actualStatus) !== JSON.stringify(expectedStatus)) {
    throw new Error(`Ambient Music fetched source has unreviewed changes: ${name}.`);
  }
  for (const record of expectedRecords) {
    const candidate = path.join(source, record.path);
    const info = fs.lstatSync(candidate);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      fs.realpathSync(candidate) !== candidate ||
      sha256File(candidate) !== record.sha256
    ) {
      throw new Error(`Ambient Music reviewed source mutation differs: ${name}/${record.path}.`);
    }
  }
  const actualSubmodules = runGit(source, ["submodule", "status", "--recursive"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([ +\-U])([a-f0-9]{40})\s+(\S+)/u);
      if (!match || match[1] !== " ") {
        throw new Error(`Ambient Music fetched submodule is not clean: ${name}.`);
      }
      return `${match[2]} ${match[3]}`;
    })
    .sort();
  const expected = expectedSubmodules.map((record) => `${record.revision} ${record.path}`).sort();
  if (JSON.stringify(actualSubmodules) !== JSON.stringify(expected)) {
    throw new Error(`Ambient Music fetched submodules differ from provenance: ${name}.`);
  }
}

function configuredMutations(provenance, dependencies) {
  if (!Array.isArray(provenance.configuredSourceMutations)) {
    throw new Error("Ambient Music provenance is missing configured source mutations.");
  }
  const records = new Map();
  for (const record of provenance.configuredSourceMutations) {
    const key = `${record?.dependency}:${record?.path}`;
    if (
      typeof record !== "object" ||
      record === null ||
      !dependencies.has(record.dependency) ||
      typeof record.path !== "string" ||
      path.isAbsolute(record.path) ||
      record.path.split(/[\\/]/u).includes("..") ||
      (record.status !== "modified" && record.status !== "untracked") ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      records.has(key)
    ) {
      throw new Error("Ambient Music provenance contains an invalid configured source mutation.");
    }
    records.set(key, record);
  }
  if (
    JSON.stringify([...records.keys()].sort()) !==
    JSON.stringify([...EXPECTED_CONFIGURED_MUTATIONS].sort())
  ) {
    throw new Error("Ambient Music configured source mutations differ from the reviewed set.");
  }
  return records;
}

function fetchedSubmodules(provenance, dependencies) {
  if (!Array.isArray(provenance.fetchedSubmodules)) {
    throw new Error("Ambient Music provenance is missing fetched submodules.");
  }
  const records = new Map();
  for (const record of provenance.fetchedSubmodules) {
    const key = `${record?.dependency}:${record?.path}`;
    if (
      typeof record !== "object" ||
      record === null ||
      !dependencies.has(record.dependency) ||
      typeof record.path !== "string" ||
      path.isAbsolute(record.path) ||
      record.path.split(/[\\/]/u).includes("..") ||
      typeof record.revision !== "string" ||
      !/^[a-f0-9]{40}$/u.test(record.revision) ||
      typeof record.repository !== "string" ||
      !/^https:\/\/[A-Za-z0-9._~:/-]+(?:\.git)?$/u.test(record.repository) ||
      records.has(key)
    ) {
      throw new Error("Ambient Music provenance contains an invalid fetched submodule.");
    }
    records.set(key, record);
  }
  if (
    JSON.stringify([...records.keys()].sort()) !==
    JSON.stringify([...EXPECTED_FETCHED_SUBMODULES].sort())
  ) {
    throw new Error("Ambient Music fetched submodules differ from the reviewed set.");
  }
  return records;
}

function configuredLinkDigest(provenance) {
  if (
    typeof provenance.configuredHelperLinkSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(provenance.configuredHelperLinkSha256)
  ) {
    throw new Error("Ambient Music provenance is missing the configured helper link digest.");
  }
  return provenance.configuredHelperLinkSha256;
}

function assertExactFetchContentSourceDirectories(buildRoot) {
  const dependencyRoot = assertBoundPath(buildRoot, "_deps", "directory");
  const actual = fs
    .readdirSync(dependencyRoot, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith("-src"))
    .map((entry) => {
      const relative = `_deps/${entry.name}`;
      assertBoundPath(buildRoot, relative, "directory");
      return relative;
    })
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...EXPECTED_FETCHCONTENT_SOURCE_DIRS].sort())) {
    throw new Error("Ambient Music configured build contains an unreviewed fetched source root.");
  }
}

function assertNoConfiguredCMakeInjection(buildRoot) {
  const cache = fs.readFileSync(assertBoundPath(buildRoot, "CMakeCache.txt", "file"), "utf8");
  const values = new Map();
  for (const line of cache.split("\n")) {
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const match = line.match(/^([^:=]+):[^=]*=(.*)$/u);
    if (match) values.set(match[1], match[2]);
  }
  for (const key of FORBIDDEN_CONFIGURED_CACHE_KEYS) {
    if (values.get(key)?.trim()) {
      throw new Error(`Ambient Music CMake configuration contains an injected override: ${key}.`);
    }
  }
}

function assertExactHelperLink(provenance, buildRoot) {
  const link = assertBoundPath(
    buildRoot,
    "CMakeFiles/aiden-ambient-music-helper.dir/link.txt",
    "file",
  );
  if (sha256File(link) !== configuredLinkDigest(provenance)) {
    throw new Error("Ambient Music configured helper link graph differs from provenance.");
  }
}

export function assertAmbientMusicConfiguredBuildEvidence(provenance, buildPath) {
  const buildRoot = fs.realpathSync(buildPath);
  assertNoConfiguredCMakeInjection(buildRoot);
  assertExactFetchContentSourceDirectories(buildRoot);
  assertExactHelperLink(provenance, buildRoot);
}

function collectGitRoots(buildRoot) {
  const roots = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") {
        roots.push(path.relative(buildRoot, directory).split(path.sep).join("/"));
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(directory, entry.name));
      }
    }
  };
  walk(buildRoot);
  return roots.sort();
}

/** Verify the effective fetched graph immediately after CMake configuration. */
export function verifyAmbientMusicFetchedGraph(provenance, buildPath) {
  const cmakePath = path.resolve("native", "ambient-music", "CMakeLists.txt");
  const dependencies = assertAmbientMusicCMakeProvenance(
    provenance,
    fs.readFileSync(cmakePath, "utf8"),
  );
  const buildRoot = fs.realpathSync(buildPath);
  assertAmbientMusicConfiguredBuildEvidence(provenance, buildRoot);
  const mutations = configuredMutations(provenance, dependencies);
  const submodules = fetchedSubmodules(provenance, dependencies);
  const gitRootByDependency = new Map(FETCHED_GIT_SOURCES);
  for (const [name, relativePath] of FETCHED_GIT_SOURCES) {
    const dependency = dependencies.get(name);
    const source = assertBoundPath(buildRoot, relativePath, "directory");
    if (runGit(source, ["rev-parse", "HEAD"]) !== dependency.revision) {
      throw new Error(`Ambient Music fetched revision differs from provenance: ${name}.`);
    }
    if (
      normalizedRepository(runGit(source, ["remote", "get-url", "origin"])) !==
      normalizedRepository(dependency.repository)
    ) {
      throw new Error(`Ambient Music fetched repository differs from provenance: ${name}.`);
    }
    const expectedRecords = [...mutations.values()].filter((record) => record.dependency === name);
    const expectedSubmodules = [...submodules.values()].filter(
      (record) => record.dependency === name,
    );
    assertAmbientMusicReviewedGitState(source, name, expectedRecords, expectedSubmodules);
    for (const record of expectedSubmodules) {
      const submodule = assertBoundPath(source, record.path, "directory");
      if (
        normalizedRepository(runGit(submodule, ["remote", "get-url", "origin"])) !==
        normalizedRepository(record.repository)
      ) {
        throw new Error(
          `Ambient Music fetched submodule repository differs from provenance: ${name}/${record.path}.`,
        );
      }
    }
  }
  for (const [name, ownerName, relativePath] of VENDORED_SOURCES) {
    const dependency = dependencies.get(name);
    const owner = dependencies.get(ownerName);
    assertBoundPath(
      buildRoot,
      relativePath,
      relativePath.endsWith("protobuf-lite") ? "directory" : "file",
    );
    if (dependency.revision !== owner.revision) {
      throw new Error(`Ambient Music vendored revision differs from provenance: ${name}.`);
    }
  }
  for (const [name, relativePath] of ARCHIVE_SOURCES) {
    const dependency = dependencies.get(name);
    const source = assertBoundPath(buildRoot, relativePath, "directory");
    if (
      typeof dependency.extractedTreeSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(dependency.extractedTreeSha256) ||
      ambientMusicSourceTreeDigest(source) !== dependency.extractedTreeSha256
    ) {
      throw new Error(`Ambient Music extracted archive tree differs from provenance: ${name}.`);
    }
  }
  const fft2d = dependencies.get("Ooura FFT2D");
  const fftModule = assertBoundPath(
    buildRoot,
    "_deps/tensorflow-lite-src/tensorflow/lite/tools/cmake/modules/fft2d.cmake",
    "file",
  );
  if (!fs.readFileSync(fftModule, "utf8").includes(`URL_HASH SHA256=${fft2d.archiveSha256}`)) {
    throw new Error("Ambient Music fetched FFT2D archive pin differs from provenance.");
  }
  const expectedGitRoots = [
    ...FETCHED_GIT_SOURCES.map(([, relativePath]) => relativePath),
    ...[...submodules.values()].map(
      (record) => `${gitRootByDependency.get(record.dependency)}/${record.path}`,
    ),
  ].sort();
  if (JSON.stringify(collectGitRoots(buildRoot)) !== JSON.stringify(expectedGitRoots)) {
    throw new Error("Ambient Music configured build contains an unreviewed git source root.");
  }
}

function dependencyFilePaths(file) {
  const contents = fs.readFileSync(file, "utf8").replace(/\\\r?\n/gu, " ");
  const separator = contents.indexOf(":");
  if (separator < 0) {
    throw new Error(`Ambient Music compiler dependency file is malformed: ${path.basename(file)}.`);
  }
  const dependencies = [];
  let current = "";
  let escaped = false;
  for (const character of contents.slice(separator + 1)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (/\s/u.test(character)) {
      if (current.length > 0) dependencies.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current.length > 0) dependencies.push(current);
  return dependencies;
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Verify every compiler input after the native target has been built. */
export function verifyAmbientMusicBuiltGraph(provenance, buildPath, sourcePath, developerPath) {
  const buildRoot = fs.realpathSync(buildPath);
  const sourceRoot = fs.realpathSync(sourcePath);
  const developerRoot = fs.realpathSync(developerPath);
  assertExactHelperLink(provenance, buildRoot);
  const dependencyFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(candidate);
      else if (entry.isFile() && entry.name.endsWith(".o.d")) dependencyFiles.push(candidate);
    }
  };
  walk(buildRoot);
  if (dependencyFiles.length === 0) {
    throw new Error("Ambient Music build produced no compiler dependency evidence.");
  }
  for (const dependencyFile of dependencyFiles) {
    for (const dependency of dependencyFilePaths(dependencyFile)) {
      const resolved = path.isAbsolute(dependency)
        ? path.normalize(dependency)
        : path.resolve(buildRoot, dependency);
      if (
        !isWithin(resolved, buildRoot) &&
        !isWithin(resolved, sourceRoot) &&
        !isWithin(resolved, developerRoot)
      ) {
        throw new Error(`Ambient Music compiler consumed an unreviewed source root: ${resolved}.`);
      }
    }
  }
}
