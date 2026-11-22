import assert from "node:assert/strict";
import test from "node:test";
import {
  QUICK_CHAT_STAGE_SIZES,
  clampBoundsToWorkArea,
  computeQuickChatInitialBounds,
  computeQuickChatTransitionBounds,
  createPendingLastWorkspaceTracker,
  shouldHideQuickChatOnBlur,
} from "./quick-chat-window-core.js";
import { isTrustedQuickChatSender } from "./quick-chat-window-security.js";
import { canPositionFloatingWindow } from "./pill-window-platform.js";
import {
  parseQuickChatExpandRequest,
  parseQuickChatWindowMode,
} from "../../renderer/shared/quick-chat.js";

test("computeQuickChatInitialBounds centers starter on primary and offset secondary displays", () => {
  const primary = { x: 0, y: 25, width: 1728, height: 1092 };
  const starter = computeQuickChatInitialBounds(primary, "starter");
  assert.equal(starter.width, QUICK_CHAT_STAGE_SIZES.starter.width);
  assert.equal(starter.height, QUICK_CHAT_STAGE_SIZES.starter.height);
  assert.equal(starter.x, Math.round((1728 - 560) / 2));
  assert.ok(starter.y >= primary.y);
  assert.ok(starter.y + starter.height <= primary.y + primary.height);

  // Offset secondary display to the left of main monitor.
  const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
  const onSecondary = computeQuickChatInitialBounds(secondary, "starter");
  assert.equal(onSecondary.x, -1920 + (1920 - 560) / 2);
  assert.ok(onSecondary.x >= secondary.x);
  assert.ok(onSecondary.x + onSecondary.width <= secondary.x + secondary.width);
});

test("computeQuickChatTransitionBounds anchors bottom edge and horizontal center when expanding upward", () => {
  const workArea = { x: 0, y: 25, width: 1728, height: 1092 };
  const starter = computeQuickChatInitialBounds(workArea, "starter");
  const starterCenter = starter.x + starter.width / 2;
  const starterBottom = starter.y + starter.height;

  const popover = computeQuickChatTransitionBounds(starter, workArea, "starter-popover");
  assert.equal(popover.width, QUICK_CHAT_STAGE_SIZES["starter-popover"].width);
  assert.equal(popover.height, QUICK_CHAT_STAGE_SIZES["starter-popover"].height);
  assert.equal(popover.x + popover.width / 2, starterCenter);
  assert.equal(popover.y + popover.height, starterBottom);

  const modal = computeQuickChatTransitionBounds(starter, workArea, "modal");
  assert.equal(modal.width, QUICK_CHAT_STAGE_SIZES.modal.width);
  assert.equal(modal.height, QUICK_CHAT_STAGE_SIZES.modal.height);
  assert.equal(modal.x + modal.width / 2, starterCenter);
  assert.equal(modal.y + modal.height, starterBottom);
});

test("clampBoundsToWorkArea shrinks and clamps gracefully on small displays", () => {
  const smallWorkArea = { x: 0, y: 0, width: 480, height: 500 };
  const clamped = clampBoundsToWorkArea({ x: -100, y: -50, width: 560, height: 640 }, smallWorkArea);
  assert.deepEqual(clamped, { x: 0, y: 0, width: 480, height: 500 });
});

test("shouldHideQuickChatOnBlur hides State 1, respects suppression, and honors State 2 keepOpenOnBlur", () => {
  // Suppressed blur never hides.
  assert.equal(
    shouldHideQuickChatOnBlur({ mode: "starter", keepOpenOnBlur: true, now: 1000, suppressBlurUntil: 1500 }),
    false,
  );
  // State 1 hides on blur once suppression expires.
  assert.equal(
    shouldHideQuickChatOnBlur({ mode: "starter", keepOpenOnBlur: true, now: 1500, suppressBlurUntil: 1500 }),
    true,
  );
  assert.equal(
    shouldHideQuickChatOnBlur({ mode: "starter-popover", keepOpenOnBlur: true, now: 2000, suppressBlurUntil: 1500 }),
    true,
  );
  // State 2 stays pinned when keepOpenOnBlur is true, hides when false.
  assert.equal(
    shouldHideQuickChatOnBlur({ mode: "modal", keepOpenOnBlur: true, now: 2000, suppressBlurUntil: 1500 }),
    false,
  );
  assert.equal(
    shouldHideQuickChatOnBlur({ mode: "modal", keepOpenOnBlur: false, now: 2000, suppressBlurUntil: 1500 }),
    true,
  );
});

