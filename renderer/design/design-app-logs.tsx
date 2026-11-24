// The live app's logs drawer (design mode v2, Phase 2c, D4). Show logs in the
// chip's menu opens it, docked to the bottom of the canvas. It reads the dev
// server's own output by run and byte cursor, never through a terminal: the
// output is untrusted, so escape sequences are removed (also across reads)
// and hidden characters are shown as escapes. It is read-only text in a
// <pre>, never markup and never links.

import { X } from "lucide-react";
import * as React from "react";
import { Button } from "../components/ui";
import { designAppApi } from "../lib/ipc";
import { useLayer } from "../lib/layer-stack";
import { usePresence } from "../lib/use-presence";
import { consentDisplayText, EMPTY_LOG_CARRY, logDisplayChunk, type DesignAppLogs, type LogCarry } from "../shared/design-app";
import { designAppStatusLine, useDesignAppsSnapshot } from "./design-app-chip";
import { useDesignPane } from "./design-pane";

/** How much of a run the drawer starts with and keeps (D4). */
export const DESIGN_APP_LOGS_KEEP = 256 * 1024;
const POLL_MS = 1000;
const DROPPED = "Earlier output was dropped";
const NEW_RUN = "New run";
const SKIPPED = "Output was skipped to show the latest";

type Chunk = { id: number; kind: "text"; text: string } | { id: number; kind: "note"; text: string };

interface Cursor {
  run: string;
  next: number;
}

/** Appends cleaned text to the kept chunks, keeping at most `DESIGN_APP_LOGS_KEEP` characters of output. */
function keep(chunks: readonly Chunk[], added: readonly Chunk[]): Chunk[] {
  let next = [...chunks, ...added];
  let size = next.reduce((total, chunk) => total + (chunk.kind === "text" ? chunk.text.length : 0), 0);
  if (size <= DESIGN_APP_LOGS_KEEP) return next;
  let dropped = false;
  while (size > DESIGN_APP_LOGS_KEEP && next.length > 0) {
    const [first, ...rest] = next;
    next = rest;
    if (first!.kind === "text") size -= first!.text.length;
    dropped = true;
  }
  // The new first chunk starts at a line, so no half line shows at the top.
  const firstText = next.findIndex((chunk) => chunk.kind === "text");
  if (dropped && firstText >= 0) {
    const chunk = next[firstText] as Extract<Chunk, { kind: "text" }>;
    const newline = chunk.text.indexOf("\n");
    const text = newline < 0 ? "" : chunk.text.slice(newline + 1);
    next = [...next.slice(0, firstText), { ...chunk, text }, ...next.slice(firstText + 1)];
  }
  // One dropped line stays on top.
  while (next[0]?.kind === "note") next = next.slice(1);
  return [{ id: -1, kind: "note", text: DROPPED }, ...next];
}

/**
 * Reads the app's log while `active`: a probe from 0, a start at the last
 * `DESIGN_APP_LOGS_KEEP` bytes, catch-up reads while behind, then one read a
 * second. The cursor and the cleaner's carry survive pauses; a new `appRoot`
 * starts over. A read that finds more than `DESIGN_APP_LOGS_KEEP` bytes still
 * to read (after a pause, or a long new run) drops what the drawer holds and
 * jumps to the last `DESIGN_APP_LOGS_KEEP` bytes, so catching up is bounded (B2).
 */
function useDesignAppLog(chatId: string, appRoot: string, active: boolean, pollMs: number): readonly Chunk[] {
  const [chunks, setChunks] = React.useState<readonly Chunk[]>([]);
  const cursor = React.useRef<Cursor | null>(null);
  const carry = React.useRef<LogCarry>(EMPTY_LOG_CARRY);
  const ids = React.useRef(0);

  React.useEffect(() => {
    cursor.current = null;
    carry.current = EMPTY_LOG_CARRY;
    setChunks([]);
  }, [chatId, appRoot]);

  React.useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const note = (text: string): Chunk => ({ id: (ids.current += 1), kind: "note", text });
    const clean = (text: string): Chunk[] => {
      const cleaned = logDisplayChunk(text, carry.current);
      carry.current = cleaned.carry;
      return cleaned.text ? [{ id: (ids.current += 1), kind: "text", text: cleaned.text }] : [];
    };
    const add = (added: Chunk[]) => {
      if (added.length > 0) setChunks((current) => keep(current, added));
    };

    const read = async (): Promise<boolean> => {
      const at = cursor.current;
      let answer: DesignAppLogs;
      if (!at) {
        answer = await designAppApi.logs(chatId, appRoot, { after: 0 });
        if (!live || answer.run === undefined) return false;
        if (answer.end > DESIGN_APP_LOGS_KEEP) {
          // Too much to show: drop the probe's text and start at the last 256 KiB.
          carry.current = EMPTY_LOG_CARRY;
          add([note(DROPPED)]);
          cursor.current = { run: answer.run, next: answer.end - DESIGN_APP_LOGS_KEEP };
          return true;
        }
        add([...(answer.truncated ? [note(DROPPED)] : []), ...clean(answer.text)]);
        cursor.current = { run: answer.run, next: answer.next };
        return answer.next < answer.end && answer.next > 0;
      }
      answer = await designAppApi.logs(chatId, appRoot, { run: at.run, after: at.next });
      if (!live || answer.run === undefined) return false;
      if (answer.end - answer.next > DESIGN_APP_LOGS_KEEP) {
        carry.current = EMPTY_LOG_CARRY;
        setChunks([note(SKIPPED)]);
        cursor.current = { run: answer.run, next: answer.end - DESIGN_APP_LOGS_KEEP };
        return true;
      }
      const newRun = answer.run !== at.run;
      if (newRun || answer.truncated) carry.current = EMPTY_LOG_CARRY;
      add([...(newRun ? [note(NEW_RUN)] : answer.truncated ? [note(DROPPED)] : []), ...clean(answer.text)]);
      cursor.current = { run: answer.run, next: answer.next };
      const advanced = newRun || answer.next > at.next;
      return advanced && answer.next < answer.end;
    };

    const loop = async () => {
      let again = false;
      try {
        again = await read();
      } catch {
        // A failed read waits for the next poll; the drawer keeps what it has.
      }
      if (!live) return;
      timer = setTimeout(() => void loop(), again ? 0 : pollMs);
    };
    void loop();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, chatId, appRoot, pollMs]);

  return chunks;
}

