import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  AMBIENT_MUSIC_VISUALIZER_BAND_COUNT,
  type AmbientMusicMetrics,
  type AmbientMusicModelId,
  type AmbientMusicSnapshot,
  type AmbientMusicSupportReason,
} from "../../renderer/shared/ambient-music.js";
import {
  AmbientMusicValidationError,
  parseAmbientMusicPlaybackProjection,
  shouldApplyAmbientMusicPlayback,
  validateAmbientMusicModel,
  validateAmbientMusicPromptMix,
  validateAmbientMusicVolume,
  validateAmbientMusicWeights,
} from "./ambient-music-core.js";
import {
  acceptAmbientMusicEventSequence,
  AMBIENT_MUSIC_PROTOCOL_VERSION,
  AmbientMusicProtocolError,
  MAX_AMBIENT_MUSIC_MESSAGE_BYTES,
  parseAmbientMusicHelperMessage,
  type AmbientMusicHelperEvent,
  type AmbientMusicHelperMethod,
  type AmbientMusicHelperRequest,
  type AmbientMusicHelperResponse,
} from "./ambient-music-protocol.js";

const HELPER_APP_NAME = "Aiden Ambient Music Helper.app";
const HELPER_EXECUTABLE = "aiden-ambient-music-helper";
const HELPER_BUILD_IDENTITY = "aiden-ambient-music-helper/1";
const START_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 3 * 60_000;
const PROMPT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const FORCE_REAP_TIMEOUT_MS = 2_000;
const IDLE_UNLOAD_MS = 5 * 60_000;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

interface TrustedHelperError {
  code: string;
  message: string;
  retryable: boolean;
}

const RESPONSE_HELPER_ERRORS: Readonly<Record<string, TrustedHelperError>> = Object.freeze({
  unsupported_protocol: {
    code: "unsupported_protocol",
    message: "The installed Ambient Music helper is incompatible with this version of Aiden.",
    retryable: false,
  },
  invalid_request: {
    code: "invalid_request",
    message: "Ambient Music rejected an invalid local command.",
    retryable: false,
  },
  duplicate_request: {
    code: "duplicate_request",
    message: "Ambient Music rejected a duplicate local command.",
    retryable: true,
  },
  model_load_failed: {
    code: "model_load_failed",
    message: "Ambient Music could not load the verified model.",
    retryable: true,
  },
  prompt_encoding_failed: {
    code: "prompt_encoding_failed",
    message: "Ambient Music could not encode this prompt mix.",
    retryable: true,
  },
  model_not_loaded: {
    code: "model_not_loaded",
    message: "Download and load Ambient Music before using it.",
    retryable: true,
  },
  unknown_method: {
    code: "unknown_method",
    message: "The installed Ambient Music helper does not support this command.",
    retryable: false,
  },
  internal_failure: {
    code: "helper_failed",
    message: "The Ambient Music helper could not complete the request.",
    retryable: true,
  },
});

const FATAL_HELPER_ERRORS: Readonly<Record<string, TrustedHelperError>> = Object.freeze({
  invalid_model_root: {
    code: "invalid_model_root",
    message: "Ambient Music could not open the verified model install.",
    retryable: true,
  },
  invalid_arguments: {
    code: "helper_launch_failed",
    message: "Ambient Music could not start its local helper.",
    retryable: true,
  },
  audio_unavailable: {
    code: "audio_unavailable",
    message: "Ambient Music could not open the current audio output.",
    retryable: true,
  },
  stdin_unavailable: {
    code: "helper_channel_failed",
    message: "Ambient Music could not open its local command channel.",
    retryable: true,
  },
});

function trustedHelperError(
  errors: Readonly<Record<string, TrustedHelperError>>,
  code: unknown,
): TrustedHelperError | undefined {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(errors, code)
    ? errors[code]
    : undefined;
}

export interface AmbientMusicVerifiedInstall {
  root: string;
  revision: string;
  verified: true;
}

