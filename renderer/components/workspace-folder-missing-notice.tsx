import { ChevronDown, Folder, FolderX, MessageCircle } from "lucide-react";
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui";
import {
  managedWorktreeMissingMessage,
  workspaceFolderMissingMessage,
  type MissingWorktreeOptions,
} from "../shared/workspace-folder-presence";

/** A place the conversation can continue: a workspace, or No workspace. */
export interface ContinueInNewChatChoice {
  workspaceId: string;
  name: string;
  noWorkspace?: boolean;
}

/**
 * Above the composer while the chat's workspace folder is gone. Sends are
 * refused until the folder is back, so the draft stays in the composer. For a
 * deleted Aiden-managed worktree it also offers Restore worktree and a new
 * chat in the main checkout that takes the unsent message along. Continue in
 * a new chat forks the conversation into another workspace, or No workspace;
 * this chat stays as it is.
 */
export function WorkspaceFolderMissingNotice({
  workspaceName,
  folder,
  worktree,
  checking,
  restoring,
  continuing,
  continueChoices,
  onCheckAgain,
  onRestore,
  onNewChatInMain,
  onContinueIn,
}: {
  workspaceName: string;
  folder?: string;
  worktree?: MissingWorktreeOptions;
  checking?: boolean;
  restoring?: boolean;
  continuing?: boolean;
  /** Where Continue in a new chat can go, most relevant first. */
  continueChoices?: readonly ContinueInNewChatChoice[];
  onCheckAgain(): void;
  onRestore?(): void;
  onNewChatInMain?(): void;
  onContinueIn?(workspaceId: string): void;
}) {
  // Aiden chose a worktree's folder, so its long path would only be noise here.
  const message = worktree
    ? managedWorktreeMissingMessage(workspaceName, undefined, worktree)
    : workspaceFolderMissingMessage(workspaceName, folder);
  const canRestore = Boolean(worktree?.restorable && onRestore);
  const canStartInMain = Boolean(worktree?.mainWorkspaceId && onNewChatInMain);
  const busy = Boolean(restoring || continuing);
  const workspaceChoices = continueChoices?.filter((choice) => !choice.noWorkspace) ?? [];
  const noWorkspaceChoice = continueChoices?.find((choice) => choice.noWorkspace);
  const canContinue = Boolean(onContinueIn && (workspaceChoices.length > 0 || noWorkspaceChoice));
  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout role="status" aria-label={worktree ? "Worktree folder missing" : "Workspace folder missing"}>
        <p className="flex items-start gap-2 text-small text-secondary">
          <FolderX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{message}</span>
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-1.5">
          {/* Putting the folder back from the Trash keeps uncommitted work, so Check again stays. */}
          <Button variant="transparent" size="small" disabled={checking || busy} onClick={onCheckAgain}>
            {checking ? "Checking…" : "Check again"}
          </Button>
          {canContinue ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={canRestore || canStartInMain ? "transparent" : "accent"}
                  size="small"
                  disabled={busy}
                >
                  {continuing ? "Continuing…" : "Continue in a new chat"}
                  <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
                <DropdownMenuLabel>Continue in</DropdownMenuLabel>
                {noWorkspaceChoice ? (
                  <DropdownMenuItem onSelect={() => onContinueIn!(noWorkspaceChoice.workspaceId)}>
                    <MessageCircle className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                    <span className="truncate">{noWorkspaceChoice.name}</span>
                  </DropdownMenuItem>
                ) : null}
                {noWorkspaceChoice && workspaceChoices.length > 0 ? <DropdownMenuSeparator /> : null}
                {workspaceChoices.map((choice) => (
                  <DropdownMenuItem key={choice.workspaceId} onSelect={() => onContinueIn!(choice.workspaceId)}>
                    <Folder className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                    <span className="truncate">{choice.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {canStartInMain ? (
            <Button
              variant={canRestore ? "transparent" : "accent"}
              size="small"
              disabled={busy}
              onClick={onNewChatInMain}
              title={worktree?.mainWorkspaceName ? `New chat in ${worktree.mainWorkspaceName}` : undefined}
            >
              New chat in main checkout
            </Button>
          ) : null}
          {canRestore ? (
            <Button variant="accent" size="small" disabled={busy} onClick={onRestore}>
              {restoring ? "Restoring…" : "Restore worktree"}
            </Button>
          ) : null}
        </div>
      </Callout>
    </div>
  );
}
