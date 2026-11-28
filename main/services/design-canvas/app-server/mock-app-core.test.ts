import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasConfigInspection } from "../canvas-config.js";
import type { DetectedApp, WebAppDetection } from "./app-server-core.js";
import { scanTsTokens } from "./app-routes-core.js";
import { exposedGlobals, guessUiRoot, isMockPackage, MOCK_FOLDERS, mockConfig, mockFolderCovered, mockOffer } from "./mock-app-core.js";

function app(partial: Partial<DetectedApp> & Pick<DetectedApp, "root" | "kind" | "reason">): DetectedApp {
  return {
    scripts: [],
    usesReact: false,
    packageManager: { name: "npm", source: "none", lockfileLevelsUp: 0 },
    installRoot: partial.root,
    installed: false,
    ...partial,
  };
}

const detection = (apps: DetectedApp[], truncated = false): WebAppDetection => ({ apps, truncated });
const NO_PATTERNS = { include: [], exclude: [] };
const free = new Map<string, "missing" | "mock" | "taken">(MOCK_FOLDERS.map((folder) => [folder, "missing"]));
const offer = (
  apps: DetectedApp[],
  options: { truncated?: boolean; config?: CanvasConfigInspection | null; folders?: Map<string, "missing" | "mock" | "taken">; patterns?: { include: string[]; exclude: string[] }; permission?: string } = {},
) => mockOffer(detection(apps, options.truncated), options.config ?? null, options.folders ?? free, options.patterns ?? NO_PATTERNS, options.permission ?? "write");

const electronReact = app({ root: ".", kind: "react-nonweb", reason: "desktop", desktopShell: "electron", usesReact: true });
const tauriReact = app({ root: ".", kind: "react-nonweb", reason: "desktop", desktopShell: "tauri", usesReact: true });
const expo = app({ root: "apps/mobile", kind: "react-nonweb", reason: "react-native", usesReact: true });
const electronVue = app({ root: ".", kind: "none", reason: "desktop", desktopShell: "electron" });
const web = app({ root: "apps/web", kind: "web", reason: "ok", framework: "vite", script: "dev" });
const mockWeb = app({ root: "design-app", kind: "web", reason: "ok", framework: "vite", script: "dev", mock: true });
const config = (apps: Array<Record<string, unknown>>): CanvasConfigInspection => ({
  status: "ok",
  config: { version: 1, apps: apps as never },
  raw: { version: 1, apps },
});

test("mockOffer follows S103's table", () => {
  assert.deepEqual(offer([electronReact]), { offer: "react-nonweb", folder: "design-app", source: ".", shell: "electron" });
  assert.deepEqual(offer([tauriReact]), { offer: "react-nonweb", folder: "design-app", source: ".", shell: "tauri" });
  assert.deepEqual(offer([expo]), { offer: "react-nonweb", folder: "design-app", source: "apps/mobile", reactNative: true });
  assert.deepEqual(offer([electronVue]), { offer: "starter", folder: "design-app" });
  assert.deepEqual(offer([]), { offer: "starter", folder: "design-app" }, "an empty folder or a Python repo");
  assert.deepEqual(offer([app({ root: ".", kind: "none", reason: "no-web-framework" })]), { offer: "starter", folder: "design-app" });
  assert.deepEqual(offer([app({ root: ".", kind: "none", reason: "no-package-json" })]), { offer: "starter", folder: "design-app" }, "Deno only");

  for (const reason of ["workspace-runner", "unknown-framework", "no-dev-script", "invalid-package-json"] as const) {
    const blocker = app({ root: "packages/x", kind: "none", reason });
    assert.deepEqual(offer([electronReact, blocker]), { offer: "refused", why: reason }, `${reason} refuses even beside a react-nonweb package`);
  }

  assert.deepEqual(offer([electronReact, web]), { offer: "refused", why: "has-web-app" });
  assert.deepEqual(offer([electronReact], { config: config([{ root: "apps/site", script: "dev" }]) }), { offer: "refused", why: "has-web-app" }, "a configured root");
  assert.deepEqual(offer([electronReact], { config: config([{ root: "apps/site", url: "http://127.0.0.1:3000" }]) }), { offer: "refused", why: "has-web-app" }, "a url root");
  // A canvas.json entry for the design app itself isn't another web app.
  assert.deepEqual(offer([electronReact], { config: config([{ root: "design-app", script: "dev" }]) }).offer, "react-nonweb");

  assert.deepEqual(offer([electronReact], { truncated: true }), { offer: "refused", why: "truncated" });
  assert.deepEqual(offer([electronReact], { config: { status: "unsupported-version", raw: { version: 9 } } }), { offer: "refused", why: "unsupported-config" });
  assert.deepEqual(offer([electronReact], { permission: "read-only" }), { offer: "refused", why: "read-only" });
  assert.deepEqual(offer([electronReact], { permission: "none" }), { offer: "refused", why: "read-only" });
});

