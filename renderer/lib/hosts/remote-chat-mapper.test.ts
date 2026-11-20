import assert from "node:assert/strict";
import test from "node:test";
import { projectAidenRemoteChatMessagesWindow } from "../../../main/services/aiden-remote-chats";
import { compileAum } from "../../shared/aiden-ui/compile";
import type { AidenUiNodeV1, ChatUiVisualV1 } from "../../shared/aiden-ui/types";
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

function drawnLines(node: AidenUiNodeV1): string[] {
  if (node.t === "#text") return [node.s ?? ""];
  const own = (node.c ?? []).flatMap(drawnLines);
  return node.t === "Text" ? [own.join("")] : own;
}

function components(node: AidenUiNodeV1): string[] {
  return [node.t, ...(node.c ?? []).flatMap(components)];
}

test("another computer's native visual shows on this Mac as the text its phones see, where its tool call ran", () => {
  const markup = `<Visual title="Revenue"><Data name="months">[{"month":"Jan","revenue":1200},{"month":"Feb","revenue":1500}]</Data><Chart kind="bar" data={$months} x="month" y="revenue" format="currency" label="By month" /><Button label="Approve" onClick={send("approve")} /><Checklist items={[{"label":"Ship","done":true}]} /></Visual>`;
  const compiled = compileAum(markup, { fallback: { chartTables: true, plainTables: true } });
  assert.ok(compiled.tree);
  const hostVisual: ChatUiVisualV1 = {
    version: 1, kind: "ui", id: "ui-1", toolCallId: "call-1", title: "Revenue", catalogVersion: 1,
    tree: compiled.tree, ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}), state: { picked: "Jan" },
    fallbackText: compiled.fallbackText, layout: "wide",
  };
  const [message] = served([{
    id: "a1", role: "assistant", content: "Here it is.", createdAt: 1, timeline, uiVisuals: [hostVisual],
  }], { limit: 50 }).messages;
  assert.equal(message?.uiVisuals?.length, 1);
  const [visual] = message!.uiVisuals!;
  assert.equal(visual!.id, "ui-1");
  assert.equal(visual!.title, "Revenue");
  assert.equal(visual!.toolCallId, "call-1", "placed where its tool call ran");
  assert.equal(visual!.layout, "wide");
  // What is drawn is the host's text, line for line, with the chart's rows written out.
  assert.deepEqual(drawnLines(visual!.tree), compiled.fallbackText.split("\n").filter((line) => line.trim()));
  assert.ok(drawnLines(visual!.tree).includes("month: Jan · revenue: $1,200.00"));
  // Nothing from the host's markup crosses: no controls, data or state to act on.
  assert.deepEqual([...new Set(components(visual!.tree))].sort(), ["#text", "Text", "Visual"]);
  assert.equal(visual!.dataJson, undefined);
  assert.equal(visual!.state, undefined);
});

test("remote visual text is drawn as words, never as markup, and an HTML, empty or pictured visual adds no text visual", () => {
  const visuals = [
    { id: "ui-markup", kind: "ui", title: "Odd", fallbackText: "<Button label=\"Go\" onClick={send(\"rm\")} />\n**bold** [link](https://example.com)" },
    { id: "ui-empty", kind: "ui", title: "Empty", fallbackText: "   " },
    { id: "html-1", kind: "html", title: "Chart", fallbackText: "ignored" },
    { id: "ui-markup", kind: "ui", title: "Duplicate", fallbackText: "again" },
    { id: "ui-bad id!", kind: "ui", title: "Bad", fallbackText: "text" },
    // Pictured on the host: its snapshot already shows as an image.
    { id: "ui-pictured", kind: "ui", title: "Pictured", fallbackText: "text", snapshotAttachmentId: "visual-snapshot_abc" },
  ];
  const message = mapRemoteMessage({ id: "a1", role: "assistant", text: "Done", createdAt: new Date(1).toISOString(), visuals });
  assert.deepEqual(message?.uiVisuals?.map((visual) => visual.id), ["ui-markup"]);
  const [visual] = message!.uiVisuals!;
  assert.deepEqual(drawnLines(visual!.tree), ["<Button label=\"Go\" onClick={send(\"rm\")} />", "**bold** [link](https://example.com)"]);
  assert.deepEqual([...new Set(components(visual!.tree))].sort(), ["#text", "Text", "Visual"]);
  // A user's message never carries one.
  assert.equal(mapRemoteMessage({ id: "u1", role: "user", text: "Hi", createdAt: new Date(1).toISOString(), visuals })?.uiVisuals, undefined);

  // However many lines the host sends, the drawn tree stays inside the visual node cap and keeps every word.
  const many = Array.from({ length: 1_500 }, (_, index) => String(index % 10)).join("\n");
  const [long] = mapRemoteMessage({ id: "a2", role: "assistant", text: "", createdAt: new Date(1).toISOString(), visuals: [{ id: "ui-long", kind: "ui", title: "Long", fallbackText: many }] })?.uiVisuals ?? [];
  assert.ok(long);
  assert.ok(components(long.tree).length <= 2_000);
  assert.equal(drawnLines(long.tree).join(" ").split(" ").length, 1_500);
});

