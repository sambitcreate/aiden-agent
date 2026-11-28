// The design app template (design mode v2 Phase 3d, S105, S106, S109, S110):
// its pins, lockfile and .npmrc read as data, its DESIGN.md through DM's real
// worker, and its vite.config.js loaded by Vite itself over small temp
// workspaces, so the real validation runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { createServer, loadConfigFromFile } from "vite";
import { isProtectedCredentialPath } from "../../model-file-policy.js";
import { runDesignMdWorker } from "../design-md/lint-client.js";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE = path.join(REPO, "resources", "design-app-template");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test("the template's direct dependencies are the versions Aiden's lockfile resolves", () => {
  const pkg = readJson(path.join(TEMPLATE, "package.json"));
  const root = readJson(path.join(REPO, "package-lock.json"));
  const direct = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  assert.deepEqual(Object.keys(direct).sort(), ["@vitejs/plugin-react", "react", "react-dom", "vite"]);
  for (const [name, version] of Object.entries(direct)) {
    assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} is an exact version`);
    assert.equal(version, root.packages[`node_modules/${name}`].version, `${name} matches Aiden's lockfile`);
  }
  // The template's own lockfile resolves the same versions.
  const lock = readJson(path.join(TEMPLATE, "package-lock.json"));
  for (const [name, version] of Object.entries(direct)) assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
});

test("every package in the template lockfile comes from the registry with sha512 integrity", () => {
  const lock = readJson(path.join(TEMPLATE, "package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; link?: boolean }>).filter(([key]) => key !== "");
  assert.ok(entries.length > 10);
  for (const [key, entry] of entries) {
    assert.equal(entry.link, undefined, `${key} is no link`);
    assert.ok(entry.resolved?.startsWith("https://registry.npmjs.org/"), `${key} resolves from the registry: ${entry.resolved}`);
    assert.ok(entry.resolved?.endsWith(".tgz"), `${key} is a tarball`);
    assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]+=*$/u, `${key} has sha512 integrity`);
  }
  // Linux and macOS bindings for the native parts are all in it (Probe 4).
  for (const key of ["node_modules/@rolldown/binding-linux-arm64-gnu", "node_modules/@rolldown/binding-linux-x64-gnu", "node_modules/@rolldown/binding-darwin-arm64", "node_modules/lightningcss-linux-arm64-gnu", "node_modules/lightningcss-darwin-arm64"]) {
    assert.ok(lock.packages[key], key);
  }
});

test("only the allowlisted optional darwin package has an install script", () => {
  const lock = readJson(path.join(TEMPLATE, "package-lock.json"));
  const scripted = Object.entries(lock.packages as Record<string, { hasInstallScript?: boolean; optional?: boolean; os?: string[] }>)
    .filter(([, entry]) => entry.hasInstallScript)
    .map(([key]) => key);
  assert.deepEqual(scripted, ["node_modules/fsevents"]);
  assert.equal(lock.packages["node_modules/fsevents"].optional, true);
  assert.deepEqual(lock.packages["node_modules/fsevents"].os, ["darwin"]);
});

test("the template's .npmrc turns off install scripts, audit, fund and the update check, and sets no registry", () => {
  const lines = fs
    .readFileSync(path.join(TEMPLATE, ".npmrc"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));
  const settings = Object.fromEntries(lines.map((line) => line.split("=").map((part) => part.trim())));
  assert.deepEqual(settings, { "ignore-scripts": "true", audit: "false", fund: "false", "update-notifier": "false" });
  assert.equal(lines.some((line) => /registry/u.test(line)), false);
});

