/**
 * `.aiden/canvas.json`: a workspace's notes for design mode (spec S39).
 *
 * DM reads `apps[].root`, `apps[].script` and `apps[].designMd`. Phase 2b adds
 * the writer: it merges into `parseCanvasConfigObject`'s raw object, so fields
 * this reader doesn't know (`routes`, `params`, `url`, `mock`, anything newer)
 * survive, writes `version: 1`, and refuses to write over a file that
 * `inspectCanvasConfig` calls `invalid` or `unsupported-version`.
 *
 * Every path in the file is workspace-relative and must pass
 * `isSafeWorkspaceRelativePath` before it's used or shown.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../shared/path-containment.js";
import { readBounded } from "./app-server/app-detect.js";
import { designTarget, isSafeScriptName, type WebAppDetection } from "./app-server/app-server-core.js";

export const CANVAS_CONFIG_PATH = ".aiden/canvas.json";
export const CANVAS_CONFIG_MAX_BYTES = 65_536;
export const CANVAS_CONFIG_VERSION = 1;
const MAX_APPS = 32;
const MAX_PATH_LENGTH = 200;
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

export type CanvasConfigApp = { root: string; script?: string; designMd?: string };
export type CanvasConfig = { version: 1; apps: CanvasConfigApp[] };
export type CanvasConfigInspection =
  | { status: "ok"; config: CanvasConfig; raw: Record<string, unknown> }
  | { status: "invalid" }
  | { status: "unsupported-version"; raw: Record<string, unknown> };

/**
 * A workspace-relative POSIX path that can be shown and joined safely: exactly
 * `.`, or segments of `[A-Za-z0-9._@+-]` with no `.`, `..` or empty segment,
 * at most 200 characters. With `extension: ".md"` it must name a `.md` file.
 */
export function isSafeWorkspaceRelativePath(value: unknown, options: { extension?: ".md" } = {}): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (options.extension) {
    if (!value.endsWith(options.extension)) return false;
  } else if (value === ".") {
    return true;
  }
  return value
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file's raw object, BOM stripped; `null` for bad JSON or anything but an object. */
export function parseCanvasConfigObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parseApps(value: unknown): CanvasConfigApp[] {
  if (!Array.isArray(value)) return [];
  const apps: CanvasConfigApp[] = [];
  for (const entry of value.slice(0, MAX_APPS)) {
    if (!isRecord(entry) || !isSafeWorkspaceRelativePath(entry.root)) continue;
    const app: CanvasConfigApp = { root: entry.root };
    if (typeof entry.script === "string" && isSafeScriptName(entry.script)) app.script = entry.script;
    if (isSafeWorkspaceRelativePath(entry.designMd, { extension: ".md" })) app.designMd = entry.designMd;
    apps.push(app);
  }
  return apps;
}

/** A file with no `version`, or `version: 1`, is understood; any other version isn't. */
export function inspectCanvasConfig(text: string): CanvasConfigInspection {
  const raw = parseCanvasConfigObject(text);
  if (!raw) return { status: "invalid" };
  if ("version" in raw && raw.version !== CANVAS_CONFIG_VERSION) return { status: "unsupported-version", raw };
  return { status: "ok", config: { version: CANVAS_CONFIG_VERSION, apps: parseApps(raw.apps) }, raw };
}

/** The understood config, known fields only, or `null`. */
export function parseCanvasConfig(text: string): CanvasConfig | null {
  const inspection = inspectCanvasConfig(text);
  return inspection.status === "ok" ? inspection.config : null;
}

/**
 * Step 1 of which app roots design mode describes (R2, shared with 2b's D4):
 * the entries with a `script` whose root detection also sees as a web app, in
 * file order, each once. `[]` with no config, or one Aiden can't read. An
 * entry detection doesn't see as a web app any more is ignored rather than
 * trusted.
 */
export function configuredRoots(config: CanvasConfig | null, detected: WebAppDetection): string[] {
  const web = new Set(detected.apps.filter((app) => app.kind === "web").map((app) => app.root));
  const scripted: string[] = [];
  for (const entry of config?.apps ?? []) {
    if (entry.script && web.has(entry.root) && !scripted.includes(entry.root)) scripted.push(entry.root);
  }
  return scripted;
}

/** Which app roots design mode describes (R2): the configured roots, otherwise what detection decides. */
export function describedRoots(config: CanvasConfig | null, detected: WebAppDetection): string[] {
  const configured = configuredRoots(config, detected);
  if (configured.length > 0) return configured;
  const target = designTarget(detected);
  if (target.kind === "single") return [target.app.root];
  if (target.kind === "choose") return target.apps.map((app) => app.root);
  return ["."];
}

/** Why `.aiden/canvas.json` wasn't read, or its text. */
export type CanvasConfigText =
  | { status: "ok"; text: string }
  | { status: "missing" | "link" | "too-large" | "unreadable" };

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * The file's text, or why it wasn't read: `missing`; `link` when it or the
 * `.aiden` folder is a symlink; `too-large` over 64 KiB; `unreadable` when
 * either isn't the kind of entry it should be or the read failed. Never
 * follows a link and never blocks on a FIFO.
 */
export async function readCanvasConfigText(workspaceRoot: string): Promise<CanvasConfigText> {
  let realRoot: string;
  try {
    realRoot = await realpath(workspaceRoot);
  } catch (error) {
    return { status: isMissing(error) ? "missing" : "unreadable" };
  }
  const folder = path.join(realRoot, ".aiden");
  const file = path.join(realRoot, CANVAS_CONFIG_PATH);
  if (!isPathInside(realRoot, file)) return { status: "unreadable" };
  for (const [entry, kind] of [
    [folder, "folder"],
    [file, "file"],
  ] as const) {
    let info;
    try {
      info = await lstat(entry);
    } catch (error) {
      return { status: isMissing(error) ? "missing" : "unreadable" };
    }
    if (info.isSymbolicLink()) return { status: "link" };
    if (kind === "folder" ? !info.isDirectory() : !info.isFile()) return { status: "unreadable" };
    if (kind === "file" && info.size > CANVAS_CONFIG_MAX_BYTES) return { status: "too-large" };
  }
  // The bounded no-follow read is the last check: a swap or growth since lstat is refused.
  const text = await readBounded(file, CANVAS_CONFIG_MAX_BYTES);
  return text === null ? { status: "unreadable" } : { status: "ok", text };
}

export async function readCanvasConfig(workspaceRoot: string): Promise<CanvasConfig | null> {
  const read = await readCanvasConfigText(workspaceRoot);
  return read.status === "ok" ? parseCanvasConfig(read.text) : null;
}
