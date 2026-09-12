import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import {
  LINUX_PAYLOAD_INVENTORY_LIMITS,
  computeLinuxPayloadInventory,
  serializeLinuxPayloadInventory,
  validateLinuxPayloadInventory,
  verifyLinuxPayloadInventory,
  verifyLinuxPayloadInventoryFile,
  writeLinuxPayloadInventory,
} from "./linux-payload-inventory.mjs";
const script = fileURLToPath(new URL("./linux-payload-inventory.mjs", import.meta.url));
async function fixture(context) {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "aiden-payload-inventory-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "payload");
  await mkdir(root, { mode: 0o755 });
  await mkdir(path.join(root, "resources"), { mode: 0o755 });
  await writeFile(path.join(root, "aiden-agent"), "synthetic executable", { mode: 0o755 });
  await writeFile(path.join(root, "resources/app.asar"), "synthetic archive", { mode: 0o644 });
  return { base, root, manifest: path.join(base, "expected.json") };
}

test("complete deterministic inventory includes root, directories, full modes and file hashes", async context => {
  const { root } = await fixture(context);
  await mkdir(path.join(root, "empty"), { mode: 0o700 });
  await writeFile(path.join(root, "!first"), "punctuation");
  await chmod(path.join(root, "aiden-agent"), 0o4755);
  const inventory = await computeLinuxPayloadInventory(root);
  assert.deepEqual(inventory.entries.map(entry => entry.path), [".", "!first", "aiden-agent", "empty", "resources", "resources/app.asar"]);
  assert.equal(inventory.entries.find(entry => entry.path === "aiden-agent").mode, 0o4755);
  assert.deepEqual(inventory.entries.find(entry => entry.path === "resources/app.asar"), {
    path: "resources/app.asar", type: "file", mode: 0o644, size: 17,
    sha256: createHash("sha256").update("synthetic archive").digest("hex"),
  });
  const first = serializeLinuxPayloadInventory(inventory);
  assert.equal(first, serializeLinuxPayloadInventory(await computeLinuxPayloadInventory(root)));
  await verifyLinuxPayloadInventory(root, inventory);
});

test("creation order and timestamps do not change serialized inventory", async context => {
  const { root, base } = await fixture(context);
  const second = path.join(base, "second");
  await mkdir(second, { mode: 0o755 });
  await writeFile(path.join(second, "aiden-agent"), "synthetic executable", { mode: 0o755 });
  await mkdir(path.join(second, "resources"), { mode: 0o755 });
  await writeFile(path.join(second, "resources/app.asar"), "synthetic archive", { mode: 0o644 });
  assert.equal(serializeLinuxPayloadInventory(await computeLinuxPayloadInventory(root)),
    serializeLinuxPayloadInventory(await computeLinuxPayloadInventory(second)));
});

test("streaming hashing covers content beyond one read chunk", async context => {
  const { root } = await fixture(context);
  const bytes = Buffer.alloc(2 * 1024 ** 2 + 37, 0x41);
  bytes[bytes.length - 1] = 0x42;
  await writeFile(path.join(root, "large"), bytes);
  const entry = (await computeLinuxPayloadInventory(root)).entries.find(value => value.path === "large");
  assert.equal(entry.size, bytes.length);
  assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
});

for (const [name, mutate] of [
  ["changed bytes", root => writeFile(path.join(root, "resources/app.asar"), "tampered archive!")],
  ["changed executable mode", root => chmod(path.join(root, "aiden-agent"), 0o644)],
  ["changed directory mode", root => chmod(path.join(root, "resources"), 0o700)],
  ["changed root mode", root => chmod(root, 0o700)],
  ["added file", root => writeFile(path.join(root, "extra"), "extra")],
  ["added empty directory", root => mkdir(path.join(root, "extra"))],
  ["missing file", root => rm(path.join(root, "resources/app.asar"))],
  ["file replaced by directory", async root => { await rm(path.join(root, "aiden-agent")); await mkdir(path.join(root, "aiden-agent")); }],
]) test(`verification rejects ${name}`, async context => {
  const { root } = await fixture(context);
  const expected = await computeLinuxPayloadInventory(root);
  await mutate(root);
  await assert.rejects(verifyLinuxPayloadInventory(root, expected), /does not match/u);
});

