// How a chat picks up a reply that was cut off: by the model's output limit,
// or by a stream that dropped after the reply had started. The text written so
// far stays, and a host message asks the model to carry on from it. Tool calls
// that were cut off never run: Pi's agent loop fails them on a length stop, and
// a dropped stream's partial calls are left out of the kept text.

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

/** A reply continues at most twice; after that it ends the way it did before. */
export const MAX_CUT_OFF_CONTINUATIONS = 2;

export type CutOffReason = "output-limit" | "dropped";

export const CUT_OFF_CONTINUATION_TEXT =
  "[Aiden host guard] Your previous reply was cut off before it finished. Continue exactly where it stopped, without repeating anything already written and without any preamble.";

function hasVisibleText(content: AssistantMessage["content"]): boolean {
  return content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

/**
 * The model message to keep before continuing, or undefined when the reply
 * cannot be continued. An output-limit stop is kept as Pi recorded it when it
 * wrote text and called no tools. A dropped stream keeps only its text: its
 * thinking may lack a closing signature and its tool calls may be partial.
 */
export function keptCutOffReply(
  message: AssistantMessage,
  reason: CutOffReason,
): AssistantMessage | undefined {
  if (reason === "output-limit") {
    if (message.stopReason !== "length") return undefined;
    if (message.content.some((block) => block.type === "toolCall")) return undefined;
    return hasVisibleText(message.content) ? message : undefined;
  }
  if (message.stopReason !== "error") return undefined;
  const text = message.content.filter((block) => block.type === "text");
  if (!hasVisibleText(text)) return undefined;
  const { errorMessage: _errorMessage, ...rest } = message;
  // "length" is Pi's cut-off reply: replayed to the model, never retried.
  return { ...rest, content: text, stopReason: "length" };
}

export function cutOffContinuationMessage(timestamp: number = Date.now()): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: CUT_OFF_CONTINUATION_TEXT }],
    timestamp,
  };
}

