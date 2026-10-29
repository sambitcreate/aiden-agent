import assert from "node:assert/strict";
import test from "node:test";
import { SpendingService } from "../services/spending-service.js";
import { registerSpendingHandlers } from "./spending.js";

function register(settings: unknown) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const spending = new SpendingService({
    persistence: { load: async () => undefined, save: async () => {} },
    settings: async () => settings,
    broadcast: () => {},
  });
  registerSpendingHandlers({ handle: (channel, handler) => void handlers.set(channel, handler), spending });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler({}, ...args);
  };
  return { spending, invoke };
}

test("a chat's status and Allow more go through the ledger; no limit reads as null", async () => {
  const { spending, invoke } = register({ chatUsd: 2 });
  assert.deepEqual(await invoke("spending:status", "chat", "chat-1"), {
    ownerKind: "chat", ownerId: "chat-1", period: "chat", limitUsd: 2, extraUsd: 0, spentUsd: 0, state: "under",
  });
  await spending.record({ kind: "chat", id: "chat-1" }, 2.2);
  const allowed = (await invoke("spending:allowMore", "chat", "chat-1")) as { extraUsd: number; state: string };
  assert.deepEqual([allowed.extraUsd, allowed.state], [2, "under"]);
  assert.equal(await register({}).invoke("spending:status", "chat", "chat-1"), null);
  await assert.rejects(invoke("spending:status", "team", "x"), /Invalid spending request/u);
  await assert.rejects(invoke("spending:status", "chat", ""), /Invalid spending request/u);
});

test("a Bot's own monthly limit can be the default, none or an amount, and a bad amount is refused", async () => {
  const { invoke } = register({ botMonthUsd: 10 });
  assert.deepEqual(await invoke("spending:botLimit", "ada"), { kind: "default" });
  assert.deepEqual(await invoke("spending:setBotLimit", "ada", 25), { kind: "amount", usd: 25 });
  assert.equal(((await invoke("spending:status", "bot", "ada")) as { limitUsd: number }).limitUsd, 25);
  assert.deepEqual(await invoke("spending:setBotLimit", "ada", null), { kind: "none" });
  assert.equal(await invoke("spending:status", "bot", "ada"), null);
  assert.deepEqual(await invoke("spending:setBotLimit", "ada", "default"), { kind: "default" });
  assert.equal(((await invoke("spending:status", "bot", "ada")) as { limitUsd: number }).limitUsd, 10);
  for (const bad of [0, -5, "25", 1e9]) {
    await assert.rejects(invoke("spending:setBotLimit", "ada", bad), /Invalid spending limit/u, String(bad));
  }
});
