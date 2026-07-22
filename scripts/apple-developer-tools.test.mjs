import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chooseBestXcodeToolchain,
  discoverXcodeDeveloperDirectories,
  inspectXcodeToolchain,
  normalizeDeveloperDirectory,
} from "./apple-developer-tools.mjs";

test("normalizes Xcode bundles without changing developer-directory overrides", () => {
  assert.equal(
    normalizeDeveloperDirectory("/Applications/Xcode-beta.app"),
    "/Applications/Xcode-beta.app/Contents/Developer",
  );
  assert.equal(
    normalizeDeveloperDirectory("/Applications/Xcode.app/Contents/Developer"),
    "/Applications/Xcode.app/Contents/Developer",
  );
  assert.equal(normalizeDeveloperDirectory("  "), null);
});

test("an explicit compatible toolchain wins, otherwise the newest compatible Xcode wins", () => {
  const stable = {
    compatible: true,
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    explicit: false,
    isPrerelease: false,
    sdkVersion: "27.0",
    source: "/Applications",
    xcodeVersion: "27.0",
  };
  const beta = {
    ...stable,
    developerDir: "/Applications/Xcode-beta.app/Contents/Developer",
    isPrerelease: true,
    xcodeVersion: "28.0",
  };
  const explicit = {
    ...stable,
    developerDir: "/opt/Xcode.app/Contents/Developer",
    explicit: true,
    sdkVersion: "26.0",
    source: "DEVELOPER_DIR",
    xcodeVersion: "26.0",
  };

  assert.equal(chooseBestXcodeToolchain([stable, beta]), beta);
  assert.equal(chooseBestXcodeToolchain([stable, { ...stable, isPrerelease: true }]), stable);
  assert.equal(chooseBestXcodeToolchain([stable, beta, explicit]), explicit);
  assert.equal(chooseBestXcodeToolchain([{ ...stable, compatible: false }]), null);
});

test("discovery combines explicit, active, installed, and Spotlight candidates without duplicates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-xcode-discovery-"));
  const applications = path.join(root, "Applications");
  const bundle = path.join(applications, "Xcode-beta.app");
  const developerDir = path.join(bundle, "Contents", "Developer");
  try {
    await mkdir(developerDir, { recursive: true });
    const candidates = discoverXcodeDeveloperDirectories({
      applicationRoots: [applications],
      env: { DEVELOPER_DIR: developerDir },
      run: (command) =>
        command.endsWith("xcode-select")
          ? { status: 0, stdout: "/Library/Developer/CommandLineTools\n" }
          : { status: 0, stdout: `${bundle}\n` },
    });
    assert.deepEqual(candidates, [
      { developerDir, explicit: true, source: "DEVELOPER_DIR" },
      {
        developerDir: "/Library/Developer/CommandLineTools",
        explicit: false,
        source: "xcode-select",
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("toolchain inspection requires the Foundation Models SDK and macro implementation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-xcode-toolchain-"));
  const developerDir = path.join(root, "Xcode.app", "Contents", "Developer");
  const macro = path.join(
    developerDir,
    "Platforms",
    "MacOSX.platform",
    "Developer",
    "usr",
    "lib",
    "swift",
    "host",
    "plugins",
    "libFoundationModelsMacros.dylib",
  );
  const sdkPath = path.join(root, "MacOSX27.0.sdk");
  const framework = path.join(
    sdkPath,
    "System",
    "Library",
    "Frameworks",
    "FoundationModels.framework",
  );
  const candidate = { developerDir, explicit: false, source: "test" };
  const run = (_command, args) => {
    if (args[0] === "-version") {
      return { status: 0, stdout: "Xcode 27.0\nBuild version 27A1\n" };
    }
    if (args.at(-1) === "--show-sdk-path") return { status: 0, stdout: `${sdkPath}\n` };
    if (args.at(-1) === "--show-sdk-version") return { status: 0, stdout: "27.0\n" };
    return { status: 1, stdout: "" };
  };

  try {
    await mkdir(path.dirname(macro), { recursive: true });
    await mkdir(framework, { recursive: true });
    await writeFile(macro, "fixture", "utf8");
    const compatible = inspectXcodeToolchain(candidate, { run });
    assert.equal(compatible.compatible, true);
    assert.equal(compatible.xcodeVersion, "27.0");
    assert.equal(compatible.sdkVersion, "27.0");

    await rm(macro);
    const missingMacro = inspectXcodeToolchain(candidate, { run });
    assert.equal(missingMacro.compatible, false);
    assert.match(missingMacro.reason, /compiler plugin is missing/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
