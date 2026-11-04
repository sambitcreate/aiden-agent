import assert from "node:assert/strict";
import test from "node:test";
import { registerBotPendingChangeCleanup } from "./bot-pending-changes.js";

test("retirement requires absence of both raw identity and authenticated authority", async () => {
  let invoke!: (event: unknown, input: unknown) => Promise<string[]>;
  registerBotPendingChangeCleanup({ handle: (_channel, handler) => { invoke = handler; }, owner: () => ({ isDestroyed: () => false }), initialize: async () => {},
    storedIds: async () => ["corrupt_but_present"], absentAuthorities: async () => ["corrupt_but_present", "deleted"] });
  assert.deepEqual(await invoke({}, ["corrupt_but_present", "deleted", "live_authority"]), ["deleted"]);
  await assert.rejects(invoke({}, ["../other"]));
});
test("unreadable protected authority and a closed document cannot produce deletion proof", async () => {
  let invoke!: (event: unknown, input: unknown) => Promise<string[]>, closed = false, unavailable = true;
  registerBotPendingChangeCleanup({ handle: (_channel, handler) => { invoke = handler; }, owner: () => ({ isDestroyed: () => closed }),
    initialize: async () => {}, storedIds: async () => [], absentAuthorities: async () => { if (unavailable) throw new Error("Protected state unavailable."); closed = true; return ["bot_a"]; } });
  await assert.rejects(invoke({}, ["bot_a"]), /Protected state unavailable/u);
  unavailable = false; await assert.rejects(invoke({}, ["bot_a"]), /document/u);
});
