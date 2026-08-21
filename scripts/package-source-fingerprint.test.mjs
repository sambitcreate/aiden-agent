import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import {
  assertMatchingPackageSourceFingerprint,
  isPackageSourceFingerprintPathExcluded,
  PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH,
} from "./package-source-fingerprint.mjs";

test("package fingerprint excludes mutable project evidence but includes implementation inputs", () => {
  assert.equal(isPackageSourceFingerprintPathExcluded("docs/plans/evidence.md"), true);
  assert.equal(isPackageSourceFingerprintPathExcluded(".memory/PLANNED.md"), true);
  assert.equal(isPackageSourceFingerprintPathExcluded(".papercuts/troubleshooting.md"), true);
  assert.equal(isPackageSourceFingerprintPathExcluded("renderer/create-images/workflow-canvas.tsx"), false);
  assert.equal(isPackageSourceFingerprintPathExcluded("package.json"), false);
});

test("package fingerprint comparison rejects stale source", () => {
  const expected = { version: 1, head: "abc", sha256: "one" };
  assert.doesNotThrow(() => assertMatchingPackageSourceFingerprint(expected, { ...expected }));
  assert.throws(
    () =>
      assertMatchingPackageSourceFingerprint(expected, {
        ...expected,
        sha256: "two",
      }),
    /does not match the working tree/u,
  );
});

test("package and acceptance contracts embed and verify the build-time fingerprint", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(
    packageJson.scripts.package,
    /computer-use:vendor && npm run package:fingerprint && npm run build:native/u,
  );
  assert.match(
    packageJson.scripts.package,
    /npm run build && npm run package:fingerprint:verify && electron-builder/u,
  );
  assert.ok(packageJson.build.files.includes(PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH));
  const acceptance = fs.readFileSync(
    new URL("./create-images-packaged-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(acceptance, /extractFile\(asarPath, PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH\)/u);
  assert.match(acceptance, /assertSamePackagedArtifactIdentity\(verifiedIdentity, finalIdentity/u);
  const distribution = fs.readFileSync(
    new URL("./run-macos-distribution.mjs", import.meta.url),
    "utf8",
  );
  const writeFingerprintIndex = distribution.indexOf('await npm("package:fingerprint")');
  const buildIndex = distribution.indexOf('await npm("build")');
  const verifyFingerprintIndex = distribution.indexOf(
    'await npm("package:fingerprint:verify")',
  );
  assert.ok(writeFingerprintIndex >= 0 && writeFingerprintIndex < buildIndex);
  assert.ok(verifyFingerprintIndex > buildIndex);
  const windowPaths = fs.readFileSync(
    new URL("../main/windows/window-paths.ts", import.meta.url),
    "utf8",
  );
  assert.match(windowPaths, /app\.getAppPath\(\)/u);
  assert.doesNotMatch(windowPaths, /import\.meta\.url/u);
});
