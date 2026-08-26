import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  cp as rawCp,
  lstat,
  mkdir as rawMkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  truncate as rawTruncate,
  writeFile as rawWriteFile,
} from "node:fs/promises";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_BUILD_ROOT = path.join(REPOSITORY_ROOT, "build");
const PERFORMANCE_RESULTS_ROOT = path.join(REPOSITORY_BUILD_ROOT, "performance-results");
const BUILD_MODES = new Set(["development", "packaged", "release"]);
const POWER_SOURCES = new Set(["ac", "battery", "unknown"]);
const MAX_FIXTURE_FILES = 10_000;
const MAX_FIXTURE_FILE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_FIXTURE_AGGREGATE_BYTES = 12 * 1024 * 1024 * 1024;
export const PERFORMANCE_SPARSE_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;

let activeFixtureStaging;

function guardedFixtureRootFor(target) {
  if (!activeFixtureStaging) return undefined;
  const relative = path.relative(activeFixtureStaging.root, path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? activeFixtureStaging
    : undefined;
}

async function assertActiveFixtureStaging(target) {
  const active = guardedFixtureRootFor(target);
  if (!active) return;
  const info = await lstat(active.root, { bigint: true });
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== active.device ||
    info.ino !== active.inode ||
    (await realpath(active.root)) !== active.root
  ) {
    throw new Error("Performance fixture staging changed during generation.");
  }
}

function assertActiveFixtureStagingSync(target) {
  const active = guardedFixtureRootFor(target);
  if (!active) return;
  const info = lstatSync(active.root, { bigint: true });
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== active.device ||
    info.ino !== active.inode ||
    realpathSync(active.root) !== active.root
  ) {
    throw new Error("Performance fixture staging changed during generation.");
  }
}

async function writeFile(target, ...args) {
  await assertActiveFixtureStaging(target);
  const result = await rawWriteFile(target, ...args);
  await assertActiveFixtureStaging(target);
  return result;
}

async function mkdir(target, ...args) {
  await assertActiveFixtureStaging(target);
  const result = await rawMkdir(target, ...args);
  await assertActiveFixtureStaging(target);
  return result;
}

async function cp(source, target, ...args) {
  await assertActiveFixtureStaging(target);
  const result = await rawCp(source, target, ...args);
  await assertActiveFixtureStaging(target);
  return result;
}

async function truncate(target, ...args) {
  await assertActiveFixtureStaging(target);
  const result = await rawTruncate(target, ...args);
  await assertActiveFixtureStaging(target);
  return result;
}

export const PERFORMANCE_SCENARIOS = Object.freeze([
  "cold-launch",
  "warm-launch",
  "visible-idle",
  "blurred-idle",
  "minimized-idle",
  "background-window-closed",
  "chat-100-turns",
  "chat-500-turns",
  "stream-2k",
  "stream-10k",
  "repo-clean",
  "repo-dirty",
  "repo-external-churn",
  "attachments-many",
  "attachments-oversized",
  "voice-long",
  "terminals-four-idle",
  "terminals-four-output",
  "mcp-offline",
  "mcp-hung",
  "mcp-duplicate-connect",
  "schedules-20-missed",
  "suspend-resume",
  "lock-unlock",
  "timezone-change",
]);