test("the starter DESIGN.md lints clean", async () => {
  const content = fs.readFileSync(path.join(TEMPLATE, "DESIGN.md"), "utf8");
  const outcome = await runDesignMdWorker({ op: "lint", content }, { deadlineMs: 30_000, loadTimeoutMs: 60_000 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.summary.errors, 0, JSON.stringify(outcome.result.findings));
  assert.equal(outcome.result.summary.warnings, 0, JSON.stringify(outcome.result.findings));
});

test("theme.css is the css-vars export of the starter DESIGN.md", async () => {
  const content = fs.readFileSync(path.join(TEMPLATE, "DESIGN.md"), "utf8");
  const outcome = await runDesignMdWorker({ op: "export", content, format: "css-vars" }, { deadlineMs: 30_000, loadTimeoutMs: 60_000 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.success, true);
  // check-aiden-rules: allow no-source-grep-test the shipped theme.css must equal the exporter's output for the shipped DESIGN.md
  assert.equal(fs.readFileSync(path.join(TEMPLATE, "src", "theme.css"), "utf8"), outcome.result.text);
});

// ---- vite.config.js, loaded by Vite over temp workspaces ----

type Workspace = { root: string; mock: string };

/** A workspace with the template's config and stubs in design-app/, node_modules linked to Aiden's own (no network). */
function workspace(mockJson?: unknown, files: Record<string, string> = {}): Workspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiden-mock-config-")));
  temps.push(root);
  const mock = path.join(root, "design-app");
  for (const rel of ["vite.config.js", "package.json", "index.html", "src/stubs/preload.ts", "src/stubs/electron.ts", "src/stubs/tauri.ts", "src/aiden/jsx-dev-runtime.ts"]) {
    fs.mkdirSync(path.dirname(path.join(mock, rel)), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, rel), path.join(mock, rel));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(mock, "node_modules"), "dir");
  if (mockJson !== undefined) fs.writeFileSync(path.join(mock, "aiden.mock.json"), typeof mockJson === "string" ? mockJson : JSON.stringify(mockJson));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { root, mock };
}

const mockJson = (extra: Record<string, unknown> = {}) => ({ version: 1, kind: "react-nonweb", source: ".", aliases: {}, stubs: {}, globals: [], ...extra });

async function load(ws: Workspace) {
  // "native" imports the config straight from disk, so no bundled temp file is written into node_modules.
  const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, path.join(ws.mock, "vite.config.js"), ws.mock, "silent", undefined, "native");
  assert.ok(loaded);
  return loaded.config;
}

async function refuses(ws: Workspace, pattern: RegExp) {
  await assert.rejects(load(ws), (error: Error) => pattern.test(error.message));
}

test("a missing aiden.mock.json is the starter", async () => {
  const ws = workspace();
  const config = await load(ws);
  assert.deepEqual(config.define?.__AIDEN_MOCK_GLOBALS__, "[]");
  assert.deepEqual(config.server?.fs?.allow, [ws.mock, fs.realpathSync(path.join(REPO, "node_modules"))]);
});

test("the template's own aiden.mock.json is the starter", async () => {
  const data = readJson(path.join(TEMPLATE, "aiden.mock.json"));
  assert.deepEqual(data, { version: 1, kind: "starter", source: null, aliases: {}, stubs: {}, globals: [] });
  const ws = workspace(data);
  const config = await load(ws);
  assert.deepEqual(config.server?.fs?.allow, [ws.mock, fs.realpathSync(path.join(REPO, "node_modules"))]);
});

test("an alias inside the workspace resolves", async () => {
  const ws = workspace(mockJson({ aliases: { "@app": "src/renderer" } }), { "src/renderer/components/Button.tsx": "export const Button = () => null;\n" });
  const config = await load(ws);
  const aliases = config.resolve?.alias as Array<{ find: RegExp; replacement: string }>;
  const app = aliases.find((entry) => entry.find.test("@app/components/Button"))!;
  assert.equal(app.replacement, path.join(ws.root, "src", "renderer"));
  assert.equal("@app/components/Button".replace(app.find, app.replacement), path.join(ws.root, "src/renderer/components/Button"));
  assert.equal(app.find.test("@application"), false, "only @app and its subpaths");
});

test("an alias to /etc, to .git or through a link out of the workspace refuses", async () => {
  await refuses(workspace(mockJson({ aliases: { "@app": "/etc" } })), /workspace-relative/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "../outside" } })), /workspace-relative/u);
  const git = workspace(mockJson({ aliases: { "@app": ".git" } }), { ".git/HEAD": "ref: refs/heads/main\n" });
  await refuses(git, /hidden/u);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-mock-outside-"));
  temps.push(outside);
  const linked = workspace(mockJson({ aliases: { "@app": "ui" } }));
  fs.symlinkSync(outside, path.join(linked.root, "ui"), "dir");
  await refuses(linked, /inside the workspace/u);
  // A link inside the workspace to a hidden folder is refused by where it leads.
  const sneaky = workspace(mockJson({ aliases: { "@app": "ui" } }), { ".ssh/config": "Host x\n" });
  fs.symlinkSync(path.join(sneaky.root, ".ssh"), path.join(sneaky.root, "ui"), "dir");
  await refuses(sneaky, /leads to/u);
});

