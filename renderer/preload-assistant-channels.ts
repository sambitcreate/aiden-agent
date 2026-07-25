// Exact channel names the Aiden assistant window may use — never prefixes. The
// window is a privileged auxiliary surface with no folder tools, no key
// material, and no scheduler reach; enumerating the surface is what keeps that
// true as `chat:` and `chats:` grow.

export const ASSISTANT_INVOKE_CHANNELS = new Set([
  "assistant:dismiss-nudge",
  "assistant:get-config",
  "assistant:get-state",
  "assistant:hide-window",
  "assistant:set-config",
  "assistant:snooze-nudge",
  "assistant:toggle-window",
  "chat:approve",
  "chat:cancel",
  "chat:start",
  "chats:create",
  "chats:get",
  "chats:list",
  "settings:get",
]);

export const ASSISTANT_NOTIFICATION_CHANNELS = new Set([
  "aiden:theme:changed",
  "assistant:nudge",
  "assistant:open-thread",
  "assistant:state-changed",
  "chat:approval",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:reasoning-delta",
  "chat:status",
  "chat:timeline",
  "chat:tool",
  "chats:metadata-updated",
]);
