import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
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

/** Exclusive across processes; contention is explicit instead of losing updates. */
export function acquireLease(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another Aiden process owns ${file}. If it crashed, remove ${lock} after checking the owner.json PID.`);
  }
  try { atomicJson(`${lock}/owner.json`, { pid: process.pid, startedAt: Date.now() }); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
  let released = false;
  return () => { if (!released) { released = true; rmSync(lock, { recursive: true, force: true }); } };
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
