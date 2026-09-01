import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { selectCanonicalBotChat } from "./bot-canonical-chat.js";
import {
  createPiCompactionModels,
  PiCompactionCoordinator,
} from "./pi-compaction-core.js";
import { syncChatMessagesToPiSession } from "./pi-compaction-session-store.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Chat, ChatMeta } from "./types.js";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import type { PiSessionPort } from "./pi-session-port.js";

export type ContextLifecycleAudience =
  | { kind: "desktop"; ownerId: string }
  | { kind: "telegram"; profile: string; ownerId: string }
  | { kind: "remote"; ownerId: string };

export type ContextLifecycleSource = "operator" | "automatic-recovery";

export type CompactChatClosedReason =
  | "already_compact"
  | "busy"
  | "archived"
  | "not_canonical"
  | "provider_unavailable"
  | "context_metadata_invalid"
  | "cancelled"
  | "compaction_failed";

export type CompactChatResult =
  | {
      compacted: true;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
    }
  | { compacted: false; reason: CompactChatClosedReason };

export interface ContextLifecycleServiceDeps {
  compactionEnabled?(): boolean;
  compactionEligible?(chat: Chat): boolean | Promise<boolean>;
  getChat(chatId: string): Promise<Chat | null>;
  listChatsByBot(botId: string): Promise<readonly ChatMeta[]>;
  isBotArchived(botId: string): Promise<boolean>;
  beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
  openSession(chatId: string): Promise<PiSessionPort>;
  resolveRuntime(
    providerId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelRuntime>;
  resolveThinkingLevel(
    chat: Chat,
    audience: ContextLifecycleAudience,
    runtime: ResolvedModelRuntime,
  ): Promise<ThinkingLevel>;
  recordUsage?(
    message: AssistantMessage,
    runtime: ResolvedModelRuntime,
  ): void | Promise<void>;
}

function cancelled(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

/** Main-owned admission and model-authority boundary for persistent-chat compaction. */
export class ContextLifecycleService {
  private readonly activeCompactions = new Map<
    string,
    { controller: AbortController; ownerId: string }
  >();

  constructor(private readonly deps: ContextLifecycleServiceDeps) {}

  cancelChat(chatId: string, ownerId?: string): boolean {
    const operation = this.activeCompactions.get(chatId);
    if (!operation || (ownerId !== undefined && operation.ownerId !== ownerId)) return false;
    operation.controller.abort(new DOMException("Compaction cancelled.", "AbortError"));
    return true;
  }

  async compactChat(
    chatId: string,
    audience: ContextLifecycleAudience,
    _source: ContextLifecycleSource,
  ): Promise<CompactChatResult> {
    if (this.deps.compactionEnabled?.() === false) {
      return { compacted: false, reason: "already_compact" };
    }
    const lease = this.deps.beginChatTurn(
      chatId,
      `context-compaction:${randomUUID()}`,
      audience.ownerId,
    );
    if (!lease) return { compacted: false, reason: "busy" };
    const operationAbort = new AbortController();
    this.activeCompactions.set(chatId, {
      controller: operationAbort,
      ownerId: audience.ownerId,
    });
    lease.onReleased(() => operationAbort.abort());

    try {
      const chat = await this.deps.getChat(chatId);
      if (!chat) return { compacted: false, reason: "archived" };
      if (await this.deps.compactionEligible?.(chat) === false) {
        return { compacted: false, reason: "already_compact" };
      }
      if (!chat.providerId || !chat.model) {
        return { compacted: false, reason: "context_metadata_invalid" };
      }
      if (chat.botId) {
        if (await this.deps.isBotArchived(chat.botId)) {
          return { compacted: false, reason: "archived" };
        }
        const canonical = selectCanonicalBotChat(
          await this.deps.listChatsByBot(chat.botId),
        );
        if (canonical?.id !== chat.id) {
          return { compacted: false, reason: "not_canonical" };
        }
      }

      let runtime: ResolvedModelRuntime;
      try {
        runtime = await this.deps.resolveRuntime(
          chat.providerId,
          chat.model,
          operationAbort.signal,
        );
      } catch (cause) {
        return {
          compacted: false,
          reason: cancelled(cause) || operationAbort.signal.aborted
            ? "cancelled"
            : "provider_unavailable",
        };
      }
      if (runtime.provider.id !== chat.providerId || runtime.model.id !== chat.model) {
        return { compacted: false, reason: "context_metadata_invalid" };
      }

      const session = await this.deps.openSession(chat.id);
      await syncChatMessagesToPiSession(
        session,
        chat.messages,
        runtime.model,
        runtime.model.input.includes("image"),
      );
      const coordinator = new PiCompactionCoordinator({
        session,
        models: createPiCompactionModels(runtime, (message) =>
          this.deps.recordUsage?.(message, runtime),
        ),
        model: runtime.model,
        thinkingLevel: await this.deps.resolveThinkingLevel(chat, audience, runtime),
        signal: operationAbort.signal,
      });
      const result = await coordinator.compact();
      if (result.errorMessage) {
        return { compacted: false, reason: "compaction_failed" };
      }
      if (!result.compacted) {
        return { compacted: false, reason: "already_compact" };
      }
      const entries = await session.getBranch();
      const latest = [...entries].reverse().find((entry) => entry.type === "compaction");
      return {
        compacted: true,
        ...(latest?.type === "compaction"
          ? {
              tokensBefore: latest.tokensBefore,
            }
          : {}),
      };
    } catch (cause) {
      return {
        compacted: false,
        reason: cancelled(cause) ? "cancelled" : "compaction_failed",
      };
    } finally {
      if (this.activeCompactions.get(chatId)?.controller === operationAbort) {
        this.activeCompactions.delete(chatId);
      }
      lease.settleAsyncWork();
      lease.release();
    }
  }
}
