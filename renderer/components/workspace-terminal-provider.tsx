import * as React from "react";
import { toast } from "./ui";
import { onNotification, terminalApi, type TerminalSession } from "../lib/ipc";
import { useActiveWorkspace } from "../lib/workspace-context";
import { returnFocus } from "../lib/focus-return";

export const TERMINAL_PANEL_EVENT = "aiden:terminal-panel";
const PLACEMENT_KEY = "aiden-agent.terminal-placement";
export type TerminalPlacement = "bottom" | "side";
export const MAX_TERMINAL_PANES = 4;

export type TerminalSplitDirection = "single" | "horizontal" | "vertical";

export interface TerminalLayout {
  direction: TerminalSplitDirection;
  ids: string[];
}

export interface TerminalContextValue {
  open: boolean;
  requestedOpen: boolean;
  placement: TerminalPlacement;
  sideTarget: HTMLDivElement | null;
  setSideTarget: (target: HTMLDivElement | null) => void;
  setSidePresented: (presented: boolean) => void;
  moveTo: (placement: TerminalPlacement) => void;
  hide: () => void;
  sessions: TerminalSession[];
  /** The foreground program of each session that has one running. */
  foregroundCommands: Readonly<Record<string, string>>;
  activeId: string | undefined;
  layout: TerminalLayout;
  canOpen: boolean;
  /** Why the terminal can't open in this workspace, when it can't; null otherwise. */
  unavailableReason: string | null;
  toggle: () => void;
  newTerminal: () => Promise<void>;
  split: (direction: Exclude<TerminalSplitDirection, "single">) => Promise<void>;
  select: (id: string) => void;
  close: (id: string) => void;
}

const TerminalContext = React.createContext<TerminalContextValue | null>(null);

