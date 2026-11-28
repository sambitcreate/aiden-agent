import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSED_COMPOSER_HISTORY,
  composerHistoryFromBotEntries,
  composerHistoryFromMessages,
  detachComposerHistory,
  dismissComposerHistory,
  formatHistoryPromptPreview,
  formatHistoryReplyPreview,
  openComposerHistory,
  reconcileComposerHistory,
  resolveComposerHistoryIndex,
  selectComposerHistoryEntry,
  stepComposerHistoryDown,
  stepComposerHistoryUp,
} from "./composer-history";
import type { ChatMessage } from "./types";
import {
  BOT_FAILED_TURN_TEXT,
  BOT_SILENT_REPLY,
  type BotTranscriptEntry,
} from "../shared/bot-live";

function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, createdAt: 1000, ...extra } as ChatMessage;
}

test("composerHistoryFromMessages filters non-person turns, preserves order, and pairs replies", () => {
  const messages: ChatMessage[] = [
    msg("s0", "system", "System prompt"),
    msg("u1", "user", "Plan the release\nwith milestones", {
      createdAt: 100,
      attachments: [{ id: "a1", name: "spec.md", mimeType: "text/plain", kind: "text", size: 20 }],
    }),
    msg(
      "a1",
      "assistant",
      '## Release Plan\n> - Ship **v2.0** via [checklist](https://example.com)\n```c++ title="demo"\nconst ok = true;\n```\n~~~sh\necho done\n~~~',
      { createdAt: 200 },
    ),
    // Follow-up agent notice stored with role "user" — must be excluded.
    msg("n1", "user", "CI failed on PR #12", {
      notice: {
        version: 1,
        source: "pull_request",
        tone: "failure",
        title: "CI failed",
        summary: "lint",
      },
    }),
    msg("a-notice", "assistant", "I looked at the CI failure."),
    // Message from a lead chat — must be excluded.
    msg("lead-1", "user", "Check the child build", { fromLeadChat: true }),
    msg("a-lead", "assistant", "Checked."),
    // Empty attachment-only user message — skipped for text recall.
    msg("u-empty", "user", "   \n  ", {
      attachments: [
        { id: "img1", name: "shot.png", mimeType: "image/png", kind: "image", size: 10 },
      ],
    }),
    msg("a-empty", "assistant", "Nice screenshot."),
    // Voice user prompt with failed reply.
    msg("u2", "user", "Summarize the diff", { inputSource: "voice", createdAt: 300 }),
    msg("a2", "assistant", "", {
      providerFailure: {
        version: 1,
        category: "rate_limit",
        attempts: 1,
        retryExhausted: false,
      },
    }),
    // Hook-blocked user prompt.
    msg("u3", "user", "Deploy with secret", {
      createdAt: 400,
      hookBlocked: { reason: "Blocked secret pattern" },
    }),
    // Unanswered trailing user prompt.
    msg("u4", "user", "Write release notes", { createdAt: 500 }),
  ];

  const entries = composerHistoryFromMessages(messages, new Set(["u1", "u2"]));
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["u1", "u2", "u3", "u4"],
  );

  assert.equal(entries[0]!.prompt, "Plan the release\nwith milestones");
  assert.equal(entries[0]!.promptPreview, "Plan the release with milestones");
  assert.equal(entries[0]!.replyStatus, "answered");
  assert.equal(
    entries[0]!.replyPreview,
    "Release Plan Ship v2.0 via checklist const ok = true; echo done",
  );
  assert.equal(entries[0]!.attachmentCount, 1);
  assert.equal(entries[0]!.forkMessageId, "u1");

  assert.equal(entries[1]!.replyStatus, "failed");
  assert.equal(
    entries[1]!.replyPreview,
    "The model provider is receiving too many requests. Wait a moment and try again.",
  );
  assert.equal(entries[1]!.forkMessageId, "u2");

  assert.equal(entries[2]!.replyStatus, "blocked");
  assert.equal(entries[2]!.replyPreview, "Blocked secret pattern");
  assert.equal(entries[2]!.forkMessageId, undefined);

  assert.equal(entries[3]!.replyStatus, "pending");
  assert.equal(entries[3]!.replyPreview, undefined);
});

test("composerHistoryFromMessages distinguishes non-latest unanswered ('none'), trailing pending, and non-text replies", () => {
  const messages: ChatMessage[] = [
    msg("u1", "user", "Wait for tests"),
    msg("n1", "user", "Tests finished", {
      notice: {
        version: 1,
        source: "check",
        tone: "success",
        title: "Tests passed",
        summary: "ok",
      },
    }),
    msg("a-notice", "assistant", "Notice reply should not belong to u1"),
    msg("u2", "user", "Draw a chart"),
    msg("a2", "assistant", "", {
      htmlArtifacts: [
        { id: "art-1", title: "Chart", kind: "html", status: "ready" },
      ] as unknown as ChatMessage["htmlArtifacts"],
    }),
    msg("u3", "user", "Send screenshot"),
    msg("a3", "assistant", "", {
      attachments: [
        { id: "img-1", name: "out.png", mimeType: "image/png", kind: "image", size: 12 },
      ],
    }),
    msg("u4", "user", "Still running"),
  ];
  const entries = composerHistoryFromMessages(messages);
  assert.deepEqual(
    entries.map((e) => [e.id, e.replyStatus, e.replyPreview]),
    [
      ["u1", "none", undefined],
      ["u2", "answered", "Visual reply"],
      ["u3", "answered", "Attachment reply"],
      ["u4", "pending", undefined],
    ],
  );
});

