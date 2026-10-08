import { isToolStep, type GenerationTimeline } from "../../shared/generation-timeline";

export interface BotReplyProjection {
  /** The answer shown as the Bot's bubble. */
  finalText: string;
  /** Narration written before the last tool call, folded into "Updates". */
  progressText: string;
}

/**
 * Splits a Bot reply the way Aiden On The Go does (`AidenBotReplyProjection`
 * on iOS): text written before the last tool call is progress, and only what
 * follows it is the answer. While the reply is still running nothing is final
 * yet, so all text so far is progress.
 */
export function resolveBotReplyProjection(
  text: string,
  timeline: GenerationTimeline | null | undefined,
  isActive: boolean,
): BotReplyProjection {
  const cleaned = text.trim();
  if (!cleaned) return { finalText: "", progressText: "" };
  if (isActive) return { finalText: "", progressText: deduplicatedProgress(text) };
  const offsets = (timeline?.steps ?? [])
    .filter(isToolStep)
    .map((step) => step.contentOffset)
    .filter((offset): offset is number => Number.isSafeInteger(offset));
  if (offsets.length === 0) return { finalText: cleaned, progressText: "" };
  const boundary = Math.max(...offsets);
  if (boundary < 0 || boundary > text.length) return { finalText: cleaned, progressText: "" };
  // Never split a surrogate pair: back up to the start of the code point.
  const unit = text.charCodeAt(boundary);
  const split = boundary > 0 && unit >= 0xdc00 && unit <= 0xdfff ? boundary - 1 : boundary;
  return {
    finalText: text.slice(split).trim(),
    progressText: deduplicatedProgress(text.slice(0, split)),
  };
}

/** Drops repeated paragraphs, comparing them with whitespace collapsed. */
function deduplicatedProgress(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const paragraph of text.split("\n\n")) {
    const cleaned = paragraph.trim();
    if (!cleaned) continue;
    const identity = cleaned.split(/\s+/u).join(" ");
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(cleaned);
  }
  return kept.join("\n\n");
}
