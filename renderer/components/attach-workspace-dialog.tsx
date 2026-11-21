// Dialog for attaching a No workspace or temporary chat in-place to a real
// project workspace, with a scratch-file carry-over step when files exist.

import * as React from "react";
import { Folder, FolderOpen, FolderPlus } from "lucide-react";
import { chatsApi, workspacesApi } from "../lib/ipc";
import type { Chat, Workspace } from "../lib/types";
import type {
  AttachFileAction,
  AttachToWorkspaceResult,
  InspectAttachFilesResult,
} from "../shared/chat-attach-workspace";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { Button, Dialog, Input, toast } from "./ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachableProjectWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces
    .filter(
      (workspace) =>
        workspace.id !== ASSISTANT_WORKSPACE_ID &&
        workspace.noWorkspace !== true &&
        Boolean(workspace.folderPath),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface AttachWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  workspaces: readonly Workspace[];
  /** Called right before IPC runs; throw to block (e.g. dirty editor / active run). */
  beforeAttach?: () => void;
  /** Called after a new workspace folder is added via the native picker. */
  onWorkspaceCreated?: (workspace: Workspace) => void;
  /** Called after the chat is attached in main. */
  onAttached: (result: AttachToWorkspaceResult<Chat>, targetWorkspace: Workspace) => void | Promise<void>;
}

export function AttachWorkspaceDialog({
  open,
  onOpenChange,
  chatId,
  workspaces,
  beforeAttach,
  onWorkspaceCreated,
  onAttached,
}: AttachWorkspaceDialogProps) {
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<{
    target: Workspace;
    files: InspectAttachFilesResult;
  } | null>(null);
  const trashButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    setQuery("");
    setBusy(false);
    setErrorText(null);
    setPreflight(null);
  }, [open, chatId]);

  React.useEffect(() => {
    if (preflight) {
      trashButtonRef.current?.focus();
    }
  }, [preflight]);

  const candidates = React.useMemo(() => {
    const list = attachableProjectWorkspaces(workspaces);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return list;
    return list.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(trimmed) ||
        (workspace.folderPath?.toLowerCase().includes(trimmed) ?? false),
    );
  }, [query, workspaces]);

  const commitAttach = React.useCallback(
    async (target: Workspace, fileAction?: AttachFileAction) => {
      setBusy(true);
      setErrorText(null);
      try {
        beforeAttach?.();
        const result = await chatsApi.attachToWorkspace({
          chatId,
          targetWorkspaceId: target.id,
          ...(fileAction ? { fileAction } : {}),
        });
        await onAttached(result, target);
        onOpenChange(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not attach this chat to the workspace.";
        setErrorText(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [beforeAttach, chatId, onAttached, onOpenChange],
  );

  const pickWorkspace = React.useCallback(
    async (target: Workspace) => {
      setBusy(true);
      setErrorText(null);
      try {
        beforeAttach?.();
        const files = await chatsApi.inspectAttachFiles(chatId);
        if (files.hasFiles) {
          setPreflight({ target, files });
          setBusy(false);
          return;
        }
        await commitAttach(target);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not inspect chat files.";
        setErrorText(message);
        toast.error(message);
        setBusy(false);
      }
    },
    [beforeAttach, chatId, commitAttach],
  );

  const openFolderAndAttach = React.useCallback(async () => {
    setBusy(true);
    setErrorText(null);
    try {
      beforeAttach?.();
      const created = await workspacesApi.createFromFolder();
      if (!created) {
        setBusy(false);
        return;
      }
      onWorkspaceCreated?.(created);
      await pickWorkspace(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open folder.";
      setErrorText(message);
      toast.error(message);
      setBusy(false);
    }
  }, [beforeAttach, onWorkspaceCreated, pickWorkspace]);

  if (preflight) {
    const { target, files } = preflight;
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Attach to ${target.name}`}
        description="This chat created files in its temporary folder. Choose what to do with them before attaching."
        confirmLabel="Copy into workspace"
        onConfirm={() => void commitAttach(target, "copy")}
        cancelLabel="Back"
        cancelKeepsOpen
        onCancel={() => {
          setPreflight(null);
          setErrorText(null);
        }}
        busy={busy}
      >
        <div className="flex flex-col gap-3">
          <div className="max-h-44 overflow-y-auto rounded-card bg-well p-2.5">
            <ul className="flex flex-col gap-1.5 text-small">
              {files.entries.map((entry) => (
                <li
                  key={entry.relativePath}
                  className="flex items-center justify-between gap-2 font-mono text-primary"
                >
                  <span className="min-w-0 truncate">{entry.relativePath}</span>
                  <span className="shrink-0 text-tertiary">{formatBytes(entry.sizeBytes)}</span>
                </li>
              ))}
            </ul>
            {files.truncated ? (
              <p className="mt-1.5 text-mini text-tertiary">
                Showing first {files.entries.length} files ({formatBytes(files.totalBytes)} total).
              </p>
            ) : null}
          </div>
          {errorText ? (
            <p role="alert" className="rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red">
              {errorText}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-mini text-tertiary">
              Or leave these files in Trash and attach only the conversation.
            </span>
            <Button
              ref={trashButtonRef}
              variant="filled"
              size="small"
              disabled={busy}
              onClick={() => void commitAttach(target, "trash")}
            >
              Leave behind (Trash)
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Attach to workspace"
      description="Move this conversation into a project workspace so future replies work directly in that folder."
      confirmHidden
      cancelLabel="Cancel"
      busy={busy}
    >
      <div className="flex flex-col gap-2.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter workspaces…"
          aria-label="Filter workspaces"
          disabled={busy}
          autoFocus
        />
        <div className="max-h-56 overflow-y-auto rounded-card bg-well p-1.5">
          {candidates.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {candidates.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void pickWorkspace(workspace)}
                    className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-regular text-primary transition-colors hover:bg-list-hover disabled:opacity-50"
                  >
                    <Folder aria-hidden="true" className="size-4 shrink-0 text-toolbar-icon" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{workspace.name}</span>
                      {workspace.folderPath ? (
                        <span className="truncate text-mini text-tertiary">
                          {workspace.folderPath}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-center text-small text-secondary">
              No matching workspaces. Open a folder below to attach this chat.
            </p>
          )}
        </div>
        {errorText ? (
          <p role="alert" className="rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red">
            {errorText}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="filled"
            size="small"
            disabled={busy}
            onClick={() => void openFolderAndAttach()}
          >
            <FolderOpen aria-hidden="true" className="size-4" />
            Open folder…
          </Button>
          <span className="flex items-center gap-1 text-mini text-tertiary">
            <FolderPlus aria-hidden="true" className="size-3.5" />
            History stays intact
          </span>
        </div>
      </div>
    </Dialog>
  );
}
