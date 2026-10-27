// A chat whose last reply was still running when Aiden quit or crashed. The
// runtime records every foreground run as an operation: a crash leaves it
// running and the next launch marks it interrupted, and a quit finishes it as
// interrupted. Stop, a finished reply or a new message records a later
// operation, so the chat stops offering Resume. Aiden never resumes on its own.

import type { DurablePiRuntimeOperation } from "./pi-runtime-effect-core.js";

export async function chatReplyInterrupted(
  store: { listOperationsByChat(chatId: string): Promise<DurablePiRuntimeOperation[]> },
  chatId: string,
): Promise<boolean> {
  let latest: DurablePiRuntimeOperation | undefined;
  for (const operation of await store.listOperationsByChat(chatId)) {
    // Subagent runs record their own operations under the parent chat.
    if (operation.lane !== "foreground") continue;
    if (!latest || operation.startedAt >= latest.startedAt) latest = operation;
  }
  return latest?.state === "interrupted";
}
