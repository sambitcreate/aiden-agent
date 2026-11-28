// Design apps' pure rules (design mode v2 Phase 3d, S103, S104, S109): which
// workspaces get one and which never do, the folder it goes in, the marker
// that makes a folder a design app, and main's first pass at aiden.mock.json
// for a React project that isn't a web app. No disk: `mock-app.ts` reads the
// files and feeds these.

import type { DesignMockKind, DesignMockOffer, MockRefusal } from "../../../../renderer/shared/design-app.js";
import type { CanvasConfigInspection } from "../canvas-config.js";
import { isProtectedCredentialPath } from "../../model-file-policy.js";
import { matchesWorkspacePattern, parseWorkspacePattern, type DetectedApp, type PackageJson, type WebAppDetection } from "./app-server-core.js";
import type { TsToken } from "./app-routes-core.js";

/** Where a design app may go, in order (S104). Never `design/`. */
export const MOCK_FOLDERS: readonly string[] = Object.freeze(["design-app", ...Array.from({ length: 8 }, (_, index) => `design-app-${index + 2}`)]);

const MOCK_FOLDER_SET = new Set(MOCK_FOLDERS);
export const isMockFolder = (root: string): boolean => MOCK_FOLDER_SET.has(root);

export type MockFolderState = "missing" | "mock" | "taken";

/** A package.json carries the design app marker: `"aiden": {"designApp": 1}`, exactly. */
export function isMockPackage(pkg: PackageJson | null | undefined): boolean {
  if (!pkg || typeof pkg !== "object") return false;
  const aiden = pkg.aiden;
  return aiden !== null && typeof aiden === "object" && !Array.isArray(aiden) && (aiden as Record<string, unknown>).designApp === 1;
}

/**
 * Whether the root's workspace patterns would take `folder` into the person's
 * workspace install. Conservative: an include this module can't read (`**`
 * paths, braces, deep patterns), or one starting with `*`, covers the folder
 * unless an exclude names that folder exactly.
 */
export function mockFolderCovered(folder: string, patterns: { include: readonly string[]; exclude: readonly string[] }): boolean {
  if (patterns.exclude.includes(folder)) return false;
  return patterns.include.some(
    (pattern) => pattern.startsWith("*") || parseWorkspacePattern(pattern) === null || matchesWorkspacePattern(folder, pattern),
  );
}

const REFUSING_REASONS = ["workspace-runner", "unknown-framework", "no-dev-script", "invalid-package-json"] as const;

const depth = (root: string) => (root === "." ? 0 : root.split("/").length);

/**
 * What design mode can do for a workspace (S103). In order: a truncated
 * detection, any web app or configured root that isn't a design app, an
 * existing design app, a read-only folder, a candidate whose app design mode
 * can't identify or run, an unsupported canvas.json, no free folder, workspace
 * patterns covering the folder; then React mocks for a react-nonweb root, else
 * the starter.
 */
export function mockOffer(
  detection: WebAppDetection,
  config: CanvasConfigInspection | null,
  folders: ReadonlyMap<string, MockFolderState>,
  patterns: { include: readonly string[]; exclude: readonly string[] },
  permission: string,
): DesignMockOffer {
  const refused = (why: MockRefusal, folder?: string): DesignMockOffer => (folder ? { offer: "refused", why, folder } : { offer: "refused", why });
  if (detection.truncated) return refused("truncated");
  const own = (root: string) => isMockFolder(root);
  if (detection.apps.some((candidate) => candidate.kind === "web" && !(candidate.mock && own(candidate.root)))) return refused("has-web-app");
  const configApps = config?.status === "ok" ? config.config.apps : [];
  if (configApps.some((entry) => !own(entry.root) && (entry.script !== undefined || entry.url !== undefined || entry.urlRefused))) {
    return refused("has-web-app");
  }
  const existing = MOCK_FOLDERS.find((folder) => folders.get(folder) === "mock");
  if (existing) return { offer: "existing", folder: existing };
  if (permission !== "write") return refused("read-only");
  const others = detection.apps.filter((candidate) => !own(candidate.root));
  for (const reason of REFUSING_REASONS) {
    if (others.some((candidate) => candidate.reason === reason)) return refused(reason);
  }
  if (config?.status === "unsupported-version") return refused("unsupported-config");
  // A folder nobody read counts as taken, never as free.
  const folder = MOCK_FOLDERS.find((name) => folders.get(name) === "missing");
  if (!folder) return refused("no-free-folder");
  if (mockFolderCovered(folder, patterns)) return refused("in-workspaces", folder);
  const sources = others.filter((candidate) => candidate.kind === "react-nonweb").sort((a, b) => depth(a.root) - depth(b.root) || a.root.localeCompare(b.root));
  const source = sources[0];
  if (source) return reactOffer(folder, source);
  return { offer: "starter", folder };
}

