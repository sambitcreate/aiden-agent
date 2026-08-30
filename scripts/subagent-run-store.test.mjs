/* global Buffer, clearTimeout, process, setTimeout */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionBinary = path.join(repositoryRoot, "build", "native", "aiden-subagent-run-store");
const testingBinary = path.join(repositoryRoot, "build", "native", "aiden-subagent-run-store-test");

function startHelper(t, directory, executable, environment = {}) {
  const child = spawn(executable, ["serve", "--directory", directory], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const lines = [];
  const waiters = [];
  const stderr = [];
  let failure;

  function fail(error) {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }

  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.once("error", fail);
  const closed = new Promise((resolve) => {
    child.once("close", (code) => {
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        fail(new Error(detail || `Subagent run-store helper exited with ${code}.`));
      }
      resolve();
    });
  });

  function nextLine() {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  const ready = nextLine().then((line) => {
    assert.equal(line, "ready");
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
  });

  return {
    async request(command) {
      await ready;
      await new Promise((resolve, reject) => {
        child.stdin.write(`${command}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return nextLine();
    },
    async close() {
      assert.equal(await this.request("close"), "ok");
      child.stdin.end();
      await closed;
    },
  };
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for test barrier: ${path.basename(file)}`);
}

function writeCommand(expected, contents) {
  return `write ${expected} ${Buffer.from(contents, "utf8").toString("base64")}`;
}

function touchFromReference(reference, target) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/touch", ["-r", reference, target], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createFifo(target) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/mkfifo", [target], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function requestPromptly(request, operation) {
  let timeout;
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${operation} to respond to the FIFO.`));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseData(response) {
  const match = /^data ([0-9a-f]+(?:-[0-9a-f]+){6,8}) ([A-Za-z0-9+/]*={0,2})$/u.exec(response);
  assert.ok(match);
  return {
    generation: match[1],
    contents: Buffer.from(match[2], "base64").toString("utf8"),
  };
}

test("a helper never acknowledges a generation installed by another writer", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-native-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const marker = path.join(root, "writer-a-installed");
  await mkdir(directory, { mode: 0o700 });

  const writerA = startHelper(t, directory, testingBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_AFTER_INSTALL: marker,
  });
  const writerB = startHelper(t, directory, productionBinary);
  const writerAResult = writerA.request(writeCommand("missing", "writer A\n"));
  await waitForFile(marker);

  const generationA = parseData(await writerB.request("read")).generation;
  const writerBResult = await writerB.request(writeCommand(generationA, "writer B\n"));
  assert.match(writerBResult, /^ok [0-9a-f]+(?:-[0-9a-f]+){6,8}$/u);
  await writeFile(`${marker}.continue`, "continue\n", { mode: 0o600 });

  assert.equal(await writerAResult, "error destination_changed");
  assert.equal(
    await writerA.request(writeCommand("missing", "writer A follow-up\n")),
    "error destination_changed",
  );
  assert.equal(parseData(await writerA.request("read")).contents, "writer B\n");
  assert.equal(await readFile(path.join(directory, "runs.json"), "utf8"), "writer B\n");

  await writerA.close();
  await writerB.close();
});

test("a FIFO destination fails closed without blocking reads or expected-generation writes", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-fifo-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const target = path.join(directory, "runs.json");
  await mkdir(directory, { mode: 0o700 });

  const bootstrap = startHelper(t, directory, productionBinary);
  const initial = await bootstrap.request(writeCommand("missing", "authorized store\n"));
  const expectedGeneration = /^ok ([0-9a-f]+(?:-[0-9a-f]+){6,8})$/u.exec(initial)?.[1];
  assert.ok(expectedGeneration);
  await bootstrap.close();

  await rm(target);
  await createFifo(target);

  const helper = startHelper(t, directory, productionBinary);
  assert.equal(
    await requestPromptly(helper.request("read"), "read"),
    "error destination_changed",
  );
  assert.equal(
    await requestPromptly(
      helper.request(writeCommand(expectedGeneration, "unexpected replacement\n")),
      "expected-generation write",
    ),
    "error destination_changed",
  );
  assert.equal(
    await requestPromptly(helper.request(writeCommand("missing", "unexpected create\n")), "missing write"),
    "error destination_changed",
  );

  await helper.close();
});

test("cleanup skips owned temporary FIFOs without blocking", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-cleanup-fifo-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const staged = path.join(directory, ".runs.json.12345678-1234-4234-8234-123456789abc.tmp");
  const captured = path.join(directory, ".runs.json.abcdef12-1234-4234-8234-123456789abc.cleanup");
  await mkdir(directory, { mode: 0o700 });
  await createFifo(staged);
  await createFifo(captured);

  const helper = startHelper(t, directory, productionBinary);
  assert.equal(await requestPromptly(helper.request("cleanup"), "cleanup"), "ok 1");
  assert.equal((await stat(staged)).isFIFO(), true);
  assert.equal((await stat(captured)).isFIFO(), true);

  await helper.close();
});

test("a post-install in-place rewrite with its mtime restored is not acknowledged", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-in-place-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const target = path.join(directory, "runs.json");
  const marker = path.join(root, "writer-installed");
  const timestampReference = path.join(root, "installed-timestamp");
  const installedContents = "safe\n";
  const replacementContents = "evil\n";
  assert.equal(Buffer.byteLength(replacementContents), Buffer.byteLength(installedContents));
  await mkdir(directory, { mode: 0o700 });

  const writer = startHelper(t, directory, testingBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_AFTER_INSTALL: marker,
  });
  const writeResult = writer.request(writeCommand("missing", installedContents));
  await waitForFile(marker);

  await writeFile(timestampReference, "timestamp\n", { mode: 0o600 });
  await touchFromReference(target, timestampReference);
  const before = await stat(target, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(target, replacementContents, { mode: 0o600 });
  await touchFromReference(timestampReference, target);
  const after = await stat(target, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);

  await writeFile(`${marker}.continue`, "continue\n", { mode: 0o600 });
  assert.equal(await writeResult, "error destination_changed");
  assert.equal(parseData(await writer.request("read")).contents, replacementContents);

  await writer.close();
});

test("a hardlink added after read validation is rejected without chmodding its inode", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-link-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const target = path.join(directory, "runs.json");
  const sentinel = path.join(root, "external-sentinel.json");
  const marker = path.join(root, "reader-validated");
  const contents = "permissive mode must survive\n";
  await mkdir(directory, { mode: 0o700 });
  await writeFile(target, contents, { mode: 0o644 });
  await chmod(target, 0o644);

  const reader = startHelper(t, directory, testingBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_AFTER_READ_STAT: marker,
  });
  const readResult = reader.request("read");
  await waitForFile(marker);
  await link(target, sentinel);
  const before = await stat(sentinel);
  assert.equal(before.mode & 0o777, 0o644);
  assert.equal(before.nlink, 2);
  await writeFile(`${marker}.continue`, "continue\n", { mode: 0o600 });

  assert.equal(await readResult, "error destination_changed");
  const afterTarget = await stat(target);
  const afterSentinel = await stat(sentinel);
  assert.equal(await readFile(target, "utf8"), contents);
  assert.equal(await readFile(sentinel, "utf8"), contents);
  assert.equal(afterTarget.mode & 0o777, 0o644);
  assert.equal(afterSentinel.mode & 0o777, 0o644);
  assert.equal(afterTarget.nlink, 2);
  assert.equal(afterSentinel.nlink, 2);
  assert.equal(afterTarget.ino, before.ino);
  assert.equal(afterSentinel.ino, before.ino);

  await reader.close();
});

test("a displaced old store replacement survives the final atomic capture boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-displaced-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const marker = path.join(root, "before-displaced-capture");
  await mkdir(directory, { mode: 0o700 });

  const bootstrap = startHelper(t, directory, productionBinary);
  const initial = await bootstrap.request(writeCommand("missing", "authorized old store\n"));
  const initialGeneration = /^ok (.+)$/u.exec(initial)?.[1];
  assert.ok(initialGeneration);
  await bootstrap.close();

  const writer = startHelper(t, directory, testingBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_DISPLACED_CAPTURE: marker,
  });
  const writeResult = writer.request(writeCommand(initialGeneration, "new store\n"));
  await waitForFile(marker);
  const stagedNames = (await readdir(directory)).filter(
    (name) => name.startsWith(".runs.json.") && name.endsWith(".tmp"),
  );
  assert.equal(stagedNames.length, 1);
  const staged = path.join(directory, stagedNames[0]);
  const movedOriginal = path.join(directory, "moved-authorized-old-store");
  await rename(staged, movedOriginal);
  await writeFile(staged, "unrelated replacement\n", { mode: 0o600 });
  await writeFile(`${marker}.continue`, "continue\n", { mode: 0o600 });

  assert.equal(await writeResult, "error destination_changed");
  assert.equal(await readFile(path.join(directory, "runs.json"), "utf8"), "new store\n");
  assert.equal(await readFile(movedOriginal, "utf8"), "authorized old store\n");
  assert.equal(await readFile(staged, "utf8"), "unrelated replacement\n");

  await writer.close();
});

test("cleanup preserves a replacement raced in immediately before atomic capture", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-cleanup-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const stale = path.join(directory, ".runs.json.12345678-1234-4234-8234-123456789abc.tmp");
  const movedOriginal = path.join(directory, "moved-authorized-stale");
  const marker = path.join(root, "before-cleanup-capture");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(stale, "authorized stale file\n", { mode: 0o600 });

  const helper = startHelper(t, directory, testingBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_CLEANUP_CAPTURE: marker,
  });
  const cleanupResult = helper.request("cleanup");
  await waitForFile(marker);
  await rename(stale, movedOriginal);
  await writeFile(stale, "unrelated replacement\n", { mode: 0o600 });
  await writeFile(`${marker}.continue`, "continue\n", { mode: 0o600 });

  assert.equal(await cleanupResult, "error destination_changed");
  assert.equal(await readFile(movedOriginal, "utf8"), "authorized stale file\n");
  assert.equal(await readFile(stale, "utf8"), "unrelated replacement\n");

  await helper.close();
});

test("production run-store ignores native capture pause controls", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-production-controls-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "private-runs");
  const marker = path.join(root, "must-not-exist");
  const stale = path.join(directory, ".runs.json.12345678-1234-4234-8234-123456789abc.tmp");
  await mkdir(directory, { mode: 0o700 });

  const helper = startHelper(t, directory, productionBinary, {
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_DISPLACED_CAPTURE: marker,
    AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_CLEANUP_CAPTURE: marker,
  });
  const initial = await helper.request(writeCommand("missing", "first\n"));
  const initialGeneration = /^ok (.+)$/u.exec(initial)?.[1];
  assert.ok(initialGeneration);
  assert.match(
    await helper.request(writeCommand(initialGeneration, "second\n")),
    /^ok [0-9a-f]+(?:-[0-9a-f]+){6,8}$/u,
  );
  await writeFile(stale, "stale\n", { mode: 0o600 });
  assert.equal(await helper.request("cleanup"), "ok 1");
  await assert.rejects(access(marker));

  await helper.close();
});
