// Streaming generation handlers. start() returns a streamId; tokens arrive via
// "chat:delta" / "chat:done" / "chat:error" broadcasts (see llm-client).

import { ipcMain } from "@glaze/core/backend";
import { llmClient } from "../services/llm-client.js";
import type { Attachment, ChatRole, ChatStartParams } from "../services/types.js";

const ROLES: ChatRole[] = ["user", "assistant", "system"];

function parseParams(value: unknown): ChatStartParams {
  if (typeof value !== "object" || value === null) throw new Error("Invalid generation params.");
  const p = value as Record<string, unknown>;
  if (typeof p.providerId !== "string" || !p.providerId) throw new Error("Missing providerId.");
  if (typeof p.model !== "string" || !p.model) throw new Error("Missing model.");
  if (!Array.isArray(p.messages)) throw new Error("Missing messages.");
  const messages = p.messages.map((raw) => {
    const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      role: ROLES.includes(m.role as ChatRole) ? (m.role as ChatRole) : "user",
      content: typeof m.content === "string" ? m.content : "",
      attachments: Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : undefined,
    };
  });
  return {
    chatId: typeof p.chatId === "string" ? p.chatId : "",
    workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
    providerId: p.providerId,
    model: p.model,
    messages,
  };
}

function newStreamId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerChatGenerationHandlers(): void {
  // The renderer supplies a streamId so it can subscribe to delta broadcasts
  // before generation begins (no dropped opening tokens).
  ipcMain.handle("chat:start", async (_event, streamId: unknown, params: unknown) => {
    const id = typeof streamId === "string" && streamId ? streamId : newStreamId();
    await llmClient.start(id, parseParams(params));
    return { streamId: id };
  });

  ipcMain.handle("chat:cancel", async (_event, streamId: unknown) => {
    if (typeof streamId === "string") llmClient.cancel(streamId);
  });

  // Resolve a pending tool-approval request ("ask" mode).
  ipcMain.handle("chat:approve", async (_event, approvalId: unknown, decision: unknown) => {
    if (typeof approvalId !== "string" || !approvalId) return;
    llmClient.approve(approvalId, decision === "allow" ? "allow" : "deny");
  });
}
