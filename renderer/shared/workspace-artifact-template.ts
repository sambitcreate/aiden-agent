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

import { ghSlotSpec, gitSlotSpec, jqSlot, locateSlot, programSlotSpec, revisionsEnd, type Slot, type SlotLookup } from "./workspace-artifact-slots.js";

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
  /**
   * Indices into `argv` of arguments filled from a workspace-file slot. The
   * text was checked to stay inside the workspace; the runner also checks
   * each one's real path, through symbolic links, just before the command runs.
   */
  paths?: number[];
  /**
   * Variables set for this command on top of the host's environment. Every
   * git command gets `GIT_LITERAL_PATHSPECS=1`, so git reads no pathspec
   * magic (`:/`, `:(top)`) or glob, from a value or the template.
   */
  env?: Record<string, string>;
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
type TemplatePart = TemplateText | TemplateParam;

interface TemplateText {
  text: string;
  /** Where unquoted text starts in the template, for the preview. */
  at?: number;
  /** Text the checked plan adds that the template does not hold (`./` after `HEAD:`), and where the preview shows it. */
  insertedAt?: number;
}

interface TemplateParam {
  param: string;
  /** The slot it sits in, from the program's table; set when the template is checked. */
  slot?: Slot;
}

interface TemplateWord {
  parts: TemplatePart[];
  /** Whether any of it was quoted. */
  quoted: boolean;
  /** Where it starts and ends in the template, for the preview. */
  start: number;
  end: number;
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
  /** `slot`: the program's table has no slot for page data where it sits. */
  kind: "syntax" | "misplaced" | "program" | "slot";
  reason: string;
}

type Parsed = { ok: true; steps: TemplateStep[] } | { ok: false; problem: WorkspaceArtifactTemplateProblem };

const syntax = (reason: string): Parsed => ({ ok: false, problem: { kind: "syntax", reason } });
const misplaced = (reason: string): Parsed => ({ ok: false, problem: { kind: "misplaced", reason } });
const PLACEHOLDER_NAME = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u;

/** A placeholder inside quotes: the quotes are not needed, since the value is one argument already. */
function quotedPlaceholder(text: string, quotes: string): Parsed {
  const name = PLACEHOLDER_NAME.exec(text)![1]!;
  return misplaced(`{{${name}}} cannot sit inside ${quotes} quotes. Leave the quotes off: each value is passed as exactly one argument, spaces and all (echo {{${name}}}).`);
}

/** The first placeholder a word holds, written back as `{{name}}` for messages. */
function placeholderIn(word: TemplateWord): string {
  const part = word.parts.find((entry) => "param" in entry);
  return part && "param" in part ? `{{${part.param}}}` : "{{param}}";
}

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
  const begin = (at: number) => (word ??= { parts: [], quoted: false, start: at, end: at });
  const pushText = (text: string, at: number, quoted: boolean) => {
    const parts = begin(at).parts;
    const last = parts[parts.length - 1];
    if (last && "text" in last) {
      last.text += text;
      // Quoted text moves the offsets, so the part no longer maps onto the template.
      if (quoted) delete last.at;
    } else parts.push(quoted ? { text } : { text, at });
  };
  const endWord = (at: number) => {
    if (word) {
      word.end = at;
      tokens.push({ kind: "word", word });
    }
    word = undefined;
  };
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]!;
    if (char === " " || char === "\t") {
      endWord(index);
      continue;
    }
    // A line continuation after a space only wraps a long line; one inside a word would join two words a reader sees apart.
    if (char === "\\" && template[index + 1] === "\n" && !word) {
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";") {
      endWord(index);
      tokens.push({ kind: "op", op: char === "\n" ? "\n" : ";" });
      continue;
    }
    if (char === "|") {
      endWord(index);
      const double = template[index + 1] === "|";
      tokens.push({ kind: "op", op: double ? "||" : "|" });
      if (double) index += 1;
      continue;
    }
    if (char === "&") {
      endWord(index);
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
        begin(index).parts.push({ param: match[1]! });
        index += match[0].length - 1;
        continue;
      }
    }
    if (char === "'") {
      const close = template.indexOf("'", index + 1);
      if (close < 0) return syntax("an unclosed ' quote");
      const text = template.slice(index + 1, close);
      if (PLACEHOLDER_TEST.test(text)) return quotedPlaceholder(text, "single");
      pushText(text, index, true);
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
      if (PLACEHOLDER_TEST.test(text)) return quotedPlaceholder(text, "double");
      pushText(text, index, true);
      word!.quoted = true;
      index = at;
      continue;
    }
    if (PLAIN_CHAR.test(char) && !(char === "~" && (!word || /[=:]$/u.test(lastText(word))))) {
      pushText(char, index, false);
      continue;
    }
    return syntax(refusedCharacter(char));
  }
  endWord(template.length);

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
 * Options whose value names a program to run for every file read; a template
 * that uses them takes no page data at all.
 */
