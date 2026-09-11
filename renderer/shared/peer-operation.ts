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
  | "git";
export type PeerWriteOperation =
  | "createChat"
  | "send"
  | "renameChat"
  | "deleteChat"
  | "cancel"
  | "respondApproval"
  | "selectFolder"
  | "createWorkspace";
export interface PeerOperation {
  operation: PeerReadOperation | PeerWriteOperation;
  resourceId?: string;
  workspaceId?: string;
  cursor?: string;
  body?: unknown;
  idempotencyKey?: string;
  revision?: string;
}
