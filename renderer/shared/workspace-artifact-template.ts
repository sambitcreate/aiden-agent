/**
 * The command language of a workspace artifact action that takes page data.
 *
 * A template with any `{{param}}` is never handed to a shell. It is read by
 * the small grammar below, checked word by word, and run as argument lists
 * (`shell: false`) by the host, so what the checks look at is exactly what
 * runs and each value is exactly one argument. The grammar:
 *
 * - Words: unquoted plain characters, '…' (literal), "…" without `$`,
 *   backticks or a backslash other than `\"` and `\\`, and `{{param}}`
 *   placeholders, alone or joined to plain unquoted text (`HEAD:{{file}}`).
 * - Between commands: `|`, `&&`, `||`, `;` and line breaks; a `\` at the
 *   end of a line, after a space, continues it.
 * - Redirections: only `2>&1`, `>/dev/null` and `2>/dev/null`.
 *
 * Anything else (`$`, backticks, `( )`, `{ }`, `[[ ]]`, `(( ))`, `<`, other
 * `>` forms, a lone `&`, `#`, `!`, unquoted `*`, `?` and `[`, a word starting
 * with `~`, shell keywords and `NAME=value` prefixes) is refused, since it
 * would mean something to a shell that this runner does not do.
 *
 * Pure and Electron-free, like `workspace-artifacts.ts`, which uses it.
 */

export const WORKSPACE_ARTIFACT_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;
const PLACEHOLDER_AT = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/uy;
const PLACEHOLDER_TEST = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/u;

export type WorkspaceArtifactRedirect = "2>&1" | ">/dev/null" | "2>/dev/null";
export type WorkspaceArtifactConnector = ";" | "&&" | "||";

/** One command of a pipeline, as the host runs it: a program and its arguments. */
export interface WorkspaceArtifactArgvCommand {
  argv: string[];
  /** In the order written; each moves stdout or stderr as the shell would. */
  redirects: WorkspaceArtifactRedirect[];
}

/** A pipeline and how it follows the one before (the first is always `;`). */
export interface WorkspaceArtifactArgvStep {
  connector: WorkspaceArtifactConnector;
  pipeline: WorkspaceArtifactArgvCommand[];
}

/**
 * A part of a word: literal text, or a placeholder with what its value must
 * be where it sits (decided when the template is checked, tested on each run).
 */
type TemplatePart = { text: string } | TemplateParam;

interface TemplateParam {
  param: string;
  /** The word names a file the program reads, so it must stay inside the workspace. */
  file?: boolean;
  /** git reads the value as a branch or refspec (git push origin {{branch}}). */
  ref?: boolean;
  /** It comes after a literal `--`, so a value starting with "-" is not read as an option. */
  afterDashes?: boolean;
}

interface TemplateWord {
  parts: TemplatePart[];
  /** Whether any of it was quoted. */
  quoted: boolean;
}

interface TemplateCommand {
  words: TemplateWord[];
  redirects: WorkspaceArtifactRedirect[];
}

interface TemplateStep {
  connector: WorkspaceArtifactConnector;
  pipeline: TemplateCommand[];
}

export interface WorkspaceArtifactTemplateProblem {
  kind: "syntax" | "misplaced" | "program";
  reason: string;
}

type Parsed = { ok: true; steps: TemplateStep[] } | { ok: false; problem: WorkspaceArtifactTemplateProblem };

const syntax = (reason: string): Parsed => ({ ok: false, problem: { kind: "syntax", reason } });
const misplaced = (reason: string): Parsed => ({ ok: false, problem: { kind: "misplaced", reason } });

/** Unquoted characters a word may hold; `~` only inside a word (`HEAD~1`). */
const PLAIN_CHAR = /^[\p{L}\p{N}\p{M}_.,:@%+/=^~-]$/u;
const REDIRECTS: readonly WorkspaceArtifactRedirect[] = ["2>/dev/null", ">/dev/null", "2>&1"];
const BREAK = /^[ \t\n;|&]$/u;

/** What a refused character means to a shell, for the refusal message. */
function refusedCharacter(char: string): string {
  switch (char) {
    case "$": return "$ (variables, $(…) and $((…)))";
    case "`": return "backticks";
    case "(": case ")": return "( ) subshells or (( )) arithmetic";
    case "{": case "}": return "{ } command groups or brace expansion";
    case "[": case "]": return "[ ], [[ ]] or a [glob]";
    case "*": case "?": return `an unquoted ${char}, which a shell expands as a glob`;
    case "<": case ">": return "a redirection other than 2>&1, >/dev/null or 2>/dev/null";
    case "#": return "# comments";
    case "!": return "!";
    case "\\": return "a backslash outside quotes";
    case "~": return "~ at the start of a word (the home folder)";
    default: return `the character ${JSON.stringify(char)}`;
  }
}