function reactOffer(folder: string, source: DetectedApp): DesignMockOffer {
  return {
    offer: "react-nonweb",
    folder,
    source: source.root,
    ...(source.desktopShell ? { shell: source.desktopShell } : {}),
    ...(source.reason === "react-native" ? { reactNative: true as const } : {}),
  };
}

// ---- main's first pass at aiden.mock.json (S109) ----

/** UI folders to try, relative to the source root, in order. */
export const UI_ROOT_CANDIDATES: readonly string[] = Object.freeze(["src/renderer", "renderer", "app/renderer", "src/web", "src/ui", "src"]);

const joinRel = (base: string, rel: string) => (base === "." ? rel : `${base}/${rel}`);

/**
 * Whether an alias may not name this workspace-relative folder: a hidden or
 * `node_modules` segment, or a path Aiden's credential rule protects. The
 * design app's vite.config.js applies the same rule again.
 */
export function aliasTargetRefused(relPath: string): boolean {
  const segments = relPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return true;
  if (segments.some((segment) => segment === ".." || segment.startsWith(".") || segment.toLowerCase() === "node_modules")) return true;
  if (isProtectedCredentialPath(relPath, "directory")) return true;
  // Every folder on the way counts too.
  for (let end = 1; end < segments.length; end++) {
    if (isProtectedCredentialPath(segments.slice(0, end).join("/"), "directory")) return true;
  }
  return false;
}

/** The folder `@app` points at: the first UI candidate with JSX within two levels that an alias may name, or null. */
export function guessUiRoot(sourceRel: string, folderHasJsx: ReadonlyMap<string, boolean>): string | null {
  for (const candidate of UI_ROOT_CANDIDATES) {
    const rel = joinRel(sourceRel, candidate);
    if (folderHasJsx.get(rel) === true && !aliasTargetRefused(rel)) return rel;
  }
  return null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const MAX_GLOBALS = 20;

/** The first string argument of each `exposeInMainWorld(` call: the globals a preload script gives the renderer. */
export function exposedGlobals(tokens: readonly TsToken[]): string[] {
  const out: string[] = [];
  for (let index = 0; index + 2 < tokens.length && out.length < MAX_GLOBALS; index++) {
    const token = tokens[index]!;
    if (token.kind !== "id" || token.value !== "exposeInMainWorld") continue;
    const open = tokens[index + 1]!;
    const name = tokens[index + 2]!;
    const after = tokens[index + 3];
    if (open.kind !== "punct" || open.value !== "(" || name.kind !== "str") continue;
    if (after && !(after.kind === "punct" && (after.value === "," || after.value === ")"))) continue;
    if (IDENTIFIER.test(name.value) && !out.includes(name.value)) out.push(name.value);
  }
  return out;
}

export type MockConfigFile = {
  version: 1;
  kind: DesignMockKind;
  source: string | null;
  aliases: Record<string, string>;
  stubs: Record<string, string>;
  globals: string[];
};

const SHELL_STUBS: Record<"electron" | "tauri", Record<string, string>> = {
  electron: { electron: "src/stubs/electron.ts", "@electron/remote": "src/stubs/electron.ts" },
  tauri: { "@tauri-apps/api": "src/stubs/tauri.ts" },
};

/** aiden.mock.json as main first writes it. React Native gets no stubs: its components don't render in React DOM. */
export function mockConfig(input: {
  kind: DesignMockKind;
  source: string | null;
  uiRoot: string | null;
  shell?: "electron" | "tauri";
  globals: readonly string[];
}): MockConfigFile {
  return {
    version: 1,
    kind: input.kind,
    source: input.source,
    aliases: input.uiRoot ? { "@app": input.uiRoot } : {},
    stubs: input.shell ? { ...SHELL_STUBS[input.shell] } : {},
    globals: input.globals.slice(0, MAX_GLOBALS),
  };
}
