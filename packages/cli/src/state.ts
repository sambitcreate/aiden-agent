import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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

/** A lock without owner.json younger than this may still be mid-acquire. */
const FRESH_LOCK_MS = 2_000;

/**
 * Whether the recorded lock owner is a live process. Returns "fresh" for a
 * missing/corrupt owner.json inside the mid-acquire window — that lock may
 * belong to a live acquirer between mkdir and the owner write.
 */
function lockOwnerIsLive(lock: string): boolean | "fresh" {
  let pid: unknown;
  try { pid = (JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown }).pid; }
  catch {
    try { if (Date.now() - statSync(lock).mtimeMs < FRESH_LOCK_MS) return "fresh"; } catch { /* gone */ }
    return false;
  }
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed holder (kill -9, power loss) leaves its lock behind; reclaim
      // it when the recorded owner is provably dead or stale debris. A live
      // owner — or one inside the mid-acquire window — keeps the lock.
      if (attempt === 0 && lockOwnerIsLive(lock) === false) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new Error(`Another Aiden process owns ${file}. If it crashed, remove ${lock} after checking the owner.json PID.`);
    }
  }
  // argv is recorded so lifecycle checks can verify the OWNER's exact
  // invocation rather than guessing from the checking process's argv/cwd.
  try { atomicJson(`${lock}/owner.json`, { pid: process.pid, argv: process.argv.slice(0, 5), startedAt: Date.now() }); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only remove the lock while owner.json still names this process. If the
    // lock was reclaimed and re-acquired meanwhile (or a fresh acquirer sits
    // between mkdir and owner write), removing it would orphan a live owner.
    // Missing/corrupt owner.json past the mid-acquire window is stale debris —
    // reclaim it rather than letting the lease wedge permanently.
    let ownerPid: number | undefined;
    try { ownerPid = (JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: number }).pid; }
    catch { /* missing/corrupt — debris rule below */ }
    if (ownerPid !== undefined) {
      if (ownerPid !== process.pid) return;
      rmSync(lock, { recursive: true, force: true });
      return;
    }
    try { if (Date.now() - statSync(lock).mtimeMs < FRESH_LOCK_MS) return; } catch { return; }
    rmSync(lock, { recursive: true, force: true });
  };
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
