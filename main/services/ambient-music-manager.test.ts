import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AmbientMusicAssetManifest,
} from "./ambient-music-download-core.js";
import { AmbientMusicModelStore, type AmbientMusicHttpClient } from "./ambient-music-download.js";
import {
  AmbientMusicManager,
  type AmbientMusicRuntimeController,
} from "./ambient-music-manager.js";
import type {
  AmbientMusicMetrics,
  AmbientMusicModelId,
  AmbientMusicSnapshot,
} from "../../renderer/shared/ambient-music.js";
import { AmbientMusicService, type AmbientMusicVerifiedInstall } from "./ambient-music-service.js";

const helperFixture = fileURLToPath(new URL("./fixtures/ambient-music-fake-helper.mjs", import.meta.url));

const content = {
  "resources/shared.bin": Buffer.from("shared"),
  "models/mrt2_small/small.bin": Buffer.from("small"),
  "models/mrt2_base/base.bin": Buffer.from("base"),
};
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const manifest: AmbientMusicAssetManifest = {
  version: 1,
  source: "google/magenta-realtime-2",
  revision: "c".repeat(40),
  license: "CC-BY-4.0",
  termsUrl: "https://huggingface.co/google/magenta-realtime-2",
  bundled: false,
  files: [
    { role: "shared", relativePath: "resources/shared.bin", size: 6, sha256: sha(content["resources/shared.bin"]) },
    { role: "mrt2_small", relativePath: "models/mrt2_small/small.bin", size: 5, sha256: sha(content["models/mrt2_small/small.bin"]) },
    { role: "mrt2_base", relativePath: "models/mrt2_base/base.bin", size: 4, sha256: sha(content["models/mrt2_base/base.bin"]) },
  ],
};

class RuntimeStub implements AmbientMusicRuntimeController {
  log: string[] = [];
  metricError?: Error;
  controlErrorAt?: "prompts" | "volume" | "variation" | "drumless" | "play";
  frameMs = 20;
  droppedFrames = 0;
  publishMetrics = false;
  promptGate?: Promise<void>;
  private state: AmbientMusicSnapshot = {
    revision: 0,
    supported: true,
    helper: "stopped",
    playback: "stopped",
    promptReady: false,
  };
  private listeners = new Set<(snapshot: AmbientMusicSnapshot) => void>();
  private metricIndex = 0;

  get metricsCount(): number { return this.metricIndex; }

