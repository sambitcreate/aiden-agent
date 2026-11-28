import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SubagentRunStoreStorageError,
  createNativeSubagentRunStoreStorage,
  isSubagentRunStoreGeneration,
} from "./subagent-run-store-io.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(repositoryRoot, "build", "native", "aiden-subagent-run-store");

test("native run-store adapter accepts the platform generation and round-trips data", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("The native run-store helper is supported only on macOS and Linux.");
    return;
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-io-"));
  const storeDirectory = path.join(parent, "store");
  const storage = createNativeSubagentRunStoreStorage(storeDirectory, binary);
  t.after(async () => {
    await storage.close();
    await rm(parent, { recursive: true, force: true });
  });

  assert.deepEqual(await storage.stat!(), {
    status: "missing",
    generation: "missing",
  });
  assert.deepEqual(await storage.read(), {
    status: "missing",
    contents: undefined,
    generation: "missing",
  });
  const first = await storage.write("missing", '{"revision":1}');
  assert.match(
    first,
    process.platform === "linux"
      ? /^[0-9a-f]+(?:-[0-9a-f]+){6}$/u
      : /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u,
  );
  assert.deepEqual(await storage.stat!(), {
    status: "data",
    generation: first,
  });
  assert.deepEqual(await storage.read(), {
    status: "data",
    contents: Buffer.from('{"revision":1}'),
    generation: first,
  });
  const second = await storage.write(first, '{"revision":2}');
  assert.notEqual(second, first);
  assert.deepEqual(await storage.stat!(), {
    status: "data",
    generation: second,
  });
  await storage.syncDirectory();
});

test("native run-store stat reports oversized stores and rejects permissive or non-regular files", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("The native run-store helper is supported only on macOS and Linux.");
    return;
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-io-stat-"));
  const storeDirectory = path.join(parent, "store");
  const target = path.join(storeDirectory, "runs.json");
  const storage = createNativeSubagentRunStoreStorage(storeDirectory, binary);
  t.after(async () => {
    await storage.close();
    await rm(parent, { recursive: true, force: true });
  });

  await storage.write("missing", '{"revision":1}');
  await chmod(target, 0o644);
  await assert.rejects(
    storage.stat!(),
    (error: unknown) =>
      error instanceof SubagentRunStoreStorageError && error.failure === "invalid_mode",
  );
  await chmod(target, 0o600);

  const hardlink = path.join(parent, "hardlink.json");
  await link(target, hardlink);
  await assert.rejects(
    storage.stat!(),
    (error: unknown) =>
      error instanceof SubagentRunStoreStorageError && error.failure === "destination_changed",
  );
  await rm(hardlink);

  await writeFile(target, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
  await chmod(target, 0o600);
  const oversizedStat = await storage.stat!();
  const oversizedRead = await storage.read();
  assert.equal(oversizedStat.status, "oversized");
  assert.equal(oversizedStat.generation, oversizedRead.generation);

  await rm(target);
  const outside = path.join(parent, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, target);
  await assert.rejects(
    storage.stat!(),
    (error: unknown) =>
      error instanceof SubagentRunStoreStorageError && error.failure === "destination_changed",
  );

  await rm(target);
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/mkfifo", [target], (error) => (error ? reject(error) : resolve()));
  });
  await assert.rejects(
    storage.stat!(),
    (error: unknown) =>
      error instanceof SubagentRunStoreStorageError && error.failure === "destination_changed",
  );
});

test("native generation admits exactly Linux and macOS field shapes", () => {
  assert.equal(isSubagentRunStoreGeneration("missing"), true);
  for (let fields = 1; fields <= 12; fields++) {
    assert.equal(isSubagentRunStoreGeneration(Array.from({ length: fields }, () => "a1").join("-")), fields === 7 || fields === 9);
  }
  for (const value of [undefined, null, 1, "", "A-1-1-1-1-1-1", "1-1-1-1-1-1-1\n", "1--1-1-1-1-1-1"]) assert.equal(isSubagentRunStoreGeneration(value), false);
});
