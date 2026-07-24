import * as React from "react";
import {
  Files,
  GitCompareArrows,
  List,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Text,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import { useActiveWorkspace } from "../lib/workspace-context";
import {
  FilesPanel,
  type FilesEditorState,
  type FilesEditorStateChangeOptions,
} from "./files-panel";
import { EnvironmentOverview } from "./environment-overview";
import { ReviewPanel } from "./review-panel";

export type EnvironmentPanelTab = "overview" | "review" | "files";
export type EnvironmentReviewMode = "changes" | "compare";

interface EnvironmentFileRequest {
  id: number;
  path: string;
  workspaceId: string;
}

interface EnvironmentPanelContextValue {
  open: boolean;
  tab: EnvironmentPanelTab;
  reviewMode: EnvironmentReviewMode;
  fileRequest: EnvironmentFileRequest | null;
  close: () => void;
  setTab: (tab: EnvironmentPanelTab) => void;
  show: (tab?: EnvironmentPanelTab) => void;
  toggle: (tab?: EnvironmentPanelTab) => void;
  openFile: (path: string) => void;
  openReview: (mode: EnvironmentReviewMode) => void;
  editorState: FilesEditorState;
  agentBusy: boolean;
  gitOperationBusy: boolean;
  gitMutationBlockedReason: string | null;
  reportEditorState: (state: FilesEditorState, options?: FilesEditorStateChangeOptions) => void;
  setAgentBusy: (busy: boolean) => void;
  cancelAgent?: () => void;
  setCancelAgentHandler: (handler: (() => void) | null) => void;
  setGitOperationBusy: (busy: boolean) => void;
  createWorktree?: (branchName: string) => Promise<void>;
  setCreateWorktreeHandler: (handler: ((branchName: string) => Promise<void>) | null) => void;
}

const EnvironmentPanelContext = React.createContext<EnvironmentPanelContextValue | null>(null);
const OPEN_STORAGE_KEY = "aiden-agent.environment.open";
const TAB_STORAGE_KEY = "aiden-agent.environment.tab";
const WIDTH_STORAGE_KEY = "aiden-agent.environment.width";
const DEFAULT_PANEL_WIDTH = 560;
const MIN_PANEL_WIDTH = 480;
const MAX_PANEL_WIDTH = 720;
const MIN_CONVERSATION_WIDTH = 560;
const SUMMARY_CARD_EXIT_MS = 120;
const EMPTY_EDITOR_STATE: FilesEditorState = {
  workspaceId: undefined,
  path: null,
  dirty: false,
  saving: false,
};
const ENVIRONMENT_PANEL_TABS = ["review", "files"] as const;

function storedPanelWidth(): number {
  const stored = localStorage.getItem(WIDTH_STORAGE_KEY);
  if (stored === null) return DEFAULT_PANEL_WIDTH;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH
    ? parsed
    : DEFAULT_PANEL_WIDTH;
}

function storedTab(): EnvironmentPanelTab {
  const stored = localStorage.getItem(TAB_STORAGE_KEY);
  return stored === "review" || stored === "files" || stored === "overview" ? stored : "overview";
}

export function EnvironmentPanelProvider({ children }: React.PropsWithChildren) {
  const { activeId } = useActiveWorkspace();
  const [open, setOpen] = React.useState(() => localStorage.getItem(OPEN_STORAGE_KEY) === "1");
  const [tab, setTabState] = React.useState<EnvironmentPanelTab>(storedTab);
  const [reviewMode, setReviewMode] = React.useState<EnvironmentReviewMode>("changes");
  const [fileRequest, setFileRequest] = React.useState<EnvironmentFileRequest | null>(null);
  const [editorState, setEditorState] = React.useState<FilesEditorState>(EMPTY_EDITOR_STATE);
  const [agentBusy, setAgentBusy] = React.useState(false);
  const [gitOperationBusy, setGitOperationBusyState] = React.useState(false);
  const [createWorktree, setCreateWorktree] = React.useState<
    ((branchName: string) => Promise<void>) | undefined
  >();
  const [cancelAgent, setCancelAgent] = React.useState<(() => void) | undefined>();
  const fileRequestIdRef = React.useRef(0);
  const gitBusyCountRef = React.useRef(0);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  const rememberFocus = React.useCallback(() => {
    if (document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement;
  }, []);

  const show = React.useCallback(
    (nextTab?: EnvironmentPanelTab) => {
      if (!open) rememberFocus();
      if (nextTab) {
        setTabState(nextTab);
        localStorage.setItem(TAB_STORAGE_KEY, nextTab);
      }
      setOpen(true);
      localStorage.setItem(OPEN_STORAGE_KEY, "1");
    },
    [open, rememberFocus],
  );

  const close = React.useCallback(() => {
    setOpen(false);
    localStorage.setItem(OPEN_STORAGE_KEY, "0");
    const returnTarget = returnFocusRef.current?.isConnected
      ? returnFocusRef.current
      : (document.querySelector<HTMLElement>("[data-environment-toggle]") ??
        document.querySelector<HTMLElement>("[data-app-focus-root]"));
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  }, []);

  const setTab = React.useCallback((nextTab: EnvironmentPanelTab) => {
    setTabState(nextTab);
    localStorage.setItem(TAB_STORAGE_KEY, nextTab);
  }, []);

  const toggle = React.useCallback(
    (nextTab?: EnvironmentPanelTab) => {
      if (open && (!nextTab || nextTab === tab)) close();
      else show(nextTab);
    },
    [close, open, show, tab],
  );

  const openFile = React.useCallback(
    (path: string) => {
      if (activeId) {
        setFileRequest({ id: ++fileRequestIdRef.current, path, workspaceId: activeId });
      }
      show("files");
    },
    [activeId, show],
  );

  const openReview = React.useCallback(
    (mode: EnvironmentReviewMode) => {
      setReviewMode(mode);
      show("review");
    },
    [show],
  );

  React.useEffect(() => {
    setRendererLifecycleGuard({ dirty: false, saving: false });
    setEditorState({ ...EMPTY_EDITOR_STATE, workspaceId: activeId });
  }, [activeId]);

  const reportEditorState = React.useCallback(
    (next: FilesEditorState, options?: FilesEditorStateChangeOptions) => {
      setRendererLifecycleGuard(
        { dirty: next.dirty, saving: next.saving },
        { touch: options?.touch },
      );
      setEditorState((current) =>
        current.workspaceId === next.workspaceId &&
        current.path === next.path &&
        current.dirty === next.dirty &&
        current.saving === next.saving
          ? current
          : next,
      );
    },
    [],
  );

  const setGitOperationBusy = React.useCallback((busy: boolean) => {
    gitBusyCountRef.current = Math.max(0, gitBusyCountRef.current + (busy ? 1 : -1));
    const nextBusy = gitBusyCountRef.current > 0;
    setRendererLifecycleGuard({ gitBusy: nextBusy });
    setGitOperationBusyState(nextBusy);
  }, []);

  React.useEffect(
    () => () => {
      gitBusyCountRef.current = 0;
      setRendererLifecycleGuard({ dirty: false, gitBusy: false, saving: false });
    },
    [],
  );

  const setCreateWorktreeHandler = React.useCallback(
    (handler: ((branchName: string) => Promise<void>) | null) => {
      setCreateWorktree(() => handler ?? undefined);
    },
    [],
  );
  const setCancelAgentHandler = React.useCallback((handler: (() => void) | null) => {
    setCancelAgent(() => handler ?? undefined);
  }, []);

  const activeEditorState = editorState.workspaceId === activeId ? editorState : EMPTY_EDITOR_STATE;
  const gitMutationBlockedReason = gitOperationBusy
    ? "Wait for the current Git operation to finish."
    : agentBusy
      ? "Stop the current response before changing Git state."
      : activeEditorState.saving
        ? "Wait for the open file to finish saving before changing Git state."
        : activeEditorState.dirty
          ? "Save or discard the open file's edits before changing Git state."
          : null;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "e"
      ) {
        if (
          gitOperationBusy ||
          document.querySelector('[data-slot="dialog-content"][data-state="open"]')
        ) {
          return;
        }
        event.preventDefault();
        if (open) close();
        else show("overview");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, gitOperationBusy, open, show]);

  const value = React.useMemo(
    () => ({
      open,
      tab,
      reviewMode,
      fileRequest,
      close,
      setTab,
      show,
      toggle,
      openFile,
      openReview,
      editorState: activeEditorState,
      agentBusy,
      gitOperationBusy,
      gitMutationBlockedReason,
      reportEditorState,
      setAgentBusy,
      cancelAgent,
      setCancelAgentHandler,
      setGitOperationBusy,
      createWorktree,
      setCreateWorktreeHandler,
    }),
    [
      activeEditorState,
      agentBusy,
      cancelAgent,
      close,
      createWorktree,
      fileRequest,
      gitOperationBusy,
      gitMutationBlockedReason,
      open,
      openFile,
      openReview,
      reportEditorState,
      reviewMode,
      setCancelAgentHandler,
      setCreateWorktreeHandler,
      setTab,
      show,
      tab,
      toggle,
    ],
  );
  return (
    <EnvironmentPanelContext.Provider value={value}>{children}</EnvironmentPanelContext.Provider>
  );
}

