import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import mutableFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getMcpPreset, serverFromPreset } from "../mcp-presets.js";
import { botConnectorForegroundLifetime, botConnectorInventoryServer } from "../bot-connector-inventory-scope.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas, syntheticCalendarSearch } from "./composio-calendar-test-support.js";
import { COMPOSIO_CALENDAR_READ_CHECK_FILE, createComposioSettingsCalendarReadCheck, saveComposioCalendarReadCheck } from "./composio-settings-calendar-check.js";
import type { ComposioCalendarReadCheckResult } from "./composio-calendar-read-check.js";
import { McpError } from "@earendil-works/pi-mcp";

const lifetime = () => ({ signal: new AbortController().signal, assertCurrent() {} });
async function fixture(t: test.TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-calendar-settings-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = serverFromPreset(getMcpPreset("composio")!);
  let clients = 0, reads = 0;
  let executorFailure: unknown;
  let published: ComposioCalendarReadCheckResult | undefined;
  let beforePublish = async () => {};
  const check = createComposioSettingsCalendarReadCheck({
    configured: async () => server,
    withClient: async (configured, _signal, operation) => {
      clients++;
      assert.equal(configured.id, "preset-composio");
      assert.equal(botConnectorInventoryServer(), configured.id);
      assert.ok(botConnectorForegroundLifetime());
      return operation({ assertCurrent: async () => {}, list: async () => syntheticCalendarMetadata(),
        call: async (tool) => tool === "COMPOSIO_SEARCH_TOOLS" ? syntheticCalendarSearch() : syntheticCalendarSchemas(),
        readCalendar: async (read) => {
          reads++;
          if (executorFailure !== undefined) throw executorFailure;
          if (read.accountId !== "ca_syntheticactive00001") return syntheticCalendarExecutor(read, undefined, "Connected account not found");
          const event = { id: "private-event-id", status: "confirmed", summary: "Private meeting title", start: { dateTime: "2026-11-04T12:30:00Z" }, end: { dateTime: "2026-11-04T12:45:00Z" } };
          return syntheticCalendarExecutor(read, read.kind === "listCalendars" ? { items: [{ id: "explicit-calendar@example.test", accessRole: "reader", summary: "Private calendar label" }] } : read.kind === "listEvents" ? { items: [event] } : event);
        },
      });
    },
    publish: async (result, current) => { await beforePublish(); await saveComposioCalendarReadCheck(directory, result, current); published = result; },
    now: () => Date.parse("2026-11-04T12:00:00Z"),
  });
  return { directory, server, check, get clients() { return clients; }, get reads() { return reads; }, get published() { return published; }, failRead: (failure: unknown) => { executorFailure = failure; }, beforePublish: (callback: typeof beforePublish) => { beforePublish = callback; } };
}

test("explicit Settings Calendar check preserves service settings and publishes only private structural proof", async (t) => {
  const f = await fixture(t), before = structuredClone(f.server);
  const result = await f.check(lifetime());
  assert.equal(f.published?.status, "verified");
  assert.equal(f.clients, 1); assert.equal(f.reads, 4);
  assert.deepEqual(f.server, before);
  assert.deepEqual(Object.keys(result), ["message"]);
  const file = path.join(f.directory, COMPOSIO_CALENDAR_READ_CHECK_FILE);
  const retained = await fs.readFile(file, "utf8");
  for (const secret of ["ca_syntheticactive00001", "explicit-calendar@example.test", "Private calendar label", "Private meeting title", "private-event-id", "secret-owner@example.test", "synthetic-private-session"]) {
    assert.ok(!retained.includes(secret)); assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("Settings privately persists closed RPC failure facts without error payloads or public diagnostics", async (t) => {
  const f = await fixture(t), marker = "private-rpc-message-account-credential-and-data";
  f.failRead(new McpError(-32033, `Account ${marker} not found`, { account_id: marker, provider_response: marker }));
  const result = await f.check(lifetime());
  assert.equal(f.reads, 1); assert.equal(f.published?.privateProof.invalidAccountRejected, false);
  const file = path.join(f.directory, COMPOSIO_CALENDAR_READ_CHECK_FILE), retained = await fs.readFile(file, "utf8"), proof = JSON.parse(retained).privateProof;
  assert.equal(proof.readFailure.stage, "send");
  assert.deepEqual(proof.readFailure.error, { category: "rpc", rpcCode: "server_error", rpcErrorDataPresent: true, textCategory: "account_not_found" });
  assert.equal(retained.includes(marker), false); assert.equal(retained.includes("-32033"), false);
  assert.ok(Buffer.byteLength(retained) < 32 * 1024); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(result), ["message"]); assert.equal(JSON.stringify(result).includes("readFailure"), false);
});

test("disabled and restricted Composio never constructs the Calendar read client", async (t) => {
  for (const mode of ["disabled", "off-model", "hidden", "legacy"] as const) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === "disabled") f.server.enabled = false;
    else if (mode === "off-model") f.server.exposure = "hidden";
    else f.server.hiddenTools = [mode === "hidden" ? "composio" : "COMPOSIO_SEARCH_TOOLS"];
    await f.check(lifetime());
    assert.equal(f.clients, 0); assert.equal(f.reads, 0); assert.equal(f.published, undefined);
    assert.deepEqual(await fs.readdir(f.directory), []);
  });
});

test("revocation after Calendar responses prevents proof publication", async (t) => {
  const f = await fixture(t);
  f.beforePublish(async () => { f.server.hiddenTools = ["composio"]; });
  await f.check(lifetime());
  assert.equal(f.published, undefined);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("Calendar proof publication rechecks owner after the final filesystem await and preserves prior evidence", async (t) => {
  const f = await fixture(t); await f.check(lifetime());
  const file = path.join(f.directory, COMPOSIO_CALENDAR_READ_CHECK_FILE);
  const previous = await fs.readFile(file, "utf8"), controller = new AbortController();
  const current = async () => controller.signal.throwIfAborted();
  let invalidated = false;
  const original = mutableFs.lstat;
  const intercepted = t.mock.method(mutableFs, "lstat", (async (...args: Parameters<typeof mutableFs.lstat>) => {
    const info = await original(...args);
    if (!invalidated && String(args[0]) === file && (await fs.readdir(f.directory)).some((name) => name.endsWith(".tmp"))) { invalidated = true; controller.abort(); }
    return info;
  }) as typeof mutableFs.lstat);
  syncBuiltinESMExports();
  try {
    await assert.rejects(saveComposioCalendarReadCheck(f.directory, { ...f.published!, checkedAt: f.published!.checkedAt + 1 }, current));
    assert.equal(invalidated, true);
  } finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await fs.readFile(file, "utf8"), previous);
  assert.deepEqual(await fs.readdir(f.directory), [COMPOSIO_CALENDAR_READ_CHECK_FILE]);
});
