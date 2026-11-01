import { createPendingAttentionRecorder, DetachedPromptLog } from "./chat-pending-attention.js";
import { chatActivityRegistry } from "./chat-activity.js";
import { hostRunRegistry } from "./host-runs-main.js";

/** Prompts the host settled because their window left the chat, per chat. */
export const detachedPromptLog = new DetachedPromptLog();

export const pendingAttentionRecorder = createPendingAttentionRecorder({
  runs: hostRunRegistry,
  log: detachedPromptLog,
  // The renderer rereads waits on every activity revision.
  onChange: () => chatActivityRegistry.touch(),
});