/** Reads a template into pipelines of words, refusing anything outside the grammar. */
function parseTemplate(template: string): Parsed {
  type Token = { kind: "word"; word: TemplateWord } | { kind: "op"; op: "|" | WorkspaceArtifactConnector | "\n" } | { kind: "redirect"; redirect: WorkspaceArtifactRedirect };
  const tokens: Token[] = [];
  let word: TemplateWord | undefined;
  const begin = () => (word ??= { parts: [], quoted: false });
  const pushText = (text: string) => {
    const parts = begin().parts;
    const last = parts[parts.length - 1];
    if (last && "text" in last) last.text += text;
    else parts.push({ text });
  };
  const endWord = () => {
    if (word) tokens.push({ kind: "word", word });
    word = undefined;
  };
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]!;
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    // A line continuation after a space only wraps a long line; one inside a word would join two words a reader sees apart.
    if (char === "\\" && template[index + 1] === "\n" && !word) {
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";") {
      endWord();
      tokens.push({ kind: "op", op: char === "\n" ? "\n" : ";" });
      continue;
    }
    if (char === "|") {
      endWord();
      const double = template[index + 1] === "|";
      tokens.push({ kind: "op", op: double ? "||" : "|" });
      if (double) index += 1;
      continue;
    }
    if (char === "&") {
      endWord();
      if (template[index + 1] !== "&") return syntax("a lone & (a background job, or |&)");
      tokens.push({ kind: "op", op: "&&" });
      index += 1;
      continue;
    }
    if (!word) {
      const redirect = REDIRECTS.find((candidate) => template.startsWith(candidate, index) && BREAK.test(template[index + candidate.length] ?? " "));
      if (redirect) {
        tokens.push({ kind: "redirect", redirect });
        index += redirect.length - 1;
        continue;
      }
    }
    if (char === "{") {
      PLACEHOLDER_AT.lastIndex = index;
      const match = PLACEHOLDER_AT.exec(template);
      if (match) {
        begin().parts.push({ param: match[1]! });
        index += match[0].length - 1;
        continue;
      }
    }
    if (char === "'") {
      const close = template.indexOf("'", index + 1);
      if (close < 0) return syntax("an unclosed ' quote");
      const text = template.slice(index + 1, close);
      if (PLACEHOLDER_TEST.test(text)) return misplaced("inside single quotes");
      pushText(text);
      word!.quoted = true;
      index = close;
      continue;
    }
    if (char === '"') {
      let text = "";
      let at = index + 1;
      for (; at < template.length && template[at] !== '"'; at += 1) {
        const inner = template[at]!;
        if (inner === "$") return syntax("$ inside double quotes, which a shell expands");
        if (inner === "`") return syntax("backticks");
        if (inner === "\\") {
          const next = template[at + 1];
          if (next !== '"' && next !== "\\") return syntax("a backslash inside double quotes other than \\\" or \\\\");
          text += next;
          at += 1;
        } else text += inner;
      }
      if (at >= template.length) return syntax('an unclosed " quote');
      if (PLACEHOLDER_TEST.test(text)) return misplaced("inside double quotes");
      pushText(text);
      word!.quoted = true;
      index = at;
      continue;
    }
    if (PLAIN_CHAR.test(char) && !(char === "~" && (!word || /[=:]$/u.test(lastText(word))))) {
      pushText(char);
      continue;
    }
    return syntax(refusedCharacter(char));
  }
  endWord();

  const steps: TemplateStep[] = [];
  let connector: WorkspaceArtifactConnector = ";";
  let pipeline: TemplateCommand[] = [];
  let current: TemplateCommand = { words: [], redirects: [] };
  // What the last operator left open: a pipe or && / || needs a command after it.
  let pending: "|" | WorkspaceArtifactConnector | undefined;
  const commandEmpty = () => current.words.length === 0 && current.redirects.length === 0;
  const finishCommand = (): Parsed | undefined => {
    if (current.words.length === 0) return syntax(current.redirects.length ? "a redirection without a command" : "an empty command");
    pipeline.push(current);
    current = { words: [], redirects: [] };
    return undefined;
  };
  for (const token of tokens) {
    if (token.kind === "word") {
      current.words.push(token.word);
      pending = undefined;
    } else if (token.kind === "redirect") {
      current.redirects.push(token.redirect);
      pending = undefined;
    } else if (token.op === "\n") {
      // A line break after |, && or || continues the command; on its own it ends one.
      if (pending === "|" || pending === "&&" || pending === "||" || (commandEmpty() && pipeline.length === 0)) continue;
      const problem = finishCommand();
      if (problem) return problem;
      steps.push({ connector, pipeline });
      pipeline = [];
      connector = ";";
      pending = undefined;
    } else {
      if (commandEmpty()) return syntax(`${token.op} without a command before it`);
      const problem = finishCommand();
      if (problem) return problem;
      if (token.op !== "|") {
        steps.push({ connector, pipeline });
        pipeline = [];
        connector = token.op;
      }
      pending = token.op;
    }
  }
  if (pending === "|" || pending === "&&" || pending === "||") return syntax(`${pending} at the end, with no command after it`);
  if (!commandEmpty()) {
    const problem = finishCommand();
    if (problem) return problem;
  }
  if (pipeline.length) steps.push({ connector, pipeline });
  if (!steps.length) return syntax("an empty command");
  return { ok: true, steps };
}

