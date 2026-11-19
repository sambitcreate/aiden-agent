import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { constants as osConstants } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type { WorkspaceArtifactArgvStep } from "../../../renderer/shared/workspace-artifacts.js";
import { createProcessGroupTerminator, decodeCappedUtf8, waitForChildExit, type ProcessGroupTerminator } from "../../shared/process-group.js";
import type { BoundedShellCommandResult } from "../bounded-shell-command.js";

export interface ArgvPlanOptions {
  steps: readonly WorkspaceArtifactArgvStep[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Combined stdout and stderr bytes kept, across every command; more stops the run. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

// The same grace and drain `runBoundedShellCommand` gives a shell.
const KILL_GRACE_MS = 1_000;
const PIPE_DRAIN_MS = 1_000;

/** Where a command's stdout or stderr goes once its redirections apply. */
type Target = "out" | "err" | "null";

/**
 * Finds `program` on the environment's PATH, as a shell would: the first
 * absolute entry holding an executable file of that name (or, on Windows,
 * that name plus one of PATHEXT). Relative PATH entries are skipped, so a
 * workspace can't put its own `git` in front. Windows is not supported: the
 * name without an extension is tried before PATHEXT, and a `.cmd` or `.bat`
 * found here cannot be spawned without a shell.
 */
export async function findProgramOnPath(program: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, program + extension);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here; try the next entry.
      }
    }
  }
  return undefined;
}

/**
 * The real path of `candidate`, or of its nearest ancestor that exists (a
 * file a command may create). Followed through symbolic links before `..`,
 * as the system follows them when the program opens it.
 */
async function realPathOrAncestor(candidate: string): Promise<string | undefined> {
  for (let current = candidate; ; current = path.dirname(current)) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A loop, a permission error and the like: not provably inside.
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      if (path.dirname(current) === current) return undefined;
    }
  }
}

function isWithin(root: string, real: string): boolean {
  const relative = path.relative(root, real);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether a workspace-file argument reaches outside the workspace once
 * symbolic links are followed. Its text was already checked (relative, no
 * `..` that climbs out), but a link inside the folder can point anywhere.
 * Both the path as the system resolves it and as git normalizes it must stay
 * inside the folder's real path.
 */
async function leadsOutside(root: string | undefined, cwd: string, argument: string): Promise<boolean> {
  if (root === undefined) return true;
  for (const candidate of [`${cwd}${path.sep}${argument}`, path.resolve(cwd, argument)]) {
    const real = await realPathOrAncestor(candidate);
    if (real === undefined || !isWithin(root, real)) return true;
  }
  return false;
}

function statusOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (number ?? 0);
}

/**
 * Runs the commands of a workspace artifact button that takes page data,
 * without a shell: each command is a program and its arguments
 * (`shell: false`), pipes are connected here, and `;`, `&&` and `||` and the
 * three redirections the template grammar allows behave as a POSIX shell's
 * would. Each command runs in its own process group under one deadline,
 * output cap and abort, like `runBoundedShellCommand`, whose result shape it
 * returns.
 */