interface PendingRequest {
  generation: number;
  resolve(response: AmbientMusicHelperResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface HelperProcess {
  child: ChildProcessWithoutNullStreams;
  generation: number;
  modelRoot: string;
  stdoutBuffer: string;
  stderrBytes: number;
  eventSequence: number;
  playbackRevision: number;
  readySettled: boolean;
  resolveReady(): void;
  rejectReady(error: Error): void;
  readyPromise: Promise<void>;
  expectedExit: boolean;
  terminalError?: AmbientMusicServiceError;
  terminationPromise?: Promise<void>;
  resolveReaped(): void;
  reapPromise: Promise<void>;
}

interface RecoverableSession {
  install: AmbientMusicVerifiedInstall;
  model: AmbientMusicModelId;
  prompts?: string[];
  weights?: number[];
  volumeDB: number;
  drumless: boolean;
  variation: number;
}

type SpawnHelper = (
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface AmbientMusicServiceOptions {
  supported?: boolean;
  supportReason?: AmbientMusicSupportReason;
  helperExecutablePath?: () => string;
  spawnHelper?: SpawnHelper;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  loadTimeoutMs?: number;
  promptTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  forceReapTimeoutMs?: number;
  idleUnloadMs?: number;
  maxStderrBytes?: number;
  warn?: (message: string, error: unknown) => void;
}

export class AmbientMusicServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AmbientMusicServiceError";
  }
}

function safeHelperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function systemVersionMajor(): number {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string };
  const match = /^(\d+)/u.exec(electronProcess.getSystemVersion?.() ?? "0");
  return match ? Number.parseInt(match[1], 10) : 0;
}

function defaultSupportReason(): AmbientMusicSupportReason | undefined {
  if (process.platform !== "darwin") return "unsupported_platform";
  if (process.arch !== "arm64") return "requires_apple_silicon";
  if (systemVersionMajor() < 14) return "requires_macos_14";
  return undefined;
}

function initialSnapshot(supported: boolean, supportReason?: AmbientMusicSupportReason): AmbientMusicSnapshot {
  return {
    revision: 0,
    supported,
    supportReason: supported ? undefined : (supportReason ?? "unsupported_platform"),
    helper: supported ? "stopped" : "unsupported",
    playback: "stopped",
    promptReady: false,
  };
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseVisualizerBands(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== AMBIENT_MUSIC_VISUALIZER_BAND_COUNT ||
    value.some((band) => typeof band !== "number" || !Number.isFinite(band) || band < 0 || band > 1)
  ) {
    throw new AmbientMusicServiceError(
      "invalid_metrics",
      "The Ambient Music helper returned invalid metrics.",
    );
  }
  return value as number[];
}

function parseMetrics(result: Record<string, unknown> | undefined): AmbientMusicMetrics {
  const transformerMs = finiteMetric(result?.transformerMs);
  const frameMs = finiteMetric(result?.frameMs);
  const bufferAvailable = finiteMetric(result?.bufferAvailable);
  const bufferCapacity = finiteMetric(result?.bufferCapacity);
  const droppedFrames = finiteMetric(result?.droppedFrames);
  if (
    transformerMs === null ||
    frameMs === null ||
    bufferAvailable === null ||
    bufferCapacity === null ||
    bufferCapacity <= 0 ||
    bufferAvailable > bufferCapacity ||
    droppedFrames === null ||
    !Number.isSafeInteger(droppedFrames)
  ) {
    throw new AmbientMusicServiceError("invalid_metrics", "The Ambient Music helper returned invalid metrics.");
  }
  return {
    transformerMs,
    frameMs,
    bufferAvailable,
    bufferCapacity,
    droppedFrames,
    visualizerBands: parseVisualizerBands(result?.visualizerBands),
  };
}

function asServiceError(error: unknown): AmbientMusicServiceError {
  if (error instanceof AmbientMusicServiceError) return error;
  if (error instanceof AmbientMusicValidationError) {
    return new AmbientMusicServiceError(error.code, error.message);
  }
  return new AmbientMusicServiceError("ambient_music_failed", "Ambient Music could not complete the operation.", true);
}

export class AmbientMusicService {
  private snapshotValue: AmbientMusicSnapshot;
  private processRecord: HelperProcess | null = null;
  private processGeneration = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(snapshot: AmbientMusicSnapshot) => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposalPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private recoverableSession: RecoverableSession | null = null;
  private systemSuspended = false;
  private systemSuspendEpoch = 0;
  private playbackActivityGeneration = 0;
  private readonly supported: boolean;
  private readonly helperPath: () => string;
  private resolvedHelperExecutable?: string;
  private readonly spawnHelper: SpawnHelper;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly forceReapTimeoutMs: number;
  private readonly idleUnloadMs: number;
  private readonly maxStderrBytes: number;
  private readonly warn: (message: string, error: unknown) => void;

