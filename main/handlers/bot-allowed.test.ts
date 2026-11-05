import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { emptyToolApprovalRulesDocument, ToolApprovalRuleBook, type ToolApprovalRuleStore } from "../services/tool-approval-rules.js";
import { createBotApprovalTallies } from "../services/bot-runtime/bot-approval-tallies.js";
import { createBotAllowList } from "../services/bot-runtime/bot-allow-list.js";
import { createBotApprovals } from "../services/bot-runtime/bot-approvals.js";
import { registerBotAllowedHandlers, registerBotApprovalDecisionHandler } from "./bot-allowed.js";

const CAL = { kind: "connection", serverId: "calendar", tool: "create_event" } as const;
async function setup(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bot-allowed-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let document = emptyToolApprovalRulesDocument(), tail: Promise<unknown> = Promise.resolve(), id = 0;
  const bots = new Set(["bot:ada", "bot:jo"]);
  const store: ToolApprovalRuleStore = {
    load: async () => structuredClone(document),
    update: mutation => {
      const result = tail.then(async () => { const draft = structuredClone(document), result = await mutation(draft); document = draft; return result; });
      tail = result.catch(() => {}); return result;
    },
  };
  const book = new ToolApprovalRuleBook(store, () => new Date("2026-11-04T12:00:00Z"), () => `rule_${++id}`, { knownBot: async botId => bots.has(botId) });
  const allowed = createBotAllowList({ rules: book, tallies: createBotApprovalTallies({ profileDir: () => dir }), approvals: createBotApprovals({ publish() {} }),
    botName: async () => "Ada", connectionName: async () => "Calendar", folderEntries: async () => [], revokeFolder: async () => false, log() {} });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const events: Array<{ channel: string; payload: unknown }> = [];
  const dispose = registerBotAllowedHandlers({ handle: (channel, handler) => handlers.set(channel, handler), allowed,
    onChange: listener => allowed.onChange(listener), botExists: async botId => bots.has(botId),
    broadcast: (channel, payload) => events.push({ channel, payload }) });
  t.after(dispose);
  const invoke = (channel: string, input?: unknown) => Promise.resolve().then(() => handlers.get(channel)!({}, input));
  return { book, allowed, events, bots, invoke, dispose };
}

test("desktop allowed IPC lists both Bots or one, removes only the named Bot entry, and emits safe change IDs", async t => {
  const f = await setup(t);
  await f.book.grantBot("bot:ada", CAL, "Calendar · Create event", "ada-person-decision");
  await f.book.grantBot("bot:jo", CAL, "Calendar · Create event", "jo-person-decision");
  const rows = await f.allowed.list();
  assert.deepEqual(await f.invoke("bots:allowed:list"), rows);
  assert.deepEqual(await f.invoke("bots:allowed:list", { botId: "bot:ada" }), rows.filter(row => row.botId === "bot:ada"));
  const ada = rows.find(row => row.botId === "bot:ada")!;
  assert.deepEqual(await f.invoke("bots:allowed:remove", { botId: "bot:jo", entryId: ada.id }), { removed: false });
  assert.deepEqual(await f.invoke("bots:allowed:remove", { botId: "bot:ada", entryId: ada.id }), { removed: true });
  assert.deepEqual(await f.invoke("bots:allowed:list", { botId: "bot:ada" }), []);
  assert.equal((await f.allowed.list("bot:jo")).length, 1);
  assert.deepEqual(f.events, [
    { channel: "bots:allowed:changed", payload: { botId: "bot:ada" } },
    { channel: "bots:allowed:changed", payload: { botId: "bot:jo" } },
    { channel: "bots:allowed:changed", payload: { botId: "bot:ada" } },
  ]);
  f.dispose();
  await f.book.recordBotUse("bot:jo", rows.find(row => row.botId === "bot:jo")!.id);
  assert.equal(f.events.length, 3, "teardown stops later broadcasts");
});

test("unknown or deleted Bots and malformed allowed IPC requests cannot read or remove another entry", async t => {
  const f = await setup(t);
  await f.book.grantBot("bot:ada", CAL, "Calendar · Create event", "decision");
  const row = (await f.allowed.list("bot:ada"))[0]!;
  for (const botId of ["bot:missing", "bot:deleted"]) {
    await assert.rejects(f.invoke("bots:allowed:list", { botId }), /This Bot no longer exists/u);
    await assert.rejects(f.invoke("bots:allowed:remove", { botId, entryId: row.id }), /This Bot no longer exists/u);
  }
  for (const input of [{ botId: "bot:ada", entryId: "../rules" }, { botId: "bot:ada", entryId: row.id, audienceId: "phone" }]) {
    await assert.rejects(f.invoke("bots:allowed:remove", input));
  }
  assert.equal((await f.allowed.list("bot:ada")).length, 1);
  f.bots.delete("bot:ada");
  await assert.rejects(f.invoke("bots:allowed:remove", { botId: "bot:ada", entryId: row.id }), /no longer exists/u);
});


test("desktop Always answers retain the offered scope and provenance; unoffered scopes cannot widen a one-time request", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const approvals = createBotApprovals({ publish() {} });
  registerBotApprovalDecisionHandler({ handle: (channel, handler) => handlers.set(channel, handler), approvals });
  const invoke = (input: unknown) => Promise.resolve().then(() => handlers.get("bots:approve")!({}, input));
  const base = { signal: undefined, botId: "bot:ada", toolCallId: "provider-reused", toolName: "calendar_create", summary: "Create event", authorizationFingerprint: "fingerprint" };
  const offered = approvals.request({ ...base, waitId: "offered", always: { key: "private-target-key", count: 3 } });
  assert.deepEqual(await invoke({ waitId: "offered", decision: "allow", scope: "always" }), { decided: true });
  assert.deepEqual(await offered, { id: "offered", authorizationFingerprint: "fingerprint", answer: "allow_always", source: "person" });
  assert.deepEqual(await invoke({ waitId: "offered", decision: "allow", scope: "always" }), { decided: false });
  const ordinary = approvals.request({ ...base, waitId: "ordinary" });
  await invoke({ waitId: "ordinary", decision: "allow", scope: "always" });
  assert.equal((await ordinary).answer, "allow", "an unoffered scope keeps the ordinary one-time allowance");
  const denied = approvals.request({ ...base, waitId: "denied" });
  await assert.rejects(invoke({ waitId: "denied", decision: "deny", scope: "always" }), /fields/u);
  assert.equal(approvals.pending()[0]?.waitId, "denied");
  await invoke({ waitId: "denied", decision: "deny" });
  assert.equal((await denied).answer, "deny");
});
