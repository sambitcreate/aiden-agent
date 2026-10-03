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
  | "botChatAccess"
  | "botFavorites";
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
  | "updateBotFavorites"
  | "updateBotChatAccess";
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
