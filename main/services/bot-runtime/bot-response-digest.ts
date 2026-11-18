import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * The digest of a provider response as the provider returned it. Pi Durable 1.5
 * stamps the requested `thinkingLevel` onto the transcript copy of each answer,
 * so the saved observation and the transcript differ only in that field; the
 * digest leaves it out so both still name the same response. A message without
 * the field digests exactly as it did before 1.5, so saved evidence stays valid.
 */
export function botResponseDigest(message: AssistantMessage): string {
  const { thinkingLevel: _harnessAnnotation, ...provider } = message;
  return createHash("sha256").update(JSON.stringify(provider)).digest("hex");
}
