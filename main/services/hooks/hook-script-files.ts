/**
 * Script files a workspace hook's command runs, folded into its digest so an
 * approval covers the script's contents and not only the command line.
 *
 * Resolution is deliberately conservative and never runs anything:
 * - the command is split into words on whitespace and shell operators, with
 *   quotes removed and a leading `$AIDEN_PROJECT_DIR` / `$CLAUDE_PROJECT_DIR`
 *   expanded to the hook's working directory (what the runner sets them to);
 * - a word counts when it resolves, relative to the working directory or as
 *   an absolute path, to a regular file inside the workspace root or the
 *   working directory;
 * - a word written as an explicit relative path (`./x`, `../x`, or under the
 *   project-dir variable) that does not exist is recorded as missing, so a
 *   script created after approval also needs a new approval.
 *
 * Words are recorded as written, not as absolute paths, so the same script in
 * another checkout (a new worktree) gives the same digest only when its bytes
 * are identical.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Files hashed per command; words past this are ignored. */
export const MAX_HOOK_SCRIPT_FILES = 16;
/** Words considered per command. */
const MAX_HOOK_COMMAND_WORDS = 128;
/** Larger files are recorded by size only. */
export const MAX_HOOK_SCRIPT_BYTES = 8 * 1024 * 1024;

export interface HookScriptFile {
  /** The word as written in the command (quotes removed). */
  word: string;
  state: "file" | "missing" | "too-large";
  /** sha256 of the contents for `file`; the byte size for `too-large`. */
  hash?: string;
  /** Present when the word is a symbolic link: where it points. */
  linkTarget?: string;
}

const PROJECT_DIR_VARIABLE = /^(?:\$\{(?:AIDEN|CLAUDE)_PROJECT_DIR\}|\$(?:AIDEN|CLAUDE)_PROJECT_DIR)(?=\/|$)/u;

/** Command words with quotes removed; operators and redirections separate words. */
export function hookCommandWords(command: string): string[] {
  const words: string[] = [];
  for (const raw of command.split(/[\s;&|()<>`]+/u)) {
    if (words.length >= MAX_HOOK_COMMAND_WORDS) break;
    const word = raw.replace(/["']/gu, "");
    if (!word) continue;
    words.push(word);
    // `--config=./check.json` names a file after the `=`.
    const equals = word.indexOf("=");
    if (equals > 0 && equals < word.length - 1) words.push(word.slice(equals + 1));
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

async function hashFile(file: string): Promise<{ state: "file" | "too-large"; hash: string } | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_HOOK_SCRIPT_BYTES) return { state: "too-large", hash: String(stat.size) };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_HOOK_SCRIPT_BYTES) return { state: "too-large", hash: String(total) };
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { state: "file", hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/**
 * The in-workspace files `command` refers to, read from `cwd` (the folder the
 * hook runs in). Only files inside `workspaceRoot` or `cwd` count.
 */
export async function hookScriptFiles(command: string, options: { workspaceRoot: string; cwd: string }): Promise<HookScriptFile[]> {
  const roots = [path.resolve(options.workspaceRoot), path.resolve(options.cwd)];
  const files: HookScriptFile[] = [];
  const seen = new Set<string>();
  for (const word of hookCommandWords(command)) {
    if (files.length >= MAX_HOOK_SCRIPT_FILES) break;
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
    if (!exists) {
      if (candidate.explicit) {
        seen.add(word);
        files.push({ word, state: "missing" });
      }
      continue;
    }
    const hashed = await hashFile(candidate.file);
    if (!hashed) {
      // A link to a folder, a socket or a dangling link: record the link itself.
      if (linkTarget === undefined) continue;
      seen.add(word);
      files.push({ word, state: "missing", linkTarget });
      continue;
    }
    seen.add(word);
    files.push({ word, state: hashed.state, hash: hashed.hash, ...(linkTarget !== undefined ? { linkTarget } : {}) });
  }
  return files;
}

/** The hook digest with its script files folded in; unchanged when it references none. */
export function digestWithScriptFiles(baseDigest: string, files: readonly HookScriptFile[]): string {
  if (files.length === 0) return baseDigest;
  return createHash("sha256").update(JSON.stringify({ v: 1, base: baseDigest, files })).digest("hex");
}
