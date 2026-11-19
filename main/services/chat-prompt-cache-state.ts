/**
 * Per-chat prompt-cache state kept in memory beside the journal: the miss
 * attribution and the side-call prefix. llm-client and the context meter
 * clear both through here, so neither outlives the prefix it describes.
 */
import { createPromptCacheTelemetry, type PromptCacheTelemetry } from "./pi-cache-telemetry.js";
import { chatSideCallPrefixes } from "./side-call-prefix.js";

/**
 * Per-chat prompt-cache miss attribution. It holds section hashes only and
 * keeps its own recent-chat bound; a dropped chat just starts fresh.
 */
export const chatPromptCacheTelemetry: PromptCacheTelemetry = createPromptCacheTelemetry();

/**
 * A completed compaction rewrote the chat's prefix on purpose: as in Pi's
 * cache stats, the next request is not counted against the old one, and no
 * side call continues the pre-compaction request.
 */
export function chatPromptPrefixCompacted(chatId: string): void {
  chatPromptCacheTelemetry.reset(chatId);
  chatSideCallPrefixes.forget(chatId);
}

/** The chat was deleted or its context profile dropped. */
export function forgetChatPromptCacheState(chatId: string): void {
  chatPromptCacheTelemetry.forget(chatId);
  chatSideCallPrefixes.forget(chatId);
}
