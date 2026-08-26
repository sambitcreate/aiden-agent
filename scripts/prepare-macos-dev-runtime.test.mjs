import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  brandMacDevRuntime,
  macDevRuntimeCodeIdentity,
  macDevRuntimeLayout,
  validateAmbientMusicDevHelper,
  validateMacDevRuntime,
} from "./prepare-macos-dev-runtime.mjs";

const execFileAsync = promisify(execFile);

function plist({ displayName, executable, identifier, name }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>${displayName}</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleShortVersionString</key><string>0</string>
  <key>CFBundleVersion</key><string>0</string>
</dict>
</plist>
`;
}

async function fixtureElectronApp(root) {
  const appPath = path.join(root, "Electron.app");
  const mainExecutable = path.join(appPath, "Contents", "MacOS", "Electron");
  await mkdir(path.dirname(mainExecutable), { recursive: true });
  await mkdir(path.join(appPath, "Contents", "Resources"), { recursive: true });
  await writeFile(mainExecutable, "fixture-electron-runtime");
  await chmod(mainExecutable, 0o755);
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    plist({
      displayName: "Electron",
      executable: "Electron",
      identifier: "com.github.Electron",
      name: "Electron",
    }),
  );

  for (const helper of macDevRuntimeLayout().helpers) {
    const helperApp = path.join(appPath, "Contents", "Frameworks", `${helper.sourceName}.app`);
    const executable = path.join(helperApp, "Contents", "MacOS", helper.sourceName);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, `fixture-${helper.sourceName}`);
    await chmod(executable, 0o755);
    await writeFile(
      path.join(helperApp, "Contents", "Info.plist"),
      plist({
        displayName: helper.sourceName,
        executable: helper.sourceName,
        identifier: "com.github.Electron.helper",
        name: helper.sourceName,
      }),
    );
  }
  return {
    appPath,
    firstHelperExecutable: path.join(
      appPath,
      "Contents",
      "Frameworks",
      `${macDevRuntimeLayout().helpers[0].sourceName}.app`,
      "Contents",
      "MacOS",
      macDevRuntimeLayout().helpers[0].sourceName,
    ),
    mainExecutable,
  };
}

async function plistRunner(command, args) {
  if (command === "/usr/bin/codesign") return "";
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8" });
  return stdout;
}

async function plistValue(plistPath, key) {
  return (
    await plistRunner("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath])
  ).trim();
}

test("brands the macOS development app and every Electron helper as Aiden Agent Dev", () => {
  assert.deepEqual(macDevRuntimeLayout(), {
    bundleIdentifier: "com.sambitcreate.aiden-agent.dev",
    executableName: "Aiden Agent Dev",
    helpers: [
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper",
        destinationName: "Aiden Agent Dev Helper",
        sourceName: "Electron Helper",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.GPU",
        destinationName: "Aiden Agent Dev Helper (GPU)",
        sourceName: "Electron Helper (GPU)",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.Plugin",
        destinationName: "Aiden Agent Dev Helper (Plugin)",
        sourceName: "Electron Helper (Plugin)",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.Renderer",
        destinationName: "Aiden Agent Dev Helper (Renderer)",
        sourceName: "Electron Helper (Renderer)",
      },
    ],
    productName: "Aiden Agent Dev",
  });
});

test("opt-in development validates the exact Ambient Music helper boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-dev-ambient-helper-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const helperApp = path.join(root, "build", "native", "Aiden Ambient Music Helper.app");
  const contents = path.join(helperApp, "Contents");
  const executable = path.join(contents, "MacOS", "aiden-ambient-music-helper");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture-helper");
  await chmod(executable, 0o755);
  await writeFile(path.join(contents, "MacOS", "mlx.metallib"), "fixture-metal");
  await writeFile(path.join(contents, "Info.plist"), "fixture-plist");
  const values = {
    CFBundleExecutable: "aiden-ambient-music-helper",
    CFBundleIdentifier: "com.sambitcreate.aiden-agent.ambient-music",
    LSMinimumSystemVersion: "14.0",
  };
  const run = async (command, args) => {
    if (command === "/usr/bin/codesign") return "";
    if (command === "/usr/bin/plutil") return `${values[args[1]]}\n`;
    throw new Error(`Unexpected command: ${command}`);
  };
  await assert.doesNotReject(
    validateAmbientMusicDevHelper(root, {
      enabled: true,
      inspectArchitectures: async () => ["arm64"],
      run,
    }),
  );
  await assert.rejects(
    validateAmbientMusicDevHelper(root, {
      enabled: true,
      inspectArchitectures: async () => ["arm64", "x86_64"],
      run,
    }),
    /exactly arm64/u,
  );
  assert.equal(await validateAmbientMusicDevHelper(root, { enabled: false }), null);
});

test("branding mutates and validates the complete cached app layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-dev-brand-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { appPath, firstHelperExecutable } = await fixtureElectronApp(root);
  const iconPath = path.join(root, "app.icns");
  await writeFile(iconPath, "fixture-icon");
  const codeIdentityBefore = await macDevRuntimeCodeIdentity(appPath);
  await writeFile(firstHelperExecutable, "changed-same-version-helper");
  await chmod(firstHelperExecutable, 0o755);
  const codeIdentityAfter = await macDevRuntimeCodeIdentity(appPath);
  assert.notDeepEqual(codeIdentityAfter, codeIdentityBefore);
  const branded = await brandMacDevRuntime(appPath, {
    appId: "com.sambitcreate.aiden-agent",
    iconPath,
    productName: "Aiden Agent",
    version: "0.27.0",
    run: plistRunner,
  });

  await validateMacDevRuntime(appPath, {
    inspectArchitectures: async () => ["arm64"],
    layout: branded.layout,
    sourceArchitectures: ["arm64"],
    sourceHelperArchitectures: Object.fromEntries(
      branded.layout.helpers.map((helper) => [helper.sourceName, ["arm64"]]),
    ),
    run: plistRunner,
  });
  for (const helper of branded.layout.helpers) {
    const helperPlist = path.join(
      appPath,
      "Contents",
      "Frameworks",
      `${helper.destinationName}.app`,
      "Contents",
      "Info.plist",
    );
    assert.equal(await plistValue(helperPlist, "CFBundleName"), helper.destinationName);
  }

  assert.equal(
    await plistValue(path.join(appPath, "Contents", "Info.plist"), "NSMicrophoneUsageDescription"),
    "Aiden Agent uses the microphone only when you choose voice input or dictation.",
  );

  await assert.rejects(
    validateMacDevRuntime(appPath, {
      inspectArchitectures: async () => ["arm64"],
      layout: branded.layout,
      sourceArchitectures: ["x86_64"],
      sourceHelperArchitectures: Object.fromEntries(
        branded.layout.helpers.map((helper) => [helper.sourceName, ["arm64"]]),
      ),
      run: plistRunner,
    }),
    /architectures do not match the installed Electron runtime/u,
  );

  await assert.rejects(
    validateMacDevRuntime(appPath, {
      inspectArchitectures: async (executablePath) =>
        executablePath.includes("GPU") ? ["x86_64"] : ["arm64"],
      layout: branded.layout,
      sourceArchitectures: ["arm64"],
      sourceHelperArchitectures: Object.fromEntries(
        branded.layout.helpers.map((helper) => [helper.sourceName, ["arm64"]]),
      ),
      run: plistRunner,
    }),
    /Helper \(GPU\) architectures do not match/u,
  );

  const firstHelper = branded.layout.helpers[0];
  const firstHelperPlist = path.join(
    appPath,
    "Contents",
    "Frameworks",
    `${firstHelper.destinationName}.app`,
    "Contents",
    "Info.plist",
  );
  await plistRunner("/usr/bin/plutil", [
    "-replace",
    "CFBundleName",
    "-string",
    "Electron Helper",
    firstHelperPlist,
  ]);
  await assert.rejects(
    validateMacDevRuntime(appPath, {
      inspectArchitectures: async () => ["arm64"],
      layout: branded.layout,
      sourceArchitectures: ["arm64"],
      sourceHelperArchitectures: Object.fromEntries(
        branded.layout.helpers.map((helper) => [helper.sourceName, ["arm64"]]),
      ),
      run: plistRunner,
    }),
    /CFBundleName mismatch/u,
  );
});
