// Anthropic message threads stay off in Aiden.
//
// Since pi-ai 1.5.1 an Anthropic request with a session ID continues a
// server-side thread and sends only the new messages, on by default for the
// `anthropic` provider on api.anthropic.com. Aiden keeps 1.4.0's behavior, a
// full request every time, until threads are evaluated against its replay
// gate: every request then carries the whole transcript Aiden assembled, and
// no server-side thread state outlives the chat that made it.

import type { Api, Model } from "@earendil-works/pi-ai";

/** The same model with Anthropic message threads turned off; other APIs are returned as they are. */
export function withoutMessageThreads<T extends Model<Api>>(model: T): T {
  if (model.api !== "anthropic-messages") return model;
  const anthropic = model as Model<"anthropic-messages">;
  if (anthropic.compat?.supportsMessageThreads === false) return model;
  return { ...anthropic, compat: { ...anthropic.compat, supportsMessageThreads: false } } as unknown as T;
}
