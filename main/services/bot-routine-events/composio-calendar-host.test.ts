import assert from "node:assert/strict";
import test from "node:test";
import { createComposioCalendarHost } from "./composio-calendar-host.js";
import { createComposioCalendarTransport } from "./composio-calendar-transport.js";
import { composioSourceConnection } from "./connector-source-admission.js";
import { syntheticCalendarMetadata, syntheticCalendarSchemas, syntheticCalendarSearch, syntheticCalendarExecutor } from "./composio-calendar-test-support.js";
import { botConnectorInventoryCacheOnly, botConnectorInventoryServer } from "../bot-connector-inventory-scope.js";
import { readComposioCalendarWatch, type ComposioCalendarRead } from "./connector-watch-composio.js";
import type { McpServer } from "../types.js";
import type { BotConnectorSourceAdmission } from "./connector-source-admission.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";

const SERVER = "preset-composio", NOW = Date.parse("2026-11-03T15:00:00Z"), ACCOUNT = "ca_syntheticactive00001", CALENDAR = "calendar@example.test";
const signal = () => new AbortController().signal;
function fixture() {
  const authorityController=new AbortController();
  let allowed = true, live = true, installed = true, releases = 0, lists = 0, sourceAdmissions = 0;
  let selected: BotConnectorSourceAdmission["selectedConnection"];
  let before: ((name: string) => void) | undefined;
  const effects: Array<{ name: string; args: Record<string, unknown> }> = [];
  const grant = composioSourceConnection(SERVER, "a".repeat(64));
  const current = async () => { if (!allowed || !live) throw new Error("source/client revoked"); };
  const host = createComposioCalendarHost({
    transport: () => installed ? createComposioCalendarTransport() : undefined,
    server: async () => { await current(); return { id: SERVER } as McpServer; },
    preflight: current, isPaused: async () => false, now: () => NOW,
    admit: async () => { sourceAdmissions++; await current(); return { ...(selected ? { selectedConnection: selected } : {}), signal: authorityController.signal, revalidateBeforeEffect: current, release: () => { releases++; } }; },
    connection: async held => { await held.revalidateBeforeEffect(); if (held.selectedConnection) assert.deepEqual(held.selectedConnection, grant); return grant; },
    withClient: async (_server, _signal, _foreground, action) => { await current(); return action({
      list: async () => { assert.equal(botConnectorInventoryServer(), SERVER); assert.equal(botConnectorInventoryCacheOnly(), false, "only selected metadata renewal temporarily leaves cache-only assembly"); before?.("tools/list"); await current(); lists++; return syntheticCalendarMetadata(); },
      call: async (name, args) => { before?.(name); await current(); effects.push({ name, args });
        if (name === "COMPOSIO_SEARCH_TOOLS") return syntheticCalendarSearch();
        if (name === "COMPOSIO_GET_TOOL_SCHEMAS") { assert.deepEqual(args.include, ["input_schema", "output_schema"]); return syntheticCalendarSchemas(); }
        assert.equal(name, "COMPOSIO_MULTI_EXECUTE_TOOL"); const item = (args.tools as Array<{ tool_slug: string; account: string; arguments: Record<string, string> }>)[0]!;
        assert.equal((args.tools as unknown[]).length, 1); assert.equal(item.account, ACCOUNT); assert.equal(args.sync_response_to_workbench, false);
        const read: ComposioCalendarRead = item.tool_slug.endsWith("LIST_CALENDARS") ? { kind: "listCalendars", accountId: ACCOUNT } : { kind: "listEvents", accountId: ACCOUNT, calendarId: item.arguments.calendarId!, timeMin: item.arguments.timeMin!, timeMax: item.arguments.timeMax!, timezone: item.arguments.timeZone! };
        return syntheticCalendarExecutor(read, read.kind === "listCalendars" ? { items: [{ id: CALENDAR, summary: "Planning", accessRole: "reader" }] } : { items: [{ id: "event-one", status:"confirmed", summary: "Planning", start: { dateTime: "2026-11-03T15:30:00Z" }, end: { dateTime: "2026-11-03T16:00:00Z" } }] });
      },
    }); },
  });
  return { host, grant, effects, counts: () => ({ releases, lists, sourceAdmissions }), revoke: () => { allowed = false;authorityController.abort(); }, close: () => { live = false; }, uninstall: () => { installed = false; }, select: () => { selected = grant; }, before: (callback: typeof before) => { before = callback; } };
}

