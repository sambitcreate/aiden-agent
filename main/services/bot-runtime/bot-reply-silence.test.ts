import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { BOT_REPLY_SILENCE_MS, withBotReplySilenceLimit } from "./bot-reply-silence.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "pending"): AssistantMessage {
  return {
    role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  } as AssistantMessage;
}

function setup() {
  const source = createAssistantMessageEventStream();
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const silenced: AssistantMessage[] = [];
  let sourceSignal!: AbortSignal;
  const outer = new AbortController();
  const output = withBotReplySilenceLimit(outer.signal, (signal) => { sourceSignal = signal; return source; }, {
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    onSilenced: (m) => silenced.push(m),
  });
  const seen: AssistantMessageEvent[] = [];
  const reading = (async () => { for await (const event of output) seen.push(event); })();
  const live = () => timers.filter((timer) => !timer.cancelled);
  const send = async (event: AssistantMessageEvent) => { source.push(event); await flush(); };
  return { source, output, seen, reading, live, send, silenced, outer, signal: () => sourceSignal };
}

const words = message([{ type: "text", text: "Here's where things stand." }]);

test("a reply that goes quiet after its words ends as finished, keeps its text, and cancels the stuck request", async () => {
  const h = setup();
  await h.send({ type: "start", partial: message([]) });
  assert.deepEqual(h.live(), [], "nothing is timed before the first words");
  await h.send({ type: "text_delta", contentIndex: 0, delta: "Here's where things stand.", partial: words });
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0]!.ms, BOT_REPLY_SILENCE_MS);
  h.live()[0]!.fn();
  await h.reading;
  const last = h.seen[h.seen.length - 1]!;
  assert.equal(last.type, "done");
  const result = await h.output.result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, words.content, "the words the person saw are the reply");
  assert.equal(h.signal().aborted, true, "the stuck request is cancelled");
  assert.equal(h.silenced.length, 1);
  // A late event from the cancelled request changes nothing.
  h.source.push({ type: "text_delta", contentIndex: 0, delta: " more", partial: words });
  assert.equal(h.seen.length, 3);
});

test("a reply that finishes on its own passes through untouched and leaves no timer", async () => {
  const h = setup();
  await h.send({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: words });
  const done = message(words.content, "stop");
  await h.send({ type: "done", reason: "stop", message: done });
  h.source.end();
  await h.reading;
  assert.deepEqual(h.live(), []);
  assert.equal((await h.output.result()).stopReason, "stop");
  assert.equal(h.signal().aborted, false);
  assert.deepEqual(h.silenced, []);
});

test("a tool call being written is never cut off, however quiet", async () => {
  const h = setup();
  await h.send({ type: "text_delta", contentIndex: 0, delta: "Let me check.", partial: words });
  await h.send({
    type: "toolcall_start", contentIndex: 1,
    partial: message([...words.content, { type: "toolCall", id: "t1", name: "read", arguments: {} }]),
  });
  assert.deepEqual(h.live(), [], "the quiet timer stops once a tool call is in flight");
  h.outer.abort();
  assert.equal(h.signal().aborted, true, "the person's Stop still reaches the request");
});
