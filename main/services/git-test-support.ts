import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
  return String(result.stdout).trim();
}

export function temporaryGitDirectory(
  t: Pick<TestContext, "after">,
  prefix: string,
): Promise<string> {
  return temporaryDirectory(t, prefix);
}

export async function createGitRepository(
  t: Pick<TestContext, "after">,
  prefix: string,
): Promise<string> {
  const root = await temporaryGitDirectory(t, prefix);
  const repository = path.join(root, "repository");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "initial\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  return repository;
}