test("a remote visual's long or odd title and its hidden characters never cost the visual or split a character", () => {
  const map = (title: unknown, fallbackText: string) =>
    mapRemoteMessage({ id: "a1", role: "assistant", text: "", createdAt: new Date(1).toISOString(), visuals: [{ id: "ui-1", kind: "ui", title, fallbackText }] })?.uiVisuals?.[0];
  const loneSurrogate = /\p{Cs}/u;

  // 119 letters then emoji: the 120-unit cap falls inside the first emoji's pair.
  const long = map(`${"a".repeat(119)}${"\u{1f600}".repeat(10)}`, "Body");
  assert.ok(long, "a title over the cap still shows the visual");
  assert.ok(long.title.length <= 120);
  assert.ok(long.title.endsWith("…"));
  assert.doesNotMatch(long.title, loneSurrogate);
  assert.equal(map("\u202e\u0007\t", "Body")?.title, "Visual", "a title of nothing visible falls back");
  assert.equal(map(42, "Body")?.title, "Visual");
  assert.equal(map("Q3\trevenue\u202e \u0085report", "Body")?.title, "Q3 revenue report");

  // Each line loses direction and control characters; a tab stays.
  const odd = map("Odd", "safe\u202eexe.txt\nbell\u0007 here\u009b\r\nname\tvalue\u2066x\u2069");
  assert.deepEqual(drawnLines(odd!.tree), ["safeexe.txt", "bell here", "name\tvalue" + "x"]);

  // The 4,000-unit cap falls inside a pair: the half character is left off, not kept.
  const capped = map("Capped", `${"b".repeat(3_999)}\u{1f600}tail`);
  assert.ok(capped);
  assert.equal(capped.fallbackText, "b".repeat(3_999));
  assert.doesNotMatch(drawnLines(capped.tree).join("\n"), loneSurrogate);
  // Hidden characters are dropped before the title or text is clipped, so a run of
  // them neither uses up the cap nor leaves half a character behind.
  assert.equal(map(`${"\u202e".repeat(3_999)}\u{1f600} Report`, "Body")?.title, "\u{1f600} Report");
  const padded = map("Padded", `${"\u200b".repeat(4_000)}visible`);
  assert.ok(padded, "a text of invisible characters before the words still shows the visual");
  assert.deepEqual(drawnLines(padded.tree), ["visible"]);
  // However long the hidden run, and however it lines up with the emoji after it, nothing visible is lost or split.
  assert.equal(map(`${"​".repeat(50_000)}Long ${" ​".repeat(5_000)}title`, "Body")?.title, "Long title");
  for (let lead = 1_015; lead <= 1_030; lead += 1) {
    const emoji = map(`${"​".repeat(lead)}${"\u{1f600}".repeat(70)}`, `${"﻿".repeat(lead * 10)}${"\u{1f600}".repeat(2_100)}`);
    assert.ok(emoji);
    assert.equal(emoji.title, `${"\u{1f600}".repeat(59)}…`, `lead ${lead}`);
    assert.equal(emoji.fallbackText, "\u{1f600}".repeat(2_000), `lead ${lead}`);
  }

  // A zero-width space, word joiner, invisible operator, BOM, interlinear annotation mark
  // or lone half of a pair draws as nothing and is dropped; a line or paragraph separator
  // reads as a space; the joiner inside an emoji stays.
  assert.equal(map("Q3\u200b rev\ufeffenue\u2060\u2028report", "Body")?.title, "Q3 revenue report");
  const hidden = map("Hidden", "pay\u200broll\u2062\ufff9note\ufffb\u2029end\ud800\n\u{1f469}\u200d\u{1f4bb} team");
  assert.deepEqual(drawnLines(hidden!.tree), ["payrollnote end", "\u{1f469}\u200d\u{1f4bb} team"]);
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

test("host image placements survive mapping without admitting malformed or non-image placements", () => {
  const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  for (const toolName of ["generate_image", "display_image", "share_image"]) {
    const [message] = served([{
      id: "reply", role: "assistant", content: "Explanation after the image.", createdAt: 1,
      timeline: { ...timeline, steps: [{ ...timeline.steps[0]!, toolName }] },
      attachments: [{ id: "photo", name: "Photo.png", kind: "image", mimeType: "image/png", size: Buffer.from(bytes, "base64").length, data: bytes }],
      imagePlacements: [{ attachmentId: "photo", toolCallId: "call-1" }],
    }], { limit: 50 }).messages;
    assert.deepEqual(message?.imagePlacements, [{ attachmentId: "photo", toolCallId: "call-1" }], toolName);
    assert.equal(message?.attachments?.[0]?.data, undefined, "placement does not inline image bytes");
  }

  const attachment = { id: "photo", name: "Photo.png", kind: "image", mimeType: "image/png", size: 10 };
  const projected = { id: "reply", role: "assistant", text: "Reply", createdAt: "2026-11-02T00:00:00Z" };
  for (const toolCallId of [undefined, null, 1, "call-0", "call-01", "call-1/other", `call-${"1".repeat(130)}`]) {
    const message = mapRemoteMessage({ ...projected, attachments: [{ ...attachment, toolCallId }] });
    assert.equal(message?.attachments?.length, 1, "an invalid additive placement must not drop the picture");
    assert.equal(message?.imagePlacements, undefined);
  }
  assert.equal(mapRemoteMessage({ ...projected, role: "user", attachments: [{ ...attachment, toolCallId: "call-1" }] })?.imagePlacements, undefined);
  assert.equal(mapRemoteMessage({ ...projected, attachments: [{ ...attachment, kind: "text", mimeType: "text/plain", toolCallId: "call-1" }] })?.imagePlacements, undefined);
});

test("another Mac's voice message keeps its By voice label; other values and roles do not", () => {
  const messages = served([
    { id: "voice", role: "user", content: "Check the reset page too.", inputSource: "voice", createdAt: 1 },
    { id: "typed", role: "user", content: "Thanks.", createdAt: 2 },
  ], { limit: 50 }).messages;
  assert.deepEqual(messages.map((message) => message.inputSource), ["voice", undefined]);

  const projected = { id: "m", text: "Hi", createdAt: "2026-11-06T00:00:00Z" };
  assert.equal(mapRemoteMessage({ ...projected, role: "user", inputSource: "dictation" })?.inputSource, undefined);
  assert.equal(mapRemoteMessage({ ...projected, role: "assistant", inputSource: "voice" })?.inputSource, undefined);
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

test("another computer's browser recording shows as its activity line without a card this Mac cannot play", () => {
  const recording = {
    id: "recording-0f1e2d3c-4b5a-4678-9abc-def012345678",
    mimeType: "video/mp4",
    durationMs: 12_400,
    sizeBytes: 1_048_576,
  };
  const stop = {
    id: "tool-2",
    order: 0,
    kind: "tool" as const,
    toolCallId: "call-2",
    toolName: "browser_recording_stop",
    label: "Stop browser recording",
    status: "completed" as const,
    startedAt: 1_500,
    updatedAt: 1_600,
    finishedAt: 1_600,
    contentOffset: 0,
    recording,
  };
  const message = mapRemoteMessage({
    id: "m-rec",
    role: "assistant",
    text: "Recorded it.",
    createdAt: "2026-10-27T10:00:00.000Z",
    timeline: { ...timeline, steps: [stop] },
  });
  const [step] = message?.timeline?.steps ?? [];
  assert.ok(step?.kind === "tool");
  assert.equal(step.toolName, "browser_recording_stop");
  assert.equal(step && "recording" in step, false);
});

test("the host can remove the cached prefix or reveal earlier pages at the same anchor", () => {
  const all = numbered(5);
  const cached = mergeNewestWindow(emptyRemoteTranscript("chat-1"), served(all, { limit: 10 }));
  const shortened = mergeNewestWindow(cached, served(all.slice(2), { limit: 10 }));
  assert.deepEqual(shortened.messages.map((m) => m.id), ["m2", "m3", "m4"]);
  const restored = mergeNewestWindow(shortened, served(all, { limit: 3 }));
  assert.equal(restored.hasOlder, true);
});
