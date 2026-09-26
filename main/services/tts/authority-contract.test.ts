import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSavedGoogleTtsKey } from "./credentials.js";

test("saved Google TTS keys use the managed credential store, not legacy custom keys", async () => {
  assert.equal(await readSavedGoogleTtsKey({ read: async (provider) => {
    assert.equal(provider, "google");
    return { type: "api_key", key: " test-google-key " };
  } }), "test-google-key");
  assert.equal(await readSavedGoogleTtsKey({ read: async () => undefined }), null);
  assert.equal(await readSavedGoogleTtsKey({ read: async () => ({ type: "api_key" }) }), null);
  assert.equal(await readSavedGoogleTtsKey({ read: async () => ({ type: "api_key", key: " " }) }), null);
  await assert.rejects(readSavedGoogleTtsKey({ read: async () => {
    throw new Error("secure storage unavailable");
  } }), /secure storage unavailable/u);
  assert.match(bindings, /getGoogleKey: \(\) => readSavedGoogleTtsKey\(piCredentialStore\)/u);
  assert.doesNotMatch(bindings, /secrets\.getKeyStrict\("google"\)/u);
});

const handlers = readFileSync(new URL("../../handlers/tts.ts", import.meta.url), "utf8");
const bindings = readFileSync(new URL("./service-main.ts", import.meta.url), "utf8");

function handler(channel: string): string {
  const start = handlers.indexOf(`ipcMain.handle("${channel}"`);
  assert.ok(start >= 0, `missing ${channel}`);
  const end = handlers.indexOf("ipcMain.handle(", start + 1);
  return handlers.slice(start, end < 0 ? undefined : end);
}

test("every TTS IPC handler validates the active renderer document", () => {
  const channels = [...handlers.matchAll(/ipcMain.handle\("(tts:[^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  assert.ok(channels.length >= 14);
  for (const channel of channels) assert.match(handler(channel), /owner\(event\)/u, channel);
  assert.match(
    handler("tts:voices:list"),
    /asNonEmptyString\(request.pageToken, "voice page token", 2048\)/u,
  );
});

test("credential mutations retain the document fence through the secret-store transaction", () => {
  for (const channel of ["tts:credential:set", "tts:credential:clear"]) {
    assert.match(handler(channel), /!currentOwner.isDestroyed\(\)/u);
  }
  assert.match(
    bindings,
    /setInternalKey\(TTS_DEDICATED_SECRET_ID, key, MAX_TTS_KEY_LENGTH, isCurrent\)/u,
  );
  assert.match(bindings, /deleteKey\(TTS_DEDICATED_SECRET_ID, isCurrent\)/u);
});


test("production synthesis persists usage through the privacy-safe mapper", () => {
  assert.match(bindings, /recordUsage:.*usageStore\.record\(ttsUsageRecord\(report\)\)/u);
});