export const PERFORMANCE_MEASUREMENT_KEYS = Object.freeze([
  "mainLoadedMs",
  "appReadyMs",
  "windowCreatedMs",
  "navigationStartedMs",
  "windowReadyMs",
  "shellPaintMs",
  "providersReadyMs",
  "composerReadyMs",
  "mainEventLoopP99Ms",
  "mainEventLoopUtilization",
  "rendererLongTaskP95Ms",
  "reactCommitCount",
  "reactCommitDurationMs",
  "frameRateP50",
  "frameTimeP95Ms",
  "liveRafCurrent",
  "liveRafPeak",
  "liveTimerCurrent",
  "liveTimerPeak",
  "scrollWrites",
  "childLaunches",
  "childPeak",
  "gitCommands",
  "ipcMessages",
  "ipcBytesIn",
  "ipcBytesOut",
  "filesystemReads",
  "filesystemReadBytes",
  "filesystemWrites",
  "filesystemWriteBytes",
  "mcpClientPeak",
  "ptyPeak",
  "recognizerPeak",
  "heapPeakBytes",
  "heapSettledBytes",
  "rssPeakBytes",
  "rssSettledBytes",
  "wakeups",
  "cpuSeconds",
  "gpuSeconds",
  "energyImpact",
  "shutdownMs",
  "shutdownTimeouts",
  "rendererJavaScriptBytes",
  "largestRendererChunkBytes",
  "buildSourceMapBytes",
  "packageBytes",
]);

export const PERFORMANCE_ARTIFACT_KEYS = Object.freeze([
  "timeProfiler",
  "energyLog",
  "coreAnimation",
  "chromePerformance",
  "reactProfiler",
  "diagnosticsExport",
  "shutdownSummary",
]);

function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return "unavailable";
  }
}

export function dirtyTreeHash() {
  let status;
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5_000,
    });
  } catch {
    throw new Error("Performance source status could not be captured.");
  }
  const digest = createHash("sha256").update(status);
  const entries = status.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3);
    if (statusCode.includes("R") || statusCode.includes("C")) index += 1;
    digest.update(file).update("\0");
    try {
      lstatSync(file);
    } catch (error) {
      if (statusCode.includes("D") && error?.code === "ENOENT") {
        continue;
      }
      throw new Error("Performance source content could not be inspected.");
    }
    try {
      digest.update(
        execFileSync("git", ["hash-object", "--no-filters", "--", file], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 1_024,
          timeout: 5_000,
        }),
      );
    } catch {
      throw new Error("Performance source content could not be hashed.");
    }
  }
  const statusAfter = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5_000,
    },
  );
  if (statusAfter !== status) {
    throw new Error("Performance source changed while its identity was captured.");
  }
  return digest.digest("hex");
}

export function benchmarkStamp(scenario, buildMode) {
  if (!PERFORMANCE_SCENARIOS.includes(scenario))
    throw new Error(`Unknown performance scenario: ${scenario}`);
  if (!BUILD_MODES.has(buildMode)) throw new Error(`Unknown benchmark build mode: ${buildMode}`);
  const powerSource = process.env.AIDEN_BENCHMARK_POWER_SOURCE ?? "unknown";
  if (!POWER_SOURCES.has(powerSource))
    throw new Error(`Unknown benchmark power source: ${powerSource}`);
  const electronVersion = require("electron/package.json").version;
  const macOSVersion =
    process.platform === "darwin"
      ? gitCommand("/usr/bin/sw_vers", "-productVersion")
      : os.release();
  const commit = git("rev-parse", "HEAD");
  const dirtyStateHash = dirtyTreeHash();
  if (!/^[0-9a-f]{40,64}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(dirtyStateHash)) {
    throw new Error("Performance receipts require an exact Git source identity.");
  }
  if (process.platform === "darwin" && !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(macOSVersion)) {
    throw new Error("Performance receipts require an exact macOS version.");
  }
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    recordedAt: new Date().toISOString(),
    scenario,
    commit,
    dirtyStateHash,
    buildMode,
    appVersion: process.env.npm_package_version ?? "unavailable",
    electronVersion,
    nodeVersion: "unbound",
    platform: process.platform,
    hardware: os.cpus()[0]?.model ?? "unavailable",
    logicalCpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    macOSVersion,
    architecture: process.arch,
    powerSource,
    profilingBuild: buildMode === "packaged",
    packageIdentity: null,
    voiceModelIdentity: null,
  };
}

function gitCommand(command, ...args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    }).trim();
  } catch {
    return "unavailable";
  }
}

