import { FolderX } from "lucide-react";
import { Button, Callout } from "./ui";
import {
  managedWorktreeMissingMessage,
  workspaceFolderMissingMessage,
  type MissingWorktreeOptions,
} from "../shared/workspace-folder-presence";

/**
 * Above the composer while the chat's workspace folder is gone. Sends are
 * refused until the folder is back, so the draft stays in the composer. For a
 * deleted Aiden-managed worktree it offers Restore worktree and a new chat in
 * the main checkout that takes the unsent message along.
 */
export function WorkspaceFolderMissingNotice({
  workspaceName,
  folder,
  worktree,
  checking,
  restoring,
  onCheckAgain,
  onRestore,
  onNewChatInMain,
}: {
  workspaceName: string;
  folder?: string;
  worktree?: MissingWorktreeOptions;
  checking?: boolean;
  restoring?: boolean;
  onCheckAgain(): void;
  onRestore?(): void;
  onNewChatInMain?(): void;
}) {
  // Aiden chose a worktree's folder, so its long path would only be noise here.
  const message = worktree
    ? managedWorktreeMissingMessage(workspaceName, undefined, worktree)
    : workspaceFolderMissingMessage(workspaceName, folder);
  const canRestore = Boolean(worktree?.restorable && onRestore);
  const canStartInMain = Boolean(worktree?.mainWorkspaceId && onNewChatInMain);
  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout role="status" aria-label={worktree ? "Worktree folder missing" : "Workspace folder missing"}>
        <p className="flex items-start gap-2 text-small text-secondary">
          <FolderX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{message}</span>
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-1.5">
          {canRestore || canStartInMain ? null : (
            <Button variant="transparent" size="small" disabled={checking} onClick={onCheckAgain}>
              {checking ? "Checking…" : "Check again"}
            </Button>
          )}
          {canStartInMain ? (
            <Button
              variant={canRestore ? "transparent" : "accent"}
              size="small"
              disabled={restoring}
              onClick={onNewChatInMain}
              title={worktree?.mainWorkspaceName ? `New chat in ${worktree.mainWorkspaceName}` : undefined}
            >
              New chat in main checkout
            </Button>
          ) : null}
          {canRestore ? (
            <Button variant="accent" size="small" disabled={restoring} onClick={onRestore}>
              {restoring ? "Restoring…" : "Restore worktree"}
            </Button>
          ) : null}
        </div>
      </Callout>
    </div>
  );
}
