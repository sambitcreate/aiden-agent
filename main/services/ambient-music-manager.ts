import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AmbientMusicBaseBenchmarkResult,
  AmbientMusicConfigV1,
  AmbientMusicDegradation,
  AmbientMusicFeatureSnapshot,
  AmbientMusicModelId,
  AmbientMusicModelStatus,
  AmbientMusicSnapshot,
} from "../../renderer/shared/ambient-music.js";
import { AmbientMusicModelStore } from "./ambient-music-download.js";
import {
  AmbientMusicDegradationMonitor,
  sameAmbientMusicDegradation,
} from "./ambient-music-degradation.js";
import type { AmbientMusicMetrics } from "../../renderer/shared/ambient-music.js";
import type { AmbientMusicVerifiedInstall } from "./ambient-music-service.js";

const BENCHMARK_PROMPTS = ["calm instrumental ambient music, soft warm synthesizer, no vocals"];
const BENCHMARK_WEIGHTS = [1];
const HELPER_BENCHMARK_IDENTITY = "aiden-ambient-music-helper/1";
const RUNTIME_METRICS_INTERVAL_MS = 500;

interface PersistedBenchmarkResult extends AmbientMusicBaseBenchmarkResult {
  key: string;
}

interface BenchmarkFile {
  version: 1;
  results: Record<string, PersistedBenchmarkResult>;
}

interface PendingWeightBatch {
  lifecycleToken: number;
  weights: number[];
  waiters: Array<{ resolve(): void; reject(error: unknown): void }>;
}

