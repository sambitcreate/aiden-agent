import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { emptyPerformanceArtifacts, emptyPerformanceMeasurements } from "./performance-fixture.mjs";
import {
  benchmarkConfigRoot,
  benchmarkEnvironment,
  benchmarkProfileRoot,
  assertPerformanceLaunchTicketPath,
  prepareBenchmarkRuntime,
  validateBenchmarkRuntimeSeedCopies,
  validateBenchmarkRuntime,
} from "./performance-launch.mjs";
import { computePerformanceFixtureIdentity } from "./performance-fixture.mjs";

test("packaged benchmark launches project only fixed receipt stamps into the app", () => {
  const receipt = {
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-10T00:00:00.000Z",
    scenario: "visible-idle",
    commit: "a".repeat(40),
    dirtyStateHash: "b".repeat(64),
    buildMode: "packaged",
    appVersion: "0.28.0",
    electronVersion: "43.1.1",
    nodeVersion: "24.18.0",
    platform: "darwin",
    hardware: "Apple M1 Max",
    logicalCpuCount: 10,
    memoryBytes: 64,
    macOSVersion: "26.4",
    architecture: "arm64",
    powerSource: "ac",
    profilingBuild: true,
    packageIdentity: null,
    voiceModelIdentity: null,
    fixture: {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      scenario: "visible-idle",
      generatedAt: "2026-08-10T00:00:00.000Z",
      chats: [100, 500],
      streams: [2_000, 10_000],
      workspaceFiles: 4_000,
      attachmentFiles: 20,
      sparseAttachmentBytes: 10 * 1024 * 1024 * 1024,
      missedSchedules: 20,
      terminals: 4,
      fixtureIdentity: "c".repeat(64),
    },
    measurements: emptyPerformanceMeasurements(),
    artifacts: emptyPerformanceArtifacts(),
  };
  assert.deepEqual(benchmarkEnvironment(receipt, "/run/performance-fixture"), {
    AIDEN_RUNTIME_PROFILE: "production",
    AIDEN_PERFORMANCE_DIAGNOSTICS: "1",
    AIDEN_BENCHMARK_RUN_ID: "00000000-0000-4000-8000-000000000001",
    AIDEN_BENCHMARK_SCENARIO: "visible-idle",
    AIDEN_BENCHMARK_POWER_SOURCE: "ac",
    AIDEN_BENCHMARK_FIXTURE_ROOT: "/run/performance-fixture",
    AIDEN_CONFIG_DIR: "/run/runtime/config",
  });
  assert.equal(benchmarkProfileRoot(receipt, "/run/performance-fixture"), "/run/runtime/profile");
  assert.equal(
    benchmarkProfileRoot(
      { ...receipt, scenario: "schedules-20-missed" },
      "/run/performance-fixture",
    ),
    "/run/runtime/profile",
  );
  assert.equal(
    benchmarkConfigRoot({ ...receipt, scenario: "mcp-hung" }, "/fixture"),
    "/runtime/config",
  );
});

test("measured and preflight launch tickets stay in the private results directory", () => {
  assert.match(
    assertPerformanceLaunchTicketPath(
      "build/performance-results/visible-idle-ac.launch-ticket.json",
    ),
    /build\/performance-results\/visible-idle-ac\.launch-ticket\.json$/u,
  );
  assert.throws(
    () => assertPerformanceLaunchTicketPath("build/copied.launch-ticket.json"),
    /must use a .launch-ticket.json file in build\/performance-results/u,
  );
});

