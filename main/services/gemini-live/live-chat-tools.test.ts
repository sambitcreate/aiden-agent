import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  GEMINI_LIVE_CHAT_FLAG,
  geminiLiveChatToolsEnabled,
  liveChatToolProviderFactory,
} from "./live-chat-tools.js";
import { LIVE_TOOL_PROVIDER_FACTORIES, prepareLiveToolProviders } from "./live-tool-providers.js";
import { LiveRendererToolBroker, LiveToolRegistry, type LiveRendererToolRequest } from "./live-tools.js";

function harness(answer: (request: LiveRendererToolRequest) => Record<string, unknown> = () => ({ ok: true })) {
  const requests: LiveRendererToolRequest[] = [];
  const cancels: string[] = [];
  let broker: LiveRendererToolBroker;
  broker = new LiveRendererToolBroker("s1", (event) => {
    if (event.type === "tool_cancel") {
      cancels.push(event.requestId);
      return;
    }
    requests.push(event);
    queueMicrotask(() => broker.resolve(event.requestId, answer(event)));
  });
  const input = { owner: {} as RendererDocumentOwner, sessionId: "s1", signal: new AbortController().signal, renderer: broker };
  return { input, requests, cancels, broker };
}

test("the chat tools are offered by default and left out by the switch, the kill switch or Live's own flag", async () => {
  const { input } = harness();
  const names = (settings: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
    liveChatToolProviderFactory(input, settings, env)?.declarations.map((declaration) => declaration.name) ?? null;

  assert.deepEqual(names({}), [
    "read_open_chat",
    "send_to_open_chat",
    "stop_open_chat",
    "find_and_open_chat",
    "start_new_chat",
  ]);
  assert.equal(names({ aidenLiveChatAccess: false }), null);
  assert.equal(names({}, { [GEMINI_LIVE_CHAT_FLAG]: "0" }), null);
  assert.equal(names({}, { [GEMINI_LIVE_CHAT_FLAG]: "off" }), null);
  assert.notEqual(names({}, { [GEMINI_LIVE_CHAT_FLAG]: "true" }), null);
  assert.equal(names({}, { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0" }), null);
  assert.equal(geminiLiveChatToolsEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0", [GEMINI_LIVE_CHAT_FLAG]: "1" }), false);

  // The shipped factory list honours the switch too.
  const prepared = await prepareLiveToolProviders(input, { aidenLiveChatAccess: false }, LIVE_TOOL_PROVIDER_FACTORIES);
  assert.equal(prepared.some((provider) => provider.declarations.some((d) => d.name === "send_to_open_chat")), false);
});

test("each call runs in the window with checked, bounded arguments", async () => {
  const { input, requests } = harness((request) => ({ ok: true, echoed: request.args }));
  const provider = liveChatToolProviderFactory(input, {}, {})!;
  const registry = new LiveToolRegistry([provider], { sessionId: "s1", owner: input.owner });

  assert.deepEqual(
    await registry.dispatch({ id: "c1", name: "send_to_open_chat", args: { text: "  Run the tests  ", mode: "steer" } }),
    { ok: true, echoed: { text: "Run the tests", mode: "steer" } },
  );
  assert.deepEqual(
    await registry.dispatch({ id: "c2", name: "read_open_chat", args: { limit: 500 } }),
    { ok: true, echoed: { limit: 20 } },
  );
  assert.deepEqual(
    await registry.dispatch({ id: "c3", name: "start_new_chat", args: { workspace: "Website", text: "Hello" } }),
    { ok: true, echoed: { workspace: "Website", text: "Hello" } },
  );
  assert.deepEqual(requests.map((request) => request.name), ["send_to_open_chat", "read_open_chat", "start_new_chat"]);
});

test("bad arguments are refused in main and never reach the window", async () => {
  const { input, requests } = harness();
  const provider = liveChatToolProviderFactory(input, {}, {})!;
  const registry = new LiveToolRegistry([provider], { sessionId: "s1", owner: input.owner });
  const refusals = [
    { name: "send_to_open_chat", args: { text: "x".repeat(4_001), mode: "auto" } },
    { name: "send_to_open_chat", args: { text: "   ", mode: "auto" } },
    { name: "send_to_open_chat", args: { text: "Hi", mode: "approve" } },
    { name: "find_and_open_chat", args: { query: 42 } },
    { name: "start_new_chat", args: { workspace: "" } },
    { name: "read_open_chat", args: { limit: "many" } },
  ];
  for (const [index, call] of refusals.entries()) {
    const response = await registry.dispatch({ id: `bad-${index}`, ...call });
    assert.equal((response.error as { code: string }).code, "invalid_arguments", call.name);
  }
  assert.equal(requests.length, 0);
});

test("a cancelled call is withdrawn from the window; a lost send, stop, open or start is outcome_unknown, not cancelled", async () => {
  const requests: LiveRendererToolRequest[] = [];
  const cancels: string[] = [];
  const broker = new LiveRendererToolBroker("s1", (event) => {
    if (event.type === "tool_cancel") cancels.push(event.requestId);
    else requests.push(event);
  }, 30_000, 20);
  const input = { owner: {} as RendererDocumentOwner, sessionId: "s1", signal: new AbortController().signal, renderer: broker };
  const provider = liveChatToolProviderFactory(input, {}, {})!;
  const registry = new LiveToolRegistry([provider], { sessionId: "s1", owner: input.owner });
  const code = (response: Record<string, unknown>) => (response.error as { code: string }).code;

  const read = registry.dispatch({ id: "c1", name: "read_open_chat", args: {} });
  await new Promise((resolve) => setImmediate(resolve));
  registry.cancel("c1");
  assert.equal(code(await read), "cancelled");

  for (const [id, name, args] of [
    ["c2", "stop_open_chat", {}],
    ["c3", "send_to_open_chat", { text: "Hi", mode: "auto" }],
    ["c4", "start_new_chat", { text: "Hi" }],
    ["c5", "find_and_open_chat", { query: "Fix login" }],
  ] as const) {
    const pending = registry.dispatch({ id, name, args });
    await new Promise((resolve) => setImmediate(resolve));
    registry.cancel(id);
    // Forwarded and never answered: it may have happened, so Live must not resend.
    assert.equal(code(await pending), "outcome_unknown", name);
  }
  assert.deepEqual(cancels, requests.map((request) => request.requestId));
});
