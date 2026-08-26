#!/usr/bin/env node

/* global Buffer, clearTimeout, process, setTimeout */

import { spawn, execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;
const HELPER_BUILD_IDENTITY = "aiden-ambient-music-helper/1";
const HELPER_EVENT_NAMES = new Set(["ready", "remoteCommand", "promptEncoding", "audioState", "fatal"]);
const PLAYBACK_STATES = new Set(["loading", "playing", "paused", "stopped", "error"]);
const DEFAULT_ACTIVE_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_PAUSED_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_IDLE_UNLOAD_MS = 5 * 60 * 1_000;

function parsePositive(value, label, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "zero or a positive" : "a positive"} integer.`);
  }
  return parsed;
}

export function parseAmbientMusicSoakArguments(argv) {
  const values = {
    helperArgs: [],
    model: "mrt2_small",
    activeMs: DEFAULT_ACTIVE_MS,
    pausedMs: DEFAULT_PAUSED_MS,
    sampleMs: 10_000,
    cycleMs: 10 * 60_000,
    maxGrowthMb: 1_024,
    minIdleReclaimMb: 128,
    maxPausedCpuPercent: 10,
    maxStderrBytes: 4 * 1024 * 1024,
    idleUnloadMs: DEFAULT_IDLE_UNLOAD_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value.`);
      index += 1;
      return value;
    };
    if (flag === "--helper") values.helper = next();
    else if (flag === "--helper-arg") values.helperArgs.push(next());
    else if (flag === "--model-root") values.modelRoot = next();
    else if (flag === "--model") values.model = next();
    else if (flag === "--output") values.output = next();
    else if (flag === "--active-ms") values.activeMs = parsePositive(next(), flag, true);
    else if (flag === "--paused-ms") values.pausedMs = parsePositive(next(), flag, true);
    else if (flag === "--sample-ms") values.sampleMs = parsePositive(next(), flag);
    else if (flag === "--cycle-ms") values.cycleMs = parsePositive(next(), flag);
    else if (flag === "--idle-unload-ms") values.idleUnloadMs = parsePositive(next(), flag, true);
    else if (flag === "--max-growth-mb") values.maxGrowthMb = parsePositive(next(), flag);
    else if (flag === "--min-idle-reclaim-mb") values.minIdleReclaimMb = parsePositive(next(), flag, true);
    else if (flag === "--max-paused-cpu-percent") values.maxPausedCpuPercent = parsePositive(next(), flag);
    else if (flag === "--max-stderr-bytes") values.maxStderrBytes = parsePositive(next(), flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!values.helper || !values.modelRoot || !values.output) {
    throw new Error("Provide --helper, --model-root, and --output.");
  }
  if (values.model !== "mrt2_small" && values.model !== "mrt2_base") {
    throw new Error("--model must be mrt2_small or mrt2_base.");
  }
  return {
    ...values,
    helper: path.resolve(values.helper),
    modelRoot: path.resolve(values.modelRoot),
    output: path.resolve(values.output),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function helperEnvironment() {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

async function processSample(pid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=,time=", "-p", String(pid)], {
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  const match = /^\s*(\d+)\s+([-\d:.]+)\s*$/u.exec(stdout);
  if (!match) throw new Error("Ambient Music resource sampling is unavailable.");
  const rssKb = Number(match[1]);
  const cpuTimeMs = parseProcessCpuTime(match[2]);
  if (!Number.isFinite(rssKb) || rssKb <= 0) {
    throw new Error("Ambient Music resource sampling returned invalid values.");
  }
  return { rssKb, cpuTimeMs };
}

async function networkSample(pid) {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP", "-a", "-p", String(pid), "-iTCP", "-iUDP", "-Fn",
    ], { timeout: 2_000, maxBuffer: 64 * 1024 });
    return stdout.split("\n").filter((line) => line.startsWith("n")).length;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      const stdout = "stdout" in error ? String(error.stdout ?? "").trim() : "";
      const stderr = "stderr" in error ? String(error.stderr ?? "").trim() : "";
      if (stdout.length === 0 && stderr.length === 0) return 0;
    }
    throw new Error("Ambient Music network sampling is unavailable.");
  }
}

