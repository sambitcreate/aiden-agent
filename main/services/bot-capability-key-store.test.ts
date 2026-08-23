import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  BOT_CAPABILITY_OPAQUE_KEY_FILENAME,
  createBotCapabilityOpaqueKeyStore,
} from "./bot-capability-key-store.js";

async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-key-"));
}

test("opaque capability key is stable, private, and copied at the boundary", async () => {
  const root = await temporaryRoot();
  const expected = Uint8Array.from({ length: 32 }, (_unused, index) => index);
  const first = createBotCapabilityOpaqueKeyStore({
    root: () => root,
    randomKey: () => expected,
  });
  const loaded = await first.load();
  loaded[0] = 255;
  assert.deepEqual(await first.load(), expected);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(root, BOT_CAPABILITY_OPAQUE_KEY_FILENAME))).mode & 0o777,
    0o600,
  );
  const restarted = createBotCapabilityOpaqueKeyStore({
    root: () => root,
    randomKey: () => new Uint8Array(32).fill(99),
  });
  assert.deepEqual(await restarted.load(), expected);
});

test("corrupt key fails closed and is preserved", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, BOT_CAPABILITY_OPAQUE_KEY_FILENAME);
  await fs.writeFile(file, "short", { mode: 0o600 });
  const store = createBotCapabilityOpaqueKeyStore({ root: () => root });
  await assert.rejects(store.load(), /invalid length/u);
  assert.equal(await fs.readFile(file, "utf8"), "short");
});

test("symlink key and unsafe roots are rejected", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "target");
  await fs.writeFile(target, Buffer.alloc(32), { mode: 0o600 });
  await fs.symlink(target, path.join(root, BOT_CAPABILITY_OPAQUE_KEY_FILENAME));
  await assert.rejects(
    createBotCapabilityOpaqueKeyStore({ root: () => root }).load(),
    /private regular file/u,
  );
  await assert.rejects(
    createBotCapabilityOpaqueKeyStore({ root: () => "." }).load(),
    /absolute private root/u,
  );
});
