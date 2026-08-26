import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  PERFORMANCE_SCENARIOS,
  PERFORMANCE_SPARSE_ATTACHMENT_BYTES,
  benchmarkStamp,
  computePerformanceFixtureIdentity,
  preparePerformanceFixture,
} from "./performance-fixture.mjs";

test("macOS benchmark stamps use the fixed system version utility", async () => {
  const source = await readFile(new URL("./performance-fixture.mjs", import.meta.url), "utf8");
  assert.match(source, /gitCommand\("\/usr\/bin\/sw_vers", "-productVersion"\)/u);
});

test("the benchmark scenario inventory covers every Phase 0 runtime case", () => {
  assert.equal(PERFORMANCE_SCENARIOS.length, 25);
  assert.ok(PERFORMANCE_SCENARIOS.includes("visible-idle"));
  assert.ok(PERFORMANCE_SCENARIOS.includes("mcp-hung"));
  assert.ok(PERFORMANCE_SCENARIOS.includes("timezone-change"));
  assert.equal(PERFORMANCE_SPARSE_ATTACHMENT_BYTES, 10 * 1024 * 1024 * 1024);
  assert.throws(() => benchmarkStamp("private-path", "packaged"), /Unknown performance scenario/u);
  assert.throws(() => benchmarkStamp("visible-idle", "private"), /Unknown benchmark build mode/u);
});

