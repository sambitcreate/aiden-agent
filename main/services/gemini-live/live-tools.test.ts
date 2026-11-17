import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  LiveRendererToolBroker,
  LiveToolRegistry,
  type LiveToolProvider,
} from "./live-tools.js";

const owner = { id: 1, documentId: "doc" } as unknown as RendererDocumentOwner;

function provider(names: string[], handle: LiveToolProvider["handle"], extra: Partial<LiveToolProvider> = {}): LiveToolProvider {
  return { declarations: names.map((name) => ({ name, description: name })), handle, ...extra };
}

test("a call reaches the provider that declared its name", async () => {
  const seen: string[] = [];
  const registry = new LiveToolRegistry(
    [
      provider(["read_open_chat"], async (call) => {
        seen.push(`chat:${call.name}`);
        return { ok: true, title: "Fix login" };
      }),
      provider(["end_session"], async (call) => {
        seen.push(`end:${call.name}`);
        return { ok: true };
      }),
    ],
    { sessionId: "s1", owner },
  );
  assert.deepEqual(await registry.dispatch({ id: "1", name: "end_session", args: {} }), { ok: true });
  assert.deepEqual(seen, ["end:end_session"]);
  assert.deepEqual(
    registry.functionDeclarations().map((declaration) => declaration.name),
    ["read_open_chat", "end_session"],
  );
});

test("an unknown tool and a throwing provider answer with fixed errors, never the thrown text", async () => {
  const registry = new LiveToolRegistry(
    [provider(["boom"], async () => { throw new Error("/Users/secret/path"); })],
    { sessionId: "s1", owner },
  );
  const unknown = await registry.dispatch({ id: "1", name: "nope", args: {} });
  assert.equal((unknown.error as { code: string }).code, "tool_unavailable");
  const failed = await registry.dispatch({ id: "2", name: "boom", args: {} });
  assert.equal((failed.error as { code: string }).code, "tool_failed");
  assert.doesNotMatch(JSON.stringify(failed), /secret/u);
});

test("two providers may not declare the same name, and names must be snake case", () => {
  const handle = async () => ({ ok: true });
  assert.throws(() => new LiveToolRegistry([provider(["a_tool"], handle), provider(["a_tool"], handle)], { sessionId: "s", owner }));
  assert.throws(() => new LiveToolRegistry([provider(["Bad-Name"], handle)], { sessionId: "s", owner }));
});

test("cancelling a call aborts its signal and reports it as cancelled", async () => {
  let aborted = false;
  const registry = new LiveToolRegistry(
    [
      provider(["slow"], (_call, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: true });
          });
        }),
      ),
    ],
    { sessionId: "s1", owner },
  );
  const pending = registry.dispatch({ id: "c1", name: "slow", args: {} });
  registry.cancel("c1");
  const response = await pending;
  assert.equal(aborted, true);
  assert.equal((response.error as { code: string }).code, "cancelled");
});

test("closing the registry aborts in-flight calls, closes providers and refuses new calls", async () => {
  let closed = 0;
  const registry = new LiveToolRegistry(
    [
      provider(
        ["wait"],
        (_call, context) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ ok: true }))),
        { close: () => { closed += 1; } },
      ),
    ],
    { sessionId: "s1", owner },
  );
  const pending = registry.dispatch({ id: "w1", name: "wait", args: {} });
  registry.close();
  assert.equal(((await pending).error as { code: string }).code, "cancelled");
  assert.equal(closed, 1);
  const after = await registry.dispatch({ id: "w2", name: "wait", args: {} });
  assert.equal((after.error as { code: string }).code, "tool_unavailable");
});

test("the renderer broker resolves a request with the window's result exactly once", async () => {
  const sent: unknown[] = [];
  const broker = new LiveRendererToolBroker("s1", (request) => sent.push(request));
  const pending = broker.request("read_open_chat", { limit: 5 });
  const request = sent[0] as { requestId: string; name: string; args: unknown };
  assert.equal(request.name, "read_open_chat");
  assert.deepEqual(request.args, { limit: 5 });
  assert.equal(broker.resolve(request.requestId, { ok: true, title: "Fix login" }), true);
  assert.equal(broker.resolve(request.requestId, { ok: false }), false);
  assert.deepEqual(await pending, { ok: true, title: "Fix login" });
});

