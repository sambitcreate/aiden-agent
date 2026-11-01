/**
 * Script files a workspace hook's command runs, folded into its digest so an
 * approval covers the script's contents and not only the command line.
 *
 * Resolution is deliberately conservative and never runs anything:
 * - the command is split into words the way a shell would for plain text:
 *   quotes and backslash escapes are removed, operators (`;`, `&&`, `|`,
 *   `(`, redirections, backquotes) separate words, and a leading
 *   `$AIDEN_PROJECT_DIR` / `$CLAUDE_PROJECT_DIR` is expanded to the hook's
 *   working directory (what the runner sets them to);
 * - a word counts when it resolves, relative to the working directory or as
 *   an absolute path, to a regular file inside the workspace root or the
 *   working directory; each one is hashed in full;
 * - a word written as an explicit relative path (`./x`, `../x`, or under the
 *   project-dir variable) that does not exist is recorded as missing, so a
 *   script created after approval also needs a new approval.
 *
 * Coverage is reported honestly:
 * - past the word, file or size limits Aiden can't check everything the
 *   command runs, so the scan is `overLimit` and the hook won't run;
 * - commands whose code lives somewhere the scan can't follow (`cd … &&`,
 *   `source`, `bash -c`, `npx`, `npm run`, `python -m`, `make`…) are listed
 *   in `unfollowed`: approving the hook doesn't cover what they run.
 *
 * Words are recorded as written, not as absolute paths, so the same script in
 * another checkout (a new worktree) gives the same digest only when its bytes
 * are identical.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Files hashed per command; a command naming more is not run. */
export const MAX_HOOK_SCRIPT_FILES = 16;
/** Words checked per command; a longer command is not run. */
export const MAX_HOOK_COMMAND_WORDS = 128;
/** Larger script files can't be checked, and a hook running one is not run. */
export const MAX_HOOK_SCRIPT_BYTES = 256 * 1024 * 1024;

export interface HookScriptFile {
  /** The word as written in the command (quotes and escapes removed). */
  word: string;
  state: "file" | "missing";
  /** sha256 of the full contents, for `file`. */
  hash?: string;
  /** Present when the word is a symbolic link: where it points. */
  linkTarget?: string;
}

export interface HookScriptScan {
  /** What goes into the digest. */
  files: HookScriptFile[];
  /** The files hashed, relative to the workspace root (or the working directory), for display. */
  paths: string[];
  /** Why Aiden can't check everything this command runs; such a hook does not run. */
  overLimit?: string;
  /** Commands whose code the scan can't follow, e.g. `npm run`, `bash -c`. */
  unfollowed: string[];
}

export interface HookCommandWord {
  text: string;
  /** The first word of a simple command: the program it runs. */
  commandPosition: boolean;
}

export interface HookCommandScan {
  words: HookCommandWord[];
  /** More words than Aiden checks. */
  tooLong: boolean;
  /** Command substitution inside quotes, which the scan does not follow. */
  hiddenCommands: boolean;
}

const PROJECT_DIR_VARIABLE = /^(?:\$\{(?:AIDEN|CLAUDE)_PROJECT_DIR\}|\$(?:AIDEN|CLAUDE)_PROJECT_DIR)(?=\/|$)/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Operators after which the next word starts a new command. */
const COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "`"]);
/** Wrappers whose first plain argument is the program they run. */
const PREFIX_COMMANDS = new Set(["env", "exec", "nohup", "time", "command", "builtin", "nice", "sudo"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const PACKAGE_SCRIPT_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "pnpm", "yarn"]);
const NPM_SCRIPT_COMMANDS = new Set(["run", "run-script", "rum", "urn", "test", "t", "tst", "start", "stop", "restart", "exec", "x"]);
const BUILD_TOOLS = new Set(["make", "gmake", "just", "rake", "gradle", "gradlew", "mvn", "task"]);

/**
 * Split a command into words as a POSIX shell would for literal text, marking
 * which words name the program of a simple command. Never expands variables
 * or globs (words with them are left as written).
 */
