import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  chatMessageToPiMessage,
  chatUserTextWithAttachments,
  toPiMessages,
} from "./generation-messages.js";
import { SkillInvocationError } from "../../renderer/shared/slash-commands.js";
import {
  parseStoredPiAssistantMessage,
  storedPiAssistantMessage,
} from "./pi-message-storage.js";
import { createPiModelImageReferences } from "./pi-model-image-references.js";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  grabbedElementThumbnailId,
  type GrabbedElementContextV1,
} from "../../renderer/shared/browser-element-grab.js";

const model: Model<"openai-completions"> = {
  id: "test",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const params = {
  chatId: "chat",
  providerId: "test",
  model: "test",
  messages: [
    {
      role: "user" as const,
      content: "Inspect this.",
      attachments: [
        {
          id: "text",
          name: "note.txt",
          mimeType: "text/plain",
          kind: "text" as const,
          size: 4,
          text: "note",
        },
        {
          id: "image",
          name: "capture.png",
          mimeType: "image/png",
          kind: "image" as const,
          size: 4,
          data: "IMAGE_SENTINEL",
        },
      ],
    },
  ],
};

test("keeps images only when the generation's effective model accepts them", () => {
  const vision = toPiMessages(params, model, true)[0];
  assert.equal(vision.role, "user");
  assert.ok(Array.isArray(vision.content));
  assert.equal(
    vision.content.some((part) => part.type === "image"),
    true,
  );
  assert.equal(JSON.stringify(vision.content).includes("note.txt"), true);

  const text = toPiMessages(params, model, false)[0];
  assert.equal(text.role, "user");
  assert.ok(Array.isArray(text.content));
  assert.equal(
    text.content.some((part) => part.type === "image"),
    false,
  );
  assert.equal(JSON.stringify(text.content).includes("note.txt"), true);
  assert.equal(JSON.stringify(text.content).includes("IMAGE_SENTINEL"), false);
  assert.match(JSON.stringify(text.content), /Attached image reference: image_image \(capture\.png\)/u);
});

test("matches Pi's installed tool-result image serialization gate", () => {
  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "computer_use",
    content: [
      { type: "text" as const, text: "capture" },
      {
        type: "image" as const,
        data: "TOOL_IMAGE_SENTINEL",
        mimeType: "image/png",
      },
    ],
    details: null,
    isError: false,
    timestamp: Date.now(),
  };
  const vision = transformMessages([toolResult], model);
  assert.equal(JSON.stringify(vision).includes("TOOL_IMAGE_SENTINEL"), true);
  const textModel = { ...model, input: ["text"] as ("text" | "image")[] };
  const text = transformMessages([toolResult], textModel);
  assert.equal(JSON.stringify(text).includes("TOOL_IMAGE_SENTINEL"), false);
});

test("a shared image whose file is gone is named for the model instead of vanishing", () => {
  const message = chatMessageToPiMessage(
    {
      id: "message-lost-image",
      role: "user",
      content: "What is in this?",
      createdAt: 1,
      attachments: [
        { id: "lost", name: "receipt.png", mimeType: "image/png", kind: "image", size: 70, sha256: "e".repeat(64) },
      ],
    },
    model,
    true,
  );
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [{ type: "text", text: "What is in this?\n\n[Image unavailable: receipt.png]" }]);
});

test("journal rehydration preserves the authoritative chat timestamp", () => {
  const message = chatMessageToPiMessage(
    {
      id: "message-1",
      role: "assistant",
      content: "Persisted response",
      createdAt: 123_456,
    },
    model,
    false,
  );

  assert.equal(message.role, "assistant");
  assert.equal(message.timestamp, 123_456);
});