function lastText(word: TemplateWord): string {
  const last = word.parts[word.parts.length - 1];
  return last && "text" in last ? last.text : "";
}

/** The word's text when it holds no placeholder. */
function literal(word: TemplateWord | undefined): string | undefined {
  if (!word) return undefined;
  let text = "";
  for (const part of word.parts) {
    if (!("text" in part)) return undefined;
    text += part.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// The programs a template with placeholders may run, and their options.

/**
 * A denylist of programs that run code can never be complete (`expect -c`,
 * `tmux new-session`, `git filter-branch --tree-filter`, `npm install` of a
 * local package all run their argument), so once a template has a
 * placeholder every command in it, piped or chained, must start with one of
 * these, written as a plain word.
 */
const ARGUMENT_TEXT_PROGRAMS = ["ls", "cat", "head", "tail", "wc", "grep", "rg", "jq", "echo", "printf", "date", "basename", "dirname", "sort", "uniq", "cut", "tr"];
const ARGUMENT_TEST_PROGRAMS = ["test", "true", "false"];
const ARGUMENT_PROGRAMS = new Set(["git", "gh", ...ARGUMENT_TEXT_PROGRAMS, ...ARGUMENT_TEST_PROGRAMS]);
/** git subcommands that take page data; `worktree` and `remote` only in the forms `GIT_SUBCOMMAND_VERBS` gives. */
const ARGUMENT_GIT_SUBCOMMANDS = [
  "status", "log", "show", "diff", "branch", "switch", "checkout", "fetch", "pull", "push", "add", "commit", "restore", "reset", "tag", "stash",
  "merge", "rebase", "cherry-pick", "revert", "worktree", "remote", "rev-parse", "grep", "blame", "ls-files", "config",
];
const GIT_SUBCOMMAND_VERBS: Record<string, readonly string[]> = { worktree: ["list", "add", "remove"], remote: ["-v", "--verbose"] };
/** git's options before the subcommand that a page may use; `-C`, `-c` and the rest change what runs or where. */
const ARGUMENT_GIT_GLOBAL_OPTIONS = new Set(["--no-pager", "-P", "--no-optional-locks"]);
/**
 * gh command groups and, for each, the verbs that take page data. `gh api` is
 * left out on purpose: `-X` sends any method and `-f`/`-F` turn a request
 * into a POST, so no set of option checks keeps it to reads; `alias`,
 * `extension` and `config` change what later gh commands run, `auth` and
 * `secret` handle credentials, and `workflow run` starts a workflow with
 * inputs of the page's choosing. A body file (`--body-file`, `-F`) is still
 * refused on every verb that has one.
 */
const ARGUMENT_GH_VERBS: Record<string, readonly string[]> = {
  pr: ["view", "list", "status", "diff", "checks", "checkout", "create", "edit", "ready", "merge", "comment", "review", "close", "reopen"],
  issue: ["view", "list", "status", "create", "edit", "comment", "close", "reopen"],
  run: ["view", "list", "watch", "rerun", "cancel"],
  repo: ["view", "list"],
  release: ["view", "list"],
  label: ["list"],
  workflow: ["view", "list"],
};
const ARGUMENT_GH_COMMANDS = ["browse", "status"];
/** A program written as a plain word: no quotes, expansions, globs or path. */
const PLAIN_PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u;
/** Words a shell reads as syntax, which this runner would run as a program instead. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "function", "select", "time", "coproc"]);
/** `NAME=value` (or `NAME[i]=`, `NAME+=`) before a command's name. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;

/** The commands a template with placeholders may run, for refusal messages. */
export const WORKSPACE_ARTIFACT_ARGUMENT_PROGRAMS =
  `git ${ARGUMENT_GIT_SUBCOMMANDS.filter((sub) => sub !== "worktree" && sub !== "remote").join(", ")}, worktree list/add/remove or remote -v ` +
  `(with only --no-pager or --no-optional-locks before the subcommand); ` +
  `${Object.entries(ARGUMENT_GH_VERBS).map(([group, verbs]) => `gh ${group} ${verbs.join("/")}`).join(", ")}, ` +
  `or gh ${ARGUMENT_GH_COMMANDS.join(" or ")}; ${[...ARGUMENT_TEXT_PROGRAMS, ...ARGUMENT_TEST_PROGRAMS].join(", ")}`;

// ---------------------------------------------------------------------------
// Options, read the way the programs read them.

/** One option as a program reads it from a word. */
interface WrittenOption {
  /** A short option's letter. */
  short?: string;
  /** A long option's name as written, lowercased; getopt_long and git take any unique prefix. */
  long?: string;
  /** Where its value would be: later in the same word, the next word, or nowhere (a letter inside a cluster). */
  value: "attached" | "next" | "none";
}

/**
 * The options one word holds, read as getopt and git's parse-options read
 * them: `--name=value`; `--name`, whose value (if it takes one) is the next
 * word; or a cluster of short letters (`-qx`), where a letter that takes a
 * value takes the rest of the word, or the next word when it comes last.
 * `valued` lists the short letters that take a value. A letter left out of
 * it only makes the checks stricter: the letters after it are then read as
 * more options rather than as its value.
 */
function readOptions(word: string, valued: string): WrittenOption[] {
  if (word === "-" || word === "--" || !word.startsWith("-")) return [];
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    return [{ long: word.slice(2, equals < 0 ? undefined : equals).toLowerCase(), value: equals < 0 ? "next" : "attached" }];
  }
  const letters = [...word.slice(1)];
  const options: WrittenOption[] = [];
  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index]!;
    if (index === letters.length - 1) options.push({ short: letter, value: "next" });
    else if (valued.includes(letter)) {
      options.push({ short: letter, value: "attached" });
      break;
    } else options.push({ short: letter, value: "none" });
  }
  return options;
}

