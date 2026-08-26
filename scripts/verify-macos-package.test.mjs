/* global Buffer, structuredClone */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import {
  assertByteForByteMatch,
  ambientMusicLicenseInventory,
  assertAmbientMusicArchitecture,
  assertAmbientMusicMachOMinimum,
  assertComputerUseBundleExecutable,
  assertComputerUseExecutableMode,
  assertComputerUseMachOMinimum,
  assertComputerUseMinimumSystemVersion,
  assertDeveloperIdSignature,
  assertElectronEntitlements,
  assertElectronHelperEntitlements,
  assertExactUniversalArchitectures,
  assertMinimalComputerUseEntitlements,
  ambientMusicPackageIdentityReceipt,
  assertMacOSArchitectureMinimum,
  assertMatchingHostCodeHashes,
  assertPackagedModelCatalogEntries,
  assertNoAmbientMusicModelAssets,
  assertNoAmbientMusicModelAssetsOutsideDirectory,
  assertSamePackagedArtifactIdentity,
  assertHardenedRuntime,
  assertRegularFile,
  requiresReleaseVerification,
  verifyExactComputerUseHelperTree,
  verifyExactAmbientMusicHelperTree,
  verifyPackagedModelCatalogResources,
  verifyReviewedComputerUseInfoPlist,
} from "./verify-macos-package.mjs";
import {
  assertAmbientMusicCMakeProvenance,
  assertAmbientMusicConfiguredBuildEvidence,
  assertAmbientMusicNativeBuildInputs,
  assertAmbientMusicReviewedGitState,
  ambientMusicSourceTreeDigest,
  verifyAmbientMusicBuiltGraph,
} from "./ambient-music-provenance.mjs";

const ambientMusicProvenance = JSON.parse(
  readFileSync(
    new URL("../resources/ambient-music/source-provenance.json", import.meta.url),
    "utf8",
  ),
);
const ambientMusicLegalFiles = [
  ...ambientMusicLicenseInventory(ambientMusicProvenance).keys(),
  "MODEL_TERMS.md",
  "NOTICE.md",
  "asset-manifest.json",
  "source-provenance.json",
];

