// Streaming generation handlers. start() returns a streamId; tokens arrive via
// "chat:delta" / "chat:done" / "chat:error" broadcasts (see llm-client).

import { ipcMain, logger } from "../platform.js";
import { desktopChatExecutionOptions, startGenerationAndMaybeTitle } from "../services/chat-generation-start.js";
import { isExplicitUserStop, parseChatCancelOrigin } from "../services/chat-cancel.js";
import { chatTitleService } from "../services/chat-title.js";
import { configStore } from "../services/config-store.js";
import { llmClient } from "../services/llm-client.js";
import { chatGenerationOwner } from "../services/chat-generation-owner.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import { parseChatRunInput } from "../../renderer/shared/chat-run-input.js";
import type { AskUserQuestionAnswerStatus } from "../../renderer/shared/ask-user-question.js";
import { parseParams } from "./chat-params.js";
import { geminiLiveService } from "../services/gemini-live/service-main.js";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../../renderer/shared/chat-message-contract.js";
import { parseToolApprovalScope } from "../../renderer/shared/tool-approval-scope.js";
import { toolApprovalRules } from "../services/tool-approval-rules-main.js";

// Re-exported so the IPC contract surface stays queryable from one module.
export { parseParams };

function newStreamId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerChatGenerationHandlers(): void {
  // The renderer supplies a streamId so it can subscribe to owner-bound deltas
  // before generation begins (no dropped opening tokens).
  ipcMain.handle(
    "chat:start",
    async (event, streamId: unknown, params: unknown, messageTurnId: unknown) => {
      const owner = chatGenerationOwner(event);
      const id = streamId === undefined ? newStreamId() : streamId;
      if (!isSafeSubagentIdentifier(id)) {
        throw new Error("Invalid chat stream identifier.");
      }
      if (!isSafeSubagentIdentifier(messageTurnId)) {
        throw new Error("Invalid chat message turn identifier.");
      }
      const parsed = parseParams(params);
      let accepted = false;
      try {
        const started = await startGenerationAndMaybeTitle(
          {
            start: (streamId, params) =>
              llmClient.start(
                streamId,
                params,
                owner,
                desktopChatExecutionOptions(messageTurnId, () => { accepted = true; }),
              ),
            startTitle: (input) => chatTitleService.startForFirstTurn(input),
            rememberSelection: (providerId, model) => {
              void configStore
                .setSettings({ lastProviderId: providerId, lastModel: model })
                .catch(() => undefined);
            },
          },
          id,
          parsed,
        );
        return { streamId: id, accepted, started };
      } catch (error) {
        if (!accepted) throw error;
        return {
          streamId: id,
          accepted: true,
          started: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("chat:cancel", async (event, streamId: unknown, origin: unknown) => {
    if (!isSafeSubagentIdentifier(streamId)) {
      throw new Error("Invalid chat stream identifier.");
    }
    const parsedOrigin = parseChatCancelOrigin(origin);
    if (!parsedOrigin) {
      throw new Error("Invalid chat cancellation origin.");
    }
    const owner = chatGenerationOwner(event);
    if (parsedOrigin === "lifecycle") {
      if (llmClient.detachRenderer(streamId, owner.documentId)) {
        logger.info("chat", JSON.stringify({ event: "renderer_lifecycle_detached", streamId }));
      }
      return;
    }
    const cancelled = llmClient.cancel(streamId, "user_stop", owner.documentId);
    if (cancelled && isExplicitUserStop(parsedOrigin)) {
      // This structured lifecycle event is intentionally content-free. Besides
      // normal diagnostics, packaged acceptance accepts it only when the
      // renderer identifies the visible Stop control as the cancellation origin.
      logger.info("chat", JSON.stringify({ event: "renderer_user_stop", streamId }));
    }
    return cancelled;
  });

  // Shared foreground admission for mid-flight input (Remote Slice 2). The
  // Remote API inputs route reaches the same Mac-owned boundary; the renderer
  // document must own the generation just like chat:cancel.
  ipcMain.handle(
    "chat:admitRunInput",
    async (event, streamId: unknown, input: unknown) => {
      if (!isSafeSubagentIdentifier(streamId)) {
        throw new Error("Invalid chat stream identifier.");
      }
      const parsed = parseChatRunInput(input);
      const owner = chatGenerationOwner(event);
      const result = await llmClient.admitChatRunInput({
        streamId,
        mode: parsed.mode,
        text: parsed.text,
        ownerDocumentId: owner.documentId,
      });
      // A committed input mutates the transcript for every observing document,
      // matching the remote path's chats:changed broadcast.
      if (result.committed) {
        ipcMain.broadcast("chats:changed", {});
      }
      return result;
    },
  );
  ipcMain.handle("chat:steer", async (event, streamId: unknown, instruction: unknown) => {
    if (!isSafeSubagentIdentifier(streamId) || typeof instruction !== "string" ||
        !instruction.trim() ||
        new TextEncoder().encode(instruction).byteLength > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
      throw new Error("Invalid chat guidance.");
    }
    const owner = chatGenerationOwner(event);
    if (!llmClient.steer(streamId, instruction.trim(), owner.documentId)) {
      throw new Error("This response can no longer accept guidance. Your draft is still here.");
    }
    return { status: "queued" as const };
  });

  // Resolve a pending tool-approval request ("ask" mode).
  ipcMain.handle(
    "chat:approve",
    async (event, approvalId: unknown, decision: unknown, options: unknown) => {
      if (typeof approvalId !== "string" || !approvalId) return;
      const owner = chatGenerationOwner(event);
      const allowed = decision === "allow";
      const formFillExcludedOrders = Array.isArray(
        (options as { formFillExcludedOrders?: unknown } | null)?.formFillExcludedOrders,
      )
        ? (options as { formFillExcludedOrders: unknown[] }).formFillExcludedOrders.filter(
            (order): order is number => Number.isSafeInteger(order),
          )
        : undefined;
      const scope = allowed
        ? parseToolApprovalScope((options as { scope?: unknown } | null)?.scope)
        : undefined;
      if (
        !llmClient.approve(approvalId, allowed ? "allow" : "deny", owner.documentId, {
          formFillExcludedOrders,
          ...(scope ? { scope } : {}),
        }) &&
        !geminiLiveService.approveComputerUse(owner, approvalId, allowed)
      ) {
        throw new Error("This renderer document does not own that approval.");
      }
    },
  );

  // Remembered "always allow" tool approval rules (Settings → Tool approvals).
  ipcMain.handle("chat:listApprovalRules", async () => toolApprovalRules.list());

  ipcMain.handle("chat:revokeApprovalRule", async (_event, ruleId: unknown) => {
    if (typeof ruleId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(ruleId)) {
      throw new Error("Invalid approval rule.");
    }
    return { revoked: await toolApprovalRules.revoke(ruleId) };
  });

  ipcMain.handle("chat:revokeAllApprovalRules", async () => ({
    revoked: await toolApprovalRules.revokeAll(),
  }));

  ipcMain.handle(
    "chat:answerQuestionnaire",
    async (
      event,
      promptId: unknown,
      response: unknown,
    ): Promise<{ status: AskUserQuestionAnswerStatus } | undefined> => {
      if (typeof promptId !== "string" || !promptId) return undefined;
      const owner = chatGenerationOwner(event);
      const outcome = llmClient.answerQuestionnaireWithOutcome(
        promptId,
        response,
        owner.documentId,
      );
      if (outcome === "rejected") {
        throw new Error("This renderer document does not own that questionnaire.");
      }
      // "expired" tells the renderer the agent already moved on, so it can
      // offer the answer as a follow-up message instead of losing it.
      return { status: outcome };
    },
  );
}