test("isTrustedQuickChatSender enforces webContentsId, main frame, and exact URL", () => {
  const url = "file:///app/build/renderer/quick-chat.html";
  assert.equal(
    isTrustedQuickChatSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    true,
  );
  assert.equal(
    isTrustedQuickChatSender(null, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    false,
  );
  assert.equal(
    isTrustedQuickChatSender(7, url, { webContentsId: 8, frameUrl: url, isMainFrame: true }),
    false,
  );
  assert.equal(
    isTrustedQuickChatSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: false }),
    false,
  );
  assert.equal(
    isTrustedQuickChatSender(7, url, {
      webContentsId: 7,
      frameUrl: "file:///app/build/renderer/main-window.html",
      isMainFrame: true,
    }),
    false,
  );
});

test("canPositionFloatingWindow skips setBounds positioning on Linux Wayland only", () => {
  assert.equal(canPositionFloatingWindow("darwin", undefined), true);
  assert.equal(canPositionFloatingWindow("linux", "x11"), true);
  assert.equal(canPositionFloatingWindow("linux", "wayland"), false);
  assert.equal(canPositionFloatingWindow("linux", "WAYLAND"), false);
});

test("quick-chat shared parsers validate modes and expand requests strictly", () => {
  assert.equal(parseQuickChatWindowMode("starter"), "starter");
  assert.equal(parseQuickChatWindowMode("starter-popover"), "starter-popover");
  assert.equal(parseQuickChatWindowMode("modal"), "modal");
  assert.throws(() => parseQuickChatWindowMode("fullscreen"));

  const draft = parseQuickChatExpandRequest({
    kind: "draft",
    workspaceId: "ws-1",
    text: "hello",
    attachments: [{ id: "att-1" }],
    providerId: "anthropic",
    model: "claude-sonnet-4-6",
  });
  assert.equal(draft.kind, "draft");
  assert.equal(draft.workspaceId, "ws-1");
  assert.equal(draft.attachments.length, 1);

  const chat = parseQuickChatExpandRequest({
    kind: "chat",
    chatId: "chat-9",
    draftText: "follow-up",
    queuedMessages: [{ content: "queued" }],
  });
  assert.equal(chat.kind, "chat");
  assert.equal(chat.chatId, "chat-9");
  assert.equal(chat.queuedMessages?.length, 1);

  assert.throws(() => parseQuickChatExpandRequest({ kind: "draft", workspaceId: "", text: "x" }));
  assert.throws(() => parseQuickChatExpandRequest({ kind: "chat", chatId: "bad\0id" }));
  assert.throws(() => parseQuickChatExpandRequest({ kind: "other" }));
});

test("createPendingLastWorkspaceTracker surfaces in-flight workspace writes to concurrent settings reads", () => {
  const tracker = createPendingLastWorkspaceTracker();
  const persisted = { lastWorkspaceId: "ws-old" };
  assert.equal(tracker.overlay(persisted).lastWorkspaceId, "ws-old");

  // Main window switches to ws-new while durable disk write is still in flight.
  const firstToken = tracker.beginWrite("ws-new");
  assert.equal(tracker.overlay(persisted).lastWorkspaceId, "ws-new");

  // Rapid second switch before first write finishes: settling first must NOT drop second.
  const secondToken = tracker.beginWrite("ws-latest");
  tracker.settleWrite(firstToken);
  assert.equal(tracker.overlay(persisted).lastWorkspaceId, "ws-latest");

  // Settling latest falls back to whatever is now persisted on disk.
  tracker.settleWrite(secondToken);
  assert.equal(tracker.overlay({ lastWorkspaceId: "ws-latest" }).lastWorkspaceId, "ws-latest");
});
