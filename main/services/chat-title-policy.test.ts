import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHAT_TITLE_LENGTH,
  buildChatRenamePrompt,
  buildChatTitlePrompt,
  canReplaceGeneratedChatTitle,
  deriveChatTitleSeed,
  sanitizeGeneratedChatTitle,
} from "./chat-title-policy.js";
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
  assert.equal(deriveChatTitleSeed({ content: "" }), "New chat");
});

test("only considers the default or original seed replaceable", () => {
  assert.equal(canReplaceGeneratedChatTitle("New chat", "Investigate reconnects"), true);
  assert.equal(canReplaceGeneratedChatTitle("New Chat", "Investigate reconnects"), true);
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