export function parseProcessCpuTime(value) {
  const [dayPart, clockPart] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const days = Number(dayPart);
  const fields = clockPart.split(":").map(Number);
  if (
    !Number.isSafeInteger(days) || days < 0 ||
    (fields.length !== 2 && fields.length !== 3) ||
    fields.some((field) => !Number.isFinite(field) || field < 0)
  ) throw new Error("Ambient Music resource sampling returned invalid CPU time.");
  const [hours, minutes, seconds] = fields.length === 3
    ? fields
    : [0, fields[0], fields[1]];
  if (minutes >= 60 || seconds >= 60) {
    throw new Error("Ambient Music resource sampling returned invalid CPU time.");
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

function waitForExit(exitPromise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateChild(child, exitPromise, graceMs = 1_000) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(exitPromise, graceMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(exitPromise, Math.max(2_000, graceMs)))) {
    throw new Error("Ambient Music helper could not be reaped.");
  }
}

class HelperProtocol {
  constructor(child, maximumStderrBytes, startTimeoutMs) {
    this.child = child;
    this.maximumStderrBytes = maximumStderrBytes;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.eventsSeen = 0;
    this.duplicateStateEvents = 0;
    this.lastEventSignature = undefined;
    this.lastEventSequence = 0;
    this.lastPlaybackRevision = 0;
    this.expectedPlaybackState = undefined;
    this.stderrBytes = 0;
    this.stdoutPending = Buffer.alloc(0);
    this.failed = false;
    this.failureError = undefined;
    this.expectedExit = false;
    this.failureSignal = new Promise((resolve) => { this.resolveFailure = resolve; });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => {
      this.fail(new Error("Ambient Music helper did not become ready during soak."));
    }, startTimeoutMs);
    child.stdout.on("data", (chunk) => this.onStdoutChunk(chunk));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > this.maximumStderrBytes) {
        this.fail(new Error("Ambient Music helper stderr exceeded the soak limit."));
      }
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Ambient Music helper exited (${code ?? signal ?? "unknown"}).`);
      if (!this.expectedExit || this.pending.size > 0) this.fail(error);
    });
    child.once("error", (error) => this.fail(error));
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.failureError = error;
    clearTimeout(this.readyTimer);
    this.resolveFailure(error);
    this.rejectReady(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
  }

  onStdoutChunk(rawChunk) {
    if (this.failed) return;
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let start = 0;
    for (let newline = chunk.indexOf(0x0a, start); newline >= 0; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      if (this.stdoutPending.length + piece.length > 64 * 1024) {
        this.fail(new Error("Ambient Music helper stdout exceeded the soak line limit."));
        return;
      }
      const line = this.stdoutPending.length > 0
        ? Buffer.concat([this.stdoutPending, piece])
        : piece;
      this.stdoutPending = Buffer.alloc(0);
      if (line.length > 0) this.onLine(line.toString("utf8"));
      start = newline + 1;
    }
    const remainder = chunk.subarray(start);
    if (this.stdoutPending.length + remainder.length > 64 * 1024) {
      this.fail(new Error("Ambient Music helper stdout exceeded the soak line limit."));
      return;
    }
    if (remainder.length > 0) {
      this.stdoutPending = this.stdoutPending.length > 0
        ? Buffer.concat([this.stdoutPending, remainder])
        : Buffer.from(remainder);
    }
  }

  onLine(line) {
    if (this.failed) return;
    let message;
    try { message = JSON.parse(line); } catch {
      this.fail(new Error("Ambient Music helper emitted invalid JSON during soak."));
      return;
    }
    if (message?.version !== PROTOCOL_VERSION) {
      this.fail(new Error("Ambient Music helper emitted an unsupported protocol version."));
      return;
    }
    if (message.type === "event") {
      if (!HELPER_EVENT_NAMES.has(message.event) || !message.detail || typeof message.detail !== "object") {
        this.fail(new Error("Ambient Music helper emitted an unknown event during soak."));
        return;
      }
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= this.lastEventSequence) {
        this.fail(new Error("Ambient Music helper emitted a stale event sequence during soak."));
        return;
      }
      this.lastEventSequence = message.sequence;
      this.eventsSeen += 1;
      if (message.detail?.playback) {
        try {
          this.acceptPlayback(message.detail.playback, `${message.event} event`);
          if (
            this.expectedPlaybackState &&
            message.detail.playback.state !== this.expectedPlaybackState
          ) throw new Error("Ambient Music playback changed unexpectedly during the soak phase.");
        } catch (error) {
          this.fail(error);
          return;
        }
      }
      const state = message.detail?.playback?.state ?? message.detail?.state ?? "";
      const signature = `${message.event}:${state}`;
      if (signature === this.lastEventSignature) this.duplicateStateEvents += 1;
      this.lastEventSignature = signature;
      if (message.event === "ready") {
        clearTimeout(this.readyTimer);
        this.resolveReady(message.detail);
      }
      if (
        message.event === "promptEncoding" &&
        message.detail.state !== "ready" &&
        message.detail.state !== "failed"
      ) {
        this.fail(new Error("Ambient Music helper emitted an invalid prompt event during soak."));
        return;
      }
      if (message.event === "fatal") {
        const error = new Error(message.detail?.message ?? "Ambient Music helper failed.");
        this.fail(error);
      }
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string" || typeof message.ok !== "boolean") {
      this.fail(new Error("Ambient Music helper emitted an invalid response during soak."));
      return;
    }
    const request = this.pending.get(message.requestId);
    if (!request) {
      this.fail(new Error("Ambient Music helper emitted an unknown response during soak."));
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result ?? {});
    else request.reject(new Error(message.error?.message ?? "Ambient Music request failed."));
  }

  request(method, params = {}) {
    if (this.failed) return Promise.reject(this.failureError);
    const requestId = `soak-${++this.nextRequestId}`;
    const timeoutMs = method === "load" ? 180_000 : method === "setPrompts" ? 60_000 : 10_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Ambient Music ${method} timed out.`));
        this.child.kill("SIGTERM");
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId,
        method,
        params,
      })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.fail(error);
      });
    });
  }

  guard(operation) {
    if (this.failed) return Promise.reject(this.failureError);
    return Promise.race([
      operation,
      this.failureSignal.then((error) => { throw error; }),
    ]);
  }

  wait(milliseconds) {
    return this.guard(delay(milliseconds));
  }

  expectExit() {
    this.expectedExit = true;
  }

  acceptPlayback(playback, label) {
    if (
      !playback ||
      typeof playback.state !== "string" ||
      !PLAYBACK_STATES.has(playback.state) ||
      !Number.isSafeInteger(playback.revision) ||
      playback.revision <= this.lastPlaybackRevision
    ) throw new Error(`Ambient Music ${label} returned stale playback state during soak.`);
    this.lastPlaybackRevision = playback.revision;
  }
}

