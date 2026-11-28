// Writing a design app on disk (design mode v2 Phase 3d, S107, S109, S110).
// The template is read from Aiden's own bundle, bounded and without links;
// the files are built in memory (aiden.mock.json and, for a project with
// tokens, a drafted DESIGN.md and theme.css) before anything is written; then
// each is created with O_EXCL | O_NOFOLLOW in folders made one level at a
// time, re-read to check its bytes, and removed again on any failure only
// while it still holds what was written. Nothing here contacts the network:
// the install is the caller's, after the person's Allow.

import { createHash } from "node:crypto";
import { lstat, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../../shared/path-containment.js";
import { inspectCanvasConfig, readCanvasConfigText, saveCanvasConfigApp, type CanvasConfigInspection } from "../canvas-config.js";
import { designMdDraftResultFor } from "../design-md/draft.js";
import type { DesignMdReader } from "../design-md/reader.js";
import { readWorkspacePatterns } from "./app-detect.js";
import { confinedTarget, readRegularFileBytes, writeConfinedFile, type PageFileFs } from "./app-page-files.js";
import { parsePackageJson } from "./app-server-core.js";
import { scanTsTokens } from "./app-routes-core.js";
import { confinedRoot, readRouteFile, routeFs, type RouteFs } from "./app-routes.js";
import type { MockOfferInputs } from "./app-server-main.js";
import { exposedGlobals, guessUiRoot, isMockFolder, isMockPackage, MOCK_FOLDERS, mockConfig, UI_ROOT_CANDIDATES, type MockConfigFile, type MockFolderState } from "./mock-app-core.js";
import type { DesignMockKind } from "../../../../renderer/shared/design-app.js";

export const TEMPLATE_LIMITS = Object.freeze({ files: 64, totalBytes: 1024 * 1024, fileBytes: 256 * 1024, depth: 6 });
const PACKAGE_JSON_CAP = 64 * 1024;
const FILE_MODE = 0o644;

/** Where the template is: the packaged app's resources, or the repository in development. */
export function designAppTemplateDir(runtime: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return runtime.isPackaged ? path.join(runtime.resourcesPath, "design-app-template") : path.join(runtime.appPath, "resources", "design-app-template");
}

/**
 * The template's files by folder-relative POSIX path, sorted. Regular files
 * and folders only: a link, a FIFO, more than 64 files, a file over 256 KiB
 * or 1 MiB in all refuses the whole template.
 */
export async function readTemplate(
  dir: string,
  limits: Partial<typeof TEMPLATE_LIMITS> = {},
): Promise<{ ok: true; files: Map<string, Buffer> } | { ok: false; problem: "template" }> {
  const cap = { ...TEMPLATE_LIMITS, ...limits };
  const refused = { ok: false as const, problem: "template" as const };
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return refused;
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (absolute: string, relative: string, depth: number): Promise<boolean> => {
    if (depth > cap.depth) return false;
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = path.join(absolute, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      let info;
      try {
        info = await lstat(child);
      } catch {
        return false;
      }
      if (info.isDirectory()) {
        if (!(await walk(child, rel, depth + 1))) return false;
        continue;
      }
      if (!info.isFile() || files.size >= cap.files) return false;
      const read = await readRegularFileBytes(child, cap.fileBytes);
      if (!read.ok) return false;
      total += read.bytes.length;
      if (total > cap.totalBytes) return false;
      files.set(rel, read.bytes);
    }
    return true;
  };
  if (!(await walk(root, "", 0)) || !files.has("package.json")) return refused;
  return { ok: true, files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** Each `MOCK_FOLDERS` entry: `missing`, a design app (`mock`), or anything else (`taken`). Never follows a link. */
export async function mockFolderStates(workspaceRoot: string): Promise<Map<string, MockFolderState>> {
  const states = new Map<string, MockFolderState>();
  let root: string | null = null;
  try {
    root = await realpath(workspaceRoot);
  } catch {
    root = null;
  }
  for (const folder of MOCK_FOLDERS) {
    if (!root) {
      states.set(folder, "taken");
      continue;
    }
    const absolute = path.join(root, folder);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      states.set(folder, (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "taken");
      continue;
    }
    if (!info.isDirectory()) {
      states.set(folder, "taken");
      continue;
    }
    const read = await readRegularFileBytes(path.join(absolute, "package.json"), PACKAGE_JSON_CAP);
    states.set(folder, read.ok && isMockPackage(parsePackageJson(read.bytes.toString("utf8"))) ? "mock" : "taken");
  }
  return states;
}

/** The disk facts the snapshot's offer decides from: folder states, workspace patterns and canvas.json. File reads only. */
export async function readMockInputs(workspaceRoot: string): Promise<MockOfferInputs> {
  const [folders, patterns, text] = await Promise.all([mockFolderStates(workspaceRoot), readWorkspacePatterns(workspaceRoot), readCanvasConfigText(workspaceRoot)]);
  const config: CanvasConfigInspection | null = text.status === "ok" ? inspectCanvasConfig(text.text) : text.status === "missing" ? null : { status: "invalid" };
  return { folders, patterns, config };
}

// ---- the react-nonweb first pass (S109) ----

const JSX_SCAN_ENTRIES = 400;
const PRELOAD_FILES = 8;
const PRELOAD_DEPTH = 4;
const PRELOAD_BYTES = 256 * 1024;
const PRELOAD_SCAN_ENTRIES = 2000;
const PRELOAD_NAME = /^preload[^/]*\.(?:ts|js|mjs|cjs)$/u;
const skipFolder = (name: string) => name.startsWith(".") || name.toLowerCase() === "node_modules";

/** Whether a real folder at `absolute` holds a `.tsx` or `.jsx` file within two levels, without following links. */
async function hasJsx(fs: RouteFs, absolute: string, levels: number, budget: { entries: number }): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(absolute);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (++budget.entries > JSX_SCAN_ENTRIES) return false;
    if (entry.isFile() && /\.(?:tsx|jsx)$/u.test(entry.name)) return true;
  }
  if (levels <= 1) return false;
  for (const entry of entries) {
    if (entry.isDirectory() && !skipFolder(entry.name) && (await hasJsx(fs, path.join(absolute, entry.name), levels - 1, budget))) return true;
  }
  return false;
}

async function preloadGlobals(fs: RouteFs, sourceReal: string): Promise<string[]> {
  const found: string[] = [];
  const budget = { entries: 0 };
  const walk = async (absolute: string, depth: number) => {
    if (found.length >= PRELOAD_FILES || depth > PRELOAD_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(absolute);
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (++budget.entries > PRELOAD_SCAN_ENTRIES || found.length >= PRELOAD_FILES) return;
      if (entry.isFile() && PRELOAD_NAME.test(entry.name)) found.push(path.join(absolute, entry.name));
      else if (entry.isDirectory() && !skipFolder(entry.name)) await walk(path.join(absolute, entry.name), depth + 1);
    }
  };
  await walk(sourceReal, 0);
  const globals: string[] = [];
  for (const file of found) {
    const read = await readRouteFile(file, PRELOAD_BYTES);
    const tokens = read ? scanTsTokens(read.value) : null;
    if (!tokens) continue;
    for (const name of exposedGlobals(tokens)) if (!globals.includes(name)) globals.push(name);
  }
  return globals;
}

/** aiden.mock.json for a mock of `source`: its UI folder as `@app`, the shell's stubs, and the preload's globals. */
export async function firstMockConfig(
  workspaceRoot: string,
  input: { kind: DesignMockKind; source?: string; shell?: "electron" | "tauri"; reactNative?: boolean },
  fs: RouteFs = routeFs(),
): Promise<MockConfigFile> {
  if (input.kind === "starter" || input.source === undefined) return mockConfig({ kind: "starter", source: null, uiRoot: null, globals: [] });
  const sourceReal = await confinedRoot(fs, workspaceRoot, input.source);
  const folderHasJsx = new Map<string, boolean>();
  let globals: string[] = [];
  if (sourceReal) {
    const workspaceReal = await fs.realpath(workspaceRoot);
    for (const candidate of UI_ROOT_CANDIDATES) {
      const rel = input.source === "." ? candidate : `${input.source}/${candidate}`;
      const real = await confinedRoot(fs, workspaceRoot, rel);
      folderHasJsx.set(rel, real !== null && isPathInside(workspaceReal, real) && (await hasJsx(fs, real, 2, { entries: 0 })));
    }
    if (input.shell === "electron") globals = await preloadGlobals(fs, sourceReal);
  }
  return mockConfig({
    kind: "react-nonweb",
    source: input.source,
    uiRoot: guessUiRoot(input.source, folderHasJsx),
    ...(input.reactNative ? {} : input.shell ? { shell: input.shell } : {}),
    globals,
  });
}

// ---- DESIGN.md and theme.css (S110) ----

export type MockDesignMd =
  | { designMd: "drafted"; files: { "DESIGN.md": Buffer; "src/theme.css": Buffer }; styleSources: string[] }
  | { designMd: "starter"; styleSources: string[]; reason: "no-tokens" | "lint" | "export" | "unavailable" | "timeout" };

/**
 * In memory only: a drafted DESIGN.md and its `css-vars` export, or why the
 * starter pair stays. The drafted pair is used only when it lints with no
 * errors and exports non-empty CSS, so a half-made pair is never written.
 */
export async function draftMockDesignMd(
  workspaceRoot: string,
  source: string,
  deps: { reader: Pick<DesignMdReader, "lintContent" | "exportContent">; signal?: AbortSignal },
): Promise<MockDesignMd> {
  let draft;
  try {
    draft = await designMdDraftResultFor(workspaceRoot, source, deps.signal);
  } catch {
    return { designMd: "starter", styleSources: [], reason: "unavailable" };
  }
  const styleSources = draft.sources;
  if (draft.colors + draft.fonts === 0) return { designMd: "starter", styleSources, reason: "no-tokens" };
  const failure = (status: string) => (status === "timed-out" ? "timeout" : "unavailable") as "timeout" | "unavailable";
  try {
    const lint = await deps.reader.lintContent(draft.content, deps.signal);
    if (lint.status !== "ok") return { designMd: "starter", styleSources, reason: lint.status === "too-large" ? "lint" : failure(lint.status) };
    if (lint.summary.errors > 0) return { designMd: "starter", styleSources, reason: "lint" };
    const exported = await deps.reader.exportContent(draft.content, "css-vars", deps.signal);
    if (exported.status === "timed-out" || exported.status === "busy" || exported.status === "linter-unavailable" || exported.status === "lint-failed") {
      return { designMd: "starter", styleSources, reason: failure(exported.status) };
    }
    if (exported.status !== "ok" || exported.text.trim().length === 0) return { designMd: "starter", styleSources, reason: "export" };
    return {
      designMd: "drafted",
      files: { "DESIGN.md": Buffer.from(draft.content, "utf8"), "src/theme.css": Buffer.from(exported.text, "utf8") },
      styleSources,
    };
  } catch {
    return { designMd: "starter", styleSources, reason: "export" };
  }
}

/** The template's files with main's aiden.mock.json and, when drafted, the DESIGN.md pair in place of the starter's. */
export function mockFiles(template: ReadonlyMap<string, Buffer>, config: MockConfigFile, designMd: MockDesignMd): Map<string, Buffer> {
  const files = new Map(template);
  files.set("aiden.mock.json", Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8"));
  if (designMd.designMd === "drafted") {
    files.set("DESIGN.md", designMd.files["DESIGN.md"]);
    files.set("src/theme.css", designMd.files["src/theme.css"]);
  }
  return files;
}

// ---- the write (S107) ----

export type MockWriteResult =
  | { ok: true; written: string[]; canvasConfig: "saved" | "not-saved" }
  | { ok: false; step: "write" | "verify"; kept: string[] };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A folder's parents first; `""` is the design app folder itself. */
function foldersOf(files: Iterable<string>): string[] {
  const folders = new Set<string>([""]);
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let end = 1; end <= parts.length; end++) folders.add(parts.slice(0, end).join("/"));
  }
  return [...folders].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.split("/").length - b.split("/").length || (a < b ? -1 : 1)));
}