function message(index, size = 256) {
  const role = index % 2 === 0 ? "user" : "assistant";
  const seed = `${role} turn ${index + 1} · bounded fixture content `;
  return {
    id: `fixture-message-${String(index + 1).padStart(5, "0")}`,
    role,
    content: seed.repeat(Math.ceil(size / seed.length)).slice(0, size),
    createdAt: index,
  };
}

function markdown(length) {
  const block = [
    "## Measured section\n",
    "A paragraph with **formatting**, a [local label](https://example.invalid), and `inline code`.\n\n",
    "```ts\nexport const measured = true;\n```\n\n",
    "$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n",
  ].join("");
  return block.repeat(Math.ceil(length / block.length)).slice(0, length);
}

function fixtureGit(root, ...args) {
  assertActiveFixtureStagingSync(root);
  const result = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  assertActiveFixtureStagingSync(root);
  return result;
}

function deterministicWav(seconds = 60, sampleRate = 16_000) {
  const samples = seconds * sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(index / 16) * 1_024), 44 + index * 2);
  }
  return bytes;
}

function sameBigIntFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function fixtureFileDigest(file, expectedSize) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size !== expectedSize ||
      before.size < 0n ||
      before.size > BigInt(MAX_FIXTURE_FILE_BYTES) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Performance fixture files must be stable regular files.");
    }
    const digest = createHash("sha256");
    const readRange = async (position, length) => {
      let offset = 0;
      while (offset < length) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, length - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position + offset);
        if (bytesRead < 1) throw new Error("Performance fixture file changed while hashing.");
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    };
    const numericSize = Number(before.size);
    await readRange(0, numericSize);
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(file, { bigint: true });
    if (
      !sameBigIntFileIdentity(before, after) ||
      !sameBigIntFileIdentity(after, currentPath) ||
      (await realpath(file)) !== path.resolve(file)
    ) {
      throw new Error("Performance fixture file changed while hashing.");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function computePerformanceFixtureIdentity(root) {
  const resolved = path.resolve(root);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("Performance fixture root must be a real directory.");
  }
  const rootInfo = await lstat(resolved, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Performance fixture root must be a real directory.");
  }
  const entries = [];
  const observedPaths = [];
  let aggregateBytes = 0;
  const visit = async (directory, relativeDirectory = "") => {
    const children = [];
    const iterator = await opendir(directory);
    for await (const child of iterator) {
      children.push(child);
      if (entries.length + children.length > MAX_FIXTURE_FILES) {
        throw new Error("Performance fixture exceeds its file-count budget.");
      }
    }
    children.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const child of children) {
      const relative = path.posix.join(relativeDirectory, child.name);
      if (relative === "manifest.json") continue;
      if (entries.length >= MAX_FIXTURE_FILES) {
        throw new Error("Performance fixture exceeds its file-count budget.");
      }
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink())
        throw new Error("Performance fixture entries must not be symlinks.");
      if (info.isDirectory()) {
        observedPaths.push({ absolute, info, directory: true });
        entries.push({ relative, kind: "directory", mode: Number(info.mode & 0o777n) });
        await visit(absolute, relative);
      } else if (info.isFile()) {
        observedPaths.push({ absolute, info, directory: false });
        const size = Number(info.size);
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_FIXTURE_FILE_BYTES ||
          aggregateBytes + size > MAX_FIXTURE_AGGREGATE_BYTES
        ) {
          throw new Error("Performance fixture exceeds its byte budget.");
        }
        aggregateBytes += size;
        entries.push({
          relative,
          kind: "file",
          mode: Number(info.mode & 0o777n),
          size: info.size.toString(),
          digest: await fixtureFileDigest(absolute, info.size),
        });
      } else {
        throw new Error("Performance fixture entries must be regular files or directories.");
      }
    }
  };
  await visit(resolved);
  for (const observed of observedPaths) {
    const current = await lstat(observed.absolute, { bigint: true });
    if (
      !sameBigIntFileIdentity(observed.info, current) ||
      (observed.directory ? !current.isDirectory() : !current.isFile()) ||
      current.isSymbolicLink() ||
      (await realpath(observed.absolute)) !== observed.absolute
    ) {
      throw new Error("Performance fixture changed while hashing.");
    }
  }
  const after = await lstat(resolved, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameBigIntFileIdentity(after, rootInfo) ||
    (await realpath(resolved)) !== resolved
  ) {
    throw new Error("Performance fixture root changed while hashing.");
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function prepareFreshFixtureRoot(resolved) {
  await mkdir(REPOSITORY_BUILD_ROOT, { recursive: true, mode: 0o700 });
  const canonicalBuildRoot = await realpath(REPOSITORY_BUILD_ROOT);
  const buildInfo = await lstat(REPOSITORY_BUILD_ROOT, { bigint: true });
  if (
    canonicalBuildRoot !== REPOSITORY_BUILD_ROOT ||
    buildInfo.isSymbolicLink() ||
    !buildInfo.isDirectory()
  ) {
    throw new Error("The repository build directory must be a real directory.");
  }
  const relative = path.relative(REPOSITORY_BUILD_ROOT, resolved);
  const components = relative.split(path.sep);
  const ancestorIdentities = [];
  let current = REPOSITORY_BUILD_ROOT;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(current)) !== current) {
      throw new Error("Performance fixture ancestors must be real directories under build.");
    }
    ancestorIdentities.push({ path: current, device: info.dev, inode: info.ino });
  }
  try {
    await mkdir(resolved, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(
        "Performance fixtures are fresh, run-specific directories and are never replaced.",
      );
    }
    throw error;
  }
  const rootIdentity = await lstat(resolved, { bigint: true });
  for (const identity of ancestorIdentities) {
    const info = await lstat(identity.path, { bigint: true });
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.dev !== identity.device ||
      info.ino !== identity.inode
    ) {
      throw new Error("A performance fixture ancestor changed during preparation.");
    }
  }
  return { device: rootIdentity.dev, inode: rootIdentity.ino };
}