/** A set of options: short letters, and long names that count by any prefix (`--upload-p`). */
interface OptionSet {
  short?: string;
  long?: readonly string[];
  /** Long names count only in full: gh's flag parser takes no abbreviations, so `--body` is not `--body-file`. */
  exact?: boolean;
}

function isOneOf(option: WrittenOption, set: OptionSet | undefined): boolean {
  if (!set) return false;
  if (option.short !== undefined) return set.short?.includes(option.short) === true;
  const name = option.long ?? "";
  return name.length > 0 && set.long?.some((full) => (set.exact ? full === name : full.startsWith(name))) === true;
}

/** The option whose value the next word is, when `word` ends with one that may take it. */
function optionBefore(word: string | undefined, valued: string): WrittenOption | undefined {
  if (word === undefined) return undefined;
  const options = readOptions(word, valued);
  const last = options[options.length - 1];
  return last?.value === "next" ? last : undefined;
}

/** Whether `word` holds an option from `set` in any form: alone, in a cluster, with `=value` or abbreviated. */
function writesOption(word: string | undefined, valued: string, set: OptionSet): boolean {
  return word !== undefined && readOptions(word, valued).some((option) => isOneOf(option, set));
}

/**
 * Short letters that take a value, by program, so a cluster is read to its
 * real end (`git commit -mF x` is a message "F"). git's are by subcommand.
 */
const VALUED_LETTERS: Record<string, string> = {
  sort: "koStT", uniq: "fsw", head: "nc", tail: "nc", cut: "bcdf", grep: "ABCDdefm", rg: "ABCEefgjMmrTt", jq: "L", basename: "s", date: "dfr",
};
const GIT_VALUED_LETTERS: Record<string, string> = {
  commit: "mFCct", merge: "msXF", pull: "sXoj", push: "o", fetch: "oj", rebase: "xsX", tag: "mFu", stash: "m", switch: "cC", checkout: "bB", worktree: "bB",
  config: "f", log: "n", show: "n", grep: "efABC", "cherry-pick": "mX", revert: "mX",
};
/**
 * Long options that take the next word, where telling an option's value
 * from an operand matters (which operand is a file, a pattern or a remote).
 * One left out only makes the checks stricter: its value is then read as an
 * operand.
 */
const VALUED_LONG: Record<string, readonly string[]> = {
  sort: ["key", "field-separator", "buffer-size", "parallel", "temporary-directory", "output", "compress-program", "files0-from", "random-source"],
  uniq: ["skip-fields", "skip-chars", "check-chars"],
  head: ["lines", "bytes"],
  tail: ["lines", "bytes", "pid", "sleep-interval", "max-unchanged-stats"],
  cut: ["bytes", "characters", "delimiter", "fields", "output-delimiter"],
  grep: ["regexp", "file", "max-count", "after-context", "before-context", "context", "label", "include", "exclude", "exclude-from", "exclude-dir"],
  rg: [
    "regexp", "file", "glob", "iglob", "type", "type-not", "type-add", "type-clear", "max-count", "after-context", "before-context", "context",
    "max-depth", "max-filesize", "path-separator", "pre", "pre-glob", "replace", "sort", "sortr", "threads", "encoding", "engine", "ignore-file",
    "colors", "context-separator", "field-context-separator", "field-match-separator", "max-columns", "dfa-size-limit", "regex-size-limit", "hostname-bin",
  ],
  wc: ["files0-from"],
  date: ["date", "file", "reference"],
};
const GIT_VALUED_LONG: Record<string, readonly string[]> = {
  push: ["push-option", "repo", "receive-pack", "exec"],
  fetch: ["depth", "deepen", "shallow-since", "shallow-exclude", "upload-pack", "jobs", "negotiation-tip", "server-option", "refmap", "filter", "recurse-submodules-default"],
  pull: ["depth", "deepen", "shallow-since", "shallow-exclude", "upload-pack", "jobs", "negotiation-tip", "server-option", "refmap", "filter", "strategy", "strategy-option"],
  grep: ["regexp", "file", "max-count", "after-context", "before-context", "context", "max-depth", "threads"],
};

