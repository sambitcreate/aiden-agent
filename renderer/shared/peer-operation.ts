export type PeerReadOperation =
  | "server"
  | "summaries"
  | "workspaces"
  | "models"
  | "chat"
  | "roots"
  | "children"
  | "stream"
  | "approval"
  | "files"
  | "file"
  | "git"
  | "messagesWindow"
  | "attachmentContent"
  | "skills"
  | "tasks"
  | "agents"
  | "streamQuestion"
  | "bots"
  | "bot"
  | "botConversations"
  | "botCapabilities"
  /** A Bot's one durable conversation (`GET /bots/{botId}/session`). */
  | "botSession";
export type PeerWriteOperation =
  | "createChat"
  | "send"
  | "renameChat"
  | "deleteChat"
  | "cancel"
  | "respondApproval"
  | "selectFolder"
  | "createWorkspace"
  | "markRead"
  | "interruptAgent"
  | "respondQuestion"
  | "inputs"
  | "runCancel"
  | "runRespondApproval"
  | "runRespondQuestion"
  | "runInputs"
  | "createBotChat"
  | "uploadAttachment"
  | "removeAttachment"
  | "forkChat"
  | "forkSummaryRetry"
  | "forkSummarySkip"
  | "forkSummaryCancel"
  // A Bot's durable conversation: the same session the host's own app and phones use.
  | "botSend"
  | "botResume"
  | "botDismiss"
  | "botStop"
  /** `itemId` is the question's `waitId`. */
  | "botAnswerQuestion"
  /** Contract revision 37 (`bot:handoffs`); `itemId` is the hand-off's `waitId`. */
  | "botAnswerHandoff"
  /** Contract revision 37: bring a hand-off forward on the host; `itemId` is its `waitId`. */
  | "botHandoffOpenOnMac"
  /** Contract revision 37: the person's pause (`POST /bots/{botId}/pause`). */
  | "botPause"
  /** Contract revision 37: lift the person's pause (`DELETE /bots/{botId}/pause`). */
  | "botUnpause"
  | "botConnectionRequest"
  | "uploadBotAttachment"
  /** `itemId` is the staged attachment. */
  | "removeBotAttachment";
export interface PeerOperation {
  operation: PeerReadOperation | PeerWriteOperation;
  /** The chat, stream, run, Bot or prompt the operation addresses. */
  resourceId?: string;
  /** A nested item: attachment, agent, approval or question prompt. */
  itemId?: string;
  workspaceId?: string;
  cursor?: string;
  /** `messagesWindow`: the message ID the window ends before. */
  before?: string;
  limit?: number;
  /** `botConversations` search text. */
  query?: string;
  /** `botConversations` and `botCapabilities` Bot filter. */
  botId?: string;
  /** `agents`: the public turn to read. */
  turnId?: string;
  includeArchived?: boolean;
  body?: unknown;
  idempotencyKey?: string;
  revision?: string;
}

/** `attachmentContent` resolves to bounded image bytes instead of JSON. */
export interface PeerAttachmentContent {
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}
