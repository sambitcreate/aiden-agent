// Least-privilege IPC allowlists for the Bot bubble overlay window preload
// (`renderer/preload-bot-bubbles.ts`): a Bot's live chat, its approvals and
// questions, the bubble controls and read-only appearance. No settings
// changes, terminal, browser, files, screen capture or native dialogs.
//
// Dependency-free (no Electron import) so main's broadcast registration and
// the contract tests can import it.

import { BOT_BUBBLE_CHANNELS } from "./shared/bot-bubbles.js";

export const BOT_BUBBLES_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  // Bubble list and overlay controls
  BOT_BUBBLE_CHANNELS.state,
  BOT_BUBBLE_CHANNELS.close,
  BOT_BUBBLE_CHANNELS.open,
  BOT_BUBBLE_CHANNELS.move,
  BOT_BUBBLE_CHANNELS.bringBack,
  BOT_BUBBLE_CHANNELS.setInteractive,
  BOT_BUBBLE_CHANNELS.setDragging,
  BOT_BUBBLE_CHANNELS.overlayInfo,
  BOT_BUBBLE_CHANNELS.transitionShown,

  // The mini chat: live feed and the Bot's own read surfaces
  "bots:live:subscribe",
  "bots:live:unsubscribe",
  "bots:live:summary",
  "bots:get",
  "bots:list",
  "bots:getCanonicalPhoto",
  "bots:sessionState",

  // Talking to the Bot
  "bots:send",
  "bots:stop",
  "bots:resume",
  "bots:dismiss",
  "bots:withdraw",

  // Approval and question cards
  "bots:approve",
  "bots:pendingApprovals",
  "bots:answerQuestion",

  // Images in a Bot's replies (fetched by main, never by the page)
  "chat:loadTranscriptImage",

  // App metadata and read-only settings / appearance
  "app:getInfo",
  "settings:get",
  "settings:getAppearance",
]);

export const BOT_BUBBLES_NOTIFICATION_CHANNELS: ReadonlySet<string> = new Set([
  BOT_BUBBLE_CHANNELS.changed,
  BOT_BUBBLE_CHANNELS.transition,
  BOT_BUBBLE_CHANNELS.overlayInfoChanged,
  "bots:live:event",
  "bots:changed",
  "bots:approval",
  "bots:approval-settled",
  "bots:attention",
  "settings:appearance-changed",
  "aiden:theme:changed",
  "app:config-externally-changed",
]);
