import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createProcessGroupTerminator, decodeCappedUtf8, processGroupExists, waitForChildExit, type ProcessGroupProbe } from "../shared/process-group.js";

export interface BoundedShellCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Combined stdout and stderr bytes kept; more stops the command. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /**
   * When the shell has exited but processes it started still hold its output
   * open (`npm run dev &`), return this long after the exit with
   * `leftoverProcessGroup` and the open streams, and leave them running for the
   * caller to take over. Without it they are stopped after a short drain
   * (`backgroundStopped`).
   */
  releaseLeftoversAfterMs?: number;
  /** Hold a check behind stdin until its group is durably recorded. On completion
   * terminate leftovers and release the record after group cleanup. */
  recordGroup?: (pid: number) => Promise<() => Promise<void>>;
  groupProbe?: ProcessGroupProbe;
}

export interface BoundedShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
  /**
   * True when the shell exited but something it started still held the output
   * pipe after the drain window, so that process group was stopped.
   */
  backgroundStopped: boolean;
  /**
   * The shell exited on its own but processes it started are still in its
   * process group (a server started with a trailing `&`). Nothing stops them;
   * the caller decides whether to track them.
   */
  leftoverProcessGroup?: number;
  /**
   * With `releaseLeftoversAfterMs`: the output the leftovers still write to.
   * Both are paused so nothing is lost before the caller attaches; it must
   * read and resume both (or just resume them), or the leftovers block.
   */
  leftoverOutput?: { stdout: Readable; stderr: Readable };
}

// SIGTERM first; anything still in the group a second later gets SIGKILL.
const KILL_GRACE_MS = 1_000;
// A background job that inherited stdout keeps the pipe open after the shell
// exits. Give remaining output this long to arrive, then stop the group.
const PIPE_DRAIN_MS = 1_000;

/**
 * Runs one shell command in its own process group with a deadline and an
 * output cap. A timeout, the cap or an abort stops the whole group: SIGTERM
 * first, SIGKILL a second later for anything still running. The result waits
 * for that cleanup. When the shell exits but a background job still holds its
 * output pipe, the command settles after a short drain and the group is
 * stopped, instead of waiting for the job or the timeout, unless
 * `releaseLeftoversAfterMs` hands the job to the caller. Used by
 * `run_command` and by workspace artifact sources and buttons.
 */