/**
 * Options whose value names a program, code or configuration to start, by
 * program, and long options that do in any program (`--exec`, `--config`).
 */
const PROGRAM_OPTIONS: Record<string, OptionSet> = {
  sort: { long: ["compress-program"] },
  rg: { long: ["pre", "hostname-bin"] },
};
const ANY_PROGRAM_LONG: OptionSet = {
  long: ["exec", "eval", "command", "config", "upload-pack", "receive-pack", "use-compress-program", "compress-program", "rsh", "rsync-path", "proxy-command"],
};
/** Words that mark a long option as naming a program by name (`--sendmail-cmd`, `--shell`). */
const PROGRAM_OPTION_WORD = /^(?:[a-z]*cmd|[a-z]*command|program|prog|exec|execdir|execute|shell|pager|editor|askpass|hooks?|eval|rsh|script|interpreter|wrapper|config|helper)$/u;
/** git's, by subcommand; `*` applies to every subcommand. A merge strategy runs the program git-merge-<strategy>. */
const GIT_PROGRAM_OPTIONS: Record<string, OptionSet> = {
  "*": { long: ["upload-pack", "receive-pack", "exec", "config", "config-env", "exec-path"] },
  merge: { short: "s", long: ["strategy"] },
  pull: { short: "s", long: ["strategy"] },
  rebase: { short: "xs", long: ["exec", "strategy"] },
  "cherry-pick": { long: ["strategy"] },
  revert: { long: ["strategy"] },
};
/** Options whose value names a file the program writes, or reads and posts. */
const FILE_OPTIONS: Record<string, OptionSet> = {
  sort: { short: "oT", long: ["output", "temporary-directory"] },
  gh: { short: "F", long: ["body-file", "recover"], exact: true },
};
const GIT_FILE_OPTIONS: Record<string, OptionSet> = {
  config: { short: "f", long: ["file", "blob"] },
};
/** git options whose value is a file git reads into a commit, tag or the list of paths: any file, a secret included. */
const GIT_READ_FILE_OPTIONS: Record<string, OptionSet> = {
  "*": { long: ["pathspec-from-file"] },
  commit: { short: "Ft", long: ["file", "template"] },
  tag: { short: "F", long: ["file"] },
  merge: { short: "F", long: ["file"] },
};
/** Options whose value is a file the program reads, so the value must stay inside the workspace. */
const READ_FILE_OPTIONS: Record<string, OptionSet> = {
  grep: { short: "f", long: ["file", "exclude-from"] },
  rg: { short: "f", long: ["file", "ignore-file"] },
  "git grep": { short: "f", long: ["file"] },
  sort: { long: ["files0-from", "random-source"] },
  wc: { long: ["files0-from"] },
  date: { short: "fr", long: ["file", "reference"] },
};
/** Programs whose operands are files they read (grep's and rg's after the pattern). */
const FILE_OPERAND_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "grep", "rg"]);
/** The options that give grep or rg its pattern, so that every operand is a file. */
const PATTERN_OPTIONS: OptionSet = { short: "ef", long: ["regexp", "file"] };

/** Whether a long option's own name says it takes a program or code (`--sendmail-cmd`, `--shell`). */
function namesAProgram(option: WrittenOption): boolean {
  return option.long !== undefined && option.long.split("-").some((part) => PROGRAM_OPTION_WORD.test(part));
}

/** A long option that names the file a program writes (`--output`, `--out`). */
function namesAnOutputFile(option: WrittenOption): boolean {
  const name = option.long;
  return name !== undefined && name.length > 0 && (name.startsWith("output") || "output".startsWith(name));
}

/**
 * `git config` keys a text value may set: none of them names a program,
 * a hook, a pager, an editor, an alias or other configuration to include.
 */
const SAFE_GIT_CONFIG_KEY = /^(?:user\.(?:name|email)|init\.defaultbranch|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote)|fetch\.prune|color\.ui|branch\.[A-Za-z0-9._/-]+\.description)$/iu;
/** `git config` subcommand words (git 2.46) that come before the key. */
const GIT_CONFIG_VERBS = new Set(["get", "set", "unset", "list", "edit", "rename-section", "remove-section"]);
/** `git config` options that take the next word. */
const GIT_CONFIG_VALUED: OptionSet = { short: "f", long: ["file", "blob", "type", "default", "comment", "value"] };
/** Plain text a placeholder may be joined to, as in `HEAD:{{branch}}` or `{{name}}.json`. */
const JOINED_TEXT = /^[A-Za-z0-9_.,:@%+/=^~-]*$/u;

/** The `git config` key among its arguments (literal words; a placeholder counts as a key too). */
function gitConfigKey(after: readonly (string | undefined)[]): { key: string | undefined; index: number } | undefined {
  for (let index = 0; index < after.length; index += 1) {
    const arg = after[index];
    if (arg !== undefined && arg.startsWith("-")) {
      const option = optionBefore(arg, GIT_VALUED_LETTERS.config!);
      if (option && isOneOf(option, GIT_CONFIG_VALUED)) index += 1;
    } else if (arg === undefined || !GIT_CONFIG_VERBS.has(arg)) return { key: arg, index };
  }
  return undefined;
}