export interface AmbientMusicManagerOptions {
  service: AmbientMusicRuntimeController;
  store: AmbientMusicModelStore;
  hardwareKey?: string;
  benchmarkWarmupMs?: number;
  benchmarkSampleIntervalMs?: number;
  benchmarkSampleCount?: number;
  disposeTimeoutMs?: number;
  metricsPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AmbientMusicRuntimeController {
  snapshot(): AmbientMusicSnapshot;
  subscribe(listener: (snapshot: AmbientMusicSnapshot) => void): () => void;
  initialize?(): AmbientMusicSnapshot | Promise<AmbientMusicSnapshot>;
  load(install: AmbientMusicVerifiedInstall, model: AmbientMusicModelId, benchmarkMode?: boolean): Promise<void>;
  unload(preserveSession?: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  setPrompts(prompts: string[], weights: number[]): Promise<void>;
  setWeights(weights: number[]): Promise<void>;
  setVolume(decibels: number): Promise<void>;
  setDrumless(enabled: boolean): Promise<void>;
  setVariation(variation: number): Promise<void>;
  setBenchmarkMode(enabled: boolean): Promise<void>;
  reset(): Promise<void>;
  metrics(): Promise<AmbientMusicMetrics>;
  handleSystemSuspend(): void;
  handleSystemResume(): void;
  dispose(): Promise<void>;
}

function defaultHardwareKey(): string {
  const cpu = os.cpus()[0]?.model ?? "unknown-cpu";
  return `${process.arch}|${cpu}|${os.release()}`;
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1));
  return sorted[index];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFiniteNumber(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parsePersistedBenchmark(value: unknown, expectedKey: string): PersistedBenchmarkResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result = value as Partial<PersistedBenchmarkResult>;
  if (
    result.key !== expectedKey ||
    (result.status !== "passed" && result.status !== "failed") ||
    typeof result.measuredAt !== "string" ||
    result.measuredAt.length > 64 ||
    !Number.isFinite(Date.parse(result.measuredAt)) ||
    !isFiniteNumber(result.p50FrameMs, 0, 60_000) ||
    !isFiniteNumber(result.p95FrameMs, result.p50FrameMs, 60_000) ||
    !isFiniteNumber(result.droppedFrames, 0, Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(result.droppedFrames) ||
    !isFiniteNumber(result.minimumBufferRatio, 0, 1)
  ) return null;
  const metricsPass = result.p95FrameMs < 40 && result.droppedFrames === 0 && result.minimumBufferRatio >= 0.25;
  if (result.status === "passed" && !metricsPass) return null;
  return {
    key: result.key,
    status: result.status,
    measuredAt: result.measuredAt,
    p50FrameMs: result.p50FrameMs,
    p95FrameMs: result.p95FrameMs,
    droppedFrames: result.droppedFrames,
    minimumBufferRatio: result.minimumBufferRatio,
  };
}

function publicBenchmark(result: PersistedBenchmarkResult | undefined): AmbientMusicBaseBenchmarkResult | undefined {
  if (!result) return undefined;
  const { key: _key, ...visible } = result;
  return visible;
}

export class AmbientMusicManager {
  private readonly service: AmbientMusicRuntimeController;
  private readonly store: AmbientMusicModelStore;
  private readonly hardwareKey: string;
  private readonly benchmarkWarmupMs: number;
  private readonly benchmarkSampleIntervalMs: number;
  private readonly benchmarkSampleCount: number;
  private readonly disposeTimeoutMs: number;
  private readonly metricsPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private revision = 0;
  private models: AmbientMusicModelStatus[];
  private runtime: AmbientMusicSnapshot;
  private baseBenchmark?: AmbientMusicBaseBenchmarkResult;
  private listeners = new Set<(snapshot: AmbientMusicFeatureSnapshot) => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private lifecycleToken = 0;
  private systemSuspendEpoch = 0;
  private systemSuspended = false;
  private selectedModel?: AmbientMusicModelId;
  private pendingWeights?: PendingWeightBatch;
  private weightDrainScheduled = false;
  private benchmarkController?: AbortController;
  private metricsTimer: NodeJS.Timeout | null = null;
  private metricsPollInFlight = false;
  private degradation?: AmbientMusicDegradation;
  private readonly degradationMonitor = new AmbientMusicDegradationMonitor();
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeService: () => void;

  constructor(options: AmbientMusicManagerOptions) {
    this.service = options.service;
    this.store = options.store;
    this.hardwareKey = options.hardwareKey ?? defaultHardwareKey();
    this.benchmarkWarmupMs = options.benchmarkWarmupMs ?? 5_000;
    this.benchmarkSampleIntervalMs = options.benchmarkSampleIntervalMs ?? 1_000;
    this.benchmarkSampleCount = options.benchmarkSampleCount ?? 30;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000;
    this.metricsPollIntervalMs = options.metricsPollIntervalMs ?? RUNTIME_METRICS_INTERVAL_MS;
    this.sleep = options.sleep ?? wait;
    this.models = this.store.snapshot();
    this.runtime = this.service.snapshot();
    this.unsubscribeStore = this.store.subscribe((models) => {
      this.models = models;
      this.publish();
    });
    this.unsubscribeService = this.service.subscribe((runtime) => {
      if (runtime.model !== this.runtime.model || runtime.helper !== this.runtime.helper) {
        this.lifecycleToken += 1;
      }
      this.runtime = runtime;
      if (runtime.playback === "playing" && !this.benchmarkController) {
        this.scheduleMetricsPoll();
      } else {
        this.stopMetricsPoll();
        this.degradationMonitor.reset(runtime.metrics?.droppedFrames);
        this.degradation = undefined;
      }
      this.publish();
    });
  }

  private benchmarkKey(): string {
    return [
      HELPER_BENCHMARK_IDENTITY,
      this.store.manifest.revision,
      this.hardwareKey,
    ].join("|");
  }

  private benchmarkPath(): string {
    return path.join(this.store.root, "benchmark-results.json");
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  snapshot(): AmbientMusicFeatureSnapshot {
    return {
      revision: this.revision,
      supported: this.runtime.supported,
      supportReason: this.runtime.supportReason,
      helper: this.runtime.helper,
      playback: this.runtime.playback,
      benchmarking: this.benchmarkController !== undefined,
      selectedModel: this.selectedModel,
      loadedModel: this.runtime.model,
      promptReady: this.runtime.promptReady,
      models: this.models.map((model) => ({ ...model })),
      storage: this.store.storageSnapshot(),
      baseBenchmark: this.baseBenchmark,
      // Base qualification renders through the real analyzer while native
      // output is force-silent. Never project those inaudible samples as a
      // live Settings spectrum.
      metrics: this.benchmarkController ? undefined : this.runtime.metrics,
      degradation: this.degradation,
      error: this.runtime.error,
    };
  }

  subscribe(listener: (snapshot: AmbientMusicFeatureSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Ambient Music is shutting down."));
    const guarded = async () => {
      if (this.disposed) throw new Error("Ambient Music is shutting down.");
      return operation();
    };
    const result = this.serial.then(guarded, guarded);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private scheduleMetricsPoll(): void {
    if (
      this.disposed ||
      this.metricsTimer ||
      this.metricsPollInFlight ||
      this.benchmarkController ||
      this.runtime.playback !== "playing"
    ) return;
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = null;
      void this.pollRuntimeMetrics();
    }, this.metricsPollIntervalMs);
    this.metricsTimer.unref();
  }

  private stopMetricsPoll(): void {
    if (!this.metricsTimer) return;
    clearTimeout(this.metricsTimer);
    this.metricsTimer = null;
  }

  private async pollRuntimeMetrics(): Promise<void> {
    if (this.metricsPollInFlight || this.disposed || this.runtime.playback !== "playing") return;
    this.metricsPollInFlight = true;
    try {
      const metrics = await this.service.metrics();
      if (this.disposed || this.runtime.playback !== "playing" || this.benchmarkController) return;
      const next = this.degradationMonitor.observe(metrics);
      if (!sameAmbientMusicDegradation(this.degradation, next)) {
        this.degradation = next;
        this.publish();
      }
    } catch {
      // Runtime request failures are projected by the service. Degradation is
      // advisory and must never mask or duplicate the authoritative error.
    } finally {
      this.metricsPollInFlight = false;
      this.scheduleMetricsPoll();
    }
  }

  private assertSupported(): void {
    if (!this.runtime.supported) {
      throw new Error("Ambient Music downloads require Apple Silicon and macOS 14 or later.");
    }
  }

  private assertHelperAvailable(): void {
    if (this.runtime.helper === "missing") {
      throw new Error(
        "Ambient Music is unavailable because this build does not include the native helper.",
      );
    }
  }

  private assertPlaybackAllowed(epoch: number): void {
    if (this.systemSuspended || epoch !== this.systemSuspendEpoch) {
      throw new Error("Ambient Music playback was cancelled because this Mac went to sleep.");
    }
  }

  async initialize(): Promise<AmbientMusicFeatureSnapshot> {
    await this.service.initialize?.();
    this.runtime = this.service.snapshot();
    this.models = await this.store.refreshStatus(false);
    const persisted = await this.readBenchmarkFile();
    this.baseBenchmark = publicBenchmark(persisted.results[this.benchmarkKey()]);
    this.publish();
    return this.snapshot();
  }

  download(model: AmbientMusicModelId, termsAccepted: true, repair = false): Promise<AmbientMusicFeatureSnapshot> {
    return this.enqueue(async () => {
      this.assertSupported();
      this.assertHelperAvailable();
      await this.store.download(model, { termsAccepted, repair });
      this.models = this.store.snapshot();
      this.publish();
      return this.snapshot();
    });
  }

  async cancelDownload(): Promise<AmbientMusicFeatureSnapshot> {
    await this.store.cancelDownload();
    this.models = this.store.snapshot();
    this.publish();
    return this.snapshot();
  }

  removeModel(model: AmbientMusicModelId, expectedRevision: number): Promise<AmbientMusicFeatureSnapshot> {
    return this.enqueue(async () => {
      this.assertSupported();
      if (expectedRevision !== this.revision) {
        throw new Error("Ambient Music changed. Review the current model state before removing it.");
      }
      if (this.runtime.model === model || this.selectedModel === model) await this.service.unload();
      await this.store.removeModel(model);
      if (this.selectedModel === model) this.selectedModel = undefined;
      this.models = this.store.snapshot();
      if (model === "mrt2_base") {
        this.baseBenchmark = undefined;
        const file = await this.readBenchmarkFile();
        delete file.results[this.benchmarkKey()];
        await this.writeBenchmarkFile(file);
      }
      this.publish();
      return this.snapshot();
    });
  }

  load(model: AmbientMusicModelId): Promise<AmbientMusicFeatureSnapshot> {
    return this.enqueue(async () => {
      this.assertSupported();
      this.assertHelperAvailable();
      if (model === "mrt2_base" && this.baseBenchmark?.status !== "passed") {
        throw new Error("Run and pass the Base real-time benchmark before loading this model.");
      }
      const install = await this.store.verifiedInstall(model);
      await this.service.load(install, model);
      this.selectedModel = model;
      this.publish();
      return this.snapshot();
    });
  }

  applyConfiguration(
    config: AmbientMusicConfigV1,
    playAfter: boolean,
  ): Promise<AmbientMusicFeatureSnapshot> {
    const suspendEpoch = this.systemSuspendEpoch;
    return this.enqueue(async () => {
      this.assertSupported();
      this.assertHelperAvailable();
      if (config.selectedModel === "mrt2_base" && this.baseBenchmark?.status !== "passed") {
        throw new Error("Run and pass the Base real-time benchmark before loading this model.");
      }
      try {
        if (this.runtime.model !== config.selectedModel) {
          const install = await this.store.verifiedInstall(config.selectedModel);
          await this.service.load(install, config.selectedModel);
        }
        this.selectedModel = config.selectedModel;
        await this.service.setPrompts(
          config.prompts.map((prompt) => prompt.text),
          config.prompts.map((prompt) => prompt.weight),
        );
        await this.service.setVolume(config.volumeDb);
        await this.service.setVariation(config.variation);
        await this.service.setDrumless(config.drumless);
        if (playAfter) {
          this.assertPlaybackAllowed(suspendEpoch);
          await this.service.play();
          this.assertPlaybackAllowed(suspendEpoch);
        }
        this.publish();
        return this.snapshot();
      } catch (error) {
        try {
          await this.service.unload();
        } catch {
          // The original operation error is authoritative; service teardown is
          // already bounded and poisons an unresponsive helper.
        }
        this.selectedModel = undefined;
        this.publish();
        throw error;
      }
    });
  }

  unload(): Promise<AmbientMusicFeatureSnapshot> {
    return this.enqueue(async () => {
      await this.service.unload();
      this.selectedModel = undefined;
      this.publish();
      return this.snapshot();
    });
  }

  play(): Promise<void> {
    const suspendEpoch = this.systemSuspendEpoch;
    return this.enqueue(async () => {
      this.assertHelperAvailable();
      this.assertPlaybackAllowed(suspendEpoch);
      const model = this.runtime.model ?? this.selectedModel;
      if (model === "mrt2_base" && this.baseBenchmark?.status !== "passed") {
        throw new Error("Run and pass the Base real-time benchmark before playing this model.");
      }
      await this.service.play();
      this.assertPlaybackAllowed(suspendEpoch);
    });
  }
  pause(): Promise<void> { return this.enqueue(() => this.service.pause()); }
  stop(): Promise<void> { return this.enqueue(() => this.service.stop()); }
  setPrompts(prompts: string[], weights: number[]): Promise<void> {
    return this.enqueue(() => {
      this.assertHelperAvailable();
      return this.service.setPrompts(prompts, weights);
    });
  }
  setWeights(weights: number[]): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Ambient Music is shutting down."));
    try {
      this.assertHelperAvailable();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      const lifecycleToken = this.lifecycleToken;
      if (this.pendingWeights && this.pendingWeights.lifecycleToken !== lifecycleToken) {
        const stale = this.pendingWeights;
        this.pendingWeights = undefined;
        for (const waiter of stale.waiters) waiter.reject(new Error("Ambient Music changed before weights could be applied."));
      }
      if (this.pendingWeights) {
        this.pendingWeights.weights = [...weights];
        this.pendingWeights.waiters.push({ resolve, reject });
      } else {
        this.pendingWeights = { lifecycleToken, weights: [...weights], waiters: [{ resolve, reject }] };
      }
      this.scheduleWeightDrain();
    });
  }

  private scheduleWeightDrain(): void {
    if (this.weightDrainScheduled || !this.pendingWeights || this.disposed) return;
    this.weightDrainScheduled = true;
    let executing: PendingWeightBatch | undefined;
    void this.enqueue(async () => {
      const batch = this.pendingWeights;
      this.pendingWeights = undefined;
      if (!batch) return;
      executing = batch;
      if (batch.lifecycleToken !== this.lifecycleToken || !this.runtime.model) {
        throw new Error("Ambient Music changed before weights could be applied.");
      }
      await this.service.setWeights(batch.weights);
      for (const waiter of batch.waiters) waiter.resolve();
    }).catch((error) => {
      for (const waiter of executing?.waiters ?? []) waiter.reject(error);
    }).finally(() => {
      this.weightDrainScheduled = false;
      this.scheduleWeightDrain();
    });
  }

  setVolume(decibels: number): Promise<void> {
    return this.enqueue(() => {
      this.assertHelperAvailable();
      return this.service.setVolume(decibels);
    });
  }
  setDrumless(enabled: boolean): Promise<void> {
    return this.enqueue(() => {
      this.assertHelperAvailable();
      return this.service.setDrumless(enabled);
    });
  }
  setVariation(variation: number): Promise<void> {
    return this.enqueue(() => {
      this.assertHelperAvailable();
      return this.service.setVariation(variation);
    });
  }
  restart(): Promise<void> {
    return this.enqueue(() => {
      this.assertHelperAvailable();
      return this.service.reset();
    });
  }

  handleSystemSuspend(): void {
    if (this.disposed) return;
    this.systemSuspended = true;
    this.systemSuspendEpoch += 1;
    this.benchmarkController?.abort();
    this.stopMetricsPoll();
    this.degradationMonitor.reset(this.runtime.metrics?.droppedFrames);
    this.degradation = undefined;
    this.service.handleSystemSuspend();
  }

  handleSystemResume(): void {
    if (this.disposed) return;
    this.systemSuspended = false;
    this.service.handleSystemResume();
  }

  benchmarkBase(expectedRevision: number): Promise<AmbientMusicBaseBenchmarkResult> {
    return this.enqueue(async () => {
      this.assertSupported();
      this.assertHelperAvailable();
      if (expectedRevision !== this.revision) {
        throw new Error("Ambient Music changed. Review the current state before benchmarking Base.");
      }
      if (this.runtime.model || this.selectedModel) {
        throw new Error("Unload the selected Ambient Music model before benchmarking Base.");
      }
      const controller = new AbortController();
      this.benchmarkController = controller;
      this.publish();
      const frames: number[] = [];
      let droppedFrames = 0;
      let minimumBufferRatio = 1;
      let loaded = false;
      let result: PersistedBenchmarkResult | undefined;
      let cleanupError: unknown;
      try {
        const install = await this.store.verifiedInstall("mrt2_base");
        await this.service.load(install, "mrt2_base", true);
        loaded = true;
        await this.service.setPrompts(BENCHMARK_PROMPTS, BENCHMARK_WEIGHTS);
        const baselineDroppedFrames = (await this.service.metrics()).droppedFrames;
        await this.service.play();
        await this.benchmarkSleep(this.benchmarkWarmupMs, controller.signal);
        for (let index = 0; index < this.benchmarkSampleCount; index += 1) {
          await this.benchmarkSleep(this.benchmarkSampleIntervalMs, controller.signal);
          const metrics = await this.service.metrics();
          frames.push(metrics.frameMs);
          droppedFrames = Math.max(
            droppedFrames,
            Math.max(0, metrics.droppedFrames - baselineDroppedFrames),
          );
          const ratio = metrics.bufferCapacity > 0
            ? metrics.bufferAvailable / metrics.bufferCapacity
            : 0;
          minimumBufferRatio = Math.min(minimumBufferRatio, ratio);
        }
        const sorted = [...frames].sort((left, right) => left - right);
        const p50FrameMs = percentile(sorted, 0.5);
        const p95FrameMs = percentile(sorted, 0.95);
        result = {
          key: this.benchmarkKey(),
          status: p95FrameMs < 40 && droppedFrames === 0 && minimumBufferRatio >= 0.25
            ? "passed"
            : "failed",
          measuredAt: new Date().toISOString(),
          p50FrameMs,
          p95FrameMs,
          droppedFrames,
          minimumBufferRatio,
        };
      } finally {
        if (loaded) {
          try { await this.service.stop(); } catch (error) { cleanupError ??= error; }
        }
        if (loaded) {
          try { await this.service.unload(); } catch (error) { cleanupError ??= error; }
        }
        if (this.benchmarkController === controller) {
          this.benchmarkController = undefined;
          // Publish the authoritative end of silent qualification even when
          // sampling or cleanup fails and this operation rejects.
          this.publish();
        }
      }
      if (cleanupError) throw cleanupError;
      if (!result) throw new Error("Ambient Music could not complete the Base benchmark.");
      const file = await this.readBenchmarkFile();
      file.results[result.key] = result;
      await this.writeBenchmarkFile(file);
      const visible = publicBenchmark(result);
      if (!visible) throw new Error("Ambient Music could not record the Base benchmark.");
      this.baseBenchmark = visible;
      this.publish();
      return visible;
    });
  }

  private async benchmarkSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Ambient Music benchmark was cancelled.");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish(new Error("Ambient Music benchmark was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      void this.sleep(milliseconds).then(() => finish(), () => finish(new Error("Ambient Music benchmark timing failed.")));
    });
  }

  private async readBenchmarkFile(): Promise<BenchmarkFile> {
    try {
      const stats = await lstat(this.benchmarkPath());
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256 * 1024) {
        return { version: 1, results: {} };
      }
      const parsed = JSON.parse(await readFile(this.benchmarkPath(), "utf8")) as Partial<BenchmarkFile>;
      if (parsed.version === 1 && parsed.results && typeof parsed.results === "object") {
        const key = this.benchmarkKey();
        const current = parsePersistedBenchmark((parsed.results as Record<string, unknown>)[key], key);
        return { version: 1, results: current ? { [key]: current } : {} };
      }
    } catch {
      // An absent or malformed cache conservatively means Base is unqualified.
    }
    return { version: 1, results: {} };
  }

  private async writeBenchmarkFile(file: BenchmarkFile): Promise<void> {
    const target = this.benchmarkPath();
    const temporary = `${target}.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeStore();
    this.unsubscribeService();
    this.listeners.clear();
    this.stopMetricsPoll();
    this.degradationMonitor.reset();
    this.degradation = undefined;
    this.benchmarkController?.abort();
    this.benchmarkController = undefined;
    const shutdownError = new Error("Ambient Music is shutting down.");
    for (const waiter of this.pendingWeights?.waiters ?? []) waiter.reject(shutdownError);
    this.pendingWeights = undefined;

    const serviceDisposal = this.service.dispose();
    const downloadCancellation = this.store.cancelDownload();
    const settled = Promise.allSettled([serviceDisposal, downloadCancellation, this.serial]);
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.disposeTimeoutMs);
        timer.unref();
      }),
    ]);
  }
}
