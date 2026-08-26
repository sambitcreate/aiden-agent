import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { readBoundedJsonFile, verifyPerformanceReceipt } from "./performance-receipt.mjs";
import {
  assertReceiptMatchesPerformancePackage,
  inspectPerformancePackage,
} from "./performance-package-identity.mjs";
import { computePerformanceFixtureIdentity } from "./performance-fixture.mjs";
import { computePerformanceVoiceModelIdentity } from "./performance-voice-model.mjs";

export function benchmarkConfigRoot(receipt, fixtureRoot) {
  return path.join(benchmarkRuntimeRoot(receipt, fixtureRoot), "config");
}

export function benchmarkEnvironment(receipt, fixtureRoot) {
  verifyPerformanceReceipt(receipt);
  return {
    AIDEN_RUNTIME_PROFILE: "production",
    AIDEN_PERFORMANCE_DIAGNOSTICS: "1",
    AIDEN_BENCHMARK_RUN_ID: receipt.runId,
    AIDEN_BENCHMARK_SCENARIO: receipt.scenario,
    AIDEN_BENCHMARK_POWER_SOURCE: receipt.powerSource,
    AIDEN_BENCHMARK_FIXTURE_ROOT: fixtureRoot,
    AIDEN_CONFIG_DIR: benchmarkConfigRoot(receipt, fixtureRoot),
    ...(receipt.voiceModelIdentity
      ? { AIDEN_BENCHMARK_VOICE_MODEL_ID: receipt.voiceModelIdentity.modelId }
      : {}),
  };
}

export function benchmarkProfileRoot(receipt, fixtureRoot) {
  return path.join(benchmarkRuntimeRoot(receipt, fixtureRoot), "profile");
}

export function benchmarkRuntimeRoot(receipt, fixtureRoot) {
  return path.join(path.dirname(path.resolve(fixtureRoot)), "runtime");
}

function benchmarkProfileSeed(receipt, fixtureRoot) {
  return receipt.scenario === "schedules-20-missed"
    ? path.join(fixtureRoot, "profiles", "schedules-20-missed")
    : path.join(fixtureRoot, "profile");
}

function benchmarkConfigSeed(receipt, fixtureRoot) {
  return new Set(["mcp-offline", "mcp-hung", "mcp-duplicate-connect"]).has(receipt.scenario)
    ? path.join(fixtureRoot, "configs", receipt.scenario)
    : path.join(fixtureRoot, "configs", "default");
}

const RUNTIME_MARKER = ".aiden-performance-runtime.json";
const REPOSITORY_DRIVERS = ["repo-dirty.sh", "repo-reset.sh", "repo-churn.sh"];