/**
 * Which operand the word at `at` is, reading `args` from `from` the way the
 * program would: past options and the values of those that take the next
 * word, and every word after a literal `--`. Undefined when the word is an
 * option's value.
 */
function operandIndex(args: readonly (string | undefined)[], from: number, at: number, valued: string, valuedLong: readonly string[]): number | undefined {
  let operands = 0;
  let ended = false;
  for (let index = from; index <= at; index += 1) {
    const arg = args[index];
    if (!ended && arg === "--") {
      ended = true;
      continue;
    }
    if (ended || arg === undefined || arg === "-" || !arg.startsWith("-")) {
      if (index === at) return operands;
      operands += 1;
      continue;
    }
    const option = optionBefore(arg, valued);
    const takes = option && (option.short !== undefined ? valued.includes(option.short) : valuedLong.some((full) => full.startsWith(option.long!)));
    if (takes) {
      if (index + 1 === at) return undefined;
      index += 1;
    }
  }
  return undefined;
}

/** git's subcommand and where it is, past the global options a page may use. */
function gitSubcommand(args: readonly (string | undefined)[]): { name: string | undefined; index: number } {
  let index = 0;
  while (index < args.length && ARGUMENT_GIT_GLOBAL_OPTIONS.has(args[index] ?? "")) index += 1;
  return { name: args[index], index };
}

/**
 * Whether one command may run with page data: a program from the allowlist,
 * named by a plain word, with a listed git subcommand or gh group and verb,
 * each written literally. `args` are its arguments, `undefined` where a word
 * holds a placeholder.
 */
function commandProblem(command: TemplateCommand): WorkspaceArtifactTemplateProblem | undefined {
  const [first, ...rest] = command.words;
  const program = literal(first!);
  if (program === undefined) return { kind: "misplaced", reason: "the command itself" };
  if (first!.quoted || !PLAIN_PROGRAM.test(program)) {
    if (!first!.quoted && ASSIGNMENT_WORD.test(program)) {
      return { kind: "syntax", reason: "a NAME=value prefix, which a shell reads as a variable for the command (this runner has no shell)" };
    }
    return { kind: "program", reason: `${program}, a program name with quotes, a path or other characters` };
  }
  if (SHELL_KEYWORDS.has(program)) return { kind: "syntax", reason: `${program}, a shell keyword (a command with {{params}} runs without a shell)` };
  if (!ARGUMENT_PROGRAMS.has(program)) return { kind: "program", reason: program };
  const args = rest.map(literal);
  const program_ = (reason: string): WorkspaceArtifactTemplateProblem => ({ kind: "program", reason });
  if (program === "git") {
    const { name: sub, index } = gitSubcommand(args);
    if (index >= args.length) return program_("git without a subcommand");
    if (sub === undefined) return { kind: "misplaced", reason: "the git subcommand" };
    if (sub.startsWith("-")) return program_(`git ${sub} before the subcommand`);
    if (!ARGUMENT_GIT_SUBCOMMANDS.includes(sub)) return program_(`git ${sub}`);
    const after = args.slice(index + 1);
    const verbs = GIT_SUBCOMMAND_VERBS[sub];
    if (sub === "remote" && !after.every((arg) => arg !== undefined && verbs!.includes(arg))) return program_("git remote other than git remote -v");
    if (sub === "worktree" && !(after[0] !== undefined && verbs!.includes(after[0]))) {
      return after[0] === undefined && after.length ? { kind: "misplaced", reason: "the git worktree verb" } : program_(`git worktree ${after[0] ?? ""}`.trim());
    }
    if (after.some((arg) => writesOption(arg, "", { long: ["no-index"] }))) return program_(`git ${sub} --no-index, which reads files outside the repository`);
    if (sub === "config") {
      if (after.some((arg) => arg === "edit" || writesOption(arg, GIT_VALUED_LETTERS.config!, { short: "e", long: ["edit"] }))) {
        return program_("git config edit, which opens an editor");
      }
      const key = gitConfigKey(after)?.key;
      if (key !== undefined && !SAFE_GIT_CONFIG_KEY.test(key)) return program_(`git config ${key}`);
    }
    return undefined;
  }
  if (program === "gh") {
    const [group, verb] = args;
    if (group === undefined && rest.length) return { kind: "misplaced", reason: "the gh command" };
    if (group !== undefined && ARGUMENT_GH_COMMANDS.includes(group)) return undefined;
    const verbs = group !== undefined && Object.prototype.hasOwnProperty.call(ARGUMENT_GH_VERBS, group) ? ARGUMENT_GH_VERBS[group] : undefined;
    if (group === undefined || verbs === undefined) return program_(group === "api" ? "gh api, which can send any request" : `gh ${group ?? ""}`.trim());
    if (verb === undefined && rest.length > 1) return { kind: "misplaced", reason: `the gh ${group} verb` };
    if (verb === undefined || !verbs.includes(verb)) return program_(`gh ${group} ${verb ?? ""}`.trim());
    return undefined;
  }
  // These run a program for every file they read, so a template that uses them takes no page data.
  const starts = PROGRAM_OPTIONS[program];
  const written = starts && args.find((arg) => writesOption(arg, VALUED_LETTERS[program] ?? "", starts));
  if (written) return program_(`${program} ${written}, which runs a program`);
  return undefined;
}