test("composerHistoryFromMessages reports timeline-only cancelled turns as stopped and failed turns as failed", () => {
  const timeline = (status: string) =>
    ({
      version: 1,
      generationId: `g-${status}`,
      status,
      startedAt: 1000,
      steps: [],
    }) as unknown as ChatMessage["timeline"];
  const messages: ChatMessage[] = [
    msg("u1", "user", "Write the summary"),
    msg("a1", "assistant", "Partial **summary** so", { timeline: timeline("cancelled") }),
    msg("u2", "user", "Try once more"),
    msg("a2", "assistant", "", { timeline: timeline("cancelled") }),
    msg("u3", "user", "And again"),
    msg("a3", "assistant", "Half an answer", { timeline: timeline("failed") }),
    msg("u4", "user", "Last try"),
    msg("a4", "assistant", "", { timeline: timeline("failed") }),
  ];
  assert.deepEqual(
    composerHistoryFromMessages(messages).map((e) => [e.id, e.replyStatus, e.replyPreview]),
    [
      ["u1", "stopped", "Partial summary so"],
      ["u2", "stopped", undefined],
      ["u3", "failed", "Half an answer"],
      ["u4", "failed", undefined],
    ],
  );
});

test("composerHistoryFromBotEntries handles failed_turn, silent replies, stopped turns, non-text outputs, and turn boundaries", () => {
  const botEntries: BotTranscriptEntry[] = [
    { id: "r1", type: "routine", label: "Morning check", text: "Check inbox", at: 10 },
    {
      id: "a0",
      type: "assistant",
      text: "Inbox clear.",
      toolCalls: [],
      stopReason: "stop",
      at: 11,
    },
    // Answered turn with tool call + silent marker ignored
    { id: "u1", type: "user", text: "Draft the update", imageCount: 2, at: 20 },
    {
      id: "a1-silent",
      type: "assistant",
      text: BOT_SILENT_REPLY,
      toolCalls: [],
      stopReason: "stop",
      at: 21,
    },
    {
      id: "a1",
      type: "assistant",
      text: "Here is **the update**.",
      toolCalls: [],
      stopReason: "stop",
      at: 22,
    },
    // Notice breaks boundary so later reply doesn't bleed back into u2
    { id: "u2", type: "user", text: "Check before reset", imageCount: 0, at: 23 },
    { id: "n1", type: "notice", notice: "session_reset" },
    {
      id: "a-after-reset",
      type: "assistant",
      text: "Fresh session greeting.",
      toolCalls: [],
      stopReason: "stop",
      at: 24,
    },
    // Incoming peer request breaks boundary too
    { id: "u3", type: "user", text: "Idle check", imageCount: 0, at: 25 },
    {
      id: "p1",
      type: "peer",
      exchangeId: "ex-1",
      direction: "received",
      peerBotId: "b2",
      peerName: "Ops",
      messageKind: "request",
      at: 26,
    },
    {
      id: "a-peer",
      type: "assistant",
      text: "Answering Ops.",
      toolCalls: [],
      stopReason: "stop",
      at: 27,
    },
    // failed_turn entry
    { id: "u4", type: "user", text: "Retry deployment", imageCount: 0, at: 30 },
    {
      id: "f1",
      type: "failed_turn",
      retryText: "Retry deployment",
      errorMessage: "Gateway 503",
      at: 31,
    },
    // failed_turn without errorMessage falls back to BOT_FAILED_TURN_TEXT
    { id: "u5", type: "user", text: "Second try", imageCount: 0, at: 32 },
    { id: "f2", type: "failed_turn", retryText: "Second try", at: 33 },
    // Stopped (aborted) turn
    { id: "u6", type: "user", text: "Long search", imageCount: 0, at: 34 },
    { id: "a6", type: "assistant", text: "", toolCalls: [], stopReason: "aborted", at: 35 },
    // Non-text shared image output (with silent assistant text)
    { id: "u7", type: "user", text: "Take a photo", imageCount: 0, at: 36 },
    {
      id: "a7",
      type: "assistant",
      text: BOT_SILENT_REPLY,
      toolCalls: [],
      stopReason: "stop",
      at: 37,
    },
    {
      id: "img1",
      type: "shared_image",
      name: "snap.png",
      mimeType: "image/png",
      size: 100,
      data: "abc",
    },
    // Non-text file edit output
    { id: "u8", type: "user", text: "Update notes", imageCount: 0, at: 38 },
    { id: "file1", type: "file", path: "notes.md", operation: "edited", at: 39 },
    // Whitespace-only user message skipped
    { id: "u9", type: "user", text: "   ", imageCount: 1, at: 40 },
  ];

  const history = composerHistoryFromBotEntries(botEntries);
  assert.deepEqual(
    history.map((item) => [item.id, item.replyStatus, item.replyPreview]),
    [
      ["u1", "answered", "Here is the update."],
      ["u2", "none", undefined],
      ["u3", "none", undefined],
      ["u4", "failed", "Gateway 503"],
      ["u5", "failed", BOT_FAILED_TURN_TEXT],
      ["u6", "stopped", undefined],
      ["u7", "answered", "Shared an image"],
      ["u8", "answered", "Updated notes.md"],
    ],
  );
  assert.equal(history[0]!.attachmentCount, 2);
  assert.equal(history[0]!.forkMessageId, undefined);
});

