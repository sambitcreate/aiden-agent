// Aiden-owned session operations exposed to Telegram controls.
//
// This is deliberately not a Pi extension adapter: Aiden owns the chat,
// provider connection, Pi journal, and cancellation lifecycle.

import type { GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import { resolveGenerationThinkingLevel } from "../generation-runtime.js";
import {
  createPiCompactionModels,
  PiCompactionCoordinator,
} from "../pi-compaction-core.js";
import { syncChatMessagesToPiSession } from "../pi-compaction-session-store.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import type { ChatMessage, StoredProvider } from "../types.js";

export interface TelegramCompactionDeps {
  getChat(chatId: string): Promise<{ messages: readonly ChatMessage[] } | null>;
  openSession(chatId: string): Promise<
    import("@earendil-works/pi-agent-core").Session<
      import("@earendil-works/pi-agent-core").JsonlSessionMetadata
    >
  >;
  resolveProvider(): Promise<{
    providerId: string;
    model: string;
    provider: StoredProvider;
  } | null>;
  resolveRuntime(
    providerId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelRuntime>;
  resolveThinkingLevel(): Promise<GenerationThinkingLevel | undefined>;
}

export interface TelegramCompactionResult {
  compacted: boolean;
  error?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

/** Compact an idle Telegram-backed Aiden chat using Pi's native journal path. */
export async function compactTelegramSession(
  deps: TelegramCompactionDeps,
  chatId: string,
): Promise<TelegramCompactionResult> {
  const [chat, provider] = await Promise.all([deps.getChat(chatId), deps.resolveProvider()]);
  if (!chat) return { compacted: false, error: "This Telegram session has no chat history yet." };
  if (!provider) return { compacted: false, error: "No provider is configured." };

  const runtime = await deps.resolveRuntime(provider.providerId, provider.model);
  const session = await deps.openSession(chatId);
  await syncChatMessagesToPiSession(
    session,
    chat.messages,
    runtime.model,
    runtime.model.input.includes("image"),
  );
  const thinkingLevel = resolveGenerationThinkingLevel(
    provider.providerId,
    runtime.model,
    await deps.resolveThinkingLevel(),
  );
  const coordinator = new PiCompactionCoordinator({
    session,
    models: createPiCompactionModels(runtime),
    model: runtime.model,
    thinkingLevel,
  });
  const result = await coordinator.compact();
  if (result.errorMessage) return { compacted: false, error: result.errorMessage };
  if (!result.compacted) {
    return { compacted: false, error: "The session is already compact enough." };
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
}