/** Where a placeholder sits: refused there, or what its value must be on each run. */
interface PlaceholderRules {
  problem?: string;
  file?: boolean;
  ref?: boolean;
}

/**
 * Whether the placeholder word at `at` among the command's arguments sits
 * where its value would name a program, code, a file to write or read from
 * anywhere, or a remote to connect to; and, where it may sit, what its value
 * must be (a file inside the workspace, a plain branch name).
 */
function placeholderRules(program: string, args: readonly (string | undefined)[], at: number, word: TemplateWord): PlaceholderRules {
  const git = program === "git" ? gitSubcommand(args) : undefined;
  const sub = git && at > git.index ? git.name : undefined;
  const valued = (sub === undefined ? VALUED_LETTERS[program] : GIT_VALUED_LETTERS[sub]) ?? "";
  const written = args[at - 1];
  const option = optionBefore(written, valued);
  const refuse = (problem: string): PlaceholderRules => ({ problem });
  if (option) {
    // A value that names a file to write or post could overwrite a hook or send a local secret.
    if (namesAnOutputFile(option) || (program !== "gh" && isOneOf(option, FILE_OPTIONS[program]))) return refuse(`the file ${program} ${written} writes`);
    if (program === "gh" && isOneOf(option, FILE_OPTIONS.gh)) return refuse(`the file gh ${written} reads and posts`);
    if (sub !== undefined && isOneOf(option, GIT_FILE_OPTIONS[sub])) return refuse(`the file git ${sub} ${written} writes`);
    if (sub !== undefined && (isOneOf(option, GIT_READ_FILE_OPTIONS[sub]) || isOneOf(option, GIT_READ_FILE_OPTIONS["*"]))) {
      return refuse(`the file git ${sub} ${written} reads`);
    }
    if (isOneOf(option, PROGRAM_OPTIONS[program]) || isOneOf(option, ANY_PROGRAM_LONG) || namesAProgram(option)) {
      return refuse(`the program or code ${program} ${written} names`);
    }
    if (sub !== undefined && (isOneOf(option, GIT_PROGRAM_OPTIONS[sub]) || isOneOf(option, GIT_PROGRAM_OPTIONS["*"]))) {
      return refuse(`the program git ${sub} ${written} names`);
    }
  }
  if (program === "jq") {
    // A filter can read any file (input, $__loc__, @sh) and the operands are files; page data goes in as a variable.
    const flag = args[at - 2];
    if (!((flag === "--arg" || flag === "--argjson") && written !== undefined && !written.startsWith("-"))) {
      return refuse("a jq filter or file (pass page data as --arg name {{x}} and read it as $name)");
    }
    return {};
  }
  if (sub === "config") {
    const found = gitConfigKey(args.slice(git!.index + 1));
    if (found === undefined || found.index + git!.index + 1 === at) return refuse("a git config key or option");
    if (!SAFE_GIT_CONFIG_KEY.test(found.key!)) return refuse(`a value for git config ${found.key}, which git may run or read as configuration`);
    return {};
  }
  if (sub === "worktree") {
    // `git worktree add` creates a folder at its path; only the new branch's name may come from the page.
    if (!(option && isOneOf(option, { short: "bB" }))) return refuse("the path or commit git worktree uses (write it literally; a {{param}} may follow -b or -B)");
    return {};
  }
  if (sub === "push" || sub === "fetch" || sub === "pull") {
    const from = git!.index + 1;
    const operand = operandIndex(args, from, at, valued, GIT_VALUED_LONG[sub]!);
    if (option && isOneOf(option, { long: ["repo"] })) return refuse(`the remote git ${sub} connects to`);
    if (operand === undefined) return {};
    const everyOperandIsARemote = sub !== "push" && args.slice(from).some((arg) => writesOption(arg, valued, { long: ["multiple", "all"] }));
    // The remote can be a URL or path, and some transports (ext::) run a command.
    if (operand === 0 || everyOperandIsARemote) return refuse(`the remote git ${sub} connects to (write the remote, such as origin, literally)`);
    const head = word.parts[0]!;
    if ("text" in head && head.text.startsWith(":")) return refuse(`joined after :, where git ${sub} deletes the branch it names`);
    return { ref: true };
  }
  if (sub === "diff") return { file: true };
  const kind = sub === "grep" ? "git grep" : sub === undefined ? program : undefined;
  if (kind === undefined) return {};
  if (option && isOneOf(option, READ_FILE_OPTIONS[kind])) return { file: true };
  if (!FILE_OPERAND_PROGRAMS.has(kind) && kind !== "git grep") return {};
  const from = git ? git.index + 1 : 0;
  const operand = operandIndex(args, from, at, valued, (git ? GIT_VALUED_LONG.grep : VALUED_LONG[kind]) ?? []);
  if (operand === undefined) return {};
  if (kind === "uniq" && operand >= 1) return refuse("the file uniq writes");
  const searches = kind === "grep" || kind === "rg" || kind === "git grep";
  if (searches && operand === 0 && !args.slice(from).some((arg) => writesOption(arg, valued, PATTERN_OPTIONS))) return {};
  return { file: true };
}

