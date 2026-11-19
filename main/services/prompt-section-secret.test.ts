import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  PROMPT_SECTION_KEY_FILE,
  chatPromptSecret,
  forgetPromptSectionDeviceKeys,
  promptSectionDeviceKey,
} from "./prompt-section-secret.js";

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-prompt-section-key-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
// Each test starts as a fresh process would: nothing cached.
beforeEach(() => forgetPromptSectionDeviceKeys());

test("a restarted app reads back the device key it created, so a chat's secret survives restarts", async () => {
  const dir = await dataDir();
  const first = chatPromptSecret(promptSectionDeviceKey(dir), "chat-a");
  forgetPromptSectionDeviceKeys();
  const afterRestart = chatPromptSecret(promptSectionDeviceKey(dir), "chat-a");
  assert.deepEqual(afterRestart, first);
  assert.equal(first.length, 32);
});

test("the key file is readable by its owner only", { skip: process.platform === "win32" }, async () => {
  const dir = await dataDir();
  promptSectionDeviceKey(dir);
  assert.equal((await stat(path.join(dir, PROMPT_SECTION_KEY_FILE))).mode & 0o777, 0o600);
});

test("chats and devices get unrelated secrets", async () => {
  const key = promptSectionDeviceKey(await dataDir());
  const other = promptSectionDeviceKey(await dataDir());
  assert.notDeepEqual(key, other);
  assert.notDeepEqual(chatPromptSecret(key, "chat-a"), chatPromptSecret(key, "chat-b"));
  assert.notDeepEqual(chatPromptSecret(key, "chat-a"), chatPromptSecret(other, "chat-a"));
});

test("a damaged key file is replaced with a new key that later launches keep", async () => {
  const dir = await dataDir();
  const file = path.join(dir, PROMPT_SECTION_KEY_FILE);
  await writeFile(file, "not a key\n");
  const replaced = promptSectionDeviceKey(dir);
  assert.match(await readFile(file, "utf8"), /^[0-9a-f]{64}\n$/u);
  forgetPromptSectionDeviceKeys();
  assert.deepEqual(promptSectionDeviceKey(dir), replaced);
});

test("an unwritable data folder still gives one stable key for the whole run", async () => {
  const missing = path.join(await dataDir(), "missing", "nested");
  const key = promptSectionDeviceKey(missing);
  assert.equal(key.length, 32);
  assert.deepEqual(promptSectionDeviceKey(missing), key);
});