test("the folder is design-app, else the next free one; a mock app is reused; design/ never", () => {
  const states = (entries: Record<string, "missing" | "mock" | "taken">) => new Map(MOCK_FOLDERS.map((folder) => [folder, entries[folder] ?? "missing"]));
  assert.deepEqual(offer([electronReact], { folders: states({ "design-app": "taken" }) }), { offer: "react-nonweb", folder: "design-app-2", source: ".", shell: "electron" });
  assert.deepEqual(offer([], { folders: states({ "design-app": "taken", "design-app-2": "taken" }) }), { offer: "starter", folder: "design-app-3" });
  assert.deepEqual(offer([electronReact, mockWeb], { folders: states({ "design-app": "mock" }) }), { offer: "existing", folder: "design-app" });
  assert.deepEqual(offer([], { folders: states({ "design-app": "taken", "design-app-4": "mock" }) }), { offer: "existing", folder: "design-app-4" });
  const allTaken = new Map(MOCK_FOLDERS.map((folder) => [folder, "taken" as const]));
  assert.deepEqual(offer([electronReact], { folders: allTaken }), { offer: "refused", why: "no-free-folder" });
  assert.equal(MOCK_FOLDERS.length, 9);
  assert.deepEqual(MOCK_FOLDERS, ["design-app", ...Array.from({ length: 8 }, (_, i) => `design-app-${i + 2}`)]);
  assert.equal(MOCK_FOLDERS.includes("design"), false);
  // A folder state the caller didn't read counts as taken, never as free.
  assert.deepEqual(offer([], { folders: new Map([["design-app", "taken"]]) }), { offer: "refused", why: "no-free-folder" });
});

test("a workspace pattern covering the folder refuses", () => {
  for (const include of [["*"], ["design-*"], ["design-app"], ["**"], ["**/*"], ["{apps,design-app}"], ["*/deep/**/x"]]) {
    assert.equal(mockFolderCovered("design-app", { include, exclude: [] }), true, JSON.stringify(include));
    assert.deepEqual(offer([electronReact], { patterns: { include, exclude: [] } }), { offer: "refused", why: "in-workspaces", folder: "design-app" }, JSON.stringify(include));
  }
  assert.equal(mockFolderCovered("design-app", { include: ["packages/*"], exclude: [] }), false);
  assert.equal(mockFolderCovered("design-app", { include: ["*"], exclude: ["design-app"] }), false);
  assert.equal(mockFolderCovered("design-app-2", { include: ["*"], exclude: ["design-app"] }), true, "the exclude must name the folder exactly");
  assert.equal(offer([electronReact], { patterns: { include: ["*"], exclude: ["design-app"] } }).offer, "react-nonweb");
});

test("real web apps come before an existing mock", () => {
  const folders = new Map(MOCK_FOLDERS.map((folder) => [folder, folder === "design-app" ? ("mock" as const) : ("missing" as const)]));
  assert.deepEqual(offer([web, mockWeb], { folders }), { offer: "refused", why: "has-web-app" });
  assert.deepEqual(offer([mockWeb], { folders }), { offer: "existing", folder: "design-app" });
});

test("isMockPackage needs aiden.designApp exactly 1", () => {
  assert.equal(isMockPackage({ aiden: { designApp: 1 } }), true);
  for (const aiden of [{ designApp: "1" }, { designApp: 2 }, { designApp: true }, {}, [1], null, 1]) {
    assert.equal(isMockPackage({ aiden }), false, JSON.stringify(aiden));
  }
  assert.equal(isMockPackage({}), false);
  assert.equal(isMockPackage(null), false);
});

