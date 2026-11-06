import assert from "node:assert/strict";
import test from "node:test";
import { createAidenRemoteBotAllowList } from "./aiden-remote-bot-allowed.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { emptyToolApprovalRulesDocument, ToolApprovalRuleBook, type ToolApprovalRuleStore } from "./tool-approval-rules.js";
import { createBotAllowList } from "./bot-runtime/bot-allow-list.js";
import type { BotAllowedEntry } from "../../renderer/shared/tool-approval-scope.js";

const BOT = "bot:00000000-0000-4000-8000-000000000057";
const OTHER = "bot:00000000-0000-4000-8000-000000000058";
const error = (code: string, status: number) => (value: unknown) => value instanceof AidenRemoteServiceError && value.code === code && value.status === status;
async function fixture(ruleCount = 2, folderCount = 1) {
  let time = Date.parse("2026-11-04T12:00:00Z"), document = emptyToolApprovalRulesDocument(), id = 0, known = true;
  let tail: Promise<unknown> = Promise.resolve();
  const store: ToolApprovalRuleStore = { load: async () => structuredClone(document), update: mutation => {
    const pending = tail.then(async () => { const next = structuredClone(document), result = await mutation(next); document = next; return result; });
    tail = pending.catch(() => {}); return pending;
  } };
  const rules = new ToolApprovalRuleBook(store, () => new Date(time), () => `rule_${++id}`, { knownBot: async () => known });
  for (let n = 0; n < ruleCount; n++) await rules.grantBot(BOT, n === 1 ? { kind: "site", host: "amazon.com", action: "click" } : { kind: "connection", serverId: "private-server", tool: `private-tool-${n}` }, n === 0 ? "Google Calendar · Create event" : `Action ${n}`, `private-decision-${n}`);
  let folders: BotAllowedEntry[] = Array.from({ length: folderCount }, (_, n) => ({ kind: "folder", id: `folder_root_${n}`, botId: BOT, what: `Folder · ~/Documents/Taxes ${n}`, createdAt: new Date(time + 1_000).toISOString() }));
  const allowed = createBotAllowList({ rules, tallies: {} as never, approvals: { pending: () => [], releaseFromAllowList: async () => false }, botName: async () => "Ada", connectionName: async () => "Calendar", folderEntries: async botId => structuredClone(folders.filter(f => !botId || f.botId === botId)), revokeFolder: async (botId, sourceId) => { const before = folders.length; folders = folders.filter(f => f.botId !== botId || f.id !== `folder_${sourceId}`); return before !== folders.length; } });
  const service = createAidenRemoteBotAllowList({ allowed, botExists: async botId => known && (botId === BOT || botId === OTHER), now: () => time });
  return { service, allowed, rules, advance: (ms: number) => { time += ms; }, setKnown: (value: boolean) => { known = value; } };
}

test("Remote allowed maps real rules and folders without private targets and removes replay-safely", async () => {
  const f = await fixture(); await f.rules.recordBotUse(BOT, "rule_1");
  const page = await f.service.list("phone", BOT);
  assert.deepEqual(page.entries.map(e => e.what), ["Folder · ~/Documents/Taxes 0", "Google Calendar · Create event", "Click on amazon.com"]);
  assert.deepEqual(page.entries[0], { id: "folder_root_0", kind: "folder", what: "Folder · ~/Documents/Taxes 0", addedAt: "2026-11-04T12:00:01.000Z" });
  const used = page.entries[1]!; assert.ok(used.kind === "rule");
  assert.equal(used.uses, 1); assert.equal(used.lastUsedAt, "2026-11-04T12:00:00.000Z");
  for (const secret of ["private-server", "private-tool", "private-decision", "target", "authorizationFingerprint"]) assert.equal(JSON.stringify(page).includes(secret), false);
  const removed = await f.service.remove("phone", BOT, "rule_1");
  assert.deepEqual(await f.service.remove("phone", BOT, "rule_1"), removed);
  assert.equal(removed.entries.some(e => e.id === "rule_1"), false);
  assert.deepEqual(await f.rules.grantBot(BOT, { kind: "connection", serverId: "private-server", tool: "private-tool-0" }, "Changed", "private-decision-0"), { status: "revoked" });
  await f.service.remove("phone", BOT, "folder_root_0"); assert.equal((await f.service.list("phone", BOT)).entries.length, 1);
  f.setKnown(false); await assert.rejects(f.service.list("phone", BOT), error("not_found", 404));
});