const PROGRAM_OPTIONS: Record<string, OptionSet> = {
  sort: { long: ["compress-program"] },
  rg: { long: ["pre", "hostname-bin"] },
};

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
      const option = optionBefore(arg, "f");
      if (option && isOneOf(option, GIT_CONFIG_VALUED)) index += 1;
    } else if (arg === undefined || !GIT_CONFIG_VERBS.has(arg)) return { key: arg, index };
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
  const misplacedAs = (word: TemplateWord, what: string, fix: string): WorkspaceArtifactTemplateProblem => {
    const name = placeholderIn(word);
    return { kind: "misplaced", reason: `${name} cannot be ${what}. ${fix.replace(/\{\{x\}\}/gu, name)}` };
  };
  if (program === undefined) return misplacedAs(first!, "the command itself", "Write the program literally; page data may only be its arguments, as in gh pr view {{x}}.");
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
    if (sub === undefined) return misplacedAs(rest[index]!, "the git subcommand", "Write the subcommand literally, as in git show {{x}}.");
    if (sub.startsWith("-")) return program_(`git ${sub} before the subcommand`);
    if (!ARGUMENT_GIT_SUBCOMMANDS.includes(sub)) return program_(`git ${sub}`);
    const after = args.slice(index + 1);
    const verbs = GIT_SUBCOMMAND_VERBS[sub];
    if (sub === "remote" && !after.every((arg) => arg !== undefined && verbs!.includes(arg))) return program_("git remote other than git remote -v");
    if (sub === "worktree" && !(after[0] !== undefined && verbs!.includes(after[0]))) {
      return after[0] === undefined && after.length
        ? misplacedAs(rest[index + 1]!, "the git worktree verb", "Write list, add or remove literally, as in git worktree add -b {{x}} ../review.")
        : program_(`git worktree ${after[0] ?? ""}`.trim());
    }
    if (after.some((arg) => writesOption(arg, "", { long: ["no-index"] }))) return program_(`git ${sub} --no-index, which reads files outside the repository`);
    if (sub === "config") {
      if (after.some((arg) => arg === "edit" || writesOption(arg, "f", { short: "e", long: ["edit"] }))) {
        return program_("git config edit, which opens an editor");
      }
      const key = gitConfigKey(after)?.key;
      if (key !== undefined && !SAFE_GIT_CONFIG_KEY.test(key)) return program_(`git config ${key}`);
    }
    return undefined;
  }
  if (program === "gh") {
    const [group, verb] = args;
    if (group === undefined && rest.length) return misplacedAs(rest[0]!, "the gh command", "Write the command and its verb literally, as in gh pr view {{x}}.");
    if (group !== undefined && ARGUMENT_GH_COMMANDS.includes(group)) return undefined;
    const verbs = group !== undefined && Object.prototype.hasOwnProperty.call(ARGUMENT_GH_VERBS, group) ? ARGUMENT_GH_VERBS[group] : undefined;
    if (group === undefined || verbs === undefined) return program_(group === "api" ? "gh api, which can send any request" : `gh ${group ?? ""}`.trim());
    if (verb === undefined && rest.length > 1) return misplacedAs(rest[1]!, `the gh ${group} verb`, `Write the verb literally, as in gh ${group} ${verbs[0]} {{x}}.`);
    if (verb === undefined || !verbs.includes(verb)) return program_(`gh ${group} ${verb ?? ""}`.trim());
    return undefined;
  }
  // These run a program for every file they read, so a template that uses them takes no page data.
  const starts = PROGRAM_OPTIONS[program];
  const written = starts && args.find((arg) => writesOption(arg, "", starts));
  if (written) return program_(`${program} ${written}, which runs a program`);
  return undefined;
}

/**
 * The slot the placeholder word at `at` among the command's arguments sits
 * in, from the program's table (`workspace-artifact-slots.ts`), or where it
 * sits when the table has no slot there, with the forms it does take.
 */
