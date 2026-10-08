// Read-only Files for a Bot: the files in its own folder, with a simple text
// viewer. Opened from the chat's ••• menu, or from a file chip at that file.

import * as React from "react";
import { ChevronLeft, File, Folder } from "lucide-react";
import { Button, Dialog, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { WorkspaceFileDocument, WorkspaceFileIndex } from "../../lib/types";

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; message: string };

export function BotFilesDialog({
  botId,
  botName,
  open,
  initialPath,
  onOpenChange,
}: {
  botId: string;
  botName: string;
  open: boolean;
  /** Opens straight to this file (a file chip). */
  initialPath?: string | null;
  onOpenChange(open: boolean): void;
}) {
  const [index, setIndex] = React.useState<Load<WorkspaceFileIndex>>({ status: "loading" });
  const [path, setPath] = React.useState<string | null>(initialPath ?? null);
  const [document, setDocument] = React.useState<Load<WorkspaceFileDocument> | null>(null);

  React.useEffect(() => {
    if (open) setPath(initialPath ?? null);
  }, [open, initialPath]);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setIndex({ status: "loading" });
    botsApi.files.list(botId).then(
      (value) => active && setIndex({ status: "ready", value }),
      (error: unknown) =>
        active && setIndex({ status: "failed", message: userFacingErrorMessage(error, `Aiden couldn’t load ${botName}’s files.`) }),
    );
    return () => {
      active = false;
    };
  }, [open, botId, botName]);

  React.useEffect(() => {
    if (!open || path === null) {
      setDocument(null);
      return;
    }
    let active = true;
    setDocument({ status: "loading" });
    botsApi.files.read(botId, path).then(
      (value) => active && setDocument({ status: "ready", value }),
      (error: unknown) =>
        active && setDocument({ status: "failed", message: userFacingErrorMessage(error, "Aiden couldn’t open that file.") }),
    );
    return () => {
      active = false;
    };
  }, [open, botId, path]);

  const files = index.status === "ready" ? index.value.entries : [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={path ?? `${botName}’s files`}
      confirmLabel="Done"
      onConfirm={() => onOpenChange(false)}
      size="large"
    >
      {path !== null ? (
        <div className="flex min-h-0 flex-col gap-2">
          <div>
            <Button variant="transparent" size="small" onClick={() => setPath(null)}>
              <ChevronLeft aria-hidden="true" />
              All files
            </Button>
          </div>
          {document === null || document.status === "loading" ? (
            <Text color="secondary">Loading…</Text>
          ) : document.status === "failed" ? (
            <Text color="secondary" role="alert">
              {document.message}
            </Text>
          ) : (
            <pre
              aria-label={`Contents of ${document.value.path}`}
              className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-control bg-control/50 p-3 font-mono text-small text-primary"
            >
              {document.value.content}
            </pre>
          )}
        </div>
      ) : index.status === "loading" ? (
        <Text color="secondary">Loading…</Text>
      ) : index.status === "failed" ? (
        <Text color="secondary" role="alert">
          {index.message}
        </Text>
      ) : files.length === 0 ? (
        <Text color="secondary">No files yet.</Text>
      ) : (
        <ul aria-label="Files" className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto">
          {files.map((entry) => (
            <li key={entry.path} style={{ paddingLeft: `${entry.depth * 12}px` }}>
              {entry.kind === "file" ? (
                <Button
                  variant="transparent"
                  size="medium"
                  className="w-full justify-start gap-2"
                  onClick={() => setPath(entry.path)}
                >
                  <File aria-hidden="true" />
                  <span className="truncate">{entry.name}</span>
                </Button>
              ) : (
                <span className="flex items-center gap-2 px-2 py-1 text-secondary">
                  <Folder aria-hidden="true" className="size-4" />
                  <span className="truncate">{entry.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