export function useEnvironmentPanel(): EnvironmentPanelContextValue {
  const context = React.useContext(EnvironmentPanelContext);
  if (!context)
    throw new Error("useEnvironmentPanel must be used inside EnvironmentPanelProvider.");
  return context;
}

function clampPanelWidth(value: number, containerWidth: number): number {
  const available = Math.max(0, containerWidth - 44);
  const maximum = Math.min(MAX_PANEL_WIDTH, available || MAX_PANEL_WIDTH);
  const minimum = Math.min(MIN_PANEL_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, value));
}

function EnvironmentPanelSurface({
  width,
  containerWidth,
  inline,
  resizing,
  setResizing,
  setWidth,
}: {
  width: number;
  containerWidth: number;
  inline: boolean;
  resizing: boolean;
  setResizing: (value: boolean) => void;
  setWidth: (value: number) => void;
}) {
  const panel = useEnvironmentPanel();
  const { active } = useActiveWorkspace();
  const fullOpen = panel.open && panel.tab !== "overview";
  const compactModal = fullOpen && !inline;
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const widthRef = React.useRef(width);
  const activeFileRequest =
    panel.fileRequest?.workspaceId === active?.id ? panel.fileRequest : null;
  widthRef.current = width;

  React.useLayoutEffect(() => {
    if (fullOpen) activeTabRef.current?.focus();
  }, [fullOpen, panel.tab]);

  React.useEffect(() => {
    if (!compactModal) return;
    const focusableSelector = [
      "a[href]",
      "button:not(:disabled)",
      "input:not(:disabled)",
      "textarea:not(:disabled)",
      "select:not(:disabled)",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const getFocusable = () =>
      Array.from(surfaceRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => element.offsetParent !== null && !element.closest("[inert]"),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Tab") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"]',
        )
      )
        return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === first || !focusable.includes(activeElement as HTMLElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || !focusable.includes(activeElement as HTMLElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [compactModal]);

  const commitWidth = React.useCallback(
    (nextWidth: number) => {
      const clamped = clampPanelWidth(nextWidth, containerWidth);
      setWidth(clamped);
      localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(clamped)));
    },
    [containerWidth, setWidth],
  );

  const beginResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !fullOpen) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = widthRef.current;
      setResizing(true);
      const move = (moveEvent: PointerEvent) => {
        setWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX, containerWidth));
      };
      const finish = (endEvent: PointerEvent) => {
        commitWidth(
          endEvent.type === "pointerup" ? startWidth + startX - endEvent.clientX : widthRef.current,
        );
        setResizing(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [commitWidth, containerWidth, fullOpen, setResizing, setWidth],
  );

  const resizeWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 40 : 16;
      let next = width;
      if (event.key === "ArrowLeft") next += increment;
      else if (event.key === "ArrowRight") next -= increment;
      else if (event.key === "Home") next = MIN_PANEL_WIDTH;
      else if (event.key === "End") next = MAX_PANEL_WIDTH;
      else return;
      event.preventDefault();
      commitWidth(next);
    },
    [commitWidth, width],
  );

  return (
    <aside
      ref={surfaceRef}
      id="environment-panel"
      inert={!fullOpen ? true : undefined}
      aria-hidden={!fullOpen ? true : undefined}
      role={compactModal ? "dialog" : undefined}
      aria-modal={compactModal ? true : undefined}
      aria-label="Environment work surface"
      className={cn(
        "environment-panel z-30 flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-popover text-primary",
        fullOpen ? "border-l border-separator" : "border-l-0",
        inline ? "relative" : "absolute inset-y-0 right-0 shadow-dialog",
        resizing ? "transition-none" : "transition-[width,opacity,transform] duration-300 ease-out",
        !fullOpen && !inline && "translate-x-full",
      )}
      style={{
        width: fullOpen ? width : inline ? 0 : width,
        opacity: fullOpen ? 1 : 0,
        pointerEvents: fullOpen ? "auto" : "none",
      }}
    >
      <div
        role="separator"
        aria-label="Resize environment panel"
        aria-orientation="vertical"
        aria-valuemin={Math.min(MIN_PANEL_WIDTH, Math.max(0, containerWidth - 44))}
        aria-valuemax={Math.min(MAX_PANEL_WIDTH, Math.max(0, containerWidth - 44))}
        aria-valuenow={Math.round(width)}
        tabIndex={fullOpen ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-y-0 left-0 z-40 -ml-1 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-focus-ring"
      />

      <header className="drag-region flex h-13 shrink-0 items-center gap-2 border-b border-separator px-3">
        <Text variant="strong" truncate className="min-w-0 flex-1">
          Environment
        </Text>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={() => panel.show("overview")}
          aria-label="Show environment summary"
          title="Show environment summary"
          className="no-drag"
        >
          <List />
        </Button>
        <div
          className="no-drag flex shrink-0 items-center rounded-control bg-well p-0.5"
          role="tablist"
          aria-label="Environment views"
        >
          {ENVIRONMENT_PANEL_TABS.map((tab) => {
            const selected = panel.tab === tab;
            const Icon = tab === "review" ? GitCompareArrows : Files;
            return (
              <button
                key={tab}
                id={`environment-${tab}-tab`}
                ref={selected ? activeTabRef : undefined}
                type="button"
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                aria-controls={`environment-${tab}-panel`}
                onClick={() => panel.setTab(tab)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const currentIndex = ENVIRONMENT_PANEL_TABS.indexOf(tab);
                  const nextTab =
                    event.key === "Home"
                      ? ENVIRONMENT_PANEL_TABS[0]
                      : event.key === "End"
                        ? ENVIRONMENT_PANEL_TABS[ENVIRONMENT_PANEL_TABS.length - 1]
                        : ENVIRONMENT_PANEL_TABS[
                            (currentIndex +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              ENVIRONMENT_PANEL_TABS.length) %
                              ENVIRONMENT_PANEL_TABS.length
                          ];
                  panel.setTab(nextTab);
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[9px] px-2 text-small-strong outline-none transition-[background-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-focus-ring",
                  selected
                    ? "bg-popover text-primary shadow-control"
                    : "text-secondary hover:bg-list-hover hover:text-primary active:bg-list-selection",
                )}
              >
                <Icon className="size-3.5" />
                <span>{tab === "review" ? "Review" : "Files"}</span>
              </button>
            );
          })}
        </div>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={panel.close}
          aria-label="Close environment panel"
          title="Close environment panel (⌘⇧E)"
          className="no-drag"
        >
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        <div
          id="environment-review-panel"
          role="tabpanel"
          aria-labelledby="environment-review-tab"
          hidden={panel.tab !== "review"}
          className="h-full min-h-0"
        >
          <ReviewPanel
            workspace={active}
            active={panel.open && panel.tab === "review"}
            mode={panel.reviewMode}
            onModeChange={panel.openReview}
            onOpenFile={panel.openFile}
          />
        </div>
        <div
          id="environment-files-panel"
          role="tabpanel"
          aria-labelledby="environment-files-tab"
          hidden={panel.tab !== "files"}
          className="h-full min-h-0"
        >
          <FilesPanel
            workspace={active}
            active={panel.open && panel.tab === "files"}
            requestedPath={activeFileRequest?.path ?? null}
            requestedPathKey={activeFileRequest?.id ?? 0}
            compact={width < 540}
            interactionBlockedReason={
              panel.gitOperationBusy ? "Wait for the current Git operation to finish." : null
            }
            onEditorStateChange={panel.reportEditorState}
          />
        </div>
      </div>
    </aside>
  );
}

