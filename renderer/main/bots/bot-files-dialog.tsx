// Read-only Files for a Bot: the files in its own folder, with a simple text
// viewer. Opened from the chat's ••• menu, or from a file chip at that file.

import * as React from "react";
import { ChevronLeft, File, Folder, RotateCcw } from "lucide-react";
import { Button, Callout, Dialog, EmptyState, Text } from "../../components/ui";
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
  const [attempt, setAttempt] = React.useState(0);

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
  }, [open, botId, botName, attempt]);

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
  }, [open, botId, path, attempt]);

  const files = index.status === "ready" ? index.value.entries : [];
  const fileName = path?.split("/").pop() || path;
  const retry = (message: string) => (
    <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
      <Text variant="small" color="red">
        {message}
      </Text>
      <Button size="small" variant="filled" onClick={() => setAttempt((value) => value + 1)}>
        <RotateCcw /> Try again
      </Button>
    </Callout>
  );
  const loading = (label: string) => (
    <div role="status" aria-label={label} className="space-y-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-7 w-full rounded-control bg-well motion-safe:animate-pulse" />
      ))}
    </div>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={path !== null ? fileName : `${botName}’s files`}
      description={path !== null ? path : `Files ${botName} made or saved while helping you.`}
      confirmHidden
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
            loading("Opening file")
          ) : document.status === "failed" ? (
            retry(document.message)
          ) : (
            <pre
              aria-label={`Contents of ${document.value.path}`}
              className="max-h-[60vh] select-text overflow-auto whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small text-primary"
            >
              {document.value.content}
            </pre>
          )}
        </div>
      ) : index.status === "loading" ? (
        loading("Loading files")
      ) : index.status === "failed" ? (
        retry(index.message)
      ) : files.length === 0 ? (
        <EmptyState
          placement="inline"
          title="No files yet"
          description={`When ${botName} writes a list, a note, or a plan, it shows up here.`}
        />
      ) : (
        <ul aria-label="Files" className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto">
          {files.map((entry) => (
            <li key={entry.path} style={{ paddingLeft: `${entry.depth * 16}px` }}>
              {entry.kind === "file" ? (
                <Button
                  variant="transparent"
                  size="medium"
                  className="w-full justify-start gap-2"
                  onClick={() => setPath(entry.path)}
                >
                  <File aria-hidden="true" className="text-secondary" />
                  <span className="truncate">{entry.name}</span>
                </Button>
              ) : (
                <span className="flex h-8 items-center gap-2 px-4 text-secondary">
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
