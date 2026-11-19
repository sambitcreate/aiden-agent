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

type TemplatePart = { text: string } | { param: string };

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
 * gh command groups and their verbs that take page data. `gh api` is left
 * out on purpose: `-X` sends any method and `-f`/`-F` turn a request into a
 * POST, so no set of option checks keeps it to reads; `alias`, `extension`
 * and `config` change what later gh commands run.
 */
const ARGUMENT_GH_GROUPS = ["pr", "issue", "run", "repo"];
const ARGUMENT_GH_VERBS = ["view", "list", "checkout", "merge", "comment", "close", "reopen", "review", "diff", "status", "browse"];
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
  `(with only --no-pager or --no-optional-locks before the subcommand); gh ${ARGUMENT_GH_GROUPS.join(", ")} followed by ${ARGUMENT_GH_VERBS.join(", ")}, ` +
  `or gh ${ARGUMENT_GH_COMMANDS.join(" or ")}; ${[...ARGUMENT_TEXT_PROGRAMS, ...ARGUMENT_TEST_PROGRAMS].join(", ")}`;

/**
 * Options whose next word names a program, code or configuration to start.
 * `short` matches short options as written; a long option counts when it is
 * any of `long` or an abbreviation of one, since getopt_long and git accept
 * a unique prefix (`--upload-p`).
 */
interface ProgramOptions {
  short?: RegExp;
  long?: readonly string[];
}
const PROGRAM_OPTIONS: Record<string, ProgramOptions> = {
  sort: { long: ["compress-program"] },
};
/**
 * Long options that name a program, code or a configuration file in any
 * command, with their abbreviations, and the words that mark one by name
 * (`--sendmail-cmd`, `--proxy-command`, `--config`).
 */
const ANY_PROGRAM_LONG: ProgramOptions = {
  long: ["exec", "eval", "command", "config", "upload-pack", "receive-pack", "use-compress-program", "compress-program", "rsh", "rsync-path", "proxy-command"],
};
const PROGRAM_OPTION_WORD = /^(?:[a-z]*cmd|[a-z]*command|program|prog|exec|execdir|execute|shell|pager|editor|askpass|hooks?|eval|rsh|script|interpreter|wrapper|config|helper)$/u;
const LONG_OPTION = /^--([A-Za-z0-9][A-Za-z0-9-]*)$/u;

/** Whether `arg`, an option as written, is one of `options` or abbreviates one. */
function isProgramOption(arg: string, options: ProgramOptions | undefined): boolean {
  if (!options) return false;
  if (options.short?.test(arg)) return true;
  const name = LONG_OPTION.exec(arg)?.[1]?.toLowerCase();
  return name !== undefined && options.long?.some((option) => option.startsWith(name)) === true;
}

/** Whether a long option's own name says it takes a program or code (`--sendmail-cmd`, `--shell`). */
function namesAProgram(arg: string): boolean {
  const name = LONG_OPTION.exec(arg)?.[1]?.toLowerCase();
  return name !== undefined && name.split("-").some((part) => PROGRAM_OPTION_WORD.test(part));
}

/** A long option that names the file a program writes (`--output`, `--out`). */
function namesAnOutputFile(arg: string): boolean {
  const name = LONG_OPTION.exec(arg)?.[1]?.toLowerCase();
  return name !== undefined && (name.startsWith("output") || "output".startsWith(name));
}

/** git's, by subcommand; `*` applies to every subcommand. */
const GIT_PROGRAM_OPTIONS: Record<string, ProgramOptions> = {
  "*": { long: ["upload-pack", "receive-pack", "exec", "config", "config-env", "exec-path"] },
  // A merge strategy runs the program git-merge-<strategy>.
  merge: { short: /^-s$/u, long: ["strategy"] },
  pull: { short: /^-s$/u, long: ["strategy"] },
  rebase: { short: /^-[xs]$/u, long: ["exec", "strategy"] },
  "cherry-pick": { long: ["strategy"] },
  revert: { long: ["strategy"] },
};
/**
 * `git config` keys a text value may set: none of them names a program,
 * a hook, a pager, an editor, an alias or other configuration to include.
 */
const SAFE_GIT_CONFIG_KEY = /^(?:user\.(?:name|email)|init\.defaultbranch|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote)|fetch\.prune|color\.ui|branch\.[A-Za-z0-9._/-]+\.description)$/iu;
/** `git config` subcommand words (git 2.46) that come before the key. */
const GIT_CONFIG_VERBS = new Set(["get", "set", "unset", "list", "edit", "rename-section", "remove-section"]);
/** `git config` options that take the next word. */
const GIT_CONFIG_VALUED = /^(?:-f|--file|--blob|--type|--default|--comment|--value)$/u;
/** Plain text a placeholder may be joined to, as in `HEAD:{{branch}}` or `{{name}}.json`. */
const JOINED_TEXT = /^[A-Za-z0-9_.,:@%+/=^~-]*$/u;

