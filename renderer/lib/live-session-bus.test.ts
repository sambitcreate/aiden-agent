import assert from "node:assert/strict";
import test from "node:test";
import { LiveSessionBus, type LiveSessionTransport } from "./live-session-bus.js";

function transport(log: unknown[]): LiveSessionTransport {
  return {
    toolResult: async (sessionId, requestId, response) => {
      log.push({ sessionId, requestId, response });
      return true;
    },
    note: async (sessionId, text) => {
      log.push({ sessionId, note: text });
      return true;
    },
  };
}

test("a tool request runs the registered handler and reports its result for that session", async () => {
  const bus = new LiveSessionBus();
  const log: unknown[] = [];
  bus.setSession("s1", transport(log));
  bus.registerTool("read_open_chat", (args) => ({ ok: true, echo: args.limit }));
  await bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "read_open_chat", args: { limit: 3 } });
  assert.deepEqual(log, [{ sessionId: "s1", requestId: "r1", response: { ok: true, echo: 3 } }]);
});

test("a missing or throwing handler answers with a fixed error", async () => {
  const bus = new LiveSessionBus();
  const log: Array<{ response: { error: { code: string } } }> = [];
  bus.setSession("s1", transport(log));
  await bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "nope", args: {} });
  bus.registerTool("boom", () => { throw new Error("private detail"); });
  await bus.runToolRequest({ sessionId: "s1", requestId: "r2", name: "boom", args: {} });
  assert.deepEqual(log.map((entry) => entry.response.error.code), ["tool_unavailable", "tool_failed"]);
  assert.doesNotMatch(JSON.stringify(log), /private detail/u);
});

test("a request for another session, or one cancelled while running, sends nothing", async () => {
  const bus = new LiveSessionBus();
  const log: unknown[] = [];
  bus.setSession("s1", transport(log));
  await bus.runToolRequest({ sessionId: "old", requestId: "r1", name: "x", args: {} });
  let release!: () => void;
  bus.registerTool("slow", (_args, context) => new Promise((resolve) => {
    release = () => resolve({ ok: true, aborted: context.signal.aborted });
  }));
  const running = bus.runToolRequest({ sessionId: "s1", requestId: "r2", name: "slow", args: {} });
  bus.cancelToolRequest("s1", "r2");
  release();
  await running;
  assert.deepEqual(log, []);
});

test("unregistering keeps a newer registration of the same tool", () => {
  const bus = new LiveSessionBus();
  const first = bus.registerTool("t", () => ({ ok: 1 }));
  bus.registerTool("t", () => ({ ok: 2 }));
  first();
  assert.equal(bus.hasTool("t"), true);
});

test("voice inputs get rising ids and reach every listener; notes need a session", async () => {
  const bus = new LiveSessionBus();
  const heard: Array<{ id: number; text: string }> = [];
  bus.onVoiceInput((input) => heard.push(input));
  bus.publishVoiceInput("allow");
  bus.publishVoiceInput("bye");
  assert.deepEqual(heard.map((input) => input.text), ["allow", "bye"]);
  assert.ok(heard[1]!.id > heard[0]!.id);
  assert.equal(bus.latestVoiceInputId(), heard[1]!.id);
  assert.equal(await bus.note("It finished."), false);
  const log: unknown[] = [];
  bus.setSession("s1", transport(log));
  assert.equal(await bus.note("It finished."), true);
  assert.deepEqual(log, [{ sessionId: "s1", note: "It finished." }]);
});
