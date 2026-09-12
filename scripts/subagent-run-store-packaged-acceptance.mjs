import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultDistributionRoot = path.join(repositoryRoot, "release", "distribution");
const timeoutMs = 45_000;
const outputLimit = 16 * 1024;
const mismatchedGeneration = "deadbeef-1-1-1-1-1-1-1-1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createRebootMigrationFixture() {
  const v1 = `${JSON.stringify({ version: 1, runs: [], pendingChatDeletions: [] }, null, 2)}\n`;
  const v2 = `${JSON.stringify(
    {
      version: 2,
      storeRevision: 2,
      migration: {
        status: "committed",
        adapterVersion: 1,
        source: "v1",
        sourceGeneration: mismatchedGeneration,
        sourceSha256: sha256(v1),
        migratedAt: 1,
      },
      snapshots: [],
      manifests: [],
      approvals: [],
      effects: [],
      pendingChatDeletions: [],
      deletionTransactions: [],
    },
    null,
    2,
  )}\n`;
  return Object.freeze({ v1, v2, mismatchedGeneration, sourceSha256: sha256(v1) });
}

async function findApps(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) results.push(candidate);
    else if (entry.isDirectory()) results.push(...(await findApps(candidate)));
  }
  return results;
}

async function resolveApp(supplied) {
  if (supplied) return path.resolve(supplied);
  const apps = await findApps(defaultDistributionRoot);
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one packaged Aiden app, found ${apps.length}.`);
  }
  return apps[0];
}

function captureOutput(stream) {
  let output = "";
  stream?.on("data", (chunk) => {
    if (output.length >= outputLimit) return;
    output += chunk.toString("utf8").slice(0, outputLimit - output.length);
  });
  return () => output.trim();
}

async function journalRecords(journal) {
  try {
    return (await readFile(journal, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error?.code ?? "") === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function waitForRenderer(journal, child, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await journalRecords(journal);
    if (records.some(({ event }) => event === "app-failed")) {
      throw new Error(`Packaged Aiden recorded app-failed. ${diagnostics()}`.trim());
    }
    if (records.some(({ event }) => event === "renderer-ready")) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Packaged Aiden exited before renderer readiness (${child.exitCode ?? child.signalCode}). ${diagnostics()}`.trim(),
      );
    }
    await delay(100);
  }
  throw new Error(`Packaged Aiden did not become renderer-ready. ${diagnostics()}`.trim());
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function writePrivate(file, contents) {
  await writeFile(file, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function runRebootMigrationPackagedAcceptance(suppliedApp) {
  if (process.platform !== "darwin") {
    throw new Error("Packaged subagent migration acceptance is macOS-only.");
  }
  const app = await resolveApp(suppliedApp);
  const executable = path.join(app, "Contents", "MacOS", "Aiden Agent");
  if (!(await stat(executable)).isFile()) throw new Error("Packaged Aiden executable is missing.");

  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-migration-"));
  await chmod(root, 0o700);
  const userData = path.join(root, "user-data");
  const portableConfig = path.join(root, "config");
  const xdgCache = path.join(root, "xdg-cache");
  const xdgConfig = path.join(root, "xdg-config");
  const xdgData = path.join(root, "xdg-data");
  const v1Directory = path.join(userData, "subagent-runs");
  const v2Directory = path.join(userData, "subagent-runs-v2");
  await Promise.all(
    [userData, portableConfig, xdgCache, xdgConfig, xdgData, v1Directory, v2Directory].map(
      (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );

  const fixture = createRebootMigrationFixture();
  const v1File = path.join(v1Directory, "runs.json");
  const v2File = path.join(v2Directory, "runs.json");
  await Promise.all([writePrivate(v1File, fixture.v1), writePrivate(v2File, fixture.v2)]);

  const environment = {};
  for (const name of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    AIDEN_CONFIG_DIR: portableConfig,
    AIDEN_RUNTIME_PROFILE: "production",
    AIDEN_SUBAGENTS_ENABLED: "1",
    AIDEN_SUBAGENTS_V2_ENABLED: "1",
    HOME: root,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  });

  const child = spawn(executable, [`--user-data-dir=${userData}`, "--disable-gpu"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = captureOutput(child.stdout);
  const stderr = captureOutput(child.stderr);
  const diagnostics = () => [stdout(), stderr()].filter(Boolean).join("\n");

  try {
    await waitForRenderer(path.join(userData, "logs", "aiden.log"), child, diagnostics);
    if ((await readFile(v1File, "utf8")) !== fixture.v1) {
      throw new Error("Packaged startup changed the frozen V1 migration source.");
    }
    const migrated = JSON.parse(await readFile(v2File, "utf8"));
    if (
      migrated.migration?.sourceGeneration !== fixture.mismatchedGeneration ||
      migrated.migration?.sourceSha256 !== fixture.sourceSha256
    ) {
      throw new Error("Packaged startup rewrote the committed migration checkpoint.");
    }
    process.stdout.write(
      "Verified packaged startup with content-identical V1 and a remounted-device generation mismatch.\n",
    );
  } finally {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
}

const modulePath = path.resolve(process.argv[1] ?? "");
if (modulePath === path.resolve(import.meta.filename)) {
  await runRebootMigrationPackagedAcceptance(process.argv[2]);
}