test("the renderer broker times out, cancels on abort, and settles everything on close", async () => {
  const sent: Array<{ type: string; requestId: string }> = [];
  const broker = new LiveRendererToolBroker("s1", (request) => sent.push(request), 20);
  const timedOut = await broker.request("slow", {});
  assert.equal((timedOut.error as { code: string }).code, "timeout");

  const abort = new AbortController();
  const cancelled = broker.request("slow", {}, abort.signal);
  abort.abort();
  assert.equal(((await cancelled).error as { code: string }).code, "cancelled");
  assert.ok(sent.some((entry) => entry.type === "tool_cancel"));

  const open = broker.request("slow", {});
  broker.close();
  assert.equal(((await open).error as { code: string }).code, "cancelled");
  const afterClose = await broker.request("slow", {});
  assert.equal((afterClose.error as { code: string }).code, "cancelled");
});

test("a non-object renderer result becomes a fixed failure", async () => {
  const sent: Array<{ requestId: string }> = [];
  const broker = new LiveRendererToolBroker("s1", (request) => sent.push(request as { requestId: string }));
  const pending = broker.request("x", {});
  broker.resolve(sent[0]!.requestId, ["not", "an", "object"]);
  assert.equal(((await pending).error as { code: string }).code, "tool_failed");
});

test("a timeout tells the window to cancel too, so a late request cannot still act", async () => {
  const sent: Array<{ type: string; requestId: string }> = [];
  const broker = new LiveRendererToolBroker("s1", (request) => sent.push(request), 20);
  const timedOut = await broker.request("read_open_chat", {});
  assert.equal((timedOut.error as { code: string }).code, "timeout");
  assert.deepEqual(sent.map((entry) => entry.type), ["tool_request", "tool_cancel"]);
  assert.equal(sent[1]!.requestId, sent[0]!.requestId);
});

test("a mutating request the window already has reports its real outcome, or outcome_unknown, never cancelled", async () => {
  const sent: Array<{ type: string; requestId: string }> = [];
  const broker = new LiveRendererToolBroker("s1", (request) => sent.push(request), 20, 30);
  // Timed out, and the window never answers: it may have gone through.
  const lost = await broker.request("send_to_open_chat", { text: "Hi" }, undefined, { mutating: true });
  assert.equal((lost.error as { code: string }).code, "outcome_unknown");
  assert.equal(lost.committed, true);
  assert.equal(sent.filter((entry) => entry.type === "tool_cancel").length, 1);

  // Cancelled while the window was sending: its answer after the cancel is the outcome.
  const abort = new AbortController();
  const sending = broker.request("send_to_open_chat", { text: "Hi" }, abort.signal, { mutating: true });
  abort.abort();
  const lastRequest = () => sent.filter((entry) => entry.type === "tool_request").reverse()[0]!;
  const request = lastRequest();
  broker.resolve(request.requestId, { ok: true, status: "sent" });
  assert.deepEqual(await sending, { ok: true, status: "sent", committed: true });

  // The window had not started it: its own "cancelled" stands.
  const early = new AbortController();
  const notStarted = broker.request("send_to_open_chat", { text: "Hi" }, early.signal, { mutating: true });
  early.abort();
  const second = lastRequest();
  broker.resolve(second.requestId, { ok: false, error: { code: "cancelled", message: "The request was cancelled." } });
  assert.equal(((await notStarted).error as { code: string }).code, "cancelled");

  // Cancelled before it ever reached the window: plainly cancelled.
  const before = new AbortController();
  before.abort();
  const never = await broker.request("send_to_open_chat", {}, before.signal, { mutating: true });
  assert.equal((never.error as { code: string }).code, "cancelled");
});

test("the registry reports a committed result even when the call was cancelled meanwhile", async () => {
  const registry = new LiveToolRegistry(
    [
      provider(["send"], (_call, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener("abort", () => resolve({ ok: true, status: "sent", committed: true }));
        }),
      ),
    ],
    { sessionId: "s1", owner },
  );
  const pending = registry.dispatch({ id: "c1", name: "send", args: {} });
  registry.cancel("c1");
  assert.deepEqual(await pending, { ok: true, status: "sent", committed: true });
});
