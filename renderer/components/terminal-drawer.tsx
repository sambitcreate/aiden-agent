// Bottom terminal drawer inspired by T3 Code's persistent terminal surface:
// sessions stay attached to the active workspace and can be opened, split,
// resized, or hidden without leaving the chat.

import * as React from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Minus, PanelBottomClose, Plus, SquareSplitHorizontal, SquareSplitVertical, TerminalSquare, X } from "lucide-react";
import { Button, Text, toast } from "./ui";
import { cn } from "../lib/ui-utils";
import { onNotification, terminalApi, type TerminalSession } from "../lib/ipc";
import { useActiveWorkspace } from "../lib/workspace-context";

const MIN_DRAWER_HEIGHT = 152;
const MAX_DRAWER_RATIO = 0.5;
const MIN_CHAT_HEIGHT = 320;
const DEFAULT_DRAWER_HEIGHT = 232;
const MAX_PANES = 4;
const HEIGHT_STORAGE_KEY = "aiden-agent.terminal-height-v2";

type SplitDirection = "single" | "horizontal" | "vertical";

interface Layout {
  direction: SplitDirection;
  ids: string[];
}

interface TerminalContextValue {
  open: boolean;
  sessions: TerminalSession[];
  activeId: string | undefined;
  layout: Layout;
  canOpen: boolean;
  toggle: () => void;
  newTerminal: () => Promise<void>;
  split: (direction: Exclude<SplitDirection, "single">) => Promise<void>;
  select: (id: string) => void;
  close: (id: string) => void;
}

const TerminalContext = React.createContext<TerminalContextValue | null>(null);

function maxDrawerHeight(): number {
  return Math.max(
    MIN_DRAWER_HEIGHT,
    Math.min(Math.floor(window.innerHeight * MAX_DRAWER_RATIO), window.innerHeight - MIN_CHAT_HEIGHT),
  );
}

function clampHeight(height: number): number {
  return Math.min(maxDrawerHeight(), Math.max(MIN_DRAWER_HEIGHT, Math.round(height)));
}

function initialHeight(): number {
  const saved = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
  return clampHeight(Number.isFinite(saved) ? saved : DEFAULT_DRAWER_HEIGHT);
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return {
    background: dark ? "#101216" : "#f9fafb",
    foreground: dark ? "#f4f5f7" : "#1d2530",
    cursor: dark ? "#a8cbff" : "#1a365d",
    selectionBackground: dark ? "rgba(168, 203, 255, 0.26)" : "rgba(26, 54, 93, 0.2)",
    black: dark ? "#222833" : "#2d3643",
    red: dark ? "#ff8b9c" : "#bd4c5f",
    green: dark ? "#9de8ae" : "#367a56",
    yellow: dark ? "#f4d27b" : "#98732b",
    blue: dark ? "#9cc4ff" : "#486aa9",
    magenta: dark ? "#dcbaff" : "#885a9d",
    cyan: dark ? "#91e9ee" : "#367d8c",
    white: dark ? "#dbe2ed" : "#dbe2ed",
    brightBlack: dark ? "#8490a2" : "#738096",
    brightRed: dark ? "#ffb1bc" : "#d36c7a",
    brightGreen: dark ? "#b5f1c1" : "#609d7c",
    brightYellow: dark ? "#f9e5b0" : "#b79350",
    brightBlue: dark ? "#c0daff" : "#7797c9",
    brightMagenta: dark ? "#eccfff" : "#a784b6",
    brightCyan: dark ? "#c1f6f7" : "#6eabb2",
    brightWhite: dark ? "#ffffff" : "#ffffff",
  };
}

