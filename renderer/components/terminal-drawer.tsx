// Bottom terminal drawer inspired by T3 Code's persistent terminal surface:
// sessions stay attached to the active workspace and can be opened, split,
// resized, or hidden without leaving the chat.

import * as React from "react";
import type { GhosttySurfaceHandle } from "../lib/ghostty-terminal/surface";
import {
  Minus,
  PanelBottomClose,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button, Text, toast } from "./ui";
import { cn } from "../lib/ui-utils";
import { onNotification, terminalApi, type TerminalSession } from "../lib/ipc";
import { useActiveWorkspace } from "../lib/workspace-context";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";

const MIN_DRAWER_HEIGHT = 152;
const MAX_DRAWER_RATIO = 0.5;
const MIN_CHAT_HEIGHT = 320;
const DEFAULT_DRAWER_HEIGHT = 232;
const MAX_PANES = 4;
const HEIGHT_STORAGE_KEY = "aiden-agent.terminal-height-v2";
const TERMINAL_DRAWER_MOTION_MS = 300;

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
    Math.min(
      Math.floor(window.innerHeight * MAX_DRAWER_RATIO),
      window.innerHeight - MIN_CHAT_HEIGHT,
    ),
  );
}

function clampHeight(height: number): number {
  return Math.min(maxDrawerHeight(), Math.max(MIN_DRAWER_HEIGHT, Math.round(height)));
}

function initialHeight(): number {
  const saved = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
  return clampHeight(Number.isFinite(saved) ? saved : DEFAULT_DRAWER_HEIGHT);
}

