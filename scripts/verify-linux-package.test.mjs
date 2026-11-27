import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  assertGlibcSymbolBaseline,
  assertLinuxBuildConfiguration,
  assertNoMetalSpeechEngine,
  findSharedWritableEntries,
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

test("Linux package requires its lease and Bot inbox helpers and shared Generative UI libraries", () => {
  const missingHelper = JSON.parse(JSON.stringify(packageJson));
  missingHelper.build.linux.extraFiles = missingHelper.build.linux.extraFiles.filter(
    (entry) => !String(entry.to).includes("aiden-bot-inbox-writer"),
  );
  assert.throws(
    () => assertLinuxBuildConfiguration(missingHelper),
    /aiden-bot-inbox-writer/u,
  );

  const missingLeaseHelper = JSON.parse(JSON.stringify(packageJson));
  missingLeaseHelper.build.linux.extraFiles = missingLeaseHelper.build.linux.extraFiles.filter(
    (entry) => !String(entry.to).includes("aiden-lease-flock"),
  );
  assert.throws(
    () => assertLinuxBuildConfiguration(missingLeaseHelper),
    /aiden-lease-flock/u,
  );

  const missingUpdateHelper = JSON.parse(JSON.stringify(packageJson));
  missingUpdateHelper.build.linux.extraFiles = missingUpdateHelper.build.linux.extraFiles.filter(
    (entry) => !String(entry.to).includes("aiden-package-install"),
  );
  assert.throws(
    () => assertLinuxBuildConfiguration(missingUpdateHelper),
    /aiden-package-install/u,
  );

  const missingLibraries = JSON.parse(JSON.stringify(packageJson));
  missingLibraries.build.extraResources = missingLibraries.build.extraResources.filter(
    (entry) => entry.from !== "resources/generative-ui",
  );
  assert.throws(
    () => assertLinuxBuildConfiguration(missingLibraries),
    /Generative UI libraries/u,
  );
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

  for (const entry of [
    {
      from: "build/native/Aiden Foundation Models Helper.app",
      to: "Helpers/Aiden Foundation Models Helper.app",
    },
    {
      from: "build/computer-use/CuaDriver.app",
      to: "Helpers/CuaDriver.app",
    },
  ]) {
    const invalidExtraFile = JSON.parse(JSON.stringify(packageJson));
    invalidExtraFile.build.linux.extraFiles.push(entry);
    assert.throws(
      () => assertLinuxBuildConfiguration(invalidExtraFile),
      /must not include Apple Foundation Models or Computer Use/u,
    );
  }
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

test("Linux releases preserve the exact declared desktop version", () => {
  assert.doesNotMatch(releaseWorkflow, /GITHUB_RUN_NUMBER|npm version/u);
  assert.match(releaseWorkflow, /node scripts\/prepare-ci-release\.mjs "\$base_tag_exists"/u);
  assert.match(releaseWorkflow, /steps\.version\.outputs\.publish == 'true'/u);
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

test("Linux packages leave out the native libraries of the Metal speech engine and its FFI binding", () => {
  assert.doesNotThrow(() =>
    assertNoMetalSpeechEngine([
      "/build/main/local-speech-worker.js",
      "/node_modules/sherpa-onnx-node/package.json",
      // The JavaScript packages are shared with the macOS file list and never loaded on Linux.
      "/node_modules/transcribe-cpp/dist/index.js",
      "/node_modules/koffi/index.js",
    ]),
  );
  for (const shipped of [
    "/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libggml-vulkan.so",
    "/node_modules/@transcribe-cpp/linux-arm64-cpu-vulkan/libtranscribe.so",
    "/node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
  ]) {
    assert.throws(() => assertNoMetalSpeechEngine([shipped]), /Metal speech engine's native libraries/u, shipped);
  }
});

test("Linux package verification names every file other users could write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-linux-verify-modes-"));
  try {
    await chmod(root, 0o755);
    await mkdir(path.join(root, "locales"), { mode: 0o755 });
    await writeFile(path.join(root, "aiden-agent"), "elf", { mode: 0o755 });
    await writeFile(path.join(root, "locales", "en-US.pak"), "pak", { mode: 0o644 });
    assert.deepEqual(await findSharedWritableEntries(root), []);
    await chmod(path.join(root, "aiden-agent"), 0o777);
    await chmod(path.join(root, "locales", "en-US.pak"), 0o664);
    assert.deepEqual(await findSharedWritableEntries(root), ["aiden-agent", path.join("locales", "en-US.pak")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux package leaves out the DESIGN.md CLI, its top-level spec files, its nested node_modules and the packages only its CLI needs", () => {
  for (const rule of [
    "!**/node_modules/@google/design.md/dist/index.js",
    "!**/node_modules/@google/design.md/dist/spec.md",
    "!**/node_modules/@google/design.md/dist/spec-config.yaml",
    "!**/node_modules/@google/design.md/dist/linter/spec.md",
    "!**/node_modules/@google/design.md/node_modules/**",
    "!**/node_modules/{citty,consola,estree-util-visit,fault,format,mdast-util-frontmatter,mdast-util-mdx,micromark-extension-frontmatter,micromark-extension-mdx-expression,micromark-extension-mdx-jsx,micromark-extension-mdx-md,micromark-extension-mdxjs,micromark-extension-mdxjs-esm,micromark-factory-mdx-expression,micromark-util-events-to-acorn,remark-frontmatter,remark-mdx,unist-util-position-from-estree}/**",
  ]) {
    const untrimmed = JSON.parse(JSON.stringify(packageJson));
    untrimmed.build.files = untrimmed.build.files.filter((entry) => entry !== rule);
    assert.throws(() => assertLinuxBuildConfiguration(untrimmed), (error) => error.message.includes(rule), rule);
  }
});
