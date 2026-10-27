import assert from "node:assert/strict";
import test from "node:test";

import { WEB_FETCH_CHANNELS, registerWebFetchHandlers } from "./web-fetch.js";
import {
  defaultWebFetchSettings,
  webFetchRendererSnapshot,
  type WebFetchSettingsV1,
} from "../../renderer/shared/web-fetch-settings.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function register(options: { keyCount?: number; destroyed?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  let settings: WebFetchSettingsV1 = defaultWebFetchSettings();
  const owner = { destroyed: options.destroyed === true, isDestroyed: () => owner.destroyed };
  registerWebFetchHandlers<unknown>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: () => owner,
    snapshot: async () => webFetchRendererSnapshot({ settings, webSearchEnabled: true, keyCount: options.keyCount ?? 0 }),
    update: async (mutation, isCurrent) => {
      const next = mutation(structuredClone(settings));
      if (isCurrent()) settings = next;
    },
  });
  // Like ipcMain.handle, a handler that throws becomes a rejected invoke.
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { handlers, invoke, owner, current: () => settings };
}

test("every channel is registered", () => {
  assert.deepEqual([...register().handlers.keys()].sort(), [...WEB_FETCH_CHANNELS].sort());
});

test("page reading turns off and on and returns the new snapshot", async () => {
  const { invoke, current } = register();
  const snapshot = (await invoke("webSearch:pages:setEnabled", false)) as { settings: WebFetchSettingsV1 };
  assert.equal(snapshot.settings.enabled, false);
  assert.equal(current().enabled, false);
  await assert.rejects(invoke("webSearch:pages:setEnabled", "off"), /on or off/u);
});

test("extract mode turns on only once the account ID and a key are saved", async () => {
  const without = register({ keyCount: 1 });
  await assert.rejects(without.invoke("webSearch:pages:setExtractEnabled", true), /account ID and at least one API key/u);
  assert.equal(without.current().extract.enabled, false);

  const ready = register({ keyCount: 1 });
  await ready.invoke("webSearch:pages:setExtractAccountId", ` ${ACCOUNT_ID.toUpperCase()} `);
  assert.equal(ready.current().extract.accountId, ACCOUNT_ID);
  const snapshot = (await ready.invoke("webSearch:pages:setExtractEnabled", true)) as { extract: { active: boolean } };
  assert.equal(snapshot.extract.active, true);
  // Turning it off never needs the model.
  await ready.invoke("webSearch:pages:setExtractAccountId", null);
  assert.equal(ready.current().extract.accountId, undefined);
  await ready.invoke("webSearch:pages:setExtractEnabled", false);
  assert.equal(ready.current().extract.enabled, false);
});

test("a malformed account ID is refused and nothing changes", async () => {
  const { invoke, current } = register();
  await assert.rejects(invoke("webSearch:pages:setExtractAccountId", "acct-123"), /32 letters and digits/u);
  await assert.rejects(invoke("webSearch:pages:setExtractAccountId", 42), /must be text/u);
  assert.deepEqual(current(), defaultWebFetchSettings());
});

test("a closed window cannot read or change settings", async () => {
  const { invoke, current } = register({ destroyed: true });
  await assert.rejects(invoke("webSearch:pages:get"), /no longer active/u);
  await assert.rejects(invoke("webSearch:pages:setEnabled", false), /no longer active/u);
  assert.equal(current().enabled, true);
});