test("journal rehydration preserves bounded continuity for an image-only assistant reply", () => {
  const message = chatMessageToPiMessage(
    {
      id: "message-image-only",
      role: "assistant",
      content: "",
      createdAt: 123_457,
      attachments: [
        {
          id: "displayed-image",
          name: "private-name.png",
          mimeType: "image/png",
          kind: "image",
          size: 4,
          data: "PRIVATE_IMAGE_BYTES",
        },
      ],
    },
    model,
    false,
  );

  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [
    { type: "text", text: "[Assistant displayed 1 inline image.]" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(message),
    /private-name|PRIVATE_IMAGE_BYTES/iu,
  );
});

test("journal rehydration never counts a visual's snapshot as an image the assistant displayed", () => {
  const image = (id: string) => ({
    id,
    name: "visual.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: 4,
    data: "PRIVATE_IMAGE_BYTES",
  });
  const message = chatMessageToPiMessage(
    {
      id: "message-visual-only",
      role: "assistant",
      content: "",
      createdAt: 123_458,
      attachments: [image(`visual-snapshot_${"a".repeat(64)}`), image("displayed-image")],
    },
    model,
    false,
  );
  assert.deepEqual(message.content, [
    { type: "text", text: "[Assistant displayed 1 inline image.]" },
  ]);
});

test("journal rehydration preserves canonical mixed-provider Pi provenance", () => {
  const canonical = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "Provider-authored thought" },
      { type: "text" as const, text: "Historical answer" },
    ],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "claude-historical",
    responseModel: "claude-historical-2026",
    responseId: "response-historical",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 3,
      cacheWrite1h: 1,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 456,
  };
  const message = chatMessageToPiMessage(
    {
      id: "message-provenance",
      role: "assistant",
      content: "Historical answer",
      createdAt: 456,
      pi: canonical,
    },
    model,
    false,
  );
  assert.deepEqual(message, canonical);
  assert.equal(
    message.role === "assistant" ? message.provider : "",
    "anthropic",
  );
  assert.equal(
    message.role === "assistant" ? message.model : "",
    "claude-historical",
  );
});

test("stored Pi provenance rejects malformed nested provider protocol", () => {
  const valid = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 10,
  };
  assert.deepEqual(parseStoredPiAssistantMessage(valid), valid);
  for (const malformed of [
    { ...valid, provider: "" },
    { ...valid, content: [{ type: "image", data: "private" }] },
    {
      ...valid,
      content: [{ type: "toolCall", id: "", name: "read", arguments: {} }],
    },
    { ...valid, usage: {} },
    { ...valid, usage: { ...valid.usage, input: Number.NaN } },
    {
      ...valid,
      usage: { ...valid.usage, cost: { ...valid.usage.cost, total: -1 } },
    },
  ])
    assert.equal(parseStoredPiAssistantMessage(malformed), undefined);
});

test("stored Pi provenance strips raw provider errors and diagnostics", () => {
  const privateCanary = "PRIVATE_PROVIDER_ERROR_91fc";
  const failed = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "partial" }],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: privateCanary,
    diagnostics: { privateCanary },
    timestamp: 10,
  };
  assert.doesNotMatch(
    JSON.stringify(storedPiAssistantMessage(failed as never)),
    new RegExp(privateCanary, "u"),
  );
  assert.doesNotMatch(
    JSON.stringify(parseStoredPiAssistantMessage(failed)),
    new RegExp(privateCanary, "u"),
  );
});

test("an explicit invocation overrides only the exact in-memory current turn", () => {
  const persisted = {
    id: "message-2",
    role: "user" as const,
    content: "Inspect this.",
    createdAt: 234_567,
    attachments: params.messages[0]!.attachments,
  };
  const journal = chatMessageToPiMessage(persisted, model, true);
  assert.doesNotMatch(JSON.stringify(journal), /PRIVATE_SKILL_INSTRUCTIONS/u);

  const current = chatMessageToPiMessage(
    persisted,
    model,
    true,
    '<skill name="Review">PRIVATE_SKILL_INSTRUCTIONS</skill>\n\nAttached file: note.txt\n```\nnote\n```\n\nInspect this.',
  );
  const serialized = JSON.stringify(current);
  assert.match(serialized, /PRIVATE_SKILL_INSTRUCTIONS/u);
  assert.equal(serialized.match(/Attached file: note\.txt/gu)?.length, 1);
  assert.equal(serialized.includes("IMAGE_SENTINEL"), true);
  assert.ok(
    serialized.indexOf("PRIVATE_SKILL_INSTRUCTIONS") <
      serialized.indexOf("note.txt"),
  );
});

test("skill message text is rejected before aggregate attachment concatenation exceeds its budget", () => {
  assert.throws(
    () => chatUserTextWithAttachments("12345", undefined, 4),
    (error: unknown) =>
      error instanceof SkillInvocationError &&
      error.code === "instructions_too_large",
  );
  assert.throws(
    () =>
      chatUserTextWithAttachments("tail", params.messages[0]!.attachments, 30),
    (error: unknown) =>
      error instanceof SkillInvocationError &&
      error.code === "instructions_too_large",
  );
});

