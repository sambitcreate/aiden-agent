import { isHtmlArtifactTitle } from "./generative-ui.js";
import { AIDEN_UI_LIMITS, type ChatUiVisualV1 } from "./aiden-ui/types.js";
import { isWireSafeKey, parseChatUiVisualV1 } from "./aiden-ui/visual.js";

/**
 * Workspace artifacts: persistent Aiden UI pages a workspace owns and the
 * Tools panel shows in its Artifacts tab. The page is a compiled `render_ui`
 * visual; its live data comes from named sources the host runs (a shell
 * command or a workspace file), never from code in the page.
 *
 * Pure and Electron-free: main validates tool input and stored files with it,
 * and the renderer reuses the same access and command rules for what it shows.
 */

export const WORKSPACE_ARTIFACT_TOOL_NAME = "workspace_artifact" as const;

export const WORKSPACE_ARTIFACT_LIMITS = {
  perWorkspace: 20,
  sources: 8,
  actions: 16,
  params: 8,
  nameChars: 40,
  titleChars: 80,
  labelChars: 60,
  descriptionChars: 200,
  commandChars: 2_000,
  fileChars: 1_024,
  argumentChars: 512,
  /** Raw command output or file text read for one source. */
  sourceOutputBytes: 256 * 1024,
  /** Parsed data kept for one source; the whole page shares `AIDEN_UI_LIMITS.dataBytes`. */
  sourceDataBytes: AIDEN_UI_LIMITS.dataBytes,
  errorChars: 500,
  actionOutputChars: 4_000,
  lines: 2_000,
  sourceTimeoutMs: 30_000,
  actionTimeoutMs: 120_000,
  minIntervalSeconds: 60,
  maxIntervalSeconds: 24 * 60 * 60,
} as const;

export type WorkspaceArtifactParse = "json" | "lines" | "text";
export type WorkspaceArtifactPermission = "full" | "ask" | "none";

export type WorkspaceArtifactSourceV1 =
  | { name: string; kind: "shell"; command: string; parse: WorkspaceArtifactParse }
  | { name: string; kind: "file"; file: string; parse: WorkspaceArtifactParse };

export interface WorkspaceArtifactParamV1 {
  name: string;
  type: "string" | "number";
}

/** A named command a page button can run with `run("name", …)`. */
export interface WorkspaceArtifactActionV1 {
  name: string;
  label: string;
  /** Shell template; `{{param}}` placeholders are filled with shell-quoted values. */
  command: string;
  params: WorkspaceArtifactParamV1[];
}

export interface WorkspaceArtifactRefreshV1 {
  onOpen: boolean;
  intervalSeconds?: number;
}

export interface WorkspaceArtifactV1 {
  version: 1;
  id: string;
  workspaceId: string;
  description?: string;
  /** The page: a compiled render_ui visual whose id is the artifact id. */
  visual: ChatUiVisualV1;
  sources: WorkspaceArtifactSourceV1[];
  actions: WorkspaceArtifactActionV1[];
  refresh: WorkspaceArtifactRefreshV1;
  /**
   * Digest of the sources and actions the person approved for an Ask
   * workspace. Any edit to them changes the digest, so it must be approved again.
   */
  approvedDigest?: string;
  createdByChatId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceArtifactSourceResultV1 {
  status: "ok" | "error" | "blocked";
  at: number;
  /** The parsed value as JSON, present when `status` is ok. */
  dataJson?: string;
  error?: string;
}

/** The last read of each source; failing reads keep the last good data. */
export interface WorkspaceArtifactSnapshotV1 {
  revision: number;
  refreshedAt: number;
  sources: Record<string, WorkspaceArtifactSourceResultV1>;
}

export interface WorkspaceArtifactView {
  artifact: WorkspaceArtifactV1;
  snapshot?: WorkspaceArtifactSnapshotV1;
  /** Digest of the artifact's current commands; approving sends it back unchanged. */
  digest: string;
}

export type WorkspaceArtifactChangeReason = "created" | "updated" | "deleted" | "refreshed";

export interface WorkspaceArtifactsChangedEvent {
  workspaceId: string;
  artifactId: string;
  reason: WorkspaceArtifactChangeReason;
  /** The chat whose tool call made the change, so that chat's window can reveal it. */
  chatId?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isWorkspaceArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID.test(value);
}

export function isWorkspaceArtifactWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID.test(value);
}

/** Source and action names are identifiers: `$name` in markup, `run("name")` on buttons. */
export function isWorkspaceArtifactName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= WORKSPACE_ARTIFACT_LIMITS.nameChars &&
    NAME.test(value) &&
    !RESERVED_NAMES.has(value) &&
    isWireSafeKey(value)
  );
}

