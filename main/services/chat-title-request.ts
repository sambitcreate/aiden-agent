// The one model request behind a generated chat title, kept apart from the
// Electron wiring in chat-title.ts so its request shape can be tested.

import { normalizeContext, type AssistantMessage, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { buildChatTitlePrompt } from "./chat-title-policy.js";
import { runtimeSupportsImages } from "./generation-runtime.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { oneOffCallOptions } from "./side-call-prefix.js";
import type { Attachment } from "./types.js";

export const TITLE_TIMEOUT_MS = 15_000;

export type ChatTitleFirstMessage = Parameters<typeof buildChatTitlePrompt>[0] & {
  attachments?: Attachment[];
};

export interface RequestChatTitleOptions {
  /** Read one stored image's bytes on demand when the title model supports vision. */
  readImage?: (sha256: string, size: number) => Promise<Uint8Array | undefined>;
}

/** Sends the title request: tool-free, at most one image, and never cached. */
export async function requestChatTitle(
  runtime: Pick<ResolvedModelRuntime, "model" | "apiKey" | "headers" | "streams">,
  firstMessage: ChatTitleFirstMessage,
  signal: AbortSignal,
  options: RequestChatTitleOptions = {},
): Promise<AssistantMessage> {
  const promptContent: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: buildChatTitlePrompt(firstMessage),
    },
  ];
  const firstImage = firstMessage.attachments?.find(
    (attachment) => attachment.kind === "image" && Boolean(attachment.data || attachment.sha256),
  );
  if (runtimeSupportsImages(runtime.model) && firstImage) {
    let imageData = firstImage.data;
    if (!imageData && firstImage.sha256 && options.readImage) {
      const bytes = await options.readImage(firstImage.sha256, firstImage.size).catch(() => undefined);
      if (bytes && bytes.byteLength > 0) {
        imageData = Buffer.from(bytes).toString("base64");
      }
    }
    if (imageData) {
      promptContent.push({
        type: "image",
        data: imageData,
        mimeType: firstImage.mimeType,
      });
    }
  }
  return runtime.streams
    .streamSimple(
      runtime.model,
      normalizeContext({
        systemPrompt: "You write short, specific titles for coding conversations.",
        messages: [{ role: "user", content: promptContent, timestamp: Date.now() }],
      }),
      oneOffCallOptions({
        apiKey: runtime.apiKey,
        headers: runtime.headers,
        signal,
        temperature: 0.2,
        maxTokens: 48,
        timeoutMs: TITLE_TIMEOUT_MS,
        maxRetries: 0,
      }),
    )
    .result();
}
