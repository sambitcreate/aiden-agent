// Parent side of the kill-harness child process.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "kill-harness.mjs");

export interface HarnessChild {
  child: ChildProcess;
  /**
   * Resolves with the payload of the first stdout line tagged `tag`; with
   * `expected`, only once a `tag value` line was printed for every value.
   */
  waitFor(tag: string, timeoutMs?: number, expected?: readonly string[]): Promise<string>;
  /** SIGKILL the child and wait for it to exit. */
  kill(): Promise<void>;
}

export function spawnHarnessChild(mode: string, args: string[]): HarnessChild {
  const child = spawn(process.execPath, ["--no-warnings", "--import", tsxLoader, helper, mode, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: Array<() => void> = [];
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
    for (const waiter of waiters.splice(0)) waiter();
  });
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.once("exit", () => {
    for (const waiter of waiters.splice(0)) waiter();
  });

  return {
    child,
    waitFor(tag, timeoutMs = 20_000, expected) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child never printed ${tag}\n${stdout}\n${stderr}`)), timeoutMs);
        const check = () => {
          const match = stdout.match(new RegExp(`^${tag} (.*)$`, "mu"));
          if (match && (expected === undefined || expected.every((value) => stdout.includes(`${tag} ${value}\n`)))) {
            clearTimeout(timer);
            resolve(match[1]!);
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            clearTimeout(timer);
            reject(new Error(`child exited before ${tag}\n${stdout}\n${stderr}`));
            return;
          }
          waiters.push(check);
        };
        check();
      });
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