function EnvironmentSummaryCard() {
  const panel = useEnvironmentPanel();
  const { active } = useActiveWorkspace();
  const open = panel.open && panel.tab === "overview";
  const [present, setPresent] = React.useState(open);
  const menuButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const reducedMotion = document.documentElement.dataset.reduceMotion === "true";
    if (reducedMotion) {
      setPresent(false);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), SUMMARY_CARD_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [open, present]);

  React.useLayoutEffect(() => {
    if (open && present) menuButtonRef.current?.focus();
  }, [open, present]);

  return (
    <aside
      id="environment-summary-card"
      hidden={!present}
      inert={!open ? true : undefined}
      aria-hidden={!open ? true : undefined}
      data-state={open ? "open" : "closed"}
      aria-label="Environment summary"
      className="environment-summary-card absolute right-3 top-14 z-30 flex max-h-[calc(100%-4.25rem)] w-[380px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[24px] border border-separator bg-popover text-primary shadow-dialog"
      style={{ pointerEvents: open ? "auto" : "none" }}
    >
      {present ? (
        <>
          <header className="drag-region flex h-12 shrink-0 items-center gap-2 px-4">
            <Text variant="strong" color="tertiary" truncate className="min-w-0 flex-1">
              Environment
            </Text>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuButtonRef}
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Environment actions"
                  title="Environment actions"
                  className="no-drag"
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => panel.openReview("changes")}>
                  <GitCompareArrows className="size-4" aria-hidden="true" />
                  Review changes
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => panel.show("files")}>
                  <Files className="size-4" aria-hidden="true" />
                  Browse files
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => panel.openReview("compare")}>
                  <GitCompareArrows className="size-4" aria-hidden="true" />
                  Compare branch
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <div className="min-h-0 flex-1">
            <EnvironmentOverview
              workspace={active}
              active={open}
              presentation="card"
              mutationBlockedReason={panel.gitMutationBlockedReason}
              onGitOperationBusyChange={panel.setGitOperationBusy}
              onOpenReview={panel.openReview}
              onCreateWorktree={panel.createWorktree}
            />
          </div>
        </>
      ) : null}
    </aside>
  );
}