test("guessUiRoot takes the first folder with JSX", () => {
  const jsx = (...folders: string[]) => new Map(folders.map((folder) => [folder, true]));
  assert.equal(guessUiRoot(".", jsx("src", "src/renderer")), "src/renderer");
  assert.equal(guessUiRoot(".", jsx("src", "renderer")), "renderer");
  assert.equal(guessUiRoot(".", jsx("src")), "src");
  assert.equal(guessUiRoot("apps/desktop", jsx("apps/desktop/src/ui")), "apps/desktop/src/ui");
  assert.equal(guessUiRoot(".", new Map([["src/renderer", false], ["src", true]])), "src");
  assert.equal(guessUiRoot(".", jsx()), null);
});

test("guessUiRoot skips folders an alias couldn't name", () => {
  assert.equal(guessUiRoot(".ssh", new Map([[".ssh/src", true]])), null);
  assert.equal(guessUiRoot("node_modules/pkg", new Map([["node_modules/pkg/src", true]])), null);
  assert.equal(guessUiRoot("packages/.hidden", new Map([["packages/.hidden/src/renderer", true]])), null);
  assert.equal(guessUiRoot("secrets", new Map([["secrets/src", true]])), null, "a credential folder");
});

test("exposedGlobals reads exposeInMainWorld's first string argument", () => {
  const tokens = (text: string) => scanTsTokens(text)!;
  assert.deepEqual(
    exposedGlobals(tokens(`import { contextBridge } from "electron";\ncontextBridge.exposeInMainWorld("api", { ping: () => 1 });\nexposeInMainWorld('electron', handlers);`)),
    ["api", "electron"],
  );
  assert.deepEqual(exposedGlobals(tokens("contextBridge.exposeInMainWorld(name, {});")), [], "a non-string first argument");
  assert.deepEqual(exposedGlobals(tokens("contextBridge.exposeInMainWorld(`api`, {});")), [], "a template literal");
  assert.deepEqual(exposedGlobals(tokens('// contextBridge.exposeInMainWorld("api", {});\n/* exposeInMainWorld("b", x) */')), [], "comments");
  assert.deepEqual(exposedGlobals(tokens('foo.exposeInMainWorldX("api", {});')), []);
  assert.deepEqual(exposedGlobals(tokens('contextBridge.exposeInMainWorld("not an id", {});')), [], "not an identifier");
  assert.deepEqual(exposedGlobals(tokens('a.exposeInMainWorld("api", 1); b.exposeInMainWorld("api", 2);')), ["api"], "deduplicated");
  const many = Array.from({ length: 30 }, (_, i) => `contextBridge.exposeInMainWorld("g${i}", {});`).join("\n");
  assert.equal(exposedGlobals(tokens(many)).length, 20, "capped at 20");
});

test("mockConfig writes the alias, the shell's stubs and the globals", () => {
  assert.deepEqual(mockConfig({ kind: "react-nonweb", source: ".", uiRoot: "src/renderer", shell: "electron", globals: ["api"] }), {
    version: 1,
    kind: "react-nonweb",
    source: ".",
    aliases: { "@app": "src/renderer" },
    stubs: { electron: "src/stubs/electron.ts", "@electron/remote": "src/stubs/electron.ts" },
    globals: ["api"],
  });
  assert.deepEqual(mockConfig({ kind: "react-nonweb", source: "apps/desk", uiRoot: "apps/desk/src", shell: "tauri", globals: [] }).stubs, {
    "@tauri-apps/api": "src/stubs/tauri.ts",
  });
  const native = mockConfig({ kind: "react-nonweb", source: "apps/mobile", uiRoot: "apps/mobile/src", globals: [] });
  assert.deepEqual(native.stubs, {});
  assert.deepEqual(native.aliases, { "@app": "apps/mobile/src" });
  assert.deepEqual(mockConfig({ kind: "starter", source: null, uiRoot: null, globals: [] }), {
    version: 1,
    kind: "starter",
    source: null,
    aliases: {},
    stubs: {},
    globals: [],
  });
});