export function isWorkspaceArtifactTitle(value: unknown): value is string {
  return isHtmlArtifactTitle(value) && value.length <= WORKSPACE_ARTIFACT_LIMITS.titleChars;
}

function invalid(message: string): never {
  throw new Error(message);
}

function parseMode(value: unknown, where: string): WorkspaceArtifactParse {
  if (value === undefined) return "json";
  if (value === "json" || value === "lines" || value === "text") return value;
  return invalid(`${where}: parse must be "json", "lines" or "text".`);
}

function workspaceRelativeFile(value: unknown, where: string): string {
  if (typeof value !== "string" || !value || value.length > WORKSPACE_ARTIFACT_LIMITS.fileChars) {
    return invalid(`${where}: file must be a workspace-relative path.`);
  }
  if (hasControlCharacter(value, false)) return invalid(`${where}: file contains control characters.`);
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\")) {
    return invalid(`${where}: file must be relative to the workspace folder.`);
  }
  if (value.split(/[\\/]/u).includes("..")) return invalid(`${where}: file may not leave the workspace folder.`);
  return value;
}

function command(value: unknown, where: string): string {
  if (typeof value !== "string") return invalid(`${where}: command must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > WORKSPACE_ARTIFACT_LIMITS.commandChars) {
    return invalid(`${where}: command must be 1–${WORKSPACE_ARTIFACT_LIMITS.commandChars} characters.`);
  }
  if (hasControlCharacter(trimmed, true)) return invalid(`${where}: command contains control characters.`);
  return trimmed;
}

/** Strict: tool input that breaks a rule is rejected with a message for the model. */
export function parseWorkspaceArtifactSources(value: unknown): WorkspaceArtifactSourceV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid("sources must be a list.");
  if (value.length > WORKSPACE_ARTIFACT_LIMITS.sources) {
    return invalid(`An artifact has at most ${WORKSPACE_ARTIFACT_LIMITS.sources} sources.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `sources[${index}]`;
    if (!isRecord(entry)) return invalid(`${where} must be an object.`);
    if (!isWorkspaceArtifactName(entry.name)) {
      return invalid(`${where}: name must be an identifier like "pulls" (letters, digits, _; at most ${WORKSPACE_ARTIFACT_LIMITS.nameChars}).`);
    }
    if (seen.has(entry.name)) return invalid(`${where}: the name "${entry.name}" is used twice.`);
    seen.add(entry.name);
    const parse = parseMode(entry.parse, where);
    if (entry.kind === "shell") return { name: entry.name, kind: "shell", command: command(entry.command, where), parse };
    if (entry.kind === "file") return { name: entry.name, kind: "file", file: workspaceRelativeFile(entry.file, where), parse };
    return invalid(`${where}: kind must be "shell" or "file".`);
  });
}