test("fifty rules plus folders page one immutable device-and-Bot snapshot without omissions", async () => {
  const f = await fixture(50, 3); const first = await f.service.list("phone", BOT);
  assert.equal(first.entries.length, 50); assert.ok(first.nextCursor);
  await f.rules.recordBotUse(BOT, "rule_50");
  const second = await f.service.list("phone", BOT, first.nextCursor);
  assert.equal(second.entries.length, 3); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 53);
  assert.equal([...first.entries, ...second.entries].filter(e => e.kind === "folder").length, 3);
  assert.deepEqual(await f.service.list("phone", BOT, first.nextCursor), second);
  await assert.rejects(f.service.list("another-phone", BOT, first.nextCursor), error("invalid_request", 400));
  await assert.rejects(f.service.list("phone", OTHER, first.nextCursor), error("invalid_request", 400));
  const fresh = await f.service.remove("phone", BOT, "rule_1"); assert.equal(fresh.entries.length, 50);
  await assert.rejects(f.service.list("phone", BOT, first.nextCursor), error("invalid_request", 400));
  assert.ok(fresh.nextCursor); await f.service.remove("phone", BOT, "missing");
  await assert.rejects(f.service.list("phone", BOT, fresh.nextCursor), error("invalid_request", 400));
});

test("cursors expire, obey per-device and global capacity, and recheck live Bot existence", async () => {
  const f = await fixture(50, 1); const first = await f.service.list("phone", BOT);
  for (let n = 0; n < 4; n++) await f.service.list("phone", BOT);
  await assert.rejects(f.service.list("phone", BOT, first.nextCursor), error("invalid_request", 400));
  const older = await f.service.list("older-device", BOT);
  for (let n = 0; n < 64; n++) await f.service.list(`device-${n}`, BOT);
  await assert.rejects(f.service.list("older-device", BOT, older.nextCursor), error("invalid_request", 400));
  const timed = await f.service.list("phone", BOT); f.advance(120_000);
  await assert.rejects(f.service.list("phone", BOT, timed.nextCursor), error("invalid_request", 400));
  const live = await f.service.list("phone", BOT); f.setKnown(false);
  await assert.rejects(f.service.list("phone", BOT, live.nextCursor), error("not_found", 404));
});

test("capture and remove serialize so a delayed capture cannot resurrect an invalidated cursor", async () => {
  const f = await fixture(50, 3); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const original = f.allowed.list; f.allowed.list = async botId => { const rows = await original(botId); started(); await gate; return rows; };
  const page = f.service.list("phone", BOT); await entered;
  const removed = f.service.remove("phone", BOT, "rule_1"); release();
  const captured = await page; await removed;
  await assert.rejects(f.service.list("phone", BOT, captured.nextCursor), error("invalid_request", 400));
});

test("complete oversized views are refused and aggregate byte capacity evicts whole snapshots", async () => {
  const rows = (count: number): BotAllowedEntry[] => Array.from({ length: count }, (_, n) => ({ kind: "folder", id: `folder_${n}`, botId: BOT, what: "😀".repeat(200), createdAt: "2026-11-04T12:00:00.000Z" }));
  let entries = rows(12_000);
  const service = createAidenRemoteBotAllowList({ allowed: { list: async () => entries, remove: async () => false }, botExists: async () => true });
  await assert.rejects(service.list("phone", BOT), error("payload_too_large", 413));
  entries = rows(2_000);
  const first = await service.list("phone-0", BOT); assert.ok(first.nextCursor);
  for (let n = 1; n <= 4; n++) await service.list(`phone-${n}`, BOT);
  await assert.rejects(service.list("phone-0", BOT, first.nextCursor), error("invalid_request", 400));
});

test("all rules and folders can be removed; other devices retain only their historical display snapshot", async () => {
  const f = await fixture(50, 3);
  const first = await f.service.list("phone", BOT), peer = await f.service.list("peer", BOT);
  const all = [...first.entries, ...(await f.service.list("phone", BOT, first.nextCursor)).entries];
  await f.service.remove("phone", BOT, all[0]!.id);
  assert.equal((await f.service.list("peer", BOT, peer.nextCursor)).entries.length, 3);
  for (const entry of all.slice(1)) await f.service.remove("phone", BOT, entry.id);
  assert.deepEqual(await f.service.list("phone", BOT), { botId: BOT, entries: [] });
  assert.equal((await f.rules.listBot(BOT)).length, 0);
});