function placeholderSlot(program: string, args: readonly (string | undefined)[], at: number, word: TemplateWord): SlotLookup {
  if (program === "jq") return jqSlot(args, at);
  if (program === "gh") {
    const [group, verb] = args;
    const alone = ARGUMENT_GH_COMMANDS.includes(group!);
    const spec = ghSlotSpec(alone ? group! : `${group!} ${verb!}`)!;
    return locateSlot(spec, args, alone ? 1 : 2, at);
  }
  if (program === "git") {
    const git = gitSubcommand(args);
    const sub = git.name!;
    if (sub === "config") {
      const found = gitConfigKey(args.slice(git.index + 1));
      const value = found && found.key !== undefined ? found.index + git.index + 2 : undefined;
      if (value !== at) return { problem: "as a git config key, option or option value. git config takes page data only as the value right after a key written literally (git config user.name {{name}})." };
      if (!SAFE_GIT_CONFIG_KEY.test(found!.key!)) return { problem: `as a value for git config ${found!.key!}, which git may run or read as configuration.` };
      return { slot: { rule: "text" } };
    }
    const found = locateSlot(gitSlotSpec(sub)!, args, git.index + 1, at);
    const head = word.parts[0]!;
    if ("slot" in found && (sub === "push" || sub === "fetch" || sub === "pull") && "text" in head && head.text.startsWith(":")) {
      return { problem: `joined after :, where git ${sub} deletes the branch it names` };
    }
    return found;
  }
  return locateSlot(programSlotSpec(program)!, args, 0, at);
}

/**
 * Whether a word with a placeholder is one the value may be part of: alone,
 * or joined only to plain text. `program` and `before` (the word before it,
 * undefined when it holds a placeholder) only shape the advice.
 */
function joinedProblem(word: TemplateWord, program: string, before: string | undefined): string | undefined {
  if (word.parts.length === 1) return undefined;
  const name = placeholderIn(word);
  if (word.quoted) return `${name} cannot be joined to quoted text. Join it only to plain unquoted text, as in git show HEAD:${name}, or make it a word of its own.`;
  if (!word.parts.every((part) => !("text" in part) || JOINED_TEXT.test(part.text))) {
    return `${name} cannot be part of a word with characters other than letters, digits and _ . , : @ % + / = ^ ~ -. Join it only to such plain text, as in git show HEAD:${name}.`;
  }
  const head = word.parts[0]!;
  if ("text" in head && head.text === "-") {
    return `${name} cannot follow a bare -, where the program would read the value as options. The number needs its option as a separate word, for example -n ${name}.`;
  }
  if ("text" in head && head.text.startsWith("-")) {
    const option = head.text.split("=")[0]!;
    return `${name} cannot be joined to the option ${option}. Pass it as a separate word: ${option} ${name}.`;
  }
  if (program === "tail" && "text" in head && head.text === "+" && before !== undefined && /^(?:-n|--lines|-c|--bytes)$/u.test(before)) {
    const unit = before === "-n" || before === "--lines" ? "line" : "byte";
    return `${name} cannot follow + there: use ${before} ${name} (last N ${unit}s); starting from ${unit} N with page data is not supported.`;
  }
  // `+cmd` is a command to some programs, and `@file` a file to read for curl and gh.
  if ("text" in head && /^[+@]/u.test(head.text)) {
    return `${name} cannot follow ${head.text[0]}, which programs read as a command or a file to load. Make it a word of its own.`;
  }
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
        const joined = joinedProblem(word, program, at > 0 ? args[at - 1] : undefined);
        if (joined) return { ok: false, problem: { kind: "misplaced", reason: joined } };
        const found = placeholderSlot(program, args, at, word);
        if ("problem" in found) return { ok: false, problem: { kind: "slot", reason: found.problem } };
        for (const part of word.parts) {
          if ("param" in part) part.slot = found.slot;
        }
        const blob = program === "git" ? readBlobPath(word, gitSubcommand(args).name!) : undefined;
        if (blob) return { ok: false, problem: { kind: "slot", reason: blob } };
      }
      const ended = args.includes("--") ? undefined : endRefs(command);
      if (ended) return { ok: false, problem: { kind: "misplaced", reason: ended } };
    }
  }
  return parsed;
}

/**
 * Adds `--` after a `refOnly` value (`git checkout {{branch}}`) when the
 * template has none. Without it git falls back to reading a value that names
 * no branch as files, and `git checkout notes.md` discards that file's edits;
 * with it git reads the value only as a branch and says it is not one. The
 * `--` goes before the first file operand after the value, or at the end of
 * the command, so options written after the value stay options.
 */
