/* global Buffer */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import {
  assertByteForByteMatch,
  assertComputerUseBundleExecutable,
  assertComputerUseExecutableMode,
  assertComputerUseMachOMinimum,
  assertComputerUseMinimumSystemVersion,
  assertDeveloperIdSignature,
  assertElectronEntitlements,
  assertElectronHelperEntitlements,
  assertExactUniversalArchitectures,
  assertMinimalComputerUseEntitlements,
  assertMacOSArchitectureMinimum,
  assertMatchingHostCodeHashes,
  assertPackagedModelCatalogEntries,
  assertPackagedSubagentInferenceWorkerEntries,
  assertPackagedNodePtyHelperEntries,
  assertNodePtySpawnHelperMode,
  assertSamePackagedArtifactIdentity,
  assertHardenedRuntime,
  assertRegularFile,
  requiresReleaseVerification,
  verifyExactComputerUseHelperTree,
  verifyPackagedModelCatalogResources,
  verifyPackagedSubagentInferenceWorker,
  verifyPackagedNodePtyResources,
  verifyReviewedComputerUseInfoPlist,
} from "./verify-macos-package.mjs";

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
        openai: { models: { broken: { name: "Broken", modalities: { input: { length: 1 } } } } },
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

test("package verifier requires a bounded packed subagent inference worker", async () => {
  assert.doesNotThrow(() =>
    assertPackagedSubagentInferenceWorkerEntries([
      "/build/main/subagent-inference-worker.js",
      "/build/main/subagent-inference-worker-runtime.js",
    ]),
  );
  assert.throws(
    () => assertPackagedSubagentInferenceWorkerEntries([]),
    /missing the subagent inference worker/u,
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-inference-worker-asar-"));
  const root = await realpath(temporaryRoot);
  const source = path.join(root, "source");
  const workerDirectory = path.join(source, "build", "main");
  try {
    await mkdir(workerDirectory, { recursive: true });
    await writeFile(
      path.join(workerDirectory, "subagent-inference-worker.js"),
      'throw new Error("Provider credential subprocesses are disabled");\nconst names = ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"];\nObject.defineProperty(childProcess, name, { configurable: false, writable: false });\nObject.defineProperty(childProcess, "promises", { value: Object.freeze({ exec, execFile, fork, spawn }), configurable: false, writable: false });\nsyncBuiltinESMExports();\nawait import("./subagent-inference-worker-runtime.js");\n',
    );
    await writeFile(
      path.join(workerDirectory, "subagent-inference-worker-runtime.js"),
      "export {};\n",
    );
    const packedAsar = path.join(root, "packed.asar");
    await createPackage(source, packedAsar);
    await assert.doesNotReject(verifyPackagedSubagentInferenceWorker(packedAsar));
    await writeFile(
      path.join(workerDirectory, "subagent-inference-worker.js"),
      'const names = ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"];\nawait import("./subagent-inference-worker-runtime.js");\nsyncBuiltinESMExports();\nObject.defineProperty(childProcess, name, { configurable: false, writable: false });\nObject.defineProperty(childProcess, "promises", { value: Object.freeze({ exec, execFile, fork, spawn }), configurable: false, writable: false });\nthrow new Error("Provider credential subprocesses are disabled");\n',
    );
    const wrongOrderAsar = path.join(root, "wrong-order.asar");
    await createPackage(source, wrongOrderAsar);
    await assert.rejects(
      verifyPackagedSubagentInferenceWorker(wrongOrderAsar),
      /disable subprocesses before loading providers/u,
    );
    await writeFile(
      path.join(workerDirectory, "subagent-inference-worker.js"),
      'throw new Error("Provider credential subprocesses are disabled");\nconst names = ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"];\nObject.defineProperty(childProcess, name, { configurable: false, writable: false });\nObject.defineProperty(childProcess, "promises", { value: Object.freeze({ exec, execFile, fork, spawn }), configurable: false, writable: false });\nsyncBuiltinESMExports();\nawait import("./subagent-inference-worker-runtime.js");\n',
    );
    const unpackedAsar = path.join(root, "unpacked.asar");
    await createPackageWithOptions(source, unpackedAsar, {
      unpack: "**/subagent-inference-worker-runtime.js",
    });
    await assert.rejects(
      verifyPackagedSubagentInferenceWorker(unpackedAsar),
      /bounded packed regular file/u,
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

test("package verifier requires unpacked executable node-pty helpers for both macOS architectures", async () => {
  const expectedEntries = [
    "/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    "/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
  ];
  assert.doesNotThrow(() => assertPackagedNodePtyHelperEntries(expectedEntries));
  assert.throws(
    () => assertPackagedNodePtyHelperEntries(expectedEntries.slice(0, 1)),
    /missing node-pty spawn-helper entries.*darwin-x64/u,
  );
  assert.doesNotThrow(() => assertNodePtySpawnHelperMode(0o100755, "spawn-helper"));
  assert.throws(
    () => assertNodePtySpawnHelperMode(0o100644, "spawn-helper"),
    /spawn-helper mode 0755/u,
  );

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-node-pty-asar-"));
  const root = await realpath(temporaryRoot);
  const source = path.join(root, "source");
  const armHelper = path.join(
    source,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  const x64Helper = path.join(
    source,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-x64",
    "spawn-helper",
  );
  const unpackedAsar = path.join(root, "unpacked.asar");
  const packedAsar = path.join(root, "packed.asar");
  try {
    await Promise.all([
      mkdir(path.dirname(armHelper), { recursive: true }),
      mkdir(path.dirname(x64Helper), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(armHelper, "arm helper", { mode: 0o755 }),
      writeFile(x64Helper, "x64 helper", { mode: 0o755 }),
    ]);
    await createPackageWithOptions(source, unpackedAsar, {
      unpack: "**/node-pty/prebuilds/**/spawn-helper",
    });
    await assert.doesNotReject(verifyPackagedNodePtyResources(unpackedAsar));

    const packagedX64Helper = path.join(
      `${unpackedAsar}.unpacked`,
      "node_modules",
      "node-pty",
      "prebuilds",
      "darwin-x64",
      "spawn-helper",
    );
    await chmod(packagedX64Helper, 0o644);
    await assert.rejects(verifyPackagedNodePtyResources(unpackedAsar), /spawn-helper mode 0755/u);

    await createPackage(source, packedAsar);
    await assert.rejects(
      verifyPackagedNodePtyResources(packedAsar),
      /must be an unpacked regular file/u,
    );
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
    bundleIdentifier: "works.aiden.agent",
    bundleVersion: "42",
    shortVersion: "1.2.3",
    cdHash: "7c6eb54a898b9aab9b4aa7d525d14e02a36330b6",
    appAsarSha256: "a".repeat(64),
  };
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
