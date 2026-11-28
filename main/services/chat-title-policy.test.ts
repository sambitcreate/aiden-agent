import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CHAT_IMAGES_DIRECTORY, createChatImageStore, imageSha256 } from "./chat-image-store.js";
import { createChatStore } from "./chat-store-core.js";
import { createChatTitleService } from "./chat-title-core.js";
import {
  MAX_CHAT_TITLE_LENGTH,
  assertRenameAllowedFromChat,
  buildChatRenamePrompt,
  buildChatTitlePrompt,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
  sanitizeGeneratedChatTitle,
} from "./chat-title-policy.js";
import { requestChatTitle } from "./chat-title-request.js";
import type { Attachment, ChatMessage } from "./types.js";

function attachment(kind: Attachment["kind"], name: string): Attachment {
  return {
    id: `attachment-${kind}`,
    name,
    mimeType: kind === "image" ? "image/png" : "text/plain",
    kind,
    size: 123,
  };
}

test("derives an immediate, sidebar-safe title from the first prompt", () => {
  assert.equal(
    deriveChatTitleSeed({ content: "  Fix   reconnect\n failures after restart  " }),
    "Fix reconnect failures after restart",
  );
  const long = deriveChatTitleSeed({ content: "a".repeat(80) });
  assert.equal(long.length, MAX_CHAT_TITLE_LENGTH);
  assert.ok(long.endsWith("..."));
});

test("uses attachment names when the first prompt has no text", () => {
  assert.equal(
    deriveChatTitleSeed({ content: "", attachments: [attachment("image", "dashboard.png")] }),
    "Image: dashboard.png",
  );
  assert.equal(
    deriveChatTitleSeed({ content: "", attachments: [attachment("text", "trace.txt")] }),
    "File: trace.txt",
  );
  assert.equal(deriveChatTitleSeed({ content: "" }), "New agent");
});

test("only considers the default or original seed replaceable", () => {
  assert.equal(canReplaceGeneratedChatTitle("New agent", "Investigate reconnects"), true);
  assert.equal(canReplaceGeneratedChatTitle("New Agent", "Investigate reconnects"), true);
  assert.equal(canReplaceGeneratedChatTitle("New chat", "Investigate reconnects"), true);
  assert.equal(canReplaceGeneratedChatTitle("Investigate reconnects", "Investigate reconnects"), true);
  assert.equal(canReplaceGeneratedChatTitle("Keep my title", "Investigate reconnects"), false);
});

test("normalizes plain, prefixed, JSON, and fenced title responses", () => {
  assert.equal(sanitizeGeneratedChatTitle('"Reconnect Failures After Restart."'), "Reconnect Failures After Restart");
  assert.equal(sanitizeGeneratedChatTitle("Title: Fix reconnect spinner!"), "Fix reconnect spinner");
  assert.equal(sanitizeGeneratedChatTitle('{"title":"Improve chat naming"}'), "Improve chat naming");
  assert.equal(
    sanitizeGeneratedChatTitle('```json\n{"title":"Improve chat naming"}\n```'),
    "Improve chat naming",
  );
  assert.equal(sanitizeGeneratedChatTitle("Primary title\nExtra explanation"), "Primary title");
  assert.equal(sanitizeGeneratedChatTitle("  ```  "), null);
});

test("builds the concise coding-title prompt with attachment metadata", () => {
  const prompt = buildChatTitlePrompt({
    content: "Tighten the chat sidebar",
    attachments: [attachment("image", "sidebar.png")],
  });
  assert.match(prompt, /3-8 words/);
  assert.match(prompt, /Tighten the chat sidebar/);
  assert.match(prompt, /sidebar\.png \(image\/png, 123 bytes\)/);
});

