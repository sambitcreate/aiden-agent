// Files (spec §8): the files in the Bot's own folder, read-only, with a simple
// text viewer. A file chip in the chat opens this tab on that file through the
// panel's file request.

import * as React from "react";
import { ChevronLeft, File, Folder, RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { WorkspaceFileDocument, WorkspaceFileIndex } from "../../lib/types";
import type { BotPanelFileRequest } from "./bot-panel-context";

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; message: string };

/**
 * The last file request each Bot's Files tab applied. It outlives the tab, so a
 * remount (leaving the chat and coming back) never reopens an old request.
 */
const handledRequestKeys = new Map<string, number>();

function unhandledRequest(botId: string, request: BotPanelFileRequest | null): BotPanelFileRequest | null {
  return request && request.botId === botId && handledRequestKeys.get(botId) !== request.key ? request : null;
}

export function BotPanelFiles({
  botId,
  botName,
  active,
  request,
}: {
  botId: string;
  botName: string;
  /** The tab is visible: the list is read each time it comes into view. */
  active: boolean;
  /** Applied once, and only when it is for this Bot. */
  request: BotPanelFileRequest | null;
}) {
  const pending = unhandledRequest(botId, request);
  const pendingKey = pending?.key ?? null;
  const pendingPath = pending?.path ?? null;
  const [index, setIndex] = React.useState<Load<WorkspaceFileIndex>>({ status: "loading" });
  const [path, setPath] = React.useState<string | null>(() => pendingPath);
  const [document, setDocument] = React.useState<Load<WorkspaceFileDocument> | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useLayoutEffect(() => {
    if (pendingKey === null || pendingPath === null) return;
    handledRequestKeys.set(botId, pendingKey);
    setPath(pendingPath);
  }, [botId, pendingKey, pendingPath]);

  React.useEffect(() => {
    if (!active) return;
    let current = true;
    // A refresh keeps the list it has on screen; only a first read shows rows loading.
    setIndex((value) => (value.status === "ready" ? value : { status: "loading" }));
    botsApi.files.list(botId).then(
      (value) => {
        if (current) setIndex({ status: "ready", value });
      },
      (error: unknown) => {
        if (!current) return;
        const message = userFacingErrorMessage(error, `Aiden couldn’t load ${botName}’s files.`);
        setIndex((value) => (value.status === "ready" ? value : { status: "failed", message }));
      },
    );
    return () => {
      current = false;
    };
  }, [active, botId, botName, attempt]);

  React.useEffect(() => {
    if (path === null) {
      setDocument(null);
      return;
    }
    if (!active) return;
    let current = true;
    setDocument({ status: "loading" });
    botsApi.files.read(botId, path).then(
      (value) => {
        if (current) setDocument({ status: "ready", value });
      },
      (error: unknown) => {
        if (current) setDocument({ status: "failed", message: userFacingErrorMessage(error, "Aiden couldn’t open that file.") });
      },
    );
    return () => {
      current = false;
    };
  }, [active, botId, path, attempt]);

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
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-7 w-full rounded-control bg-well motion-safe:animate-pulse" />
      ))}
    </div>
  );

  if (path !== null) {
    return (
      <div className="flex min-h-0 flex-col gap-2">
        <div>
          <Button variant="transparent" size="small" onClick={() => setPath(null)}>
            <ChevronLeft aria-hidden="true" />
            All files
          </Button>
        </div>
        <Text as="h3" variant="strong" className="truncate px-1" title={path}>
          {path.split("/").pop() || path}
        </Text>
        {document === null || document.status === "loading" ? (
          loading("Opening file")
        ) : document.status === "failed" ? (
          retry(document.message)
        ) : (
          <pre
            aria-label={`Contents of ${document.value.path}`}
            className="select-text whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small text-primary"
          >
            {document.value.content}
          </pre>
        )}
      </div>
    );
  }

  const files = index.status === "ready" ? index.value.entries : [];
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Text as="p" variant="small" color="secondary" className="px-1">
        {`Files ${botName} made or saved while helping you.`}
      </Text>
      {index.status === "loading" ? (
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
        <ul aria-label="Files" className="flex flex-col gap-0.5">
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
    </div>
  );
}