function endRefs(command: TemplateCommand): string | undefined {
  let last = -1;
  command.words.forEach((word, index) => {
    if (word.parts.some((part) => "param" in part && part.slot?.refOnly)) last = index;
  });
  if (last < 0 || literal(command.words[0]) !== "git") return undefined;
  const args = command.words.slice(1).map(literal);
  const git = gitSubcommand(args);
  const end = revisionsEnd(gitSlotSpec(git.name!)!, args, git.index + 1, last - 1);
  const name = placeholderIn(command.words[last]!);
  if (end.optionAfter !== undefined) {
    return `${end.optionAfter} is written after the files of git ${git.name!}. Aiden adds -- before the files so git reads ${name} only as a revision, and git would then read ${end.optionAfter} as a file. Write ${end.optionAfter} before ${name}.`;
  }
  const at = command.words[end.at]!.end;
  command.words.splice(end.at + 1, 0, { parts: [{ text: "--", insertedAt: at }], quoted: false, start: at, end: at });
  return undefined;
}

/**
 * `REV:{{file}}` in git names a file in a commit, and git reads that path
 * from the repository root, not the folder it runs in. In a workspace that
 * is a folder inside a repository, the value would reach the rest of the
 * repository. A placeholder after the first `:` of a revision or file
 * operand becomes a `blob` path, and the plan adds `./` after the `:`, so
 * git reads the path from the workspace; the value then must stay inside it.
 * An index path `:N:{{file}}` (stage 0 to 3) gets the `./` after its stage:
 * git reads `:./0:f` as a path named `0:f`.
 */
function readBlobPath(word: TemplateWord, sub: string): string | undefined {
  if (sub === "push" || sub === "fetch" || sub === "pull") return undefined;
  const colon = word.parts.findIndex((part) => "text" in part && part.text.includes(":"));
  if (colon < 0 || !word.parts.slice(colon + 1).some((part) => "param" in part)) return undefined;
  const head = word.parts.find((part): part is TemplateParam => "param" in part)!;
  if (head.slot?.rule !== "rev" && head.slot?.rule !== "path") return undefined;
  const part = word.parts[colon] as TemplateText;
  if (part.at === undefined) return "write the REV: before a file placeholder without quotes or backslashes, as in git show HEAD:{{file}}";
  // Before the `:` is the revision, after it the file.
  word.parts.forEach((later, index) => {
    if ("param" in later) later.slot = index > colon ? { rule: "path", blob: true } : { rule: "rev" };
  });
  const split = blobStart(part.text, colon === 0);
  const rest = part.text.slice(split);
  if (rest.startsWith("./")) return undefined;
  const inserted: TemplateText[] = [{ text: part.text.slice(0, split), at: part.at }, { text: "./", insertedAt: part.at! + split }];
  if (rest) inserted.push({ text: rest, at: part.at! + split });
  word.parts.splice(colon, 1, ...inserted);
  return undefined;
}

/** Where the path starts in a `REV:path` or `:N:path` word: after the first `:`, or after a leading index stage. */
function blobStart(text: string, wordStart: boolean): number {
  const stage = wordStart ? /^:[0-3]:/u.exec(text) : null;
  return stage ? stage[0].length : text.indexOf(":") + 1;
}

/** What `staysInside` refuses, as a refusal says it. */
const OUTSIDE_PATHS = "no absolute path, drive letter (C:), home folder (~ or ~/…), or .. that leads out of it";

/** Whether a template holds a placeholder, and so runs without a shell. */
export function workspaceArtifactTemplateHasParams(template: string): boolean {
  return PLACEHOLDER_TEST.test(template);
}

/**
 * Whether a path stays inside the folder it is read from: relative, with no
 * drive letter, not the home folder (`~` or `~/…`), and no `..` that climbs
 * out. `~notes.md` is a file name: nothing expands it without a shell.
 */
function staysInside(path: string): boolean {
  if (/^[/\\]/u.test(path) || /^~(?:[/\\]|$)/u.test(path) || /^[A-Za-z]:/u.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]/u)) {
    if (segment === "..") depth -= 1;
    else if (segment !== "" && segment !== ".") depth += 1;
    if (depth < 0) return false;
  }
  return true;
}

/** A stash git stash show, apply, pop or drop reads by its place in the list. */
const STASH_NAME = /^(?:stash@\{\d+\}|\d+)$/u;

