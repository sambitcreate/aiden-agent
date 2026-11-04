import assert from "node:assert/strict";
import test from "node:test";
import { verifyCalendarContract } from "./composio-calendar-contract.js";
import { createComposioCalendarTransport } from "./composio-calendar-transport.js";
import type { ComposioCalendarTransportContext } from "./composio-calendar-host-port.js";
import { syntheticCalendarExecutor, syntheticCalendarMetadata, syntheticCalendarSchemas } from "./composio-calendar-test-support.js";
import type { ComposioCalendarRead } from "./connector-watch-composio.js";

const request: ComposioCalendarRead = { kind: "listEvents", accountId: "explicit-account", calendarId: "explicit@example.test", timeMin: "2026-11-04T15:00:00Z", timeMax: "2026-11-04T16:00:00Z", timezone: "UTC" };
function fixture() {
  let searches = 0, schemas = 0; const executions: ComposioCalendarRead[] = [];
  const metadata = syntheticCalendarMetadata(); const response = syntheticCalendarSchemas();
  const context: ComposioCalendarTransportContext = { phase: "background", metadata, signal: new AbortController().signal, async assertCurrent() {}, async getSchemas() { schemas++; return response; }, async execute(read) { executions.push(read); return syntheticCalendarExecutor(read, { items: [] }); }, async currentAccounts() { searches++; throw new Error("Search cannot run in the background"); } };
  return { context, response, executions, expected: verifyCalendarContract(metadata, response).contract, counts: () => ({ searches, schemas }) };
}
test("background prepare/read revalidates fixed schemas and never Search", async () => {
  const f = fixture(), transport = createComposioCalendarTransport();
  const ready = await transport.prepare(f.context, f.expected);
  await ready.port.assertCurrent(request, f.context.signal); await ready.port.read(request, f.context.signal);
  await ready.port.read({ ...request, pageToken: "opaque-exact-next-page" }, f.context.signal);
  assert.deepEqual(f.counts(), { searches: 0, schemas: 3 }); assert.equal(f.executions.length, 2);
  assert.equal(f.executions[1]!.kind === "listEvents" && f.executions[1]!.pageToken, "opaque-exact-next-page");
});
test("background without accepted contract and schema drift cannot execute", async () => {
  const f = fixture(), transport = createComposioCalendarTransport();
  await assert.rejects(transport.prepare(f.context)); assert.equal(f.counts().schemas, 0);
  const ready = await transport.prepare(f.context, f.expected);
  f.response.data.tool_schemas.GOOGLECALENDAR_EVENTS_LIST!.output_schema.properties.error = { type: "string", maxLength: 5 } as { type: string };
  await assert.rejects(ready.port.read(request, f.context.signal)); assert.equal(f.executions.length, 0);
});
test("revocation after awaited schema verification stops execution", async () => {
  const f = fixture(); const ready = await createComposioCalendarTransport().prepare(f.context, f.expected);
  let active = true; f.context.assertCurrent = async () => { if (!active) throw new Error("revoked"); };
  f.context.getSchemas = async () => { active = false; return f.response; };
  await assert.rejects(ready.port.read(request, f.context.signal), /revoked/u); assert.equal(f.executions.length, 0);
});
test("page cancellation during a noncooperative schema read cannot later execute", async () => {
  const f = fixture(); const ready = await createComposioCalendarTransport().prepare(f.context, f.expected);
  let release!: () => void, started!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { started = resolve; });
  f.context.getSchemas = async () => { started(); await held; return f.response; };
  const controller = new AbortController(); const pending = ready.port.read(request, controller.signal);
  await entered; controller.abort(); await assert.rejects(pending); release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.executions.length, 0);
});
test("foreground prepare still requires current source admission before fixed schema I/O", async () => {
  const f = fixture(); f.context.phase = "foreground"; f.context.assertCurrent = async () => { throw new Error("no current source admission"); };
  await assert.rejects(createComposioCalendarTransport().prepare(f.context)); assert.equal(f.counts().schemas, 0); assert.equal(f.executions.length, 0);
});

test("transport enforces declared upstream output even when the critical Calendar fields are plausible", async () => {
  const f = fixture(); f.response.data.tool_schemas.GOOGLECALENDAR_EVENTS_LIST!.output_schema.properties.items = { type: "string" } as never;
  const expected = verifyCalendarContract(f.context.metadata, f.response).contract;
  const ready = await createComposioCalendarTransport().prepare(f.context, expected);
  await assert.rejects(ready.port.read(request, f.context.signal)); assert.equal(f.executions.length, 1);
});

test("unsafe executor output is refused at preparation before any executor call", async () => {
  const f = fixture(); f.context.phase = "foreground";
  f.context.metadata[2]!.outputSchema = { type: "object", properties: { data: { type: "string", pattern: "(a+)+$" } } };
  await assert.rejects(createComposioCalendarTransport().prepare(f.context)); assert.equal(f.executions.length, 0);
});

test("production output validation rejects an executor root that violates its declared schema", async () => {
  const f = fixture(); const ready = await createComposioCalendarTransport().prepare(f.context, f.expected);
  f.context.execute = async (read) => ({ ...syntheticCalendarExecutor(read, { items: [] }), unexpected_output: true });
  await assert.rejects(ready.port.read(request, f.context.signal));
});
