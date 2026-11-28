// Bottom terminal drawer inspired by T3 Code's persistent terminal surface:
// sessions stay attached to the active workspace and can be opened, split,
// resized, or hidden without leaving the chat.

import * as React from "react";
import { createPortal } from "react-dom";
import type { GhosttyTerminalSurface } from "../lib/ghostty-terminal/surface";
import { ghosttyThemeFromCss } from "../lib/ghostty-terminal/theme";
import {
  MessageSquarePlus,
  Minus,
  PanelBottomClose,
  PanelRightOpen,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  AlertDialog,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Text,
  toast,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { onNotification, terminalApi, type TerminalSession } from "../lib/ipc";
import { useLinkOpener } from "../lib/link-opener";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { useResizeHandle } from "../lib/use-resize-handle";
import { TERMINAL_CONTEXT_UNAVAILABLE, terminalContextDelivery } from "../lib/terminal-context";
import {
  MAX_TERMINAL_PANES,
  TERMINAL_PANEL_EVENT,
  TerminalSideTarget,
  WorkspaceTerminalProvider,
  useWorkspaceTerminal,
} from "./workspace-terminal-provider";

export {
  TERMINAL_PANEL_EVENT,
  TerminalSideTarget,
  WorkspaceTerminalProvider,
  useWorkspaceTerminal,
};

const MIN_DRAWER_HEIGHT = 152;
const MAX_DRAWER_RATIO = 0.5;
const MIN_CHAT_HEIGHT = 320;
const DEFAULT_DRAWER_HEIGHT = 232;
const MAX_PANES = MAX_TERMINAL_PANES;
const HEIGHT_STORAGE_KEY = "aiden-agent.terminal-height-v2";
const TERMINAL_DRAWER_MOTION_MS = 300;
const SELECTION_ACTION_WIDTH = 112;
const SELECTION_ACTION_HEIGHT = 28;
const SELECTION_ACTION_GAP = 6;

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
  const saved = Number(localStorage.getItem(HEIGHT_STORAGE_KEY) ?? DEFAULT_DRAWER_HEIGHT);
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

function TerminalViewport({
  session,
  label,
  active,
  visible,
  onFocus,
  onUnavailable,
  clearEpoch,
}: {
  session: TerminalSession;
  label: string;
  active: boolean;
  visible: boolean;
  onFocus: () => void;
  onUnavailable: () => void;
  clearEpoch: number;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<GhosttyTerminalSurface | null>(null);
  const resizeTerminalRef = React.useRef<(() => void) | null>(null);
  const onUnavailableRef = React.useRef(onUnavailable);
  const activeRef = React.useRef(active);
  const visibleRef = React.useRef(visible);
  onUnavailableRef.current = onUnavailable;
  activeRef.current = active;
  visibleRef.current = visible;
  const [selectionAction, setSelectionAction] = React.useState<{ left: number; top: number } | null>(null);
  const [menuHasSelection, setMenuHasSelection] = React.useState(false);
  const focusLeftTerminalRef = React.useRef(false);

  const addSelectionToChat = () => {
    const surface = surfaceRef.current;
    const position = surface?.getSelectionPosition();
    if (!surface || !position) return false;
    const delivered = terminalContextDelivery.capture(session.workspaceId)?.deliver({
      label,
      lineStart: position.start.y + 1,
      lineEnd: position.end.y + 1,
      text: surface.getSelection(),
    });
    if (!delivered) {
      toast.error(TERMINAL_CONTEXT_UNAVAILABLE);
      return false;
    }
    surface.clearSelection();
    return true;
  };

  const { openLink, canOpen } = useLinkOpener();
  // openLink/canOpen change identity when the saved preference loads or
  // changes; read them through a ref so the terminal (and its scrollback)
  // isn't torn down and rebuilt just because the preference changed.
  const linkOpenerRef = React.useRef({ openLink, canOpen });
  linkOpenerRef.current = { openLink, canOpen };

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let surface: GhosttyTerminalSurface | null = null;
    let cancelData: (() => void) | undefined;
    const teardown = () => {
      cancelData?.();
      cancelData = undefined;
      if (surfaceRef.current === surface) surfaceRef.current = null;
      surface?.dispose();
      surface = null;
      resizeTerminalRef.current = null;
    };
    void import("../lib/ghostty-terminal/surface")
      .then(async ({ GhosttyTerminalSurface }) => {
        if (cancelled || !hostRef.current) return;
        const next = await GhosttyTerminalSurface.create(hostRef.current, {
          theme: ghosttyThemeFromCss(terminalTheme()),
          font: { family: terminalFontFamily(), size: terminalFontSize() },
          get visible() {
            return visibleRef.current;
          },
          onData: (data) => {
            void terminalApi.write(session.id, data).catch(() => undefined);
          },
          onResize: (cols, rows) => {
            setSelectionAction(null);
            void terminalApi.resize(session.id, cols, rows).catch(() => undefined);
          },
          onSelectionChange: () => setSelectionAction(null),
          onViewportScroll: () => setSelectionAction(null),
          onSelectionSettled: () => {
            const surface = surfaceRef.current;
            const hostBounds = hostRef.current?.getBoundingClientRect();
            if (!surface || !hostBounds) return;
            // A selection ending outside the viewport has no point to attach to.
            const end = surface.getSelectionEndClientRect() ?? hostBounds;
            const clampWithin = (value: number, size: number, limit: number) =>
              Math.max(SELECTION_ACTION_GAP, Math.min(value, limit - size - SELECTION_ACTION_GAP));
            setSelectionAction({
              left: clampWithin(
                end.right - hostBounds.left + SELECTION_ACTION_GAP,
                SELECTION_ACTION_WIDTH,
                hostBounds.width,
              ),
              top: clampWithin(
                end.bottom - hostBounds.top + SELECTION_ACTION_GAP,
                SELECTION_ACTION_HEIGHT,
                hostBounds.height,
              ),
            });
          },
          beforeKey: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") return false;
            return true;
          },
          canActivateLink: (url) => linkOpenerRef.current.canOpen(url),
          onLinkActivate: (url, event) => {
            linkOpenerRef.current.openLink(url, {
              modifiers: { metaKey: event.metaKey, ctrlKey: event.ctrlKey },
              workspaceId: session.workspaceId,
            });
          },
        });
        const mount = hostRef.current;
        if (cancelled || !mount) {
          next.dispose();
          return;
        }
        surface = next;
        surfaceRef.current = next;
        if (activeRef.current) next.focus();
        const resize = () => {
          try {
            next.fit();
          } catch {
            // The host can briefly have zero size during drawer animation.
          }
        };
        resizeTerminalRef.current = resize;
        let hydrated = false;
        let lastSequence = 0;
        const queuedData: Array<{ sequence: number; data: string }> = [];
        const writeData = (event: { sequence: number; data: string }) => {
          if (event.sequence <= lastSequence) return;
          lastSequence = event.sequence;
          // New output can move the selection out from under the action.
          setSelectionAction(null);
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
          if (buffer) next.resetAndWrite(buffer);
          lastSequence = sequence;
          hydrated = true;
          for (const event of queuedData) writeData(event);
          resize();
        } catch {
          teardown();
          if (!cancelled) onUnavailableRef.current();
          return;
        }
        if (cancelled) {
          teardown();
          return;
        }
        requestAnimationFrame(resize);
      })
      .catch(() => {
        if (cancelled || hostRef.current !== host) return;
        teardown();
        host.classList.remove("ghostty-screen");
        host.replaceChildren();
        onUnavailableRef.current();
      });
    return () => {
      cancelled = true;
      teardown();
    };
  }, [session.id]);

  React.useEffect(() => {
    surfaceRef.current?.setVisible(visible);
    if (!visible) setSelectionAction(null);
  }, [visible]);

  React.useEffect(() => {
    if (active) requestAnimationFrame(() => surfaceRef.current?.focus());
    else setSelectionAction(null);
  }, [active]);

  React.useEffect(() => {
    if (clearEpoch > 0) surfaceRef.current?.clear();
  }, [clearEpoch]);

  React.useEffect(() => {
    const updateAppearance = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      surface.setTheme(ghosttyThemeFromCss(terminalTheme()));
      void surface.setFont({ family: terminalFontFamily(), size: terminalFontSize() });
      requestAnimationFrame(() => resizeTerminalRef.current?.());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
  }, []);

  return (
    <div className="relative h-full min-h-0 w-full">
      {/* A modal menu hides the composer from assistive tech, which reads as unavailable. */}
      <ContextMenu
        modal={false}
        onOpenChange={(menuOpen) => {
          if (menuOpen) setMenuHasSelection(surfaceRef.current?.hasSelection() ?? false);
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={hostRef}
            data-command-scope="terminal"
            onMouseDown={onFocus}
            className="relative h-full min-h-0 w-full overflow-hidden select-text"
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            // Adding to chat moved focus to the composer; don't pull it back.
            if (focusLeftTerminalRef.current) event.preventDefault();
            focusLeftTerminalRef.current = false;
          }}
        >
          <ContextMenuItem
            disabled={!menuHasSelection}
            onSelect={() => {
              focusLeftTerminalRef.current = addSelectionToChat();
            }}
          >
            Add to chat
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menuHasSelection}
            onSelect={() => {
              const selection = surfaceRef.current?.getSelection();
              if (!selection) return;
              void navigator.clipboard
                .writeText(selection)
                .catch(() => toast.error("Couldn't copy the terminal selection."));
            }}
          >
            Copy
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void surfaceRef.current
                ?.pasteFromClipboard(() => navigator.clipboard.readText())
                .catch(() => toast.error("Couldn't read the clipboard."));
            }}
          >
            Paste
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => surfaceRef.current?.selectAll()}>Select all</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {selectionAction ? (
        <Button
          variant="filled"
          size="small"
          className="absolute z-10"
          style={selectionAction}
          // Keep focus in the terminal; a press here must not end the selection.
          onMouseDown={(event) => event.preventDefault()}
          onClick={addSelectionToChat}
        >
          <MessageSquarePlus /> Add to chat
        </Button>
      ) : null}
    </div>
  );
}

