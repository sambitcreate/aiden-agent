// A Bot's reply that has gone silent after its words arrived.
//
// Some provider connections deliver the whole answer and then never send their
// closing event. The person sees the finished reply, yet the Bot stays busy
// until the provider's own request timeout (10 minutes) and its retries run
// out, which can be half an hour. Once a reply's text has arrived and the
// provider then sends nothing for two minutes, the reply ends here as finished,
// with its text kept, and the stuck request is cancelled.
//
// Only a reply with words and no tool call in flight is cut loose: a silent
// tool call is left to the provider's own timeout, because ending it would
// drop the step the model asked for. Nothing is ever waited on before the
// first words, so slow starts and usage-limit waits are untouched.

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/** Silence after the reply's words before the reply is treated as finished. */
export const BOT_REPLY_SILENCE_MS = 2 * 60_000;

export interface BotReplySilenceOptions {
  silenceMs?: number;
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  /** The reply was ended here; for the log. */
  onSilenced?(message: AssistantMessage): void;
}

function hasWordsAndNoToolCall(message: AssistantMessage | undefined): message is AssistantMessage {
  if (!message) return false;
  let words = false;
  for (const block of message.content) {
    if (block.type === "toolCall") return false;
    if (block.type === "text" && block.text.trim().length > 0) words = true;
  }
  return words;
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Open one model request through `open` (with a signal this wrapper can also
 * abort) and forward its events, ending the reply as finished if it goes
 * silent after its words.
 */
export function withBotReplySilenceLimit(
  signal: AbortSignal | undefined,
  open: (signal: AbortSignal) => AssistantMessageEventStream,
  options: BotReplySilenceOptions = {},
): AssistantMessageEventStream {
  const silenceMs = options.silenceMs ?? BOT_REPLY_SILENCE_MS;
  const setTimer = options.setTimer ?? defaultTimer;
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });

  const output = createAssistantMessageEventStream();
  let latest: AssistantMessage | undefined;
  let timer: { cancel(): void } | undefined;
  let finished = false;

  const finish = () => {
    finished = true;
    timer?.cancel();
    timer = undefined;
    signal?.removeEventListener("abort", forward);
  };

  const silenced = () => {
    if (finished || !hasWordsAndNoToolCall(latest)) return;
    finish();
    const message: AssistantMessage = {
      ...latest,
      content: latest.content.filter((block) => block.type !== "toolCall"),
      stopReason: "stop",
    };
    output.push({ type: "done", reason: "stop", message });
    output.end(message);
    controller.abort();
    options.onSilenced?.(message);
  };

  const source = open(controller.signal);
  void (async () => {
    try {
      for await (const event of source) {
        if (finished) return;
        output.push(event);
        if (event.type === "done" || event.type === "error") {
          finish();
          output.end(event.type === "done" ? event.message : event.error);
          return;
        }
        latest = event.partial;
        timer?.cancel();
        timer = hasWordsAndNoToolCall(latest) ? setTimer(silenced, silenceMs) : undefined;
      }
      if (finished) return;
      finish();
      output.end();
      void source.result().then((message) => output.end(message), () => {});
    } catch (error) {
      // The request this wrapper cancelled may throw on its way out; the reply already ended.
      if (finished) return;
      finish();
      if (!latest) {
        output.end();
        return;
      }
      const message: AssistantMessage = { ...latest, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
      output.push({ type: "error", reason: "error", error: message });
      output.end(message);
    }
  })();
  return output;
}