export async function runArgvPlan(options: ArgvPlanOptions): Promise<BoundedShellCommandResult> {
  const { signal } = options;
  if (signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, aborted: true, backgroundStopped: false };
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let aborted = false;
  let backgroundStopped = false;
  let stopped = false;
  const terminators: ProcessGroupTerminator[] = [];
  const running = new Set<ProcessGroupTerminator>();
  const stopAll = () => {
    stopped = true;
    for (const terminator of running) terminator.terminate();
  };
  const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, options.maxOutputBytes - bytes);
    if (remaining > 0) target.push(value.subarray(0, remaining));
    bytes += value.length;
    if (bytes > options.maxOutputBytes && !outputLimitExceeded) {
      outputLimitExceeded = true;
      stopAll();
    }
  };
  const captureStdout = capture(stdout);
  const captureStderr = capture(stderr);
  const abort = () => {
    aborted = true;
    stopAll();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, options.timeoutMs);
  timeout.unref?.();

  let workspaceRoot: Promise<string | undefined> | undefined;
  /** The workspace folder's real path, read once on first use; undefined when it can't be read. */
  const root = () => (workspaceRoot ??= fs.realpath(options.cwd).catch(() => undefined));
  /** Runs one pipeline and settles with its status: the last command's. */
  const runPipeline = async (pipeline: WorkspaceArtifactArgvStep["pipeline"]): Promise<number> => {
    const programs: string[] = [];
    for (const command of pipeline) {
      const found = await findProgramOnPath(command.argv[0]!, options.env);
      if (!found) {
        captureStderr(`${command.argv[0]}: command not found\n`);
        return 127;
      }
      programs.push(found);
    }
    // Checked just before the pipeline starts, so a link an earlier command made counts too.
    for (const command of pipeline) {
      for (const index of command.paths ?? []) {
        const argument = command.argv[index]!;
        if (await leadsOutside(await root(), options.cwd, argument)) {
          captureStderr(`${command.argv[0]}: ${argument}: leads outside the workspace through a symbolic link, so it was not run\n`);
          return 126;
        }
      }
    }
    if (stopped) return 1;
    const waits: Promise<number>[] = [];
    // Spawned last to first, so each command's stdout can be the next one's stdin.
    let next: Writable | null = null;
    for (let index = pipeline.length - 1; index >= 0; index -= 1) {
      const command = pipeline[index]!;
      const last = index === pipeline.length - 1;
      let fd1: Target = "out";
      let fd2: Target = "err";
      for (const redirect of command.redirects) {
        if (redirect === ">/dev/null") fd1 = "null";
        else if (redirect === "2>/dev/null") fd2 = "null";
        else fd2 = fd1;
      }
      const into = (target: Target): "ignore" | "pipe" | Writable => {
        if (target === "null") return "ignore";
        if (target === "out" && !last) return next ?? "ignore";
        return "pipe";
      };
      const stdio: StdioOptions = [index === 0 ? "ignore" : "pipe", into(fd1), into(fd2)];
      let child: ChildProcess;
      try {
        child = spawn(programs[index]!, command.argv.slice(1), {
          argv0: command.argv[0],
          cwd: options.cwd,
          env: options.env,
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
          stdio,
        });
      } catch (error) {
        captureStderr(`${command.argv[0]}: ${(error as Error).message}\n`);
        waits.unshift(Promise.resolve(126));
        next?.destroy();
        next = null;
        continue;
      }
      // The child holds its own end of the pipe now; the parent's copy would keep it open.
      next?.destroy();
      next = child.stdin ?? null;
      next?.on("error", () => undefined);
      if (last) {
        child.stdout?.on("data", captureStdout);
        child.stderr?.on("data", fd2 === "out" ? captureStdout : captureStderr);
      } else {
        child.stderr?.on("data", captureStderr);
      }
      const terminator = createProcessGroupTerminator(child, { killGraceMs: KILL_GRACE_MS });
      terminators.push(terminator);
      running.add(terminator);
      if (stopped) terminator.terminate();
      waits.unshift(
        waitForChildExit(child, { drainMs: PIPE_DRAIN_MS, onPipesHeld: () => terminator.terminate() }).then(
          ({ code, signal: exitSignal, pipesHeld }) => {
            if (pipesHeld) backgroundStopped = true;
            else running.delete(terminator);
            return statusOf(code, exitSignal);
          },
          (error: Error) => {
            running.delete(terminator);
            captureStderr(`${command.argv[0]}: ${error.message}\n`);
            return 126;
          },
        ),
      );
    }
    next?.destroy();
    const statuses = await Promise.all(waits);
    return statuses[statuses.length - 1]!;
  };

  let status = 0;
  for (const step of options.steps) {
    if (stopped) break;
    if (step.connector === "&&" && status !== 0) continue;
    if (step.connector === "||" && status === 0) continue;
    status = await runPipeline(step.pipeline);
  }
  clearTimeout(timeout);
  signal?.removeEventListener("abort", abort);
  await Promise.all(terminators.map((terminator) => terminator.finished()));
  return {
    stdout: decodeCappedUtf8(Buffer.concat(stdout), outputLimitExceeded),
    stderr: decodeCappedUtf8(Buffer.concat(stderr), outputLimitExceeded),
    exitCode: stopped ? null : status,
    timedOut,
    outputLimitExceeded,
    aborted,
    backgroundStopped: backgroundStopped && !timedOut && !outputLimitExceeded && !aborted,
  };
}