/**
 * Writes `files` into `folder`, which must not exist yet. Every folder is made
 * by this call, one level at a time, and every file create-only, with
 * `package.json` last; then each is re-read no-follow and must hold exactly
 * what was written. Any failure, or the admission's signal (a folder-path
 * change or lost access), stops there. Aiden never deletes a file on rollback
 * (as 3c's page copies): what was written stays, named in `kept`. Because the
 * marker is written last, a folder left by a failed write is never taken for
 * a design app; it counts as taken, so the next scaffold uses the next folder.
 * Last, canvas.json gains `{root: folder, script: "dev"}`; a failure there
 * leaves the design app in place (`not-saved`), since detection finds it alone.
 */
export async function writeMockApp(
  workspaceRoot: string,
  folder: string,
  files: ReadonlyMap<string, Buffer>,
  options: {
    admission: { signal: AbortSignal };
    /** Test hooks. */
    fs?: Partial<PageFileFs>;
    afterFolder?: (folderRel: string) => Promise<void>;
    beforeVerify?: () => Promise<void>;
    saveConfig?: typeof saveCanvasConfigApp;
  },
): Promise<MockWriteResult> {
  if (!isMockFolder(folder)) throw new Error("That isn't a design app folder.");
  let workspaceReal: string;
  try {
    workspaceReal = await realpath(workspaceRoot);
  } catch {
    return { ok: false, step: "write", kept: [] };
  }
  const written: Array<{ rel: string; absolute: string; sha: string }> = [];
  const aborted = () => options.admission.signal.aborted;

  // Nothing is removed: a path checked and then removed could be the person's file by then.
  const rollback = async (step: "write" | "verify"): Promise<MockWriteResult> => ({ ok: false, step, kept: written.map((file) => file.rel).sort() });

  for (const sub of foldersOf(files.keys())) {
    if (aborted()) return rollback("write");
    const rel = sub ? `${folder}/${sub}` : folder;
    // The probe name is never created: it makes `rel` the one folder confinedTarget may create.
    const target = await confinedTarget(workspaceReal, `${rel}/.aiden-new-folder`, { create: true, ...(options.fs ? { fs: options.fs } : {}) });
    if (!target.ok || !target.createdFolder) return rollback("write");
    await options.afterFolder?.(rel);
  }
  // The marker goes last, so a partial write is never a design app.
  const ordered = [...files].sort(([a], [b]) => Number(a === "package.json") - Number(b === "package.json"));
  for (const [rel, bytes] of ordered) {
    if (aborted()) return rollback("write");
    const result = await writeConfinedFile(workspaceReal, `${folder}/${rel}`, bytes, FILE_MODE, { create: false, ...(options.fs ? { fs: options.fs } : {}) });
    if (!result.ok) return rollback("write");
    written.push({ rel, absolute: result.absolute, sha: sha256(bytes) });
  }
  await options.beforeVerify?.();
  if (aborted()) return rollback("write");
  for (const file of written) {
    const read = await readRegularFileBytes(file.absolute, TEMPLATE_LIMITS.fileBytes);
    if (!read.ok || sha256(read.bytes) !== file.sha) return rollback("verify");
  }
  let canvasConfig: "saved" | "not-saved" = "not-saved";
  try {
    canvasConfig = (await (options.saveConfig ?? saveCanvasConfigApp)(workspaceReal, { root: folder, script: "dev" })) === "saved" ? "saved" : "not-saved";
  } catch {
    canvasConfig = "not-saved";
  }
  return { ok: true, written: written.map((file) => file.rel).sort(), canvasConfig };
}

// ---- E2E only (unpackaged builds) ----

/**
 * `AIDEN_E2E_DESIGN_APP_NODE_MODULES`: an absolute folder an E2E run links in
 * as the new design app's node_modules, so its install never reaches the
 * network. A packaged build ignores it.
 */
export function e2eDesignAppNodeModules(runtime: { isPackaged: boolean; env: NodeJS.ProcessEnv }): string | undefined {
  if (runtime.isPackaged) return undefined;
  const value = runtime.env.AIDEN_E2E_DESIGN_APP_NODE_MODULES;
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) ? value : undefined;
}

/** Links `target` as `folder/node_modules`, create-only, inside the workspace's real folder. */
export async function linkDesignAppNodeModules(workspaceRoot: string, folder: string, target: string): Promise<void> {
  if (!isMockFolder(folder)) throw new Error("That isn't a design app folder.");
  const root = await realpath(workspaceRoot);
  const dir = path.join(root, folder);
  const info = await lstat(dir);
  if (!info.isDirectory() || (await realpath(dir)) !== dir) throw new Error("The design app folder moved.");
  await symlink(target, path.join(dir, "node_modules"), "dir");
}