  constructor(options: AmbientMusicServiceOptions = {}) {
    const supportReason = options.supportReason ?? defaultSupportReason();
    this.supported = options.supported ?? supportReason === undefined;
    this.snapshotValue = initialSnapshot(this.supported, supportReason);
    this.helperPath = options.helperExecutablePath ?? (() =>
      path.join(process.cwd(), "build", "native", HELPER_APP_NAME, "Contents", "MacOS", HELPER_EXECUTABLE));
    this.spawnHelper = options.spawnHelper ?? ((executable, args, spawnOptions) =>
      spawn(executable, args, spawnOptions));
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    this.forceReapTimeoutMs = options.forceReapTimeoutMs ?? FORCE_REAP_TIMEOUT_MS;
    this.idleUnloadMs = options.idleUnloadMs ?? IDLE_UNLOAD_MS;
    this.maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
    this.warn = options.warn ?? (() => undefined);
  }

  snapshot(): AmbientMusicSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: (snapshot: AmbientMusicSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(): AmbientMusicSnapshot {
    if (!this.supported || this.disposed) return this.snapshotValue;
    let available = false;
    this.resolvedHelperExecutable = undefined;
    try {
      const executable = this.helperPath();
      const info = lstatSync(executable);
      const canonical = realpathSync(executable);
      available =
        info.isFile() &&
        !info.isSymbolicLink() &&
        (info.mode & 0o111) !== 0;
      if (available) this.resolvedHelperExecutable = canonical;
    } catch {
      available = false;
    }
    const helper = available ? "stopped" : "missing";
    if (this.snapshotValue.helper !== helper) {
      this.update({ helper, playback: "stopped", error: undefined });
    }
    return this.snapshotValue;
  }

  private update(patch: Partial<Omit<AmbientMusicSnapshot, "revision">>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: this.snapshotValue.revision + 1,
    };
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private fail(error: AmbientMusicServiceError): void {
    this.clearIdleTimer();
    this.update({
      helper: this.supported ? "crashed" : "unsupported",
      playback: "error",
      model: undefined,
      promptReady: false,
      metrics: undefined,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AmbientMusicServiceError("service_disposed", "Ambient Music is shutting down.");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new AmbientMusicServiceError("service_disposed", "Ambient Music is shutting down."));
    }
    const guarded = async () => {
      this.assertActive();
      return operation();
    };
    const result = this.serial.then(guarded, guarded);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private canonicalInstall(install: AmbientMusicVerifiedInstall): AmbientMusicVerifiedInstall {
    if (install?.verified !== true || typeof install.revision !== "string" || !install.revision) {
      throw new AmbientMusicServiceError("unverified_install", "Ambient Music requires a verified model download.");
    }
    try {
      return { ...install, root: realpathSync(install.root) };
    } catch {
      throw new AmbientMusicServiceError("invalid_model_root", "The verified Ambient Music model root is unavailable.");
    }
  }

  private createProcessRecord(child: ChildProcessWithoutNullStreams, modelRoot: string): HelperProcess {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveReaped!: () => void;
    const reapPromise = new Promise<void>((resolve) => { resolveReaped = resolve; });
    return {
      child,
      generation: ++this.processGeneration,
      modelRoot,
      stdoutBuffer: "",
      stderrBytes: 0,
      eventSequence: 0,
      playbackRevision: 0,
      readySettled: false,
      resolveReady,
      rejectReady,
      readyPromise,
      expectedExit: false,
      resolveReaped,
      reapPromise,
    };
  }

  private async ensureStarted(modelRoot: string): Promise<HelperProcess> {
    this.assertActive();
    if (!this.supported) {
      throw new AmbientMusicServiceError(
        "unsupported_platform",
        "Ambient Music is not supported on this Mac.",
      );
    }
    const current = this.processRecord;
    if (current && current.modelRoot === modelRoot && this.snapshotValue.helper === "ready") return current;
    if (current) await this.terminateRecord(current, undefined, true);

    if (this.initialize().helper === "missing" || !this.resolvedHelperExecutable) {
      this.update({ helper: "missing", playback: "stopped", error: undefined });
      throw new AmbientMusicServiceError("helper_missing", "The Ambient Music native helper is not included in this build.");
    }
    const executable = this.resolvedHelperExecutable;

    this.update({ helper: "starting", playback: "stopped", promptReady: false, error: undefined });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnHelper(executable, ["--model-root", modelRoot], {
        env: safeHelperEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      throw new AmbientMusicServiceError("helper_launch_failed", "Could not launch the Ambient Music helper.", true);
    }
    const record = this.createProcessRecord(child, modelRoot);
    this.processRecord = record;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(record, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(record, chunk));
    child.stdin.on("error", () => {
      void this.terminateRecord(
        record,
        new AmbientMusicServiceError("helper_write_failed", "The Ambient Music command channel closed.", true),
      );
    });
    child.once("error", () => {
      void this.terminateRecord(
        record,
        new AmbientMusicServiceError("helper_launch_failed", "The Ambient Music helper could not launch.", true),
      );
    });
    child.once("exit", () => this.handleExit(record));

    const timer = setTimeout(() => {
      void this.terminateRecord(
        record,
        new AmbientMusicServiceError("start_timeout", "Ambient Music took too long to start.", true),
      );
    }, this.startTimeoutMs);
    timer.unref();
    try {
      await record.readyPromise;
      return record;
    } finally {
      clearTimeout(timer);
    }
  }

  private consumeStderr(record: HelperProcess, chunk: Buffer): void {
    if (record !== this.processRecord || record.terminationPromise) return;
    record.stderrBytes += chunk.byteLength;
    if (record.stderrBytes > this.maxStderrBytes) {
      void this.protocolFailure(record, "helper_stderr_overflow");
    }
  }

  private consumeStdout(record: HelperProcess, chunk: string): void {
    if (record !== this.processRecord || record.terminationPromise) return;
    record.stdoutBuffer += chunk;
    if (Buffer.byteLength(record.stdoutBuffer, "utf8") > MAX_AMBIENT_MUSIC_MESSAGE_BYTES * 2) {
      void this.protocolFailure(record, "helper_stdout_overflow");
      return;
    }
    let newline = record.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = record.stdoutBuffer.slice(0, newline);
      record.stdoutBuffer = record.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          const message = parseAmbientMusicHelperMessage(line);
          if (message.type === "event") this.handleEvent(record, message);
          else this.handleResponse(record, message);
        } catch (error) {
          this.warn("Rejected invalid native helper output", error);
          void this.protocolFailure(
            record,
            error instanceof AmbientMusicProtocolError ? error.code : "invalid_helper_output",
          );
          return;
        }
      }
      newline = record.stdoutBuffer.indexOf("\n");
    }
  }

