/* global Buffer */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertByteForByteMatch,
  assertComputerUseBundleExecutable,
  assertComputerUseExecutableMode,
  assertComputerUseMachOMinimum,
  assertComputerUseMinimumSystemVersion,
  assertDeveloperIdSignature,
  assertElectronEntitlements,
  assertMinimalComputerUseEntitlements,
  assertMatchingHostCodeHashes,
  assertSamePackagedArtifactIdentity,
  assertHardenedRuntime,
  assertRegularFile,
  requiresReleaseVerification,
  verifyExactComputerUseHelperTree,
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
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]
    .map((key) => `<key>${key}</key><true/>`)
    .join("");
  assert.doesNotThrow(() => assertElectronEntitlements(`<plist><dict>${expected}</dict></plist>`));
  assert.throws(() => assertElectronEntitlements("<plist><dict/></plist>"), /pinned runtime set/);
  assert.throws(
    () =>
      assertElectronEntitlements(
        `<plist><dict>${expected}<key>com.apple.security.app-sandbox</key><true/></dict></plist>`,
      ),
    /pinned runtime set/,
  );
});
