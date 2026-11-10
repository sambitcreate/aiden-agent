import type { LiveToolPrepareInput, LiveToolProvider } from "./live-tools.js";

/** The Live tool that ends the conversation when the user says goodbye. */
export const LIVE_END_SESSION_TOOL = "end_session";

const INSTRUCTION =
  "Call end_session only when the user clearly wants to end this conversation, for example by saying goodbye, bye, that's all or stop listening. Say one short goodbye first, then call it. Never call it for a pause, a question or thanks in the middle of a task.";

/**
 * Ends the Live session after Live's goodbye. The attended window runs the
 * tool: it lets the goodbye finish playing (bounded), then stops the session,
 * so main only forwards the call. The user talking over the goodbye cancels it.
 */
export function createEndSessionToolProvider(input: Pick<LiveToolPrepareInput, "renderer">): LiveToolProvider {
  const pending = new Set<AbortController>();
  return {
    declarations: [
      {
        name: LIVE_END_SESSION_TOOL,
        description:
          "Ends this Live conversation after your goodbye has played. Use only when the user clearly wants to stop talking.",
        parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    instructions: [INSTRUCTION],
    async handle(_call, context) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) abort.abort();
      pending.add(abort);
      try {
        // No arguments are forwarded: the window needs none, and Gemini's
        // arguments are untrusted.
        return await input.renderer.request(LIVE_END_SESSION_TOOL, {}, abort.signal);
      } finally {
        pending.delete(abort);
        context.signal.removeEventListener("abort", cancel);
      }
    },
    interrupt() {
      // The user spoke over the goodbye: they are not done yet.
      for (const abort of pending) abort.abort();
    },
    close() {
      for (const abort of pending) abort.abort();
      pending.clear();
    },
  };
}

