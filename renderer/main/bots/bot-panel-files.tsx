// Files (spec §8): the files in the Bot's own folder, read-only, with a simple
// text viewer. A file chip in the chat opens this tab on that file through the
// panel's file request.

import * as React from "react";
import { ChevronLeft, File, Folder, RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, Text } from "../../components/ui";
import { botsApi, onNotification } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { WorkspaceFileDocument, WorkspaceFileIndex } from "../../lib/types";
import type { BotPanelFileRequest } from "./bot-panel-context";

/** A read that has shown something keeps it on screen through a refresh, and a refresh that fails says so above it. */
type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T; refreshError?: string }
  | { status: "failed"; message: string };

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
  // Try again re-reads only what failed: the list or the open file.
  const [listAttempt, setListAttempt] = React.useState(0);
  const [documentAttempt, setDocumentAttempt] = React.useState(0);
  // Opening a file or going back to All files unmounts the focused button; the
  // view that replaces it takes focus, so it never falls to the page (where
  // Escape no longer closes the panel). Only a person's choice here moves it.
  const focusAfterSwap = React.useRef<{ to: "heading" } | { to: "row"; path: string } | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const openFile = (next: string) => {
    focusAfterSwap.current = { to: "heading" };
    setPath(next);
  };
  const showAllFiles = () => {
    if (path !== null) focusAfterSwap.current = { to: "row", path };
    setPath(null);
  };

  React.useLayoutEffect(() => {
    const target = focusAfterSwap.current;
    focusAfterSwap.current = null;
    if (!target) return;
    if (target.to === "heading") {
      headingRef.current?.focus();
      return;
    }
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-file-path]") ?? []).find(
      (element) => element.dataset.filePath === target.path,
    );
    (row ?? listRef.current)?.focus();
  }, [path]);

  React.useLayoutEffect(() => {
    if (pendingKey === null || pendingPath === null) return;
    handledRequestKeys.set(botId, pendingKey);
    setPath(pendingPath);
  }, [botId, pendingKey, pendingPath]);

  // The Bot's session state changes as each turn starts and ends; re-read then
  // so a file it just wrote shows without pressing Refresh.
  React.useEffect(() => {
    if (!active) return;
    return onNotification<{ botId?: unknown; session?: unknown }>("bots:changed", (payload) => {
      if (payload?.botId !== botId || !("session" in payload)) return;
      setListAttempt((value) => value + 1);
      setDocumentAttempt((value) => value + 1);
    });
  }, [active, botId]);

  React.useEffect(() => {
    if (!active) return;
    let current = true;
    // Coming back into view re-reads the list behind the one on screen.
    setIndex((value) => (value.status === "ready" ? value : { status: "loading" }));
    botsApi.files.list(botId).then(
      (value) => {
        if (current) setIndex({ status: "ready", value });
      },
      (error: unknown) => {
        if (!current) return;
        const message = userFacingErrorMessage(error, `Aiden couldn’t load ${botName}’s files.`);
        setIndex((value) =>
          value.status === "ready" ? { status: "ready", value: value.value, refreshError: message } : { status: "failed", message },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [active, botId, botName, listAttempt]);

  React.useEffect(() => {
    if (path === null) {
      setDocument(null);
      return;
    }
    if (!active) return;
    let current = true;
    const showing = (value: Load<WorkspaceFileDocument> | null): value is Extract<Load<WorkspaceFileDocument>, { status: "ready" }> =>
      value?.status === "ready" && value.value.path === path;
    // The open file stays on screen while it is re-read; only another file shows the skeleton.
    setDocument((value) => (showing(value) ? value : { status: "loading" }));
    botsApi.files.read(botId, path).then(
      (value) => {
        if (current) setDocument({ status: "ready", value });
      },
      (error: unknown) => {
        if (!current) return;
        const message = userFacingErrorMessage(error, "Aiden couldn’t open that file.");
        setDocument((value) =>
          showing(value) ? { status: "ready", value: value.value, refreshError: message } : { status: "failed", message },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [active, botId, path, documentAttempt]);

  const retry = (message: string, onRetry: () => void) => (
    <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
      <Text variant="small" color="red">
        {message}
      </Text>
      <Button size="small" variant="filled" onClick={onRetry}>
        <RotateCcw /> Try again
      </Button>
    </Callout>
  );
  const retryList = () => setListAttempt((value) => value + 1);
  const retryDocument = () => setDocumentAttempt((value) => value + 1);
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
          <Button variant="transparent" size="small" onClick={showAllFiles}>
            <ChevronLeft aria-hidden="true" />
            All files
          </Button>
        </div>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="truncate rounded-control px-1 text-strong font-medium text-primary outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          title={path}
        >
          {path.split("/").pop() || path}
        </h2>
        {document === null || document.status === "loading" ? (
          loading("Opening file")
        ) : document.status === "failed" ? (
          retry(document.message, retryDocument)
        ) : (
          <>
            {document.refreshError ? retry(document.refreshError, retryDocument) : null}
            <pre
              aria-label={`Contents of ${document.value.path}`}
              className="select-text whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small text-primary"
            >
              {document.value.content}
            </pre>
          </>
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
      {index.status === "ready" && index.refreshError ? retry(index.refreshError, retryList) : null}
      {index.status === "loading" ? (
        loading("Loading files")
      ) : index.status === "failed" ? (
        retry(index.message, retryList)
      ) : files.length === 0 ? (
        <EmptyState
          placement="inline"
          title="No files yet"
          description={`When ${botName} writes a list, a note, or a plan, it shows up here.`}
        />
      ) : (
        <ul ref={listRef} aria-label="Files" tabIndex={-1} className="flex flex-col gap-0.5 outline-none">
          {files.map((entry) => (
            <li key={entry.path} style={{ paddingLeft: `${entry.depth * 16}px` }}>
              {entry.kind === "file" ? (
                <Button
                  variant="transparent"
                  size="medium"
                  className="w-full justify-start gap-2"
                  data-file-path={entry.path}
                  onClick={() => openFile(entry.path)}
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