test("Calendar has no source discovery, metadata or reads until the verified host transport is installed", async () => {
  const f = fixture(); f.uninstall(); assert.equal(f.host.available(), false);
  await assert.rejects(f.host.discover("bot", SERVER, signal(), async () => {}), /await/u);
  assert.equal(f.counts().sourceAdmissions, 0); assert.equal(f.counts().lists, 0); assert.deepEqual(f.effects, []);
});

test("foreground source discovery and background polls share one service allowance, with no background Search", async () => {
  const f = fixture(); f.select();
  const [binding] = await f.host.discover("bot", SERVER, signal(), async () => {}); assert.ok(binding); assert.equal(binding.accountId, ACCOUNT); assert.equal(binding.calendarId, CALENDAR); assert.equal(binding.tools.length, 1);
  const prior = f.effects.length;
  const result = await f.host.withPort("bot", binding, signal(), port => readComposioCalendarWatch({accountId:binding.accountId,calendarId:binding.calendarId,labels:binding.labels}, { lookAheadMinutes: 60, timezone: "America/New_York" }, undefined, port, NOW, signal()));
  assert.equal(result.items.length, 1); assert.equal(result.changes[0]!.kind, "entered");
  assert.equal(f.effects.slice(prior).some(row => row.name === "COMPOSIO_SEARCH_TOOLS"), false);
  assert.deepEqual(f.effects.slice(prior).filter(row => row.name === "COMPOSIO_MULTI_EXECUTE_TOOL").map(row => (row.args.tools as Array<{ tool_slug: string }>)[0]!.tool_slug), ["GOOGLECALENDAR_EVENTS_LIST"]);
  assert.equal(f.counts().releases, 2); assert.equal(botConnectorInventoryServer(), undefined);
});

test("current source/client changes at metadata, schema and actual send boundaries stop all later effects", async () => {
  for (const boundary of ["tools/list", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL"]) {
    const f = fixture(); const [binding] = await f.host.discover("bot", SERVER, signal(), async () => {}); const start = f.effects.length;
    f.before(name => { if (name === boundary) f.revoke(); });
    await assert.rejects(f.host.withPort("bot", binding!, signal(), port => readComposioCalendarWatch({accountId:binding!.accountId,calendarId:binding!.calendarId,labels:binding!.labels}, { lookAheadMinutes: 60, timezone: "UTC" }, undefined, port, NOW, signal())));
    assert.equal(f.effects.slice(start).some(row => row.name === "COMPOSIO_MULTI_EXECUTE_TOOL"), false); assert.equal(f.counts().releases, 2);
  }
});

test("queued source revalidation borrows the actual task grant and refuses recipient/current binding drift", async () => {
  const f = fixture(); const [binding] = await f.host.discover("bot", SERVER, signal(), async () => {});
  let validations = 0; const task = { authority: { connections: [f.grant] }, signal: signal(), revalidateBeforeEffect: async () => { validations++; }, release: () => { throw new Error("borrowed task lease must remain owned by its task"); } } as unknown as BotRuntimeAuthorityAdmission;
  const before = f.counts().sourceAdmissions; await f.host.validate("bot", binding!, signal(), task); assert.equal(f.counts().sourceAdmissions, before); assert.ok(validations > 1);
  const wrong = structuredClone(binding!); wrong.calendarId = "other@example.test";
  await assert.rejects(f.host.withPort("bot", wrong, signal(), port => port.read({ kind: "listEvents", accountId: ACCOUNT, calendarId: CALENDAR, timeMin: new Date(NOW).toISOString(), timeMax: new Date(NOW + 60_000).toISOString(), timezone: "UTC" }, signal())), /cannot change/u);
  const empty = { ...task, authority: { connections: [] } } as unknown as BotRuntimeAuthorityAdmission;
  await assert.rejects(f.host.validate("recipient", binding!, signal(), empty), /no current allowance/u);
  f.close(); await assert.rejects(f.host.validate("bot", binding!, signal(), task));
});


test("Calendar save authorization retains the same source lease through the caller's publication boundary", async()=>{
  const f=fixture();const [binding]=await f.host.discover("bot",SERVER,signal(),async()=>{});const before=f.counts();
  const held=await f.host.authorize("bot",binding!,signal());
  assert.equal(f.counts().sourceAdmissions,before.sourceAdmissions+1);assert.equal(f.counts().releases,before.releases,"the validated source lease is still held for the caller's atomic mutation");
  f.revoke();assert.equal(held.signal.aborted,true);await assert.rejects(held.revalidateBeforeEffect());held.release();assert.equal(f.counts().releases,before.releases+1);
});
