/* global console, process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAmbientMusicCMakeProvenance,
  assertAmbientMusicNativeBuildInputs,
  verifyAmbientMusicBuiltGraph,
  verifyAmbientMusicFetchedGraph,
} from "./ambient-music-provenance.mjs";

const required = process.argv.includes("--required");
const optional = process.argv.includes("--optional");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "native", "ambient-music");
const requestedBuildPath = process.env.AIDEN_AMBIENT_MUSIC_BUILD_DIR
  ? path.resolve(process.env.AIDEN_AMBIENT_MUSIC_BUILD_DIR)
  : path.join(projectRoot, "build", "native-ambient-music");
let buildPath;
const appName = "Aiden Ambient Music Helper.app";
const destination = path.join(projectRoot, "build", "native", appName);
const executableName = "aiden-ambient-music-helper";
const executable = path.join(destination, "Contents", "MacOS", executableName);
const infoPlist = path.join(sourcePath, "Info.plist");
const artwork = path.join(projectRoot, "resources", "app-icon.png");
const legalSource = path.join(projectRoot, "resources", "ambient-music");
const legalFiles = Object.freeze([
  "MODEL_TERMS.md",
  "NOTICE.md",
  "asset-manifest.json",
  "source-provenance.json",
]);
const nativeBuildEnvironment = Object.freeze(
  Object.fromEntries(
    Object.entries({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: process.env.HOME,
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    }).filter(([, value]) => typeof value === "string" && value.length > 0),
  ),
);

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readLicenseRecords() {
  let provenance;
  try {
    provenance = JSON.parse(
      fs.readFileSync(path.join(legalSource, "source-provenance.json"), "utf8"),
    );
  } catch {
    fail("The Ambient Music source provenance is invalid JSON.");
  }
  if (provenance?.schemaVersion !== 2 || !Array.isArray(provenance.packagedLicenseFiles)) {
    fail("The Ambient Music source provenance has an unsupported legal schema.");
  }
  const records = provenance.packagedLicenseFiles;
  const packageFiles = new Set();
  for (const record of records) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.packageFile !== "string" ||
      !/^LICENSE\.[A-Za-z0-9-]+\.txt$/u.test(record.packageFile) ||
      packageFiles.has(record.packageFile) ||
      (record.sourceRoot !== "repository" && record.sourceRoot !== "nativeBuild") ||
      typeof record.sourcePath !== "string" ||
      path.isAbsolute(record.sourcePath) ||
      record.sourcePath.split(/[\\/]/u).includes("..") ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      fail("The Ambient Music source provenance contains an invalid license record.");
    }
    packageFiles.add(record.packageFile);
  }
  const groups = [
    provenance.nativeSources,
    provenance.compiledDependencies,
    provenance.headerDependencies,
    provenance.buildOnlyDependencies,
  ];
  const referenced = new Set();
  for (const group of groups) {
    if (!Array.isArray(group))
      fail("The Ambient Music source provenance is missing a dependency group.");
    for (const dependency of group) {
      if (!Array.isArray(dependency?.licenseFiles) || dependency.licenseFiles.length === 0) {
        fail("Every Ambient Music native dependency must name its packaged license files.");
      }
      for (const packageFile of dependency.licenseFiles) {
        if (!packageFiles.has(packageFile)) {
          fail(`Ambient Music provenance references an unknown license file: ${packageFile}.`);
        }
        referenced.add(packageFile);
      }
    }
  }
  if (referenced.size !== packageFiles.size) {
    fail("The Ambient Music legal inventory contains an unreferenced license file.");
  }
  return { provenance, records };
}

function fail(message, status = 1) {
  if (buildPath) fs.rmSync(buildPath, { force: true, recursive: true });
  fs.rmSync(destination, { force: true, recursive: true });
  if (required) {
    console.error(message);
    process.exit(status || 1);
  }
  console.warn(`${message} Ambient Music will be unavailable in this development build.`);
  process.exit(0);
}

if (!required && !optional) {
  console.error("Use --required for packaging or --optional for development.");
  process.exit(2);
}

if (!fs.existsSync(artwork)) {
  fail("The Ambient Music Now Playing artwork is missing.");
}
for (const legalFile of legalFiles) {
  if (!fs.existsSync(path.join(legalSource, legalFile))) {
    fail(`The reviewed Ambient Music notice is missing: ${legalFile}.`);
  }
}
const { provenance, records: licenseRecords } = readLicenseRecords();
try {
  assertAmbientMusicNativeBuildInputs(provenance, projectRoot);
  assertAmbientMusicCMakeProvenance(
    provenance,
    fs.readFileSync(path.join(sourcePath, "CMakeLists.txt"), "utf8"),
  );
} catch (error) {
  fail(error instanceof Error ? error.message : "Ambient Music provenance verification failed.");
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("The Ambient Music helper requires macOS on Apple Silicon.");
}

if (optional && process.env.AIDEN_BUILD_AMBIENT_MUSIC !== "1") {
  fs.rmSync(destination, { force: true, recursive: true });
  console.log(
    "Ambient Music helper: skipped optional native build (set AIDEN_BUILD_AMBIENT_MUSIC=1 to enable). ",
  );
  process.exit(0);
}

fs.mkdirSync(path.dirname(requestedBuildPath), { recursive: true });
buildPath = fs.mkdtempSync(
  path.join(path.dirname(requestedBuildPath), `${path.basename(requestedBuildPath)}.verified-`),
);
const configure = spawnSync(
  "cmake",
  [
    "-S",
    sourcePath,
    "-B",
    buildPath,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DAIDEN_AMBIENT_MUSIC_WITH_MAGENTA=ON",
  ],
  { cwd: projectRoot, encoding: "utf8", env: nativeBuildEnvironment, stdio: "inherit" },
);
if (configure.error || configure.status !== 0) {
  fail("Could not configure the Ambient Music helper.", configure.status ?? 1);
}
try {
  verifyAmbientMusicFetchedGraph(provenance, buildPath);
} catch (error) {
  fail(
    error instanceof Error
      ? error.message
      : "The fetched Ambient Music dependency graph could not be verified.",
  );
}

const build = spawnSync("cmake", ["--build", buildPath, "--target", executableName, "--parallel"], {
  cwd: projectRoot,
  encoding: "utf8",
  env: nativeBuildEnvironment,
  stdio: "inherit",
});
if (build.error || build.status !== 0) {
  fail("Could not build the Ambient Music helper.", build.status ?? 1);
}
const developerDirectory = spawnSync("/usr/bin/xcode-select", ["-p"], {
  cwd: projectRoot,
  encoding: "utf8",
  env: nativeBuildEnvironment,
});
if (developerDirectory.error || developerDirectory.status !== 0) {
  fail("Could not resolve the reviewed Apple developer toolchain.");
}
try {
  verifyAmbientMusicBuiltGraph(provenance, buildPath, sourcePath, developerDirectory.stdout.trim());
} catch (error) {
  fail(
    error instanceof Error
      ? error.message
      : "The compiled Ambient Music dependency graph could not be verified.",
  );
}

const sourceExecutable = path.join(buildPath, executableName);
const metallibs = [];
function collectMetallibs(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMetallibs(entryPath);
    else if (entry.name === "mlx.metallib") metallibs.push(entryPath);
  }
}
collectMetallibs(buildPath);
if (!fs.existsSync(sourceExecutable) || metallibs.length !== 1) {
  fail("The Ambient Music build did not produce exactly one helper and one mlx.metallib.");
}

fs.rmSync(destination, { force: true, recursive: true });
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.mkdirSync(path.join(destination, "Contents", "Resources"), { recursive: true });
fs.copyFileSync(sourceExecutable, executable);
fs.copyFileSync(metallibs[0], path.join(destination, "Contents", "MacOS", "mlx.metallib"));
fs.copyFileSync(infoPlist, path.join(destination, "Contents", "Info.plist"));
fs.copyFileSync(
  artwork,
  path.join(destination, "Contents", "Resources", "AmbientMusicArtwork.png"),
);
for (const legalFile of legalFiles) {
  fs.copyFileSync(
    path.join(legalSource, legalFile),
    path.join(destination, "Contents", "Resources", legalFile),
  );
}
for (const record of licenseRecords) {
  const sourceRoot = record.sourceRoot === "repository" ? projectRoot : buildPath;
  const source = path.join(sourceRoot, record.sourcePath);
  let info;
  try {
    info = fs.lstatSync(source);
  } catch {
    fail(`The pinned Ambient Music dependency license is missing: ${record.sourcePath}.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || sha256(source) !== record.sha256) {
    fail(
      `The pinned Ambient Music dependency license does not match provenance: ${record.packageFile}.`,
    );
  }
  fs.copyFileSync(source, path.join(destination, "Contents", "Resources", record.packageFile));
}
fs.chmodSync(executable, 0o755);
fs.rmSync(buildPath, { force: true, recursive: true });
buildPath = undefined;

const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (sign.error || sign.status !== 0) {
  fail("Could not sign the Ambient Music helper app.", sign.status ?? 1);
}

const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (verify.error || verify.status !== 0) {
  fail("The signed Ambient Music helper app did not verify.", verify.status ?? 1);
}

const smoke = spawnSync(
  process.execPath,
  ["--test", path.join(projectRoot, "scripts", "ambient-music-helper.test.mjs")],
  {
    cwd: projectRoot,
    env: { ...process.env, AIDEN_AMBIENT_MUSIC_TEST_HELPER: executable },
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (smoke.error || smoke.status !== 0) {
  fail(
    "The Magenta-linked Ambient Music helper failed its protocol smoke test.",
    smoke.status ?? 1,
  );
}

console.log(`Ambient Music helper: ${path.relative(projectRoot, destination)}`);