export async function runBoundedShellCommand(options: BoundedShellCommandOptions): Promise<BoundedShellCommandResult> {
  const { signal } = options;
  if (signal?.aborted) {
    // Cancelled before it started: nothing runs.
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, aborted: true, backgroundStopped: false };
  }
  const { recordGroup } = options;
  const spawnOptions = {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
  };
  // On a host crash the pipe closes. An unrecorded shell then exits without
  // evaluating the person's command. Pass the command as an argument verbatim.
  const child = recordGroup
    ? spawn("/bin/sh", ["-c", 'IFS= read -r ready && exec /bin/sh -c "$1" </dev/null', "aiden-check", options.command],
        { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(options.command, { ...spawnOptions, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const terminator = createProcessGroupTerminator(child, { killGraceMs: KILL_GRACE_MS, probe: options.groupProbe });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let aborted = false;

  const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, options.maxOutputBytes - bytes);
    if (remaining > 0) target.push(value.subarray(0, remaining));
    bytes += value.length;
    if (bytes > options.maxOutputBytes && !outputLimitExceeded) {
      outputLimitExceeded = true;
      terminator.terminate();
    }
  };
  const captureStdout = capture(stdout);
  const captureStderr = capture(stderr);
  child.stdout.on("data", captureStdout);
  child.stderr.on("data", captureStderr);
  const abort = () => {
    aborted = true;
    terminator.terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminator.terminate();
  }, options.timeoutMs);
  timeout.unref?.();
  const stopWatching = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  };

  const result = (exitCode: number | null, extra: Partial<BoundedShellCommandResult>): BoundedShellCommandResult => ({
    stdout: decodeCappedUtf8(Buffer.concat(stdout), outputLimitExceeded),
    stderr: decodeCappedUtf8(Buffer.concat(stderr), outputLimitExceeded),
    exitCode,
    timedOut,
    outputLimitExceeded,
    aborted,
    backgroundStopped: false,
    ...extra,
  });

  let releaseRecord: (() => Promise<void>) | undefined;
  let admissionError: unknown;
  child.stdin?.on("error", () => { /* The check was stopped before admission. */ });
  const admission = recordGroup && child.pid
    ? recordGroup(child.pid).then((release) => {
        releaseRecord = release;
        child.stdin?.end(terminator.requested ? undefined : "run\n");
      }).catch((error: unknown) => {
        admissionError = error;
        child.stdin?.end();
      })
    : undefined;
  try {
    const releaseAfter = recordGroup || process.platform === "win32" ? undefined : options.releaseLeftoversAfterMs;
    if (releaseAfter !== undefined) {
      const released = await waitOrRelease(child, releaseAfter, () => !terminator.requested && processGroupExists(child.pid));
      if (released.kind === "released") {
        child.stdout.off("data", captureStdout);
        child.stderr.off("data", captureStderr);
        // Held until whoever takes the leftovers reads or drains them.
        child.stdout.pause();
        child.stderr.pause();
        return result(released.code, {
          leftoverProcessGroup: child.pid,
          leftoverOutput: { stdout: child.stdout, stderr: child.stderr },
        });
      }
      if (released.kind === "closed") return result(released.code, leftovers(child.pid, terminator.requested));
      // Nothing left in the group to hand over (or a timeout, the cap or an
      // abort is already stopping it): stop it as without a caller.
      terminator.terminate();
      child.stdout.destroy();
      child.stderr.destroy();
      // The run is over. Waiting for cleanup must not rewrite how it ended.
      stopWatching();
      const stopConfirmed = await terminator.finished() !== "cleanup_unconfirmed";
      return result(released.code, { backgroundStopped: stopConfirmed && !timedOut && !outputLimitExceeded && !aborted });
    }
    const { code, pipesHeld } = await waitForChildExit(child, {
      drainMs: PIPE_DRAIN_MS,
      onPipesHeld: () => terminator.terminate(),
    });
    if (recordGroup) {
      await admission;
      if (admissionError) throw admissionError;
      if (processGroupExists(child.pid)) terminator.terminate();
    }
    stopWatching();
    const stopConfirmed = await terminator.finished() !== "cleanup_unconfirmed";
    return result(code, {
      ...(pipesHeld ? {} : leftovers(child.pid, terminator.requested)),
      // Only a group stopped because of the drain counts; a timeout, the cap or
      // an abort already explains itself.
      backgroundStopped: pipesHeld && stopConfirmed && !timedOut && !outputLimitExceeded && !aborted,
    });
  } finally {
    stopWatching();
    // The shell can close before its descendants leave the process group.
    await terminator.finished();
    await admission;
    await releaseRecord?.();
  }
}

/** Processes still in the group after the shell closed its output on its own. */
function leftovers(pid: number | undefined, terminationRequested: boolean): Partial<BoundedShellCommandResult> {
  return !terminationRequested && pid && processGroupExists(pid) ? { leftoverProcessGroup: pid } : {};
}

type ReleaseOutcome = { kind: "closed" | "held" | "released"; code: number | null };

/**
 * Like `waitForChildExit`, but when the pipes are still held `releaseAfterMs`
 * after the shell exits and `canRelease()` agrees, settles as "released" and
 * leaves the pipes open for the caller.
 */
function waitOrRelease(child: ReturnType<typeof spawn>, releaseAfterMs: number, canRelease: () => boolean): Promise<ReleaseOutcome> {
  return new Promise<ReleaseOutcome>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => {
      timer = setTimeout(() => settle(() => resolve({ kind: canRelease() ? "released" : "held", code })), releaseAfterMs);
    });
    child.once("close", (code) => settle(() => resolve({ kind: "closed", code })));
  });
}