export function scanHookCommand(command: string): HookCommandScan {
  const words: HookCommandWord[] = [];
  let tooLong = false;
  let hiddenCommands = false;
  let current = "";
  let inWord = false;
  let atCommand = true;

  const end = () => {
    if (!inWord) return;
    inWord = false;
    if (words.length >= MAX_HOOK_COMMAND_WORDS) {
      tooLong = true;
      current = "";
      return;
    }
    words.push({ text: current, commandPosition: atCommand });
    // `FOO=1 ./x.sh`: an assignment before the program keeps the next word in command position.
    if (!(atCommand && ASSIGNMENT.test(current))) atCommand = false;
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (char === "\\") {
      const next = command[index + 1];
      index += 1;
      if (next === undefined || next === "\n") continue;
      current += next;
      inWord = true;
      continue;
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const stop = close === -1 ? command.length : close;
      current += command.slice(index + 1, stop);
      inWord = true;
      index = stop;
      continue;
    }
    if (char === '"') {
      inWord = true;
      index += 1;
      for (; index < command.length && command[index] !== '"'; index += 1) {
        const inner = command[index] as string;
        if (inner === "\\" && index + 1 < command.length && '"\\$`\n'.includes(command[index + 1] as string)) {
          index += 1;
          if (command[index] !== "\n") current += command[index];
          continue;
        }
        if (inner === "`" || (inner === "$" && command[index + 1] === "(")) hiddenCommands = true;
        current += inner;
      }
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      end();
      atCommand = true;
      index += 1;
      continue;
    }
    if (/\s/u.test(char) && char !== "\n") {
      end();
      continue;
    }
    if (char === "<" || char === ">" || (char === "&" && command[index + 1] === ">")) {
      // A redirection (`>`, `>>`, `2>&1`, `&>`, `<<`) is not a new command; its target is a plain word.
      end();
      while (index + 1 < command.length && "<>&|".includes(command[index + 1] as string)) index += 1;
      continue;
    }
    if (COMMAND_SEPARATORS.has(char)) {
      end();
      atCommand = true;
      continue;
    }
    current += char;
    inWord = true;
  }
  end();
  return { words, tooLong, hiddenCommands };
}

/** Commands in `words` that run code the scan can't follow to a file. */
export function unfollowedCommands(scan: HookCommandScan): string[] {
  const found = new Set<string>();
  if (scan.hiddenCommands) found.add("command substitution in quotes");
  const { words } = scan;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as HookCommandWord;
    if (!word.commandPosition) continue;
    let program = word.text;
    let position = index;
    // Look through wrappers and assignments to the program they run.
    while (PREFIX_COMMANDS.has(path.basename(program)) || ASSIGNMENT.test(program)) {
      position += 1;
      while (position < words.length && (words[position]?.text.startsWith("-") || ASSIGNMENT.test(words[position]?.text ?? ""))) position += 1;
      const next = words[position];
      if (!next || next.commandPosition) break;
      program = next.text;
    }
    const name = path.basename(program);
    const argsUntilNext: string[] = [];
    for (let at = position + 1; at < words.length && !words[at]?.commandPosition; at += 1) argsUntilNext.push(words[at]?.text ?? "");
    const firstPlain = argsUntilNext.find((arg) => !arg.startsWith("-"));
    if (name === "cd" || name === "pushd") found.add(name);
    else if (name === "source" || name === ".") found.add(name);
    else if (name === "eval") found.add("eval");
    else if (SHELLS.has(name) && argsUntilNext.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg))) found.add(`${name} -c`);
    else if (PACKAGE_SCRIPT_RUNNERS.has(name)) found.add(name);
    else if (name === "npm" && firstPlain && NPM_SCRIPT_COMMANDS.has(firstPlain)) found.add(`npm ${firstPlain}`);
    else if ((name === "bun" || name === "deno") && firstPlain && ["run", "x", "test", "task"].includes(firstPlain)) found.add(`${name} ${firstPlain}`);
    else if ((name === "uv" || name === "poetry" || name === "cargo") && firstPlain === "run") found.add(`${name} run`);
    else if (/^python(?:\d+(?:\.\d+)?)?$/u.test(name) && argsUntilNext.includes("-m")) found.add(`${name} -m`);
    else if (BUILD_TOOLS.has(name)) found.add(name);
  }
  return [...found];
}