  private protocolFailure(record: HelperProcess, code: string): Promise<void> {
    return this.terminateRecord(
      record,
      new AmbientMusicServiceError(code, "The Ambient Music helper violated its process contract.", true),
    );
  }

  private handleEvent(record: HelperProcess, event: AmbientMusicHelperEvent): void {
    if (record !== this.processRecord) return;
    record.eventSequence = acceptAmbientMusicEventSequence(record.eventSequence, event);
    if (event.event === "ready") {
      if (
        event.detail.protocolVersion !== AMBIENT_MUSIC_PROTOCOL_VERSION ||
        event.detail.modelRootApproved !== true ||
        event.detail.magentaEnabled !== true ||
        event.detail.buildIdentity !== HELPER_BUILD_IDENTITY ||
        record.readySettled
      ) {
        void this.protocolFailure(record, "invalid_ready_event");
        return;
      }
      record.readySettled = true;
      void this.completeHandshake(record);
      return;
    }
    if (event.event === "fatal") {
      const trusted = trustedHelperError(FATAL_HELPER_ERRORS, event.detail.code);
      if (!trusted) {
        void this.protocolFailure(record, "invalid_fatal_event");
        return;
      }
      void this.terminateRecord(
        record,
        new AmbientMusicServiceError(trusted.code, trusted.message, trusted.retryable),
      );
      return;
    }
    if (event.event === "promptEncoding") {
      const state = event.detail.state;
      if (state !== "ready" && state !== "failed") {
        void this.protocolFailure(record, "invalid_prompt_event");
        return;
      }
      this.update({ promptReady: state === "ready" });
      return;
    }
    if (event.event === "audioState") {
      if (event.detail.state === "recovered") {
        this.applyPlayback(record, event.detail.playback);
      } else if (event.detail.state === "failed") {
        void this.terminateRecord(
          record,
          new AmbientMusicServiceError("audio_route_failed", "Ambient Music lost its audio output.", true),
        );
      } else {
        void this.protocolFailure(record, "invalid_audio_event");
      }
      return;
    }
    const command = event.detail.command;
    if (command !== "play" && command !== "pause" && command !== "stop" && command !== "toggle") {
      void this.protocolFailure(record, "invalid_remote_command");
      return;
    }
    if (
      this.systemSuspended &&
      (command === "play" || command === "toggle") &&
      event.detail.playback &&
      (event.detail.playback as { state?: unknown }).state === "playing"
    ) {
      void this.enqueue(async () => {
        if (this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) return;
        const current = this.readyRecord();
        const response = await this.requestFor(current, "suspend");
        this.applyPlayback(current, response.result?.playback);
      }).catch((error) => this.warn("Could not reject a remote Play during sleep", error));
      return;
    }
    this.applyPlayback(record, event.detail.playback);
  }

