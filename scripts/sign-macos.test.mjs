/* global URL */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  COMPUTER_USE_ENTITLEMENTS,
  createAidenMacSignOptions,
  verifyPinnedLume,
} from "./sign-macos.mjs";
import { packagedComputerUsePaths } from "./computer-use-signing-pins.mjs";
import {
  LUME_ARTIFACT_PROVENANCE,
  lumeRequirement,
  packagedLumePaths,
} from "./bot-computers-lume-pins.mjs";

test("mac signing hook ignores only the exact pinned driver and retains prior ignores", () => {
  const app = path.resolve("/tmp/Aiden Agent.app");
  const paths = packagedComputerUsePaths(app);
  const options = createAidenMacSignOptions({
    app,
    ignore: (file) => file.endsWith("already-ignored"),
    optionsForFile: () => ({ entitlements: "/tmp/electron.plist", hardenedRuntime: true }),
  });

  assert.equal(options.ignore(paths.driver), true);
  assert.equal(options.ignore(path.join(app, "Contents", "MacOS", "cua-driver")), false);
  assert.equal(options.ignore(path.join(app, "already-ignored")), true);
});

test("mac signing hook assigns minimal entitlements to privileged and standalone native helpers", () => {
  const app = path.resolve("/tmp/Aiden Agent.app");
  const paths = packagedComputerUsePaths(app);
  const electronEntitlements = "/tmp/electron.plist";
  const options = createAidenMacSignOptions({
    app,
    optionsForFile: () => ({
      entitlements: electronEntitlements,
      hardenedRuntime: true,
      timestamp: true,
    }),
  });

  assert.equal(options.optionsForFile(paths.helperApp).entitlements, COMPUTER_USE_ENTITLEMENTS);
  assert.equal(options.optionsForFile(paths.broker).entitlements, COMPUTER_USE_ENTITLEMENTS);
  assert.equal(options.optionsForFile(paths.broker).timestamp, true);
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-bot-inbox-writer"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-lease-flock"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-run-store"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-file-mutator"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-shell-runner"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-worktree-remover"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "MacOS", "Aiden Agent")).entitlements,
    electronEntitlements,
  );
});

async function lumeFixtureApp(t) {
  const { mkdtemp, mkdir, realpath, rm, truncate, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-sign-lume-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Aiden Agent.app");
  const paths = packagedLumePaths(app);
  await mkdir(path.dirname(paths.binary), { recursive: true });
  await writeFile(paths.binary, "stand-in");
  await truncate(paths.binary, LUME_ARTIFACT_PROVENANCE.binaryBytes);
  return { root, app, paths };
}

test("mac signing hook never re-signs the Lume bundle or anything inside it", () => {
  const app = path.resolve("/tmp/Aiden Agent.app");
  const lume = packagedLumePaths(app);
  const options = createAidenMacSignOptions({ app });
  for (const file of [lume.lumeApp, lume.binary, lume.infoPlist, lume.provisioningProfile]) {
    assert.equal(options.ignore(file), true, file);
  }
  for (const file of [
    path.join(app, "Contents", "Helpers", "lume.app-other", "Contents", "MacOS", "lume"),
    path.join(app, "Contents", "Helpers", "lume"),
    packagedComputerUsePaths(app).broker,
    path.join(app, "Contents", "MacOS", "Aiden Agent"),
  ]) {
    assert.equal(options.ignore(file), false, file);
  }
});

test("electron-builder's signIgnore covers the Lume bundle directory and its contents", async () => {
  const { readFile } = await import("node:fs/promises");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const patterns = [packageJson.build.mac.signIgnore].flat().map((pattern) => new RegExp(pattern));
  const ignored = (file) => patterns.some((pattern) => pattern.test(file));
  const app = "/Users/me/release/mac-arm64/Aiden Agent.app";
  const lume = packagedLumePaths(app);
  const cua = packagedComputerUsePaths(app);
  // osx-sign signs every .app directory it walks, so the bundle path itself must match.
  for (const file of [lume.lumeApp, lume.binary, lume.infoPlist, cua.driver]) assert.equal(ignored(file), true, file);
  for (const file of [cua.broker, cua.helperApp, path.join(app, "Contents", "MacOS", "Aiden Agent")]) {
    assert.equal(ignored(file), false, file);
  }
  assert.equal(
    packageJson.build.mac.binaries.some((entry) => /lume/i.test(entry)),
    false,
    "Lume keeps its upstream signature, so it must never be listed for Aiden re-signing",
  );
});

test("electron-builder places Lume and its provenance where the hook and the verifier look", async () => {
  const { readFile } = await import("node:fs/promises");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const app = path.resolve("/tmp/Aiden Agent.app");
  const lume = packagedLumePaths(app);
  const contents = path.join(app, "Contents");
  const extraFile = packageJson.build.mac.extraFiles.find((entry) => entry.from === "build/bot-computers/lume.app");
  assert.ok(extraFile, "the vendored bundle is copied into the package");
  assert.equal(path.join(contents, extraFile.to), lume.lumeApp);
  const resources = new Map(packageJson.build.mac.extraResources.map((entry) => [entry.from, entry.to]));
  assert.equal(
    path.join(contents, "Resources", resources.get("resources/bot-computers/lume-artifact.json")),
    lume.outerProvenance,
  );
  assert.equal(
    path.join(contents, "Resources", resources.get("resources/bot-computers/LICENSE.lume.md")),
    lume.outerLicenseNotice,
  );
  assert.match(packageJson.scripts["bot-computers:vendor"], /scripts\/vendor-lume\.mjs$/u);
  const order = packageJson.scripts.package.split("&&").map((step) => step.trim());
  const at = (script) => order.indexOf(`npm run ${script}`);
  assert.ok(at("bot-computers:vendor") > at("computer-use:vendor"));
  assert.ok(at("bot-computers:vendor") < at("build"));
});

test("pinned Lume verification refuses a changed binary before running codesign", async (t) => {
  const { app, paths } = await lumeFixtureApp(t);
  const calls = [];
  const execute = async (command, args) => {
    calls.push({ command, args });
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    verifyPinnedLume(app, { hash: async () => "0".repeat(64), execute }),
    /Packaging changed the pinned Lume binary/,
  );
  assert.equal(calls.length, 0);

  await verifyPinnedLume(app, { hash: async () => LUME_ARTIFACT_PROVENANCE.binarySha256, execute });
  assert.deepEqual(calls, [
    {
      command: "/usr/bin/codesign",
      args: ["--verify", "--deep", "--strict", "--verbose=2", `-R=${lumeRequirement()}`, paths.lumeApp],
    },
  ]);
});

test("pinned Lume verification refuses a symlinked bundle", async (t) => {
  const { rename, symlink } = await import("node:fs/promises");
  const { root, app, paths } = await lumeFixtureApp(t);
  const elsewhere = path.join(root, "elsewhere.app");
  await rename(paths.lumeApp, elsewhere);
  await symlink(elsewhere, paths.lumeApp);
  await assert.rejects(
    verifyPinnedLume(app, {
      hash: async () => LUME_ARTIFACT_PROVENANCE.binarySha256,
      execute: async () => assert.fail("codesign must not run"),
    }),
    /not a regular, non-symlinked bundle/,
  );
});