function appearanceValue(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function terminalFontSize(): number {
  const value = Number.parseFloat(appearanceValue("--code-font-size", "12"));
  return Number.isFinite(value) ? value : 12;
}

function terminalFontFamily(): string {
  return appearanceValue(
    "--font-code-family",
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  );
}

function terminalTheme() {
  const dark = document.documentElement.dataset.appearanceScheme === "dark";
  const foreground = appearanceValue("--terminal-foreground", dark ? "#e6e9ee" : "#1c1e21");
  const background = appearanceValue("--terminal-background", dark ? "#1d232d" : "#ffffff");
  const red = appearanceValue("--terminal-red", dark ? "#ff5e57" : "#ff453a");
  const green = appearanceValue("--terminal-green", dark ? "#32d17a" : "#30d158");
  const yellow = appearanceValue("--terminal-yellow", dark ? "#ffb020" : "#d48a00");
  const blue = appearanceValue("--terminal-blue", dark ? "#8ebcff" : "#3866ad");
  const magenta = appearanceValue("--terminal-magenta", dark ? "#dcbaff" : "#895a9d");
  const cyan = appearanceValue("--terminal-cyan", dark ? "#91e9ee" : "#367d8c");
  return {
    background,
    foreground,
    cursor: appearanceValue("--terminal-cursor", "#0a84ff"),
    selectionBackground: appearanceValue(
      "--terminal-selection",
      dark ? "rgb(10 132 255 / 0.3)" : "rgb(10 132 255 / 0.2)",
    ),
    black: appearanceValue("--terminal-black", dark ? "#252a31" : "#34373b"),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: appearanceValue("--terminal-white", foreground),
    brightBlack: appearanceValue("--text-tertiary", dark ? "#9aa3ae" : "#6b7280"),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
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
      setLayout((previous) => ({
        ...previous,
        ids: previous.ids.filter((id) => id !== sessionId),
      }));
      setActiveId((previous) => (previous === sessionId ? undefined : previous));
    };
    return onNotification("terminal:exit", removeExited);
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
    async (direction: Exclude<SplitDirection, "single">) => {
      const base =
        activeId && layout.ids.includes(activeId) ? layout.ids : activeId ? [activeId] : [];
      if (base.length >= MAX_PANES) {
        toast.info(`A terminal group can show up to ${MAX_PANES} panes.`);
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

  const toggle = React.useCallback(() => {
    if (open) {
      const hadTerminalFocus =
        document.activeElement instanceof Element &&
        document.activeElement.closest(".terminal-drawer");
      setOpen(false);
      if (hadTerminalFocus)
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>("[data-terminal-toggle]")?.focus(),
        );
    } else if (sessions.length > 0) {
      setOpen(true);
    } else {
      void newTerminal();
    }
  }, [newTerminal, open, sessions.length]);

  const value = React.useMemo<TerminalContextValue>(
    () => ({
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
        setLayout((previous) =>
          previous.ids.includes(id) ? previous : { direction: "single", ids: [id] },
        );
      },
      close,
    }),
    [
      active?.folderPath,
      active?.permission,
      activeId,
      close,
      layout,
      newTerminal,
      open,
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

function TerminalViewport({
  session,
  active,
  onFocus,
  onUnavailable,
  clearEpoch,
}: {
  session: TerminalSession;
  active: boolean;
  onFocus: () => void;
  onUnavailable: () => void;
  clearEpoch: number;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<GhosttySurfaceHandle | null>(null);
  const resizeTerminalRef = React.useRef<(() => void) | null>(null);
  const onUnavailableRef = React.useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let surface: GhosttySurfaceHandle | null = null;
    let cancelData: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let disposeInput: { dispose: () => void } | undefined;
    const teardown = () => {
      cancelData?.();
      cancelData = undefined;
      observer?.disconnect();
      observer = undefined;
      disposeInput?.dispose();
      disposeInput = undefined;
      if (surfaceRef.current === surface) surfaceRef.current = null;
      surface?.dispose();
      surface = null;
      resizeTerminalRef.current = null;
    };
    void import("../lib/ghostty-terminal/surface").then(async ({ openGhosttySurface }) => {
      if (cancelled || !hostRef.current) return;
      const next = await openGhosttySurface(hostRef.current, {
        cursorBlink: true,
        fontFamily: terminalFontFamily(),
        fontSize: terminalFontSize(),
        lineHeight: 1.25,
        theme: terminalTheme(),
      });
      const mount = hostRef.current;
      if (cancelled || !mount) {
        next.dispose();
        return;
      }
      surface = next;
      surfaceRef.current = next;
      const resize = () => {
        try {
          next.fit();
          void terminalApi.resize(session.id, next.cols, next.rows).catch(() => undefined);
        } catch {
          // The host can briefly have zero size during drawer animation.
        }
      };
      resizeTerminalRef.current = resize;
      observer = new ResizeObserver(() => requestAnimationFrame(resize));
      observer.observe(mount);
      let hydrated = false;
      let lastSequence = 0;
      const queuedData: Array<{ sequence: number; data: string }> = [];
      const writeData = (event: { sequence: number; data: string }) => {
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        next.write(event.data);
      };
      cancelData = onNotification<{ sessionId: string; sequence: number; data: string }>(
        "terminal:data",
        (event) => {
          if (event.sessionId !== session.id) return;
          if (!hydrated) queuedData.push(event);
          else writeData(event);
        },
      );
      if (cancelled) {
        teardown();
        return;
      }
      try {
        const { buffer, sequence } = await terminalApi.snapshot(session.id);
        if (cancelled) {
          teardown();
          return;
        }
        if (buffer) next.write(buffer);
        lastSequence = sequence;
        hydrated = true;
        for (const event of queuedData) writeData(event);
        resize();
      } catch {
        // Electron's main process can restart during development. Remove the
        // renderer-side tab instead of leaving an inert terminal pane behind.
        teardown();
        if (!cancelled) onUnavailableRef.current();
        return;
      }
      if (cancelled) {
        teardown();
        return;
      }
      disposeInput = next.onData(
        (data) => void terminalApi.write(session.id, data).catch(() => undefined),
      );
      next.attachCustomKeyEventHandler((event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") return false;
        return true;
      });
      requestAnimationFrame(resize);
    });
    return () => {
      cancelled = true;
      teardown();
    };
  }, [session.id]);

  React.useEffect(() => {
    if (active) requestAnimationFrame(() => surfaceRef.current?.focus());
  }, [active]);

  React.useEffect(() => {
    if (clearEpoch > 0) surfaceRef.current?.clear();
  }, [clearEpoch]);

  React.useEffect(() => {
    const updateAppearance = () => {
      if (!surfaceRef.current) return;
      surfaceRef.current.setAppearance({
        theme: terminalTheme(),
        fontFamily: terminalFontFamily(),
        fontSize: terminalFontSize(),
      });
      requestAnimationFrame(() => resizeTerminalRef.current?.());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
  }, []);

  return (
    <div
      ref={hostRef}
      data-command-scope="terminal"
      onMouseDown={onFocus}
      className="h-full min-h-0 w-full select-text p-2"
    />
  );
}

export function TerminalDrawer() {
  const { open, sessions, activeId, layout, canOpen, toggle, newTerminal, split, select, close } =
    useWorkspaceTerminal();
  const [height, setHeight] = React.useState(initialHeight);
  const toggleShortcut = useShortcutLabel("terminal.toggle");
  const toggleShortcutBinding = useShortcutBinding("terminal.toggle");
  const [clearEpoch, setClearEpoch] = React.useState(0);
  const [present, setPresent] = React.useState(open);
  const resizeRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  const heightRef = React.useRef(height);
  heightRef.current = height;
  const visibleIds = layout.ids.filter((id) => sessions.some((session) => session.id === id));
  const visibleSessions =
    visibleIds.length > 0
      ? visibleIds.map((id) => sessions.find((session) => session.id === id)!).filter(Boolean)
      : activeId
        ? sessions.filter((session) => session.id === activeId)
        : [];
  const canSplit = visibleSessions.length < MAX_PANES;

  React.useEffect(() => {
    const onResize = () => setHeight((current) => clampHeight(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  React.useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    const timeout = window.setTimeout(
      () => setPresent(false),
      reduceMotion ? 0 : TERMINAL_DRAWER_MOTION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open, present]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startY: event.clientY, startHeight: height };
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    setHeight(
      clampHeight(resizeRef.current.startHeight + resizeRef.current.startY - event.clientY),
    );
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

  // Keep the surface only for its short exit curve, then remove it so a closed
  // terminal cannot leave a phantom painted region at the bottom of the chat.
  if (!present) return null;

  return (
    <section
      inert={!open ? true : undefined}
      aria-hidden={!open ? true : undefined}
      data-state={open ? "open" : "closed"}
      className="terminal-drawer relative shrink-0 overflow-hidden border-t border-separator bg-popover"
      style={{ "--terminal-drawer-height": `${height}px` } as React.CSSProperties}
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
        className="absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize outline-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator hover:before:bg-accent focus-visible:before:h-0.5 focus-visible:before:bg-accent"
      />
      <div className="flex h-full min-h-0 flex-col">
        <header className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
          <div
            className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1"
            aria-label="Terminal tabs"
          >
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
                  <button
                    type="button"
                    onClick={() => select(session.id)}
                    aria-current={selected ? "page" : undefined}
                    className="flex min-w-0 items-center gap-1.5 rounded-md outline-none transition-shadow focus-visible:bg-list-selection focus-visible:outline-none"
                  >
                    <TerminalSquare className="size-3.5 shrink-0" />
                    <span className="max-w-28 truncate">{`Terminal ${index + 1}`}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      close(session.id);
                    }}
                    className="rounded-full p-0.5 text-tertiary opacity-70 outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out hover:bg-control-active hover:text-primary active:bg-list-selection group-hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-list-selection focus-visible:outline-none"
                    aria-label={`Close Terminal ${index + 1}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <Button
              variant="transparent"
              size="small"
              iconOnly
              onClick={() => void newTerminal()}
              disabled={!canOpen}
              aria-label="New terminal tab"
              title="New terminal tab"
            >
              <Plus />
            </Button>
          </div>
          <div className="no-drag flex shrink-0 items-center gap-0.5 border-l border-separator pl-2">
            <Button
              variant="transparent"
              size="small"
              iconOnly
              onClick={() => void split("horizontal")}
              disabled={!canOpen || !canSplit || sessions.length === 0}
              aria-label="Split terminal horizontally"
              title="Split terminal horizontally"
            >
              <SquareSplitHorizontal />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              onClick={() => void split("vertical")}
              disabled={!canOpen || !canSplit || sessions.length === 0}
              aria-label="Split terminal vertically"
              title="Split terminal vertically"
            >
              <SquareSplitVertical />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              onClick={() => setClearEpoch((value) => value + 1)}
              disabled={!activeId}
              aria-label="Clear terminal view"
              title="Clear terminal view"
            >
              <Minus />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              onClick={toggle}
              aria-label="Hide terminal"
              aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)}
              title={`Hide terminal (${toggleShortcut})`}
            >
              <PanelBottomClose />
            </Button>
          </div>
        </header>
        {visibleSessions.length > 0 ? (
          <div
            className={cn(
              "min-h-0 flex-1 gap-px bg-separator",
              layout.direction === "vertical"
                ? "grid grid-rows-[repeat(var(--terminal-panes),minmax(0,1fr))]"
                : layout.direction === "horizontal"
                  ? "grid grid-cols-[repeat(var(--terminal-panes),minmax(0,1fr))]"
                  : "block",
            )}
            style={{ "--terminal-panes": visibleSessions.length } as React.CSSProperties}
          >
            {visibleSessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  "min-h-0 min-w-0 bg-popover",
                  activeId === session.id && "ring-1 ring-inset ring-accent/35",
                )}
              >
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
            <Text variant="small" color="secondary">
              Open a terminal tab to work in this workspace.
            </Text>
            <Button
              variant="filled"
              size="small"
              onClick={() => void newTerminal()}
              disabled={!canOpen}
            >
              <Plus /> New terminal
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