export function TerminalDrawer() {
  const { open, requestedOpen, placement, sideTarget, moveTo, sessions, foregroundCommands, activeId, layout, canOpen, toggle, newTerminal, split, select, close } =
    useWorkspaceTerminal();
  const [closeRequest, setCloseRequest] = React.useState<{ id: string; label: string; command: string } | null>(null);
  // A program can finish while the question is open, and the shell with it.
  const pendingClose = closeRequest && sessions.some((session) => session.id === closeRequest.id) ? closeRequest : null;
  const requestClose = async (id: string, label: string) => {
    const command = await terminalApi.foregroundCommand(id).catch(() => null);
    if (command) setCloseRequest({ id, label, command });
    else close(id);
  };
  const bottomTargetRef = React.useRef<HTMLDivElement>(null);
  const [portalHost] = React.useState(() => { const node = document.createElement("div"); node.className = "h-full min-h-0"; return node; });
  React.useLayoutEffect(() => {
    const target = placement === "side" ? sideTarget : bottomTargetRef.current;
    target?.appendChild(portalHost);
    return () => { portalHost.remove(); };
  }, [placement, sideTarget, portalHost]);
  const [height, setHeight] = React.useState(initialHeight);
  const toggleShortcut = useShortcutLabel("terminal.toggle");
  const toggleShortcutBinding = useShortcutBinding("terminal.toggle");
  const [clearEpoch, setClearEpoch] = React.useState(0);
  const [present, setPresent] = React.useState(open);
  // While the drawer's height animates, the body keeps its settled size and the
  // drawer clips it. Otherwise every frame would refit the canvas: a new backing
  // store, a grid reflow and a full render, about 18 times per toggle.
  const [moving, setMoving] = React.useState(false);
  const settledOpenRef = React.useRef(false);
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

  React.useLayoutEffect(() => {
    if (settledOpenRef.current === open) return;
    settledOpenRef.current = open;
    setMoving(true);
    const timeout = window.setTimeout(() => setMoving(false), TERMINAL_DRAWER_MOTION_MS);
    return () => window.clearTimeout(timeout);
  }, [open]);

  // The drawer is below the divider, so moving the divider up makes it taller.
  const resizeHandle = useResizeHandle({
    orientation: "horizontal",
    panel: "end",
    value: height,
    min: MIN_DRAWER_HEIGHT,
    max: maxDrawerHeight(),
    disabled: !open,
    onResize: (next) => setHeight(clampHeight(next)),
    onCommit: (next) => {
      const settled = clampHeight(next);
      setHeight(settled);
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(settled));
    },
    onToggleCollapse: toggle,
  });

  // Keep the renderer attached to one portal host across docking and hiding.
  // The hidden container releases layout without resetting the terminal screen.
  const content = (
    <section
      inert={!open ? true : undefined}
      aria-hidden={!open ? true : undefined}
      data-state={open ? "open" : "closed"}
      className="terminal-drawer relative shrink-0 overflow-hidden border-t border-separator bg-popover"
      data-placement={placement}
      style={{ "--terminal-drawer-height": placement === "side" ? "100%" : `${height}px`, "--terminal-drawer-body-height": placement === "side" ? "100%" : `${height - 1}px`, display: (placement === "side" ? !requestedOpen : !present) ? "none" : undefined } as React.CSSProperties}
    >
      <div
        hidden={placement === "side"}
        {...resizeHandle}
        aria-label="Resize terminal drawer"
        className="absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize outline-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator hover:before:bg-accent focus-visible:before:h-0.5 focus-visible:before:bg-focus-ring"
      />
      {/* The settled body height is the drawer's less its 1px top border. */}
      <div className={cn("flex min-h-0 flex-col", moving ? "h-(--terminal-drawer-body-height)" : "h-full")}>
        <header className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
          <div
            className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1"
            aria-label="Terminal tabs"
          >
            {sessions.map((session, index) => {
              const selected = activeId === session.id;
              const label = `Terminal ${index + 1}`;
              const command = foregroundCommands[session.id];
              return (
                <div
                  key={session.id}
                  className={cn(
                    "group flex h-7 shrink-0 items-center gap-1 rounded-menu border px-1.5 text-small transition-colors",
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
                    <span className="max-w-28 truncate">{label}</span>
                    {command ? (
                      <span className="flex min-w-0 items-center gap-1 text-tertiary" title={`Running ${command}`}>
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
                        <span className="max-w-20 truncate">{command}</span>
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void requestClose(session.id, label);
                    }}
                    className="rounded-full p-0.5 text-tertiary opacity-70 outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out hover:bg-control-active hover:text-primary active:bg-list-selection group-hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-list-selection focus-visible:outline-none"
                    aria-label={`Close ${label}`}
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
            <Button variant="transparent" size="small" iconOnly onClick={() => moveTo(placement === "side" ? "bottom" : "side")} aria-label={placement === "side" ? "Move terminal to bottom" : "Move terminal to side panel"} title={placement === "side" ? "Move to bottom" : "Move to side panel"}><PanelRightOpen /></Button>
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
              // One grid for every layout: a single pane needs the definite track
              // too, or its canvas falls back to the bitmap's aspect ratio for height.
              "grid min-h-0 flex-1 gap-px bg-separator",
              layout.direction === "vertical"
                ? "grid-cols-[minmax(0,1fr)] grid-rows-[repeat(var(--terminal-panes),minmax(0,1fr))]"
                : "grid-cols-[repeat(var(--terminal-panes),minmax(0,1fr))] grid-rows-[minmax(0,1fr)]",
            )}
            style={{ "--terminal-panes": visibleSessions.length } as React.CSSProperties}
          >
            {visibleSessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  "relative min-h-0 min-w-0 bg-(--terminal-background)",
                  // The cue sits in the screen's padding, outside the canvas: dimming the
                  // canvas would take its text below the terminal contrast guarantees.
                  visibleSessions.length > 1 && activeId === session.id &&
                    "after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-focus-ring",
                )}
              >
                <TerminalViewport
                  session={session}
                  label={`Terminal ${sessions.indexOf(session) + 1}`}
                  active={open && activeId === session.id}
                  visible={open}
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
  return <>
    <div ref={bottomTargetRef} className="shrink-0" hidden={placement !== "bottom" || !present} />
    {createPortal(content, portalHost)}
    <AlertDialog
      open={pendingClose !== null}
      onOpenChange={(next) => { if (!next) setCloseRequest(null); }}
      title={`Close ${pendingClose?.label ?? "terminal"}?`}
      description={`${pendingClose?.command ?? "A program"} is still running. Closing the terminal stops it.`}
      confirmLabel="Close terminal"
      confirmVariant="destructive"
      onConfirm={() => {
        if (pendingClose) close(pendingClose.id);
        setCloseRequest(null);
      }}
    />
  </>;
}