/** The `git config` key among its arguments (literal words; a placeholder counts as a key too). */
function gitConfigKey(after: readonly (string | undefined)[]): { key: string | undefined; index: number } | undefined {
  for (let index = 0; index < after.length; index += 1) {
    const arg = after[index];
    if (arg !== undefined && GIT_CONFIG_VALUED.test(arg)) index += 1;
    else if (arg === undefined || (!arg.startsWith("-") && !GIT_CONFIG_VERBS.has(arg))) return { key: arg, index };
  }
  return undefined;
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
    let index = 0;
    while (index < args.length && ARGUMENT_GIT_GLOBAL_OPTIONS.has(args[index] ?? "")) index += 1;
    if (index >= args.length) return program_("git without a subcommand");
    const sub = args[index];
    if (sub === undefined) return { kind: "misplaced", reason: "the git subcommand" };
    if (sub.startsWith("-")) return program_(`git ${sub} before the subcommand`);
    if (!ARGUMENT_GIT_SUBCOMMANDS.includes(sub)) return program_(`git ${sub}`);
    const after = args.slice(index + 1);
    const verbs = GIT_SUBCOMMAND_VERBS[sub];
    if (sub === "remote" && !after.every((arg) => arg !== undefined && verbs!.includes(arg))) return program_("git remote other than git remote -v");
    if (sub === "worktree" && !(after[0] !== undefined && verbs!.includes(after[0]))) {
      return after[0] === undefined && after.length ? { kind: "misplaced", reason: "the git worktree verb" } : program_(`git worktree ${after[0] ?? ""}`.trim());
    }
    if (sub === "config") {
      if (after.some((arg) => arg === "edit" || arg === "-e" || arg === "--edit")) return program_("git config edit, which opens an editor");
      const key = gitConfigKey(after)?.key;
      if (key !== undefined && !SAFE_GIT_CONFIG_KEY.test(key)) return program_(`git config ${key}`);
    }
    return undefined;
  }
  if (program === "gh") {
    const [group, verb] = args;
    if (group === undefined && rest.length) return { kind: "misplaced", reason: "the gh command" };
    if (group !== undefined && ARGUMENT_GH_COMMANDS.includes(group)) return undefined;
    if (group === undefined || !ARGUMENT_GH_GROUPS.includes(group)) return program_(group === "api" ? "gh api, which can send any request" : `gh ${group ?? ""}`.trim());
    if (verb === undefined && rest.length > 1) return { kind: "misplaced", reason: `the gh ${group} verb` };
    if (verb === undefined || !ARGUMENT_GH_VERBS.includes(verb)) return program_(`gh ${group} ${verb ?? ""}`.trim());
    return undefined;
  }
  if (program === "sort" && args.some((arg) => arg !== undefined && isProgramOption(arg.replace(/=.*$/su, ""), PROGRAM_OPTIONS.sort))) return program_("sort --compress-program");
  if (program === "rg" && args.some((arg) => arg !== undefined && /^--(?:pre|hostname-bin)(?:=|$)/u.test(arg))) return program_("rg --pre or --hostname-bin, which run a program");
  return undefined;
}

/**
 * Whether the placeholder word at `at` among the command's arguments sits
 * where its value would name a program, code or a file to write.
 */
function placeholderProblem(program: string, args: readonly (string | undefined)[], at: number): string | undefined {
  const before = args.slice(0, at);
  const last = before[before.length - 1] ?? "";
  // A value that names a file to write or post could overwrite a hook or send a local secret.
  if (namesAnOutputFile(last) || (program === "sort" && /^-[A-Za-z]*o$/u.test(last))) return `the file ${program} ${last} writes`;
  if (program === "gh" && (last === "-F" || last === "--body-file")) return `the file gh ${last} reads and posts`;
  if (program === "git" && before.includes("config") && /^(?:-f|--file)$/u.test(last)) return "the file git config writes";
  if (program === "uniq") {
    let operands = 0;
    for (let index = 0; index < before.length; index += 1) {
      const arg = before[index];
      if (arg !== undefined && /^-[fsw]$/u.test(arg)) index += 1;
      else if (arg === undefined || !arg.startsWith("-") || arg === "-") operands += 1;
    }
    if (operands >= 1) return "the file uniq writes";
  }
  if (isProgramOption(last, PROGRAM_OPTIONS[program]) || isProgramOption(last, ANY_PROGRAM_LONG) || namesAProgram(last)) {
    return `the program or code ${program} ${last} names`;
  }
  if (program === "git") {
    let index = 0;
    while (index < args.length && ARGUMENT_GIT_GLOBAL_OPTIONS.has(args[index] ?? "")) index += 1;
    const sub = args[index]!;
    if (at > index && (isProgramOption(last, GIT_PROGRAM_OPTIONS[sub]) || isProgramOption(last, GIT_PROGRAM_OPTIONS["*"]))) {
      return `the program git ${sub} ${last} names`;
    }
    if (sub === "config") {
      const found = gitConfigKey(args.slice(index + 1));
      if (found === undefined || found.index + index + 1 === at) return "a git config key or option";
      if (!SAFE_GIT_CONFIG_KEY.test(found.key!)) return `a value for git config ${found.key}, which git may run or read as configuration`;
    }
  }
  return undefined;
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
        const reason = joinedProblem(word) ?? placeholderProblem(program, args, at);
        if (reason) return { ok: false, problem: { kind: "misplaced", reason } };
      }
    }
  }
  return parsed;
}

/** Whether a template holds a placeholder, and so runs without a shell. */
export function workspaceArtifactTemplateHasParams(template: string): boolean {
  return PLACEHOLDER_TEST.test(template);
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
