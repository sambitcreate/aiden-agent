import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectWebApp } from "./app-detect.js";
import { hashBounded, launchDirsUnchanged, readLaunchSurface } from "./app-fingerprint.js";
import type { DetectedApp } from "./app-server-core.js";

const skip = process.platform === "win32" ? "POSIX file types" : false;

async function workspace(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-fingerprint-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function put(root: string, rel: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

async function webApp(root: string, rel = "."): Promise<DetectedApp> {
  const detected = await detectWebApp(root, { stopAt: path.dirname(root), homeDir: path.dirname(root) });
  const app = detected.apps.find((candidate) => candidate.root === rel);
  assert.ok(app, `no app at ${rel}: ${JSON.stringify(detected.apps.map((candidate) => [candidate.root, candidate.reason]))}`);
  return app;
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "web", devDependencies: { vite: "^6.0.0" }, scripts, ...extra });

async function surfaceOf(root: string, app: DetectedApp) {
  const result = await readLaunchSurface(root, app);
  assert.ok("fingerprint" in result, JSON.stringify(result));
  return result;
}

test("the surface lists the script, pre and post texts, both roots' install lifecycle scripts, and the files present", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", JSON.stringify({ private: true, workspaces: ["apps/*"], packageManager: "npm@10.9.0", scripts: { postinstall: "node root-setup.js", prepare: "husky" } }));
  await put(root, "package-lock.json", "{}");
  await put(root, "apps/web/package.json", pkg({ dev: "vite", predev: "node gen.js", postdev: "echo done", preinstall: "node check.js", build: "vite build" }, { devEngines: { runtime: { name: "node" } } }));
  await put(root, "apps/web/vite.config.ts", "export default {}");
  await put(root, "apps/web/.npmrc", "registry=https://registry.example/\n//registry.example/:_authToken=SECRET-TOKEN\n");
  const surface = await surfaceOf(root, await webApp(root, "apps/web"));
  assert.deepEqual(surface.scripts.map((script) => script.name), ["dev", "predev", "postdev", "preinstall", "postinstall (.)", "prepare (.)"]);
  assert.equal(surface.scripts.find((script) => script.name === "predev")?.text, "node gen.js");
  assert.equal(surface.surface.scripts["app:build"], undefined, "a script that never runs is not covered");
  assert.equal(surface.surface.scripts["install:postinstall"], "node root-setup.js");
  assert.equal(surface.surface.scripts["install:install"], null);
  assert.deepEqual(surface.surface.packageManager, { app: undefined, install: "npm@10.9.0" });
  assert.deepEqual(surface.surface.devEngines, { app: { runtime: { name: "node" } }, install: undefined });
  assert.deepEqual(surface.launchFiles, ["apps/web/.npmrc", "apps/web/vite.config.ts"]);
  assert.deepEqual(surface.surface.installArgv, ["npm", "ci"]);
  assert.deepEqual(surface.surface.runArgv, ["npm", "run", "dev"]);
  assert.equal(surface.packageName, "web");
  assert.equal(surface.lockHash, createHash("sha256").update("{}").digest("hex"));
});

test("rc and workspace files in every folder from the app root to the lockfile folder are hashed", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", JSON.stringify({ private: true }));
  await put(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  await put(root, ".pnpmfile.cjs", "module.exports = {}");
  await put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await put(root, "apps/web/package.json", pkg({ dev: "vite" }));
  await put(root, "apps/web/.npmrc", "a=1\n");
  const app = await webApp(root, "apps/web");
  const before = await surfaceOf(root, app);
  const names = before.surface.files.map(([name]) => name);
  for (const name of ["apps/web/.npmrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", "pnpm-lock.yaml", "apps/.npmrc", ".npmrc"]) {
    assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  }
  assert.equal(before.surface.files.find(([name]) => name === "apps/.npmrc")?.[1], "missing");
  for (const [rel, text] of [
    ["apps/web/.npmrc", "a=2\n"],
    [".pnpmfile.cjs", "module.exports = { hooks: {} }"],
    ["apps/.npmrc", "b=1\n"],
  ] as const) {
    const previous = (await surfaceOf(root, app)).fingerprint;
    await put(root, rel, text);
    assert.notEqual((await surfaceOf(root, app)).fingerprint, previous, rel);
  }
});

test("an enclosing lockfile two levels up is hashed", { skip }, async (t) => {
  const outer = await workspace(t);
  await put(outer, "package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
  await put(outer, "package-lock.json", "{\"v\":1}");
  const root = path.join(outer, "apps", "web");
  await put(root, "package.json", pkg({ dev: "vite" }));
  const detected = await detectWebApp(root, { stopAt: path.dirname(outer), homeDir: path.dirname(outer) });
  const app = detected.apps[0]!;
  assert.equal(app.packageManager.lockfileLevelsUp, 2);
  const first = await surfaceOf(root, app);
  assert.ok(first.surface.files.some(([name, hash]) => name === "../../package-lock.json" && hash !== "missing"));
  assert.equal(first.launchFiles.some((name) => name.startsWith("..")), false, "names above the workspace are never shown");
  await put(outer, "package-lock.json", "{\"v\":2}");
  assert.notEqual((await surfaceOf(root, app)).fingerprint, first.fingerprint);
});

test("another checkout with identical launch files has another fingerprint; the same checkout through a link has the same one", { skip }, async (t) => {
  const files = async (root: string) => {
    await put(root, "package.json", pkg({ dev: "vite", predev: "node gen.js" }));
    await put(root, "package-lock.json", "{}");
    await put(root, "vite.config.ts", "export default {}");
  };
  const site = await workspace(t);
  const fork = await workspace(t);
  await files(site);
  await files(fork);
  const ofSite = await surfaceOf(site, await webApp(site));
  const ofFork = await surfaceOf(fork, await webApp(fork));
  assert.deepEqual(ofFork.scripts, ofSite.scripts, "the card would show the same scripts");
  assert.deepEqual(ofFork.surface.files, ofSite.surface.files, "and the same launch files, byte for byte");
  assert.notEqual(ofFork.fingerprint, ofSite.fingerprint, "a workspace re-pointed at the fork asks again");

  const links = await workspace(t);
  const linked = path.join(links, "site-link");
  await symlink(site, linked);
  assert.equal((await surfaceOf(linked, await webApp(site))).fingerprint, ofSite.fingerprint, "the same folder by another path keeps its consent");
});

test("the folders a read validated stop matching when one is renamed and its name reused, by a link or a new folder", { skip }, async (t) => {
  for (const swap of ["link", "folder"] as const) {
    const root = await workspace(t);
    await put(root, "package.json", JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }));
    await put(root, "package-lock.json", "{}");
    await put(root, "apps/web/package.json", pkg({ dev: "vite" }));
    await put(root, "apps/other/package.json", pkg({ dev: "vite" }));
    const read = await surfaceOf(root, await webApp(root, "apps/web"));
    assert.equal(await launchDirsUnchanged(read.dirs), true, `${swap}: untouched folders still match`);
    await rename(path.join(root, "apps/web"), path.join(root, "apps/web-old"));
    if (swap === "link") await symlink(path.join(root, "apps/other"), path.join(root, "apps/web"));
    else await put(root, "apps/web/package.json", pkg({ dev: "vite" }));
    assert.equal(await launchDirsUnchanged(read.dirs), false, `${swap}: the name now names another folder`);
  }
});

test("the read reports the real app and install folders it validated, so a spawn never rebuilds them from relative roots", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }));
  await put(root, "package-lock.json", "{}");
  await put(root, "apps/web/package.json", pkg({ dev: "vite" }));
  const app = await webApp(root, "apps/web");
  const read = await surfaceOf(root, app);
  assert.equal(read.dirs.app, path.join(root, "apps", "web"));
  assert.equal(read.dirs.install, path.join(root, ...app.installRoot.split("/").filter((part) => part !== ".")));

  const links = await workspace(t);
  const linked = path.join(links, "mono-link");
  await symlink(root, linked);
  const viaLink = await surfaceOf(linked, app);
  assert.equal(viaLink.dirs.app, path.join(root, "apps", "web"), "a path through a link reports the real folder");
});

test("a .yarnrc.yml yarnPath target is hashed, and a yarnPath that is a symlink refuses", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite" }, { packageManager: "yarn@4.5.0" }));
  await put(root, "yarn.lock", "__metadata:\n  version: 8\n");
  await put(root, ".yarnrc.yml", "yarnPath: .yarn/releases/yarn-4.5.0.cjs\n");
  await put(root, ".yarn/releases/yarn-4.5.0.cjs", "console.log('yarn')");
  const app = await webApp(root);
  const first = await surfaceOf(root, app);
  assert.ok(first.surface.files.some(([name]) => name === ".yarn/releases/yarn-4.5.0.cjs"));
  await put(root, ".yarn/releases/yarn-4.5.0.cjs", "console.log('evil')");
  assert.notEqual((await surfaceOf(root, app)).fingerprint, first.fingerprint);
  await rm(path.join(root, ".yarn/releases/yarn-4.5.0.cjs"));
  await put(root, "elsewhere.cjs", "x");
  await symlink(path.join(root, "elsewhere.cjs"), path.join(root, ".yarn/releases/yarn-4.5.0.cjs"));
  assert.deepEqual(await readLaunchSurface(root, app), { problem: "launch-file-unreadable", file: ".yarn/releases/yarn-4.5.0.cjs" });
});

test("a symlinked vite.config.ts refuses with launch-file-unreadable naming it", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite" }));
  await put(root, "real.config.ts", "export default {}");
  await symlink(path.join(root, "real.config.ts"), path.join(root, "vite.config.ts"));
  assert.deepEqual(await readLaunchSurface(root, await webApp(root)), { problem: "launch-file-unreadable", file: "vite.config.ts" });
});

test("a FIFO named .npmrc refuses at once", { skip, timeout: 2_000 }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite" }));
  const app = await webApp(root);
  execFileSync("mkfifo", [path.join(root, ".npmrc")]);
  assert.deepEqual(await readLaunchSurface(root, app), { problem: "launch-file-unreadable", file: ".npmrc" });
});

test("a 2 MiB config file refuses, and a 10 MiB lockfile is hashed", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite" }));
  await put(root, "package-lock.json", "x".repeat(10 * 1024 * 1024));
  const app = await webApp(root);
  const ok = await surfaceOf(root, app);
  assert.ok(ok.surface.files.some(([name, hash]) => name === "package-lock.json" && /^[0-9a-f]{64}$/u.test(hash)));
  await put(root, "vite.config.mjs", "x".repeat(2 * 1024 * 1024));
  assert.deepEqual(await readLaunchSurface(root, app), { problem: "launch-file-unreadable", file: "vite.config.mjs" });
});

test("a script over 4 000 characters gives script-too-long", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite", predev: `echo ${"x".repeat(4_000)}` }));
  assert.deepEqual(await readLaunchSurface(root, await webApp(root)), { problem: "script-too-long" });
});

test("an .npmrc's contents never appear in the result", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "package.json", pkg({ dev: "vite" }));
  await put(root, ".npmrc", "//registry.npmjs.org/:_authToken=npm_SECRET_VALUE\n");
  const result = await surfaceOf(root, await webApp(root));
  assert.equal(JSON.stringify(result).includes("npm_SECRET_VALUE"), false);
  assert.ok(result.launchFiles.includes(".npmrc"));
});

test("hashBounded hashes a regular file and refuses links, folders and oversize files", { skip }, async (t) => {
  const root = await workspace(t);
  await put(root, "a.txt", "hello");
  assert.deepEqual(await hashBounded(path.join(root, "a.txt"), 10), { hash: createHash("sha256").update("hello").digest("hex") });
  assert.deepEqual(await hashBounded(path.join(root, "a.txt"), 4), { unreadable: true });
  assert.deepEqual(await hashBounded(path.join(root, "missing.txt"), 10), { missing: true });
  assert.deepEqual(await hashBounded(root, 10), { unreadable: true });
  await symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
  assert.deepEqual(await hashBounded(path.join(root, "link.txt"), 10), { unreadable: true });
});