/**
 * Why `text` is not a plain branch or tag name, following `git
 * check-ref-format`: git reads `+` as a forced push, `:` as a mapping or a
 * delete, `*` as a glob over every branch, `^ ~ @{ ..` as revision syntax,
 * and falls back to a path for a name it does not know. `remote` (a ref
 * git push, fetch or pull sends) also refuses a full `refs/…` name, which
 * could name any ref on the other side.
 */
function refProblem(text: string, remote: boolean): string | undefined {
  if (text === "") return "it is empty";
  if (/^[-+]/u.test(text)) return "no leading - or + (git reads them as an option or a forced push)";
  if (text.includes(":")) return "no : (git reads it as a mapping that renames or deletes a ref)";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f*?[\\^~]/u.test(text)) return "no spaces, control characters or * ? [ \\ ^ ~ (globs and revision syntax)";
  if (text.includes("..") || text.includes("@{") || text === "@") return "no .., @{ or a lone @ (revision syntax)";
  if (text.startsWith("/") || text.endsWith("/") || text.includes("//")) return "no leading, trailing or doubled /";
  if (text.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock")) || text.endsWith(".")) {
    return "no part that starts with . or ends with .lock, and no trailing . (git reads . as a path)";
  }
  if (remote && text.startsWith("refs/")) return "no full refs/… name, which could name any ref on the other side; write the branch name alone";
  return undefined;
}

/**
 * Why `text` is not a git revision a value may be: the `ref` rules, but
 * with revision syntax (`~ ^ .. @{`). Still no `:`, which reads a file
 * from the repository root (`HEAD:secret`) or searches commit messages
 * (`:/text`), no glob, and no leading `.` or `/`, which git would read as a
 * path when no revision has that name.
 */
function revProblem(text: string): string | undefined {
  if (text === "") return "it is empty";
  if (/^[-+]/u.test(text)) return "no leading - or + (git reads them as an option)";
  if (text.includes(":")) return "no : (git reads REV:path as a file from the repository root; write the file as its own value, as in git show HEAD:{{file}})";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f*?[\\]/u.test(text)) return "no spaces, control characters or * ? [ \\ (globs)";
  if (/^[./]/u.test(text)) return "no leading . or / (git reads it as a path)";
  return undefined;
}

/** The path of a `REV:{{file}}` or `:N:{{file}}` word, as the template and value write it (without the plan's `./`). */
function blobPath(word: TemplateWord, value: (name: string) => string): string {
  const written = word.parts.map((part) => ("text" in part ? (part.insertedAt === undefined ? part.text : "") : value(part.param))).join("");
  return written.slice(blobStart(written, "text" in word.parts[0]!));
}

/**
 * Why a value may not fill its placeholder where the template puts it, or
 * undefined when every value fits its slot's rule. A word that would start
 * with "-" is read as an option, so only a slot the program always takes as
 * an option's value (`git commit -m {{msg}}`) may hold one.
 */
export function workspaceArtifactValueProblem(steps: readonly TemplateStep[], value: (name: string) => string): string | undefined {
  for (const step of steps) {
    for (const command of step.pipeline) {
      const git = literal(command.words[0]) === "git";
      for (const word of command.words) {
        const params = word.parts.filter((part): part is TemplateParam => "param" in part);
        if (!params.length) continue;
        const name = params[0]!.param;
        const filled = word.parts.map((part) => ("text" in part ? part.text : value(part.param))).join("");
        const slot = params[0]!.slot ?? { rule: "text" };
        if (filled.startsWith("-") && !(word.parts.length === 1 && slot.dash)) {
          return `${name} cannot start with "-" there: the program would read it as an option. Pass such a value as an option's value (git commit -m {{msg}}, grep -e {{pattern}}, gh pr create --body {{body}}), or leave the "-" out.`;
        }
        for (const part of params) {
          const text = value(part.param);
          const rule = part.slot?.rule ?? "text";
          if (rule === "number" && !/^\d+$/u.test(text)) return `${part.param} must be a whole number there.`;
          if (rule === "ref" && !(part.slot?.stash && STASH_NAME.test(filled))) {
            const problem = refProblem(text, part.slot?.remote === true);
            const expected = part.slot?.stash ? "a stash name (stash@{n} or n) or a branch or tag name" : "a branch or tag name";
            if (problem) return `${part.param} must be ${expected} there: ${problem}.`;
          }
          if (rule === "rev") {
            const problem = revProblem(text);
            if (problem) return `${part.param} must be a git revision there: ${problem}.`;
          }
          // git runs with GIT_LITERAL_PATHSPECS=1, so `*`, `?` and `[` name themselves (`app/[id]/page.tsx`);
          // a `:` anywhere is refused: leading, it is pathspec magic (`:/`, `:(top)`); inside, git
          // diff and grep read `HEAD:secret/s` as a file from the repository root.
          if (rule === "path" && git && text.includes(":")) {
            return `${part.param} must name a file inside the workspace: no :, which git reads as pathspec magic (:/) or a file at a revision (HEAD:path), both of which reach past the workspace.`;
          }
          if (rule === "target" && (/^[-+]/u.test(text) || /[:@]/u.test(text))) {
            return `${part.param} must be a number or a branch-like name there: no leading - or +, and no :, @ or ://, which gh reads as another repository or a URL.`;
          }
        }
        // A qualifier starts a term: `repo:x`, `-org:x`, `(user:x`; `superuser:` or `Georg:` is a word.
        if (slot.search && /(?<![\p{L}\p{N}_])(?:repo|org|user|owner):/iu.test(filled)) {
          return `${name} cannot hold a repo:, org:, user: or owner: qualifier there: it would search past this repository.`;
        }
        if (slot.rule === "path" && !staysInside(filled)) return `${name} must name a file inside the workspace: ${OUTSIDE_PATHS}.`;
        const blob = params.find((part) => part.slot?.blob);
        if (blob && !staysInside(blobPath(word, value))) {
          return `${blob.param} must name a file inside the workspace: ${OUTSIDE_PATHS}.`;
        }
      }
    }
  }
  return undefined;
}