  snapshot(): AmbientMusicSnapshot { return this.state; }
  initialize(): AmbientMusicSnapshot { return this.state; }
  subscribe(listener: (snapshot: AmbientMusicSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(patch: Partial<AmbientMusicSnapshot>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
  async load(_install: AmbientMusicVerifiedInstall, model: AmbientMusicModelId, benchmarkMode = false) {
    this.log.push(`load:${model}${benchmarkMode ? ":benchmark" : ""}`);
    if (benchmarkMode) this.log.push("benchmark:true");
    this.update({ helper: "ready", playback: "paused", model });
  }
  async unload() { this.log.push("unload"); this.update({ playback: "stopped", model: undefined }); }
  async play() {
    this.log.push("play");
    if (this.controlErrorAt === "play") throw new Error("play failed");
    this.update({ playback: "playing" });
  }
  async pause() { this.log.push("pause"); this.update({ playback: "paused" }); }
  async stop() { this.log.push("stop"); this.update({ playback: "stopped" }); }
  async setPrompts() {
    this.log.push("prompts");
    await this.promptGate;
    if (this.controlErrorAt === "prompts") throw new Error("prompts failed");
    this.update({ promptReady: true });
  }
  async setWeights(weights: number[]) { this.log.push(`weights:${weights.join(",")}`); }
  async setVolume(decibels: number) {
    this.log.push(`volume:${decibels}`);
    if (this.controlErrorAt === "volume") throw new Error("volume failed");
  }
  async setDrumless(enabled: boolean) {
    this.log.push(`drumless:${enabled}`);
    if (this.controlErrorAt === "drumless") throw new Error("drumless failed");
  }
  async setVariation(variation: number) {
    this.log.push(`variation:${variation}`);
    if (this.controlErrorAt === "variation") throw new Error("variation failed");
  }
  async setBenchmarkMode(enabled: boolean) { this.log.push(`benchmark:${enabled}`); }
  async reset() { this.log.push("reset"); }
  async metrics(): Promise<AmbientMusicMetrics> {
    if (this.metricError) throw this.metricError;
    this.metricIndex += 1;
    const metrics = {
      transformerMs: 10,
      frameMs: this.frameMs + this.metricIndex,
      bufferAvailable: 6,
      bufferCapacity: 10,
      droppedFrames: this.droppedFrames,
    };
    if (this.publishMetrics) this.update({ metrics });
    return metrics;
  }
  handleSystemSuspend() { this.log.push("system-suspend"); void this.pause(); }
  handleSystemResume() { this.log.push("system-resume"); }
  async dispose() { this.log.push("dispose"); }
}

test("a missing native helper blocks model downloads before any network request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-missing-helper-"));
  let networkRequests = 0;
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: {
      async request() {
        networkRequests += 1;
        throw new Error("network must remain unreachable");
      },
    },
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  runtime.update({ helper: "missing" });
  const manager = new AmbientMusicManager({ service: runtime, store });
  try {
    const initial = await manager.initialize();
    assert.equal(initial.supported, true);
    assert.equal(initial.helper, "missing");
    await assert.rejects(
      manager.download("mrt2_small", true),
      /does not include the native helper/u,
    );
    assert.equal(networkRequests, 0);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function client(): AmbientMusicHttpClient {
  return {
    async request(url) {
      const marker = `/${manifest.revision}/`;
      const relative = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length)) as keyof typeof content;
      return {
        statusCode: 200,
        headers: { etag: `"${sha(content[relative])}"` },
        body: Readable.from([content[relative]]),
      };
    },
  };
}

test("Base remains unqualified until a persisted current-key benchmark passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  runtime.publishMetrics = true;
  const manager = new AmbientMusicManager({
    service: runtime,
    store,
    hardwareKey: "test-hardware|test-os",
    benchmarkWarmupMs: 0,
    benchmarkSampleIntervalMs: 0,
    benchmarkSampleCount: 3,
    sleep: async () => undefined,
  });
  let leakedSilentSpectrum = false;
  let observedSilentBenchmark = false;
  const unsubscribe = manager.subscribe((snapshot) => {
    if (snapshot.benchmarking && snapshot.loadedModel === "mrt2_base") {
      observedSilentBenchmark = true;
      assert.equal(snapshot.metrics, undefined);
    }
    if (snapshot.benchmarking && snapshot.metrics) leakedSilentSpectrum = true;
  });
  try {
    await manager.initialize();
    assert.equal(manager.snapshot().baseBenchmark, undefined);
    await manager.download("mrt2_base", true);
    assert.equal(manager.snapshot().baseBenchmark, undefined);
    runtime.droppedFrames = 9;
    const result = await manager.benchmarkBase(manager.snapshot().revision);
    assert.equal(result.status, "passed");
    assert.equal(result.droppedFrames, 0);
    assert.equal(observedSilentBenchmark, true);
    assert.equal(leakedSilentSpectrum, false);
    assert.equal(manager.snapshot().benchmarking, false);
    assert.equal("key" in result, false);
    assert.deepEqual(runtime.log.slice(0, 8), [
      "load:mrt2_base:benchmark",
      "benchmark:true",
      "prompts",
      "play",
      "stop",
      "unload",
    ]);

    const reloaded = new AmbientMusicManager({
      service: new RuntimeStub(),
      store,
      hardwareKey: "test-hardware|test-os",
    });
    try {
      await reloaded.initialize();
      assert.equal(reloaded.snapshot().baseBenchmark?.status, "passed");
    } finally {
      await reloaded.dispose();
    }
  } finally {
    unsubscribe();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed Base benchmark always disables benchmark mode and unloads Base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-failed-benchmark-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  const manager = new AmbientMusicManager({
    service: runtime,
    store,
    benchmarkWarmupMs: 0,
    benchmarkSampleIntervalMs: 0,
    benchmarkSampleCount: 1,
    sleep: async () => undefined,
  });
  try {
    await manager.initialize();
    await manager.download("mrt2_base", true);
    runtime.metricError = new Error("metrics unavailable");
    await assert.rejects(manager.benchmarkBase(manager.snapshot().revision), /metrics unavailable/);
    assert.equal(manager.snapshot().loadedModel, undefined);
    assert.equal(manager.snapshot().baseBenchmark, undefined);
    assert.deepEqual(runtime.log.slice(-2), ["stop", "unload"]);

    runtime.update({ model: "mrt2_base", playback: "paused", helper: "ready" });
    await assert.rejects(manager.play(), /pass the Base real-time benchmark/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly unloaded selection no longer blocks the Base benchmark", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-unload-benchmark-"));
  const store = new AmbientMusicModelStore({ root, manifest, httpClient: client(), availableBytes: async () => Number.MAX_SAFE_INTEGER });
  const manager = new AmbientMusicManager({
    service: new RuntimeStub(),
    store,
    benchmarkWarmupMs: 0,
    benchmarkSampleIntervalMs: 0,
    benchmarkSampleCount: 1,
    sleep: async () => undefined,
  });
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    await manager.download("mrt2_base", true);
    await manager.load("mrt2_small");
    await assert.rejects(manager.benchmarkBase(manager.snapshot().revision), /Unload the selected/);
    await manager.unload();
    assert.equal((await manager.benchmarkBase(manager.snapshot().revision)).status, "passed");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("forged persisted benchmark data cannot qualify Base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-forged-benchmark-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const setup = new AmbientMusicManager({ service: new RuntimeStub(), store, hardwareKey: "forged-hardware" });
  try {
    await setup.initialize();
    await setup.download("mrt2_base", true);
    await setup.dispose();
    const key = `aiden-ambient-music-helper/1|${manifest.revision}|forged-hardware`;
    await writeFile(path.join(root, "benchmark-results.json"), JSON.stringify({
      version: 1,
      results: { [key]: {
        key,
        status: "passed",
        measuredAt: new Date().toISOString(),
        p50FrameMs: 20,
        p95FrameMs: 80,
        droppedFrames: 3,
        minimumBufferRatio: 0.1,
      } },
    }));

    const runtime = new RuntimeStub();
    const manager = new AmbientMusicManager({ service: runtime, store, hardwareKey: "forged-hardware" });
    try {
      await manager.initialize();
      assert.equal(manager.snapshot().baseBenchmark, undefined);
      await assert.rejects(manager.load("mrt2_base"), /Run and pass/);
    } finally {
      await manager.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weight updates coalesce and cannot cross a queued model deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-weights-"));
  const store = new AmbientMusicModelStore({ root, manifest, httpClient: client(), availableBytes: async () => Number.MAX_SAFE_INTEGER });
  const runtime = new RuntimeStub();
  const manager = new AmbientMusicManager({ service: runtime, store });
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    await manager.load("mrt2_small");
    await Promise.all([
      manager.setWeights([0.9, 0.1]),
      manager.setWeights([0.4, 0.6]),
      manager.setWeights([0.2, 0.8]),
    ]);
    assert.deepEqual(runtime.log.filter((entry) => entry.startsWith("weights:")), ["weights:0.2,0.8"]);

    const remove = manager.removeModel("mrt2_small", manager.snapshot().revision);
    const staleWeights = manager.setWeights([1]);
    await remove;
    await assert.rejects(staleWeights, /changed before weights/);
    assert.equal(runtime.log.filter((entry) => entry.startsWith("weights:")).length, 1);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale destructive confirmations are rejected inside the manager queue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-stale-remove-"));
  const store = new AmbientMusicModelStore({ root, manifest, httpClient: client(), availableBytes: async () => Number.MAX_SAFE_INTEGER });
  const manager = new AmbientMusicManager({ service: new RuntimeStub(), store });
  try {
    await manager.initialize();
    const initialRevision = manager.snapshot().revision;
    const download = manager.download("mrt2_small", true);
    const staleRemove = manager.removeModel("mrt2_small", initialRevision);
    await download;
    await assert.rejects(staleRemove, /Ambient Music changed/);
    assert.equal(manager.snapshot().models[0].state, "ready");

    const revision = manager.snapshot().revision;
    const first = manager.removeModel("mrt2_small", revision);
    const second = manager.removeModel("mrt2_small", revision);
    await first;
    await assert.rejects(second, /Ambient Music changed/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose starts helper teardown immediately and aborts an active benchmark", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-dispose-"));
  const store = new AmbientMusicModelStore({ root, manifest, httpClient: client(), availableBytes: async () => Number.MAX_SAFE_INTEGER });
  const runtime = new RuntimeStub();
  const manager = new AmbientMusicManager({
    service: runtime,
    store,
    benchmarkWarmupMs: 60_000,
    benchmarkSampleIntervalMs: 0,
    benchmarkSampleCount: 1,
    sleep: async () => await new Promise<void>(() => undefined),
    disposeTimeoutMs: 500,
  });
  try {
    await manager.initialize();
    await manager.download("mrt2_base", true);
    const benchmark = manager.benchmarkBase(manager.snapshot().revision);
    while (!runtime.log.includes("play")) await new Promise((resolve) => setImmediate(resolve));
    await manager.dispose();
    await assert.rejects(benchmark, /cancelled|shutting down/);
    assert.ok(runtime.log.indexOf("dispose") < runtime.log.indexOf("stop"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model deletion unloads the active model before removing its assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-remove-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  const manager = new AmbientMusicManager({ service: runtime, store });
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    await manager.load("mrt2_small");
    runtime.update({ playback: "stopped", model: undefined });
    await manager.removeModel("mrt2_small", manager.snapshot().revision);
    assert.equal(runtime.log.includes("unload"), true);
    assert.equal(manager.snapshot().models[0].state, "not_installed");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration apply is serialized and unloads every partial runtime change on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-apply-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  const manager = new AmbientMusicManager({ service: runtime, store });
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    runtime.controlErrorAt = "variation";
    await assert.rejects(manager.applyConfiguration({
      version: 1,
      selectedModel: "mrt2_small",
      prompts: [{ id: "pads", text: "warm pads", weight: 1 }],
      volumeDb: -21,
      variation: 0.4,
      drumless: true,
    }, true), /variation failed/);
    assert.deepEqual(runtime.log.slice(-6), [
      "load:mrt2_small",
      "prompts",
      "volume:-21",
      "variation:0.4",
      "unload",
    ].slice(-6));
    assert.equal(manager.snapshot().selectedModel, undefined);
    assert.equal(manager.snapshot().loadedModel, undefined);
    assert.equal(manager.snapshot().playback, "stopped");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("sleep permanently cancels an in-flight apply-and-play even after resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-suspend-apply-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  let releasePrompts: () => void = () => undefined;
  runtime.promptGate = new Promise<void>((resolve) => { releasePrompts = resolve; });
  const manager = new AmbientMusicManager({ service: runtime, store });
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    const applying = manager.applyConfiguration({
      version: 1,
      selectedModel: "mrt2_small",
      prompts: [{ id: "pads", text: "warm pads", weight: 1 }],
      volumeDb: -21,
      variation: 0.4,
      drumless: true,
    }, true);
    while (!runtime.log.includes("prompts")) await new Promise((resolve) => setImmediate(resolve));
    manager.handleSystemSuspend();
    manager.handleSystemResume();
    releasePrompts();
    await assert.rejects(applying, /went to sleep/);
    assert.equal(runtime.log.includes("play"), false);
    assert.equal(manager.snapshot().playback, "stopped");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("playing polls runtime pressure, clears after recovery, and stops polling while paused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-pressure-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const runtime = new RuntimeStub();
  runtime.frameMs = 50;
  const manager = new AmbientMusicManager({
    service: runtime,
    store,
    metricsPollIntervalMs: 5,
  });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 1_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Ambient Music metrics polling.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    await manager.load("mrt2_small");
    await manager.play();
    await waitFor(() => manager.snapshot().degradation !== undefined);
    assert.equal(manager.snapshot().degradation?.code, "realtime_pressure");

    runtime.frameMs = 10;
    await waitFor(() => manager.snapshot().degradation === undefined && runtime.metricsCount >= 5);
    await manager.pause();
    const pausedCount = runtime.metricsCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.metricsCount, pausedCount);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("short app-owned lifecycle soak covers background playback, idle unload, sleep, recovery, and quit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-manager-lifecycle-soak-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client(),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const children = new Set<ChildProcessWithoutNullStreams>();
  const service = new AmbientMusicService({
    supported: true,
    helperExecutablePath: () => process.execPath,
    idleUnloadMs: 20,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 30,
    forceReapTimeoutMs: 100,
    spawnHelper: (_executable, _args, options) => {
      const child = spawn(process.execPath, [helperFixture], options) as ChildProcessWithoutNullStreams;
      children.add(child);
      child.once("exit", () => children.delete(child));
      return child;
    },
  });
  const manager = new AmbientMusicManager({
    service,
    store,
    metricsPollIntervalMs: 5,
    disposeTimeoutMs: 500,
  });
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 1_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await manager.initialize();
    await manager.download("mrt2_small", true);
    await manager.applyConfiguration({
      version: 1,
      selectedModel: "mrt2_small",
      prompts: [{ id: "pads", text: "warm pads", weight: 1 }],
      volumeDb: -21,
      variation: 0.4,
      drumless: true,
    }, true);
    // Window focus and renderer lifetime deliberately have no playback hook.
    await waitFor(() => manager.snapshot().metrics !== undefined, "Background metrics did not update.");
    assert.equal(manager.snapshot().playback, "playing");

    await manager.pause();
    await waitFor(() => manager.snapshot().loadedModel === undefined, "Idle model unload did not occur.");
    await manager.play();
    assert.equal(manager.snapshot().playback, "playing");

    manager.handleSystemSuspend();
    await waitFor(() => manager.snapshot().playback === "paused", "Suspend did not stop playback.");
    manager.handleSystemResume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(manager.snapshot().playback, "playing");

    await manager.dispose();
    assert.equal(children.size, 0);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