test("runtime seeds publish atomically and mutable relaunch state stays isolated", async () => {
  const run = await mkdtemp(path.join(process.cwd(), "build", "aiden-runtime-test-"));
  const fixtureRoot = path.join(run, "performance-fixture");
  const input = {
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-10T00:00:00.000Z",
    scenario: "visible-idle",
    commit: "a".repeat(40),
    dirtyStateHash: "b".repeat(64),
    buildMode: "packaged",
    appVersion: "0.28.0",
    electronVersion: "43.1.1",
    nodeVersion: "24.18.0",
    platform: "darwin",
    hardware: "Apple M1 Max",
    logicalCpuCount: 10,
    memoryBytes: 64,
    macOSVersion: "26.4",
    architecture: "arm64",
    powerSource: "ac",
    profilingBuild: true,
    packageIdentity: null,
    voiceModelIdentity: null,
    fixture: {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      scenario: "visible-idle",
      generatedAt: "2026-08-10T00:00:00.000Z",
      chats: [100, 500],
      streams: [2_000, 10_000],
      workspaceFiles: 4_000,
      attachmentFiles: 20,
      sparseAttachmentBytes: 10 * 1024 * 1024 * 1024,
      missedSchedules: 20,
      terminals: 4,
      fixtureIdentity: "c".repeat(64),
    },
    measurements: emptyPerformanceMeasurements(),
    artifacts: emptyPerformanceArtifacts(),
  };
  try {
    await mkdir(path.join(fixtureRoot, "profile"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "configs", "default"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "workspace"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "profile", "seed.json"), "{}\n");
    await writeFile(
      path.join(fixtureRoot, "profile", "config.json"),
      '{"workspaces":[{"id":"default","folderPath":"seed"}]}\n',
    );
    await writeFile(path.join(fixtureRoot, "configs", "default", "config.json"), "{}\n");
    for (const driver of ["repo-dirty.sh", "repo-reset.sh", "repo-churn.sh"]) {
      await writeFile(path.join(fixtureRoot, driver), "#!/bin/sh\n", { mode: 0o700 });
    }
    const stagedCopy = path.join(run, "staged-copy");
    await Promise.all([
      cp(path.join(fixtureRoot, "profile"), path.join(stagedCopy, "profile"), {
        recursive: true,
      }),
      cp(path.join(fixtureRoot, "configs", "default"), path.join(stagedCopy, "config"), {
        recursive: true,
      }),
      cp(path.join(fixtureRoot, "workspace"), path.join(stagedCopy, "workspace"), {
        recursive: true,
      }),
      ...["repo-dirty.sh", "repo-reset.sh", "repo-churn.sh"].map((driver) =>
        cp(path.join(fixtureRoot, driver), path.join(stagedCopy, driver)),
      ),
    ]);
    const driverDigest = createHash("sha256").update("#!/bin/sh\n").digest("hex");
    const expectedCopies = {
      profileSeedIdentity: await computePerformanceFixtureIdentity(
        path.join(fixtureRoot, "profile"),
      ),
      configSeedIdentity: await computePerformanceFixtureIdentity(
        path.join(fixtureRoot, "configs", "default"),
      ),
      workspaceSeedIdentity: await computePerformanceFixtureIdentity(
        path.join(fixtureRoot, "workspace"),
      ),
      repositoryDriverSeedIdentities: [driverDigest, driverDigest, driverDigest],
    };
    await validateBenchmarkRuntimeSeedCopies(stagedCopy, expectedCopies);
    await writeFile(path.join(stagedCopy, "workspace", "raced.txt"), "changed during copy\n");
    await assert.rejects(
      () => validateBenchmarkRuntimeSeedCopies(stagedCopy, expectedCopies),
      /does not match/u,
    );
    await rm(stagedCopy, { recursive: true });
    await mkdir(path.join(run, "runtime"));
    await writeFile(path.join(run, "runtime", "partial.txt"), "interrupted copy\n");
    await assert.rejects(
      () => prepareBenchmarkRuntime(input, fixtureRoot),
      /incomplete or unowned/u,
    );
    await rm(path.join(run, "runtime"), { recursive: true });
    const runtime = await prepareBenchmarkRuntime(input, fixtureRoot);
    await writeFile(path.join(runtime.profile, "settings.json"), '{"mutated":true}\n');
    const reused = await prepareBenchmarkRuntime(input, fixtureRoot);
    assert.equal(
      await readFile(path.join(reused.profile, "settings.json"), "utf8"),
      '{"mutated":true}\n',
    );

    await rm(reused.config, { recursive: true });
    await symlink(path.join(fixtureRoot, "configs", "default"), reused.config);
    await assert.rejects(() => validateBenchmarkRuntime(input, fixtureRoot), /real directory/u);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test("measured launch uses a lightweight ticket before spawn and full verification after exit", async () => {
  const source = await readFile(new URL("./performance-launch.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  const lightweight = main.indexOf("assertLightweightLaunchTicket(receipt, ticket)");
  const spawnIndex = main.indexOf("const child = spawn(");
  const postFixture = main.indexOf("computePerformanceFixtureIdentity(fixtureRoot)", spawnIndex);
  const postPackage = main.indexOf("inspectPerformancePackage(appPath)", spawnIndex);
  const measuredSection = main.slice(main.indexOf("const ticket = exactTicket"), spawnIndex);
  assert.ok(lightweight >= 0 && lightweight < spawnIndex);
  assert.equal(main.slice(lightweight, spawnIndex).includes("inspectPerformancePackage"), false);
  assert.equal(
    main.slice(lightweight, spawnIndex).includes("computePerformanceFixtureIdentity"),
    false,
  );
  assert.equal(measuredSection.includes("currentMacPowerSource"), false);
  assert.match(source, /execFileSync\("\/usr\/bin\/pmset", \["-g", "batt"\]/u);
  assert.ok(postFixture > spawnIndex);
  assert.ok(postPackage > spawnIndex);
});