test("formatHistoryReplyPreview preserves snake_case identifiers, strips nested markdown prefixes, and safely clips surrogate pairs", () => {
  assert.equal(
    formatHistoryReplyPreview("> # Heading\n> 1. Updated `my_helper_fn` in **snake_case_module**"),
    "Heading Updated my_helper_fn in snake_case_module",
  );
  const emojiText = "🚀".repeat(120);
  const clipped = formatHistoryPromptPreview(emojiText);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipped.includes("\uFFFD"), false);
  const beforeEllipsis = clipped.charCodeAt(clipped.length - 2);
  assert.equal(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff, false);
});

test("history state transitions: open, step up/down, clamp, restore draft, select, detach, reconcile", () => {
  const entries = composerHistoryFromMessages([
    msg("u1", "user", "First prompt"),
    msg("a1", "assistant", "First reply"),
    msg("u2", "user", "Second prompt"),
    msg("a2", "assistant", "Second reply"),
    msg("u3", "user", "Third prompt"),
    msg("a3", "assistant", "Third reply"),
  ]);

  assert.equal(openComposerHistory([], ""), null);

  // Open selects newest entry.
  const opened = openComposerHistory(entries, "");
  assert.ok(opened);
  assert.equal(opened.text, "Third prompt");
  assert.equal(opened.state.activeId, "u3");
  assert.equal(resolveComposerHistoryIndex(entries, opened.state), 2);

  // Step up moves older and clamps at oldest (index 0).
  const up1 = stepComposerHistoryUp(entries, opened.state)!;
  assert.equal(up1.text, "Second prompt");
  assert.equal(up1.state.activeId, "u2");

  const up2 = stepComposerHistoryUp(entries, up1.state)!;
  assert.equal(up2.text, "First prompt");
  assert.equal(up2.state.activeId, "u1");

  const upClamped = stepComposerHistoryUp(entries, up2.state)!;
  assert.equal(upClamped.text, "First prompt");
  assert.equal(upClamped.state.activeId, "u1");

  // Step down moves newer, then closes and restores savedDraft past newest.
  const down1 = stepComposerHistoryDown(entries, upClamped.state)!;
  assert.equal(down1.closed, false);
  assert.equal(down1.text, "Second prompt");

  const down2 = stepComposerHistoryDown(entries, down1.state)!;
  assert.equal(down2.closed, false);
  assert.equal(down2.text, "Third prompt");

  const downClose = stepComposerHistoryDown(entries, down2.state)!;
  assert.equal(downClose.closed, true);
  assert.equal(downClose.text, "");
  assert.deepEqual(downClose.state, CLOSED_COMPOSER_HISTORY);

  // Select closes with chosen prompt.
  const selected = selectComposerHistoryEntry(entries, "u1")!;
  assert.equal(selected.text, "First prompt");
  assert.deepEqual(selected.state, CLOSED_COMPOSER_HISTORY);

  // Dismiss restores savedDraft; detach closes without specifying text.
  const openedWithDraft = openComposerHistory(entries, "draft")!;
  const dismissed = dismissComposerHistory(openedWithDraft.state);
  assert.equal(dismissed.text, "draft");
  assert.deepEqual(dismissed.state, CLOSED_COMPOSER_HISTORY);
  assert.deepEqual(detachComposerHistory(), CLOSED_COMPOSER_HISTORY);

  // Reconcile keeps selection anchored by id when new messages append, or falls back safely.
  const appended = [
    ...entries,
    ...composerHistoryFromMessages([msg("u4", "user", "Fourth prompt")]),
  ];
  const anchored = reconcileComposerHistory(appended, up1.state);
  assert.equal(anchored.activeId, "u2");

  const shrunk = entries.slice(0, 1); // only u1 remains
  const fallback = reconcileComposerHistory(shrunk, up1.state);
  assert.equal(fallback.open, true);
  assert.equal(fallback.activeId, "u1");

  const emptied = reconcileComposerHistory([], up1.state);
  assert.deepEqual(emptied, CLOSED_COMPOSER_HISTORY);
});