export function parseWorkspaceArtifactActions(value: unknown): WorkspaceArtifactActionV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid("actions must be a list.");
  if (value.length > WORKSPACE_ARTIFACT_LIMITS.actions) {
    return invalid(`An artifact has at most ${WORKSPACE_ARTIFACT_LIMITS.actions} actions.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `actions[${index}]`;
    if (!isRecord(entry)) return invalid(`${where} must be an object.`);
    if (!isWorkspaceArtifactName(entry.name)) return invalid(`${where}: name must be an identifier like "merge".`);
    if (seen.has(entry.name)) return invalid(`${where}: the name "${entry.name}" is used twice.`);
    seen.add(entry.name);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label || label.length > WORKSPACE_ARTIFACT_LIMITS.labelChars || hasControlCharacter(label, false)) {
      return invalid(`${where}: label must be 1–${WORKSPACE_ARTIFACT_LIMITS.labelChars} characters, like "Merge pull request".`);
    }
    const rawParams = entry.params ?? [];
    if (!Array.isArray(rawParams) || rawParams.length > WORKSPACE_ARTIFACT_LIMITS.params) {
      return invalid(`${where}: params must be a list of at most ${WORKSPACE_ARTIFACT_LIMITS.params}.`);
    }
    const paramNames = new Set<string>();
    const params = rawParams.map((param, paramIndex): WorkspaceArtifactParamV1 => {
      const at = `${where}.params[${paramIndex}]`;
      if (!isRecord(param) || !isWorkspaceArtifactName(param.name)) return invalid(`${at}: name must be an identifier.`);
      if (paramNames.has(param.name)) return invalid(`${at}: the name "${param.name}" is used twice.`);
      paramNames.add(param.name);
      const type = param.type ?? "string";
      if (type !== "string" && type !== "number") return invalid(`${at}: type must be "string" or "number".`);
      return { name: param.name, type };
    });
    const template = command(entry.command, where);
    for (const match of template.matchAll(PLACEHOLDER)) {
      if (!paramNames.has(match[1]!)) return invalid(`${where}: {{${match[1]}}} is not one of its params.`);
    }
    return { name: entry.name, label, command: template, params };
  });
}

export function parseWorkspaceArtifactRefresh(value: unknown): WorkspaceArtifactRefreshV1 {
  if (value === undefined) return { onOpen: true };
  if (!isRecord(value)) return invalid("refresh must be an object.");
  const onOpen = value.onOpen === undefined ? true : value.onOpen === true;
  if (value.onOpen !== undefined && typeof value.onOpen !== "boolean") return invalid("refresh.onOpen must be true or false.");
  if (value.intervalSeconds === undefined || value.intervalSeconds === null || value.intervalSeconds === 0) return { onOpen };
  const seconds = value.intervalSeconds;
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < WORKSPACE_ARTIFACT_LIMITS.minIntervalSeconds ||
    seconds > WORKSPACE_ARTIFACT_LIMITS.maxIntervalSeconds
  ) {
    return invalid(
      `refresh.intervalSeconds must be a whole number from ${WORKSPACE_ARTIFACT_LIMITS.minIntervalSeconds} to ${WORKSPACE_ARTIFACT_LIMITS.maxIntervalSeconds}.`,
    );
  }
  return { onOpen, intervalSeconds: seconds };
}

export function parseWorkspaceArtifactDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return invalid("description must be text.");
  const trimmed = value.trim();
  if (trimmed.length > WORKSPACE_ARTIFACT_LIMITS.descriptionChars || hasControlCharacter(trimmed, false)) {
    return invalid(`description must be one line of at most ${WORKSPACE_ARTIFACT_LIMITS.descriptionChars} characters.`);
  }
  return trimmed || undefined;
}

function tryParse<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Lenient for stored files: an entry that no longer validates is dropped, never repaired. */
export function parseWorkspaceArtifactV1(value: unknown): WorkspaceArtifactV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (!isWorkspaceArtifactId(value.id) || !isWorkspaceArtifactWorkspaceId(value.workspaceId)) return undefined;
  const visual = parseChatUiVisualV1(value.visual);
  if (!visual || visual.id !== value.id || !isWorkspaceArtifactTitle(visual.title)) return undefined;
  const sources = tryParse(() => parseWorkspaceArtifactSources(value.sources));
  const actions = tryParse(() => parseWorkspaceArtifactActions(value.actions));
  const refresh = tryParse(() => parseWorkspaceArtifactRefresh(value.refresh));
  const description = tryParse(() => parseWorkspaceArtifactDescription(value.description));
  if (!sources || !actions || !refresh || (value.description !== undefined && description === undefined)) return undefined;
  const revision = value.revision;
  const createdAt = finiteTime(value.createdAt);
  const updatedAt = finiteTime(value.updatedAt);
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  if (createdAt === undefined || updatedAt === undefined) return undefined;
  const approvedDigest =
    typeof value.approvedDigest === "string" && /^[a-f0-9]{64}$/u.test(value.approvedDigest) ? value.approvedDigest : undefined;
  const createdByChatId =
    typeof value.createdByChatId === "string" && value.createdByChatId.length <= 256 ? value.createdByChatId : undefined;
  return {
    version: 1,
    id: value.id,
    workspaceId: value.workspaceId,
    ...(description ? { description } : {}),
    visual,
    sources,
    actions,
    refresh,
    ...(approvedDigest ? { approvedDigest } : {}),
    ...(createdByChatId ? { createdByChatId } : {}),
    revision,
    createdAt,
    updatedAt,
  };
}

export function parseWorkspaceArtifactSnapshotV1(value: unknown): WorkspaceArtifactSnapshotV1 | undefined {
  if (!isRecord(value) || !isRecord(value.sources)) return undefined;
  const revision = value.revision;
  const refreshedAt = finiteTime(value.refreshedAt);
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || refreshedAt === undefined) {
    return undefined;
  }
  const sources: Record<string, WorkspaceArtifactSourceResultV1> = {};
  for (const [name, entry] of Object.entries(value.sources).slice(0, WORKSPACE_ARTIFACT_LIMITS.sources)) {
    if (!isWorkspaceArtifactName(name) || !isRecord(entry)) continue;
    const at = finiteTime(entry.at);
    if (at === undefined || (entry.status !== "ok" && entry.status !== "error" && entry.status !== "blocked")) continue;
    const dataJson =
      typeof entry.dataJson === "string" && byteLength(entry.dataJson) <= WORKSPACE_ARTIFACT_LIMITS.sourceDataBytes
        ? entry.dataJson
        : undefined;
    const error = typeof entry.error === "string" ? entry.error.slice(0, WORKSPACE_ARTIFACT_LIMITS.errorChars) : undefined;
    sources[name] = { status: entry.status, at, ...(dataJson !== undefined ? { dataJson } : {}), ...(error ? { error } : {}) };
  }
  return { revision, refreshedAt, sources };
}

/**
 * The page's data: its own `<Data>` bindings, then the latest good value of
 * each source by name. A source that has never succeeded binds `null`, so
 * pages can test `{$pulls == null}` for a first load.
 */
export function workspaceArtifactDataJson(
  artifact: Pick<WorkspaceArtifactV1, "visual" | "sources">,
  snapshot: WorkspaceArtifactSnapshotV1 | undefined,
): string | undefined {
  let data: Record<string, unknown> = {};
  if (artifact.visual.dataJson) {
    try {
      const parsed = JSON.parse(artifact.visual.dataJson) as unknown;
      if (isRecord(parsed)) data = { ...parsed };
    } catch {
      data = {};
    }
  }
  for (const source of artifact.sources) {
    const result = snapshot?.sources[source.name];
    let value: unknown = null;
    if (result?.dataJson !== undefined) {
      try {
        value = JSON.parse(result.dataJson) as unknown;
      } catch {
        value = null;
      }
    }
    data[source.name] = value;
  }
  const keys = Object.keys(data);
  if (keys.length === 0) return undefined;
  const serialized = JSON.stringify(data);
  // Every source fits on its own; together they still share the page's cap.
  if (byteLength(serialized) <= AIDEN_UI_LIMITS.dataBytes * (WORKSPACE_ARTIFACT_LIMITS.sources + 1)) return serialized;
  return artifact.visual.dataJson;
}

/** Turns command output or file text into the value a page reads. */
export function parseWorkspaceArtifactOutput(
  mode: WorkspaceArtifactParse,
  text: string,
): { ok: true; dataJson: string } | { ok: false; error: string } {
  let value: unknown;
  if (mode === "json") {
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: "The output is not valid JSON." };
    }
  } else if (mode === "lines") {
    value = text
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(0, WORKSPACE_ARTIFACT_LIMITS.lines);
  } else {
    value = text.trimEnd();
  }
  const dataJson = JSON.stringify(value) ?? "null";
  if (byteLength(dataJson) > WORKSPACE_ARTIFACT_LIMITS.sourceDataBytes) {
    return {
      ok: false,
      error: `The data is larger than ${WORKSPACE_ARTIFACT_LIMITS.sourceDataBytes / 1024} KiB; select fewer fields or rows.`,
    };
  }
  return { ok: true, dataJson };
}

/** POSIX single-quoting: the value is always one literal word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Fills an action's template. Arguments line up with its params in order.
 * Every value is shell-quoted, so a page can never inject shell syntax.
 */
export function resolveWorkspaceArtifactCommand(action: WorkspaceArtifactActionV1, args: readonly unknown[]): string {
  if (args.length > action.params.length) invalid(`${action.label} takes ${action.params.length} value(s).`);
  const values = new Map<string, string>();
  action.params.forEach((param, index) => {
    const raw = args[index];
    if (param.type === "number") {
      const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
      if (!Number.isFinite(number)) invalid(`${action.label} needs a number for ${param.name}.`);
      values.set(param.name, String(number));
      return;
    }
    if (typeof raw !== "string" && typeof raw !== "number") invalid(`${action.label} needs text for ${param.name}.`);
    const text = String(raw);
    if (text.length > WORKSPACE_ARTIFACT_LIMITS.argumentChars || hasControlCharacter(text, false)) {
      invalid(`${action.label}: ${param.name} is too long or contains control characters.`);
    }
    values.set(param.name, text);
  });
  return action.command.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values.get(name);
    if (value === undefined) return invalid(`${action.label} needs a value for ${name}.`);
    return shellQuote(value);
  });
}

export type WorkspaceArtifactSourceAccess = "run" | "needs-approval" | "blocked";

/**
 * Sources follow the chat's workspace access: Full runs them, Ask runs file
 * reads and runs commands only once the person approved this exact set, and
 * Off (or no folder) runs nothing.
 */
export function workspaceArtifactSourceAccess(
  permission: WorkspaceArtifactPermission,
  hasFolder: boolean,
  source: WorkspaceArtifactSourceV1,
  approved: boolean,
): WorkspaceArtifactSourceAccess {
  if (permission === "none" || !hasFolder) return "blocked";
  if (permission === "full" || source.kind === "file") return "run";
  return approved ? "run" : "needs-approval";
}

/** Text for the approval card: everything the artifact can run, verbatim. */
export function describeWorkspaceArtifactCommands(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): string {
  const lines: string[] = [];
  for (const source of sources) if (source.kind === "shell") lines.push(`• ${source.name}: ${source.command}`);
  for (const action of actions) lines.push(`• ${action.label} (button): ${action.command}`);
  return lines.join("\n");
}

export function workspaceArtifactHasCommands(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): boolean {
  return actions.length > 0 || sources.some((source) => source.kind === "shell");
}