for (const [name, make] of [
  ["file symlink", (root, base) => symlink(path.join(base, "outside"), path.join(root, "linked"))],
  ["directory symlink", root => symlink("resources", path.join(root, "linked"))],
  ["hard link", root => link(path.join(root, "aiden-agent"), path.join(root, "linked"))],
]) test(`rejects payload ${name}`, async context => {
  const { root, base } = await fixture(context);
  await writeFile(path.join(base, "outside"), "outside");
  await make(root, base);
  await assert.rejects(computeLinuxPayloadInventory(root), /link/u);
});

test("rejects root and ancestor symlinks", async context => {
  const { root, base } = await fixture(context);
  const linked = path.join(base, "linked");
  await symlink(root, linked);
  await assert.rejects(computeLinuxPayloadInventory(linked), /ancestor.*link/u);
  await assert.rejects(computeLinuxPayloadInventory(path.join(linked, "resources")), /ancestor.*link/u);
});

test("rejects FIFO without opening or blocking on it", async context => {
  const { root } = await fixture(context);
  const result = spawnSync("mkfifo", [path.join(root, "pipe")], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(computeLinuxPayloadInventory(root), /regular file/u);
});

test("detects metadata changes while a file is being read", async context => {
  const { root } = await fixture(context);
  const file = path.join(root, "aiden-agent");
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let mutated = false;
  context.mock.method(prototype, "read", async function (...args) {
    const result = await original.apply(this, args);
    if (!mutated && result.bytesRead) { mutated = true; await chmod(file, 0o700); }
    return result;
  });
  await assert.rejects(computeLinuxPayloadInventory(root), /changed during inventory/u);
});

test("external manifest creation is exclusive and verification is explicit", async context => {
  const { root, manifest } = await fixture(context);
  await writeLinuxPayloadInventory(root, manifest);
  const original = await readFile(manifest);
  await verifyLinuxPayloadInventoryFile(root, manifest);
  await assert.rejects(writeLinuxPayloadInventory(root, manifest), /EEXIST/u);
  assert.deepEqual(await readFile(manifest), original);
  await assert.rejects(writeLinuxPayloadInventory(root, path.join(root, "manifest.json")), /outside/u);
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, path.join(root, "resources/app.asar")), /outside/u);
});

test("manifest path may not use symlinks or hard links", async context => {
  const { root, manifest, base } = await fixture(context);
  await writeLinuxPayloadInventory(root, manifest);
  const linked = path.join(base, "linked.json");
  await symlink(manifest, linked);
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, linked), /regular file/u);
  await assert.rejects(writeLinuxPayloadInventory(root, linked), /EEXIST/u);
  const parent = path.join(base, "parent");
  await symlink(base, parent);
  await assert.rejects(writeLinuxPayloadInventory(root, path.join(parent, "new.json")), /ancestor.*link/u);
  await rm(linked);
  await link(manifest, linked);
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, linked), /hard link/u);
});

test("bounded file and manifest sizes reject sparse oversized inputs before reading", async context => {
  const { root, manifest } = await fixture(context);
  await writeFile(manifest, "");
  await truncate(manifest, LINUX_PAYLOAD_INVENTORY_LIMITS.manifestBytes + 1);
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, manifest), /size limit/u);
  const large = path.join(root, "large");
  await writeFile(large, "");
  await truncate(large, LINUX_PAYLOAD_INVENTORY_LIMITS.fileBytes + 1);
  await assert.rejects(computeLinuxPayloadInventory(root), /size limit/u);
});