test("builds a bounded rename prompt from the original request and recent conversation", () => {
  const messages: ChatMessage[] = [
    {
      id: "system",
      role: "system",
      content: "Hidden system instructions",
      createdAt: 1,
    },
    {
      id: "user-1",
      role: "user",
      content: "Add an on-device chat rename action",
      attachments: [attachment("image", "sidebar.png")],
      createdAt: 2,
    },
    ...Array.from({ length: 10 }, (_, index): ChatMessage => ({
      id: `assistant-${index}`,
      role: "assistant",
      content: `Implementation detail ${index} 🧩 `.repeat(1_000),
      createdAt: 3 + index,
    })),
    {
      id: "user-2",
      role: "user",
      content: "Keep manual renames safe when generation finishes",
      createdAt: 20,
    },
  ];

  const prompt = buildChatRenamePrompt(messages);
  assert.match(prompt, /Add an on-device chat rename action/);
  assert.match(prompt, /Image: sidebar\.png/);
  assert.match(prompt, /Keep manual renames safe when generation finishes/);
  assert.doesNotMatch(prompt, /Hidden system instructions/);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 16_384);
});

test("renderer renames refuse a design-owned chat only when asked to", () => {
  const designChat = { owner: { kind: "design-project", projectId: "project-1" } } as const;
  assert.throws(
    () => assertRenameAllowedFromChat(designChat, { rejectFeatureOwned: true }),
    /belongs to another Aiden feature/u,
  );
  // The owning feature renames through the shared service without the option.
  assert.doesNotThrow(() => assertRenameAllowedFromChat(designChat, {}));
  assert.doesNotThrow(() => assertRenameAllowedFromChat({}, { rejectFeatureOwned: true }));
});

test("the title request is a tool-free one-off that writes no prompt cache", async () => {
  const sent: Array<{ context: { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }; options: Record<string, unknown> }> = [];
  const runtime = {
    model: {
      id: "model-a",
      name: "Model A",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    apiKey: "title-secret",
    headers: undefined,
    streams: {
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        sent.push({ context: context as never, options: options as Record<string, unknown> });
        return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Fix login" }] }) };
      },
    },
  } as unknown as Parameters<typeof requestChatTitle>[0];
  const image = { ...attachment("image", "screen.png"), data: "aGVsbG8=" };
  await requestChatTitle(runtime, { content: "Fix the login redirect", attachments: [image] }, new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.options.cacheRetention, "none");
  assert.equal(sent[0]!.options.apiKey, "title-secret");
  assert.deepEqual(sent[0]!.context.tools ?? [], []);
  const user = sent[0]!.context.messages.filter((message) => message.role === "user");
  assert.equal(user.length, 1);
  const content = user[0]!.content as Array<{ type: string }>;
  assert.deepEqual(content.map((part) => part.type), ["text", "image"]);
});

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const ONE_PIXEL_BYTES = Buffer.from(ONE_PIXEL_PNG, "base64");

function storedPngAttachment(id: string, variantByte: number): Attachment {
  const bytes = Buffer.from(ONE_PIXEL_BYTES);
  bytes[bytes.length - 1] ^= variantByte;
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    kind: "image",
    size: bytes.length,
    data: bytes.toString("base64"),
  };
}

