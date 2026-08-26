import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import {
  assertGlibcSymbolBaseline,
  assertLinuxBuildConfiguration,
  isElfMagic,
} from "./verify-linux-package.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("Linux package targets common distro formats and includes native helpers", () => {
  assert.doesNotThrow(() => assertLinuxBuildConfiguration(packageJson));
});

test("Linux package configuration rejects globally bundled Computer Use resources", () => {
  const invalid = JSON.parse(JSON.stringify(packageJson));
  invalid.build.extraResources.push({
    from: "resources/computer-use/cua-driver-artifact.json",
    to: "computer-use/cua-driver-artifact.json",
  });
  assert.throws(
    () => assertLinuxBuildConfiguration(invalid),
    /must not be global/u,
  );
});

test("Linux package configuration requires desktop association and runtime libraries", () => {
  for (const mutate of [
    (invalid) => {
      invalid.build.linux.syncDesktopName = false;
    },
    (invalid) => {
      invalid.build.deb.depends = invalid.build.deb.depends.filter(
        (dependency) =>
          dependency !==
          "libasound2t64 (>= 1.0.17) | libasound2 (>= 1.0.17)",
      );
    },
    (invalid) => {
      invalid.build.rpm.depends = invalid.build.rpm.depends.filter(
        (dependency) => !dependency.includes("libsecret"),
      );
    },
    (invalid) => {
      invalid.build.toolsets.appimage = "0.0.0";
    },
  ]) {
    const invalid = JSON.parse(JSON.stringify(packageJson));
    mutate(invalid);
    assert.throws(() => assertLinuxBuildConfiguration(invalid));
  }
});

test("Linux distribution refreshes models.dev only through the explicit release step", () => {
  assert.doesNotMatch(packageJson.scripts["dist:linux"], /models:refresh/u);
  assert.match(
    releaseWorkflow,
    /npm run models:refresh\s+npm run dist:linux/u,
  );
});

test("Linux native binaries cannot silently raise the RHEL 9 glibc baseline", () => {
  assert.doesNotThrow(() =>
    assertGlibcSymbolBaseline("helper", "UND (GLIBC_2.34) close_range"),
  );
  assert.throws(
    () => assertGlibcSymbolBaseline("helper", "UND (GLIBC_2.38) __isoc23_strtoull"),
    /requires GLIBC_2\.38/u,
  );
});

test("Linux package verification ignores foreign native prebuilds", () => {
  assert.equal(isElfMagic(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), true);
  assert.equal(isElfMagic(Buffer.from("MZ\u0090\u0000", "latin1")), false);
  assert.equal(isElfMagic(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), false);
  assert.equal(isElfMagic(Buffer.from([0x7f, 0x45, 0x4c])), false);
});
