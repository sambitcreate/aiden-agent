import * as React from "react";

export interface TerminalCloseRequest {
  id: string;
  label: string;
  command: string;
}

interface Options {
  /** Terminals still open; a question about one that ended is dropped. */
  sessionIds: readonly string[];
  /** The program a close would stop, or null when nothing would be lost. */
  foregroundCommand: (id: string) => Promise<string | null>;
  close: (id: string) => void;
}

/**
 * A terminal's close button: closes at once when nothing is running, and asks
 * first otherwise. The check can take a moment while the main process watches
 * a busy shell, so a second click on the same tab waits for the first, and only
 * the latest click's answer counts. An earlier, slower answer about another tab
 * must not replace the open question or close a terminal behind it.
 */
export function useTerminalCloseRequest({ sessionIds, foregroundCommand, close }: Options) {
  const [request, setRequest] = React.useState<TerminalCloseRequest | null>(null);
  const pending = request && sessionIds.includes(request.id) ? request : null;
  const sessionIdsRef = React.useRef(sessionIds);
  sessionIdsRef.current = sessionIds;
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;
  const checkingRef = React.useRef(new Set<string>());
  const generationRef = React.useRef(0);

  const requestClose = React.useCallback(
    async (id: string, label: string) => {
      if (checkingRef.current.has(id) || pendingRef.current?.id === id) return;
      checkingRef.current.add(id);
      const generation = ++generationRef.current;
      let command: string | null;
      try {
        command = await foregroundCommand(id).catch(() => null);
      } finally {
        checkingRef.current.delete(id);
      }
      if (generation !== generationRef.current || !sessionIdsRef.current.includes(id)) return;
      if (command) setRequest({ id, label, command });
      else close(id);
    },
    [foregroundCommand, close],
  );
  const confirm = React.useCallback(() => {
    const current = pendingRef.current;
    if (current) close(current.id);
    setRequest(null);
  }, [close]);
  const dismiss = React.useCallback(() => setRequest(null), []);
  return { pending, requestClose, confirm, dismiss };
}
