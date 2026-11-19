import { isHtmlArtifactTitle } from "./generative-ui.js";
import { AIDEN_UI_LIMITS, type ChatUiVisualV1 } from "./aiden-ui/types.js";
import { isWireSafeKey, parseAidenUiState, parseChatUiVisualV1 } from "./aiden-ui/visual.js";
import {
  checkWorkspaceArtifactTemplate,
  workspaceArtifactValueProblem,
  fillWorkspaceArtifactTemplate,
  WORKSPACE_ARTIFACT_ARGUMENT_PROGRAMS,
  WORKSPACE_ARTIFACT_PLACEHOLDER,
  workspaceArtifactTemplateHasParams,
  type WorkspaceArtifactArgvStep,
} from "./workspace-artifact-template.js";

export type { WorkspaceArtifactArgvCommand, WorkspaceArtifactArgvStep, WorkspaceArtifactRedirect } from "./workspace-artifact-template.js";

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
  /** Earlier versions kept per page; the oldest is dropped first. */
  history: 5,
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
  /**
   * The state the markup declared (`<Visual state={{…}}>`), kept apart from
   * `visual.state`, which the person's own choices overwrite. Export writes
   * this, never the person's state.
   */
  initialState?: Record<string, unknown>;
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
  /** A policy denial invalidates cached good data rather than retaining it. */
  policyDenied?: true;
  at: number;
  /** The parsed value as JSON, present when `status` is ok. */
  dataJson?: string;
  error?: string;
}