test("chatTitleService reads zero images for Foundation Models and text models, and hydrates only the first image for vision models", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-title-images-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const rawImages = createChatImageStore(async () => root);
  const readHashes: string[] = [];
  const chatStore = createChatStore(async () => root, undefined, {
    images: {
      ...rawImages,
      read: async (sha256, size) => {
        readHashes.push(sha256);
        return rawImages.read(sha256, size);
      },
    },
  });

  let routeSetting: "apple-foundation-models" | "chat-model" = "apple-foundation-models";
  let modelInputs: Array<"text" | "image"> = ["text", "image"];
  const modelSentContent: Array<Array<{ type: string; data?: string }>> = [];
  const broadcasts: Array<{ chatId: string; title: string }> = [];

  const titleService = createChatTitleService({
    chatStore,
    configStore: {
      getSettings: async () => ({ chatTitleProviderId: routeSetting }),
    },
    foundationModelsConnection: {
      status: async () => ({
        id: "apple-foundation-models",
        label: "Apple Foundation Models",
        state: "ready",
        detail: "Ready",
        local: true,
        titleOnly: true,
        retryable: false,
      }),
      generateTitle: async () => "On-device summary title",
    },
    hostPlatformCapabilities: () => ({ appleFoundationModels: true }),
    resolveModelRuntime: async () =>
      ({
        provider: { id: "anthropic", label: "Anthropic", kind: "apiKey" },
        model: {
          id: "model-title",
          name: "Model Title",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: modelInputs,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
        apiKey: "secret",
        headers: undefined,
        streams: {
          streamSimple: (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
            const user = context.messages.find((m) => m.role === "user");
            modelSentContent.push((user?.content ?? []) as Array<{ type: string; data?: string }>);
            return {
              result: async () => ({
                role: "assistant",
                content: [{ type: "text", text: "Vision model title" }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "model-title",
                usage: {
                  input: 10,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 14,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              }),
            };
          },
        },
      }) as never,
    usageStore: { record: async () => undefined },
    broadcastMetadataUpdated: (update) => broadcasts.push({ chatId: update.chatId, title: update.title }),
    logWarn: () => undefined,
  });

  const firstImg = storedPngAttachment("img-1", 0);
  const secondImg = storedPngAttachment("img-2", 1);
  const thirdImg = storedPngAttachment("img-3", 2);
  const firstSha = imageSha256(Buffer.from(firstImg.data!, "base64"));

  const makeChatWithAttachments = (id: string, content: string, attachments: Attachment[]) =>
    chatStore.createWithFirstMessage({
      id,
      workspaceId: "workspace-1",
      title: "New agent",
      turnId: `turn-${id}`,
      fingerprint: `fp-${id}`,
      assertCurrent: () => undefined,
      message: { id: `msg-${id}`, content, attachments },
    });

  // 1. Apple Foundation Models first-turn title and manual rename read 0 stored images.
  const fmChat = await makeChatWithAttachments("fm-chat", "Review these three screenshots", [
    firstImg,
    secondImg,
    thirdImg,
  ]);
  assert.deepEqual(readHashes, []);

  titleService.startForFirstTurn({
    chatId: fmChat.id,
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn(fmChat.id);
  assert.equal((await chatStore.getWithImageReferences(fmChat.id))?.title, "On-device summary title");
  // Manually rename again after seeding a distinct title to exercise generateFoundationModelsRename.
  await chatStore.rename(fmChat.id, "Temporary manual title");
  const renameResult = await titleService.renameWithFoundationModels(fmChat.id);
  assert.equal(renameResult.title, "On-device summary title");
  assert.equal(renameResult.changed, true);
  assert.deepEqual(readHashes, [], "Foundation Models first-turn and rename read zero image files");

  // 2. Chat-model route with a text-only model reads 0 stored images.
  routeSetting = "chat-model";
  modelInputs = ["text"];
  const textModelChat = await makeChatWithAttachments("text-model-chat", "Summarize layout issue", [
    firstImg,
    secondImg,
    thirdImg,
  ]);
  titleService.startForFirstTurn({
    chatId: textModelChat.id,
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn(textModelChat.id);
  assert.deepEqual(readHashes, [], "text-only chat model reads zero image files");
  assert.deepEqual(modelSentContent[0]?.map((part) => part.type), ["text"]);

  // 3. Chat-model route with a vision model hydrates only the first image out of three.
  modelInputs = ["text", "image"];
  modelSentContent.length = 0;
  const visionChat = await makeChatWithAttachments("vision-chat", "Explain the modal alignment bug", [
    firstImg,
    secondImg,
    thirdImg,
  ]);
  titleService.startForFirstTurn({
    chatId: visionChat.id,
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn(visionChat.id);
  assert.deepEqual(readHashes, [firstSha], "vision title reads only the first image hash");
  assert.deepEqual(modelSentContent[0]?.map((part) => part.type), ["text", "image"]);
  assert.equal(modelSentContent[0]?.[1]?.data, firstImg.data);

  // 4. Missing first-image file degrades cleanly to text-only prompt after 1 read attempt.
  readHashes.length = 0;
  modelSentContent.length = 0;
  const missingImgChat = await makeChatWithAttachments("missing-img-chat", "Describe missing screenshot", [
    firstImg,
    secondImg,
  ]);
  await fs.rm(path.join(root, CHAT_IMAGES_DIRECTORY, firstSha.slice(0, 2), firstSha));
  titleService.startForFirstTurn({
    chatId: missingImgChat.id,
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn(missingImgChat.id);
  assert.deepEqual(readHashes, [firstSha]);
  assert.deepEqual(modelSentContent[0]?.map((part) => part.type), ["text"]);
  assert.ok(broadcasts.some((entry) => entry.chatId === missingImgChat.id));
});
