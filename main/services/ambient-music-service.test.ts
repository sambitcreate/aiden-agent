import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AmbientMusicService, type AmbientMusicServiceOptions } from "./ambient-music-service.js";

const fixture = fileURLToPath(new URL("./fixtures/ambient-music-fake-helper.mjs", import.meta.url));

async function createHarness(modes: string[], overrides: AmbientMusicServiceOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-music-service-"));
  let spawnCount = 0;
  let activeChildren = 0;
  const service = new AmbientMusicService({
    supported: true,
    helperExecutablePath: () => process.execPath,
    requestTimeoutMs: 80,
    startTimeoutMs: 200,
    shutdownTimeoutMs: 30,
    forceReapTimeoutMs: 100,
    idleUnloadMs: 10_000,
    spawnHelper: (_executable, _args, options) => {
      const mode = modes[Math.min(spawnCount, modes.length - 1)] ?? "normal";
      spawnCount += 1;
      const child = spawn(process.execPath, [fixture], {
        ...options,
        env: { ...options.env, AIDEN_AMBIENT_TEST_MODE: mode },
      }) as ChildProcessWithoutNullStreams;
      activeChildren += 1;
      child.once("exit", () => { activeChildren -= 1; });
      return child;
    },
    ...overrides,
  });
  return {
    root,
    service,
    install: { root, revision: "test-revision", verified: true as const },
    spawnCount: () => spawnCount,
    activeChildren: () => activeChildren,
    async cleanup() {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("newer remote playback state wins over an older UI response", async () => {
  const harness = await createHarness(["interleaved"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    assert.equal(harness.service.snapshot().playback, "paused");
  } finally {
    await harness.cleanup();
  }
});

test("initialization reports helper availability without spawning it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-helper-probe-"));
  const executable = path.join(root, "Aiden Ambient Music Helper");
  let spawnCount = 0;
  const service = new AmbientMusicService({
    supported: true,
    helperExecutablePath: () => executable,
    spawnHelper: () => {
      spawnCount += 1;
      throw new Error("initialization must not spawn");
    },
  });
  try {
    assert.equal(service.initialize().helper, "missing");
    assert.equal(spawnCount, 0);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    assert.equal(service.initialize().helper, "stopped");
    assert.equal(spawnCount, 0);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("an output-route rebuild pauses authoritatively without autoplay", async () => {
  const harness = await createHarness(["routeRecovered"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    assert.equal(harness.service.snapshot().playback, "paused");
    assert.equal(harness.service.snapshot().helper, "ready");
  } finally {
    await harness.cleanup();
  }
});

test("output-route recovery preserves stopped and system-suspended playback", async () => {
  for (const mode of ["routeAfterStop", "routeDuringSuspend"]) {
    const harness = await createHarness([mode]);
    try {
      await harness.service.load(harness.install, "mrt2_small");
      await harness.service.setPrompts(["ambient pads"], [1]);
      await harness.service.play();
      if (mode === "routeAfterStop") await harness.service.stop();
      else harness.service.handleSystemSuspend();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        harness.service.snapshot().playback,
        mode === "routeAfterStop" ? "stopped" : "paused",
      );
    } finally {
      await harness.cleanup();
    }
  }
});

test("system suspend pauses and resume never restores playback intent", async () => {
  const harness = await createHarness(["normal"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    harness.service.handleSystemSuspend();
    const deadline = Date.now() + 500;
    while (harness.service.snapshot().playback !== "paused") {
      if (Date.now() >= deadline) throw new Error("Ambient Music did not pause before suspend.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    harness.service.handleSystemResume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.service.snapshot().playback, "paused");
  } finally {
    await harness.cleanup();
  }
});

test("a remote Play racing suspend is rejected and cannot restore audio", async () => {
  const harness = await createHarness(["remotePlayDuringSuspend"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    harness.service.handleSystemSuspend();
    const deadline = Date.now() + 500;
    while (harness.service.snapshot().playback !== "paused") {
      if (Date.now() >= deadline) throw new Error("Remote Play survived system suspend.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    harness.service.handleSystemResume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.service.snapshot().playback, "paused");
  } finally {
    await harness.cleanup();
  }
});

test("invalid runtime metrics poison the helper instead of creating a polling loop", async () => {
  const harness = await createHarness(["invalidMetrics"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await assert.rejects(harness.service.metrics(), /invalid metrics/iu);
    assert.equal(harness.service.snapshot().helper, "crashed");
    assert.equal(harness.service.snapshot().playback, "error");
  } finally {
    await harness.cleanup();
  }
});

test("fractional drops and impossible buffer metrics poison the helper", async () => {
  const harness = await createHarness(["invalidMetricsShape"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await assert.rejects(harness.service.metrics(), /invalid metrics/iu);
    assert.equal(harness.service.snapshot().helper, "crashed");
  } finally {
    await harness.cleanup();
  }
});

test("normalized visualizer energy is projected and malformed bands poison the helper", async () => {
  const healthy = await createHarness(["normal"]);
  try {
    await healthy.service.load(healthy.install, "mrt2_small");
    const metrics = await healthy.service.metrics();
    assert.equal(metrics.visualizerBands?.length, 18);
    assert.equal(metrics.visualizerBands?.[0], 0);
    assert.equal(metrics.visualizerBands?.[17], 1);
  } finally {
    await healthy.cleanup();
  }

  const malformed = await createHarness(["invalidVisualizerMetrics"]);
  try {
    await malformed.service.load(malformed.install, "mrt2_small");
    await assert.rejects(malformed.service.metrics(), /invalid metrics/iu);
    assert.equal(malformed.service.snapshot().helper, "crashed");
  } finally {
    await malformed.cleanup();
  }
});

test("visualizer telemetry never crosses a playback generation", async () => {
  const harness = await createHarness(["normal"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    await harness.service.metrics();
    assert.equal(harness.service.snapshot().metrics?.visualizerBands?.length, 18);

    await harness.service.pause();
    assert.equal(harness.service.snapshot().metrics, undefined);
    await harness.service.play();
    assert.equal(harness.service.snapshot().metrics, undefined);
    await harness.service.metrics();
    await harness.service.reset();
    assert.equal(harness.service.snapshot().metrics, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("model-load failure reaps the partial helper before a fresh retry", async () => {
  const harness = await createHarness(["loadFailure", "normal"]);
  try {
    await assert.rejects(
      harness.service.load(harness.install, "mrt2_small"),
      (error: unknown) => error instanceof Error &&
        error.message === "Ambient Music could not load the verified model." &&
        !error.message.includes("/Users/"),
    );
    assert.equal(harness.service.snapshot().helper, "crashed");
    assert.equal(harness.activeChildren(), 0);
    await harness.service.load(harness.install, "mrt2_small");
    assert.equal(harness.spawnCount(), 2);
  } finally {
    await harness.cleanup();
  }
});

test("fatal helper diagnostics cannot expose native paths or stack output", async () => {
  const harness = await createHarness(["hostileFatal"]);
  try {
    await assert.rejects(
      harness.service.load(harness.install, "mrt2_small"),
      (error: unknown) => error instanceof Error &&
        error.message === "Ambient Music could not open the current audio output." &&
        !error.message.includes("/Users/") &&
        !error.message.includes("stack"),
    );
    assert.equal(
      harness.service.snapshot().error?.message,
      "Ambient Music could not open the current audio output.",
    );
  } finally {
    await harness.cleanup();
  }
});

test("inherited object names cannot bypass the helper error allowlist", async () => {
  const harness = await createHarness(["prototypeError"]);
  try {
    await assert.rejects(
      harness.service.load(harness.install, "mrt2_small"),
      /violated its process contract/iu,
    );
    assert.equal(harness.service.snapshot().helper, "crashed");
    assert.equal(harness.service.snapshot().error?.code, "invalid_helper_error");
  } finally {
    await harness.cleanup();
  }
});

test("a mutating request timeout poisons and reaps the helper", async () => {
  const harness = await createHarness(["timeout"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await assert.rejects(harness.service.play(), /did not complete play/);
    assert.equal(harness.service.snapshot().helper, "crashed");
    assert.equal(harness.service.snapshot().model, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("a closed helper stdin cannot surface an unhandled EPIPE", async () => {
  const harness = await createHarness(["epipe"]);
  try {
    await assert.rejects(harness.service.load(harness.install, "mrt2_small"));
    assert.equal(harness.service.snapshot().helper, "crashed");
  } finally {
    await harness.cleanup();
  }
});

test("delayed helper stderr overflow poisons and reaps the service process", async () => {
  const harness = await createHarness(["serviceStderrOverflow"], { maxStderrBytes: 32 });
  try {
    await assert.rejects(harness.service.load(harness.install, "mrt2_small"));
    assert.equal(harness.service.snapshot().helper, "crashed");
    assert.equal(harness.activeChildren(), 0);
  } finally {
    await harness.cleanup();
  }
});

test("explicit Play performs one bounded recovery after a helper crash", async () => {
  const harness = await createHarness(["crashOnPlay", "normal"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await assert.rejects(harness.service.play(), /exited unexpectedly/);
    assert.equal(harness.service.snapshot().helper, "crashed");
    await harness.service.play();
    assert.equal(harness.service.snapshot().playback, "playing");
    assert.equal(harness.spawnCount(), 2);
  } finally {
    await harness.cleanup();
  }
});

test("dispose is irreversible and prevents post-quit respawn", async () => {
  const harness = await createHarness(["normal"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.dispose();
    await assert.rejects(harness.service.play(), /shutting down/);
    assert.equal(harness.spawnCount(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("dispose SIGKILLs and reaps a helper that ignores shutdown and TERM", async () => {
  const harness = await createHarness(["ignoreTerm"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.dispose();
    assert.equal(harness.activeChildren(), 0);
  } finally {
    await harness.cleanup();
  }
});

test("idle pause unloads without autoplay and explicit Play reloads the selected model", async () => {
  const harness = await createHarness(["normal"], { idleUnloadMs: 20 });
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.service.snapshot().model, undefined);
    assert.equal(harness.service.snapshot().playback, "stopped");
    await harness.service.play();
    assert.equal(harness.service.snapshot().model, "mrt2_small");
    assert.equal(harness.service.snapshot().playback, "playing");
  } finally {
    await harness.cleanup();
  }
});

test("a remote Play at the idle boundary prevents the helper from unloading", async () => {
  const harness = await createHarness(["remotePlayBeforeIdleUnload"], { idleUnloadMs: 20 });
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.service.snapshot().model, "mrt2_small");
    assert.equal(harness.service.snapshot().playback, "playing");
  } finally {
    await harness.cleanup();
  }
});

test("explicit unload after idle clears recovery state for deleted assets", async () => {
  const harness = await createHarness(["normal"], { idleUnloadMs: 20 });
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.service.snapshot().model, undefined);
    await harness.service.unload();
    await assert.rejects(harness.service.play(), /Download and load Ambient Music first/);
  } finally {
    await harness.cleanup();
  }
});

test("Play is rejected until a prompt mix has committed", async () => {
  const harness = await createHarness(["normal"]);
  try {
    await harness.service.load(harness.install, "mrt2_small");
    await assert.rejects(harness.service.play(), /Apply a valid Ambient Music prompt mix/);
    assert.equal(harness.service.snapshot().playback, "paused");
    await harness.service.setPrompts(["ambient pads"], [1]);
    await harness.service.play();
    assert.equal(harness.service.snapshot().playback, "playing");
  } finally {
    await harness.cleanup();
  }
});

test("unsupported snapshots expose a bounded typed reason", async () => {
  const service = new AmbientMusicService({ supported: false, supportReason: "requires_apple_silicon" });
  try {
    assert.equal(service.snapshot().supported, false);
    assert.equal(service.snapshot().supportReason, "requires_apple_silicon");
    await assert.rejects(
      service.load({ root: process.cwd(), revision: "unused", verified: true }, "mrt2_small"),
      /not supported/,
    );
  } finally {
    await service.dispose();
  }
});