test("rejects malformed schemas, paths, digests, ordering, parents and bounds", async context => {
  const { root } = await fixture(context);
  const valid = await computeLinuxPayloadInventory(root);
  for (const mutate of [
    value => value.schemaVersion = 2,
    value => value.hashAlgorithm = "sha1",
    value => value.authenticated = true,
    value => value.entries = [],
    value => value.entries = Array(LINUX_PAYLOAD_INVENTORY_LIMITS.entries + 1).fill(value.entries[0]),
    value => value.entries[0].path = "root",
    value => value.entries[1].path = "/absolute",
    value => value.entries[1].path = "../escape",
    value => value.entries[1].path = "resources/./file",
    value => value.entries[1].path = "resources//file",
    value => value.entries[1].path = "resources\\file",
    value => value.entries[1].path = "line\nbreak",
    value => value.entries[1].path = "x".repeat(LINUX_PAYLOAD_INVENTORY_LIMITS.pathBytes + 1),
    value => value.entries[1].path = "x/".repeat(LINUX_PAYLOAD_INVENTORY_LIMITS.depth) + "file",
    value => value.entries[1].sha256 = "0".repeat(63),
    value => value.entries[1].sha256 = "A".repeat(64),
    value => value.entries[1].size = -1,
    value => value.entries[1].mode = 0o10000,
    value => value.entries[1].mode = 0.5,
    value => value.entries[1].unknown = "extra",
    value => value.entries.push(value.entries[1]),
    value => value.entries.reverse(),
    value => value.entries.splice(2, 1),
    value => value.entries[1].type = "symlink",
  ]) {
    const changed = globalThis.structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateLinuxPayloadInventory(changed));
  }
});

test("aggregate declared size is bounded", () => {
  const entries = [{ path: ".", type: "directory", mode: 0o755 }];
  for (let index = 0; index < 9; index++) entries.push({ path: `file${index}`, type: "file", mode: 0o644,
    size: LINUX_PAYLOAD_INVENTORY_LIMITS.fileBytes, sha256: "0".repeat(64) });
  assert.throws(() => validateLinuxPayloadInventory({ schemaVersion: 1, hashAlgorithm: "sha256", entries }), /total size limit/u);
});

test("no inventory filename is silently excluded from payload coverage", async context => {
  const { root } = await fixture(context);
  await writeFile(path.join(root, "linux-payload-inventory.json"), "ordinary payload file");
  assert.ok((await computeLinuxPayloadInventory(root)).entries.some(entry => entry.path === "linux-payload-inventory.json"));
});

test("CLI creates and verifies external inventory, refuses overwrite and invalid usage", async context => {
  const { root, manifest } = await fixture(context);
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run(["compute", root, manifest]).status, 0);
  const verified = run(["verify", root, manifest]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /authenticity and immutable installation are not established/u);
  assert.equal(run(["compute", root, manifest]).status, 1);
  assert.equal(run(["verify", root, manifest, "extra"]).status, 2);
  assert.equal(run(["verify"]).status, 2);
  await writeFile(path.join(root, "aiden-agent"), "tampered");
  assert.equal(run(["verify", root, manifest]).status, 1);
});

test("manifest JSON and UTF-8 parsing failures are rejected", async context => {
  const { root, manifest } = await fixture(context);
  await writeFile(manifest, "{");
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, manifest));
  await writeFile(manifest, Buffer.from([0xff]));
  await assert.rejects(verifyLinuxPayloadInventoryFile(root, manifest));
});

test("noncanonical filesystem roots are rejected without path normalization", async context => {
  const { root } = await fixture(context);
  await assert.rejects(computeLinuxPayloadInventory(`${root}/`), /canonical/u);
  await assert.rejects(computeLinuxPayloadInventory(`${root}/resources/..`), /canonical/u);
  await assert.rejects(computeLinuxPayloadInventory("relative/path"), /canonical/u);
});