/** Command words with quotes and escapes removed, plus the path after `=` in `--flag=./file`. */
export function hookCommandWords(command: string): string[] {
  const words: string[] = [];
  for (const { text } of scanHookCommand(command).words) {
    if (!text) continue;
    words.push(text);
    const equals = text.indexOf("=");
    if (equals > 0 && equals < text.length - 1) words.push(text.slice(equals + 1));
  }
  return words;
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function candidatePath(word: string, cwd: string): { file: string; explicit: boolean } | undefined {
  if (word.startsWith("-") || word.includes("://")) return undefined;
  const projectDir = PROJECT_DIR_VARIABLE.exec(word);
  if (projectDir) {
    const rest = word.slice(projectDir[0].length);
    if (/[$*?[\]{}~]/u.test(rest)) return undefined;
    return { file: path.join(cwd, rest), explicit: true };
  }
  if (/[$*?[\]{}~]/u.test(word)) return undefined;
  const explicit = word.startsWith("./") || word.startsWith("../");
  return { file: path.isAbsolute(word) ? path.normalize(word) : path.resolve(cwd, word), explicit };
}

type Hashed = { state: "file"; hash: string } | { state: "too-large" } | undefined;

/** sha256 of the whole file, streamed; `too-large` past the cap. */
async function hashFile(file: string): Promise<Hashed> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_HOOK_SCRIPT_BYTES) return { state: "too-large" };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // It grew while being read.
      if (total > MAX_HOOK_SCRIPT_BYTES) return { state: "too-large" };
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { state: "file", hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/**
 * The in-workspace files `command` refers to, read from `cwd` (the folder the
 * hook runs in), and how much of what it runs that covers. Only files inside
 * `workspaceRoot` or `cwd` count.
 */
export async function hookScriptFiles(command: string, options: { workspaceRoot: string; cwd: string }): Promise<HookScriptScan> {
  const roots = [path.resolve(options.workspaceRoot), path.resolve(options.cwd)];
  const commandScan = scanHookCommand(command);
  const scan: HookScriptScan = { files: [], paths: [], unfollowed: unfollowedCommands(commandScan) };
  if (commandScan.tooLong) {
    scan.overLimit = `the command has more than ${MAX_HOOK_COMMAND_WORDS} words`;
    return scan;
  }
  const seen = new Set<string>();
  for (const word of hookCommandWords(command)) {
    if (seen.has(word)) continue;
    const candidate = candidatePath(word, options.cwd);
    if (!candidate || !roots.some((root) => inside(root, candidate.file))) continue;
    if (roots.includes(candidate.file)) continue;
    let linkTarget: string | undefined;
    let exists = true;
    try {
      const stat = await fs.lstat(candidate.file);
      if (stat.isSymbolicLink()) linkTarget = await fs.readlink(candidate.file);
      else if (!stat.isFile()) continue;
    } catch {
      exists = false;
    }
    if (!exists && !candidate.explicit) continue;
    seen.add(word);
    if (scan.files.length >= MAX_HOOK_SCRIPT_FILES) {
      scan.overLimit = `the command names more than ${MAX_HOOK_SCRIPT_FILES} files`;
      return scan;
    }
    if (!exists) {
      scan.files.push({ word, state: "missing" });
      continue;
    }
    const hashed = await hashFile(candidate.file);
    if (hashed?.state === "too-large") {
      scan.overLimit = `${word} is larger than ${MAX_HOOK_SCRIPT_BYTES / (1024 * 1024)} MiB`;
      return scan;
    }
    if (!hashed) {
      // A link to a folder, a socket or a dangling link: record the link itself.
      if (linkTarget === undefined) {
        seen.delete(word);
        continue;
      }
      scan.files.push({ word, state: "missing", linkTarget });
      continue;
    }
    scan.files.push({ word, state: "file", hash: hashed.hash, ...(linkTarget !== undefined ? { linkTarget } : {}) });
    const root = roots.find((candidateRoot) => inside(candidateRoot, candidate.file)) as string;
    scan.paths.push(path.relative(root, candidate.file).split(path.sep).join("/"));
  }
  return scan;
}

/** The hook digest with its script files folded in; unchanged when it references none. */
export function digestWithScriptFiles(baseDigest: string, files: readonly HookScriptFile[]): string {
  if (files.length === 0) return baseDigest;
  return createHash("sha256").update(JSON.stringify({ v: 1, base: baseDigest, files })).digest("hex");
}