function sampleGrabbedElement(overrides: Partial<GrabbedElementContextV1> = {}): GrabbedElementContextV1 {
  const id = overrides.id ?? "el_hero_1";
  return {
    version: GRABBED_ELEMENT_SCHEMA_VERSION,
    id,
    label: "<LandingHeroClient />",
    framework: "react",
    componentName: "LandingHeroClient",
    componentStack: [
      {
        name: "LandingHeroClient",
        environment: "client",
        source: { filePath: "src/components/LandingHeroClient.tsx", line: 42, column: 7, symbolicated: true },
      },
      { name: "HomePage", environment: "server" },
    ],
    source: { filePath: "src/components/LandingHeroClient.tsx", line: 42, column: 7, symbolicated: true },
    props: { variant: "primary", disabled: false },
    tagName: "section",
    selector: "main > section.hero",
    htmlSnippet: '<section class="hero"><h1>Hello</h1></section>',
    boundingBox: { x: 12, y: 80, width: 960, height: 420 },
    pageUrl: "http://localhost:3000/",
    pageTitle: "Landing",
    thumbnailAttachmentId: grabbedElementThumbnailId(id),
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("grabbed elements serialize deterministically for vision and text-only models without noisy fallbacks", () => {
  const firstElement = sampleGrabbedElement({ id: "el_one", label: "<Hero />" });
  const secondElement = sampleGrabbedElement({
    id: "el_two",
    label: "button.cta",
    framework: "dom",
    componentName: undefined,
    componentStack: undefined,
    source: undefined,
    props: undefined,
    tagName: "button",
    selector: "button.cta",
  });
  const attachments = [
    {
      id: grabbedElementThumbnailId("el_two"),
      name: "button.png",
      mimeType: "image/png",
      kind: "image" as const,
      size: 4,
      data: "THUMB_TWO",
    },
    {
      id: "user-photo",
      name: "photo.png",
      mimeType: "image/png",
      kind: "image" as const,
      size: 4,
      data: "USER_PHOTO",
    },
    {
      id: grabbedElementThumbnailId("el_one"),
      name: "hero.png",
      mimeType: "image/png",
      kind: "image" as const,
      size: 4,
      data: "THUMB_ONE",
    },
  ];
  const message = {
    id: "msg-grab",
    role: "user" as const,
    content: "Tighten spacing",
    createdAt: 500,
    attachments,
    grabbedElements: [firstElement, secondElement],
  };

  // Vision model: emits <attached-browser-elements> with thumbnail notes + regular image then #1..#N thumbnails.
  const vision = chatMessageToPiMessage(message, model, true);
  assert.equal(vision.role, "user");
  assert.ok(Array.isArray(vision.content));
  const visionText = vision.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(visionText, /<attached-browser-elements>/u);
  assert.match(visionText, /## Element 1: <Hero \/>/u);
  assert.match(visionText, /## Element 2: button\.cta/u);
  assert.equal(visionText.match(/- Thumbnail: attached cropped screenshot/gu)?.length, 2);
  assert.equal(visionText.includes("1700000000000"), false, "capturedAt must never enter prompt");
  assert.equal(visionText.includes("el_one"), false, "random element id must never enter prompt");
  const visionImages = vision.content
    .filter((part) => part.type === "image")
    .map((part) => part.data);
  assert.deepEqual(visionImages, ["USER_PHOTO", "THUMB_ONE", "THUMB_TWO"]);

  // Cache stability: changing capturedAt and element/thumbnail ids yields identical prompt text.
  const reran = chatMessageToPiMessage(
    {
      ...message,
      grabbedElements: [
        { ...firstElement, id: "el_one_v2", thumbnailAttachmentId: grabbedElementThumbnailId("el_one_v2"), capturedAt: 9_999_999 },
        { ...secondElement, id: "el_two_v2", thumbnailAttachmentId: grabbedElementThumbnailId("el_two_v2"), capturedAt: 9_999_999 },
      ],
      attachments: [
        { ...attachments[0]!, id: grabbedElementThumbnailId("el_two_v2") },
        attachments[1]!,
        { ...attachments[2]!, id: grabbedElementThumbnailId("el_one_v2") },
      ],
    },
    model,
    true,
  );
  assert.ok(Array.isArray(reran.content));
  const reranText = reran.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.equal(reranText, visionText);

  // Text-only model: full structured metadata, NO thumbnail notes, NO image blocks, NO grab-thumb fallback lines.
  const textOnly = chatMessageToPiMessage(message, model, false);
  assert.equal(textOnly.role, "user");
  assert.ok(Array.isArray(textOnly.content));
  assert.equal(textOnly.content.some((part) => part.type === "image"), false);
  const textOnlyBody = textOnly.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(textOnlyBody, /<attached-browser-elements>/u);
  assert.match(textOnlyBody, /LandingHeroClient\.tsx:42:7/u);
  assert.doesNotMatch(textOnlyBody, /- Thumbnail:/u);
  assert.match(textOnlyBody, /Attached image reference: image_user-photo \(photo\.png\)/u);
  assert.doesNotMatch(textOnlyBody, /grab-thumb_/u);
  assert.doesNotMatch(textOnlyBody, /hero\.png|button\.png/u);
});

test("grabbed elements without thumbnails still serialize with empty user text and omit unavailable-image noise", () => {
  const noThumbElement = sampleGrabbedElement({ id: "el_plain", thumbnailAttachmentId: undefined });
  const textOnlyGrab = chatMessageToPiMessage(
    {
      id: "msg-no-thumb",
      role: "user",
      content: "",
      createdAt: 600,
      grabbedElements: [noThumbElement],
    },
    model,
    true,
  );
  assert.ok(Array.isArray(textOnlyGrab.content));
  assert.match(JSON.stringify(textOnlyGrab.content), /<attached-browser-elements>/u);
  assert.doesNotMatch(JSON.stringify(textOnlyGrab.content), /- Thumbnail:/u);

  const missingThumbElement = sampleGrabbedElement({ id: "el_missing_thumb" });
  const missingThumbMessage = chatMessageToPiMessage(
    {
      id: "msg-missing-thumb",
      role: "user",
      content: "Check this",
      createdAt: 601,
      grabbedElements: [missingThumbElement],
      attachments: [
        {
          id: grabbedElementThumbnailId("el_missing_thumb"),
          name: "hero.png",
          mimeType: "image/png",
          kind: "image",
          size: 42,
          sha256: "a".repeat(64),
        },
      ],
    },
    model,
    true,
  );
  const serialized = JSON.stringify(missingThumbMessage.content);
  assert.doesNotMatch(serialized, /Image unavailable/u);
  assert.doesNotMatch(serialized, /- Thumbnail:/u);
});

test("explicit skill invocation includes grabbed elements once and keeps thumbnails for vision models", () => {
  const element = sampleGrabbedElement({ id: "el_skill" });
  const thumb = {
    id: grabbedElementThumbnailId("el_skill"),
    name: "hero.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: 4,
    data: "SKILL_THUMB",
  };
  const body = chatUserTextWithAttachments("Fix alignment", [thumb], 100_000, [element]);
  assert.match(body, /<attached-browser-elements>/u);
  assert.doesNotMatch(body, /- Thumbnail:/u);
  assert.match(body, /Fix alignment/u);

  assert.throws(
    () => chatUserTextWithAttachments("Fix", [thumb], 40, [element]),
    (error: unknown) =>
      error instanceof SkillInvocationError && error.code === "instructions_too_large",
  );

  const wrappedPrompt = `<skill name="Polish">Polish UI.</skill>\n\n${body}`;
  const persisted = {
    id: "msg-skill-grab",
    role: "user" as const,
    content: "Fix alignment",
    createdAt: 700,
    attachments: [thumb],
    grabbedElements: [element],
  };

  const vision = chatMessageToPiMessage(persisted, model, true, wrappedPrompt);
  assert.ok(Array.isArray(vision.content));
  const visionText = vision.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.equal(visionText.match(/<attached-browser-elements>/gu)?.length, 1);
  assert.deepEqual(
    vision.content.filter((part) => part.type === "image").map((part) => part.data),
    ["SKILL_THUMB"],
  );

  const textOnly = chatMessageToPiMessage(persisted, model, false, wrappedPrompt);
  assert.ok(Array.isArray(textOnly.content));
  assert.equal(textOnly.content.some((part) => part.type === "image"), false);
  assert.doesNotMatch(JSON.stringify(textOnly.content), /Attached image reference/u);
});

test("model image references exclude grabbed-element thumbnails from list_image_references and resolve", async () => {
  const userImage = {
    id: "chat-photo",
    name: "photo.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: 70,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  };
  const grabThumb = {
    ...userImage,
    id: grabbedElementThumbnailId("el_1"),
    name: "LandingHeroClient.png",
  };
  const references = createPiModelImageReferences({
    snapshot: [userImage, grabThumb],
    readCurrent: async () => [userImage, grabThumb],
    generated: () => [],
  });
  const listed = await references.listImages();
  assert.deepEqual(
    listed.map((item) => item.id),
    ["chat-photo"],
  );
  await assert.rejects(
    references.resolveImage(grabThumb.id),
    /missing, changed, or does not belong/u,
  );
});
