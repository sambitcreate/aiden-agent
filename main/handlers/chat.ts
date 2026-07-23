// Streaming generation handlers. start() returns a streamId; tokens arrive via
// "chat:delta" / "chat:done" / "chat:error" broadcasts (see llm-client).

import { ipcMain, logger } from "../platform.js";
import { startGenerationAndMaybeTitle } from "../services/chat-generation-start.js";
import { isExplicitUserStop } from "../services/chat-cancel.js";
import { chatTitleService } from "../services/chat-title.js";
import { llmClient } from "../services/llm-client.js";
import { chatGenerationOwner } from "../services/chat-generation-owner.js";
import { parseParams } from "./chat-params.js";

// Re-exported so the IPC contract surface stays queryable from one module.
export { parseParams };

function newStreamId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerChatGenerationHandlers(): void {
  // The renderer supplies a streamId so it can subscribe to owner-bound deltas
  // before generation begins (no dropped opening tokens).
  ipcMain.handle("chat:start", async (event, streamId: unknown, params: unknown) => {
    const owner = chatGenerationOwner(event);
    const id = typeof streamId === "string" && streamId ? streamId : newStreamId();
    const parsed = parseParams(params);
    await startGenerationAndMaybeTitle(
      {
        start: (streamId, params) => llmClient.start(streamId, params, owner),
        startTitle: (input) => chatTitleService.startForFirstTurn(input),
      },
      id,
      parsed,
    );
    return { streamId: id };
  });

  ipcMain.handle("chat:cancel", async (event, streamId: unknown, origin: unknown) => {
    if (typeof streamId !== "string") return;
    const owner = chatGenerationOwner(event);
    if (llmClient.cancel(streamId, owner.documentId) && isExplicitUserStop(origin)) {
      // This structured lifecycle event is intentionally content-free. Besides
      // normal diagnostics, packaged acceptance accepts it only when the
      // renderer identifies the visible Stop control as the cancellation origin.
      logger.info("chat", JSON.stringify({ event: "renderer_user_stop", streamId }));
    }
  });

  // Resolve a pending tool-approval request ("ask" mode).
  ipcMain.handle("chat:approve", async (event, approvalId: unknown, decision: unknown) => {
    if (typeof approvalId !== "string" || !approvalId) return;
    const owner = chatGenerationOwner(event);
    if (!llmClient.approve(approvalId, decision === "allow" ? "allow" : "deny", owner.documentId)) {
      throw new Error("This renderer document does not own that approval.");
    }
  });
}