export function EnvironmentWorkbench({ children }: React.PropsWithChildren) {
  const panel = useEnvironmentPanel();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const [resizing, setResizing] = React.useState(false);
  const [preferredWidth, setPreferredWidth] = React.useState(storedPanelWidth);
  const fullOpen = panel.open && panel.tab !== "overview";
  const renderedWidth = clampPanelWidth(preferredWidth, containerWidth);
  const inline = containerWidth - renderedWidth >= MIN_CONVERSATION_WIDTH;

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!panel.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      event.preventDefault();
      panel.close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel]);

  const overlayOpen = fullOpen && !inline;
  React.useEffect(() => {
    if (!overlayOpen) return;
    const main = containerRef.current?.closest("main");
    const shell = main?.parentElement;
    if (!main || !shell) return;
    const background = Array.from(shell.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== main,
    );
    const snapshots = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const { element } of snapshots) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    return () => {
      for (const { element, inert, ariaHidden } of snapshots) {
        if (!element.isConnected) continue;
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
    };
  }, [overlayOpen]);

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden">
      <div
        inert={overlayOpen ? true : undefined}
        aria-hidden={overlayOpen ? true : undefined}
        className="h-full min-h-0 min-w-0 flex-1"
      >
        {children}
      </div>
      {overlayOpen ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close environment panel"
          onClick={panel.close}
          className="absolute inset-0 z-20 cursor-default bg-black/10 outline-none backdrop-blur-[1px] transition-opacity"
        />
      ) : null}
      <EnvironmentSummaryCard />
      <EnvironmentPanelSurface
        width={renderedWidth}
        containerWidth={containerWidth}
        inline={inline}
        resizing={resizing}
        setResizing={setResizing}
        setWidth={setPreferredWidth}
      />
    </div>
  );
}

export function EnvironmentPanelToggle({ disabled = false }: { disabled?: boolean }) {
  const panel = useEnvironmentPanel();
  return (
    <Button
      iconOnly
      variant="glass"
      size="large"
      onClick={() => (panel.open ? panel.close() : panel.show("overview"))}
      disabled={disabled}
      aria-label={panel.open ? "Hide environment" : "Show environment"}
      aria-pressed={panel.open}
      aria-controls={
        panel.open && panel.tab !== "overview" ? "environment-panel" : "environment-summary-card"
      }
      title="Toggle environment (⌘⇧E)"
      data-environment-toggle
    >
      {panel.open ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}
