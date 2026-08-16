import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  appendDevLauncherEvent,
  brandMacDevRuntime,
  macDevRuntimeCodeIdentity,
  macDevLauncherLogPath,
  macDevRuntimeLayout,
  validateMacDevRuntime,
} from "./prepare-macos-dev-runtime.mjs";

const execFileAsync = promisify(execFile);

test("development launcher diagnostics use the isolated dev log root", () => {
  assert.equal(
    macDevLauncherLogPath({ HOME: "/Users/tester" }),
    "/Users/tester/Library/Application Support/Aiden Agent Dev/logs/aiden-dev-launcher.log",
  );
  assert.equal(
    macDevLauncherLogPath({
      HOME: "/Users/tester",
      AIDEN_DEV_LAUNCHER_LOG: "/tmp/custom-launcher.log",
    }),
    "/tmp/custom-launcher.log",
  );
  assert.equal(macDevLauncherLogPath({}), null);
});

test("development launcher diagnostics persist lifecycle details synchronously", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-dev-launcher-log-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const target = path.join(root, "nested", "launcher.log");

  appendDevLauncherEvent(target, "electron_exit", {
    code: null,
    signal: "SIGTERM",
    electronPid: 123,
  });

  assert.match(
    await readFile(target, "utf8"),
    /electron_exit \{"code":null,"signal":"SIGTERM","electronPid":123\}/u,
  );
});

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
    const helperApp = path.join(
      appPath,
      "Contents",
      "Frameworks",
      `${helper.sourceName}.app`,
    );
    const executable = path.join(
      helperApp,
      "Contents",
      "MacOS",
      helper.sourceName,
    );
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
    await plistRunner("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      plistPath,
    ])
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
    await plistValue(
      path.join(appPath, "Contents", "Info.plist"),
      "NSMicrophoneUsageDescription",
    ),
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