test("an alias to .aiden, node_modules, a hidden folder or the mock itself refuses", async () => {
  await refuses(workspace(mockJson({ aliases: { "@app": ".aiden" } }), { ".aiden/canvas.json": "{}" }), /hidden/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "node_modules" } }), { "node_modules/x/index.js": "" }), /node_modules/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "src/.private" } }), { "src/.private/a.tsx": "" }), /hidden/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "design-app" } })), /design app's own folder/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "design-app/src" } })), /design app's own folder/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "." } })), /hidden|workspace/u);
  await refuses(workspace(mockJson({ aliases: { "@app": "missing" } })), /doesn't exist/u);
});

test("an alias to a protected credential path refuses", async () => {
  for (const target of [".ssh", ".aws", "config/.env.d", "secrets", "deploy/credentials", "app/keystore", "tokens"]) {
    await refuses(workspace(mockJson({ aliases: { "@app": target } }), { [`${target}/x.txt`]: "x" }), /hidden|credential/u);
  }
});

test("the config's credential rule agrees with isProtectedCredentialPath", async () => {
  const config = (await import(pathToFileURL(path.join(TEMPLATE, "vite.config.js")).href)) as { aliasPathRefused(rel: string): boolean };
  const table = [
    ".ssh", ".aws", ".gnupg", ".git", ".aiden", ".config/gcloud", ".docker", ".kube", "src/.env", "config/.env.local", ".envrc",
    "secrets", "secret", "src/secrets", "tokens", "auth", "oauth", "creds", "credentials", "config/credentials", "keys", "api-keys",
    "app/keystore", "keychain", "vault", "wallet", "passwords", "id_rsa", "id_ed25519", "kubeconfig", "service-account", "client_secret",
    "certs/server.pem", "deploy/key.p12", "backup.bak", "private_key", "pgp", "logins",
    "src", "src/renderer", "src/ui", "app/components", "renderer", "src/web", "lib/widgets", "packages/ui/src", "src/renderer/settings",
    "docs", "design-system", "src/author", "src/keyboard", "src/tokenizer-ui",
  ];
  let refusedOrdinary = 0;
  for (const rel of table) {
    if (isProtectedCredentialPath(rel, "directory")) assert.equal(config.aliasPathRefused(rel), true, `${rel} is protected, so an alias refuses it`);
    else if (!config.aliasPathRefused(rel)) refusedOrdinary++;
  }
  assert.ok(refusedOrdinary >= 8, "ordinary UI folders stay aliasable");
  for (const ordinary of ["src/renderer", "src/ui", "app/components", "packages/ui/src"]) assert.equal(config.aliasPathRefused(ordinary), false, ordinary);
});

test("server.fs.allow is the mock, its node_modules and the alias folders only", async () => {
  const starter = workspace({ version: 1, kind: "starter", source: null, aliases: {}, stubs: {}, globals: [] });
  const nodeModules = fs.realpathSync(path.join(REPO, "node_modules"));
  assert.deepEqual((await load(starter)).server?.fs?.allow, [starter.mock, nodeModules]);
  const electron = workspace(
    mockJson({ aliases: { "@app": "src/renderer", "@shared": "src/shared" }, stubs: { electron: "src/stubs/electron.ts" }, globals: ["api"] }),
    { "src/renderer/App.tsx": "", "src/shared/x.ts": "" },
  );
  const config = await load(electron);
  assert.deepEqual(config.server?.fs?.allow, [electron.mock, nodeModules, path.join(electron.root, "src/renderer"), path.join(electron.root, "src/shared")]);
  assert.equal(config.server?.fs?.allow?.includes(electron.root), false, "never the workspace root");
  assert.equal(config.define?.__AIDEN_MOCK_GLOBALS__, JSON.stringify(["api"]));
  const aliases = config.resolve?.alias as Array<{ find: RegExp; replacement: string }>;
  const stub = aliases.find((entry) => entry.find.test("electron"))!;
  assert.equal(stub.replacement, path.join(electron.mock, "src/stubs/electron.ts"));
  assert.equal(stub.find.test("electron/renderer"), true);
  assert.equal(stub.find.test("electron-store"), false);
  // An inline PostCSS config, so no postcss.config.* above the folder runs (Probe 3).
  assert.deepEqual(config.css?.postcss, {});
});