  private async completeHandshake(record: HelperProcess): Promise<void> {
    try {
      const response = await this.requestFor(record, "hello");
      if (
        response.result?.protocolVersion !== AMBIENT_MUSIC_PROTOCOL_VERSION ||
        response.result.magentaEnabled !== true ||
        response.result.buildIdentity !== HELPER_BUILD_IDENTITY
      ) {
        await this.protocolFailure(record, "invalid_helper_capability");
        return;
      }
      if (record !== this.processRecord || record.terminationPromise) return;
      this.update({ helper: "ready", playback: "stopped", error: undefined });
      record.resolveReady();
    } catch (error) {
      if (record === this.processRecord && !record.terminationPromise) {
        await this.terminateRecord(record, asServiceError(error));
      }
    }
  }

  private handleResponse(record: HelperProcess, response: AmbientMusicHelperResponse): void {
    if (record !== this.processRecord) return;
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.generation !== record.generation) {
      void this.protocolFailure(record, "unknown_response_id");
      return;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response);
    else {
      const trusted = trustedHelperError(RESPONSE_HELPER_ERRORS, response.error?.code);
      if (!trusted) {
        const error = new AmbientMusicServiceError(
          "invalid_helper_error",
          "The Ambient Music helper violated its process contract.",
          true,
        );
        pending.reject(error);
        void this.protocolFailure(record, error.code);
        return;
      }
      pending.reject(new AmbientMusicServiceError(trusted.code, trusted.message, trusted.retryable));
    }
  }

  private handleExit(record: HelperProcess): void {
    record.resolveReaped();
    if (record !== this.processRecord) return;
    this.processRecord = null;
    const error = record.terminalError ?? new AmbientMusicServiceError(
      "helper_exited",
      "The Ambient Music helper exited unexpectedly.",
      true,
    );
    this.rejectPending(record.generation, error);
    record.rejectReady(error);
    if (record.terminalError) {
      if (!record.expectedExit) this.fail(record.terminalError);
    } else if (record.expectedExit || this.disposed) {
      this.update({
        helper: this.supported ? "stopped" : "unsupported",
        playback: "stopped",
        promptReady: false,
        model: undefined,
        metrics: undefined,
        error: undefined,
      });
    } else {
      this.fail(error);
    }
  }

  private rejectPending(generation: number, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private terminateRecord(
    record: HelperProcess,
    error?: AmbientMusicServiceError,
    expected = false,
  ): Promise<void> {
    if (record.terminationPromise) return record.terminationPromise;
    record.expectedExit = expected;
    record.terminalError = error;
    if (error) {
      this.fail(error);
      this.rejectPending(record.generation, error);
      record.rejectReady(error);
    }
    record.terminationPromise = (async () => {
      const child = record.child;
      if (child.exitCode === null) child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, this.shutdownTimeoutMs);
      force.unref();
      await Promise.race([
        record.reapPromise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.shutdownTimeoutMs + this.forceReapTimeoutMs);
          timer.unref();
        }),
      ]);
      clearTimeout(force);
      if (record === this.processRecord && child.exitCode === null) {
        this.processRecord = null;
      }
    })();
    return record.terminationPromise;
  }

  private requestFor(
    record: HelperProcess,
    method: AmbientMusicHelperMethod,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<AmbientMusicHelperResponse> {
    const child = record.child;
    if (
      record !== this.processRecord ||
      record.terminationPromise ||
      child.exitCode !== null ||
      child.killed
    ) {
      return Promise.reject(new AmbientMusicServiceError("helper_not_running", "Ambient Music is not running.", true));
    }
    const request: AmbientMusicHelperRequest = {
      version: AMBIENT_MUSIC_PROTOCOL_VERSION,
      requestId: randomUUID(),
      method,
      params,
    };
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload, "utf8") > 64 * 1024) {
      return Promise.reject(new AmbientMusicServiceError("request_too_large", "The Ambient Music request is too large."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        const error = new AmbientMusicServiceError(
          "request_timeout",
          `Ambient Music did not complete ${method} in time.`,
          true,
        );
        reject(error);
        void this.terminateRecord(record, error);
      }, timeoutMs);
      timer.unref();
      this.pending.set(request.requestId, { generation: record.generation, resolve, reject, timer });
      child.stdin.write(payload, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        clearTimeout(timer);
        const serviceError = new AmbientMusicServiceError(
          "helper_write_failed",
          "Could not send a command to Ambient Music.",
          true,
        );
        reject(serviceError);
        void this.terminateRecord(record, serviceError);
      });
    });
  }

  private readyRecord(): HelperProcess {
    const record = this.processRecord;
    if (!record || this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) {
      throw new AmbientMusicServiceError("model_not_ready", "Download and load Ambient Music before using it.");
    }
    return record;
  }

  private assertPlaybackAllowed(epoch: number): void {
    if (this.systemSuspended || epoch !== this.systemSuspendEpoch) {
      throw new AmbientMusicServiceError(
        "system_suspended",
        "Ambient Music playback was cancelled because this Mac went to sleep.",
      );
    }
  }

  private applyPlayback(record: HelperProcess, value: unknown): void {
    let projection;
    try {
      projection = parseAmbientMusicPlaybackProjection(value);
    } catch (error) {
      void this.protocolFailure(record, asServiceError(error).code);
      return;
    }
    if (!shouldApplyAmbientMusicPlayback(record.playbackRevision, projection)) return;
    record.playbackRevision = projection.revision;
    this.playbackActivityGeneration += 1;
    const playbackChanged = projection.state !== this.snapshotValue.playback;
    this.update({
      playback: projection.state,
      error: undefined,
      ...(playbackChanged ? { metrics: undefined } : {}),
    });
    if (projection.state === "playing") this.clearIdleTimer();
    else this.scheduleIdleUnload();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer();
    if (!this.snapshotValue.model || this.disposed) return;
    const activityGeneration = this.playbackActivityGeneration;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.enqueue(async () => {
        if (
          activityGeneration !== this.playbackActivityGeneration ||
          this.snapshotValue.playback === "playing"
        ) return;
        const record = this.readyRecord();
        const response = await this.requestFor(record, "idleUnload", {}, this.promptTimeoutMs);
        if (response.result?.skipped === true) {
          this.applyPlayback(record, response.result.playback);
          return;
        }
        if (response.result?.skipped !== false) {
          await this.protocolFailure(record, "invalid_idle_unload_response");
          throw new AmbientMusicServiceError(
            "invalid_idle_unload_response",
            "The Ambient Music helper returned an invalid idle-unload result.",
          );
        }
        this.applyPlayback(record, response.result.playback);
        this.update({ playback: "stopped", model: undefined, promptReady: false, metrics: undefined });
        this.clearIdleTimer();
      }).catch((error) => this.warn("Idle unload failed", error));
    }, this.idleUnloadMs);
    this.idleTimer.unref();
  }

  private async loadInternal(
    install: AmbientMusicVerifiedInstall,
    model: AmbientMusicModelId,
    benchmarkMode = false,
  ): Promise<void> {
    const record = await this.ensureStarted(install.root);
    this.update({
      playback: "loading",
      promptReady: false,
      model: undefined,
      metrics: undefined,
      error: undefined,
    });
    try {
      const response = await this.requestFor(record, "load", { model, benchmarkMode }, this.loadTimeoutMs);
      if (response.result?.model !== model) {
        await this.protocolFailure(record, "invalid_load_response");
        throw new AmbientMusicServiceError("invalid_load_response", "The helper loaded an unexpected model.", true);
      }
      this.update({ playback: "paused", model, promptReady: false, error: undefined });
      this.applyPlayback(record, response.result.playback);
      this.recoverableSession = benchmarkMode
        ? null
        : { install, model, volumeDB: -18, drumless: false, variation: 0 };
      this.scheduleIdleUnload();
    } catch (error) {
      const serviceError = asServiceError(error);
      await this.terminateRecord(record, serviceError);
      throw serviceError;
    }
  }

  load(
    installValue: AmbientMusicVerifiedInstall,
    modelValue: AmbientMusicModelId,
    benchmarkMode = false,
  ): Promise<void> {
    return this.enqueue(async () => {
      const install = this.canonicalInstall(installValue);
      const model = validateAmbientMusicModel(modelValue);
      if (typeof benchmarkMode !== "boolean") {
        throw new AmbientMusicServiceError("invalid_benchmark_mode", "Benchmark mode must be on or off.");
      }
      await this.loadInternal(install, model, benchmarkMode);
    });
  }

  setPrompts(rawPrompts: string[], rawWeights: number[]): Promise<void> {
    return this.enqueue(async () => {
      const { prompts, weights } = validateAmbientMusicPromptMix(rawPrompts, rawWeights);
      const record = this.readyRecord();
      this.update({ promptReady: false, error: undefined });
      await this.requestFor(record, "setPrompts", { prompts, weights }, this.promptTimeoutMs);
      this.update({ promptReady: true });
      if (this.recoverableSession) {
        this.recoverableSession.prompts = prompts;
        this.recoverableSession.weights = weights;
      }
    });
  }

  setWeights(rawWeights: number[]): Promise<void> {
    return this.enqueue(async () => {
      const expectedCount = this.recoverableSession?.prompts?.length;
      const weights = validateAmbientMusicWeights(rawWeights, expectedCount);
      if (!this.snapshotValue.model && this.recoverableSession?.prompts) {
        this.recoverableSession.weights = weights;
        return;
      }
      const record = this.readyRecord();
      await this.requestFor(record, "setWeights", { weights });
      if (this.recoverableSession) this.recoverableSession.weights = weights;
    });
  }

  setVolume(rawDecibels: number): Promise<void> {
    return this.enqueue(async () => {
      const decibels = validateAmbientMusicVolume(rawDecibels);
      if (!this.snapshotValue.model && this.recoverableSession) {
        this.recoverableSession.volumeDB = decibels;
        return;
      }
      const record = this.readyRecord();
      await this.requestFor(record, "setVolume", { decibels });
      if (this.recoverableSession) this.recoverableSession.volumeDB = decibels;
    });
  }

  setDrumless(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (typeof enabled !== "boolean") {
        throw new AmbientMusicServiceError("invalid_drumless", "Drumless must be on or off.");
      }
      if (!this.snapshotValue.model && this.recoverableSession) {
        this.recoverableSession.drumless = enabled;
        return;
      }
      const record = this.readyRecord();
      await this.requestFor(record, "setDrumless", { enabled });
      if (this.recoverableSession) this.recoverableSession.drumless = enabled;
    });
  }

  setBenchmarkMode(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (typeof enabled !== "boolean") {
        throw new AmbientMusicServiceError("invalid_benchmark_mode", "Benchmark mode must be on or off.");
      }
      await this.requestFor(this.readyRecord(), "setBenchmarkMode", { enabled });
    });
  }

  setVariation(rawVariation: number): Promise<void> {
    return this.enqueue(async () => {
      if (typeof rawVariation !== "number" || !Number.isFinite(rawVariation) || rawVariation < 0 || rawVariation > 1) {
        throw new AmbientMusicServiceError("invalid_variation", "Variation must be between zero and one.");
      }
      if (!this.snapshotValue.model && this.recoverableSession) {
        this.recoverableSession.variation = rawVariation;
        return;
      }
      await this.requestFor(this.readyRecord(), "setVariation", { variation: rawVariation });
      if (this.recoverableSession) this.recoverableSession.variation = rawVariation;
    });
  }

  private async recoverSession(): Promise<HelperProcess> {
    const session = this.recoverableSession;
    if (!session) throw new AmbientMusicServiceError("model_not_ready", "Download and load Ambient Music first.");
    await this.loadInternal(this.canonicalInstall(session.install), session.model);
    const record = this.readyRecord();
    if (session.prompts && session.weights) {
      await this.requestFor(
        record,
        "setPrompts",
        { prompts: session.prompts, weights: session.weights },
        this.promptTimeoutMs,
      );
      this.update({ promptReady: true });
    }
    await this.requestFor(record, "setVolume", { decibels: session.volumeDB });
    await this.requestFor(record, "setDrumless", { enabled: session.drumless });
    await this.requestFor(record, "setVariation", { variation: session.variation });
    this.recoverableSession = { ...session };
    return record;
  }

  play(): Promise<void> {
    const suspendEpoch = this.systemSuspendEpoch;
    return this.enqueue(async () => {
      this.assertPlaybackAllowed(suspendEpoch);
      this.clearIdleTimer();
      const record = this.snapshotValue.helper === "crashed" ||
          (this.snapshotValue.helper === "ready" && !this.snapshotValue.model)
        ? await this.recoverSession()
        : this.readyRecord();
      this.assertPlaybackAllowed(suspendEpoch);
      if (!this.snapshotValue.promptReady) {
        throw new AmbientMusicServiceError(
          "prompt_not_ready",
          "Apply a valid Ambient Music prompt mix before playing.",
        );
      }
      const response = await this.requestFor(record, "play");
      if (this.systemSuspended || suspendEpoch !== this.systemSuspendEpoch) {
        const suspended = await this.requestFor(record, "suspend");
        this.applyPlayback(record, suspended.result?.playback);
        this.assertPlaybackAllowed(suspendEpoch);
      }
      this.applyPlayback(record, response.result?.playback);
    });
  }

  pause(): Promise<void> {
    return this.enqueue(async () => {
      const record = this.readyRecord();
      const response = await this.requestFor(record, "pause");
      this.applyPlayback(record, response.result?.playback);
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      const record = this.readyRecord();
      const response = await this.requestFor(record, "stop");
      this.applyPlayback(record, response.result?.playback);
    });
  }

  reset(): Promise<void> {
    return this.enqueue(async () => {
      await this.requestFor(this.readyRecord(), "reset");
      this.update({ metrics: undefined });
    });
  }

  metrics(): Promise<AmbientMusicMetrics> {
    return this.enqueue(async () => {
      const record = this.readyRecord();
      const response = await this.requestFor(record, "metrics");
      let metrics: AmbientMusicMetrics;
      try {
        metrics = parseMetrics(response.result);
      } catch (error) {
        await this.protocolFailure(record, "invalid_metrics");
        throw asServiceError(error);
      }
      this.update({ metrics });
      return metrics;
    });
  }

  unload(preserveSession = false): Promise<void> {
    return this.enqueue(async () => {
      this.clearIdleTimer();
      const record = this.processRecord;
      if (!record || this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) {
        if (!preserveSession) this.recoverableSession = null;
        return;
      }
      const response = await this.requestFor(record, "unload", {}, this.promptTimeoutMs);
      this.applyPlayback(record, response.result?.playback);
      this.update({ playback: "stopped", model: undefined, promptReady: false, metrics: undefined });
      this.clearIdleTimer();
      if (!preserveSession) this.recoverableSession = null;
    });
  }

  handleSystemSuspend(): void {
    if (this.disposed) return;
    this.systemSuspended = true;
    this.systemSuspendEpoch += 1;
    this.clearIdleTimer();
    if (this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) return;
    void this.enqueue(async () => {
      if (this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) return;
      const record = this.readyRecord();
      const response = await this.requestFor(record, "suspend");
      this.applyPlayback(record, response.result?.playback);
    }).catch((error) => this.warn("Could not suspend Ambient Music before sleep", error));
  }

  handleSystemResume(): void {
    // A resume only permits a future explicit Play. The suspend epoch makes
    // every playback request that started before sleep permanently stale.
    this.systemSuspended = false;
    if (this.disposed || this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) return;
    void this.enqueue(async () => {
      if (this.snapshotValue.helper !== "ready" || !this.snapshotValue.model) return;
      await this.requestFor(this.readyRecord(), "resume");
    }).catch((error) => this.warn("Could not restore Ambient Music controls after wake", error));
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    this.clearIdleTimer();
    const record = this.processRecord;
    const immediateTeardown = record ? this.shutdownRecord(record) : Promise.resolve();
    this.disposalPromise = (async () => {
      await immediateTeardown;
      await this.serial;
      const latest = this.processRecord;
      if (latest) await this.shutdownRecord(latest);
      this.listeners.clear();
    })();
    return this.disposalPromise;
  }

  private async shutdownRecord(record: HelperProcess): Promise<void> {
    record.expectedExit = true;
    if (!record.terminationPromise && record.child.exitCode === null) {
      try {
        await this.requestFor(record, "shutdown", {}, this.shutdownTimeoutMs);
      } catch {
        // A closing helper can race its final response. The bounded reap below
        // remains authoritative and escalates if needed.
      }
    }
    await this.terminateRecord(record, undefined, true);
  }
}