/** Set for every git command a template with page data runs (see `WorkspaceArtifactArgvCommand.env`). */
const GIT_ENV = { GIT_LITERAL_PATHSPECS: "1" } as const;

/** The template's commands with each placeholder replaced by its value, one argument per word. */
export function fillWorkspaceArtifactTemplate(steps: readonly TemplateStep[], value: (name: string) => string): WorkspaceArtifactArgvStep[] {
  return steps.map((step) => ({
    connector: step.connector,
    pipeline: step.pipeline.map((command) => {
      const paths = command.words.flatMap((word, index) =>
        word.parts.some((part) => "param" in part && part.slot?.rule === "path" && !part.slot.blob) ? [index] : [],
      );
      return {
        argv: command.words.map((word) => word.parts.map((part) => ("text" in part ? part.text : value(part.param))).join("")),
        redirects: [...command.redirects],
        ...(paths.length > 0 ? { paths } : {}),
        ...(literal(command.words[0]) === "git" ? { env: { ...GIT_ENV } } : {}),
      };
    }),
  }));
}

/**
 * The template as the confirmation shows it: each value quoted by `quote`
 * in place, with what the checked plan adds (`GIT_LITERAL_PATHSPECS=1`
 * before git, `./` after `HEAD:`) written in, so a shell reading the preview
 * runs exactly what the plan runs.
 */
export function previewWorkspaceArtifactTemplate(
  template: string,
  steps: readonly TemplateStep[],
  value: (name: string) => string,
  quote: (value: string) => string,
): string {
  const edits: { at: number; end: number; text: string }[] = [];
  for (const match of template.matchAll(WORKSPACE_ARTIFACT_PLACEHOLDER)) {
    edits.push({ at: match.index, end: match.index + match[0].length, text: quote(value(match[1]!)) });
  }
  for (const step of steps) {
    for (const command of step.pipeline) {
      const first = command.words[0]!;
      if (literal(first) === "git") edits.push({ at: first.start, end: first.start, text: Object.entries(GIT_ENV).map(([name, setting]) => `${name}=${setting} `).join("") });
      for (const word of command.words) {
        // A word the plan adds (`--`) is written after a space; text it adds inside a word (`./`) is not.
        const added = word.parts.every((part) => "text" in part && part.insertedAt !== undefined);
        for (const part of word.parts) {
          if ("text" in part && part.insertedAt !== undefined) edits.push({ at: part.insertedAt, end: part.insertedAt, text: added ? ` ${part.text}` : part.text });
        }
      }
    }
  }
  // Insertions before a replacement at the same place: `HEAD:` + `./` + the value.
  edits.sort((a, b) => a.at - b.at || (a.end - a.at) - (b.end - b.at));
  let out = "";
  let from = 0;
  for (const edit of edits) {
    out += template.slice(from, edit.at) + edit.text;
    from = edit.end;
  }
  return out + template.slice(from);
}
