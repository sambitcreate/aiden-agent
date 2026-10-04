import assert from "node:assert/strict";
import test from "node:test";
import { projectAidenRemoteChatMessagesWindow } from "../../../main/services/aiden-remote-chats";
import type { Chat, ChatMessage } from "../types";
import {
  emptyRemoteTranscript,
  mapRemoteChat,
  mapRemoteMessage,
  mapRemoteMessagesWindow,
  mergeNewestWindow,
  mergeOlderWindow,
  type RemoteTranscript,
} from "./remote-chat-mapper";

const timeline = {
  version: 3 as const,
  generationId: "gen-1",
  status: "completed" as const,
  startedAt: 1_000,
  finishedAt: 2_000,
  steps: [
    {
      id: "tool-1",
      order: 0,
      kind: "tool" as const,
      toolCallId: "call-1",
      toolName: "read_file",
      label: "Read file",
      status: "completed" as const,
      startedAt: 1_000,
      updatedAt: 2_000,
      finishedAt: 2_000,
      contentOffset: 0,
      target: "README.md",
    },
  ],
};

function hostChat(messages: ChatMessage[]): Chat {
  return { id: "chat-1", title: "Release notes", createdAt: 1, updatedAt: 2, workspaceId: "ws", messages };
}

function numbered(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${index}`,
    createdAt: 1_000 + index,
  }));
}

/** A window exactly as the host serves it, mapped back on this Mac. */
function served(messages: ChatMessage[], input: { before?: string; limit: number }) {
  return mapRemoteMessagesWindow(
    JSON.parse(JSON.stringify(projectAidenRemoteChatMessagesWindow(hostChat(messages), input))),
  );
}

test("a host message survives projection and mapping with what the transcript can render", () => {
  const original: ChatMessage[] = [
    {
      id: "u1",
      role: "user",
      content: "Summarise the README",
      createdAt: Date.UTC(2026, 9, 1, 9, 30),
      attachments: [
        { id: "a1", name: "notes.txt", mimeType: "text/plain", kind: "text", size: 12, text: "secret body" },
      ],
    },
    {
      id: "a1",
      role: "assistant",
      content: "Done",
      reasoning: "Read it first",
      createdAt: Date.UTC(2026, 9, 1, 9, 31),
      timeline,
      htmlArtifacts: [
        { version: 1, kind: "html", id: "art-1", title: "Chart", mimeType: "text/html", size: 10, mediaId: "media-1" },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      content: "",
      createdAt: Date.UTC(2026, 9, 1, 9, 32),
      providerFailure: { version: 1, category: "rate_limit", attempts: 3, retryExhausted: true },
    },
  ];

  const window = served(original, { limit: 50 });

  assert.equal(window.chatId, "chat-1");
  assert.equal(window.hasOlder, false);
  assert.deepEqual(
    window.messages.map((message) => [message.id, message.role, message.content, message.createdAt]),
    original.map((message) => [message.id, message.role, message.content, message.createdAt]),
  );
  // Attachment chips keep their metadata; the bytes never cross.
  const [chip] = window.messages[0]?.attachments ?? [];
  assert.equal(chip?.name, "notes.txt");
  assert.equal(chip?.size, 12);
  assert.equal(chip?.text, undefined);
  assert.equal(chip?.data, undefined);
  assert.equal(window.messages[1]?.reasoning, "Read it first");
  assert.equal(window.messages[1]?.timeline?.steps[0]?.kind, "tool");
  // HTML artifact frames resolve local media, so remote artifacts are not rendered.
  assert.equal(window.messages[1]?.htmlArtifacts, undefined);
  assert.deepEqual(window.messages[2]?.providerFailure, original[2]?.providerFailure);
});

test("rows the transcript cannot render are skipped and malformed pages are rejected", () => {
  assert.equal(mapRemoteMessage({ id: "x", role: "system", text: "hi", createdAt: "2026-10-01T00:00:00Z" }), null);
  assert.equal(mapRemoteMessage({ id: "x", role: "user", text: "hi", createdAt: "not a date" }), null);
  assert.equal(mapRemoteMessage(null), null);
  // A failure outcome that breaks the closed schema is dropped, not guessed.
  const message = mapRemoteMessage({
    id: "x",
    role: "assistant",
    text: "",
    createdAt: "2026-10-01T00:00:00Z",
    outcome: { status: "failed", category: "made_up", attempts: 1, retryExhausted: false },
  });
  assert.equal(message?.providerFailure, undefined);
  assert.throws(() => mapRemoteMessagesWindow({ chatId: "c", messages: [] }), /unreadable/);
});

test("a summary row or chat projection maps to a chat with no transcript of its own", () => {
  const chat = mapRemoteChat({
    id: "chat-9",
    workspaceId: "ws-1",
    title: "  ",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    messages: [{ id: "m", role: "user", text: "ignored", createdAt: "2026-10-01T00:00:00.000Z" }],
  });
  assert.equal(chat?.title, "Remote chat");
  assert.equal(chat?.workspaceId, "ws-1");
  assert.equal(chat?.updatedAt, Date.UTC(2026, 9, 2));
  assert.deepEqual(chat?.messages, []);
  assert.equal(mapRemoteChat({ title: "no id" }), null);
});

test("a large chat is read newest first and paged back to the beginning without gaps", () => {
  const all = numbered(130);
  let transcript: RemoteTranscript = mergeNewestWindow(emptyRemoteTranscript("chat-1"), served(all, { limit: 50 }));
  assert.equal(transcript.messages.length, 50);
  assert.equal(transcript.messages[transcript.messages.length - 1]?.id, "m129");
  assert.equal(transcript.hasOlder, true);

  while (transcript.hasOlder) {
    const before = transcript.messages[0]!.id;
    transcript = mergeOlderWindow(transcript, served(all, { before, limit: 50 }));
  }
  assert.deepEqual(
    transcript.messages.map((message) => message.id),
    all.map((message) => message.id),
  );
});

test("refreshing the newest window keeps older pages it still overlaps", () => {
  const all = numbered(80);
  let transcript = mergeNewestWindow(emptyRemoteTranscript("chat-1"), served(all, { limit: 50 }));
  transcript = mergeOlderWindow(transcript, served(all, { before: transcript.messages[0]!.id, limit: 50 }));
  assert.equal(transcript.messages.length, 80);

  // Two new turns land on the host; the newest window still overlaps what is loaded.
  const grown = numbered(82);
  transcript = mergeNewestWindow(transcript, served(grown, { limit: 50 }));
  assert.deepEqual(
    transcript.messages.map((message) => message.id),
    grown.map((message) => message.id),
  );
  assert.equal(transcript.hasOlder, false);
});

test("a newest window that no longer overlaps replaces the transcript", () => {
  const all = numbered(60);
  let transcript = mergeNewestWindow(emptyRemoteTranscript("chat-1"), served(all, { limit: 10 }));
  // The host's chat was rewritten (for example, older turns removed and new ones added).
  const rewritten = numbered(5).map((message) => ({ ...message, id: `r${message.id}` }));
  transcript = mergeNewestWindow(transcript, served(rewritten, { limit: 10 }));
  assert.deepEqual(
    transcript.messages.map((message) => message.id),
    rewritten.map((message) => message.id),
  );
  assert.equal(transcript.hasOlder, false);

  transcript = mergeNewestWindow(transcript, served([], { limit: 10 }));
  assert.deepEqual(transcript.messages, []);
});
