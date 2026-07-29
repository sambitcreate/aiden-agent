import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type SubagentRunStoreGeneration = "missing" | string;

export type SubagentRunStoreReadResult =
  | {
      status: "missing";
      contents: undefined;
      generation: "missing";
    }
  | {
      status: "oversized";
      contents: undefined;
      generation: string;
    }
  | {
      status: "data";
      contents: Buffer;
      generation: string;
    };

export interface SubagentRunStoreStorage {
  cleanup(): Promise<boolean>;
  read(): Promise<SubagentRunStoreReadResult>;
  write(expected: SubagentRunStoreGeneration, contents: string): Promise<string>;
  syncDirectory(): Promise<void>;
  close(): Promise<void>;
}

export class SubagentRunStoreStorageError extends Error {
  readonly name = "SubagentRunStoreStorageError";

  constructor(readonly failure: "destination_changed" | "io_failed" | "invalid_input") {
    super(
      failure === "destination_changed"
        ? "Subagent run storage changed and was preserved."
        : "Subagent run storage is unavailable.",
    );
  }
}

function defaultStorageBinary(): string {
  if (
    process.defaultApp !== true &&
    typeof process.resourcesPath === "string" &&
    process.resourcesPath.length > 0
  ) {
    return path.resolve(process.resourcesPath, "..", "Helpers", "aiden-subagent-run-store");
  }
  return path.resolve(process.cwd(), "build", "native", "aiden-subagent-run-store");
}

function safeGeneration(value: string): boolean {
  return value === "missing" || /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u.test(value);
}

class NativeSubagentRunStoreStorage implements SubagentRunStoreStorage {
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private output = "";
  private outputBytes = 0;
  private readonly lines: string[] = [];
  private readonly lineWaiters: Array<{
    resolve: (line: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  private stderr = "";
  private failure: Error | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly binary = defaultStorageBinary(),
  ) {}

  private setReferenced(referenced: boolean): void {
    const child = this.child;
    if (!child) return;
    if (referenced) child.ref();
    else child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const referenceable = stream as typeof stream & { ref?: () => void; unref?: () => void };
      if (referenced) referenceable.ref?.();
      else referenceable.unref?.();
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.lineWaiters.splice(0)) waiter.reject(error);
  }

  private acceptOutput(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength;
    if (this.outputBytes > MAX_RESPONSE_BYTES) {
      this.child?.kill("SIGKILL");
      this.fail(new SubagentRunStoreStorageError("io_failed"));
      return;
    }
    this.output += chunk.toString("utf8");
    for (;;) {
      const newline = this.output.indexOf("\n");
      if (newline < 0) break;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      this.outputBytes = Buffer.byteLength(this.output, "utf8");
      const waiter = this.lineWaiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  private nextLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.lineWaiters.push({ resolve, reject });
    });
  }

  private async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = (async () => {
        const child = spawn(this.binary, ["serve", "--directory", this.directory], {
          detached: false,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        child.stdout.on("data", (chunk: Buffer) => this.acceptOutput(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
          if (this.stderr.length < 16 * 1024) this.stderr += chunk.toString("utf8");
        });
        child.once("error", () => this.fail(new SubagentRunStoreStorageError("io_failed")));
        child.once("close", () => {
          const detail = this.stderr.trim();
          this.fail(
            new Error(
              detail
                ? `Subagent run storage helper stopped: ${detail}`
                : "Subagent run storage helper stopped.",
            ),
          );
        });
        const handshake = await this.withTimeout(this.nextLine());
        if (handshake !== "ready") {
          child.kill("SIGKILL");
          throw new SubagentRunStoreStorageError("io_failed");
        }
        this.setReferenced(false);
      })();
    }
    return this.startPromise;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.child?.kill("SIGKILL");
            reject(new SubagentRunStoreStorageError("io_failed"));
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async request(command: string): Promise<string> {
    let response = "";
    const result = this.operationTail.then(
      async () => {
        await this.start();
        const child = this.child;
        if (!child || this.failure)
          throw this.failure ?? new SubagentRunStoreStorageError("io_failed");
        this.setReferenced(true);
        try {
          await this.withTimeout(
            new Promise<void>((resolve, reject) => {
              child.stdin.write(`${command}\n`, (error) => {
                if (error) reject(new SubagentRunStoreStorageError("io_failed"));
                else resolve();
              });
            }),
          );
          response = await this.withTimeout(this.nextLine());
        } finally {
          this.setReferenced(false);
        }
      },
      async () => {
        throw this.failure ?? new SubagentRunStoreStorageError("io_failed");
      },
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
    if (response.startsWith("error ")) {
      const failure = response.slice(6);
      if (
        failure === "destination_changed" ||
        failure === "io_failed" ||
        failure === "invalid_input"
      ) {
        throw new SubagentRunStoreStorageError(failure);
      }
      throw new SubagentRunStoreStorageError("io_failed");
    }
    return response;
  }

  async cleanup(): Promise<boolean> {
    const response = await this.request("cleanup");
    if (response === "ok 0") return false;
    if (response === "ok 1") return true;
    throw new SubagentRunStoreStorageError("io_failed");
  }

  async read(): Promise<SubagentRunStoreReadResult> {
    const response = await this.request("read");
    if (response === "missing") {
      return { status: "missing", contents: undefined, generation: "missing" };
    }
    if (response.startsWith("oversize ")) {
      const generation = response.slice(9);
      if (!safeGeneration(generation)) throw new SubagentRunStoreStorageError("io_failed");
      return { status: "oversized", contents: undefined, generation };
    }
    const match = /^data ([0-9a-f]+(?:-[0-9a-f]+){8}) ([A-Za-z0-9+/]*={0,2})$/u.exec(response);
    if (!match) throw new SubagentRunStoreStorageError("io_failed");
    return {
      status: "data",
      generation: match[1],
      contents: Buffer.from(match[2], "base64"),
    };
  }

  async write(expected: SubagentRunStoreGeneration, contents: string): Promise<string> {
    if (!safeGeneration(expected)) throw new SubagentRunStoreStorageError("invalid_input");
    const response = await this.request(
      `write ${expected} ${Buffer.from(contents, "utf8").toString("base64")}`,
    );
    const match = /^ok ([0-9a-f]+(?:-[0-9a-f]+){8})$/u.exec(response);
    if (!match) throw new SubagentRunStoreStorageError("io_failed");
    return match[1];
  }

  async syncDirectory(): Promise<void> {
    if ((await this.request("sync")) !== "ok") {
      throw new SubagentRunStoreStorageError("io_failed");
    }
  }

  async close(): Promise<void> {
    if (!this.startPromise || this.failure) return;
    try {
      await this.request("close");
    } finally {
      this.child?.stdin.end();
    }
  }
}

export function createNativeSubagentRunStoreStorage(
  directory: string,
  binary?: string,
): SubagentRunStoreStorage {
  if (!path.isAbsolute(directory)) {
    throw new Error("Subagent run storage requires an absolute directory.");
  }
  return new NativeSubagentRunStoreStorage(directory, binary);
}
