import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import * as path from "node:path";
import { trackDiagnosticChild } from "../performance-child.js";
import {
  assertPreparedSubagentFileMutation,
  assertSubagentFileInspection,
  canonicalSubagentFileEffectId,
  canonicalSubagentFileRelativePath,
  type PreparedSubagentFileMutation,
  type SubagentFileInspection,
  type SubagentWorkspaceRootIdentity,
} from "./subagent-file-mutation-core.js";

const MAX_RESPONSE_BYTES = 275_000;
const MAX_COMMAND_BYTES = 275_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RECOVERY_NAME = /^\.aiden-subagent-file-[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[a-f0-9-]{36}\.tmp$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type SubagentFileMutatorFailure =
  | "cancelled"
  | "conflict"
  | "indeterminate"
  | "invalid_input"
  | "io_failed";

export class SubagentFileMutatorError extends Error {
  readonly name = "SubagentFileMutatorError";

  constructor(readonly failure: SubagentFileMutatorFailure) {
    super(
      failure === "cancelled"
        ? "The workspace file operation was cancelled."
        : failure === "conflict"
          ? "The workspace file changed and was preserved."
          : failure === "indeterminate"
            ? "The workspace file operation outcome is unknown. Aiden did not remove any recovery artifact it could verify."
            : failure === "invalid_input"
              ? "The workspace file operation request is invalid."
              : "The workspace file operation could not be completed safely.",
    );
  }
}

export interface SubagentFileMutatorRuntimePaths {
  defaultApp: boolean;
  resourcesPath?: string;
  cwd: string;
}

export function resolveSubagentFileMutatorBinary(
  runtime: SubagentFileMutatorRuntimePaths = {
    defaultApp: process.defaultApp === true,
    resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
    cwd: process.cwd(),
  },
): string {
  if (
    runtime.defaultApp !== true &&
    typeof runtime.resourcesPath === "string" &&
    runtime.resourcesPath.length > 0
  ) {
    return path.resolve(runtime.resourcesPath, "..", "Helpers", "aiden-subagent-file-mutator");
  }
  return path.resolve(runtime.cwd, "build", "native", "aiden-subagent-file-mutator");
}

type SpawnMutator = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface CreateSubagentFileMutatorClientOptions {
  workspaceRoot: Readonly<SubagentWorkspaceRootIdentity>;
  binary?: string;
  requestTimeoutMs?: number;
  /** Optional narrower effectful timeout; defaults to the general request timeout. */
  effectfulRequestTimeoutMs?: number;
  spawnProcess?: SpawnMutator;
}

export interface SubagentFileMutationCommit {
  effectId: string;
  effectDigest: string;
  postimageSha256: string;
  postimageBytes: number;
  recoveryName?: string;
}

type ClientState =
  | { kind: "idle" }
  | { kind: "inspected"; inspection: Readonly<SubagentFileInspection> }
  | { kind: "prepared"; effect: PreparedSubagentFileMutation }
  | {
      kind: "committed" | "indeterminate";
      effect: PreparedSubagentFileMutation;
      recoveryName?: string;
    }
  | { kind: "closed" };

function validDecimalIdentity(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function encodeProtocolValue(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded || "-";
}

function decodeProtocolText(value: string, bytes: number): string {
  if (value === "-") {
    if (bytes !== 0) throw new SubagentFileMutatorError("io_failed");
    return "";
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new SubagentFileMutatorError("io_failed");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) {
    throw new SubagentFileMutatorError("io_failed");
  }
  const text = decoded.toString("utf8");
  if (Buffer.from(text, "utf8").compare(decoded) !== 0) {
    throw new SubagentFileMutatorError("io_failed");
  }
  return text;
}

function nativeFailure(value: string): SubagentFileMutatorFailure | undefined {
  if (
    value === "conflict" ||
    value === "indeterminate" ||
    value === "invalid_input" ||
    value === "io_failed"
  ) {
    return value;
  }
  return undefined;
}

export class SubagentFileMutatorClient {
  private readonly workspaceRoot: Readonly<SubagentWorkspaceRootIdentity>;
  private readonly binary: string;
  private readonly requestTimeoutMs: number;
  private readonly effectfulRequestTimeoutMs: number;
  private readonly spawnProcess: SpawnMutator;
  private readonly trackChildDiagnostics: boolean;
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private closedPromise: Promise<void> | undefined;
  private output = "";
  private outputBytes = 0;
  private queuedLineBytes = 0;
  private readonly lines: string[] = [];
  private readonly lineWaiters: Array<{
    resolve(line: string): void;
    reject(error: unknown): void;
  }> = [];
  private failure: SubagentFileMutatorError | undefined;
  private closing = false;
  private state: ClientState = { kind: "idle" };
  private operationTail: Promise<void> = Promise.resolve();
  private stateTail: Promise<void> = Promise.resolve();

  constructor(options: CreateSubagentFileMutatorClientOptions) {
    if (
      !path.isAbsolute(options.workspaceRoot.canonicalPath) ||
      options.workspaceRoot.canonicalPath.includes("\0") ||
      !validDecimalIdentity(options.workspaceRoot.device) ||
      !validDecimalIdentity(options.workspaceRoot.inode) ||
      !Number.isFinite(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) ||
      (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) <= 0 ||
      !Number.isFinite(
        options.effectfulRequestTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ) ||
      (options.effectfulRequestTimeoutMs ??
        options.requestTimeoutMs ??
        DEFAULT_REQUEST_TIMEOUT_MS) <= 0
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    this.workspaceRoot = Object.freeze({ ...options.workspaceRoot });
    this.binary = options.binary ?? resolveSubagentFileMutatorBinary();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.effectfulRequestTimeoutMs = options.effectfulRequestTimeoutMs ?? this.requestTimeoutMs;
    this.spawnProcess = options.spawnProcess ?? (spawn as SpawnMutator);
    this.trackChildDiagnostics = options.spawnProcess === undefined;
  }

  get currentState(): ClientState["kind"] {
    return this.state.kind;
  }

  private stateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation);
    this.stateTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private setReferenced(referenced: boolean): void {
    const child = this.child;
    if (!child) return;
    if (referenced) child.ref();
    else child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const referenceable = stream as typeof stream & {
        ref?: () => void;
        unref?: () => void;
      };
      if (referenced) referenceable.ref?.();
      else referenceable.unref?.();
    }
  }

  private fail(error: SubagentFileMutatorError): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.lineWaiters.splice(0)) waiter.reject(error);
  }

  private terminate(error: SubagentFileMutatorError): void {
    this.fail(error);
    this.child?.kill("SIGKILL");
  }

  private acceptOutput(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength;
    if (this.outputBytes > MAX_RESPONSE_BYTES) {
      this.terminate(new SubagentFileMutatorError("io_failed"));
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
      else {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        this.queuedLineBytes += lineBytes;
        if (this.lines.length >= 1 || this.queuedLineBytes > MAX_RESPONSE_BYTES) {
          this.terminate(new SubagentFileMutatorError("io_failed"));
          return;
        }
        this.lines.push(line);
      }
    }
  }

  private nextLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) {
      this.queuedLineBytes -= Buffer.byteLength(line, "utf8") + 1;
      return Promise.resolve(line);
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.lineWaiters.push({ resolve, reject });
    });
  }

  private async bounded<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    timeoutFailure: () => SubagentFileMutatorError,
    abortFailure: () => SubagentFileMutatorError = () => new SubagentFileMutatorError("cancelled"),
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (signal?.aborted) throw new SubagentFileMutatorError("cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          const stop = (failure: () => SubagentFileMutatorError) => {
            const error = failure();
            this.terminate(error);
            reject(error);
          };
          timer = setTimeout(() => stop(timeoutFailure), timeoutMs);
          if (signal) {
            const abort = () => stop(abortFailure);
            signal.addEventListener("abort", abort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", abort);
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort();
    }
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (!this.startPromise && signal?.aborted) {
      throw new SubagentFileMutatorError("cancelled");
    }
    if (!this.startPromise) {
      const starting = (async () => {
        const child = this.spawnProcess(
          this.binary,
          [
            "serve",
            "--root",
            this.workspaceRoot.canonicalPath,
            "--device",
            this.workspaceRoot.device,
            "--inode",
            this.workspaceRoot.inode,
          ],
          {
            cwd: "/",
            detached: false,
            env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        if (this.trackChildDiagnostics) {
          trackDiagnosticChild("subagent-file-mutator", child);
        }
        this.child = child;
        child.stdout.on("data", (chunk: Buffer) => this.acceptOutput(chunk));
        child.stderr.resume();
        child.once("error", () => this.fail(new SubagentFileMutatorError("io_failed")));
        this.closedPromise = new Promise<void>((resolve) => {
          child.once("close", () => {
            if (!this.closing) this.fail(new SubagentFileMutatorError("io_failed"));
            resolve();
          });
        });
        const handshake = await this.bounded(
          this.nextLine(),
          signal,
          () => new SubagentFileMutatorError("io_failed"),
        );
        if (handshake !== "ready") {
          this.terminate(new SubagentFileMutatorError("io_failed"));
          throw new SubagentFileMutatorError("io_failed");
        }
        this.setReferenced(false);
      })();
      this.startPromise = starting.catch((error) => {
        if (!this.child) this.startPromise = undefined;
        throw error;
      });
    }
    return this.startPromise;
  }

  private async request(command: string, signal?: AbortSignal, effectful = false): Promise<string> {
    if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    let response = "";
    let sent = false;
    const result = this.operationTail.then(async () => {
      await this.start(signal);
      const child = this.child;
      if (!child || this.failure) {
        throw this.failure ?? new SubagentFileMutatorError("io_failed");
      }
      if (signal?.aborted) throw new SubagentFileMutatorError("cancelled");
      this.setReferenced(true);
      try {
        sent = effectful;
        await this.bounded(
          new Promise<void>((resolve, reject) => {
            child.stdin.write(`${command}\n`, (error) => {
              if (error) reject(new SubagentFileMutatorError("io_failed"));
              else resolve();
            });
          }),
          signal,
          () => new SubagentFileMutatorError(effectful && sent ? "indeterminate" : "io_failed"),
          () => new SubagentFileMutatorError(effectful && sent ? "indeterminate" : "cancelled"),
          effectful ? this.effectfulRequestTimeoutMs : this.requestTimeoutMs,
        );
        response = await this.bounded(
          this.nextLine(),
          signal,
          () => new SubagentFileMutatorError(effectful && sent ? "indeterminate" : "io_failed"),
          () => new SubagentFileMutatorError(effectful && sent ? "indeterminate" : "cancelled"),
          effectful ? this.effectfulRequestTimeoutMs : this.requestTimeoutMs,
        );
      } catch (error) {
        if (effectful && sent) {
          throw new SubagentFileMutatorError("indeterminate");
        }
        throw error;
      } finally {
        this.setReferenced(false);
      }
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
    if (response.startsWith("error ")) {
      const failure = nativeFailure(response.slice(6));
      if (failure) throw new SubagentFileMutatorError(failure);
      throw new SubagentFileMutatorError("io_failed");
    }
    return response;
  }

  inspect(
    effectIdValue: string,
    relativePathValue: string,
    signal?: AbortSignal,
  ): Promise<Readonly<SubagentFileInspection>> {
    return this.stateOperation(() =>
      this.inspectUnlocked(effectIdValue, relativePathValue, signal),
    );
  }

  private async inspectUnlocked(
    effectIdValue: string,
    relativePathValue: string,
    signal?: AbortSignal,
  ): Promise<Readonly<SubagentFileInspection>> {
    if (this.state.kind !== "idle") throw new SubagentFileMutatorError("invalid_input");
    let effectId: string;
    let relativePath: string;
    try {
      effectId = canonicalSubagentFileEffectId(effectIdValue);
      relativePath = canonicalSubagentFileRelativePath(relativePathValue);
    } catch {
      throw new SubagentFileMutatorError("invalid_input");
    }
    const response = await this.request(
      `inspect ${effectId} ${encodeProtocolValue(relativePath)}`,
      signal,
    );
    let inspection: Readonly<SubagentFileInspection>;
    if (response === `inspected ${effectId} absent`) {
      inspection = Object.freeze({
        version: 1 as const,
        effectId,
        workspaceRoot: this.workspaceRoot,
        relativePath,
        expectedRevision: "absent" as const,
      });
    } else {
      const match =
        /^inspected ([A-Za-z0-9_-]{1,64}) ([a-f0-9]{64}) ([0-9]+) ([A-Za-z0-9+/=]+|-)$/u.exec(
          response,
        );
      if (!match || match[1] !== effectId || !SHA256.test(match[2])) {
        this.terminate(new SubagentFileMutatorError("io_failed"));
        throw new SubagentFileMutatorError("io_failed");
      }
      const bytes = Number(match[3]);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        this.terminate(new SubagentFileMutatorError("io_failed"));
        throw new SubagentFileMutatorError("io_failed");
      }
      const currentContent = decodeProtocolText(match[4], bytes);
      inspection = Object.freeze({
        version: 1 as const,
        effectId,
        workspaceRoot: this.workspaceRoot,
        relativePath,
        expectedRevision: match[2],
        currentContent,
      });
    }
    try {
      assertSubagentFileInspection(inspection);
    } catch {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    this.state = { kind: "inspected", inspection };
    return inspection;
  }

  async prepare(effectValue: PreparedSubagentFileMutation, signal?: AbortSignal): Promise<void> {
    let effect: PreparedSubagentFileMutation;
    try {
      assertPreparedSubagentFileMutation(effectValue);
      effect = Object.freeze({
        ...effectValue,
        workspaceRoot: Object.freeze({ ...effectValue.workspaceRoot }),
        postimage: Object.freeze({ ...effectValue.postimage }),
      });
      assertPreparedSubagentFileMutation(effect);
    } catch {
      throw new SubagentFileMutatorError("invalid_input");
    }
    return this.stateOperation(() => this.prepareUnlocked(effect, signal));
  }

  private async prepareUnlocked(
    effect: PreparedSubagentFileMutation,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = this.state;
    if (current.kind !== "inspected") {
      throw new SubagentFileMutatorError("invalid_input");
    }
    try {
      assertPreparedSubagentFileMutation(effect);
    } catch {
      throw new SubagentFileMutatorError("invalid_input");
    }
    if (
      effect.workspaceRoot.canonicalPath !== this.workspaceRoot.canonicalPath ||
      effect.workspaceRoot.device !== this.workspaceRoot.device ||
      effect.workspaceRoot.inode !== this.workspaceRoot.inode
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    if (
      effect.effectId !== current.inspection.effectId ||
      effect.relativePath !== current.inspection.relativePath ||
      effect.expectedRevision !== current.inspection.expectedRevision
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    const response = await this.request(
      [
        "prepare-inspected",
        effect.effectId,
        effect.expectedRevision,
        encodeProtocolValue(effect.postimage.content),
      ].join(" "),
      signal,
    );
    try {
      assertPreparedSubagentFileMutation(effect);
    } catch {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    const match = /^prepared ([A-Za-z0-9_-]{1,64}) ([a-f0-9]{64}) ([0-9]+)$/u.exec(response);
    if (
      !match ||
      match[1] !== effect.effectId ||
      match[2] !== effect.postimage.sha256 ||
      Number(match[3]) !== effect.postimage.bytes
    ) {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    this.state = { kind: "prepared", effect };
  }

  commit(effectId: string, signal?: AbortSignal): Promise<SubagentFileMutationCommit> {
    return this.stateOperation(() => this.commitUnlocked(effectId, signal));
  }

  private async commitUnlocked(
    effectId: string,
    signal?: AbortSignal,
  ): Promise<SubagentFileMutationCommit> {
    const current = this.state;
    if (current.kind !== "prepared" || current.effect.effectId !== effectId) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    let response: string;
    try {
      response = await this.request(`commit ${effectId}`, signal, true);
    } catch (error) {
      if (error instanceof SubagentFileMutatorError) {
        if (error.failure === "conflict") this.state = { kind: "idle" };
        else if (error.failure === "indeterminate") {
          this.state = { kind: "indeterminate", effect: current.effect };
        } else if (error.failure === "io_failed") {
          this.state = { kind: "idle" };
        }
      }
      throw error;
    }
    const match =
      /^committed ([A-Za-z0-9_-]{1,64}) ([a-f0-9]{64}) ([0-9]+) (none|\.aiden-subagent-file-[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[a-f0-9-]{36}\.tmp)$/u.exec(
        response,
      );
    const recoveryName = match?.[4] === "none" ? undefined : match?.[4];
    if (
      !match ||
      match[1] !== effectId ||
      !SHA256.test(match[2]) ||
      match[2] !== current.effect.postimage.sha256 ||
      Number(match[3]) !== current.effect.postimage.bytes ||
      (recoveryName !== undefined && !RECOVERY_NAME.test(recoveryName)) ||
      (recoveryName !== undefined &&
        !recoveryName.startsWith(`.aiden-subagent-file-${effectId}-`)) ||
      (current.effect.expectedRevision === "absent") !== (recoveryName === undefined)
    ) {
      this.terminate(new SubagentFileMutatorError("indeterminate"));
      this.state = { kind: "indeterminate", effect: current.effect };
      throw new SubagentFileMutatorError("indeterminate");
    }
    this.state = recoveryName
      ? { kind: "committed", effect: current.effect, recoveryName }
      : { kind: "idle" };
    return {
      effectId,
      effectDigest: current.effect.effectDigest,
      postimageSha256: current.effect.postimage.sha256,
      postimageBytes: current.effect.postimage.bytes,
      ...(recoveryName ? { recoveryName } : {}),
    };
  }

  finalize(effectId: string, signal?: AbortSignal): Promise<void> {
    return this.stateOperation(() => this.finalizeUnlocked(effectId, signal));
  }

  private async finalizeUnlocked(effectId: string, signal?: AbortSignal): Promise<void> {
    const current = this.state;
    if (
      (current.kind !== "committed" && current.kind !== "indeterminate") ||
      current.effect.effectId !== effectId
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    let response: string;
    try {
      response = await this.request(`finalize ${effectId}`, signal, true);
    } catch (error) {
      if (error instanceof SubagentFileMutatorError && error.failure === "indeterminate") {
        this.state = { ...current, kind: "indeterminate" };
      }
      throw error;
    }
    if (response !== `finalized ${effectId}`) {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    this.state = { kind: "idle" };
  }

  preserve(effectId: string, signal?: AbortSignal): Promise<void> {
    return this.stateOperation(() => this.preserveUnlocked(effectId, signal));
  }

  private async preserveUnlocked(effectId: string, signal?: AbortSignal): Promise<void> {
    const current = this.state;
    if (
      (current.kind !== "committed" && current.kind !== "indeterminate") ||
      current.effect.effectId !== effectId
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    let response: string;
    try {
      response = await this.request(`preserve ${effectId}`, signal, true);
    } catch (error) {
      if (error instanceof SubagentFileMutatorError && error.failure === "indeterminate") {
        this.state = { ...current, kind: "indeterminate" };
      }
      throw error;
    }
    if (response !== `preserved ${effectId}`) {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    this.state = { kind: "idle" };
  }

  cancel(effectId: string, signal?: AbortSignal): Promise<void> {
    return this.stateOperation(() => this.cancelUnlocked(effectId, signal));
  }

  private async cancelUnlocked(effectId: string, signal?: AbortSignal): Promise<void> {
    const current = this.state;
    if (
      (current.kind !== "inspected" && current.kind !== "prepared") ||
      (current.kind === "inspected"
        ? current.inspection.effectId !== effectId
        : current.effect.effectId !== effectId)
    ) {
      throw new SubagentFileMutatorError("invalid_input");
    }
    const response = await this.request(`cancel ${effectId}`, signal);
    if (response !== `cancelled ${effectId}`) {
      this.terminate(new SubagentFileMutatorError("io_failed"));
      throw new SubagentFileMutatorError("io_failed");
    }
    this.state = { kind: "idle" };
  }

  close(signal?: AbortSignal): Promise<void> {
    return this.stateOperation(() => this.closeUnlocked(signal));
  }

  private async closeUnlocked(signal?: AbortSignal): Promise<void> {
    if (this.state.kind === "closed") return;
    if (!this.startPromise) {
      this.state = { kind: "closed" };
      return;
    }
    if (this.failure) {
      await this.killAndDrain();
      this.state = { kind: "closed" };
      return;
    }
    try {
      if (this.state.kind === "inspected") {
        await this.cancelUnlocked(this.state.inspection.effectId, signal);
      }
      if (this.state.kind === "prepared") {
        await this.cancelUnlocked(this.state.effect.effectId, signal);
      }
      if (this.state.kind === "committed" || this.state.kind === "indeterminate") {
        await this.preserveUnlocked(this.state.effect.effectId, signal);
      }
      this.closing = true;
      if ((await this.request("close", signal)) !== "ok") {
        throw new SubagentFileMutatorError("io_failed");
      }
      this.child?.stdin.end();
      if (this.closedPromise) {
        await this.bounded(
          this.closedPromise,
          signal,
          () => new SubagentFileMutatorError("io_failed"),
        );
      }
      this.state = { kind: "closed" };
    } catch (error) {
      await this.killAndDrain();
      this.state = { kind: "closed" };
      throw error;
    }
  }

  private async killAndDrain(): Promise<void> {
    this.child?.kill("SIGKILL");
    const closed = this.closedPromise;
    if (!closed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.requestTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

export function createSubagentFileMutatorClient(
  options: CreateSubagentFileMutatorClientOptions,
): SubagentFileMutatorClient {
  return new SubagentFileMutatorClient(options);
}
