// Production wiring of the started-chat links (Phase 5, D2).

import { app, logger } from "../../platform.js";
import { DataStore } from "../data-store.js";
import type { ApprovalCeiling } from "../approval-gate/run-approval.js";
import type { ChatStartedByV1 } from "../../../renderer/shared/chat-started-by.js";
import {
  ChatLinkStore,
  emptyChatLinkDocument,
  parseChatLinkDocument,
  startedChatTurnCeiling,
  type ChatLinkDocument,
} from "./links.js";

const CHAT_LINKS_FILE = "chat-orchestration.json";
const CHAT_LINKS_MAX_BYTES = 8 * 1024 * 1024;

const storage = new DataStore<ChatLinkDocument>(
  CHAT_LINKS_FILE,
  emptyChatLinkDocument(),
  () => app.getPath("userData"),
  {
    maxBytes: CHAT_LINKS_MAX_BYTES,
    fileMode: 0o600,
    compact: true,
    normalize: (value) => parseChatLinkDocument(value),
  },
);

export const chatLinks = new ChatLinkStore(
  { load: () => storage.load(), save: (document) => storage.save(document) },
  (message, error) => logger.warn("chat-orchestration", message, error),
);

/**
 * The ceiling a started chat's turns run under, or `undefined` for any other
 * chat: the stored one narrowed by the lead's workspace as it is now. A chat
 * that says another chat started it but whose link is gone (a damaged links
 * file) runs as Ask with no Mac grants rather than unbounded.
 */
export async function startedChatApprovalCeiling(
  chatId: string,
  startedBy: ChatStartedByV1 | undefined,
): Promise<ApprovalCeiling | undefined> {
  await chatLinks.restore();
  return startedChatTurnCeiling({
    links: chatLinks,
    chatId,
    startedBy,
    // What the lead's workspace allows now, read on every turn of the chat.
    leadCeiling: async (leadChatId) => {
      const [{ chatStore }, { configStore }, { approvalCeilingOf, currentWorkspaceApproval }] =
        await Promise.all([
          import("../chat-store.js"),
          import("../config-store.js"),
          import("../approval-gate/run-approval.js"),
        ]);
      const workspaceId = (await chatStore.getMeta(leadChatId))?.workspaceId;
      const policy = workspaceId
        ? await currentWorkspaceApproval(configStore, workspaceId)
        : undefined;
      return policy ? approvalCeilingOf(policy) : undefined;
    },
  });
}

/** The person wrote in a started chat: the lead's `send` and Stop leave it alone from now on. */
export async function markPersonTookOver(chatId: string, now = Date.now()): Promise<void> {
  await chatLinks.restore();
  await chatLinks.update(chatId, (link) => {
    link.tookOverAt = now;
  });
}
