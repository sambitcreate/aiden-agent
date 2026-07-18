// Lightweight git inspection + actions for a workspace folder. Uses the git CLI
// (present on any dev machine) with a short timeout so a hung git never blocks
// the UI. Read helpers (info/branches) fail soft; actions (checkout/create)
// surface git's own error message so the UI can show it.

import { execFile } from "child_process";
import { promisify } from "util";
import type { GitBranches, GitInfo } from "./types.js";

const run = promisify(execFile);

/** Read-only git invocation: returns trimmed stdout, or null on any failure. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 3000, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Mutating git invocation: throws with git's stderr on failure. */
async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 8000, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : "git command failed."));
  }
}

async function currentBranch(folderPath: string): Promise<string | undefined> {
  const branch =
    (await git(folderPath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
    (await git(folderPath, ["rev-parse", "--short", "HEAD"]));
  return branch && branch !== "HEAD" ? branch : (branch ?? undefined);
}

/** Count of uncommitted entries (staged + unstaged + untracked). */
async function uncommittedCount(folderPath: string): Promise<number> {
  const status = await git(folderPath, ["status", "--porcelain"]);
  if (!status) return 0;
  return status.split("\n").filter((line) => line.trim().length > 0).length;
}

async function isRepo(folderPath: string): Promise<boolean> {
  return (await git(folderPath, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

export async function gitInfo(folderPath: string): Promise<GitInfo> {
  if (!folderPath || !(await isRepo(folderPath))) return { isRepo: false };
  const [branch, uncommitted] = await Promise.all([currentBranch(folderPath), uncommittedCount(folderPath)]);
  return { isRepo: true, branch, uncommitted };
}

/** List local branches with the current one and uncommitted count. */
export async function gitBranches(folderPath: string): Promise<GitBranches> {
  if (!folderPath || !(await isRepo(folderPath))) {
    return { isRepo: false, branches: [], uncommitted: 0 };
  }
  const [raw, current, uncommitted] = await Promise.all([
    git(folderPath, ["branch", "--format=%(refname:short)", "--sort=-committerdate"]),
    currentBranch(folderPath),
    uncommittedCount(folderPath),
  ]);
  const branches = (raw ?? "")
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);
  return { isRepo: true, current, branches, uncommitted };
}

/** Switch to an existing branch. Throws with git's message (e.g. on conflicts). */
export async function gitCheckout(folderPath: string, name: string): Promise<void> {
  await gitOrThrow(folderPath, ["checkout", name]);
}

/** Create and check out a new branch off the current HEAD. */
export async function gitCreateBranch(folderPath: string, name: string): Promise<void> {
  await gitOrThrow(folderPath, ["checkout", "-b", name]);
}
