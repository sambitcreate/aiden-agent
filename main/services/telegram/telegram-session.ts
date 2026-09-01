import type { CompactChatResult } from "../context-lifecycle-service.js";

export interface TelegramCompactionResult {
  compacted: boolean;
  error?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

const CLOSED_REASON_COPY: Record<
  Exclude<CompactChatResult, { compacted: true }>["reason"],
  string
> = {
  already_compact: "The session is already compact enough.",
  busy: "Wait for the active turn to finish or abort it first.",
  archived: "This session is archived or no longer available.",
  not_canonical: "This legacy Bot conversation is read-only.",
  provider_unavailable: "The saved provider is unavailable.",
  context_metadata_invalid: "The saved model context is invalid.",
  cancelled: "Compaction was cancelled.",
  compaction_failed: "Compaction failed.",
};

/** Convert the content-free lifecycle result into Telegram-owned presentation copy. */
export function telegramCompactionResult(result: CompactChatResult): TelegramCompactionResult {
  return result.compacted
    ? result
    : { compacted: false, error: CLOSED_REASON_COPY[result.reason] };
}