test("fixture generation is deterministic in shape and bounded", async () => {
  const temporary = await mkdtemp(path.join(process.cwd(), "build", "aiden-perf-test-"));
  const root = path.join(temporary, "performance-fixture");
  try {
    const manifest = await preparePerformanceFixture(root, {
      sparseAttachmentBytes: 16 * 1024 * 1024,
    });
    assert.equal(manifest.workspaceFiles, 4_000);
    assert.equal(manifest.sparseAttachmentBytes, 16 * 1024 * 1024);
    const chat = JSON.parse(await readFile(path.join(root, "chat-500.json"), "utf8"));
    assert.equal(chat.messages.length, 500);
    assert.equal(chat.messages[499].content.length, 1_024);
    assert.equal(chat.id, "performance-chat-500");
    assert.equal(chat.workspaceId, "default");
    const index = JSON.parse(
      await readFile(path.join(root, "profile", "chats", "index.json"), "utf8"),
    );
    assert.equal(index.length, 2);
    assert.equal(index[1].messages, undefined);
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: path.join(root, "workspace"),
        encoding: "utf8",
      }),
      "",
    );
    assert.equal((await stat(path.join(root, "attachments", "text-00.txt"))).size, 512 * 1024);
    assert.equal((await stat(path.join(root, "voice-60s.wav"))).size, 44 + 60 * 16_000 * 2);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "profile", "schedules.json"), "utf8")),
      [],
    );
    const missedSchedules = JSON.parse(
      await readFile(path.join(root, "profiles", "schedules-20-missed", "schedules.json"), "utf8"),
    );
    assert.equal(missedSchedules.length, 20);
    assert.ok(
      missedSchedules.every(
        ({ providerId, model }) =>
          providerId === "performance-stream" && model === "performance-stream",
      ),
    );
    const portable = JSON.parse(
      await readFile(path.join(root, "configs", "default", "config.json"), "utf8"),
    );
    assert.equal(portable.providers[0].id, "performance-stream");
    assert.equal(portable.mcpServers.length, 0);
    const hung = JSON.parse(
      await readFile(path.join(root, "configs", "mcp-hung", "config.json"), "utf8"),
    );
    assert.equal(hung.mcpServers.length, 1);
    const scenarioInputs = JSON.parse(
      await readFile(path.join(root, "scenario-inputs.json"), "utf8"),
    );
    const streamServer = await readFile(path.join(root, "stream-server.mjs"), "utf8");
    assert.match(streamServer, /path:'src\/fixture-0000\.ts'/u);
    assert.doesNotMatch(streamServer, /path\.join\(root,'workspace'/u);
    assert.deepEqual(scenarioInputs.lifecycle.timezone, {
      source: "UTC",
      target: "America/New_York",
      settleSeconds: 60,
    });
    assert.equal(
      scenarioInputs.attachments.deletionSource,
      path.join(root, "attachments", "text-00.txt"),
    );
    assert.equal(
      scenarioInputs.attachments.deletionCopy,
      path.join(path.dirname(root), "runtime", "workspace", "deleted-attachment.txt"),
    );
    assert.match(manifest.fixtureIdentity, /^[0-9a-f]{64}$/u);
    assert.equal(await computePerformanceFixtureIdentity(root), manifest.fixtureIdentity);
    const sparse = await open(path.join(root, "attachments", "sparse-10gb.txt"), "r+");
    await sparse.write(Buffer.from("X"), 0, 1, 8 * 1024 * 1024);
    await sparse.close();
    assert.notEqual(await computePerformanceFixtureIdentity(root), manifest.fixtureIdentity);
    execFileSync(path.join(root, "repo-dirty.sh"), [], { cwd: process.cwd() });
    assert.match(
      await readFile(path.join(root, "workspace", "src", "fixture-0000.ts"), "utf8"),
      /deterministic dirty state/u,
    );
    assert.notEqual(await computePerformanceFixtureIdentity(root), manifest.fixtureIdentity);
    execFileSync(path.join(root, "repo-reset.sh"), [], { cwd: process.cwd() });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("fixture generation never replaces an existing unowned directory", async () => {
  const temporary = await mkdtemp(path.join(process.cwd(), "build", "aiden-perf-owned-test-"));
  const root = path.join(temporary, "performance-fixture");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "valuable.txt"), "keep me");
    await assert.rejects(() => preparePerformanceFixture(root), /never replaced/u);
    assert.equal(await readFile(path.join(root, "valuable.txt"), "utf8"), "keep me");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("fixture generation refuses an arbitrary external performance-fixture path", async () => {
  const external = path.join(
    path.parse(process.cwd()).root,
    "tmp",
    "valuable",
    "performance-fixture",
  );
  await assert.rejects(() => preparePerformanceFixture(external), /repository's build directory/u);
});

test("fixture generation rejects an ancestor symlink without touching its target", async () => {
  const buildParent = await mkdtemp(path.join(process.cwd(), "build", "aiden-perf-link-test-"));
  const externalParent = await mkdtemp(
    path.join(process.cwd(), "build", "aiden-perf-external-test-"),
  );
  const externalFixture = path.join(externalParent, "performance-fixture");
  const link = path.join(buildParent, "redirect");
  try {
    await mkdir(externalFixture);
    await writeFile(path.join(externalFixture, "valuable.txt"), "keep me");
    await symlink(externalParent, link);
    await assert.rejects(
      () => preparePerformanceFixture(path.join(link, "performance-fixture")),
      /ancestors must be real directories|never replaced/u,
    );
    assert.equal(await readFile(path.join(externalFixture, "valuable.txt"), "utf8"), "keep me");
  } finally {
    await rm(buildParent, { recursive: true, force: true });
    await rm(externalParent, { recursive: true, force: true });
  }
});

test("a replaced staging pathname cannot redirect fixture writes", async () => {
  const temporary = await mkdtemp(path.join(process.cwd(), "build", "aiden-perf-swap-test-"));
  const root = path.join(temporary, "performance-fixture");
  const external = path.join(temporary, "external");
  const moved = path.join(temporary, "bound-original");
  await mkdir(external);
  try {
    await assert.rejects(
      () =>
        preparePerformanceFixture(root, {
          sparseAttachmentBytes: 1024 * 1024,
          testAfterStagingBound: async (staging) => {
            await rename(staging, moved);
            await symlink(external, staging);
          },
        }),
      /staging changed/u,
    );
    assert.deepEqual(await readdir(external), []);
    await assert.rejects(() => readdir(moved), /ENOENT/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("dirty source identity supports exact tracked deletions", async () => {
  const repository = await mkdtemp(path.join(process.cwd(), "build", "aiden-source-stamp-test-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Aiden Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@invalid.example"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository });
    await rm(path.join(repository, "tracked.txt"));
    const moduleUrl = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "performance-fixture.mjs"),
    ).href;
    const digest = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { dirtyTreeHash } from ${JSON.stringify(moduleUrl)}; process.stdout.write(dirtyTreeHash());`,
      ],
      { cwd: repository, encoding: "utf8" },
    );
    assert.match(digest, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