function requiredMetric(value, label, integer = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(`Ambient Music returned an invalid ${label} metric during soak.`);
  }
  return value;
}

function requirePlaybackResult(protocol, result, expectedState, label) {
  const playback = result?.playback;
  if (
    !playback ||
    playback.state !== expectedState ||
    !Number.isSafeInteger(playback.revision) ||
    playback.revision < 1
  ) throw new Error(`Ambient Music ${label} returned invalid playback state during soak.`);
  protocol.acceptPlayback(playback, label);
  protocol.expectedPlaybackState = expectedState;
  return playback;
}

export async function runAmbientMusicSoak(options) {
  const startedAt = Date.now();
  const child = spawn(options.helper, [
    ...options.helperArgs,
    "--model-root",
    options.modelRoot,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...helperEnvironment(), ...(options.helperEnv ?? {}) },
  });
  const protocol = new HelperProtocol(child, options.maxStderrBytes, options.startTimeoutMs ?? 10_000);
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  const aggregate = {
    metricSamples: 0,
    droppedFrames: 0,
    maximumFrameMs: 0,
    maximumTransformerMs: 0,
    positiveInferenceSamples: 0,
    minimumBufferRatio: 1,
    initialRssKb: undefined,
    maximumRssKb: 0,
    finalRssKb: undefined,
    activeResourceSamples: 0,
    pausedResourceSamples: 0,
    activeCpuSamples: 0,
    pausedCpuSamples: 0,
    maximumActiveCpuPercent: 0,
    maximumPausedCpuPercent: 0,
    activeCpuTimeMs: 0,
    pausedCpuTimeMs: 0,
    networkSamples: 0,
    networkSocketObservations: 0,
    pauseResumeCycles: 0,
    pressuredMetricSamples: 0,
    maximumConsecutivePressureSamples: 0,
    idleUnloadObserved: false,
    idleUnloadLatencyMs: undefined,
    preIdleUnloadRssKb: undefined,
    minimumPostIdleUnloadRssKb: undefined,
  };
  let previousResourceSample;

  const sampleProcess = async (phase) => {
    const sampler = options.processSampler ?? processSample;
    const sample = await protocol.guard(sampler(child.pid, {
      phase,
      idleUnloadObserved: aggregate.idleUnloadObserved,
    }));
    if (!sample) throw new Error("Ambient Music resource sampling is unavailable.");
    if (
      !Number.isFinite(sample.rssKb) || sample.rssKb <= 0 ||
      !Number.isFinite(sample.cpuTimeMs) || sample.cpuTimeMs < 0
    ) throw new Error("Ambient Music resource sampling returned invalid values.");
    const socketSampler = options.networkSampler ?? networkSample;
    const sockets = await protocol.guard(socketSampler(child.pid));
    if (!Number.isSafeInteger(sockets) || sockets < 0) {
      throw new Error("Ambient Music network sampling returned invalid values.");
    }
    aggregate.networkSamples += 1;
    aggregate.networkSocketObservations += sockets;
    if (sockets > 0) {
      throw new Error("Ambient Music helper opened a network socket during soak.");
    }
    const sampledAt = Date.now();
    aggregate.initialRssKb ??= sample.rssKb;
    aggregate.finalRssKb = sample.rssKb;
    aggregate.maximumRssKb = Math.max(aggregate.maximumRssKb, sample.rssKb);
    if (aggregate.idleUnloadObserved) {
      aggregate.minimumPostIdleUnloadRssKb = Math.min(
        aggregate.minimumPostIdleUnloadRssKb ?? sample.rssKb,
        sample.rssKb,
      );
    }
    if (phase === "active") {
      aggregate.activeResourceSamples += 1;
    } else {
      aggregate.pausedResourceSamples += 1;
    }
    if (previousResourceSample?.phase === phase && sampledAt > previousResourceSample.sampledAt) {
      const cpuDeltaMs = sample.cpuTimeMs - previousResourceSample.cpuTimeMs;
      if (cpuDeltaMs < 0) throw new Error("Ambient Music resource CPU time moved backwards.");
      const cpuPercent = (cpuDeltaMs / (sampledAt - previousResourceSample.sampledAt)) * 100;
      if (phase === "active") {
        aggregate.activeCpuSamples += 1;
        aggregate.activeCpuTimeMs += cpuDeltaMs;
        aggregate.maximumActiveCpuPercent = Math.max(aggregate.maximumActiveCpuPercent, cpuPercent);
      } else {
        aggregate.pausedCpuSamples += 1;
        aggregate.pausedCpuTimeMs += cpuDeltaMs;
        aggregate.maximumPausedCpuPercent = Math.max(aggregate.maximumPausedCpuPercent, cpuPercent);
      }
    }
    previousResourceSample = { phase, sampledAt, cpuTimeMs: sample.cpuTimeMs };
  };

  try {
    const ready = await protocol.ready;
    if (
      ready?.protocolVersion !== PROTOCOL_VERSION ||
      ready?.modelRootApproved !== true ||
      ready?.magentaEnabled !== true ||
      ready?.buildIdentity !== HELPER_BUILD_IDENTITY
    ) {
      throw new Error("Ambient Music helper did not approve the installed model root.");
    }
    const hello = await protocol.request("hello");
    if (
      hello.protocolVersion !== PROTOCOL_VERSION ||
      hello.magentaEnabled !== true ||
      hello.buildIdentity !== HELPER_BUILD_IDENTITY
    ) throw new Error("Ambient Music helper capability handshake failed during soak.");
    const loaded = await protocol.request("load", { model: options.model, benchmarkMode: false });
    if (loaded.model !== options.model) {
      throw new Error("Ambient Music helper loaded an unexpected model during soak.");
    }
    requirePlaybackResult(protocol, loaded, "paused", "load");
    const promptResult = await protocol.request("setPrompts", {
      prompts: ["calm instrumental ambient music, soft warm synthesizer, no vocals"],
      weights: [1],
    });
    if (!Array.isArray(promptResult.weights) || promptResult.weights.length !== 1 || promptResult.weights[0] !== 1) {
      throw new Error("Ambient Music helper did not commit the soak prompt mix.");
    }
    const baselineMetrics = await protocol.request("metrics");
    const baselineDroppedFrames = requiredMetric(
      baselineMetrics.droppedFrames,
      "dropped-frame",
      true,
    );
    requirePlaybackResult(protocol, await protocol.request("play"), "playing", "play");
    await sampleProcess("active");

    const activeDeadline = Date.now() + options.activeMs;
    let nextCycle = Date.now() + options.cycleMs;
    let consecutivePressureSamples = 0;
    let previousDroppedFrames = baselineDroppedFrames;
    const sampleMetrics = async () => {
      const metrics = await protocol.request("metrics");
      const frameMs = requiredMetric(metrics.frameMs, "frame-time");
      const transformerMs = requiredMetric(metrics.transformerMs, "transformer-time");
      const bufferAvailable = requiredMetric(metrics.bufferAvailable, "buffer-available");
      const capacity = requiredMetric(metrics.bufferCapacity, "buffer-capacity");
      const cumulativeDroppedFrames = requiredMetric(metrics.droppedFrames, "dropped-frame", true);
      if (capacity <= 0 || bufferAvailable > capacity) {
        throw new Error("Ambient Music returned invalid buffer metrics during soak.");
      }
      if (cumulativeDroppedFrames < previousDroppedFrames) {
        throw new Error("Ambient Music dropped-frame metrics moved backwards during soak.");
      }
      previousDroppedFrames = cumulativeDroppedFrames;
      aggregate.metricSamples += 1;
      const droppedFrames = Math.max(0, cumulativeDroppedFrames - baselineDroppedFrames);
      aggregate.droppedFrames = Math.max(aggregate.droppedFrames, droppedFrames);
      aggregate.maximumFrameMs = Math.max(aggregate.maximumFrameMs, frameMs);
      aggregate.maximumTransformerMs = Math.max(aggregate.maximumTransformerMs, transformerMs);
      if (frameMs > 0 && transformerMs > 0) aggregate.positiveInferenceSamples += 1;
      const ratio = bufferAvailable / capacity;
      aggregate.minimumBufferRatio = Math.min(aggregate.minimumBufferRatio, ratio);
      const pressured = frameMs >= 40 || ratio < 0.25 || droppedFrames > 0;
      consecutivePressureSamples = pressured ? consecutivePressureSamples + 1 : 0;
      if (pressured) aggregate.pressuredMetricSamples += 1;
      aggregate.maximumConsecutivePressureSamples = Math.max(
        aggregate.maximumConsecutivePressureSamples,
        consecutivePressureSamples,
      );
    };
    while (Date.now() < activeDeadline) {
      await sampleMetrics();
      await sampleProcess("active");
      if (Date.now() >= nextCycle) {
        requirePlaybackResult(protocol, await protocol.request("pause"), "paused", "pause");
        await protocol.wait(Math.min(1_000, Math.max(0, activeDeadline - Date.now())));
        if (Date.now() < activeDeadline) {
          requirePlaybackResult(protocol, await protocol.request("play"), "playing", "resume");
        }
        aggregate.pauseResumeCycles += 1;
        nextCycle = Date.now() + options.cycleMs;
      }
      await protocol.wait(Math.min(options.sampleMs, Math.max(0, activeDeadline - Date.now())));
    }
    if (options.activeMs > 0) await sampleMetrics();

    requirePlaybackResult(protocol, await protocol.request("suspend"), "paused", "suspend");
    const pausedStartedAt = Date.now();
    const pausedDeadline = Date.now() + options.pausedMs;
    while (Date.now() < pausedDeadline) {
      let sampledDuringIteration = false;
      const pausedElapsed = Date.now() - pausedStartedAt;
      if (!aggregate.idleUnloadObserved && pausedElapsed >= options.idleUnloadMs) {
        await sampleProcess("paused");
        aggregate.preIdleUnloadRssKb = aggregate.finalRssKb;
        previousResourceSample = undefined;
        const idle = await protocol.request("idleUnload");
        if (idle.skipped !== false) {
          throw new Error("Ambient Music idle unload was unexpectedly skipped.");
        }
        requirePlaybackResult(protocol, idle, "stopped", "idle unload");
        aggregate.idleUnloadObserved = true;
        aggregate.idleUnloadLatencyMs = Date.now() - pausedStartedAt;
        await sampleProcess("paused");
        sampledDuringIteration = true;
      }
      if (!sampledDuringIteration) await sampleProcess("paused");
      const untilUnload = aggregate.idleUnloadObserved
        ? options.sampleMs
        : Math.max(1, options.idleUnloadMs - (Date.now() - pausedStartedAt));
      await protocol.wait(Math.min(
        options.sampleMs,
        untilUnload,
        Math.max(0, pausedDeadline - Date.now()),
      ));
    }
    if (options.pausedMs > 0) await sampleProcess("paused");
    protocol.expectExit();
    await protocol.request("shutdown");
    let exitTimer;
    const exitTimeout = new Promise((resolve) => {
      exitTimer = setTimeout(() => resolve({ timeout: true }), 5_000);
    });
    const exit = await Promise.race([
      exitPromise,
      exitTimeout,
    ]);
    clearTimeout(exitTimer);
    if (exit?.timeout) {
      child.kill("SIGKILL");
      throw new Error("Ambient Music helper did not exit after shutdown.");
    }
    if (aggregate.initialRssKb === undefined || aggregate.finalRssKb === undefined) {
      throw new Error("Ambient Music soak did not collect required memory samples.");
    }
    const growthKb = Math.max(0, aggregate.finalRssKb - aggregate.initialRssKb);
    const peakGrowthKb = Math.max(0, aggregate.maximumRssKb - aggregate.initialRssKb);
    const idleUnloadRequired = options.pausedMs > 0 && options.idleUnloadMs < options.pausedMs;
    const idleUnloadReclaimedKb = aggregate.preIdleUnloadRssKb === undefined ||
      aggregate.minimumPostIdleUnloadRssKb === undefined
      ? 0
      : Math.max(0, aggregate.preIdleUnloadRssKb - aggregate.minimumPostIdleUnloadRssKb);
    const realtimeHealthy = options.activeMs === 0 || (
      aggregate.metricSamples > 0 &&
      aggregate.droppedFrames === 0 &&
      aggregate.maximumConsecutivePressureSamples < 2 &&
      aggregate.positiveInferenceSamples > 0 &&
      aggregate.activeCpuTimeMs > 0
    );
    const passed =
      protocol.stderrBytes <= options.maxStderrBytes &&
      !protocol.failed &&
      growthKb <= options.maxGrowthMb * 1_024 &&
      peakGrowthKb <= options.maxGrowthMb * 1_024 &&
      aggregate.activeResourceSamples > 0 &&
      (options.pausedMs === 0 || aggregate.pausedResourceSamples > 0) &&
      (options.activeMs === 0 || aggregate.activeCpuSamples > 0) &&
      (options.pausedMs === 0 || aggregate.pausedCpuSamples > 0) &&
      aggregate.networkSamples > 0 &&
      aggregate.networkSocketObservations === 0 &&
      aggregate.maximumPausedCpuPercent <= options.maxPausedCpuPercent &&
      realtimeHealthy &&
      protocol.duplicateStateEvents === 0 &&
      (!idleUnloadRequired || (
        aggregate.idleUnloadObserved &&
        idleUnloadReclaimedKb >= options.minIdleReclaimMb * 1_024
      )) &&
      exit.code === 0;
    const receipt = {
      version: 1,
      passed,
      model: options.model,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      activeDurationMs: options.activeMs,
      pausedDurationMs: options.pausedMs,
      metricSamples: aggregate.metricSamples,
      droppedFrames: aggregate.droppedFrames,
      maximumFrameMs: aggregate.maximumFrameMs,
      maximumTransformerMs: aggregate.maximumTransformerMs,
      positiveInferenceSamples: aggregate.positiveInferenceSamples,
      minimumBufferRatio: aggregate.minimumBufferRatio,
      pauseResumeCycles: aggregate.pauseResumeCycles,
      pressuredMetricSamples: aggregate.pressuredMetricSamples,
      maximumConsecutivePressureSamples: aggregate.maximumConsecutivePressureSamples,
      initialRssKb: aggregate.initialRssKb,
      maximumRssKb: aggregate.maximumRssKb,
      finalRssKb: aggregate.finalRssKb,
      rssGrowthKb: growthKb,
      peakRssGrowthKb: peakGrowthKb,
      activeResourceSamples: aggregate.activeResourceSamples,
      pausedResourceSamples: aggregate.pausedResourceSamples,
      activeCpuSamples: aggregate.activeCpuSamples,
      pausedCpuSamples: aggregate.pausedCpuSamples,
      maximumActiveCpuPercent: aggregate.maximumActiveCpuPercent,
      maximumPausedCpuPercent: aggregate.maximumPausedCpuPercent,
      activeCpuTimeMs: aggregate.activeCpuTimeMs,
      pausedCpuTimeMs: aggregate.pausedCpuTimeMs,
      networkSamples: aggregate.networkSamples,
      networkSocketObservations: aggregate.networkSocketObservations,
      idleUnloadObserved: aggregate.idleUnloadObserved,
      idleUnloadLatencyMs: aggregate.idleUnloadLatencyMs,
      idleUnloadReclaimedKb,
      helperEvents: protocol.eventsSeen,
      duplicateStateEvents: protocol.duplicateStateEvents,
      stderrBytes: protocol.stderrBytes,
      helperExited: true,
    };
    await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    if (!passed) throw new Error("Ambient Music soak exceeded a bounded resource or shutdown limit.");
    return receipt;
  } finally {
    await terminateChild(child, exitPromise, options.teardownGraceMs ?? 1_000);
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  runAmbientMusicSoak(parseAmbientMusicSoakArguments(process.argv.slice(2))).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