function chatFixture(id, title, count, size) {
  const messages = Array.from({ length: count }, (_, index) => message(index, size));
  return {
    id,
    title,
    workspaceId: "default",
    createdAt: 1,
    updatedAt: count,
    messages,
  };
}

export function emptyPerformanceMeasurements() {
  return Object.fromEntries(PERFORMANCE_MEASUREMENT_KEYS.map((key) => [key, null]));
}

export function emptyPerformanceArtifacts() {
  return Object.fromEntries(PERFORMANCE_ARTIFACT_KEYS.map((key) => [key, null]));
}

export async function preparePerformanceFixture(
  root,
  {
    runId = randomUUID(),
    scenario = "visible-idle",
    sparseAttachmentBytes = PERFORMANCE_SPARSE_ATTACHMENT_BYTES,
    testAfterStagingBound,
  } = {},
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new Error("Performance fixture run identity must be a UUID.");
  }
  if (!PERFORMANCE_SCENARIOS.includes(scenario)) {
    throw new Error("Performance fixture scenario is invalid.");
  }
  if (
    !Number.isSafeInteger(sparseAttachmentBytes) ||
    sparseAttachmentBytes < 1024 * 1024 ||
    sparseAttachmentBytes > PERFORMANCE_SPARSE_ATTACHMENT_BYTES
  ) {
    throw new Error("Performance fixture sparse attachment size is invalid.");
  }
  const resolved = path.resolve(root);
  const relativeToBuild = path.relative(REPOSITORY_BUILD_ROOT, resolved);
  if (
    path.basename(resolved) !== "performance-fixture" ||
    relativeToBuild === "" ||
    relativeToBuild.startsWith("..") ||
    path.isAbsolute(relativeToBuild)
  ) {
    throw new Error(
      "Performance fixture output must be a performance-fixture directory under this repository's build directory.",
    );
  }
  try {
    await lstat(resolved);
    throw new Error(
      "Performance fixtures are fresh, run-specific directories and are never replaced.",
    );
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const outputRoot = `${resolved}.stage-${randomUUID()}`;
  const originalWorkingDirectory = process.cwd();
  const output = (...parts) => (parts.length === 0 ? "." : path.join(...parts));
  const runtime = (...parts) => path.join(resolved, ...parts);
  const mutableRuntime = (...parts) => path.join(path.dirname(resolved), "runtime", ...parts);
  const outputRootIdentity = await prepareFreshFixtureRoot(outputRoot);
  if (activeFixtureStaging) {
    const current = await lstat(outputRoot, { bigint: true });
    if (
      !current.isSymbolicLink() &&
      current.isDirectory() &&
      current.dev === outputRootIdentity.device &&
      current.ino === outputRootIdentity.inode
    ) {
      await rm(outputRoot, { recursive: true, force: true });
    }
    throw new Error("Performance fixture generation is already active.");
  }
  activeFixtureStaging = { root: outputRoot, ...outputRootIdentity };
  let workingDirectoryBound = false;
  let published = false;
  try {
    process.chdir(outputRoot);
    workingDirectoryBound = true;
    const boundRoot = await lstat(".", { bigint: true });
    if (
      boundRoot.isSymbolicLink() ||
      !boundRoot.isDirectory() ||
      boundRoot.dev !== outputRootIdentity.device ||
      boundRoot.ino !== outputRootIdentity.inode ||
      (await realpath(".")) !== outputRoot
    ) {
      throw new Error("Performance fixture staging changed while it was bound.");
    }
    if (testAfterStagingBound) await testAfterStagingBound(outputRoot);
    await writeFile(
      output(".aiden-performance-fixture"),
      `${JSON.stringify({ schemaVersion: 1, runId, scenario })}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await mkdir(output("workspace", "src"), { recursive: true });
    await mkdir(output("workspace", "generated"), { recursive: true });
    await mkdir(output("attachments"), { recursive: true });
    await mkdir(output("profile", "chats"), { recursive: true });
    await mkdir(output("configs", "default"), { recursive: true });
    await mkdir(output("configs", "mcp-offline"), { recursive: true });
    await mkdir(output("configs", "mcp-hung"), { recursive: true });
    await mkdir(output("configs", "mcp-duplicate-connect"), { recursive: true });
    const chats = [
      chatFixture("performance-chat-100", "Performance 100 turns", 100, 256),
      chatFixture("performance-chat-500", "Performance 500 turns", 500, 1_024),
    ];
    for (const chat of chats) {
      await writeFile(output("profile", "chats", `${chat.id}.json`), `${JSON.stringify(chat)}\n`, {
        mode: 0o600,
      });
    }
    await writeFile(
      output("profile", "chats", "index.json"),
      `${JSON.stringify(
        chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          workspaceId: chat.workspaceId,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        })),
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(output("chat-100.json"), `${JSON.stringify(chats[0])}\n`);
    await writeFile(output("chat-500.json"), `${JSON.stringify(chats[1])}\n`);
    await writeFile(output("stream-2k.md"), markdown(2_000));
    await writeFile(output("stream-10k.md"), markdown(10_000));
    for (let index = 0; index < 4_000; index += 1) {
      const directory = index < 3_000 ? "src" : "generated";
      await writeFile(
        output("workspace", directory, `fixture-${String(index).padStart(4, "0")}.ts`),
        `export const value${index} = ${index};\n`,
      );
    }
    fixtureGit(output("workspace"), "init", "--initial-branch=main");
    fixtureGit(output("workspace"), "config", "user.name", "Aiden Performance Fixture");
    fixtureGit(output("workspace"), "config", "user.email", "performance@invalid.example");
    fixtureGit(output("workspace"), "add", ".");
    fixtureGit(output("workspace"), "commit", "-m", "Deterministic performance fixture");
    for (let index = 0; index < 20; index += 1) {
      const prefix = `bounded attachment ${String(index).padStart(2, "0")}\n`;
      await writeFile(
        output("attachments", `text-${String(index).padStart(2, "0")}.txt`),
        prefix.repeat(Math.ceil((512 * 1024) / prefix.length)).slice(0, 512 * 1024),
      );
    }
    await writeFile(output("voice-60s.wav"), deterministicWav());
    const sparseAttachment = output("attachments", "sparse-10gb.txt");
    await writeFile(sparseAttachment, "bounded prefix\n");
    await truncate(sparseAttachment, sparseAttachmentBytes);
    await writeFile(
      output("terminal-output.sh"),
      "#!/bin/sh\ni=0\nwhile [ $i -lt 20000 ]; do printf 'fixture-%05d\\n' \"$i\"; i=$((i+1)); done\n",
      { mode: 0o700 },
    );
    await writeFile(
      output("mcp-hung.mjs"),
      "process.stdin.resume(); setInterval(() => {}, 60000);\n",
      { mode: 0o700 },
    );
    await writeFile(
      output("repo-dirty.sh"),
      '#!/bin/sh\nset -eu\nfixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nprintf \'// deterministic dirty state\\n\' >> "$fixture_dir/workspace/src/fixture-0000.ts"\nprintf \'untracked\\n\' > "$fixture_dir/workspace/performance-untracked.txt"\n',
      { mode: 0o700 },
    );
    await writeFile(
      output("repo-reset.sh"),
      '#!/bin/sh\nset -eu\nfixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\ngit -C "$fixture_dir/workspace" reset --hard HEAD\ngit -C "$fixture_dir/workspace" clean -fd\n',
      { mode: 0o700 },
    );
    await writeFile(
      output("repo-churn.sh"),
      '#!/bin/sh\nset -eu\nfixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\ni=0\nwhile [ $i -lt 120 ]; do printf \'%s\\n\' "$i" > "$fixture_dir/workspace/performance-churn.txt"; i=$((i+1)); sleep 1; done\n',
      { mode: 0o700 },
    );
    await writeFile(
      output("stream-playback.mjs"),
      "import { readFile } from 'node:fs/promises'; const file=process.argv[2]; const delay=Math.max(1,Math.min(1000,Number(process.argv[3]??20))); if(!file) throw new Error('Usage: stream-playback.mjs <fixture> [delay-ms]'); const body=await readFile(file,'utf8'); for(let i=0;i<body.length;i+=48){process.stdout.write(body.slice(i,i+48)); await new Promise(r=>setTimeout(r,delay));}\n",
      { mode: 0o700 },
    );
    const now = Date.now();
    const schedules = Array.from({ length: 20 }, (_, index) => ({
      id: `performance-missed-${String(index + 1).padStart(2, "0")}`,
      name: `Performance missed task ${index + 1}`,
      enabled: true,
      mode: "llm",
      cron: "*/5 * * * *",
      timezone: "UTC",
      nextRunAt: now - (index + 1) * 300_000,
      workspaceId: "default",
      providerId: "performance-stream",
      model: "performance-stream",
      prompt: `Return exactly: scheduled fixture ${index + 1}`,
      permission: "read-only",
      notify: false,
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000 + index,
    }));
    await writeFile(output("profile", "schedules.json"), "[]\n", { mode: 0o600 });
    await writeFile(
      output("profile", "config.json"),
      `${JSON.stringify({
        workspaces: [
          {
            id: "default",
            name: "Performance fixture",
            folderPath: runtime("workspace"),
            permission: "ask",
            createdAt: now,
            updatedAt: now,
          },
        ],
        seeded: true,
      })}\n`,
      { mode: 0o600 },
    );
    const schedulesProfile = output("profiles", "schedules-20-missed");
    await mkdir(path.dirname(schedulesProfile), { recursive: true });
    await cp(output("profile"), schedulesProfile, {
      recursive: true,
      errorOnExist: true,
    });
    await writeFile(
      path.join(schedulesProfile, "schedules.json"),
      `${JSON.stringify(schedules)}\n`,
      {
        mode: 0o600,
      },
    );
    const streamProvider = {
      id: "performance-stream",
      kind: "openai",
      label: "Performance stream fixture",
      baseUrl: "http://127.0.0.1:41491/v1",
      needsKey: false,
      defaultModel: "performance-stream",
      deployment: "local",
    };
    const offlineMcp = {
      id: "performance-mcp-offline",
      name: "Performance offline",
      transport: "stdio",
      command: "/definitely/missing/aiden-mcp",
      enabled: true,
    };
    const hungMcp = {
      id: "performance-mcp-hung",
      name: "Performance hung",
      transport: "stdio",
      command: process.execPath,
      args: [runtime("mcp-hung.mjs")],
      enabled: true,
    };
    const portableConfig = (mcpServers) => ({
      providers: [streamProvider],
      providerIdAliases: {},
      mcpServers,
      skills: [],
    });
    await Promise.all([
      writeFile(
        output("configs", "default", "config.json"),
        `${JSON.stringify(portableConfig([]))}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        output("configs", "mcp-offline", "config.json"),
        `${JSON.stringify(portableConfig([offlineMcp]))}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        output("configs", "mcp-hung", "config.json"),
        `${JSON.stringify(portableConfig([hungMcp]))}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        output("configs", "mcp-duplicate-connect", "config.json"),
        `${JSON.stringify(portableConfig([offlineMcp]))}\n`,
        { mode: 0o600 },
      ),
    ]);
    await writeFile(
      output("stream-server.mjs"),
      `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path'; const root=${JSON.stringify(resolved)}; const server=http.createServer(async(req,res)=>{if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'performance-stream',object:'model'}]}));return;} if(req.url==='/v1/chat/completions'){let body='';for await(const chunk of req) body+=chunk;const parsed=JSON.parse(body||'{}');const toolCompleted=Array.isArray(parsed.messages)&&parsed.messages.some(message=>message.role==='tool');const count=body.includes('10000')?'10k':'2k';const text=await readFile(path.join(root,'stream-'+count+'.md'),'utf8');res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\\n\\n');send({reasoning_content:'Inspect the fixed fixture before answering. '});if(!toolCompleted&&Array.isArray(parsed.tools)&&parsed.tools.some(tool=>tool?.function?.name==='read_file')){send({tool_calls:[{index:0,id:'performance-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'src/fixture-0000.ts'})}}]},'tool_calls');res.end('data: [DONE]\\n\\n');return;}for(let i=0;i<text.length;i+=48){send({content:text.slice(i,i+48)});await new Promise(r=>setTimeout(r,20));}send({},'stop');res.end('data: [DONE]\\n\\n');return;}res.writeHead(404);res.end();});server.listen(41491,'127.0.0.1');\n`,
      { mode: 0o700 },
    );
    await writeFile(
      output("scenario-inputs.json"),
      `${JSON.stringify(
        {
          mcp: {
            offline: { command: "/definitely/missing/aiden-mcp" },
            hung: { command: process.execPath, args: [runtime("mcp-hung.mjs")] },
            duplicateConnects: 100,
          },
          schedules: { missed: 20 },
          attachments: {
            deletionSource: runtime("attachments", "text-00.txt"),
            deletionCopy: mutableRuntime("workspace", "deleted-attachment.txt"),
          },
          streams: {
            serverCommand: [process.execPath, runtime("stream-server.mjs")],
            model: "performance-stream",
            prompts: ["stream 2000", "stream 10000"],
          },
          repository: {
            runtimeRoot: mutableRuntime(),
            workspace: mutableRuntime("workspace"),
            clean: mutableRuntime("repo-reset.sh"),
            dirty: mutableRuntime("repo-dirty.sh"),
            churn: mutableRuntime("repo-churn.sh"),
          },
          voice: { file: runtime("voice-60s.wav"), seconds: 60 },
          terminals: { count: 4, outputCommand: runtime("terminal-output.sh") },
          lifecycle: {
            actions: ["suspend-resume", "lock-unlock", "timezone-change"],
            timezone: {
              source: "UTC",
              target: "America/New_York",
              settleSeconds: 60,
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const manifest = {
      schemaVersion: 1,
      runId,
      scenario,
      generatedAt: new Date().toISOString(),
      chats: [100, 500],
      streams: [2_000, 10_000],
      workspaceFiles: 4_000,
      attachmentFiles: 20,
      sparseAttachmentBytes,
      missedSchedules: 20,
      terminals: 4,
      fixtureIdentity: await computePerformanceFixtureIdentity(process.cwd()),
    };
    await writeFile(output("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const stagedInfo = await lstat(".", { bigint: true });
    if (
      stagedInfo.isSymbolicLink() ||
      !stagedInfo.isDirectory() ||
      stagedInfo.dev !== outputRootIdentity.device ||
      stagedInfo.ino !== outputRootIdentity.inode ||
      (await realpath(".")) !== outputRoot
    ) {
      throw new Error("Performance fixture staging changed before publication.");
    }
    await rename(outputRoot, resolved);
    published = true;
    return manifest;
  } finally {
    let boundStagingPath;
    if (workingDirectoryBound) {
      try {
        boundStagingPath = process.cwd();
      } catch {
        boundStagingPath = undefined;
      }
    }
    if (workingDirectoryBound) process.chdir(originalWorkingDirectory);
    activeFixtureStaging = undefined;
    for (const candidate of published
      ? []
      : new Set([outputRoot, boundStagingPath].filter(Boolean))) {
      try {
        const remaining = await lstat(candidate, { bigint: true });
        if (
          !remaining.isSymbolicLink() &&
          remaining.isDirectory() &&
          remaining.dev === outputRootIdentity.device &&
          remaining.ino === outputRootIdentity.inode &&
          (await realpath(candidate)) === candidate
        ) {
          await rm(candidate, { recursive: true, force: true });
        }
      } catch {
        // Successful publication removes the staging path; a replaced path is
        // deliberately left untouched rather than deleting unowned data.
      }
    }
  }
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  if (process.argv.includes("--list")) {
    process.stdout.write(`${PERFORMANCE_SCENARIOS.join("\n")}\n`);
    return;
  }
  const scenario = args.get("--scenario");
  const output = args.get("--output");
  if (!scenario || !output) {
    throw new Error(
      "Usage: performance-fixture.mjs --scenario <name> --output <receipt.json> [--fixture-root <path>] [--build-mode packaged]",
    );
  }
  const stamp = benchmarkStamp(scenario, args.get("--build-mode") ?? "development");
  const fixtureRoot =
    args.get("--fixture-root") ??
    path.join("build", "performance-runs", stamp.runId, "performance-fixture");
  const manifest = await preparePerformanceFixture(fixtureRoot, {
    runId: stamp.runId,
    scenario: stamp.scenario,
  });
  const receipt = {
    ...stamp,
    fixture: manifest,
    measurements: emptyPerformanceMeasurements(),
    artifacts: emptyPerformanceArtifacts(),
  };
  const resolvedOutput = path.resolve(output);
  await mkdir(PERFORMANCE_RESULTS_ROOT, { recursive: true, mode: 0o700 });
  if (
    path.dirname(resolvedOutput) !== PERFORMANCE_RESULTS_ROOT ||
    (await realpath(PERFORMANCE_RESULTS_ROOT)) !== PERFORMANCE_RESULTS_ROOT ||
    !/^[a-zA-Z0-9._-]{1,160}\.json$/u.test(path.basename(resolvedOutput))
  ) {
    throw new Error(
      "Performance receipts must be fresh JSON files directly under build/performance-results.",
    );
  }
  await writeFile(resolvedOutput, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `Prepared ${scenario} fixture at ${fixtureRoot} and stamped ${resolvedOutput}.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