test("Ambient Music provenance locks the complete packaged dependency license inventory", () => {
  const inventory = ambientMusicLicenseInventory(ambientMusicProvenance);
  assert.equal(inventory.size, 28);
  assert.equal(
    inventory.get("LICENSE.mlx-acknowledgments.txt")?.sha256,
    "754321096cf44f1382ba2bb8309f9b445cffa9ea14ac44b9f21fc34619520b99",
  );
  assert.equal(
    inventory.get("LICENSE.sentencepiece-darts-clone.txt")?.sha256,
    "155f59997298ee336602c49f9c1110f268ac394ca2197eb02647a3555935ad52",
  );
  assert.equal(
    inventory.get("LICENSE.flatbuffers.txt")?.sha256,
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
  const missing = structuredClone(ambientMusicProvenance);
  missing.packagedLicenseFiles.pop();
  assert.throws(
    () => ambientMusicLicenseInventory(missing),
    /unknown license file|differs from the reviewed build graph/u,
  );
  const traversal = structuredClone(ambientMusicProvenance);
  traversal.packagedLicenseFiles[0].sourcePath = "../outside";
  assert.throws(() => ambientMusicLicenseInventory(traversal), /invalid license record/u);
});

test("Ambient Music provenance is mechanically bound to the reviewed CMake fetch graph", () => {
  const cmake = readFileSync(
    new URL("../native/ambient-music/CMakeLists.txt", import.meta.url),
    "utf8",
  );
  assert.doesNotThrow(() => assertAmbientMusicCMakeProvenance(ambientMusicProvenance, cmake));
  const driftedRevision = cmake.replace("ce45c52505c8158ea48d2a54e8caae05efd86bfe", "0".repeat(40));
  assert.throws(
    () => assertAmbientMusicCMakeProvenance(ambientMusicProvenance, driftedRevision),
    /CMake git pin differs/u,
  );
  const driftedArchive = cmake.replace(
    "d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d",
    "0".repeat(64),
  );
  assert.throws(
    () => assertAmbientMusicCMakeProvenance(ambientMusicProvenance, driftedArchive),
    /CMake archive pin differs/u,
  );
  const buildScript = readFileSync(
    new URL("./build-ambient-music-helper.mjs", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /verifyAmbientMusicFetchedGraph\(provenance, buildPath\)/u);
  assert.match(buildScript, /verifyAmbientMusicBuiltGraph\(/u);
  assert.match(buildScript, /GIT_CONFIG_GLOBAL: "\/dev\/null"/u);
  assert.match(buildScript, /env: nativeBuildEnvironment/u);
  assert.ok(
    ambientMusicProvenance.fetchedSubmodules.every(
      (record) => typeof record.repository === "string" && record.repository.startsWith("https://"),
    ),
  );
  assert.doesNotThrow(() =>
    assertAmbientMusicNativeBuildInputs(
      ambientMusicProvenance,
      path.resolve(new URL("..", import.meta.url).pathname),
    ),
  );
  const expandedCMake = new Map([
    [
      "native/ambient-music/CMakeLists.txt",
      Buffer.from(`${cmake}\nFetchContent_Declare(unreviewed URL https://example.invalid)\n`),
    ],
  ]);
  assert.throws(
    () =>
      assertAmbientMusicNativeBuildInputs(
        ambientMusicProvenance,
        path.resolve(new URL("..", import.meta.url).pathname),
        expandedCMake,
      ),
    /native build input differs/u,
  );
});

test("Ambient Music fetched sources reject dirty Git and extracted archive bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-source-state-"));
  const root = await realpath(temporaryRoot);
  const gitRoot = path.join(root, "git-source");
  const archiveRoot = path.join(root, "archive-source");
  try {
    await Promise.all([mkdir(gitRoot), mkdir(archiveRoot)]);
    const tracked = path.join(gitRoot, "compiled.cc");
    await writeFile(tracked, "reviewed source\n", "utf8");
    execFileSync("git", ["init", "--quiet", gitRoot]);
    execFileSync("git", ["-C", gitRoot, "add", "compiled.cc"]);
    execFileSync("git", [
      "-C",
      gitRoot,
      "-c",
      "user.name=Aiden Tests",
      "-c",
      "user.email=tests@invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    assert.doesNotThrow(() => assertAmbientMusicReviewedGitState(gitRoot, "fixture"));
    await writeFile(tracked, "mutated source\n", "utf8");
    assert.throws(
      () => assertAmbientMusicReviewedGitState(gitRoot, "fixture"),
      /unreviewed changes/u,
    );

    const extracted = path.join(archiveRoot, "compiled.h");
    await writeFile(extracted, "reviewed archive source\n", "utf8");
    const reviewedDigest = ambientMusicSourceTreeDigest(archiveRoot);
    await writeFile(extracted, "reviewed archive source!\n", "utf8");
    assert.notEqual(ambientMusicSourceTreeDigest(archiveRoot), reviewedDigest);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Ambient Music configured and compiled evidence rejects extra source, link, and header roots", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-build-evidence-"));
  const root = await realpath(temporaryRoot);
  const buildRoot = path.join(root, "build root");
  const sourceRoot = path.join(root, "source root");
  const developerRoot = path.join(root, "developer root");
  const link = "reviewed helper link\n";
  const provenance = structuredClone(ambientMusicProvenance);
  provenance.configuredHelperLinkSha256 = createHash("sha256").update(link).digest("hex");
  const expectedSources = [
    "fmt",
    "json",
    "magenta-realtime",
    "metal_cpp",
    "mlx",
    "sentencepiece",
    "tensorflow-lite",
  ];
  try {
    await Promise.all([
      ...expectedSources.map((name) =>
        mkdir(path.join(buildRoot, "_deps", `${name}-src`), { recursive: true }),
      ),
      mkdir(path.join(buildRoot, "CMakeFiles", "aiden-ambient-music-helper.dir", "src"), {
        recursive: true,
      }),
      mkdir(sourceRoot),
      mkdir(developerRoot),
    ]);
    await Promise.all([
      writeFile(path.join(buildRoot, "CMakeCache.txt"), "CMAKE_TOOLCHAIN_FILE:FILEPATH=\n"),
      writeFile(
        path.join(buildRoot, "CMakeFiles", "aiden-ambient-music-helper.dir", "link.txt"),
        link,
      ),
      writeFile(path.join(sourceRoot, "main.mm"), "source\n"),
      writeFile(path.join(developerRoot, "header.h"), "header\n"),
      writeFile(path.join(buildRoot, "generated.h"), "generated\n"),
    ]);
    assert.doesNotThrow(() => assertAmbientMusicConfiguredBuildEvidence(provenance, buildRoot));
    await mkdir(path.join(buildRoot, "_deps", "unreviewed-src"));
    assert.throws(
      () => assertAmbientMusicConfiguredBuildEvidence(provenance, buildRoot),
      /unreviewed fetched source root/u,
    );
    await rm(path.join(buildRoot, "_deps", "unreviewed-src"), { recursive: true });
    await writeFile(
      path.join(buildRoot, "CMakeFiles", "aiden-ambient-music-helper.dir", "link.txt"),
      `${link}/tmp/unreviewed.a\n`,
    );
    assert.throws(
      () => assertAmbientMusicConfiguredBuildEvidence(provenance, buildRoot),
      /link graph differs/u,
    );
    await writeFile(
      path.join(buildRoot, "CMakeFiles", "aiden-ambient-music-helper.dir", "link.txt"),
      link,
    );
    await writeFile(
      path.join(buildRoot, "CMakeCache.txt"),
      "CMAKE_TOOLCHAIN_FILE:FILEPATH=/tmp/injected.cmake\n",
    );
    assert.throws(
      () => assertAmbientMusicConfiguredBuildEvidence(provenance, buildRoot),
      /injected override/u,
    );
    await writeFile(path.join(buildRoot, "CMakeCache.txt"), "CMAKE_TOOLCHAIN_FILE:FILEPATH=\n");
    const dependencyFile = path.join(
      buildRoot,
      "CMakeFiles",
      "aiden-ambient-music-helper.dir",
      "src",
      "main.mm.o.d",
    );
    await writeFile(
      dependencyFile,
      `object: ${[
        path.join(sourceRoot, "main.mm"),
        path.join(developerRoot, "header.h"),
        path.join(buildRoot, "generated.h"),
      ]
        .map((entry) => entry.replaceAll("\\", "\\\\").replaceAll(" ", "\\ "))
        .join(" ")}\n`,
    );
    assert.doesNotThrow(() =>
      verifyAmbientMusicBuiltGraph(provenance, buildRoot, sourceRoot, developerRoot),
    );
    await writeFile(dependencyFile, "object: /tmp/unreviewed-header.h\n");
    assert.throws(
      () => verifyAmbientMusicBuiltGraph(provenance, buildRoot, sourceRoot, developerRoot),
      /unreviewed source root/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function createComputerUseHelperTree(root) {
  const contents = path.join(root, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  const signature = path.join(contents, "_CodeSignature");
  await Promise.all([
    mkdir(macOS, { recursive: true }),
    mkdir(resources, { recursive: true }),
    mkdir(signature, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(contents, "Info.plist"), "reviewed plist", "utf8"),
    writeFile(path.join(macOS, "aiden-cua-broker"), "broker", "utf8"),
    writeFile(path.join(macOS, "cua-driver"), "driver", "utf8"),
    writeFile(path.join(resources, "LICENSE.cua-driver.md"), "license", "utf8"),
    writeFile(path.join(resources, "cua-driver-artifact.json"), "{}", "utf8"),
    writeFile(path.join(signature, "CodeResources"), "signature", "utf8"),
  ]);
}

async function createAmbientMusicHelperTree(root) {
  const contents = path.join(root, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  const signature = path.join(contents, "_CodeSignature");
  await Promise.all([
    mkdir(macOS, { recursive: true }),
    mkdir(resources, { recursive: true }),
    mkdir(signature, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(contents, "Info.plist"), "plist", "utf8"),
    writeFile(path.join(macOS, "aiden-ambient-music-helper"), "helper", "utf8"),
    writeFile(path.join(macOS, "mlx.metallib"), "metal", "utf8"),
    writeFile(path.join(resources, "AmbientMusicArtwork.png"), "art", "utf8"),
    ...ambientMusicLegalFiles.map((file) => writeFile(path.join(resources, file), file, "utf8")),
    writeFile(path.join(signature, "CodeResources"), "signature", "utf8"),
  ]);
}

function modelCatalogFixture() {
  return {
    openai: {
      models: {
        "openai/example": {
          name: "Example",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  };
}

test("package verifier rejects symlinked Computer Use resources", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-package-file-"));
  const root = await realpath(temporaryRoot);
  const reviewed = path.join(root, "reviewed");
  const substituted = path.join(root, "substituted");
  try {
    await writeFile(reviewed, "reviewed\n", "utf8");
    await symlink(reviewed, substituted);
    await assert.doesNotReject(assertRegularFile(reviewed));
    await assert.rejects(assertRegularFile(substituted), /regular non-symlinked package file/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier requires byte-identical Computer Use provenance and notice files", () => {
  assert.doesNotThrow(() =>
    assertByteForByteMatch(Buffer.from("reviewed\n"), Buffer.from("reviewed\n"), "notice"),
  );
  assert.throws(
    () => assertByteForByteMatch(Buffer.from("substituted\n"), Buffer.from("reviewed\n"), "notice"),
    /differs from the reviewed copy/,
  );
});

test("package verifier requires models.dev and rejects a bundled Artificial Analysis snapshot", async () => {
  assert.doesNotThrow(() =>
    assertPackagedModelCatalogEntries(["/resources/model-capabilities.json"]),
  );
  assert.throws(() => assertPackagedModelCatalogEntries([]), /missing the models.dev/u);
  assert.throws(
    () =>
      assertPackagedModelCatalogEntries([
        "/resources/model-capabilities.json",
        "/resources/artificial-analysis-models.json",
      ]),
    /obsolete Artificial Analysis/u,
  );

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-model-catalog-asar-"));
  const root = await realpath(temporaryRoot);
  const source = path.join(root, "source");
  const resources = path.join(source, "resources");
  const rejectedAsar = path.join(root, "rejected.asar");
  const acceptedAsar = path.join(root, "accepted.asar");
  const malformedAsar = path.join(root, "malformed.asar");
  try {
    await mkdir(resources, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(resources, "model-capabilities.json"),
        `${JSON.stringify(modelCatalogFixture())}\n`,
        "utf8",
      ),
      writeFile(path.join(resources, "artificial-analysis-models.json"), "{}\n", "utf8"),
    ]);
    await createPackage(source, rejectedAsar);
    await assert.rejects(
      verifyPackagedModelCatalogResources(rejectedAsar),
      /obsolete Artificial Analysis/u,
    );

    await unlink(path.join(resources, "artificial-analysis-models.json"));
    await createPackage(source, acceptedAsar);
    await assert.doesNotReject(verifyPackagedModelCatalogResources(acceptedAsar));

    await writeFile(
      path.join(resources, "model-capabilities.json"),
      JSON.stringify({
        openai: {
          models: {
            broken: { name: "Broken", modalities: { input: { length: 1 } } },
          },
        },
      }),
      "utf8",
    );
    await createPackage(source, malformedAsar);
    await assert.rejects(
      verifyPackagedModelCatalogResources(malformedAsar),
      /modalities\.input must be a string array/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier rejects directory, symlink, and unpacked catalog entries", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-model-catalog-entry-"));
  const root = await realpath(temporaryRoot);
  const source = path.join(root, "source");
  const resources = path.join(source, "resources");
  const catalog = path.join(resources, "model-capabilities.json");
  try {
    await mkdir(catalog, { recursive: true });
    const directoryAsar = path.join(root, "directory.asar");
    await createPackage(source, directoryAsar);
    await assert.rejects(
      verifyPackagedModelCatalogResources(directoryAsar),
      /packed regular file/u,
    );

    await rm(catalog, { recursive: true, force: true });
    const target = path.join(resources, "catalog-target.json");
    await writeFile(target, `${JSON.stringify(modelCatalogFixture())}\n`, "utf8");
    await symlink("catalog-target.json", catalog);
    const symlinkAsar = path.join(root, "symlink.asar");
    await createPackage(source, symlinkAsar);
    await assert.rejects(verifyPackagedModelCatalogResources(symlinkAsar), /packed regular file/u);

    await unlink(catalog);
    await writeFile(catalog, `${JSON.stringify(modelCatalogFixture())}\n`, "utf8");
    const unpackedAsar = path.join(root, "unpacked.asar");
    await createPackageWithOptions(source, unpackedAsar, {
      unpack: "**/model-capabilities.json",
    });
    await assert.rejects(verifyPackagedModelCatalogResources(unpackedAsar), /packed regular file/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier rejects additional helper Info.plist keys", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-package-plist-"));
  const root = await realpath(temporaryRoot);
  const reviewed = path.join(root, "reviewed.plist");
  const packaged = path.join(root, "packaged.plist");
  const reviewedContents =
    "<plist><dict><key>CFBundleExecutable</key><string>aiden-cua-broker</string></dict></plist>";
  try {
    await writeFile(reviewed, reviewedContents, "utf8");
    await writeFile(
      packaged,
      reviewedContents.replace(
        "</dict>",
        "<key>LSEnvironment</key><dict><key>UNEXPECTED</key><string>1</string></dict></dict>",
      ),
      "utf8",
    );
    await assert.rejects(
      verifyReviewedComputerUseInfoPlist(packaged, reviewed),
      /differs from the reviewed copy/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier rejects files outside the exact reviewed helper tree", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-package-tree-"));
  const helper = await realpath(temporaryRoot);
  try {
    await createComputerUseHelperTree(helper);
    await assert.doesNotReject(verifyExactComputerUseHelperTree(helper));
    await writeFile(path.join(helper, "Contents", "MacOS", "unexpected-helper"), "extra", "utf8");
    await assert.rejects(
      verifyExactComputerUseHelperTree(helper),
      /tree differs from the reviewed payload/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier pins the exact Ambient Music helper payload", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-package-tree-"));
  const helper = await realpath(temporaryRoot);
  try {
    await createAmbientMusicHelperTree(helper);
    await assert.doesNotReject(verifyExactAmbientMusicHelperTree(helper));
    await writeFile(path.join(helper, "Contents", "MacOS", "unreviewed.dylib"), "extra", "utf8");
    await assert.rejects(
      verifyExactAmbientMusicHelperTree(helper),
      /Ambient Music helper tree differs from the reviewed payload/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier requires an arm64 macOS 14 Ambient Music executable", () => {
  assert.doesNotThrow(() => assertAmbientMusicArchitecture("arm64\n"));
  assert.throws(() => assertAmbientMusicArchitecture("arm64 x86_64\n"), /exactly arm64/u);
  assert.throws(() => assertAmbientMusicArchitecture("x86_64\n"), /exactly arm64/u);
  assert.doesNotThrow(() => assertAmbientMusicMachOMinimum("platform MACOS\nminos 14.0\n"));
  assert.throws(
    () => assertAmbientMusicMachOMinimum("platform MACOS\nminos 13.0\n"),
    /not pinned to macOS 14\.0/u,
  );
  assert.throws(
    () => assertAmbientMusicMachOMinimum("platform IOS\nminos 14.0\n"),
    /not pinned to macOS 14\.0/u,
  );
});

test("package verifier rejects Ambient Music weights anywhere in an artifact", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-package-assets-"));
  const root = await realpath(temporaryRoot);
  try {
    await mkdir(path.join(root, "Aiden Agent.app", "Contents", "Resources"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "Aiden Agent.app", "Contents", "Resources", "safe.json"),
      "{}",
      "utf8",
    );
    await assert.doesNotReject(assertNoAmbientMusicModelAssets(root));
    await writeFile(
      path.join(root, "Aiden Agent.app", "Contents", "Resources", "mrt2_small.mlxfn"),
      "weight",
      "utf8",
    );
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root),
      /contains an Ambient Music model asset/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier rejects Ambient Music weights packed inside app.asar", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-asar-assets-"));
  const root = await realpath(temporaryRoot);
  const appResources = path.join(root, "Aiden Agent.app", "Contents", "Resources");
  const source = path.join(root, "asar-source");
  try {
    await Promise.all([
      mkdir(appResources, { recursive: true }),
      mkdir(path.join(source, "resources", "musiccoca"), { recursive: true }),
    ]);
    await writeFile(
      path.join(source, "resources", "musiccoca", "text_encoder.tflite"),
      "weight",
      "utf8",
    );
    await createPackage(source, path.join(appResources, "app.asar"));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root),
      /app\.asar:resources\/musiccoca\/text_encoder\.tflite/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier rejects renamed model bytes inside renamed and nested ASAR containers", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-content-assets-"));
  const root = await realpath(temporaryRoot);
  const payload = Buffer.from("exact model fingerprint fixture", "utf8");
  const manifest = {
    version: 1,
    bundled: false,
    files: [
      {
        role: "fixture",
        relativePath: "models/fixture/model.mlxfn",
        size: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };
  try {
    const loose = path.join(root, "opaque-resource.bin");
    await writeFile(loose, payload);
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /contains Ambient Music model bytes: opaque-resource\.bin/u,
    );
    await unlink(loose);
    await writeFile(loose, Buffer.concat([payload, Buffer.from("suffix")]));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /contains Ambient Music model bytes: opaque-resource\.bin/u,
    );
    await unlink(loose);
    await writeFile(loose, Buffer.concat([Buffer.from("prefix"), payload, Buffer.from("suffix")]));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /contains Ambient Music model bytes: opaque-resource\.bin/u,
    );
    await unlink(loose);
    await writeFile(loose, gzipSync(payload));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /unreviewed gzip container: opaque-resource\.bin/u,
    );
    await unlink(loose);
    await writeFile(loose, Buffer.concat([Buffer.from("prefix"), gzipSync(payload)]));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /unreviewed gzip container: opaque-resource\.bin/u,
    );
    await unlink(loose);

    const innerSource = path.join(root, "inner-source");
    const outerSource = path.join(root, "outer-source");
    await Promise.all([mkdir(innerSource), mkdir(outerSource)]);
    await writeFile(path.join(innerSource, "opaque-resource.bin"), payload);
    const innerAsar = path.join(root, "inner.asar");
    await createPackage(innerSource, innerAsar);
    await copyFile(innerAsar, path.join(outerSource, "nested-payload.bin"));
    const renamedOuterAsar = path.join(root, "opaque-container.bin");
    await createPackage(outerSource, renamedOuterAsar);
    await Promise.all([
      rm(innerSource, { recursive: true }),
      rm(outerSource, { recursive: true }),
      rm(innerAsar),
    ]);
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest),
      /contains Ambient Music model bytes: opaque-container\.bin/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("package verifier accepts only exact reviewed size-collision files", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-collision-receipt-"));
  const root = await realpath(temporaryRoot);
  const model = Buffer.from("model fingerprint", "utf8");
  const reviewed = Buffer.alloc(model.byteLength + 1, 0x61);
  const reviewedPath = "reviewed.bin";
  const manifest = {
    version: 1,
    bundled: false,
    files: [
      {
        role: "fixture",
        relativePath: "model.bin",
        size: model.byteLength,
        sha256: createHash("sha256").update(model).digest("hex"),
      },
    ],
  };
  const collisionAllowlist = {
    schemaVersion: 1,
    maxWrapperBytes: 1024 * 1024,
    records: [
      {
        path: reviewedPath,
        size: reviewed.byteLength,
        sha256: createHash("sha256").update(reviewed).digest("hex"),
        reasons: ["model-size-collision"],
      },
    ],
  };
  try {
    await writeFile(path.join(root, reviewedPath), reviewed);
    await assert.doesNotReject(
      assertNoAmbientMusicModelAssets(root, manifest, { collisionAllowlist }),
    );
    await writeFile(path.join(root, reviewedPath), Buffer.alloc(reviewed.byteLength, 0x62));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest, { collisionAllowlist }),
      /differs from reviewed collision receipt/u,
    );
    await writeFile(path.join(root, reviewedPath), reviewed);
    await writeFile(
      path.join(root, "unreviewed.bin"),
      Buffer.concat([Buffer.from("x"), gzipSync(model)]),
    );
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest, { collisionAllowlist }),
      /unreviewed gzip container/u,
    );
    await unlink(path.join(root, "unreviewed.bin"));
    await unlink(path.join(root, reviewedPath));
    await assert.rejects(
      assertNoAmbientMusicModelAssets(root, manifest, { collisionAllowlist }),
      /missing reviewed collision receipt/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("archive scans exclude only the already-verified top-level app", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-ambient-archive-scan-"));
  const root = await realpath(temporaryRoot);
  const app = path.join(root, "Aiden Agent.app");
  try {
    await mkdir(app);
    await writeFile(path.join(app, "mrt2_small.mlxfn"), "verified separately", "utf8");
    await assert.doesNotReject(assertNoAmbientMusicModelAssetsOutsideDirectory(root, app));
    await writeFile(path.join(root, "text_encoder.tflite"), "outside app", "utf8");
    await assert.rejects(
      assertNoAmbientMusicModelAssetsOutsideDirectory(root, app),
      /contains an Ambient Music model asset/u,
    );
    const nested = path.join(app, "nested");
    await mkdir(nested);
    await assert.rejects(
      assertNoAmbientMusicModelAssetsOutsideDirectory(root, nested),
      /direct child/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS packaging includes the helper and reviewed notices without model files", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    packageJson.build.mac.binaries.includes("Contents/Helpers/Aiden Ambient Music Helper.app"),
  );
  const ambientMetallib =
    "Contents/Helpers/Aiden Ambient Music Helper.app/Contents/MacOS/mlx.metallib";
  assert.ok(packageJson.build.mac.binaries.includes(ambientMetallib));
  assert.ok(
    packageJson.build.mac.binaries.indexOf(ambientMetallib) <
      packageJson.build.mac.binaries.indexOf("Contents/Helpers/Aiden Ambient Music Helper.app"),
  );
  assert.ok(
    packageJson.build.mac.extraFiles.some(
      (entry) =>
        entry.from === "build/native/Aiden Ambient Music Helper.app" &&
        entry.to === "Helpers/Aiden Ambient Music Helper.app",
    ),
  );
  const resources = packageJson.build.extraResources.find(
    (entry) => entry.from === "build/native/Aiden Ambient Music Helper.app/Contents/Resources",
  );
  assert.deepEqual(resources?.filter, [
    "LICENSE.*.txt",
    "MODEL_TERMS.md",
    "NOTICE.md",
    "asset-manifest.json",
    "source-provenance.json",
  ]);
  assert.doesNotMatch(
    JSON.stringify(packageJson.build),
    /mrt2_(?:small|base)\.(?:mlxfn|safetensors)/u,
  );
});

test("package verifier requires the pinned broker executable and hardened executable modes", () => {
  assert.doesNotThrow(() => assertComputerUseBundleExecutable("aiden-cua-broker"));
  assert.throws(
    () => assertComputerUseBundleExecutable("cua-driver"),
    /Unexpected Computer Use CFBundleExecutable/,
  );
  assert.doesNotThrow(() => assertComputerUseExecutableMode(0o100755, "broker"));
  assert.throws(() => assertComputerUseExecutableMode(0o100644, "broker"), /executable mode 0755/);
  assert.throws(() => assertComputerUseExecutableMode(0o100777, "broker"), /executable mode 0755/);
});

test("package verifier pins the helper to the launch-requirement deployment floor", () => {
  assert.doesNotThrow(() => assertComputerUseMinimumSystemVersion("14.4"));
  assert.throws(() => assertComputerUseMinimumSystemVersion("13.0"), /minimum macOS version/);
});

test("package verifier requires the enclosing bundle and host process to share one CDHash", () => {
  const cdHash = "7c6eb54a898b9aab9b4aa7d525d14e02a36330b6";
  assert.doesNotThrow(() => assertMatchingHostCodeHashes(cdHash, cdHash));
  assert.throws(
    () => assertMatchingHostCodeHashes(cdHash, "29c2c0deb62a3d5223dec8fcc611a267a3077903"),
    /do not share one exact CDHash/,
  );
  assert.throws(() => assertMatchingHostCodeHashes("not-a-hash", "not-a-hash"), /CDHash/);
});

test("archive identity must match the verified staging app in every bound field", () => {
  const identity = {
    bundleIdentifier: "com.sambitcreate.aiden-agent",
    bundleVersion: "42",
    shortVersion: "1.2.3",
    cdHash: "7c6eb54a898b9aab9b4aa7d525d14e02a36330b6",
    appAsarSha256: "a".repeat(64),
    codeResourcesSha256: "c".repeat(64),
  };
  assert.deepEqual(ambientMusicPackageIdentityReceipt({ packageIdentity: identity }), identity);
  assert.doesNotThrow(() => assertSamePackagedArtifactIdentity(identity, { ...identity }, "ZIP"));
  assert.throws(
    () =>
      assertSamePackagedArtifactIdentity(
        identity,
        { ...identity, appAsarSha256: "b".repeat(64) },
        "DMG",
      ),
    /DMG.*appAsarSha256 mismatch/u,
  );
  assert.throws(
    () =>
      assertSamePackagedArtifactIdentity(
        identity,
        { ...identity, codeResourcesSha256: "d".repeat(64) },
        "signed wide-wrapper fixture",
      ),
    /codeResourcesSha256 mismatch/u,
  );
  assert.throws(
    () =>
      assertSamePackagedArtifactIdentity(
        identity,
        { ...identity, codeResourcesSha256: undefined },
        "ZIP",
      ),
    /complete immutable package identity/u,
  );
});

test("package verifier requires hardened runtime on every executable code object", () => {
  assert.doesNotThrow(() =>
    assertHardenedRuntime("CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=20"),
  );
  assert.throws(
    () => assertHardenedRuntime("CodeDirectory v=20400 size=900 flags=0x0(none) hashes=20"),
    /Hardened runtime/,
  );
});

test("release verification requires Aiden's Developer ID identity, not development signing", () => {
  assert.doesNotThrow(() =>
    assertDeveloperIdSignature(
      "Authority=Developer ID Application: Sambit Biswas (5WP229CBB8)\nTeamIdentifier=5WP229CBB8",
    ),
  );
  assert.throws(
    () =>
      assertDeveloperIdSignature(
        "Authority=Apple Development: Sambit Biswas (7EK65FX44E)\nTeamIdentifier=5WP229CBB8",
      ),
    /Developer ID Application/,
  );
  assert.throws(
    () =>
      assertDeveloperIdSignature(
        "Authority=Developer ID Application: Other (WRONGTEAM1)\nTeamIdentifier=WRONGTEAM1",
      ),
    /Developer ID Application/,
  );
  assert.equal(requiresReleaseVerification("development"), false);
  assert.equal(requiresReleaseVerification("distribution"), true);
  assert.equal(requiresReleaseVerification(undefined), true);
});

test("package verifier checks the broker's Mach-O deployment target, not only Info.plist", () => {
  assert.doesNotThrow(() =>
    assertComputerUseMachOMinimum(
      "Load command 10\n      cmd LC_BUILD_VERSION\n platform MACOS\n    minos 14.4\n",
    ),
  );
  assert.throws(
    () => assertComputerUseMachOMinimum("platform MACOS\nminos 11.0\n"),
    /LC_BUILD_VERSION/,
  );
});

test("package verifier requires the exact universal architecture set for both private helpers", () => {
  for (const target of ["Managed worktree remover", "Private subagent run store"]) {
    assert.doesNotThrow(() => assertExactUniversalArchitectures("x86_64 arm64\n", target));
    assert.doesNotThrow(() => assertExactUniversalArchitectures("arm64 x86_64\n", target));
    assert.throws(
      () => assertExactUniversalArchitectures("arm64\n", target),
      /exactly the arm64 and x86_64 architectures/u,
    );
    assert.throws(
      () => assertExactUniversalArchitectures("arm64 x86_64 arm64e\n", target),
      /exactly the arm64 and x86_64 architectures/u,
    );
    assert.throws(
      () => assertExactUniversalArchitectures("arm64 arm64\n", target),
      /exactly the arm64 and x86_64 architectures/u,
    );
    assert.throws(
      () => assertExactUniversalArchitectures("arm64 x86_64h\n", target),
      /exactly the arm64 and x86_64 architectures/u,
    );
  }
});

test("package verifier checks each architecture deployment floor independently", () => {
  for (const target of ["Managed worktree remover", "Private subagent run store"]) {
    for (const architecture of ["arm64", "x86_64"]) {
      assert.doesNotThrow(() =>
        assertMacOSArchitectureMinimum(
          "Load command 11\nplatform MACOS\nminos 14.4\n",
          target,
          architecture,
        ),
      );
      assert.throws(
        () => assertMacOSArchitectureMinimum("platform IOS\nminos 14.4\n", target, architecture),
        new RegExp(`${architecture} slice is not pinned to macOS 14\\.4`, "u"),
      );
      assert.throws(
        () => assertMacOSArchitectureMinimum("platform MACOS\nminos 13.0\n", target, architecture),
        new RegExp(`${architecture} slice is not pinned to macOS 14\\.4`, "u"),
      );
      assert.throws(
        () =>
          assertMacOSArchitectureMinimum(
            "platform MACOS\nminos 14.4\nplatform MACOS\nminos 14.4\n",
            target,
            architecture,
          ),
        new RegExp(`${architecture} slice is not pinned to macOS 14\\.4`, "u"),
      );
    }
  }
});

test("package verifier rejects privileged Computer Use broker entitlements", () => {
  assert.doesNotThrow(() =>
    assertMinimalComputerUseEntitlements(
      '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
    ),
  );
  assert.throws(
    () =>
      assertMinimalComputerUseEntitlements(
        "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>",
      ),
    /unexpected entitlements/,
  );
});

test("package verifier requires the normal Electron runtime entitlements", () => {
  const expected = [
    "com.apple.security.automation.apple-events",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ]
    .map((key) => `<key>${key}</key><true/>`)
    .join("");
  assert.doesNotThrow(() => assertElectronEntitlements(`<plist><dict>${expected}</dict></plist>`));
  assert.throws(() => assertElectronEntitlements("<plist><dict/></plist>"), /pinned runtime set/);
  assert.throws(
    () =>
      assertElectronEntitlements(
        `<plist><dict>${expected.replace(
          "<key>com.apple.security.device.audio-input</key><true/>",
          "<key>com.apple.security.device.audio-input</key><false/>",
        )}</dict></plist>`,
      ),
    /pinned runtime set/u,
  );
  assert.throws(
    () =>
      assertElectronEntitlements(
        `<plist><dict>${expected}<key>com.apple.security.app-sandbox</key><true/></dict></plist>`,
      ),
    /pinned runtime set/,
  );
});

test("package verifier requires inherited microphone access on Electron helpers", () => {
  const expected = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ]
    .map((key) => `<key>${key}</key><true/>`)
    .join("");
  assert.doesNotThrow(() =>
    assertElectronHelperEntitlements(`<plist><dict>${expected}</dict></plist>`),
  );
  assert.throws(
    () => assertElectronHelperEntitlements("<plist><dict/></plist>"),
    /pinned inherited set/u,
  );
  assert.throws(
    () =>
      assertElectronHelperEntitlements(
        `<plist><dict>${expected.replace(
          "<key>com.apple.security.device.audio-input</key><true/>",
          "<key>com.apple.security.device.audio-input</key><false/>",
        )}</dict></plist>`,
      ),
    /pinned inherited set/u,
  );
  assert.throws(
    () =>
      assertElectronHelperEntitlements(
        `<plist><dict>${expected}<key>com.apple.security.automation.apple-events</key><true/></dict></plist>`,
      ),
    /pinned inherited set/u,
  );
});
