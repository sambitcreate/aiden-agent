/* global URL, process */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseAmbientMusicSoakArguments,
  parseProcessCpuTime,
  runAmbientMusicSoak,
} from "./ambient-music-soak.mjs";

const fixture = fileURLToPath(new URL("../main/services/fixtures/ambient-music-fake-helper.mjs", import.meta.url));

test("soak arguments require explicit installed paths and bounded durations", () => {
  assert.throws(() => parseAmbientMusicSoakArguments([]), /Provide --helper/);
  assert.throws(() => parseAmbientMusicSoakArguments([
    "--helper", process.execPath,
    "--model-root", process.cwd(),
    "--output", "receipt.json",
    "--active-ms", "-1",
  ]), /zero or a positive integer/);
});

test("process CPU time parsing supports macOS clock and day formats", () => {
  assert.equal(parseProcessCpuTime("0:00.03"), 30);
  assert.equal(parseProcessCpuTime("2:03:04.50"), 7_384_500);
  assert.equal(parseProcessCpuTime("1-02:03:04.50"), 93_784_500);
  assert.throws(() => parseProcessCpuTime("0:99.00"), /invalid CPU time/);
});

test("short contract soak exits the helper and writes aggregate-only receipt data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-"));
  const output = path.join(root, "receipt.json");
  let cpuTimeMs = 0;
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", output,
        "--active-ms", "60",
        "--paused-ms", "20",
        "--sample-ms", "10",
        "--cycle-ms", "25",
        "--idle-unload-ms", "10",
        "--max-growth-mb", "64",
      ]),
      processSampler: async (_pid, context) => ({
        rssKb: context.idleUnloadObserved ? 1_000 : 200_000,
        cpuTimeMs: (cpuTimeMs += 0.1),
      }),
      networkSampler: async () => 0,
    };
    const receipt = await runAmbientMusicSoak(options);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.helperExited, true);
    assert.ok(receipt.metricSamples >= 1);
    assert.ok(receipt.pauseResumeCycles >= 1);
    assert.ok(receipt.activeResourceSamples >= 1);
    assert.ok(receipt.pausedResourceSamples >= 1);
    assert.ok(receipt.activeCpuSamples >= 1);
    assert.ok(receipt.pausedCpuSamples >= 1);
    assert.ok(receipt.maximumPausedCpuPercent <= options.maxPausedCpuPercent);
    assert.equal(receipt.idleUnloadObserved, true);
    assert.ok(receipt.idleUnloadLatencyMs >= 10);
    assert.ok(receipt.idleUnloadReclaimedKb >= options.minIdleReclaimMb * 1_024);
    assert.equal(receipt.droppedFrames, 0);
    assert.ok(receipt.maximumConsecutivePressureSamples < 2);
    assert.ok(receipt.positiveInferenceSamples > 0);
    assert.ok(receipt.activeCpuTimeMs > 0);
    assert.equal(receipt.networkSocketObservations, 0);
    const raw = await readFile(output, "utf8");
    const persisted = JSON.parse(raw);
    assert.deepEqual(Object.keys(persisted).sort(), [
      "activeCpuSamples", "activeCpuTimeMs", "activeDurationMs", "activeResourceSamples",
      "completedAt", "droppedFrames", "duplicateStateEvents", "helperEvents", "helperExited",
      "idleUnloadLatencyMs", "idleUnloadObserved", "idleUnloadReclaimedKb", "initialRssKb", "maximumActiveCpuPercent",
      "maximumConsecutivePressureSamples", "maximumFrameMs", "maximumPausedCpuPercent",
      "maximumRssKb", "maximumTransformerMs", "metricSamples", "minimumBufferRatio", "model",
      "networkSamples", "networkSocketObservations", "passed", "pauseResumeCycles", "pausedCpuSamples",
      "pausedCpuTimeMs", "pausedDurationMs", "pausedResourceSamples", "peakRssGrowthKb",
      "positiveInferenceSamples", "pressuredMetricSamples", "rssGrowthKb", "startedAt", "stderrBytes",
      "version", "finalRssKb",
    ].sort());
    assert.ok(Object.values(persisted).every((value) =>
      value === null || ["boolean", "number", "string"].includes(typeof value)));
    assert.doesNotMatch(raw, /calm instrumental|model-root|aiden-ambient-soak/u);
    assert.doesNotMatch(raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["invalidOutputIgnoreTerm", "unterminatedOverflowIgnoreTerm"]) {
  test(`fault cleanup escalates and reaps a TERM-ignoring ${mode} helper`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-fault-"));
    const output = path.join(root, "receipt.json");
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", output,
          "--active-ms", "20",
          "--paused-ms", "0",
          "--sample-ms", "5",
          "--cycle-ms", "10",
        ]),
        teardownGraceMs: 20,
        helperEnv: { AIDEN_AMBIENT_TEST_MODE: mode },
        processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
        networkSampler: async () => 0,
      };
      const started = Date.now();
      await assert.rejects(runAmbientMusicSoak(options));
      assert.ok(Date.now() - started < 1_000, "fault cleanup should escalate without hanging");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("startup timeout SIGKILLs and reaps a silent TERM-ignoring helper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-start-timeout-"));
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", path.join(root, "receipt.json"),
        "--active-ms", "0",
        "--paused-ms", "0",
      ]),
      startTimeoutMs: 30,
      teardownGraceMs: 20,
      helperEnv: { AIDEN_AMBIENT_TEST_MODE: "silentStartIgnoreTerm" },
      processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
      networkSampler: async () => 0,
    };
    const started = Date.now();
    await assert.rejects(runAmbientMusicSoak(options), /did not become ready/);
    assert.ok(Date.now() - started < 1_000, "startup failure should be reaped without hanging");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["delayedOverflowIgnoreTerm", "delayedStderrIgnoreTerm"]) {
  test(`${mode} failure interrupts waits and reaps the helper`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-delayed-fault-"));
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", path.join(root, "receipt.json"),
          "--active-ms", "500",
          "--paused-ms", "0",
          "--sample-ms", "250",
          "--cycle-ms", "1000",
          "--max-stderr-bytes", "32",
        ]),
        teardownGraceMs: 20,
        helperEnv: { AIDEN_AMBIENT_TEST_MODE: mode },
        processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
        networkSampler: async () => 0,
      };
      const started = Date.now();
      await assert.rejects(runAmbientMusicSoak(options));
      assert.ok(Date.now() - started < 1_000, "delayed protocol failure should interrupt the current wait");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("resource sampling failures fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-sampling-"));
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", path.join(root, "receipt.json"),
        "--active-ms", "0",
        "--paused-ms", "0",
      ]),
      teardownGraceMs: 20,
      processSampler: async () => undefined,
      networkSampler: async () => 0,
    };
    await assert.rejects(runAmbientMusicSoak(options), /resource sampling is unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network sampling failures fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-network-sampling-"));
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", path.join(root, "receipt.json"),
        "--active-ms", "0",
        "--paused-ms", "0",
      ]),
      teardownGraceMs: 20,
      processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
      networkSampler: async () => { throw new Error("network sampler unavailable"); },
    };
    await assert.rejects(runAmbientMusicSoak(options), /network sampler unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coercible but nonnumeric metric types fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-metrics-"));
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", path.join(root, "receipt.json"),
        "--active-ms", "20",
        "--paused-ms", "0",
        "--sample-ms", "5",
        "--cycle-ms", "10",
      ]),
      teardownGraceMs: 20,
      helperEnv: { AIDEN_AMBIENT_TEST_MODE: "coercibleMetrics" },
      processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
      networkSampler: async () => 0,
    };
    await assert.rejects(runAmbientMusicSoak(options), /invalid dropped-frame metric/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [mode, expected] of [
  ["stalePlayback", /stale playback state/],
  ["backwardMetrics", /moved backwards/],
]) {
  test(`${mode} counters fail closed`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-counter-"));
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", path.join(root, "receipt.json"),
          "--active-ms", "20",
          "--paused-ms", "0",
          "--sample-ms", "5",
          "--cycle-ms", "10",
        ]),
        teardownGraceMs: 20,
        helperEnv: { AIDEN_AMBIENT_TEST_MODE: mode },
        processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
        networkSampler: async () => 0,
      };
      await assert.rejects(runAmbientMusicSoak(options), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [mode, expected] of [
  ["epipe", /closed|write|exited/iu],
  ["unexpectedPause", /changed unexpectedly/],
  ["silentMetrics", /bounded resource or shutdown limit/],
]) {
  test(`${mode} cannot produce a passing soak receipt`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-runtime-fault-"));
    let cpuTimeMs = 0;
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", path.join(root, "receipt.json"),
          "--active-ms", "80",
          "--paused-ms", "0",
          "--sample-ms", "20",
          "--cycle-ms", "1000",
        ]),
        teardownGraceMs: 20,
        helperEnv: { AIDEN_AMBIENT_TEST_MODE: mode },
        processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: (cpuTimeMs += 0.1) }),
        networkSampler: async () => 0,
      };
      await assert.rejects(runAmbientMusicSoak(options), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("peak RSS growth fails the receipt even when final RSS recovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-memory-"));
  let sampleIndex = 0;
  let cpuTimeMs = 0;
  try {
    const output = path.join(root, "receipt.json");
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", output,
        "--active-ms", "60",
        "--paused-ms", "0",
        "--sample-ms", "10",
        "--cycle-ms", "1000",
        "--max-growth-mb", "1",
      ]),
      processSampler: async () => ({
        rssKb: ++sampleIndex === 2 ? 3_000 : 1_000,
        cpuTimeMs: (cpuTimeMs += 0.1),
      }),
      networkSampler: async () => 0,
    };
    await assert.rejects(runAmbientMusicSoak(options), /bounded resource or shutdown limit/);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    assert.equal(receipt.passed, false);
    assert.ok(receipt.peakRssGrowthKb > 1_024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an observed helper network socket aborts the soak immediately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-network-"));
  try {
    const options = {
      ...parseAmbientMusicSoakArguments([
        "--helper", process.execPath,
        "--helper-arg", fixture,
        "--model-root", root,
        "--output", path.join(root, "receipt.json"),
        "--active-ms", "60",
        "--paused-ms", "0",
      ]),
      teardownGraceMs: 20,
      processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: 0 }),
      networkSampler: async () => 1,
    };
    await assert.rejects(runAmbientMusicSoak(options), /opened a network socket/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [mode, receiptAssertion] of [
  ["duplicateStateEvents", (receipt) => assert.ok(receipt.duplicateStateEvents > 0)],
  ["sustainedPressure", (receipt) => assert.ok(receipt.maximumConsecutivePressureSamples >= 2)],
]) {
  test(`${mode} fails the completed soak receipt`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-soak-gate-"));
    const output = path.join(root, "receipt.json");
    let cpuTimeMs = 0;
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", output,
          "--active-ms", "80",
          "--paused-ms", "0",
          "--sample-ms", "10",
          "--cycle-ms", "1000",
        ]),
        helperEnv: { AIDEN_AMBIENT_TEST_MODE: mode },
        processSampler: async () => ({ rssKb: 1_000, cpuTimeMs: (cpuTimeMs += 0.1) }),
        networkSampler: async () => 0,
      };
      await assert.rejects(runAmbientMusicSoak(options), /bounded resource or shutdown limit/);
      const receipt = JSON.parse(await readFile(output, "utf8"));
      receiptAssertion(receipt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("paused CPU hot loops and idle unload without RSS reclamation fail their gates", async () => {
  for (const kind of ["pausedCpu", "idleReclaim"]) {
    const root = await mkdtemp(path.join(tmpdir(), `aiden-ambient-soak-${kind}-`));
    const output = path.join(root, "receipt.json");
    let cpuTimeMs = 0;
    try {
      const options = {
        ...parseAmbientMusicSoakArguments([
          "--helper", process.execPath,
          "--helper-arg", fixture,
          "--model-root", root,
          "--output", output,
          "--active-ms", "40",
          "--paused-ms", "50",
          "--sample-ms", "10",
          "--cycle-ms", "1000",
          "--idle-unload-ms", kind === "idleReclaim" ? "10" : "100",
        ]),
        processSampler: async () => ({
          rssKb: 200_000,
          cpuTimeMs: (cpuTimeMs += kind === "pausedCpu" ? 5 : 0.1),
        }),
        networkSampler: async () => 0,
      };
      await assert.rejects(runAmbientMusicSoak(options), /bounded resource or shutdown limit/);
      const receipt = JSON.parse(await readFile(output, "utf8"));
      if (kind === "pausedCpu") assert.ok(receipt.maximumPausedCpuPercent > options.maxPausedCpuPercent);
      else {
        assert.equal(receipt.idleUnloadObserved, true);
        assert.equal(receipt.idleUnloadReclaimedKb, 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
