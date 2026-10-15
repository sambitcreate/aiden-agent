import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tryAcquireProcessLifetimeLock } from "../../../main/services/process-lifetime-lock.ts";

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(fallback);
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
    const parent = openSync(dirname(file), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
}

/** Legacy owner metadata is consulted only after the permanent guard is held. */
function lockOwnerIsLive(lock: string): boolean {
  let owner: unknown;
  try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as unknown; }
  catch { return false; }
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return false;
  const record = owner as { pid?: unknown; protocol?: unknown };
  if (record.protocol === "flock-v1") return false;
  const pid = record.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  return false;
}

/** Exclusive across processes; contention is explicit instead of losing updates. */
export function acquireLease(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const releaseGuard = tryAcquireProcessLifetimeLock(leaseGuardPath(file), cliLeaseHelperPath());
  if (!releaseGuard) throw new Error(`Another Aiden process owns ${file}.`);
  let mayHavePublished = false;
  // argv is recorded so lifecycle checks can verify the OWNER's exact
  // invocation rather than guessing from the checking process's argv/cwd.
  try {
    if (existsSync(lock)) {
      if (lockOwnerIsLive(lock)) throw new Error(`Another Aiden process owns ${file}.`);
      rmSync(lock, { recursive: true, force: true });
    }
    mkdirSync(lock, { mode: 0o700 });
    mayHavePublished = true;
    atomicJson(`${lock}/owner.json`, { protocol: "flock-v1", pid: process.pid, argv: process.argv.slice(0, 5), startedAt: Date.now(), token: randomUUID() });
  } catch (error) {
    try { if (mayHavePublished) rmSync(lock, { recursive: true, force: true }); }
    finally { releaseGuard(); }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { rmSync(lock, { recursive: true, force: true }); }
    finally { releaseGuard(); }
  };
}

export function leaseGuardPath(file: string): string { return `${file}.lease.lock`; }

export function cliLeaseHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = process.env.AIDEN_CLI_ENTRY;
  const candidates = [
    ...(entry ? [join(dirname(entry), "native/aiden-lease-flock")] : []),
    join(here, "native/aiden-lease-flock"),
    resolve(here, "../native/aiden-lease-flock"),
    join(here, "app/native/aiden-lease-flock"),
    resolve(here, "../../../build/native/aiden-lease-flock"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export class JsonStore<T> {
  readonly file: string;
  readonly fallback: T;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(file: string, fallback: T) { this.file = file; this.fallback = fallback; }
  async load(): Promise<T> { return readJson(this.file, this.fallback); }
  async save(value: T): Promise<void> { await this.update(() => value, undefined, true); }
  update<R>(mutation: (draft: T) => R | Promise<R>, isCurrent?: () => boolean, replace = false): Promise<R> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      const release = acquireLease(this.file);
      try {
        const draft = await this.load();
        const result = await mutation(draft);
        if (isCurrent && !isCurrent()) throw new Error("The operation was cancelled.");
        atomicJson(this.file, replace ? result : draft);
        return result;
      } finally { release(); }
    });
    this.tail = operation;
    return operation;
  }
}

/** Shell-like quoting for slash commands, without expansion or execution. */
export function splitArgs(input: string): string[] {
  const output: string[] = [];
  let token = "", quote = "", escaped = false, started = false;
  for (const char of input) {
    if (escaped) { token += char; escaped = false; started = true; }
    else if (char === "\\" && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ""; else token += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) output.push(token); token = ""; started = false; }
    else { token += char; started = true; }
  }
  if (quote || escaped) throw new Error("Unfinished quote or escape.");
  if (started) output.push(token);
  return output;
}