export function DesignAppLogsDrawer({
  chatId,
  appRoot,
  onClose,
  returnFocus,
  pollMs = POLL_MS,
}: {
  chatId: string;
  /** The app whose output shows; null when the drawer is closed. */
  appRoot: string | null;
  onClose: () => void;
  /** The element focus goes back to when the drawer closes: the chip. */
  returnFocus?: () => HTMLElement | null;
  /** For tests: the wait between reads that found nothing new. */
  pollMs?: number;
}) {
  const open = appRoot !== null;
  const [shown, setShown] = React.useState(appRoot);
  if (appRoot !== null && appRoot !== shown) setShown(appRoot);
  const root = appRoot ?? shown;
  const ref = React.useRef<HTMLDivElement>(null);
  const { rendered, exiting } = usePresence(open, ref);

  const close = React.useCallback(() => {
    onClose();
    returnFocus?.()?.focus();
  }, [onClose, returnFocus]);
  useLayer(open, "panel", { name: "design-app-logs", onEscape: close });

  if (!rendered || root === null) return null;
  return (
    <div
      ref={ref}
      data-presence={exiting ? "exiting" : "visible"}
      className="design-app-logs glass-surface absolute inset-x-3 bottom-3 z-10 flex flex-col overflow-hidden rounded-button shadow-control"
    >
      <DesignAppLogsBody chatId={chatId} appRoot={root} open={open} onClose={close} pollMs={pollMs} />
    </div>
  );
}

function DesignAppLogsBody({
  chatId,
  appRoot,
  open,
  onClose,
  pollMs,
}: {
  chatId: string;
  appRoot: string;
  open: boolean;
  onClose: () => void;
  pollMs: number;
}) {
  const snapshot = useDesignAppsSnapshot(chatId, true);
  const app = snapshot ? snapshot.apps.find((candidate) => candidate.appRoot === appRoot) : undefined;
  // Reads only while open, while the canvas is shown (never document.visibilityState, B-m1), and while the app is known.
  const { stacked, pane } = useDesignPane();
  const visible = !stacked || pane === "canvas";
  const gone = snapshot !== undefined && app === undefined;
  const chunks = useDesignAppLog(chatId, appRoot, open && visible && !gone, pollMs);

  const output = React.useRef<HTMLPreElement>(null);
  const [following, setFollowing] = React.useState(true);
  const followingRef = React.useRef(true);
  React.useLayoutEffect(() => {
    const element = output.current;
    if (element && followingRef.current) element.scrollTop = element.scrollHeight;
  }, [chunks]);
  React.useEffect(() => {
    if (open) output.current?.focus({ preventScroll: true });
  }, [open]);

  const onScroll = () => {
    const element = output.current;
    if (!element) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 4;
    followingRef.current = atEnd;
    setFollowing(atEnd);
  };
  const jump = () => {
    const element = output.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  };

  const label = `${app?.frameworkLabel ?? "App"} · ${consentDisplayText(appRoot)}`;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-small font-medium text-primary">
            Logs: <span className="font-mono">{label}</span>
          </h2>
          {app ? <p className="truncate text-small text-secondary">{designAppStatusLine(app)}</p> : null}
        </div>
        {following ? null : (
          <Button variant="bar" size="small" onClick={jump}>
            Jump to latest
          </Button>
        )}
        <Button variant="bar" size="small" iconOnly aria-label="Close logs" title="Close logs" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <pre
        ref={output}
        role="log"
        aria-live="off"
        aria-label={`Output of ${label}`}
        tabIndex={0}
        onScroll={onScroll}
        className="design-app-logs-output min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-small text-primary"
      >
        {chunks.map((chunk) =>
          chunk.kind === "note" ? (
            <span key={chunk.id} className="my-1 block text-tertiary">
              {chunk.text}
            </span>
          ) : (
            <React.Fragment key={chunk.id}>{chunk.text}</React.Fragment>
          ),
        )}
      </pre>
    </>
  );
}