export function WorkspaceTerminalProvider({ children }: { children: React.ReactNode }) {
  const { active } = useActiveWorkspace();
  const [open, setOpen] = React.useState(false);
  const [sessions, setSessions] = React.useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = React.useState<string>();
  const [layout, setLayout] = React.useState<Layout>({ direction: "single", ids: [] });
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
  React.useEffect(() => {
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
      setLayout((previous) => ({ ...previous, ids: previous.ids.filter((id) => id !== sessionId) }));
      setActiveId((previous) => (previous === sessionId ? undefined : previous));
    };
    return onNotification("terminal:exit", removeExited);
  }, []);

  const create = React.useCallback((): Promise<TerminalSession | undefined> => {
    if (creatingRef.current) return creatingRef.current;
    const pending = (async () => {
      if (!active?.folderPath || active.permission === "none") {
        toast.error("Choose a folder workspace and enable workspace access before opening a terminal.");
        return undefined;
      }
      try {
        const session = await terminalApi.create(active.id);
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

  const split = React.useCallback(async (direction: Exclude<SplitDirection, "single">) => {
    const base = activeId && layout.ids.includes(activeId) ? layout.ids : activeId ? [activeId] : [];
    if (base.length >= MAX_PANES) {
      toast.info(`A terminal group can show up to ${MAX_PANES} panes.`);
      return;
    }
    const session = await create();
    if (!session) return;
    setLayout({ direction, ids: [...base, session.id] });
  }, [activeId, create, layout.ids]);

  const close = React.useCallback((id: string) => {
    void terminalApi.close(id).catch(() => undefined);
    setSessions((previous) => previous.filter((session) => session.id !== id));
    setLayout((previous) => ({ ...previous, ids: previous.ids.filter((sessionId) => sessionId !== id) }));
    setActiveId((previous) => previous === id ? sessionsRef.current.find((session) => session.id !== id)?.id : previous);
  }, []);

  const toggle = React.useCallback(() => {
    if (open) {
      const hadTerminalFocus = document.activeElement instanceof Element && document.activeElement.closest(".terminal-drawer");
      setOpen(false);
      if (hadTerminalFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-terminal-toggle]")?.focus());
    } else if (sessions.length > 0) {
      setOpen(true);
    } else {
      void newTerminal();
    }
  }, [newTerminal, open, sessions.length]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const value = React.useMemo<TerminalContextValue>(() => ({
    open,
    sessions,
    activeId,
    layout,
    canOpen: Boolean(active?.folderPath && active.permission !== "none"),
    toggle,
    newTerminal,
    split,
    select: (id) => {
      setActiveId(id);
      setLayout((previous) => previous.ids.includes(id) ? previous : { direction: "single", ids: [id] });
    },
    close,
  }), [active?.folderPath, active?.permission, activeId, close, layout, newTerminal, open, sessions, split, toggle]);

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useWorkspaceTerminal(): TerminalContextValue {
  const context = React.useContext(TerminalContext);
  if (!context) throw new Error("useWorkspaceTerminal must be used inside WorkspaceTerminalProvider.");
  return context;
}

function TerminalViewport({ session, active, onFocus, onUnavailable, clearEpoch }: {
  session: TerminalSession;
  active: boolean;
  onFocus: () => void;
  onUnavailable: () => void;
  clearEpoch: number;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const xtermRef = React.useRef<Xterm | null>(null);
  const onUnavailableRef = React.useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new Xterm({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    xtermRef.current = xterm;
    const resize = () => {
      try {
        fit.fit();
        void terminalApi.resize(session.id, xterm.cols, xterm.rows).catch(() => undefined);
      } catch {
        // The host can briefly have zero size during drawer animation.
      }
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(resize));
    observer.observe(host);
    let hydrated = false;
    let lastSequence = 0;
    const queuedData: Array<{ sequence: number; data: string }> = [];
    const writeData = (event: { sequence: number; data: string }) => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      xterm.write(event.data);
    };
    const cancelData = onNotification<{ sessionId: string; sequence: number; data: string }>("terminal:data", (event) => {
      if (event.sessionId !== session.id) return;
      if (!hydrated) queuedData.push(event);
      else writeData(event);
    });
    void terminalApi.snapshot(session.id).then(({ buffer, sequence }) => {
      if (xtermRef.current !== xterm) return;
      if (buffer) xterm.write(buffer);
      lastSequence = sequence;
      hydrated = true;
      for (const event of queuedData) writeData(event);
      resize();
    }).catch(() => {
      // Electron's main process can restart during development. Remove the
      // renderer-side tab instead of leaving an inert terminal pane behind.
      onUnavailableRef.current();
    });
    const disposeInput = xterm.onData((data) => void terminalApi.write(session.id, data).catch(() => undefined));
    xterm.attachCustomKeyEventHandler((event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") return false;
      return true;
    });
    requestAnimationFrame(resize);
    return () => {
      cancelData();
      observer.disconnect();
      disposeInput.dispose();
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [session.id]);

  React.useEffect(() => {
    if (active) requestAnimationFrame(() => xtermRef.current?.focus());
  }, [active]);

  React.useEffect(() => {
    if (clearEpoch > 0) xtermRef.current?.clear();
  }, [clearEpoch]);

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      if (xtermRef.current) xtermRef.current.options.theme = terminalTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={hostRef} onMouseDown={onFocus} className="h-full min-h-0 w-full select-text p-2" />;
}

export function TerminalDrawer() {
  const { open, sessions, activeId, layout, canOpen, toggle, newTerminal, split, select, close } = useWorkspaceTerminal();
  const [height, setHeight] = React.useState(initialHeight);
  const [clearEpoch, setClearEpoch] = React.useState(0);
  const resizeRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  const heightRef = React.useRef(height);
  heightRef.current = height;
  const visibleIds = layout.ids.filter((id) => sessions.some((session) => session.id === id));
  const visibleSessions = visibleIds.length > 0
    ? visibleIds.map((id) => sessions.find((session) => session.id === id)!).filter(Boolean)
    : activeId ? sessions.filter((session) => session.id === activeId) : [];
  const canSplit = visibleSessions.length < MAX_PANES;

  React.useEffect(() => {
    const onResize = () => setHeight((current) => clampHeight(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startY: event.clientY, startHeight: height };
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    setHeight(clampHeight(resizeRef.current.startHeight + resizeRef.current.startY - event.clientY));
  };
  const endResize = () => {
    resizeRef.current = null;
    localStorage.setItem(HEIGHT_STORAGE_KEY, String(heightRef.current));
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHeight((current) => clampHeight(current + increment));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHeight((current) => clampHeight(current - increment));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHeight(MIN_DRAWER_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      setHeight(maxDrawerHeight());
    }
  };

  // T3 Code removes its drawer from the layout when closed rather than
  // shrinking a still-painted terminal to zero. Keeping it mounted created a
  // phantom dark surface at the bottom of Aiden's chat column.
  if (!open) return null;

  return (
    <section
      className="terminal-drawer relative shrink-0 overflow-hidden border-t border-separator bg-popover"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label="Resize terminal drawer"
        aria-orientation="horizontal"
        aria-valuemin={MIN_DRAWER_HEIGHT}
        aria-valuemax={maxDrawerHeight()}
        aria-valuenow={height}
        tabIndex={open ? 0 : -1}
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator hover:before:bg-accent"
      />
      <div className="flex h-full min-h-0 flex-col">
        <header className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
          <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1" aria-label="Terminal tabs">
            {sessions.map((session, index) => {
              const selected = activeId === session.id;
              return (
                <div
                  key={session.id}
                  className={cn(
                    "group flex h-7 shrink-0 items-center gap-1 rounded-[9px] border px-1.5 text-small transition-colors",
                    selected
                      ? "border-field bg-control text-primary"
                      : "border-transparent text-secondary hover:border-field/70 hover:bg-list-hover hover:text-primary",
                  )}
                >
                  <button type="button" onClick={() => select(session.id)} aria-current={selected ? "page" : undefined} className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                    <TerminalSquare className="size-3.5 shrink-0" />
                    <span className="max-w-28 truncate">{`Terminal ${index + 1}`}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      close(session.id);
                    }}
                    className="rounded-md p-0.5 text-tertiary opacity-70 outline-none transition-colors hover:bg-control-active hover:text-primary group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/50"
                    aria-label={`Close Terminal ${index + 1}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <Button variant="transparent" size="small" iconOnly onClick={() => void newTerminal()} disabled={!canOpen} aria-label="New terminal tab" title="New terminal tab">
              <Plus />
            </Button>
          </div>
          <div className="no-drag flex shrink-0 items-center gap-0.5 border-l border-separator pl-2">
            <Button variant="transparent" size="small" iconOnly onClick={() => void split("horizontal")} disabled={!canOpen || !canSplit || sessions.length === 0} aria-label="Split terminal horizontally" title="Split terminal horizontally">
              <SquareSplitHorizontal />
            </Button>
            <Button variant="transparent" size="small" iconOnly onClick={() => void split("vertical")} disabled={!canOpen || !canSplit || sessions.length === 0} aria-label="Split terminal vertically" title="Split terminal vertically">
              <SquareSplitVertical />
            </Button>
            <Button variant="transparent" size="small" iconOnly onClick={() => setClearEpoch((value) => value + 1)} disabled={!activeId} aria-label="Clear terminal view" title="Clear terminal view">
              <Minus />
            </Button>
            <Button variant="transparent" size="small" iconOnly onClick={toggle} aria-label="Hide terminal" title="Hide terminal (⌘J)">
              <PanelBottomClose />
            </Button>
          </div>
        </header>
        {visibleSessions.length > 0 ? (
          <div className={cn("min-h-0 flex-1 gap-px bg-separator", layout.direction === "vertical" ? "grid grid-rows-[repeat(var(--terminal-panes),minmax(0,1fr))]" : layout.direction === "horizontal" ? "grid grid-cols-[repeat(var(--terminal-panes),minmax(0,1fr))]" : "block")} style={{ "--terminal-panes": visibleSessions.length } as React.CSSProperties}>
            {visibleSessions.map((session) => (
              <div key={session.id} className={cn("min-h-0 min-w-0 bg-popover", activeId === session.id && "ring-1 ring-inset ring-accent/35")}>
                <TerminalViewport
                  session={session}
                  active={activeId === session.id}
                  onFocus={() => select(session.id)}
                  onUnavailable={() => close(session.id)}
                  clearEpoch={activeId === session.id ? clearEpoch : 0}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <Text variant="small" color="secondary">Open a terminal tab to work in this workspace.</Text>
            <Button variant="filled" size="small" onClick={() => void newTerminal()} disabled={!canOpen}>
              <Plus /> New terminal
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