/** The last read of each source; failing reads keep the last good data. */
export interface WorkspaceArtifactSnapshotV1 {
  /** Legacy file-source caches are invalidated once before being returned. */
  filePolicyVersion?: 1;
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

/** One earlier version of a page that Restore can bring back. */
export interface WorkspaceArtifactRevisionSummary {
  revision: number;
  /** When that version was replaced. */
  savedAt: number;
  /** The page's name at that time; a restore keeps the current name. */
  title: string;
  /**
   * It runs commands other than the ones allowed for the current page, so under
   * Ask a restore leaves them waiting to be allowed again.
   */
  needsApproval: boolean;
}

/**
 * What a page file would add, shown before anything is saved. Confirming
 * sends back only the token; main keeps the page itself until then.
 */
export type WorkspaceArtifactImportPreview =
  | { status: "cancelled" }
  | {
      status: "ready";
      token: string;
      title: string;
      description?: string;
      /** Every command the page can run, as the Review dialog lists them. */
      commands: { label: string; command: string }[];
      /** Workspace files its sources read. */
      files: string[];
      /**
       * When the page's sources are read by themselves: as it opens (and an
       * imported page opens at once) and on a timer. Absent when it has no
       * sources.
       */
      refresh?: { onOpen: boolean; intervalSeconds?: number };
      /** Whether any source is a command, so refreshing the page runs commands rather than only reading files. */
      shellSources: boolean;
    };

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
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Format, default-ignorable and bidi-control characters: zero-width marks, joiners, overrides, BOM. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
/**
 * The invisible characters that are part of a visible emoji: a variation
 * selector right after an emoji or keycap base ("❤️", "1️⃣"), and a joiner
 * between two emoji ("👨‍👩‍👧"). Anywhere else they hide, so they are refused.
 */
const EMOJI_PARTS = /(?<=[\p{Extended_Pictographic}#*0-9])[︎️]|(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}️]?)‍(?=\p{Extended_Pictographic})/gu;

/**
 * Whether text holds a C0 or C1 control character (other than `\n` and `\t`
 * when `allowLineBreaks`), a line or paragraph separator, or an invisible
 * character (see `INVISIBLE`) that isn't part of an emoji (see `EMOJI_PARTS`). These are refused in commands, labels, titles,
 * descriptions, file paths and button values, so text shown for review can't
 * hide characters or reorder itself. Visible look-alike letters (homoglyphs)
 * are not caught.
 */
function hasControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (allowLineBreaks && (code === 0x09 || code === 0x0a)) continue;
      return true;
    }
    if ((code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return INVISIBLE.test(value.replace(EMOJI_PARTS, ""));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isWorkspaceArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID.test(value);
}

/** A page revision number: a positive safe integer. */
export function isWorkspaceArtifactRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
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

/**
 * Refuses a source, action or param name. A well-formed name that is reserved
 * (a built-in object property, or a key Aiden's phone apps treat as private)
 * says so and offers one that is free, rather than calling it malformed.
 */
function invalidName(where: string, value: unknown, example: string): never {
  if (typeof value === "string" && value.length <= WORKSPACE_ARTIFACT_LIMITS.nameChars && NAME.test(value)) {
    const why = RESERVED_NAMES.has(value) ? "it is a built-in object property" : "Aiden's phone apps treat a key with that name as private";
    const suggestion = `my${value.charAt(0).toUpperCase()}${value.slice(1)}`;
    const free = isWorkspaceArtifactName(suggestion) ? `, so try "${suggestion}"` : ", so pick another";
    return invalid(`${where}: the name "${value}" is reserved (${why})${free}.`);
  }
  return invalid(`${where}: name must be an identifier like "${example}" (letters, digits, _; at most ${WORKSPACE_ARTIFACT_LIMITS.nameChars}).`);
}

export function isWorkspaceArtifactTitle(value: unknown): value is string {
  return isHtmlArtifactTitle(value) && value.length <= WORKSPACE_ARTIFACT_LIMITS.titleChars && !hasControlCharacter(value, false);
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
  if (hasControlCharacter(trimmed, true)) {
    return invalid(`${where}: command contains control or invisible characters (line breaks must be \\n, not \\r).`);
  }
  // Blank lines could push the rest of a command out of an approval card's view.
  if (/\n(?:[ \t]*\n){2,}/u.test(trimmed)) return invalid(`${where}: command has more than one blank line in a row.`);
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
    if (!isWorkspaceArtifactName(entry.name)) return invalidName(where, entry.name, "pulls");
    if (seen.has(entry.name)) return invalid(`${where}: the name "${entry.name}" is used twice.`);
    seen.add(entry.name);
    const parse = parseMode(entry.parse, where);
    if (entry.kind === "shell") return { name: entry.name, kind: "shell", command: command(entry.command, where), parse };
    if (entry.kind === "file") return { name: entry.name, kind: "file", file: workspaceRelativeFile(entry.file, where), parse };
    return invalid(`${where}: kind must be "shell" or "file".`);
  });
}

/** Why an action's command may not take page data as written, or undefined when it may. */
function actionPlacementProblem(template: string): string | undefined {
  if (!workspaceArtifactTemplateHasParams(template)) return undefined;
  const checked = checkWorkspaceArtifactTemplate(template);
  if (checked.ok) return undefined;
  const { kind, reason } = checked.problem;
  if (kind === "misplaced") {
    return `each {{param}} must be its own unquoted word, not ${reason}. Write gh pr comment {{number}} --body {{body}}; plain text may be joined on, as in git show HEAD:{{file}}.`;
  }
  if (kind === "syntax") return `a command with {{params}} runs without a shell, so it may not use ${reason}. ${TEMPLATE_GRAMMAR}`;
  return `page data may not be passed to a command that uses ${reason}. In a command with {{params}}, every command (piped or chained) must start with one of: ${WORKSPACE_ARTIFACT_ARGUMENT_PROGRAMS}, written as a plain word. A command without {{params}} is not limited this way (it runs in a shell, exactly as saved), so write a fixed command instead, or ask the person.`;
}

const TEMPLATE_GRAMMAR = "Put | && || ; or a line break between commands, quote text with ' or \", and use only 2>&1, >/dev/null or 2>/dev/null as redirections.";

/**
 * Why a stored action is turned off: its command no longer passes the
 * placeholder rules, which can tighten after a page was saved. A page keeps
 * such an action so nothing is lost, but it never runs until rewritten.
 */
export function workspaceArtifactActionProblem(action: Pick<WorkspaceArtifactActionV1, "command" | "params">): string | undefined {
  return actionPlacementProblem(action.command);
}

/**
 * Reads a page's actions. `stored` keeps an action whose placeholders the
 * current rules refuse (see `workspaceArtifactActionProblem`), for pages saved
 * before a rule tightened; anything a person or the model writes is strict.
 */
export function parseWorkspaceArtifactActions(value: unknown, options: { stored?: boolean } = {}): WorkspaceArtifactActionV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid("actions must be a list.");
  if (value.length > WORKSPACE_ARTIFACT_LIMITS.actions) {
    return invalid(`An artifact has at most ${WORKSPACE_ARTIFACT_LIMITS.actions} actions.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `actions[${index}]`;
    if (!isRecord(entry)) return invalid(`${where} must be an object.`);
    if (!isWorkspaceArtifactName(entry.name)) return invalidName(where, entry.name, "merge");
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
      if (!isRecord(param)) return invalid(`${at} must be an object.`);
      if (!isWorkspaceArtifactName(param.name)) return invalidName(at, param.name, "number");
      if (paramNames.has(param.name)) return invalid(`${at}: the name "${param.name}" is used twice.`);
      paramNames.add(param.name);
      const type = param.type ?? "string";
      if (type !== "string" && type !== "number") return invalid(`${at}: type must be "string" or "number".`);
      return { name: param.name, type };
    });
    const template = command(entry.command, where);
    for (const match of template.matchAll(WORKSPACE_ARTIFACT_PLACEHOLDER)) {
      if (!paramNames.has(match[1]!)) return invalid(`${where}: {{${match[1]}}} is not one of its params.`);
    }
    const problem = options.stored ? undefined : actionPlacementProblem(template);
    if (problem) return invalid(`${where}: ${problem}`);
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

/**
 * Lenient for stored files: an entry that no longer validates is dropped,
 * never repaired, except an action the placeholder rules now refuse, which
 * stays on the page turned off (`workspaceArtifactActionProblem`).
 */
export function parseWorkspaceArtifactV1(value: unknown): WorkspaceArtifactV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (!isWorkspaceArtifactId(value.id) || !isWorkspaceArtifactWorkspaceId(value.workspaceId)) return undefined;
  const visual = parseChatUiVisualV1(value.visual);
  if (!visual || visual.id !== value.id || !isWorkspaceArtifactTitle(visual.title)) return undefined;
  const sources = tryParse(() => parseWorkspaceArtifactSources(value.sources));
  const actions = tryParse(() => parseWorkspaceArtifactActions(value.actions, { stored: true }));
  const refresh = tryParse(() => parseWorkspaceArtifactRefresh(value.refresh));
  const description = tryParse(() => parseWorkspaceArtifactDescription(value.description));
  if (!sources || !actions || !refresh || (value.description !== undefined && description === undefined)) return undefined;
  const initialState = value.initialState === undefined ? undefined : parseAidenUiState(value.initialState);
  if (value.initialState !== undefined && !initialState) return undefined;
  const revision = value.revision;
  const createdAt = finiteTime(value.createdAt);
  const updatedAt = finiteTime(value.updatedAt);
  if (!isWorkspaceArtifactRevision(revision)) return undefined;
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
    ...(initialState ? { initialState } : {}),
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
  if (!isWorkspaceArtifactRevision(revision) || refreshedAt === undefined) {
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
    sources[name] = { status: entry.status, at, ...(entry.policyDenied === true ? { policyDenied: true as const } : {}), ...(dataJson !== undefined ? { dataJson } : {}), ...(error ? { error } : {}) };
  }
  return { revision, refreshedAt, sources, ...(value.filePolicyVersion === 1 ? { filePolicyVersion: 1 as const } : {}) };
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
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * What a button runs. A command without placeholders runs through the shell
 * as written; one with placeholders never does: it runs as argument lists,
 * each value exactly one argument, with the pipes and `&&`, `||`, `;` the
 * template wrote (see `workspace-artifact-template.ts`).
 */
export type ResolvedWorkspaceArtifactCommand =
  | {
      kind: "shell";
      command: string;
      /** The command as written, for the confirmation dialog. */
      preview: string;
    }
  | {
      kind: "argv";
      steps: WorkspaceArtifactArgvStep[];
      /** The template with each value shell-quoted in place, for the confirmation dialog; a shell would run it the same way. */
      preview: string;
    };

/**
 * Fills an action's template. Arguments line up with its params in order.
 * The values never become code: a template with placeholders is read by
 * Aiden's own grammar and run without a shell, so each value is one
 * argument to the program the template names and nothing else.
 */
export function resolveWorkspaceArtifactCommand(
  action: WorkspaceArtifactActionV1,
  args: readonly unknown[],
): ResolvedWorkspaceArtifactCommand {
  // Checked again here, so a stored action the rules now refuse never runs.
  const problem = workspaceArtifactActionProblem(action);
  if (problem) invalid(`${action.label} is turned off: its command no longer passes Aiden's checks (${problem}) Update the page's actions to rewrite it.`);
  if (args.length > action.params.length) invalid(`${action.label} takes ${action.params.length} value(s).`);
  const values = action.params.map((param, index) => {
    const raw = args[index];
    if (param.type === "number") {
      const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
      if (!Number.isFinite(number)) invalid(`${action.label} needs a number for ${param.name}.`);
      // "-1" would reach the command as an option, or as "every process" to kill.
      if (number < 0) invalid(`${action.label}: ${param.name} cannot be negative.`);
      return String(number);
    }
    if (typeof raw !== "string" && typeof raw !== "number") invalid(`${action.label} needs text for ${param.name}.`);
    const text = String(raw);
    if (text.length > WORKSPACE_ARTIFACT_LIMITS.argumentChars || hasControlCharacter(text, false)) {
      invalid(`${action.label}: ${param.name} is too long or contains control characters.`);
    }
    return text;
  });
  if (!workspaceArtifactTemplateHasParams(action.command)) return { kind: "shell", command: action.command, preview: action.command };
  const position = new Map(action.params.map((param, index) => [param.name, index]));
  const value = (name: string): string => {
    const index = position.get(name);
    return index === undefined ? invalid(`${action.label} needs a value for ${name}.`) : values[index]!;
  };
  const checked = checkWorkspaceArtifactTemplate(action.command);
  if (!checked.ok) return invalid(`${action.label} is turned off.`);
  // Where the value lands decides what it may be: never an option, a refspec git would force or delete with, or a file outside the workspace.
  const problem_ = workspaceArtifactValueProblem(checked.steps, value);
  if (problem_) invalid(`${action.label}: ${problem_}`);
  return {
    kind: "argv",
    steps: fillWorkspaceArtifactTemplate(checked.steps, value),
    preview: action.command.replace(WORKSPACE_ARTIFACT_PLACEHOLDER, (_match, name: string) => shellQuote(value(name))),
  };
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
  if (source.kind === "file") return permission === "none" || !hasFolder ? "blocked" : "run";
  return workspaceArtifactCommandAccess(permission, hasFolder, approved);
}

/** Shell commands, from sources or buttons: Full runs them, Ask once approved, Off never. */
export function workspaceArtifactCommandAccess(
  permission: WorkspaceArtifactPermission,
  hasFolder: boolean,
  approved: boolean,
): WorkspaceArtifactSourceAccess {
  if (permission === "none" || !hasFolder) return "blocked";
  if (permission === "full") return "run";
  return approved ? "run" : "needs-approval";
}

/** Everything the artifact can run, one entry per command, verbatim. */
export function workspaceArtifactCommandList(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): { label: string; command: string }[] {
  return [
    ...sources.flatMap((source) => (source.kind === "shell" ? [{ label: `Source ${source.name}`, command: source.command }] : [])),
    ...actions.map((action) => ({
      label: workspaceArtifactActionProblem(action) ? `Button “${action.label}” (turned off: it won’t run)` : `Button “${action.label}”`,
      command: action.command,
    })),
  ];
}

/** Text for the approval card: everything the artifact can run, verbatim. */
export function describeWorkspaceArtifactCommands(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): string {
  return workspaceArtifactCommandList(sources, actions)
    .map((entry) => `• ${entry.label}: ${entry.command}`)
    .join("\n");
}

/**
 * Whether saving these commands leaves them waiting for the person under Ask:
 * they run something, and they are not the exact set already allowed.
 */
export function workspaceArtifactCommandsNeedApproval(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
  digest: string,
  approvedDigest: string | undefined,
): boolean {
  return workspaceArtifactHasCommands(sources, actions) && digest !== approvedDigest;
}

export function workspaceArtifactHasCommands(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): boolean {
  return actions.length > 0 || sources.some((source) => source.kind === "shell");
}