test("server.fs.deny names the credential globs", async () => {
  const ws = workspace(mockJson({ aliases: { "@app": "src/renderer" } }), {
    "src/renderer/components/Button.tsx": "export function Button() { return <button>Save</button>; }\n",
    "src/renderer/.npmrc": "//registry.npmjs.org/:_authToken=secret\n",
    "src/renderer/.env": "TOKEN=secret\n",
    "src/renderer/server.key": "secret\n",
    "src/other/Thing.tsx": "export const Thing = 1;\n",
  });
  const server = await createServer({
    configFile: path.join(ws.mock, "vite.config.js"),
    configLoader: "native",
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls!.local[0]!.replace(/\/$/u, "");
    const status = async (url: string) => (await fetch(`${origin}${url}`)).status;
    const alias = path.join(ws.root, "src", "renderer");
    assert.equal(await status(`/@fs${alias}/components/Button.tsx`), 200);
    assert.equal(await status(`/@fs${alias}/.npmrc`), 403);
    assert.equal(await status(`/@fs${alias}/.env`), 403);
    assert.equal(await status(`/@fs${alias}/server.key`), 403);
    // Outside the allow list: the workspace's other folders aren't served.
    assert.equal(await status(`/@fs${ws.root}/src/other/Thing.tsx`), 403);
  } finally {
    await server.close();
  }
});

test("a stub outside src/stubs refuses", async () => {
  await refuses(workspace(mockJson({ stubs: { electron: "src/main.tsx" } })), /src\/stubs/u);
  await refuses(workspace(mockJson({ stubs: { electron: "src/stubs/../../vite.config.js" } })), /src\/stubs/u);
  await refuses(workspace(mockJson({ stubs: { electron: "src/stubs/missing.ts" } })), /doesn't exist/u);
  const linked = workspace(mockJson({ stubs: { electron: "src/stubs/link.ts" } }), { "secret.ts": "export {}" });
  fs.symlinkSync(path.join(linked.root, "secret.ts"), path.join(linked.mock, "src/stubs/link.ts"));
  await refuses(linked, /src\/stubs/u);
});

test("a bad alias name or a non-identifier global refuses", async () => {
  await refuses(workspace(mockJson({ aliases: { "../x": "src" } }), { "src/a.tsx": "" }), /alias name/u);
  await refuses(workspace(mockJson({ aliases: { "@App": "src" } }), { "src/a.tsx": "" }), /alias name/u);
  await refuses(workspace(mockJson({ globals: ["not an identifier"] })), /global/u);
  await refuses(workspace(mockJson({ globals: ["window"] })), /global/u);
  await refuses(workspace(mockJson({ globals: Array.from({ length: 21 }, (_, i) => `g${i}`) })), /at most 20 globals/u);
  await refuses(workspace(mockJson({ stubs: { "Not A Package": "src/stubs/electron.ts" } })), /package name/u);
  await refuses(workspace(mockJson({ version: 2 })), /version/u);
  await refuses(workspace("{not json"), /valid JSON/u);
  const linkedFile = workspace();
  fs.writeFileSync(path.join(linkedFile.root, "real.json"), JSON.stringify(mockJson()));
  fs.symlinkSync(path.join(linkedFile.root, "real.json"), path.join(linkedFile.mock, "aiden.mock.json"));
  await refuses(linkedFile, /regular file/u);
});

// ── S111: the data-aiden-src shim ──

type Shim = typeof import("../../../../resources/design-app-template/src/aiden/jsx-dev-runtime.js");

/** The shim as Vite serves it, with the workspace roots vite.config.js defines (its realpath first, then as given). */
async function shim(roots: readonly string[]): Promise<Shim> {
  (globalThis as { __AIDEN_WORKSPACE_ROOTS__?: readonly string[] }).__AIDEN_WORKSPACE_ROOTS__ = roots;
  try {
    // A fresh module per roots: the shim reads the define once, as it loads.
    return (await import(`${pathToFileURL(path.join(TEMPLATE, "src/aiden/jsx-dev-runtime.ts")).href}?roots=${encodeURIComponent(roots.join("|"))}`)) as Shim;
  } finally {
    delete (globalThis as { __AIDEN_WORKSPACE_ROOTS__?: readonly string[] }).__AIDEN_WORKSPACE_ROOTS__;
  }
}

const propsOf = (element: unknown) => (element as { props: Record<string, unknown> }).props;

test("a host element gets data-aiden-src with ws:, the workspace path and line", async () => {
  const { jsxDEV } = await shim(["/Users/person/site"]);
  const element = jsxDEV("h1", { children: "Hello" }, undefined, false, { fileName: "/Users/person/site/design-app/src/routes/index.tsx", lineNumber: 9 }, undefined);
  assert.equal(propsOf(element)["data-aiden-src"], "ws:design-app/src/routes/index.tsx:9");
  assert.equal(propsOf(element).children, "Hello", "the other props pass through");
  // An aliased project component compiles through the same runtime.
  const aliased = jsxDEV("button", {}, undefined, false, { fileName: "/Users/person/site/src/renderer/components/Button.tsx?v=3", lineNumber: 14 }, undefined);
  assert.equal(propsOf(aliased)["data-aiden-src"], "ws:src/renderer/components/Button.tsx:14");
});

test("a workspace under a linked folder still matches", async () => {
  // vite.config.js defines the realpath'd root and the root as given; Vite's fileName is the realpath form.
  const { jsxDEV } = await shim(["/private/var/folders/ab/site", "/var/folders/ab/site"]);
  for (const fileName of ["/private/var/folders/ab/site/design-app/src/App.tsx", "/var/folders/ab/site/design-app/src/App.tsx"]) {
    const element = jsxDEV("main", {}, undefined, false, { fileName, lineNumber: 3 }, undefined);
    assert.equal(propsOf(element)["data-aiden-src"], "ws:design-app/src/App.tsx:3", fileName);
  }
});

test("a component element, an element that has one already, and a source outside the workspace are left alone", async () => {
  const { jsxDEV } = await shim(["/Users/person/site"]);
  const source = { fileName: "/Users/person/site/design-app/src/routes/index.tsx", lineNumber: 4 };
  const Card = () => null;
  assert.equal("data-aiden-src" in propsOf(jsxDEV(Card, {}, undefined, false, source, undefined)), false, "a component");
  assert.equal(propsOf(jsxDEV("div", { "data-aiden-src": "mine" }, undefined, false, source, undefined))["data-aiden-src"], "mine");
  for (const outside of [
    { fileName: "/Users/person/other/src/App.tsx", lineNumber: 1 },
    { fileName: "/Users/person/site-two/src/App.tsx", lineNumber: 1 },
    { fileName: "/Users/person/site/node_modules/../secret.tsx", lineNumber: 1 },
    { fileName: "/Users/person/site/design-app/src/App.tsx", lineNumber: 0 },
    undefined,
  ]) {
    assert.equal("data-aiden-src" in propsOf(jsxDEV("div", {}, undefined, false, outside, undefined)), false, JSON.stringify(outside));
  }
});

test("the value is capped at 256 characters and never absolute or with ..", async () => {
  const { aidenSourceStamp } = await shim([]);
  const root = "/Users/person/site";
  const long = `design-app/src/${"a".repeat(240)}.tsx`;
  assert.equal(aidenSourceStamp({ fileName: `${root}/${long}`, lineNumber: 1 }, [root]), null);
  const fits = `design-app/src/${"a".repeat(220)}.tsx`;
  const stamp = aidenSourceStamp({ fileName: `${root}/${fits}`, lineNumber: 12 }, [root]);
  assert.ok(stamp && stamp.length <= 256);
  for (const fileName of [`${root}/design-app/../x.tsx`, `${root}//x.tsx`, `${root}/./x.tsx`, "/etc/passwd"]) {
    const value = aidenSourceStamp({ fileName, lineNumber: 1 }, [root]);
    assert.equal(value, null, fileName);
  }
  const ok = aidenSourceStamp({ fileName: `${root}/design-app/x.tsx`, lineNumber: 1 }, [root])!;
  assert.ok(ok.startsWith("ws:") && !ok.slice(3).startsWith("/") && !ok.includes(".."));
});