export function WorkspaceTerminalProvider({ children }: { children: React.ReactNode }) {
  const { active } = useActiveWorkspace();
  const [open, setOpen] = React.useState(false);
  const [placement, setPlacement] = React.useState<TerminalPlacement>(() =>
    localStorage.getItem(PLACEMENT_KEY) === "side" ? "side" : "bottom",
  );
  const [sideTarget, setSideTarget] = React.useState<HTMLDivElement | null>(null);
  const [sidePresented, setSidePresented] = React.useState(false);
  const hide = React.useCallback(() => setOpen(false), []);
  const [sessions, setSessions] = React.useState<TerminalSession[]>([]);
  const [foregroundCommands, setForegroundCommands] = React.useState<Readonly<Record<string, string>>>({});
  const [activeId, setActiveId] = React.useState<string>();
  const [layout, setLayout] = React.useState<TerminalLayout>({ direction: "single", ids: [] });
  const sessionsRef = React.useRef<TerminalSession[]>([]);
  const workspaceRef = React.useRef(active?.id);
  const creatingRef = React.useRef<Promise<TerminalSession | undefined> | null>(null);
  sessionsRef.current = sessions;

  const clearSessions = React.useCallback(() => {
    const previous = sessionsRef.current;
    sessionsRef.current = [];
    setSessions([]);
    setActiveId(undefined);
    setLayout({ direction: "single", ids: [] });
    for (const session of previous) void terminalApi.close(session.id).catch(() => undefined);
  }, []);

  // A terminal belongs to its workspace. Switching folders never leaves an
  // invisible shell running in the previous folder.
  React.useLayoutEffect(() => {
    if (workspaceRef.current !== active?.id) {
      workspaceRef.current = active?.id;
      clearSessions();
      setOpen(false);
    }
  }, [active?.id, clearSessions]);

  React.useEffect(() => () => clearSessions(), [clearSessions]);

  React.useEffect(() => {
    const removeExited = ({ sessionId }: { sessionId: string }) => {
      setSessions((previous) => previous.filter((session) => session.id !== sessionId));
      setLayout((previous) => ({
        ...previous,
        ids: previous.ids.filter((id) => id !== sessionId),
      }));
      setActiveId((previous) => (previous === sessionId ? undefined : previous));
      setForegroundCommands(({ [sessionId]: _exited, ...others }) => others);
    };
    return onNotification("terminal:exit", removeExited);
  }, []);

  React.useEffect(() => {
    const updateForeground = ({ sessionId, command }: { sessionId: string; command: string | null }) => {
      setForegroundCommands(({ [sessionId]: _previous, ...others }) =>
        command === null ? others : { ...others, [sessionId]: command },
      );
    };
    return onNotification("terminal:activity", updateForeground);
  }, []);

  const create = React.useCallback((): Promise<TerminalSession | undefined> => {
    if (creatingRef.current) return creatingRef.current;
    const pending = (async () => {
      if (!active?.folderPath || active.permission === "none") {
        toast.error(
          "Choose a folder workspace and enable workspace access before opening a terminal.",
        );
        return undefined;
      }
      try {
        const session = await terminalApi.create(active.id);
        if (workspaceRef.current !== active.id) {
          await terminalApi.close(session.id).catch(() => undefined);
          return undefined;
        }
        // Surface once when the preferred shell was unavailable and a fallback
        // launched the terminal — the user should know their $SHELL is broken.
        if (session.preferredShellSkipped) {
          toast.info(
            `Used ${session.resolvedShell} because $SHELL was unavailable. Check your shell preference if this is unexpected.`,
          );
        }
        setSessions((previous) => [...previous, session]);
        setActiveId(session.id);
        setOpen(true);
        return session;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't start a terminal.");
        return undefined;
      }
    })();
    creatingRef.current = pending;
    void pending.finally(() => {
      if (creatingRef.current === pending) creatingRef.current = null;
    });
    return pending;
  }, [active]);

  const newTerminal = React.useCallback(async () => {
    const session = await create();
    if (!session) return;
    setLayout({ direction: "single", ids: [session.id] });
  }, [create]);

  const split = React.useCallback(
    async (direction: Exclude<TerminalSplitDirection, "single">) => {
      const base =
        activeId && layout.ids.includes(activeId) ? layout.ids : activeId ? [activeId] : [];
      if (base.length >= MAX_TERMINAL_PANES) {
        toast.info(`A terminal group can show up to ${MAX_TERMINAL_PANES} panes.`);
        return;
      }
      const session = await create();
      if (!session) return;
      setLayout({ direction, ids: [...base, session.id] });
    },
    [activeId, create, layout.ids],
  );

  const close = React.useCallback((id: string) => {
    void terminalApi.close(id).catch(() => undefined);
    setSessions((previous) => previous.filter((session) => session.id !== id));
    setLayout((previous) => ({
      ...previous,
      ids: previous.ids.filter((sessionId) => sessionId !== id),
    }));
    setActiveId((previous) =>
      previous === id ? sessionsRef.current.find((session) => session.id !== id)?.id : previous,
    );
  }, []);

  const moveTo = React.useCallback(
    (next: TerminalPlacement) => {
      setPlacement(next);
      localStorage.setItem(PLACEMENT_KEY, next);
      setOpen(true);
      window.dispatchEvent(
        new CustomEvent(TERMINAL_PANEL_EVENT, { detail: next === "side" ? "show" : "bottom" }),
      );
      if (!sessionsRef.current.length) void newTerminal();
    },
    [newTerminal],
  );

  const toggle = React.useCallback(() => {
    if (placement === "side" && (!open || !sidePresented)) {
      moveTo("side");
      return;
    }
    if (open) {
      const hadTerminalFocus =
        document.activeElement instanceof Element &&
        document.activeElement.closest(".terminal-drawer");
      setOpen(false);
      if (placement === "side")
        window.dispatchEvent(new CustomEvent(TERMINAL_PANEL_EVENT, { detail: "hide" }));
      if (hadTerminalFocus)
        requestAnimationFrame(() =>
          returnFocus([...document.querySelectorAll<HTMLElement>("[data-terminal-toggle]")], {
            closing: hadTerminalFocus,
          }),
        );
    } else if (sessions.length > 0) {
      setOpen(true);
    } else {
      void newTerminal();
    }
  }, [newTerminal, open, sessions.length, placement, sidePresented, moveTo]);

  const value = React.useMemo<TerminalContextValue>(
    () => ({
      open: open && (placement === "bottom" || sidePresented),
      requestedOpen: open,
      placement,
      sideTarget,
      setSideTarget,
      setSidePresented,
      moveTo,
      hide,
      sessions,
      foregroundCommands,
      activeId,
      layout,
      canOpen: Boolean(active?.folderPath && active.permission !== "none"),
      unavailableReason: !active?.folderPath
        ? "Choose a workspace folder to use the terminal."
        : active.permission === "none"
          ? "Workspace access is off for this folder, so the terminal can't open."
          : null,
      toggle,
      newTerminal,
      split,
      select: (id) => {
        setActiveId(id);
        setLayout((previous) =>
          previous.ids.includes(id) ? previous : { direction: "single", ids: [id] },
        );
      },
      close,
    }),
    [
      placement,
      sideTarget,
      sidePresented,
      moveTo,
      hide,
      active?.folderPath,
      active?.permission,
      activeId,
      close,
      layout,
      newTerminal,
      open,
      foregroundCommands,
      sessions,
      split,
      toggle,
    ],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useWorkspaceTerminal(): TerminalContextValue {
  const context = React.useContext(TerminalContext);
  if (!context)
    throw new Error("useWorkspaceTerminal must be used inside WorkspaceTerminalProvider.");
  return context;
}

export function TerminalSideTarget({ presented }: { presented: boolean }) {
  const { setSideTarget, setSidePresented } = useWorkspaceTerminal();
  React.useLayoutEffect(() => {
    setSidePresented(presented);
    return () => setSidePresented(false);
  }, [presented, setSidePresented]);
  return <div ref={setSideTarget} className="h-full min-h-0" />;
}