async function boundedRuntimeSeedFileDigest(file) {
  const resolved = path.resolve(file);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("Benchmark runtime seed files must not use symlinks.");
  }
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 64n * 1024n) {
      throw new Error("Benchmark runtime seed files must be bounded regular files.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(resolved, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      bytes.length !== Number(before.size) ||
      (await realpath(resolved)) !== resolved
    ) {
      throw new Error("Benchmark runtime seed files changed while hashing.");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

async function expectedRuntimeMarker(receipt, fixtureRoot) {
  return {
    schemaVersion: 1,
    runId: receipt.runId,
    scenario: receipt.scenario,
    profileSeedIdentity: await computePerformanceFixtureIdentity(
      benchmarkProfileSeed(receipt, fixtureRoot),
    ),
    configSeedIdentity: await computePerformanceFixtureIdentity(
      benchmarkConfigSeed(receipt, fixtureRoot),
    ),
    workspaceSeedIdentity: await computePerformanceFixtureIdentity(
      path.join(fixtureRoot, "workspace"),
    ),
    repositoryDriverSeedIdentities: await Promise.all(
      REPOSITORY_DRIVERS.map((driver) =>
        boundedRuntimeSeedFileDigest(path.join(fixtureRoot, driver)),
      ),
    ),
  };
}

export async function validateBenchmarkRuntimeSeedCopies(staging, expected) {
  const [profileCopyIdentity, configCopyIdentity, workspaceCopyIdentity, driverCopyIdentities] =
    await Promise.all([
      computePerformanceFixtureIdentity(path.join(staging, "profile")),
      computePerformanceFixtureIdentity(path.join(staging, "config")),
      computePerformanceFixtureIdentity(path.join(staging, "workspace")),
      Promise.all(
        REPOSITORY_DRIVERS.map((driver) =>
          boundedRuntimeSeedFileDigest(path.join(staging, driver)),
        ),
      ),
    ]);
  if (
    profileCopyIdentity !== expected.profileSeedIdentity ||
    configCopyIdentity !== expected.configSeedIdentity ||
    workspaceCopyIdentity !== expected.workspaceSeedIdentity ||
    JSON.stringify(driverCopyIdentities) !== JSON.stringify(expected.repositoryDriverSeedIdentities)
  ) {
    throw new Error("The benchmark runtime copy does not match its immutable seeds.");
  }
}

async function validateExistingRuntime(destination, expected) {
  const existing = await lstat(destination);
  if (
    existing.isSymbolicLink() ||
    !existing.isDirectory() ||
    (await realpath(destination)) !== destination
  ) {
    throw new Error("The benchmark runtime directory must be a real directory.");
  }
  for (const child of ["profile", "config", "workspace"]) {
    const childPath = path.join(destination, child);
    const childInfo = await lstat(childPath);
    if (
      childInfo.isSymbolicLink() ||
      !childInfo.isDirectory() ||
      (await realpath(childPath)) !== childPath
    ) {
      throw new Error(`The benchmark runtime ${child} must be a real directory.`);
    }
  }
  let marker;
  try {
    marker = (await readBoundedJsonFile(path.join(destination, RUNTIME_MARKER), 4 * 1024)).value;
  } catch {
    throw new Error("The benchmark runtime directory is incomplete or unowned.");
  }
  if (JSON.stringify(marker) !== JSON.stringify(expected)) {
    throw new Error("The benchmark runtime directory does not match this receipt and seed.");
  }
}

export async function prepareBenchmarkRuntime(receipt, fixtureRoot) {
  verifyPerformanceReceipt(receipt);
  const destination = benchmarkRuntimeRoot(receipt, fixtureRoot);
  const parent = path.dirname(destination);
  if ((await realpath(parent)) !== parent) {
    throw new Error("The benchmark run directory must not use symlinks.");
  }
  const expected = await expectedRuntimeMarker(receipt, fixtureRoot);
  try {
    await validateExistingRuntime(destination, expected);
    return {
      root: destination,
      profile: benchmarkProfileRoot(receipt, fixtureRoot),
      config: benchmarkConfigRoot(receipt, fixtureRoot),
      workspace: path.join(destination, "workspace"),
    };
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    try {
      await lstat(destination);
      throw new Error("The benchmark runtime directory is incomplete or unowned.");
    } catch (existingError) {
      if (
        !(existingError && typeof existingError === "object" && existingError.code === "ENOENT")
      ) {
        throw existingError;
      }
    }
  }

  const staging = path.join(parent, `.runtime.${randomUUID()}.stage`);
  try {
    await mkdir(staging, { mode: 0o700 });
    await Promise.all([
      cp(benchmarkProfileSeed(receipt, fixtureRoot), path.join(staging, "profile"), {
        recursive: true,
        errorOnExist: true,
      }),
      cp(benchmarkConfigSeed(receipt, fixtureRoot), path.join(staging, "config"), {
        recursive: true,
        errorOnExist: true,
      }),
      cp(path.join(fixtureRoot, "workspace"), path.join(staging, "workspace"), {
        recursive: true,
        errorOnExist: true,
      }),
      ...REPOSITORY_DRIVERS.map((driver) =>
        cp(path.join(fixtureRoot, driver), path.join(staging, driver), { errorOnExist: true }),
      ),
    ]);
    await validateBenchmarkRuntimeSeedCopies(staging, expected);
    const profileConfigPath = path.join(staging, "profile", "config.json");
    const profileConfig = (await readBoundedJsonFile(profileConfigPath, 512 * 1024)).value;
    if (!Array.isArray(profileConfig?.workspaces) || profileConfig.workspaces.length !== 1) {
      throw new Error("The benchmark profile seed has an invalid workspace contract.");
    }
    profileConfig.workspaces[0] = {
      ...profileConfig.workspaces[0],
      folderPath: path.join(destination, "workspace"),
    };
    await writeFile(profileConfigPath, `${JSON.stringify(profileConfig)}\n`, { mode: 0o600 });
    await writeFile(path.join(staging, RUNTIME_MARKER), `${JSON.stringify(expected)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await validateExistingRuntime(destination, expected);
  return {
    root: destination,
    profile: benchmarkProfileRoot(receipt, fixtureRoot),
    config: benchmarkConfigRoot(receipt, fixtureRoot),
    workspace: path.join(destination, "workspace"),
  };
}

export async function validateBenchmarkRuntime(receipt, fixtureRoot) {
  const destination = benchmarkRuntimeRoot(receipt, fixtureRoot);
  await validateExistingRuntime(destination, await expectedRuntimeMarker(receipt, fixtureRoot));
  return {
    root: destination,
    profile: benchmarkProfileRoot(receipt, fixtureRoot),
    config: benchmarkConfigRoot(receipt, fixtureRoot),
    workspace: path.join(destination, "workspace"),
  };
}

function pathIdentity(info, mutable = false) {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    ...(mutable
      ? {}
      : {
          size: info.size.toString(),
          mtimeNs: info.mtimeNs.toString(),
          ctimeNs: info.ctimeNs.toString(),
        }),
  };
}

async function captureLaunchPathIdentity(target, { directory = false, mutable = false } = {}) {
  const resolved = path.resolve(target);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("Benchmark launch paths must not use symlinks.");
  }
  const info = await lstat(resolved, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error("Benchmark launch paths have an invalid type.");
  }
  return pathIdentity(info, mutable);
}

async function assertLaunchPathIdentity(target, expected, options) {
  const observed = await captureLaunchPathIdentity(target, options);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("A benchmark launch path changed after preflight.");
  }
}

function exactTicket(ticket) {
  const keys = Object.keys(ticket ?? {})
    .sort()
    .join("\n");
  const expected = [
    "schemaVersion",
    "runId",
    "scenario",
    "fixtureRoot",
    "appPath",
    "fixtureIdentity",
    "packageIdentity",
    "appAsarIdentity",
    "executableIdentity",
    "fixtureRootIdentity",
    "runtimeRootIdentity",
    "runtimeMarkerIdentity",
    "profileIdentity",
    "configIdentity",
    "workspaceIdentity",
    "voiceModelIdentity",
    "voiceModelRootIdentity",
    "repositoryDriverIdentities",
  ]
    .sort()
    .join("\n");
  const validIdentity = (identity, mutable = false) => {
    const fields = mutable
      ? ["device", "inode"]
      : ["device", "inode", "size", "mtimeNs", "ctimeNs"];
    return (
      identity &&
      Object.keys(identity).sort().join("\n") === fields.sort().join("\n") &&
      fields.every(
        (field) => typeof identity[field] === "string" && /^[0-9]{1,32}$/u.test(identity[field]),
      )
    );
  };
  if (
    keys !== expected ||
    ticket.schemaVersion !== 1 ||
    !validIdentity(ticket.appAsarIdentity) ||
    !validIdentity(ticket.executableIdentity) ||
    !validIdentity(ticket.fixtureRootIdentity, true) ||
    !validIdentity(ticket.runtimeRootIdentity, true) ||
    !validIdentity(ticket.profileIdentity, true) ||
    !validIdentity(ticket.configIdentity, true) ||
    !validIdentity(ticket.workspaceIdentity, true) ||
    !validIdentity(ticket.runtimeMarkerIdentity) ||
    !Array.isArray(ticket.repositoryDriverIdentities) ||
    ticket.repositoryDriverIdentities.length !== 3 ||
    ticket.repositoryDriverIdentities.some((identity) => !validIdentity(identity)) ||
    (ticket.voiceModelRootIdentity !== null && !validIdentity(ticket.voiceModelRootIdentity, true))
  ) {
    throw new Error("Invalid benchmark launch ticket.");
  }
  return ticket;
}

export async function prepareBenchmarkLaunchTicket(receipt, fixtureRoot, appPath) {
  verifyPerformanceReceipt(receipt);
  const resolvedFixture = path.resolve(fixtureRoot);
  const resolvedApp = path.resolve(appPath);
  const fixtureIdentity = await computePerformanceFixtureIdentity(resolvedFixture);
  if (fixtureIdentity !== receipt.fixture.fixtureIdentity) {
    throw new Error("The benchmark fixture does not match its bound receipt.");
  }
  const packageIdentity = await inspectPerformancePackage(resolvedApp);
  assertReceiptMatchesPerformancePackage(receipt, packageIdentity);
  const runtime = await prepareBenchmarkRuntime(receipt, resolvedFixture);
  await validateBenchmarkRuntime(receipt, resolvedFixture);
  if ((await computePerformanceFixtureIdentity(resolvedFixture)) !== fixtureIdentity) {
    throw new Error("The benchmark fixture changed during preflight.");
  }
  let voiceModelRootIdentity = null;
  if (receipt.voiceModelIdentity) {
    const voiceRoot = path.join(
      runtime.profile,
      "parakeet-models",
      receipt.voiceModelIdentity.modelId,
    );
    const observed = await computePerformanceVoiceModelIdentity(
      voiceRoot,
      receipt.voiceModelIdentity.modelId,
    );
    if (JSON.stringify(observed) !== JSON.stringify(receipt.voiceModelIdentity)) {
      throw new Error("The installed voice model does not match its bound receipt.");
    }
    voiceModelRootIdentity = await captureLaunchPathIdentity(voiceRoot, {
      directory: true,
      mutable: true,
    });
  }
  const appAsar = path.join(resolvedApp, "Contents", "Resources", "app.asar");
  const executable = path.join(resolvedApp, "Contents", "MacOS", "Aiden Agent");
  return exactTicket({
    schemaVersion: 1,
    runId: receipt.runId,
    scenario: receipt.scenario,
    fixtureRoot: resolvedFixture,
    appPath: resolvedApp,
    fixtureIdentity,
    packageIdentity,
    voiceModelIdentity: receipt.voiceModelIdentity,
    voiceModelRootIdentity,
    repositoryDriverIdentities: await Promise.all(
      REPOSITORY_DRIVERS.map((driver) =>
        captureLaunchPathIdentity(path.join(runtime.root, driver)),
      ),
    ),
    appAsarIdentity: await captureLaunchPathIdentity(appAsar),
    executableIdentity: await captureLaunchPathIdentity(executable),
    fixtureRootIdentity: await captureLaunchPathIdentity(resolvedFixture, {
      directory: true,
      mutable: true,
    }),
    runtimeRootIdentity: await captureLaunchPathIdentity(runtime.root, {
      directory: true,
      mutable: true,
    }),
    runtimeMarkerIdentity: await captureLaunchPathIdentity(path.join(runtime.root, RUNTIME_MARKER)),
    profileIdentity: await captureLaunchPathIdentity(runtime.profile, {
      directory: true,
      mutable: true,
    }),
    configIdentity: await captureLaunchPathIdentity(runtime.config, {
      directory: true,
      mutable: true,
    }),
    workspaceIdentity: await captureLaunchPathIdentity(runtime.workspace, {
      directory: true,
      mutable: true,
    }),
  });
}

export function assertPerformanceLaunchTicketPath(destination) {
  const resolved = path.resolve(destination);
  const resultsRoot = path.resolve("build", "performance-results");
  const relative = path.relative(resultsRoot, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !resolved.endsWith(".launch-ticket.json")
  ) {
    throw new Error(
      "Launch tickets must use a .launch-ticket.json file in build/performance-results.",
    );
  }
  return resolved;
}

async function writeLaunchTicket(destination, ticket) {
  const resolved = assertPerformanceLaunchTicketPath(destination);
  const parent = path.dirname(resolved);
  if ((await realpath(parent)) !== parent) throw new Error("Launch ticket parent is unsafe.");
  const parentBefore = await lstat(parent, { bigint: true });
  try {
    const existing = exactTicket((await readBoundedJsonFile(resolved, 64 * 1024)).value);
    if (existing.runId !== ticket.runId || existing.scenario !== ticket.scenario) {
      throw new Error("An existing launch ticket belongs to another run.");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const temporary = path.join(parent, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(ticket, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const parentCurrent = await lstat(parent, { bigint: true });
    if (
      parentCurrent.dev !== parentBefore.dev ||
      parentCurrent.ino !== parentBefore.ino ||
      (await realpath(parent)) !== parent
    ) {
      throw new Error("Launch ticket parent changed during publication.");
    }
    await rename(temporary, resolved);
    const parentHandle = await open(parent, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertLightweightLaunchTicket(receipt, ticket) {
  exactTicket(ticket);
  if (
    ticket.runId !== receipt.runId ||
    ticket.scenario !== receipt.scenario ||
    ticket.fixtureIdentity !== receipt.fixture.fixtureIdentity ||
    JSON.stringify(ticket.packageIdentity) !== JSON.stringify(receipt.packageIdentity) ||
    JSON.stringify(ticket.voiceModelIdentity) !== JSON.stringify(receipt.voiceModelIdentity)
  ) {
    throw new Error("The launch ticket does not match this receipt.");
  }
  const executable = path.join(ticket.appPath, "Contents", "MacOS", "Aiden Agent");
  await Promise.all([
    assertLaunchPathIdentity(
      path.join(ticket.appPath, "Contents", "Resources", "app.asar"),
      ticket.appAsarIdentity,
    ),
    assertLaunchPathIdentity(executable, ticket.executableIdentity),
    assertLaunchPathIdentity(ticket.fixtureRoot, ticket.fixtureRootIdentity, {
      directory: true,
      mutable: true,
    }),
    assertLaunchPathIdentity(
      benchmarkRuntimeRoot(receipt, ticket.fixtureRoot),
      ticket.runtimeRootIdentity,
      {
        directory: true,
        mutable: true,
      },
    ),
    assertLaunchPathIdentity(
      path.join(benchmarkRuntimeRoot(receipt, ticket.fixtureRoot), RUNTIME_MARKER),
      ticket.runtimeMarkerIdentity,
    ),
    assertLaunchPathIdentity(
      benchmarkProfileRoot(receipt, ticket.fixtureRoot),
      ticket.profileIdentity,
      {
        directory: true,
        mutable: true,
      },
    ),
    assertLaunchPathIdentity(
      benchmarkConfigRoot(receipt, ticket.fixtureRoot),
      ticket.configIdentity,
      {
        directory: true,
        mutable: true,
      },
    ),
    assertLaunchPathIdentity(
      path.join(benchmarkRuntimeRoot(receipt, ticket.fixtureRoot), "workspace"),
      ticket.workspaceIdentity,
      { directory: true, mutable: true },
    ),
    ...(receipt.voiceModelIdentity
      ? [
          assertLaunchPathIdentity(
            path.join(
              benchmarkProfileRoot(receipt, ticket.fixtureRoot),
              "parakeet-models",
              receipt.voiceModelIdentity.modelId,
            ),
            ticket.voiceModelRootIdentity,
            { directory: true, mutable: true },
          ),
        ]
      : ticket.voiceModelRootIdentity === null
        ? []
        : [Promise.reject(new Error("The launch ticket has an unexpected voice model."))]),
    ...REPOSITORY_DRIVERS.map((driver, index) =>
      assertLaunchPathIdentity(
        path.join(benchmarkRuntimeRoot(receipt, ticket.fixtureRoot), driver),
        ticket.repositoryDriverIdentities[index],
      ),
    ),
  ]);
  return executable;
}

export async function prepareBenchmarkProfile(receipt, fixtureRoot) {
  return (await prepareBenchmarkRuntime(receipt, fixtureRoot)).profile;
}

function currentMacPowerSource() {
  if (process.platform !== "darwin") return "unknown";
  try {
    const output = execFileSync("/usr/bin/pmset", ["-g", "batt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    if (/drawing from 'Battery Power'/u.test(output)) return "battery";
    if (/drawing from 'AC Power'/u.test(output)) return "ac";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const receiptPath = value("--receipt");
  const appPath = value("--app");
  const ticketPath = value("--ticket");
  if (!receiptPath || !appPath) {
    throw new Error(
      "Usage: performance-launch.mjs --receipt <receipt.json> --app <Aiden Agent.app> --ticket <ticket.json> [--prepare-ticket] [--fixture-root <path>]",
    );
  }
  const receipt = (await readBoundedJsonFile(receiptPath, 512 * 1024)).value;
  verifyPerformanceReceipt(receipt);
  const fixtureRoot = path.resolve(
    value("--fixture-root") ??
      path.join("build", "performance-runs", receipt.runId, "performance-fixture"),
  );
  if (!ticketPath) throw new Error("A preflight launch ticket is required.");
  const resolvedTicketPath = assertPerformanceLaunchTicketPath(ticketPath);
  if (process.argv.includes("--prepare-ticket")) {
    const observedPower = currentMacPowerSource();
    if (observedPower === "unknown" || observedPower !== receipt.powerSource) {
      throw new Error(
        `Receipt power source ${receipt.powerSource} does not match this Mac (${observedPower}).`,
      );
    }
    const ticket = await prepareBenchmarkLaunchTicket(receipt, fixtureRoot, appPath);
    await writeLaunchTicket(resolvedTicketPath, ticket);
    process.stdout.write(
      "Launch ticket prepared. Reboot/settle before cold launch; do not run package verification again before measurement.\n",
    );
    return;
  }
  const ticket = exactTicket((await readBoundedJsonFile(resolvedTicketPath, 64 * 1024)).value);
  if (ticket.fixtureRoot !== fixtureRoot || ticket.appPath !== path.resolve(appPath)) {
    throw new Error("The launch ticket paths do not match this invocation.");
  }
  // Deliberately perform only constant-size stat/identity checks here. The full
  // fixture hash, strict signature checks, app.asar hash, and runtime probe were
  // completed when the ticket was prepared, and are repeated after the measured
  // app exits. Running them here would invalidate cold-cache measurements.
  const executable = await assertLightweightLaunchTicket(receipt, ticket);
  await access(executable);
  const child = spawn(
    executable,
    [`--user-data-dir=${benchmarkProfileRoot(receipt, fixtureRoot)}`],
    {
      env: { ...process.env, ...benchmarkEnvironment(receipt, fixtureRoot) },
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  await assertLightweightLaunchTicket(receipt, ticket);
  const postFixtureIdentity = await computePerformanceFixtureIdentity(fixtureRoot);
  const postPackageIdentity = await inspectPerformancePackage(appPath);
  if (postFixtureIdentity !== ticket.fixtureIdentity) {
    throw new Error("The benchmark fixture changed during the measured run.");
  }
  assertReceiptMatchesPerformancePackage(receipt, postPackageIdentity);
  if (JSON.stringify(postPackageIdentity) !== JSON.stringify(ticket.packageIdentity)) {
    throw new Error("The benchmark package changed during the measured run.");
  }
  if (receipt.voiceModelIdentity) {
    const postVoiceIdentity = await computePerformanceVoiceModelIdentity(
      path.join(
        benchmarkProfileRoot(receipt, fixtureRoot),
        "parakeet-models",
        receipt.voiceModelIdentity.modelId,
      ),
      receipt.voiceModelIdentity.modelId,
    );
    if (JSON.stringify(postVoiceIdentity) !== JSON.stringify(receipt.voiceModelIdentity)) {
      throw new Error("The benchmark voice model changed during the measured run.");
    }
  }
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
