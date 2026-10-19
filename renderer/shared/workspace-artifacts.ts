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
const PLACEHOLDER_AT = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/uy;
const PLACEHOLDER_TEST = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/u;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Control characters, plus the invisible ones (zero-width, bidi overrides,
 * line separators, BOM) that could make text on an approval card read
 * differently from what runs.
 */
function hasControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
    if (
      (code >= 0x80 && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

const WORD_BREAK_AFTER = /[\s;&|)]/u;
/** Reserved words that come before a command's name without being it. */
const COMMAND_PREFIX_WORDS = new Set(["!", "coproc", "do", "elif", "else", "if", "then", "until", "while"]);
/** `NAME=value` (or `NAME[i]=`, `NAME+=`) before a command's name. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;
/** A redirection operator; one ending in `&2` or `&-` has no target word. */
const REDIRECTION = /^(?:&>>?|<<<|<>|[<>]&(?:[0-9]+-?|-)|[<>]&|>>|>\||[<>])/u;
/** Commands that run their arguments as code or as another program. */
const RUNS_ARGUMENT = new Set([
  ".",
  "arch",
  "builtin",
  "bunx",
  "busybox",
  "caffeinate",
  "chroot",
  "command",
  "doas",
  "env",
  "eval",
  "exec",
  "flock",
  "ionice",
  "nice",
  "nohup",
  "npx",
  "parallel",
  "pkexec",
  "pnpx",
  "runuser",
  "setsid",
  "sg",
  "source",
  "ssh",
  "stdbuf",
  "strace",
  "su",
  "sudo",
  "systemd-run",
  "time",
  "timeout",
  "trap",
  "unbuffer",
  "uvx",
  "watch",
  "xargs",
  "xcrun",
]);

/**
 * Programs that read some argument as code: `code` matches the options whose
 * value is code or names the code to run, `valued` the other options that take
 * the next word, and `operand` says which plain arguments are code (the first
 * for `awk '{…}' file` unless a code option gave it, or each after the first
 * for `sqlite3 db 'select …'`).
 */
interface CodeArguments {
  code: RegExp;
  valued?: RegExp;
  operand?: "first" | "after-first";
}
const SHELL_CODE: CodeArguments = { code: /^-[A-Za-z]*c$/u, valued: /^[-+][oO]$/u, operand: "first" };
const AWK_CODE: CodeArguments = { code: /^(?:-[feE]|--file|--source|--exec)$/u, valued: /^(?:-[Fv]|--field-separator|--assign)$/u, operand: "first" };
const NODE_CODE: CodeArguments = { code: /^(?:-[epr]|--eval|--print|--require|--import|--loader|--experimental-loader)$/u, operand: "first" };
const CODE_ARGUMENTS: Record<string, CodeArguments> = {
  ash: SHELL_CODE,
  bash: SHELL_CODE,
  csh: SHELL_CODE,
  dash: SHELL_CODE,
  fish: SHELL_CODE,
  ksh: SHELL_CODE,
  mksh: SHELL_CODE,
  sh: SHELL_CODE,
  tcsh: SHELL_CODE,
  zsh: SHELL_CODE,
  awk: AWK_CODE,
  gawk: AWK_CODE,
  mawk: AWK_CODE,
  nawk: AWK_CODE,
  sed: { code: /^(?:-[A-Za-z]*[ef]|--expression|--file)$/u, valued: /^(?:-l|--line-length)$/u, operand: "first" },
  gsed: { code: /^(?:-[A-Za-z]*[ef]|--expression|--file)$/u, valued: /^(?:-l|--line-length)$/u, operand: "first" },
  python: { code: /^-[A-Za-z]*[cm]$/u, valued: /^-[WX]$/u, operand: "first" },
  pypy: { code: /^-[A-Za-z]*[cm]$/u, valued: /^-[WX]$/u, operand: "first" },
  node: NODE_CODE,
  nodejs: NODE_CODE,
  bun: NODE_CODE,
  perl: { code: /^(?:-[A-Za-z]*[eE]|-[mM])$/u, valued: /^-[Ix]$/u, operand: "first" },
  ruby: { code: /^(?:-[A-Za-z]*e|-r)$/u, valued: /^-[IC]$/u, operand: "first" },
  php: { code: /^-[rBREf]$/u, operand: "first" },
  lua: { code: /^-[el]$/u, operand: "first" },
  luajit: { code: /^-[el]$/u, operand: "first" },
  osascript: { code: /^-e$/u, operand: "first" },
  R: { code: /^(?:-e|--file)$/u },
  Rscript: { code: /^-e$/u, operand: "first" },
  pwsh: { code: /^-(?:c|command|e|ec|encodedcommand|f|file)$/iu, operand: "first" },
  powershell: { code: /^-(?:c|command|e|ec|encodedcommand|f|file)$/iu, operand: "first" },
  sqlite: { code: /^-(?:cmd|init)$/u, valued: /^-(?:separator|nullvalue|newline|vfs|mmap|maxsize|lookaside|pagecache|heap)$/u, operand: "after-first" },
  psql: { code: /^(?:-c|--command|-f|--file)$/u },
  mysql: { code: /^(?:-e|--execute)$/u },
  mariadb: { code: /^(?:-e|--execute)$/u },
  git: { code: /^(?:-c|--config-env|--exec-path)$/u },
};
/** Builtins that read a word as a variable name or arithmetic; bash evaluates a name's `[subscript]`. */
const NAME_COMMANDS = new Set(["declare", "export", "getopts", "let", "local", "mapfile", "read", "readarray", "readonly", "typeset", "unset"]);
/** Builtins whose `-v` (or `wait -p`) value is a variable name. */
const NAME_OPTION_COMMANDS: Record<string, RegExp> = { printf: /^-v$/u, test: /^-[vR]$/u, "[": /^-[vR]$/u, wait: /^-[A-Za-z]*p$/u };

interface PlaceholderPlacement {
  /** Where a placeholder sits wrongly for any value. */
  misplaced?: string;
  /** A placeholder bash evaluates as arithmetic; only numbers are safe there. */
  arithmetic?: string;
}

/** A word as the shell reads it once quotes, backslashes and line continuations go. */
function unquotedWord(word: string): string {
  return word.replace(/\\\n/gu, "").replace(/["'\\]/gu, "");
}

/**
 * Judges a placeholder by the words of its simple command before it (as
 * written, without redirections): whether it would be the command itself, an
 * argument that command runs as code, or a word bash reads as a variable name
 * or arithmetic. Returns a reason for any value, `"name"` when only text
 * values are unsafe, or undefined.
 */
function placeholderCommandProblem(words: readonly string[], inArithmetic: boolean): string | "name" | undefined {
  let start = 0;
  while (start < words.length && (COMMAND_PREFIX_WORDS.has(words[start]!) || ASSIGNMENT_WORD.test(words[start]!))) start += 1;
  if (start >= words.length) return inArithmetic ? "name" : "the command itself";
  const command = unquotedWord(words[start]!);
  // A name built by expansion, a glob or braces is only known when it runs.
  if (/[$`*?{}]/u.test(command) || (command !== "[" && command.includes("["))) return "an argument to a command chosen when it runs";
  const base = command.replace(/^.*\//u, "");
  // python3.12 and lua5.4 follow python and lua's rules.
  const name = base.replace(/[0-9][0-9.]*$/u, "") || base;
  if (RUNS_ARGUMENT.has(base) || RUNS_ARGUMENT.has(name)) return `an argument to ${base}, which runs it`;
  const args = words.slice(start + 1).map(unquotedWord);
  const last = args[args.length - 1] ?? "";
  if (base === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir)$/u.test(arg))) return "an argument to find -exec, which runs it";
  const spec = CODE_ARGUMENTS[base] ?? CODE_ARGUMENTS[name];
  if (spec) {
    if (spec.code.test(last)) return `the code given to ${base} ${last}`;
    let operands = 0;
    let codeGiven = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--") {
        operands += args.length - index - 1;
        break;
      }
      if (spec.code.test(arg)) {
        codeGiven = true;
        index += 1;
      } else if (spec.valued?.test(arg)) index += 1;
      else if (!arg.startsWith("-") || arg === "-") operands += 1;
    }
    if (spec.operand === "first" && !codeGiven && operands === 0) return `the program ${base} runs`;
    if (spec.operand === "after-first" && operands >= 1) return `the code ${base} runs`;
  }
  if (inArithmetic || NAME_COMMANDS.has(base) || NAME_OPTION_COMMANDS[base]?.test(last)) return "name";
  return undefined;
}

/**
 * Each placeholder must stand alone as an unquoted argument (`gh pr merge
 * {{number}}`): never inside quotes, backticks, `$(…)`, `${…}`, a heredoc,
 * a comment or a longer word, never the command itself, and never an
 * argument a command runs as code (`eval`, `sh -c`, `python -c`, an awk
 * program). Returns where a placeholder sits wrongly, or undefined. The value
 * itself never becomes shell code (see `resolveWorkspaceArtifactCommand`);
 * this keeps each value one plain argument, as the person's confirmation
 * shows it. The list of programs that run code is the common ones, not every
 * program; under Ask each press still shows the exact command.
 */
function placeholderPlacement(template: string, isText: (name: string) => boolean): PlaceholderPlacement {
  const misplaced = (reason: string): PlaceholderPlacement => ({ misplaced: reason });
  if (!PLACEHOLDER_TEST.test(template)) return {};
  if (template.includes("AIDEN_ARG_")) return misplaced("next to AIDEN_ARG_ variables, which are reserved");
  if (/<<(?!<)/u.test(template)) return misplaced("inside a heredoc");
  type Quote = "'" | '"' | "`" | "$'" | null;
  let quote: Quote = null;
  // Open $(…), ${…}, $[…], <(…) and >(…), each with the quoting it started in.
  const expansions: { close: string; quote: Quote }[] = [];
  // Unquoted [[ … ]] and (( … )), where bash reads words as arithmetic.
  let testBrackets = false;
  let arithmeticParens = 0;
  // The words so far of the current top-level simple command, as written,
  // without redirections; where the word being read started; and whether
  // that word is a redirection's target rather than an argument.
  let words: string[] = [];
  let wordStart = -1;
  let redirectTarget = false;
  const endWord = (index: number) => {
    if (wordStart < 0) return;
    if (redirectTarget) redirectTarget = false;
    else words.push(template.slice(wordStart, index));
    wordStart = -1;
  };
  const checked = new Set<number>();
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]!;
    if (quote === "'" || quote === "$'") {
      if (quote === "$'" && char === "\\") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    const depth = expansions.length;
    const top = quote === null && depth === 0;
    if (char === "\\") {
      // A line continuation joins words; any other backslash starts or extends one.
      if (top && wordStart < 0 && template[index + 1] !== "\n") wordStart = index;
      index += 1;
      continue;
    }
    if (top && wordStart < 0 && char === "#") {
      // A comment runs to the end of its line, which then ends the command.
      const newline = template.indexOf("\n", index);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    if (template.startsWith("{{", index)) {
      PLACEHOLDER_AT.lastIndex = index;
      const match = PLACEHOLDER_AT.exec(template);
      if (match) {
        checked.add(index);
        if (quote === '"') return misplaced("inside double quotes");
        if (quote === "`") return misplaced("inside backticks");
        if (depth > 0) return misplaced("inside a $(…), ${…}, $[…] or <(…) expansion");
        const end = index + match[0].length;
        const after = end >= template.length ? " " : template[end]!;
        if (wordStart >= 0 || !WORD_BREAK_AFTER.test(after)) return misplaced("part of a longer word");
        // A redirection's target is only ever a file name (`cat > {{x}}`).
        const problem = redirectTarget ? undefined : placeholderCommandProblem(words, arithmeticParens > 0 || testBrackets);
        if (problem === "name") {
          if (isText(match[1]!)) return { arithmetic: match[1]! };
        } else if (problem !== undefined) return misplaced(problem);
        wordStart = index;
        index = end - 1;
        continue;
      }
    }
    if (top) {
      if (char === "<" || char === ">" || (char === "&" && template[index + 1] === ">")) {
        if (char !== "&" && template[index + 1] === "(") {
          // <(…) and >(…) are words whose inside is a command.
          if (wordStart < 0) wordStart = index;
          expansions.push({ close: ")", quote: null });
          index += 1;
          continue;
        }
        // An fd written against the operator (2>, {fd}>) belongs to it.
        if (wordStart >= 0 && /^(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(template.slice(wordStart, index))) wordStart = -1;
        endWord(index);
        const operator = REDIRECTION.exec(template.slice(index))![0];
        redirectTarget = !/&(?:[0-9]+-?|-)$/u.test(operator);
        index += operator.length - 1;
        continue;
      }
      const startsWord = wordStart < 0;
      // `{` and `}` group commands only as words of their own.
      const brace = (char === "{" && startsWord && /\s/u.test(template[index + 1] ?? " ")) || (char === "}" && startsWord);
      if (";&|()\n".includes(char) || brace) {
        endWord(index);
        words = [];
        redirectTarget = false;
      } else if (/\s/u.test(char)) {
        endWord(index);
        continue;
      } else if (startsWord) wordStart = index;
      if (!testBrackets && startsWord && template.startsWith("[[", index)) {
        testBrackets = true;
        wordStart = -1;
        index += 1;
        continue;
      }
      if (testBrackets && template.startsWith("]]", index)) {
        testBrackets = false;
        wordStart = -1;
        index += 1;
        continue;
      }
      if (arithmeticParens === 0 && startsWord && template.startsWith("((", index)) {
        arithmeticParens = 2;
        index += 1;
        continue;
      }
      if (arithmeticParens > 0 && (char === "(" || char === ")")) {
        arithmeticParens += char === "(" ? 1 : -1;
        continue;
      }
    }
    if (quote === null && char === "$" && template[index + 1] === "'") {
      quote = "$'";
      index += 1;
    } else if (quote === null && (char === "'" || char === '"' || char === "`")) quote = char;
    else if (quote !== null && char === quote) quote = null;
    else if ((quote === null || quote === '"') && char === "$" && "({[".includes(template[index + 1] ?? " ")) {
      expansions.push({ close: { "(": ")", "{": "}", "[": "]" }[template[index + 1] as "(" | "{" | "["], quote });
      quote = null;
      index += 1;
    } else if (quote === null && depth > 0 && char === "(") expansions.push({ close: ")", quote: null });
    else if (quote === null && depth > 0 && char === expansions[depth - 1]!.close) quote = expansions.pop()!.quote;
  }
  if (quote !== null || expansions.length !== 0) return misplaced("after an unclosed quote or expansion");
  // A placeholder the scan stepped over (say, right after a backslash) was never checked.
  for (const match of template.matchAll(PLACEHOLDER)) if (!checked.has(match.index)) return misplaced("after a backslash or other escape");
  return {};
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
    const placement = placeholderPlacement(template, (name) => params.some((param) => param.name === name && param.type === "string"));
    if (placement.misplaced) {
      return invalid(`${where}: each {{param}} must be its own unquoted word, not ${placement.misplaced}. Write gh pr comment {{number}} --body {{body}}.`);
    }
    if (placement.arithmetic) {
      return invalid(
        `${where}: {{${placement.arithmetic}}} is text, and bash evaluates text inside [[ ]], (( )), let or declare as arithmetic. Give it type "number", or compare with [ … ].`,
      );
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
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export interface ResolvedWorkspaceArtifactCommand {
  /** What runs: the values are bound to read-only variables and the template reads them as "${AIDEN_ARG_1}"… */
  command: string;
  /** The same command with each value quoted in place, for the confirmation dialog. */
  preview: string;
}

/**
 * Fills an action's template. Arguments line up with its params in order.
 * The values never become shell code: they are quoted into read-only
 * variables and the template refers to them only as "${AIDEN_ARG_N}", so even
 * a template that wraps a placeholder in quotes or `$(…)` cannot run what a
 * page passes in. Read-only, unlike "$1", means `set --`, `shift` or a shell
 * function cannot swap the value the confirmation showed for another.
 */
export function resolveWorkspaceArtifactCommand(
  action: WorkspaceArtifactActionV1,
  args: readonly unknown[],
): ResolvedWorkspaceArtifactCommand {
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
    // A leading dash would reach the command as an option (--upload-pack=…).
    if (text.startsWith("-")) invalid(`${action.label}: ${param.name} cannot start with "-".`);
    return text;
  });
  const position = new Map(action.params.map((param, index) => [param.name, index]));
  const fill = (render: (index: number) => string) =>
    action.command.replace(PLACEHOLDER, (_match, name: string) => {
      const index = position.get(name);
      if (index === undefined) return invalid(`${action.label} needs a value for ${name}.`);
      return render(index);
    });
  const variable = (index: number) => `AIDEN_ARG_${index + 1}`;
  const body = fill((index) => `"\${${variable(index)}}"`);
  const bind = values.map((value, index) => `${variable(index)}=${shellQuote(value)}`).join(" ");
  return {
    command: values.length ? `readonly ${bind}\n${body}` : body,
    preview: fill((index) => shellQuote(values[index]!)),
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
    ...actions.map((action) => ({ label: `Button “${action.label}”`, command: action.command })),
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

export function workspaceArtifactHasCommands(
  sources: readonly WorkspaceArtifactSourceV1[],
  actions: readonly WorkspaceArtifactActionV1[],
): boolean {
  return actions.length > 0 || sources.some((source) => source.kind === "shell");
}