/** Whether a word with a placeholder is one the value may be part of: alone, or joined only to plain text. */
function joinedProblem(word: TemplateWord): string | undefined {
  if (word.parts.length === 1) return undefined;
  if (word.quoted) return "joined to quoted text";
  if (!word.parts.every((part) => !("text" in part) || JOINED_TEXT.test(part.text))) return "part of a longer word with other characters";
  const head = word.parts[0]!;
  if ("text" in head && head.text.startsWith("-")) return "joined to an option (write --body {{body}}, not --body={{body}})";
  // `+cmd` is a command to some programs, and `@file` a file to read for curl and gh.
  if ("text" in head && /^[+@]/u.test(head.text)) return "joined after + or @, which programs read as a command or a file to load";
  return undefined;
}

/**
 * Reads and checks a template that holds placeholders. Returns its pipelines
 * or what it uses that a command with page data may not.
 */
export function checkWorkspaceArtifactTemplate(template: string): { ok: true; steps: TemplateStep[] } | { ok: false; problem: WorkspaceArtifactTemplateProblem } {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return parsed;
  for (const step of parsed.steps) {
    for (const command of step.pipeline) {
      const problem = commandProblem(command);
      if (problem) return { ok: false, problem };
      const program = literal(command.words[0])!;
      const args = command.words.slice(1).map(literal);
      for (let at = 0; at < args.length; at += 1) {
        if (args[at] !== undefined) continue;
        const word = command.words[at + 1]!;
        const joined = joinedProblem(word);
        if (joined) return { ok: false, problem: { kind: "misplaced", reason: joined } };
        const rules = placeholderRules(program, args, at, word);
        if (rules.problem) return { ok: false, problem: { kind: "misplaced", reason: rules.problem } };
        const afterDashes = args.slice(0, at).includes("--");
        for (const part of word.parts) {
          if ("param" in part) Object.assign(part, { file: rules.file, ref: rules.ref, afterDashes });
        }
      }
    }
  }
  return parsed;
}

/** Whether a template holds a placeholder, and so runs without a shell. */
export function workspaceArtifactTemplateHasParams(template: string): boolean {
  return PLACEHOLDER_TEST.test(template);
}

/** Whether a path stays inside the folder it is read from: relative, not under ~, and no `..` that climbs out. */
function staysInside(path: string): boolean {
  if (/^[/\\~]/u.test(path) || /^[A-Za-z]:/u.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]/u)) {
    if (segment === "..") depth -= 1;
    else if (segment !== "" && segment !== ".") depth += 1;
    if (depth < 0) return false;
  }
  return true;
}

/**
 * Why a value may not fill its placeholder where the template puts it, or
 * undefined when every value fits: one that starts with "-" (read as an
 * option) unless it comes after a literal `--`; a branch or refspec git
 * would read as a force, a delete or a mapping; a file outside the workspace.
 */
export function workspaceArtifactValueProblem(steps: readonly TemplateStep[], value: (name: string) => string): string | undefined {
  for (const step of steps) {
    for (const command of step.pipeline) {
      for (const word of command.words) {
        let file = false;
        for (const part of word.parts) {
          if (!("param" in part)) continue;
          const text = value(part.param);
          if (text.startsWith("-") && !part.afterDashes) {
            return `${part.param} cannot start with "-": the program would read it as an option. Only a value placed after a literal -- in the command may.`;
          }
          if (part.ref && (/^[-+:]/u.test(text) || text.includes(":"))) {
            return `${part.param} cannot start with -, + or : or contain :, since git reads it as a branch or refspec there (+ forces a push, : deletes or renames a branch).`;
          }
          file ||= part.file === true;
        }
        if (file) {
          const filled = word.parts.map((part) => ("text" in part ? part.text : value(part.param))).join("");
          const param = word.parts.find((part): part is TemplateParam => "param" in part)!.param;
          if (!staysInside(filled)) return `${param} must name a file inside the workspace: no absolute path, ~, or .. that leads out of it.`;
        }
      }
    }
  }
  return undefined;
}

/** The template's commands with each placeholder replaced by its value, one argument per word. */
export function fillWorkspaceArtifactTemplate(steps: readonly TemplateStep[], value: (name: string) => string): WorkspaceArtifactArgvStep[] {
  return steps.map((step) => ({
    connector: step.connector,
    pipeline: step.pipeline.map((command) => ({
      argv: command.words.map((word) => word.parts.map((part) => ("text" in part ? part.text : value(part.param))).join("")),
      redirects: [...command.redirects],
    })),
  }));
}
