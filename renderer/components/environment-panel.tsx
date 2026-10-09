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
  toast,
} from "./ui";
import { ChatContextPanel, type ChatContextDetails } from "./chat-context-panel";
import { WorkspaceToolLauncher, WORKSPACE_TOOLS, workspaceToolLabel } from "./workspace-tool-launcher";
import { TerminalSideTarget, useWorkspaceTerminal, TERMINAL_PANEL_EVENT } from "./terminal-drawer";
import type { BrowserState } from "../shared/browser";
import { acceptBrowserState } from "../lib/browser-ui-state";
import { cn } from "../lib/ui-utils";
import { setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useBrowserLinks } from "../lib/use-browser-links";
import {
  FilesPanel,
  type FilesEditorState,
  type FilesEditorStateChangeOptions,
} from "./files-panel";
import { EnvironmentOverview } from "./environment-overview";
import { ReviewPanel } from "./review-panel";
import { SubagentMark } from "./subagent-chips";
import { SubagentsPanel } from "./subagents-panel";
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  resolveEnvironmentPanelLayout,
  resolveEnvironmentPanelResizeBounds,
  resolveChatCardInset,
  resolveQuickViewLayout,
} from "../lib/environment-panel-layout";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { browserApi, devicesApi, subagentsApi } from "../lib/ipc";
import { type SubagentEffectActivityV1, type SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  buildSubagentRunViews,
  captureSubagentDetailRequest,
  isSubagentRunSnapshotTerminal,
  isSubagentSelectionValid,
  mergeSubagentHistorySnapshot,
  mergeSubagentSnapshots,
  reconcileSubagentPersistenceHandoff,
  resolveSubagentDetailResult,
  resolveSubagentSelection,
  summarizeSubagentRunViews,
  type SubagentDetailRequest,
  type SubagentReferenceMessage,
  type SubagentRunView,
  type SubagentRunViewCounts,
} from "../lib/subagent-view-state";
import {
  subagentOverviewSummary,
  subagentPanelOwnerKey,
  subagentPanelSelectionState,
} from "../lib/subagent-panel-state";
import {
  SubagentLiveAnnouncer,
  type SubagentDetailAnnouncementRequest,
} from "./subagent-live-announcer";
import { useAppCapabilities } from "../lib/app-capabilities";
import {
  availableEnvironmentPanelTabs,
  parseEnvironmentOpenTabs,
  normalizeEnvironmentPanelTab,
  parseEnvironmentPanelTab,
  reduceEnvironmentSurfaceState,
  shouldRestoreEnvironmentFocus,
  type EnvironmentSurfaceMode,
  type EnvironmentSurface,
  type EnvironmentSurfaceState,
  type EnvironmentPanelTab,
} from "../lib/environment-panel-state";
import {
  EMPTY_SUBAGENT_STOP_PENDING_STATE,
  beginSubagentStopPending,
  clearSubagentStopPending,
  failSubagentStopPending,
  replaceSubagentStopPendingOwner,
  type SubagentStopPendingState,
} from "../lib/subagent-stop-pending";
import {
  deviceRevealAction,
  deviceTabKey,
  openDeviceTab,
  selectDeviceTab,
} from "../lib/device-tabs";
import { deviceWorkspace, useFloatingDevice } from "../lib/device-workspace-store";
import {
  DeviceTabContextMenu,
  DeviceTabRenameInput,
  useDeviceTabs,
} from "./device-workspace-tabs";

// The browser and simulator tabs carry their own heavy dependencies and are
// rarely opened, so their code loads with the panel instead of at startup.
const BrowserPanel = React.lazy(() =>
  import("./browser-panel").then((module) => ({ default: module.BrowserPanel })),
);
const DevicesPanel = React.lazy(() =>
  import("./devices-panel").then((module) => ({ default: module.DevicesPanel })),
);
const DeviceMiniPlayerHost = React.lazy(() =>
  import("./device-mini-player").then((module) => ({ default: module.DeviceMiniPlayerHost })),
);

export type { EnvironmentPanelTab } from "../lib/environment-panel-state";
export type EnvironmentReviewMode = "changes" | "compare";

interface EnvironmentSubagentContext {
  chatId: string | null;
  workspaceId: string | null;
  references: SubagentReferenceMessage[];
  liveSnapshots: SubagentRunSnapshot[];
  handoffSnapshots: SubagentRunSnapshot[];
  loadedSnapshots: SubagentRunSnapshot[];
}

interface EnvironmentFileRequest {
  id: number;
  path: string;
  workspaceId: string;
}

interface EnvironmentActiveChat {
  chatId: string | null;
  workspaceId: string | null;
}

interface EnvironmentPanelContextValue {
  toolsOpen: boolean;
  openTabs: EnvironmentPanelTab[];
  closeTab: (tab: EnvironmentPanelTab) => void;
  contextDetails: ChatContextDetails | null;
  setContextDetails: (details: ChatContextDetails | null) => void;
  /** Chat currently presented in the main pane; drives chat-scoped PR actions. */
  activeChat: EnvironmentActiveChat;
  setActiveChat: (chatId: string | null, workspaceId: string | null) => void;
  quickViewOpen: boolean;
  frontSurface: EnvironmentSurface | null;
  surfaceMode: EnvironmentSurfaceMode;
  dockRightInset: number;
  tab: EnvironmentPanelTab;
  subagentsEnabled: boolean;
  devicesEnabled: boolean;
  reviewMode: EnvironmentReviewMode;
  fileRequest: EnvironmentFileRequest | null;
  closeAll: () => void;
  closeTools: () => void;
  closeQuickView: () => void;
  reportSurfaceLayout: (layout: { inline: boolean; width: number } | null) => void;
  setTab: (tab: EnvironmentPanelTab) => void;
  showTools: (tab?: EnvironmentPanelTab) => void;
  showQuickView: () => void;
  activateSurface: (surface: EnvironmentSurface) => void;
  toggleTools: () => void;
  toggleQuickView: () => void;
  openFile: (path: string) => void;
  openReview: (mode: EnvironmentReviewMode) => void;
  subagents: EnvironmentSubagentContext;
  subagentViews: SubagentRunView[];
  subagentCounts: SubagentRunViewCounts;
  selectedSubagentRunId: string | null;
  subagentFocusDetailVersion: number;
  subagentDetailLoading: boolean;
  subagentDetailError: string | null;
  subagentDetailEffects: SubagentEffectActivityV1[];
  subagentStopPendingRunIds: readonly string[];
  subagentStopErrorsByRunId: Readonly<Record<string, string>>;
  announceSubagentDetail: (ownerKey: string, message: string) => void;
  syncSubagents: (
    chatId: string,
    workspaceId: string,
    references: SubagentReferenceMessage[],
    liveSnapshots: SubagentRunSnapshot[],
  ) => void;
  releaseSubagents: (chatId: string, workspaceId: string) => void;
  openSubagent: (runId: string, returnTarget?: HTMLElement | null) => void;
  selectSubagent: (runId: string | null) => void;
  retrySubagentDetail: () => void;
  stopSubagent: (run: SubagentRunSnapshot) => Promise<void>;
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
const TABS_STORAGE_KEY = "aiden-agent.environment.open-tabs-v1";
const OPEN_STORAGE_KEY = "aiden-agent.environment.open";
const QUICK_VIEW_OPEN_STORAGE_KEY = "aiden-agent.quick-view.open";
const FRONT_SURFACE_STORAGE_KEY = "aiden-agent.environment.front-surface";
const SURFACE_STORAGE_VERSION_KEY = "aiden-agent.environment.surface-state-version";
const TAB_STORAGE_KEY = "aiden-agent.environment.tab";
const LAST_TOOLS_TAB_STORAGE_KEY = "aiden-agent.environment.last-tools-tab";
const WIDTH_STORAGE_KEY = "aiden-agent.environment.width";
const SUMMARY_CARD_EXIT_MS = 120;
const EMPTY_EDITOR_STATE: FilesEditorState = {
  workspaceId: undefined,
  path: null,
  dirty: false,
  saving: false,
};
const EMPTY_ACTIVE_CHAT: EnvironmentActiveChat = { chatId: null, workspaceId: null };

const EMPTY_SUBAGENT_CONTEXT: EnvironmentSubagentContext = {
  chatId: null,
  workspaceId: null,
  references: [],
  liveSnapshots: [],
  handoffSnapshots: [],
  loadedSnapshots: [],
};

function storedPanelWidth(): number {
  const stored = localStorage.getItem(WIDTH_STORAGE_KEY);
  if (stored === null) return DEFAULT_PANEL_WIDTH;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH
    ? parsed
    : DEFAULT_PANEL_WIDTH;
}

interface EnvironmentTabCapabilities {
  subagentsEnabled: boolean;
  devicesEnabled: boolean;
}

function storedLastToolsTab(
  currentTab: EnvironmentPanelTab,
  { subagentsEnabled, devicesEnabled }: EnvironmentTabCapabilities,
) {
  const stored = parseEnvironmentPanelTab(localStorage.getItem(LAST_TOOLS_TAB_STORAGE_KEY));
  if (stored && normalizeEnvironmentPanelTab(stored, subagentsEnabled, devicesEnabled) === stored) {
    return stored;
  }
  return normalizeEnvironmentPanelTab(currentTab, subagentsEnabled, devicesEnabled);
}

function initialEnvironmentSurfaceState(
  capabilities: EnvironmentTabCapabilities,
): EnvironmentSurfaceState {
  const rawTab = localStorage.getItem(TAB_STORAGE_KEY);
  const storedTab: EnvironmentPanelTab =
    parseEnvironmentPanelTab(rawTab) ?? storedLastToolsTab("new-tab", capabilities);
  const migrated = localStorage.getItem(SURFACE_STORAGE_VERSION_KEY) === "2";
  if (!migrated) {
    const legacyOpen = localStorage.getItem(OPEN_STORAGE_KEY) === "1";
    const quickViewOpen = legacyOpen && rawTab === "overview";
    const toolsOpen = legacyOpen && rawTab !== "overview";
    localStorage.setItem(QUICK_VIEW_OPEN_STORAGE_KEY, quickViewOpen ? "1" : "0");
    localStorage.setItem(OPEN_STORAGE_KEY, toolsOpen ? "1" : "0");
    localStorage.setItem(SURFACE_STORAGE_VERSION_KEY, "2");
    return {
      quickViewOpen,
      toolsOpen,
      toolsTab: "new-tab",
      openTabs: [...new Set([...parseEnvironmentOpenTabs(localStorage.getItem(TABS_STORAGE_KEY), storedTab), "new-tab" as const])],
      frontSurface: quickViewOpen ? "quick-view" : toolsOpen ? "tools" : null,
    };
  }
  const quickViewOpen = localStorage.getItem(QUICK_VIEW_OPEN_STORAGE_KEY) === "1";
  const toolsOpen = localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  const storedFront = localStorage.getItem(FRONT_SURFACE_STORAGE_KEY);
  const frontSurface =
    storedFront === "quick-view" && quickViewOpen
      ? "quick-view"
      : storedFront === "tools" && toolsOpen
        ? "tools"
        : toolsOpen
          ? "tools"
          : quickViewOpen
            ? "quick-view"
            : null;
  return { quickViewOpen, toolsOpen, toolsTab: "new-tab", openTabs: [...new Set([...parseEnvironmentOpenTabs(localStorage.getItem(TABS_STORAGE_KEY), storedTab), "new-tab" as const])], frontSurface };
}

export function EnvironmentPanelProvider({ children }: React.PropsWithChildren) {
  const { activeId } = useActiveWorkspace();
  const terminal = useWorkspaceTerminal();
  const [contextDetails, setContextDetails] = React.useState<ChatContextDetails | null>(null);
  useBrowserLinks(activeId);
  const { subagents: subagentsEnabled, devices: devicesEnabled } = useAppCapabilities();
  const [surfaceState, dispatchSurface] = React.useReducer(
    reduceEnvironmentSurfaceState,
    { subagentsEnabled, devicesEnabled },
    initialEnvironmentSurfaceState,
  );
  const [surfaceLayout, setSurfaceLayout] = React.useState({ inline: false, width: 0 });
  const tab = normalizeEnvironmentPanelTab(
    surfaceState.toolsTab,
    subagentsEnabled,
    devicesEnabled,
  );
  const [reviewMode, setReviewMode] = React.useState<EnvironmentReviewMode>("changes");
  const [fileRequest, setFileRequest] = React.useState<EnvironmentFileRequest | null>(null);
  const [editorState, setEditorState] = React.useState<FilesEditorState>(EMPTY_EDITOR_STATE);
  const [agentBusy, setAgentBusy] = React.useState(false);
  const [subagents, setRenderedSubagents] =
    React.useState<EnvironmentSubagentContext>(EMPTY_SUBAGENT_CONTEXT);
  const [activeChat, setActiveChatState] =
    React.useState<EnvironmentActiveChat>(EMPTY_ACTIVE_CHAT);
  const setActiveChat = React.useCallback(
    (chatId: string | null, workspaceId: string | null) => {
      setActiveChatState((current) =>
        current.chatId === chatId && current.workspaceId === workspaceId
          ? current
          : { chatId, workspaceId },
      );
    },
    [],
  );
  const subagentsRef = React.useRef<EnvironmentSubagentContext>(EMPTY_SUBAGENT_CONTEXT);
  const commitSubagents = React.useCallback(
    (
      update:
        | EnvironmentSubagentContext
        | ((current: EnvironmentSubagentContext) => EnvironmentSubagentContext | undefined),
    ): boolean => {
      const current = subagentsRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (!next) return false;
      subagentsRef.current = next;
      setRenderedSubagents(next);
      return true;
    },
    [],
  );
  const [selectedSubagentRunId, setSelectedSubagentRunId] = React.useState<string | null>(null);
  const [subagentFocusDetailVersion, setSubagentFocusDetailVersion] = React.useState(0);
  const [subagentDetailLoading, setSubagentDetailLoading] = React.useState(false);
  const [subagentDetailError, setSubagentDetailError] = React.useState<string | null>(null);
  const [subagentStopPending, setSubagentStopPending] = React.useState<SubagentStopPendingState>(
    EMPTY_SUBAGENT_STOP_PENDING_STATE,
  );
  const [subagentEffectDetail, setSubagentEffectDetail] = React.useState<{
    ownerKey: string;
    runId: string;
    generationId: string;
    revision: number;
    effects: SubagentEffectActivityV1[];
  } | null>(null);
  const [subagentDetailRequestVersion, setSubagentDetailRequestVersion] = React.useState(0);
  const [subagentDetailAnnouncement, setSubagentDetailAnnouncement] =
    React.useState<SubagentDetailAnnouncementRequest | null>(null);
  const [gitOperationBusy, setGitOperationBusyState] = React.useState(false);
  const [createWorktree, setCreateWorktree] = React.useState<
    ((branchName: string) => Promise<void>) | undefined
  >();
  const [cancelAgent, setCancelAgent] = React.useState<(() => void) | undefined>();
  const fileRequestIdRef = React.useRef(0);
  const gitBusyCountRef = React.useRef(0);
  const toolsReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const quickViewReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const returnSubagentRunIdRef = React.useRef<string | null>(null);
  const subagentChatIdRef = React.useRef<string | null>(null);
  const subagentWorkspaceIdRef = React.useRef<string | null>(null);
  const subagentDetailRequestRef = React.useRef<SubagentDetailRequest | undefined>(undefined);
  const subagentDetailAnnouncementIdRef = React.useRef(0);
  const subagentStopPendingRef = React.useRef<SubagentStopPendingState>(
    EMPTY_SUBAGENT_STOP_PENDING_STATE,
  );
  const commitSubagentStopPending = React.useCallback((next: SubagentStopPendingState) => {
    if (next === subagentStopPendingRef.current) return;
    subagentStopPendingRef.current = next;
    setSubagentStopPending(next);
  }, []);
  const subagentViews = React.useMemo(
    () =>
      subagentsEnabled && subagents.chatId && subagents.workspaceId
        ? buildSubagentRunViews(
            subagents.chatId,
            subagents.references,
            [
              ...subagents.loadedSnapshots,
              ...subagents.handoffSnapshots,
              ...subagents.liveSnapshots,
            ],
            subagents.workspaceId,
          )
        : [],
    [
      subagents.chatId,
      subagents.handoffSnapshots,
      subagents.liveSnapshots,
      subagents.loadedSnapshots,
      subagents.references,
      subagents.workspaceId,
      subagentsEnabled,
    ],
  );
  const subagentCounts = React.useMemo(
    () => summarizeSubagentRunViews(subagentViews),
    [subagentViews],
  );
  const selectedSubagentView = subagentViews.find((entry) => entry.runId === selectedSubagentRunId);
  const selectedSubagentGenerationId = selectedSubagentView?.generationId;
  const selectedSubagentReferenceMessageId = selectedSubagentView?.referenceMessageId;

  const rememberFocus = React.useCallback(
    (surface: EnvironmentSurface) => {
      if (!(document.activeElement instanceof HTMLElement)) return;
      const target =
        surface === "tools" ? toolsReturnFocusRef : quickViewReturnFocusRef;
      target.current = document.activeElement;
    },
    [],
  );

  const reportSurfaceLayout = React.useCallback(
    (layout: { inline: boolean; width: number } | null) => {
      const next = layout ?? { inline: false, width: 0 };
      setSurfaceLayout((current) =>
        current.inline === next.inline && current.width === next.width ? current : next,
      );
    },
    [],
  );

  const showTools = React.useCallback(
    (nextTab?: EnvironmentPanelTab) => {
      const resolvedTab = nextTab
        ? normalizeEnvironmentPanelTab(nextTab, subagentsEnabled, devicesEnabled)
        : "new-tab";
      const activeElement = document.activeElement;
      const focusOutsideSurface =
        activeElement instanceof HTMLElement &&
        !shouldRestoreEnvironmentFocus(activeElement, "tools");
      if (!surfaceState.toolsOpen || focusOutsideSurface) rememberFocus("tools");
      dispatchSurface({ type: "show-tools", tab: resolvedTab });
    },
    [devicesEnabled, rememberFocus, subagentsEnabled, surfaceState.toolsOpen],
  );

  const restoreSurfaceFocus = React.useCallback((surface: EnvironmentSurface) => {
    const activeElement = document.activeElement;
    const focusInsideClosingSurface =
      activeElement instanceof HTMLElement && shouldRestoreEnvironmentFocus(activeElement, surface);
    if (!focusInsideClosingSurface) return;
    const returnRef = surface === "tools" ? toolsReturnFocusRef : quickViewReturnFocusRef;
    const replacementChip =
      surface === "tools"
        ? Array.from(
            document.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]"),
          ).find((element) => element.dataset.subagentChipRunId === returnSubagentRunIdRef.current)
        : null;
    const storedTarget = returnRef.current;
    const storedTargetAvailable =
      storedTarget?.isConnected &&
      !storedTarget.closest("[inert]") &&
      !storedTarget.closest('[aria-hidden="true"]');
    const fallbackSelector =
      surface === "tools" ? "[data-environment-toggle]" : "[data-quick-view-toggle]";
    const returnTarget = storedTargetAvailable
      ? storedTarget
      : (replacementChip ??
        document.querySelector<HTMLElement>(fallbackSelector) ??
        document.querySelector<HTMLElement>("[data-app-focus-root]"));
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  }, []);

  const closeTools = React.useCallback(() => {
    if (gitOperationBusy) return;
    restoreSurfaceFocus("tools");
    dispatchSurface({ type: "close-tools" });
  }, [gitOperationBusy, restoreSurfaceFocus]);

  const closeQuickView = React.useCallback(() => {
    if (gitOperationBusy) return;
    restoreSurfaceFocus("quick-view");
    dispatchSurface({ type: "close-quick-view" });
  }, [gitOperationBusy, restoreSurfaceFocus]);

  const closeAll = React.useCallback(() => {
    if (gitOperationBusy) return;
    dispatchSurface({ type: "close-all" });
  }, [gitOperationBusy]);

  const showQuickView = React.useCallback(() => {
    const activeElement = document.activeElement;
    const focusOutsideSurface =
      activeElement instanceof HTMLElement &&
      !shouldRestoreEnvironmentFocus(activeElement, "quick-view");
    if (!surfaceState.quickViewOpen || focusOutsideSurface) rememberFocus("quick-view");
    dispatchSurface({ type: "show-quick-view" });
  }, [rememberFocus, surfaceState.quickViewOpen]);

  const activateSurface = React.useCallback((surface: EnvironmentSurface) => {
    dispatchSurface({ type: "activate", surface });
  }, []);

  const setTab = React.useCallback(
    (nextTab: EnvironmentPanelTab) => {
      const resolvedTab = normalizeEnvironmentPanelTab(nextTab, subagentsEnabled, devicesEnabled);
      dispatchSurface({ type: "show-tools", tab: resolvedTab });
    },
    [devicesEnabled, subagentsEnabled],
  );

  const toggleTools = React.useCallback(() => {
    if (gitOperationBusy) return;
    if (surfaceState.toolsOpen) {
      restoreSurfaceFocus("tools");
    } else {
      rememberFocus("tools");
    }
    dispatchSurface({ type: "toggle-tools", tab: "new-tab" });
  }, [gitOperationBusy, rememberFocus, restoreSurfaceFocus, surfaceState.toolsOpen]);

  const closeTab = React.useCallback((closing: EnvironmentPanelTab) => {
    if (gitOperationBusy) return;
    // Closing this navigation tab hides the editor; its mounted owner retains unsaved edits.
    if (closing === "terminal") terminal.hide();
    dispatchSurface({ type: "close-tab", tab: closing });
  }, [gitOperationBusy, terminal.hide]);

  React.useEffect(() => {
    const onTerminal = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === "show") showTools("terminal");
      else {
        dispatchSurface({ type: "close-tab", tab: "terminal" });
        if (action === "bottom" && !surfaceLayout.inline) closeTools();
      }
    };
    window.addEventListener(TERMINAL_PANEL_EVENT, onTerminal);
    return () => window.removeEventListener(TERMINAL_PANEL_EVENT, onTerminal);
  }, [showTools, surfaceLayout.inline, closeTools]);

  const toggleQuickView = React.useCallback(() => {
    if (gitOperationBusy) return;
    if (surfaceState.quickViewOpen) {
      restoreSurfaceFocus("quick-view");
    } else {
      rememberFocus("quick-view");
    }
    dispatchSurface({ type: "toggle-quick-view" });
  }, [gitOperationBusy, rememberFocus, restoreSurfaceFocus, surfaceState.quickViewOpen]);

  const openFile = React.useCallback(
    (path: string) => {
      if (activeId) {
        setFileRequest({
          id: ++fileRequestIdRef.current,
          path,
          workspaceId: activeId,
        });
      }
      showTools("files");
    },
    [activeId, showTools],
  );

  React.useEffect(() => browserApi.onEvent((event) => {
    if (event.type === "show" && event.workspaceId === (activeId ?? "default")) showTools("browser");
  }), [activeId, showTools]);

  const revealChatId = activeChat.chatId;
  React.useEffect(() => {
    if (!devicesEnabled) return undefined;
    // An agent-opened device gets its tab back and floats over the chat, or
    // brings its tab forward when auto-show is off.
    return devicesApi.onReveal((chatId, target) => {
      const action = deviceRevealAction({
        chatId,
        activeChatId: revealChatId,
        target: target ?? null,
        autoFloat: deviceWorkspace.autoFloat(),
        canFloat: true,
      });
      if (action === "ignore") return;
      if (target) deviceWorkspace.updateTabs(chatId, (tabs) => openDeviceTab(tabs, deviceTabKey(target)));
      if (action === "float" && target) deviceWorkspace.setFloating(chatId, deviceTabKey(target));
      else showTools("devices");
    });
  }, [devicesEnabled, revealChatId, showTools]);

  const openReview = React.useCallback(
    (mode: EnvironmentReviewMode) => {
      setReviewMode(mode);
      showTools("review");
    },
    [showTools],
  );

  const syncSubagents = React.useCallback(
    (
      chatId: string,
      workspaceId: string,
      references: SubagentReferenceMessage[],
      liveSnapshots: SubagentRunSnapshot[],
    ) => {
      if (!subagentsEnabled) return;
      const ownedLiveSnapshots = mergeSubagentSnapshots([], liveSnapshots, {
        chatId,
        workspaceId,
      });
      const changedOwner =
        subagentChatIdRef.current !== chatId || subagentWorkspaceIdRef.current !== workspaceId;
      subagentChatIdRef.current = chatId;
      subagentWorkspaceIdRef.current = workspaceId;
      const ownerKey = subagentPanelOwnerKey(chatId, workspaceId);
      if (changedOwner) {
        commitSubagentStopPending(
          replaceSubagentStopPendingOwner(subagentStopPendingRef.current, ownerKey),
        );
        subagentDetailRequestRef.current = undefined;
        setSubagentEffectDetail(null);
        setSelectedSubagentRunId(null);
        setSubagentDetailLoading(false);
        setSubagentDetailError(null);
      }
      const terminalRunIds = new Set(
        ownedLiveSnapshots.filter(isSubagentRunSnapshotTerminal).map((snapshot) => snapshot.runId),
      );
      commitSubagentStopPending(
        clearSubagentStopPending(subagentStopPendingRef.current, ownerKey, terminalRunIds),
      );
      commitSubagents((current) => {
        const handoff = reconcileSubagentPersistenceHandoff(
          changedOwner ? [] : current.loadedSnapshots,
          changedOwner ? [] : current.handoffSnapshots,
          changedOwner ? [] : current.liveSnapshots,
          ownedLiveSnapshots,
          references,
          { chatId, workspaceId },
        );
        return {
          chatId,
          workspaceId,
          references,
          ...handoff,
        };
      });
    },
    [commitSubagentStopPending, commitSubagents, subagentsEnabled],
  );

  const releaseSubagents = React.useCallback(
    (chatId: string, workspaceId: string) => {
      if (subagentChatIdRef.current !== chatId || subagentWorkspaceIdRef.current !== workspaceId) {
        return;
      }
      subagentChatIdRef.current = null;
      subagentWorkspaceIdRef.current = null;
      subagentDetailRequestRef.current = undefined;
      setSubagentEffectDetail(null);
      commitSubagentStopPending(
        replaceSubagentStopPendingOwner(subagentStopPendingRef.current, null),
      );
      returnSubagentRunIdRef.current = null;
      commitSubagents(EMPTY_SUBAGENT_CONTEXT);
      setSelectedSubagentRunId(null);
      setSubagentDetailLoading(false);
      setSubagentDetailError(null);
    },
    [commitSubagentStopPending, commitSubagents],
  );

  const openSubagent = React.useCallback(
    (runId: string, returnTarget?: HTMLElement | null) => {
      if (!subagentsEnabled) return;
      if (returnTarget?.isConnected) toolsReturnFocusRef.current = returnTarget;
      returnSubagentRunIdRef.current = runId;
      subagentDetailRequestRef.current = undefined;
      setSelectedSubagentRunId(runId);
      setSubagentDetailLoading(
        Boolean(
          subagentViews.find(
            (entry) => entry.runId === runId && entry.referenceMessageId && !entry.snapshot,
          ),
        ),
      );
      setSubagentFocusDetailVersion((version) => version + 1);
      setSubagentDetailRequestVersion((version) => version + 1);
      setSubagentDetailError(null);
      showTools("subagents");
    },
    [showTools, subagentViews, subagentsEnabled],
  );

  const selectSubagent = React.useCallback(
    (runId: string | null) => {
      if (!subagentsEnabled) return;
      subagentDetailRequestRef.current = undefined;
      setSelectedSubagentRunId(runId);
      setSubagentDetailLoading(
        Boolean(
          runId &&
          subagentViews.find(
            (entry) => entry.runId === runId && entry.referenceMessageId && !entry.snapshot,
          ),
        ),
      );
      setSubagentDetailRequestVersion((version) => version + 1);
      setSubagentDetailError(null);
    },
    [subagentViews, subagentsEnabled],
  );

  const retrySubagentDetail = React.useCallback(() => {
    if (!subagentsEnabled || !selectedSubagentRunId || !selectedSubagentReferenceMessageId) return;
    subagentDetailRequestRef.current = undefined;
    setSubagentDetailLoading(true);
    setSubagentDetailError(null);
    setSubagentDetailRequestVersion((version) => version + 1);
  }, [selectedSubagentReferenceMessageId, selectedSubagentRunId, subagentsEnabled]);

  const stopSubagent = React.useCallback(
    async (run: SubagentRunSnapshot) => {
      const chatId = subagentChatIdRef.current;
      const workspaceId = subagentWorkspaceIdRef.current;
      if (
        !subagentsEnabled ||
        run.version !== 2 ||
        run.execution !== "foreground" ||
        !chatId ||
        !workspaceId ||
        run.chatId !== chatId ||
        run.workspaceId !== workspaceId
      ) {
        throw new Error("This subagent is no longer available to stop.");
      }
      const ownerKey = subagentPanelOwnerKey(chatId, workspaceId);
      const pending = beginSubagentStopPending(subagentStopPendingRef.current, ownerKey, run.runId);
      commitSubagentStopPending(pending.state);
      if (!pending.accepted) return;
      try {
        const result = await subagentsApi.stop(chatId, run.runId);
        if (result.action !== "stop") {
          throw new Error("Aiden returned an invalid Stop result.");
        }
        if (isSubagentRunSnapshotTerminal(result.snapshot)) {
          commitSubagentStopPending(
            clearSubagentStopPending(
              subagentStopPendingRef.current,
              ownerKey,
              new Set([run.runId]),
            ),
          );
        }
        commitSubagents((current) => {
          if (current.chatId !== chatId || current.workspaceId !== workspaceId) return undefined;
          return {
            ...current,
            liveSnapshots: mergeSubagentSnapshots(current.liveSnapshots, [result.snapshot], {
              chatId,
              workspaceId,
            }),
          };
        });
      } catch (error) {
        const failure = failSubagentStopPending(
          subagentStopPendingRef.current,
          ownerKey,
          run.runId,
          error instanceof Error ? error.message : "Aiden could not stop this subagent.",
        );
        if (failure.accepted) commitSubagentStopPending(failure.state);
      }
    },
    [commitSubagentStopPending, commitSubagents, subagentsEnabled],
  );

  React.useEffect(() => {
    if (!subagents.chatId || !subagents.workspaceId) return;
    const ownerKey = subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId);
    const terminalRunIds = new Set<string>();
    for (const view of subagentViews) {
      const state = view.snapshot?.state;
      if (
        state === "completed" ||
        state === "failed" ||
        state === "timed_out" ||
        state === "interrupted" ||
        state === "stopped" ||
        state === "unknown"
      ) {
        terminalRunIds.add(view.runId);
      }
    }
    commitSubagentStopPending(
      clearSubagentStopPending(subagentStopPendingRef.current, ownerKey, terminalRunIds),
    );
  }, [commitSubagentStopPending, subagentViews, subagents.chatId, subagents.workspaceId]);

  const announceSubagentDetail = React.useCallback(
    (ownerKey: string, message: string) => {
      if (
        !subagentsEnabled ||
        !message ||
        ownerKey !==
          subagentPanelOwnerKey(subagentChatIdRef.current, subagentWorkspaceIdRef.current)
      ) {
        return;
      }
      setSubagentDetailAnnouncement({
        id: ++subagentDetailAnnouncementIdRef.current,
        ownerKey,
        message,
      });
    },
    [subagentsEnabled],
  );

  React.useEffect(() => {
    if (!subagentsEnabled) return;
    const resolved = resolveSubagentSelection(selectedSubagentRunId ?? undefined, subagentViews);
    if (selectedSubagentRunId && !isSubagentSelectionValid(selectedSubagentRunId, subagentViews)) {
      subagentDetailRequestRef.current = undefined;
      setSelectedSubagentRunId(resolved ?? null);
      return;
    }
    if (surfaceState.toolsOpen && tab === "subagents" && !selectedSubagentRunId && resolved) {
      setSelectedSubagentRunId(resolved);
      setSubagentDetailLoading(
        Boolean(
          subagentViews.find(
            (entry) => entry.runId === resolved && entry.referenceMessageId && !entry.snapshot,
          ),
        ),
      );
    }
  }, [selectedSubagentRunId, subagentViews, subagentsEnabled, surfaceState.toolsOpen, tab]);

  React.useEffect(() => {
    if (!subagentsEnabled) return;
    const chatId = subagents.chatId;
    const workspaceId = subagents.workspaceId;
    const runId = selectedSubagentRunId;
    subagentDetailRequestRef.current = undefined;
    if (
      !chatId ||
      !workspaceId ||
      !runId ||
      !selectedSubagentGenerationId ||
      !selectedSubagentReferenceMessageId
    ) {
      setSubagentDetailLoading(false);
      setSubagentDetailError(null);
      return;
    }
    const request = captureSubagentDetailRequest(
      chatId,
      {
        runId,
        generationId: selectedSubagentGenerationId,
      },
      workspaceId,
    );
    const requestBaselineSnapshot = mergeSubagentSnapshots(
      [],
      [
        ...subagentsRef.current.loadedSnapshots,
        ...subagentsRef.current.handoffSnapshots,
        ...subagentsRef.current.liveSnapshots,
      ],
      { chatId, workspaceId },
    ).find(
      (snapshot) =>
        snapshot.runId === runId && snapshot.generationId === selectedSubagentGenerationId,
    );
    subagentDetailRequestRef.current = request;
    setSubagentDetailLoading(true);
    setSubagentDetailError(null);
    void subagentsApi
      .get(chatId, runId)
      .then((detail) => {
        const safeSnapshot = resolveSubagentDetailResult(
          request,
          subagentDetailRequestRef.current,
          subagentChatIdRef.current ?? "",
          selectedSubagentRunId ?? undefined,
          detail?.snapshot,
          requestBaselineSnapshot,
        );
        const requestIsCurrent =
          request === subagentDetailRequestRef.current &&
          subagentChatIdRef.current === chatId &&
          subagentWorkspaceIdRef.current === workspaceId &&
          selectedSubagentRunId === runId;
        if (!requestIsCurrent) return;
        if (!safeSnapshot) {
          setSubagentDetailError("Aiden could not refresh this saved subagent.");
          return;
        }
        const accepted = commitSubagents((current) => {
          if (current.chatId !== chatId || current.workspaceId !== workspaceId) return undefined;
          const merged = mergeSubagentHistorySnapshot(
            current.loadedSnapshots,
            current.handoffSnapshots,
            current.liveSnapshots,
            safeSnapshot,
            { chatId, workspaceId },
          );
          if (!merged.accepted) return undefined;
          return {
            ...current,
            loadedSnapshots: merged.loadedSnapshots,
          };
        });
        if (!accepted) {
          setSubagentDetailError("Aiden could not refresh this saved subagent.");
          return;
        }
        setSubagentEffectDetail({
          ownerKey: subagentPanelOwnerKey(chatId, workspaceId),
          runId,
          generationId: safeSnapshot.generationId,
          revision: safeSnapshot.revision,
          effects: detail?.effects ?? [],
        });
      })
      .catch((error: unknown) => {
        if (
          request === subagentDetailRequestRef.current &&
          subagentChatIdRef.current === chatId &&
          subagentWorkspaceIdRef.current === workspaceId
        ) {
          setSubagentDetailError(
            error instanceof Error ? error.message : "Aiden could not load this subagent.",
          );
        }
      })
      .finally(() => {
        if (
          request === subagentDetailRequestRef.current &&
          subagentChatIdRef.current === chatId &&
          subagentWorkspaceIdRef.current === workspaceId
        ) {
          setSubagentDetailLoading(false);
        }
      });
  }, [
    selectedSubagentRunId,
    selectedSubagentGenerationId,
    selectedSubagentReferenceMessageId,
    subagents.chatId,
    subagents.workspaceId,
    subagentDetailRequestVersion,
    subagentsEnabled,
    commitSubagents,
  ]);

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
      setRendererLifecycleGuard({
        dirty: false,
        gitBusy: false,
        saving: false,
      });
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

  React.useEffect(() => {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ version: 1, tabs: surfaceState.openTabs ?? [surfaceState.toolsTab] }));
    localStorage.setItem(OPEN_STORAGE_KEY, surfaceState.toolsOpen ? "1" : "0");
    localStorage.setItem(QUICK_VIEW_OPEN_STORAGE_KEY, surfaceState.quickViewOpen ? "1" : "0");
    localStorage.setItem(TAB_STORAGE_KEY, surfaceState.toolsTab);
    localStorage.setItem(LAST_TOOLS_TAB_STORAGE_KEY, surfaceState.toolsTab);
    if (surfaceState.frontSurface) {
      localStorage.setItem(FRONT_SURFACE_STORAGE_KEY, surfaceState.frontSurface);
    } else {
      localStorage.removeItem(FRONT_SURFACE_STORAGE_KEY);
    }
  }, [surfaceState]);

  const activeEditorState = editorState.workspaceId === activeId ? editorState : EMPTY_EDITOR_STATE;
  const displayedSubagentSelection = subagentPanelSelectionState(
    subagentViews,
    selectedSubagentRunId,
    surfaceState.toolsOpen && tab === "subagents",
    subagentDetailLoading,
    subagentDetailError,
  );
  const displayedSubagentView = subagentViews.find(
    (view) => view.runId === displayedSubagentSelection.runId,
  );
  const gitMutationBlockedReason = gitOperationBusy
    ? "Wait for the current Git operation to finish."
    : agentBusy
      ? "Stop the current response before changing Git state."
      : activeEditorState.saving
        ? "Wait for the open file to finish saving before changing Git state."
        : activeEditorState.dirty
          ? "Save or discard the open file's edits before changing Git state."
          : null;
  const surfaceMode: EnvironmentSurfaceMode = !surfaceState.toolsOpen
    ? "closed"
    : surfaceLayout.inline
      ? "tools-pinned"
      : "tools-floating";
  // Floating layouts do not have enough guaranteed room for both the tools
  // surface and Assistant. Let Assistant layer at the normal chat edge there.
  const dockRightInset = surfaceState.toolsOpen && surfaceLayout.inline ? surfaceLayout.width : 0;

  const value = React.useMemo(
    () => ({
      toolsOpen: surfaceState.toolsOpen,
      openTabs: surfaceState.openTabs ?? [surfaceState.toolsTab],
      closeTab,
      contextDetails: contextDetails?.chat.id === activeChat.chatId ? contextDetails : null,
      setContextDetails,
      activeChat,
      setActiveChat,
      quickViewOpen: surfaceState.quickViewOpen,
      frontSurface: surfaceState.frontSurface,
      surfaceMode,
      dockRightInset,
      tab,
      subagentsEnabled,
      devicesEnabled,
      reviewMode,
      fileRequest,
      closeAll,
      closeTools,
      closeQuickView,
      reportSurfaceLayout,
      setTab,
      showTools,
      showQuickView,
      activateSurface,
      toggleTools,
      toggleQuickView,
      openFile,
      openReview,
      subagents,
      subagentViews,
      subagentCounts,
      selectedSubagentRunId: displayedSubagentSelection.runId,
      subagentFocusDetailVersion,
      subagentDetailLoading: displayedSubagentSelection.loading,
      subagentDetailError,
      subagentDetailEffects:
        subagentEffectDetail?.ownerKey ===
          subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId) &&
        subagentEffectDetail.runId === displayedSubagentSelection.runId &&
        subagentEffectDetail.generationId === displayedSubagentView?.generationId &&
        subagentEffectDetail.revision === displayedSubagentView?.snapshot?.revision
          ? subagentEffectDetail.effects
          : [],
      subagentStopPendingRunIds:
        subagentStopPending.ownerKey ===
        subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId)
          ? subagentStopPending.runIds
          : [],
      subagentStopErrorsByRunId:
        subagentStopPending.ownerKey ===
        subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId)
          ? subagentStopPending.errors
          : {},
      announceSubagentDetail,
      syncSubagents,
      releaseSubagents,
      openSubagent,
      selectSubagent,
      retrySubagentDetail,
      stopSubagent,
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
      activeChat,
      contextDetails, closeTab, surfaceState.openTabs, surfaceState.toolsTab,
      setActiveChat,
      activeEditorState,
      agentBusy,
      announceSubagentDetail,
      cancelAgent,
      activateSurface,
      closeAll,
      closeQuickView,
      closeTools,
      createWorktree,
      dockRightInset,
      fileRequest,
      gitOperationBusy,
      gitMutationBlockedReason,
      openFile,
      openReview,
      openSubagent,
      reportEditorState,
      releaseSubagents,
      reviewMode,
      retrySubagentDetail,
      reportSurfaceLayout,
      stopSubagent,
      selectSubagent,
      selectedSubagentRunId,
      displayedSubagentSelection.loading,
      displayedSubagentSelection.runId,
      displayedSubagentView?.generationId,
      displayedSubagentView?.snapshot?.revision,
      subagentFocusDetailVersion,
      setCancelAgentHandler,
      setCreateWorktreeHandler,
      setTab,
      showQuickView,
      showTools,
      subagentDetailError,
      subagentEffectDetail,
      subagentStopPending,
      subagentDetailLoading,
      subagents,
      subagentCounts,
      subagentViews,
      subagentsEnabled,
      devicesEnabled,
      surfaceMode,
      surfaceState.frontSurface,
      surfaceState.quickViewOpen,
      surfaceState.toolsOpen,
      syncSubagents,
      tab,
      toggleQuickView,
      toggleTools,
    ],
  );
  return (
    <EnvironmentPanelContext.Provider value={value}>
      {subagentsEnabled ? (
        <SubagentLiveAnnouncer
          ownerKey={subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId)}
          runs={subagents.liveSnapshots}
          detailRequest={subagentDetailAnnouncement}
        />
      ) : null}
      {children}
    </EnvironmentPanelContext.Provider>
  );
}

export function useEnvironmentPanel(): EnvironmentPanelContextValue {
  const context = React.useContext(EnvironmentPanelContext);
  if (!context)
    throw new Error("useEnvironmentPanel must be used inside EnvironmentPanelProvider.");
  return context;
}

function EnvironmentPanelSurface({
  width,
  containerWidth,
  inline,
  presented,
  resizing,
  setResizing,
  setWidth,
}: {
  width: number;
  containerWidth: number;
  inline: boolean;
  presented: boolean;
  resizing: boolean;
  setResizing: (value: boolean) => void;
  setWidth: (value: number) => void;
}) {
  const panel = useEnvironmentPanel();
  const toggleShortcut = useShortcutLabel("environment.toggle");
  const toggleShortcutBinding = useShortcutBinding("environment.toggle");
  const { active } = useActiveWorkspace();
  const fullOpen = panel.toolsOpen;
  const terminal = useWorkspaceTerminal();
  const [browserState, setBrowserState] = React.useState<BrowserState | null>(null);
  const browserStateRef = React.useRef<BrowserState | null>(null);
  const browser = browserState?.workspaceId === active?.id ? browserState : null;
  const workspaceRef = React.useRef(active?.id);
  React.useLayoutEffect(() => {
    workspaceRef.current = active?.id;
    browserStateRef.current = null;
    setBrowserState(null);
  }, [active?.id]);
  const commitBrowserState = React.useCallback((next: BrowserState | null) => {
    if (!next) return false;
    const accepted = acceptBrowserState(browserStateRef.current, next, workspaceRef.current ?? "");
    if (accepted !== next) return false;
    browserStateRef.current = accepted;
    setBrowserState(accepted);
    return true;
  }, []);
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const [browserFocusRequest, setBrowserFocusRequest] = React.useState<string | null>(null);
  const navigationIntentRef = React.useRef(0);
  React.useLayoutEffect(() => {
    navigationIntentRef.current++;
    setBrowserFocusRequest(null);
  }, [active?.id, fullOpen, panel.tab, panel.frontSurface, presented]);
  const tabMenuSelectionRef = React.useRef(false);
  const handledSubagentFocusRef = React.useRef(0);
  const widthRef = React.useRef(width);
  const activeFileRequest =
    panel.fileRequest?.workspaceId === active?.id ? panel.fileRequest : null;
  const availableTabs = availableEnvironmentPanelTabs(panel.subagentsEnabled, panel.devicesEnabled);
  const panelTabs = [...new Set([...panel.openTabs.filter((tab) => availableTabs.includes(tab)), panel.tab])];
  const runBrowser = async (command: Parameters<typeof browserApi.command>[1]) => {
    const owner = active?.id;
    if (!owner) return;
    const result = await browserApi.command(owner, command);
    if (workspaceRef.current !== owner) return;
    // Keep snapshots monotonic while preserving the command's completion signal.
    // Callers validate navigation against this latest state and their own intent.
    commitBrowserState(result.state);
    const current = browserStateRef.current;
    if (current?.workspaceId !== owner) return;
    return { ...result, state: current };
  };
  const chatId = panel.activeChat.chatId;
  const devices = useDeviceTabs(chatId, panel.devicesEnabled && fullOpen && panelTabs.includes("devices"));
  const [renamingDevice, setRenamingDevice] = React.useState<string | null>(null);
  const openTool = (tool: EnvironmentPanelTab) => {
    navigationIntentRef.current++;
    setBrowserFocusRequest(null);
    if (tool === "terminal") terminal.moveTo("side");
    else {
      // "+ → Device" opens the picker; choosing a device there adds its tab.
      if (tool === "devices") devices.openPicker();
      panel.setTab(tool);
    }
  };
  type StripTab = { id: string; kind: EnvironmentPanelTab; label: string; selected: boolean; deviceKey?: string | null };
  const stripTabs = panelTabs.flatMap<StripTab>((kind) => kind === "browser" && browser?.tabs.length
    ? browser.tabs.map((page) => ({ id: page.id, kind, label: page.title || "Browser", selected: panel.tab === "browser" && browser.activeTabId === page.id }))
    : kind === "devices"
      ? devices.entries.map((entry) => ({ id: entry.key ? `device:${entry.key}` : "devices", kind, label: entry.label, selected: panel.tab === "devices" && entry.selected, deviceKey: entry.key }))
      : [{ id: kind, kind, label: workspaceToolLabel(kind), selected: panel.tab === kind }]);
  const selectStripTab = (entry: StripTab) => {
    if (entry.deviceKey !== undefined) {
      navigationIntentRef.current++;
      devices.select(entry.deviceKey);
      panel.setTab("devices");
    } else if (entry.kind === "browser" && entry.id !== "browser") {
      const intent = ++navigationIntentRef.current;
      void runBrowser({ action: "select", tabId: entry.id }).then((result) => {
        if (!result || intent !== navigationIntentRef.current || result.state.activeTabId !== entry.id || !result.state.tabs.some((page) => page.id === entry.id)) return;
        panel.setTab("browser");
        setBrowserFocusRequest(entry.id);
      }).catch(() => toast.error("Could not select browser tab."));
    } else openTool(entry.kind);
  };
  const closeStripTab = (entry: StripTab) => {
    const intent = ++navigationIntentRef.current;
    requestAnimationFrame(() => activeTabRef.current?.focus());
    if (entry.deviceKey !== undefined) {
      // Closing a device tab ends its viewer session; the simulator keeps running.
      if (devices.close(entry.deviceKey)) panel.closeTab("devices");
    } else if (entry.kind === "browser" && entry.id !== "browser") {
      void runBrowser({ action: "close", tabId: entry.id }).then((result) => {
        if (!result || intent !== navigationIntentRef.current || result.state.tabs.some((page) => page.id === entry.id)) return;
        if (!result.state.tabs.length) panel.closeTab("browser");
        else if (panel.tab === "browser") setBrowserFocusRequest(result.state.activeTabId);
      }).catch(() => toast.error("Could not close browser tab."));
    } else panel.closeTab(entry.kind);
  };
  const openBrowserUrl = async (url: string) => {
    const intent = ++navigationIntentRef.current;
    const result = await runBrowser({ action: "create", url, show: false });
    if (!result || intent !== navigationIntentRef.current || !result.tabId || !result.state.tabs.some((page) => page.id === result.tabId)) return;
    // A hidden create deliberately preserves the previous active page. Select it
    // only while this request still owns navigation, then reveal the presenter.
    const selected = await runBrowser({ action: "select", tabId: result.tabId });
    if (!selected || intent !== navigationIntentRef.current || selected.state.activeTabId !== result.tabId || !selected.state.tabs.some((page) => page.id === result.tabId)) return;
    panel.setTab("browser");
  };
  widthRef.current = width;

  React.useLayoutEffect(() => {
    if (!fullOpen || !presented || panel.frontSurface !== "tools") return;
    if (
      panel.tab === "subagents" &&
      panel.subagentFocusDetailVersion > handledSubagentFocusRef.current
    ) {
      handledSubagentFocusRef.current = panel.subagentFocusDetailVersion;
      const frame = window.requestAnimationFrame(() => {
        const heading = surfaceRef.current?.querySelector<HTMLElement>(
          "[data-subagent-detail-heading]",
        );
        (heading ?? activeTabRef.current)?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    activeTabRef.current?.focus();
  }, [fullOpen, panel.frontSurface, panel.subagentFocusDetailVersion, panel.tab, presented]);

  // Only a strip interaction requests this handoff. Wait for React to commit the
  // authoritative selection; a RAF after IPC can run before the new tab's ref.
  React.useLayoutEffect(() => {
    if (!browserFocusRequest || !presented || panel.tab !== "browser") return;
    if (browser?.activeTabId === browserFocusRequest) {
      activeTabRef.current?.focus();
      setBrowserFocusRequest(null);
    } else if (!browser?.tabs.some((page) => page.id === browserFocusRequest)) {
      setBrowserFocusRequest(null);
    }
  }, [browserFocusRequest, browser, panel.tab, presented]);

  const resizeBounds = resolveEnvironmentPanelResizeBounds(containerWidth, inline);
  const clampToResizeBounds = React.useCallback(
    (nextWidth: number) => Math.min(resizeBounds.max, Math.max(resizeBounds.min, nextWidth)),
    [resizeBounds.max, resizeBounds.min],
  );

  const commitWidth = React.useCallback(
    (nextWidth: number) => {
      const clamped = clampToResizeBounds(nextWidth);
      setWidth(clamped);
      localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(clamped)));
    },
    [clampToResizeBounds, setWidth],
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
        setWidth(clampToResizeBounds(startWidth + startX - moveEvent.clientX));
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
    [clampToResizeBounds, commitWidth, fullOpen, setResizing, setWidth],
  );

  const resizeWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 40 : 16;
      let next = width;
      if (event.key === "ArrowLeft") next += increment;
      else if (event.key === "ArrowRight") next -= increment;
      else if (event.key === "Home") next = resizeBounds.min;
      else if (event.key === "End") next = resizeBounds.max;
      else return;
      event.preventDefault();
      commitWidth(next);
    },
    [commitWidth, resizeBounds.max, resizeBounds.min, width],
  );

  return (
    <aside
      ref={surfaceRef}
      id="environment-panel"
      data-environment-surface="tools"
      data-surface-mode={inline ? "tools-pinned" : "tools-floating"}
      data-state={fullOpen ? (presented ? "open" : "covered") : "closed"}
      inert={!presented ? true : undefined}
      aria-hidden={!presented ? true : undefined}
      aria-label="Environment work surface"
      onFocusCapture={() => panel.activateSurface("tools")}
      onPointerDownCapture={() => panel.activateSurface("tools")}
      className={cn(
        "environment-panel absolute z-30 flex min-h-0 flex-col overflow-hidden bg-popover text-primary",
        inline
          ? "inset-y-0 right-0 border-l border-separator"
          : "bottom-3 right-3 rounded-sheet shadow-dialog",
        // Float below the top bar so its tool buttons stay reachable, like Quick View.
        !inline && "top-14",
        resizing
          ? "transition-none"
          : "transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        (!fullOpen || !presented) && !inline && "translate-x-[calc(100%+0.75rem)]",
      )}
      style={{
        width: fullOpen ? width : inline ? 0 : width,
        opacity: fullOpen && presented ? 1 : 0,
        pointerEvents: fullOpen && presented ? "auto" : "none",
      }}
    >
      <div
        role="separator"
        aria-label="Resize environment panel"
        aria-orientation="vertical"
        aria-valuemin={resizeBounds.min}
        aria-valuemax={resizeBounds.max}
        aria-valuenow={Math.round(width)}
        tabIndex={fullOpen ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-y-0 left-0 z-40 -ml-1 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-accent"
      />

      <header className="drag-region flex h-13 shrink-0 items-center gap-1 border-b border-separator px-2">
        <div className="no-drag flex min-w-0 flex-1 gap-1 overflow-x-auto py-1" role="tablist" aria-label="Environment views">
          {stripTabs.map((entry, index) => {
            const Icon = WORKSPACE_TOOLS.find((tool) => tool.id === entry.kind)?.icon ?? Plus;
            const deviceKey = entry.deviceKey;
            const tabButton = <Button ref={entry.selected ? activeTabRef : undefined} id={entry.selected ? `environment-${entry.kind}-tab` : undefined} variant="transparent" size="small" role="tab" tabIndex={entry.selected ? 0 : -1} aria-selected={entry.selected} aria-controls={`environment-${entry.kind}-panel`} title={deviceKey ? `${entry.label} — double-click to rename` : entry.label} disabled={panel.gitOperationBusy} onClick={() => selectStripTab(entry)} onDoubleClick={deviceKey ? () => setRenamingDevice(deviceKey) : undefined} onKeyDown={(event) => {
                if (event.key === "Delete") { event.preventDefault(); closeStripTab(entry); return; }
                if (event.key === "F2" && deviceKey) { event.preventDefault(); setRenamingDevice(deviceKey); return; }
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? stripTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + stripTabs.length) % stripTabs.length;
                selectStripTab(stripTabs[next]);
              }}><Icon className="size-4 shrink-0" /><span className="max-w-32 truncate">{entry.label}</span></Button>;
            const renaming = deviceKey && renamingDevice === deviceKey;
            const finishRename = () => { setRenamingDevice(null); requestAnimationFrame(() => activeTabRef.current?.focus()); };
            return <div key={entry.id} data-device-tab={deviceKey ?? undefined} className={cn("flex min-w-0 shrink-0 items-center rounded-control", entry.selected && "bg-list-selection")}>
              {renaming
                ? <DeviceTabRenameInput title={entry.label} onCommit={(title) => { devices.rename(deviceKey, title); finishRename(); }} onCancel={finishRename} />
                : deviceKey
                  ? <DeviceTabContextMenu floating={devices.floating === deviceKey} onRename={() => setRenamingDevice(deviceKey)} onFloat={() => { devices.float(deviceKey); panel.closeTools(); }} onClose={() => closeStripTab(entry)}>{tabButton}</DeviceTabContextMenu>
                  : tabButton}
              <Button variant="transparent" size="small" iconOnly disabled={panel.gitOperationBusy} aria-label={`Close ${entry.label} tab`} onClick={() => closeStripTab(entry)}><X className="size-3" /></Button>
            </div>;
          })}
        </div>
        <Button variant="transparent" size="small" iconOnly className="no-drag" disabled={panel.gitOperationBusy} aria-label="New workspace tab" onClick={() => openTool("new-tab")}><Plus /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="transparent" size="small" iconOnly className="no-drag" aria-label="Open tabs"><List /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={(event) => { if (tabMenuSelectionRef.current) { event.preventDefault(); tabMenuSelectionRef.current = false; requestAnimationFrame(() => activeTabRef.current?.focus()); } }}>{stripTabs.map((entry) => <DropdownMenuItem key={entry.id} disabled={panel.gitOperationBusy} onSelect={() => { tabMenuSelectionRef.current = true; selectStripTab(entry); }}>{entry.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        <Button variant="transparent" size="small" iconOnly onClick={panel.closeTools} aria-label="Close environment panel" aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)} title={`Close workspace panel (${toggleShortcut})`} className="no-drag"><PanelRightClose /></Button>
      </header>

      <div className="min-h-0 flex-1 @container">
        <div id="environment-new-tab-panel" role="tabpanel" aria-labelledby="environment-new-tab-tab" hidden={panel.tab !== "new-tab"} className="h-full min-h-0">
          <WorkspaceToolLauncher hasWorkspace={Boolean(active)} hasFolderAccess={Boolean(active?.folderPath && active.permission !== "none")} canOpenTerminal={terminal.canOpen} subagents={panel.subagentsEnabled} devices={panel.devicesEnabled} busy={panel.gitOperationBusy} onOpen={openTool} onQuickView={panel.showQuickView} onUrl={openBrowserUrl} />
        </div>
        <div id="environment-context-panel" role="tabpanel" aria-labelledby="environment-context-tab" hidden={panel.tab !== "context"} className="h-full min-h-0"><ChatContextPanel details={panel.contextDetails} /></div>
        <div id="environment-terminal-panel" role="tabpanel" aria-labelledby="environment-terminal-tab" hidden={panel.tab !== "terminal"} className="h-full min-h-0"><TerminalSideTarget presented={presented && panel.tab === "terminal"} /></div>
        <div
          id="environment-review-panel"
          role="tabpanel"
          aria-labelledby="environment-review-tab"
          hidden={panel.tab !== "review"}
          className="h-full min-h-0"
        >
          <ReviewPanel
            workspace={active}
            chatId={panel.activeChat.chatId ?? undefined}
            active={presented && panel.tab === "review"}
            mode={panel.reviewMode}
            onModeChange={panel.openReview}
            onOpenFile={panel.openFile}
          />
        </div>
        {panel.subagentsEnabled ? (
          <div
            id="environment-subagents-panel"
            role="tabpanel"
            aria-labelledby="environment-subagents-tab"
            hidden={panel.tab !== "subagents"}
            className="h-full min-h-0"
          >
            <SubagentsPanel
              chatId={panel.subagents.chatId}
              workspaceId={panel.subagents.workspaceId}
              runs={panel.subagentViews}
              handoffSnapshots={panel.subagents.handoffSnapshots}
              selectedRunId={panel.selectedSubagentRunId}
              selectedRunSnapshot={
                panel.subagentViews.find((run) => run.runId === panel.selectedSubagentRunId)
                  ?.snapshot
              }
              detailLoading={panel.subagentDetailLoading}
              detailError={panel.subagentDetailError}
              effectActivity={panel.subagentDetailEffects}
              onSelectedRunChange={panel.selectSubagent}
              onRetryDetail={panel.retrySubagentDetail}
              onStopRun={panel.stopSubagent}
              stopPendingRunIds={panel.subagentStopPendingRunIds}
              stopErrorsByRunId={panel.subagentStopErrorsByRunId}
              onDetailAnnouncement={panel.announceSubagentDetail}
              detailRequestVersion={panel.subagentFocusDetailVersion}
              compact={width < 620}
              active={presented && panel.tab === "subagents"}
              ownerReplacementFallbackFocusTarget={() => activeTabRef.current}
            />
          </div>
        ) : null}
        <div
          id="environment-files-panel"
          role="tabpanel"
          aria-labelledby="environment-files-tab"
          hidden={panel.tab !== "files"}
          className="h-full min-h-0"
        >
          <FilesPanel
            workspace={active}
            active={presented && panel.tab === "files"}
            requestedPath={activeFileRequest?.path ?? null}
            requestedPathKey={activeFileRequest?.id ?? 0}
            compact={width < 540}
            interactionBlockedReason={
              panel.gitOperationBusy ? "Wait for the current Git operation to finish." : null
            }
            onEditorStateChange={panel.reportEditorState}
          />
        </div>
        <div
          id="environment-browser-panel"
          role="tabpanel"
          aria-labelledby="environment-browser-tab"
          hidden={panel.tab !== "browser"}
          className="h-full min-h-0"
        >
          {active && (
            <React.Suspense fallback={null}>
              <BrowserPanel
                workspaceId={active.id}
                integratedTabs
                onStateChange={commitBrowserState}
                active={presented && panel.tab === "browser"}
                onDock={() => panel.showTools("browser")}
              />
            </React.Suspense>
          )}
        </div>
        {panel.devicesEnabled ? (
          <div
            id="environment-devices-panel"
            role="tabpanel"
            aria-labelledby="environment-devices-tab"
            hidden={panel.tab !== "devices"}
            className="h-full min-h-0"
          >
            {active && (
              <React.Suspense fallback={null}>
                <DevicesPanel
                  workspaceId={active.id}
                  chatId={panel.activeChat.chatId ?? undefined}
                  active={presented && panel.tab === "devices"}
                  compact={width < 540}
                  selected={devices.selected}
                  floating={devices.floating}
                  onOpened={(session) => devices.opened(session)}
                  onClosed={(session) => devices.dismiss(deviceTabKey(session))}
                  onFloat={(session) => {
                    devices.float(deviceTabKey(session));
                    panel.closeTools();
                  }}
                  onDock={(session) => {
                    if (chatId) deviceWorkspace.setFloating(chatId, null);
                    devices.select(deviceTabKey(session));
                  }}
                />
              </React.Suspense>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function QuickViewCard({
  width,
  right,
  presented,
}: {
  width: number;
  right: number;
  presented: boolean;
}) {
  const panel = useEnvironmentPanel();
  const { active } = useActiveWorkspace();
  const open = panel.quickViewOpen;
  const [present, setPresent] = React.useState(open);
  const menuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const menuDestinationRef = React.useRef<EnvironmentReviewMode | "files" | null>(null);
  const subagentCounts = panel.subagentCounts;
  const hasSubagents = panel.subagentsEnabled && subagentCounts.active + subagentCounts.done > 0;
  const representativeSubagent =
    panel.subagentViews.find((view) => !view.terminal) ?? panel.subagentViews[0];
  const subagentSummary = subagentOverviewSummary(panel.subagentViews);

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
    if (open && present && presented && panel.frontSurface === "quick-view") {
      menuButtonRef.current?.focus();
    }
  }, [open, panel.frontSurface, present, presented]);

  return (
    <aside
      id="quick-view-card"
      data-environment-surface="quick-view"
      data-surface-mode="quick-view"
      hidden={!present}
      inert={!open || !presented ? true : undefined}
      aria-hidden={!open || !presented ? true : undefined}
      data-state={open ? (presented ? "open" : "covered") : "closed"}
      aria-label="Quick View"
      onFocusCapture={() => panel.activateSurface("quick-view")}
      onPointerDownCapture={() => panel.activateSurface("quick-view")}
      className={cn(
        "quick-view-card absolute top-14 z-30 flex max-h-[calc(100%-4.25rem)] flex-col overflow-hidden rounded-sheet bg-popover text-primary shadow-dialog transition-[right,width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        (!open || !presented) && "translate-x-[calc(100%+0.75rem)] opacity-0",
      )}
      style={{
        width,
        right,
        pointerEvents: open && presented ? "auto" : "none",
      }}
    >
      {present ? (
        <>
          <header className="drag-region flex h-12 shrink-0 items-center gap-2 px-4">
            <Text variant="strong" color="tertiary" truncate className="min-w-0 flex-1">
              Quick View
            </Text>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuButtonRef}
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Quick View actions"
                  title="Quick View actions"
                  className="no-drag"
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-52"
                onCloseAutoFocus={(event) => {
                  const destination = menuDestinationRef.current;
                  menuDestinationRef.current = null;
                  if (!destination) return;
                  const trigger = menuButtonRef.current;
                  const triggerAvailable =
                    trigger?.isConnected &&
                    !trigger.closest('[inert], [aria-hidden="true"]');
                  if (!open || !presented || panel.gitOperationBusy || !triggerAvailable) {
                    // Keep Radix's normal restoration when the trigger is usable. If
                    // it disappeared or became inert, preserve newer focus or use the
                    // application fallback instead of leaving focus in the removed menu.
                    if (!triggerAvailable) {
                      event.preventDefault();
                      const focused = document.activeElement;
                      if (
                        !(focused instanceof HTMLElement) ||
                        focused === document.body ||
                        !focused.isConnected ||
                        focused.closest('[inert], [aria-hidden="true"]')
                      ) {
                        document.querySelector<HTMLElement>("[data-app-focus-root]")?.focus();
                      }
                    }
                    return;
                  }
                  event.preventDefault();
                  // Finish the menu's focus scope before opening tools. Otherwise its
                  // return focus reactivates Quick View and covers tools in narrow layouts.
                  // Remember the durable trigger, not the menu item that just unmounted.
                  trigger.focus();
                  if (destination === "files") panel.showTools("files");
                  else panel.openReview(destination);
                }}
              >
                <DropdownMenuItem
                  disabled={panel.gitOperationBusy}
                  onSelect={() => {
                    menuDestinationRef.current = "changes";
                  }}
                >
                  <GitCompareArrows className="size-4" aria-hidden="true" />
                  Review changes
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={panel.gitOperationBusy}
                  onSelect={() => {
                    menuDestinationRef.current = "files";
                  }}
                >
                  <Files className="size-4" aria-hidden="true" />
                  Browse files
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={panel.gitOperationBusy}
                  onSelect={() => {
                    menuDestinationRef.current = "compare";
                  }}
                >
                  <GitCompareArrows className="size-4" aria-hidden="true" />
                  Compare branch
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <EnvironmentOverview
                workspace={active}
                chatId={panel.activeChat.chatId ?? undefined}
                active={open && presented}
                presentation="card"
                mutationBlockedReason={panel.gitMutationBlockedReason}
                onGitOperationBusyChange={panel.setGitOperationBusy}
                onOpenReview={panel.openReview}
                onCreateWorktree={panel.createWorktree}
              />
            </div>
            {hasSubagents ? (
              <div className="shrink-0 border-t border-separator px-3 py-3">
                <Text as="h2" variant="small-strong" color="tertiary" className="mb-1 px-2">
                  Subagents
                </Text>
                <button
                  type="button"
                  onClick={() => panel.showTools("subagents")}
                  aria-label={`Open Subagents, ${subagentSummary.ariaLabel}`}
                  className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none"
                >
                  <SubagentMark
                    role={representativeSubagent?.role}
                    state={representativeSubagent?.state ?? "finished"}
                    activity={representativeSubagent?.snapshot?.activity}
                    size={20}
                  />
                  <span className="min-w-0 truncate text-regular text-primary">
                    {subagentSummary.primary}
                  </span>
                  <span className="max-w-44 min-w-0 truncate text-small tabular-nums text-tertiary">
                    {subagentSummary.secondary}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </aside>
  );
}

/** CSS lengths in px or rem, as the chat column tokens are written; `none` is unbounded. */
function cssLength(value: string, rootFontSize: number, fallback: number): number {
  if (value.trim() === "none") return Number.POSITIVE_INFINITY;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return fallback;
  return value.trim().endsWith("rem") ? amount * rootFontSize : amount;
}

/** The chat column's maximum width and inner gutter, read from its CSS tokens as Appearance sets them. */
function useChatColumnMetrics(): { maxWidth: number; gutter: number } {
  const [metrics, setMetrics] = React.useState({ maxWidth: 832, gutter: 72 });
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const style = getComputedStyle(root);
      const rootFontSize = Number.parseFloat(style.fontSize) || 16;
      const next = {
        maxWidth: cssLength(style.getPropertyValue("--chat-content-max-width"), rootFontSize, 832),
        gutter: cssLength(style.getPropertyValue("--aiden-dock-gutter"), rootFontSize, 72),
      };
      setMetrics((current) =>
        current.maxWidth === next.maxWidth && current.gutter === next.gutter ? current : next,
      );
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "data-chat-width"] });
    return () => observer.disconnect();
  }, []);
  return metrics;
}

export function EnvironmentWorkbench({
  children,
  suppressed = false,
}: React.PropsWithChildren<{
  /**
   * Hides the Environment and Quick View surfaces without changing whether
   * they are open, for content that is not on this Mac (a paired host's chat).
   */
  suppressed?: boolean;
}>) {
  const panel = useEnvironmentPanel();
  const toolsOpen = panel.toolsOpen && !suppressed;
  const quickViewOpen = panel.quickViewOpen && !suppressed;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const [resizing, setResizing] = React.useState(false);
  const [preferredWidth, setPreferredWidth] = React.useState(storedPanelWidth);
  const fullOpen = toolsOpen;
  const { width: renderedWidth, inline } = resolveEnvironmentPanelLayout(
    preferredWidth,
    containerWidth,
  );
  const quickViewLayout = resolveQuickViewLayout(
    containerWidth,
    toolsOpen,
    renderedWidth,
    inline,
  );
  const stacked =
    quickViewOpen && toolsOpen && !quickViewLayout.alongsideTools;
  const toolsPresented =
    toolsOpen && (!stacked || panel.frontSurface === "tools");
  const quickViewPresented =
    quickViewOpen && (!stacked || panel.frontSurface === "quick-view");
  const inlineToolsWidth = fullOpen && inline ? renderedWidth : 0;
  const chatColumn = useChatColumnMetrics();
  // Quick View docks beside the chat when it is the visible card and no floating
  // tools surface already covers the chat.
  const chatCardInset =
    quickViewPresented && (inline || !toolsPresented)
      ? resolveChatCardInset({
          chatWidth: containerWidth - inlineToolsWidth,
          maxColumnWidth: chatColumn.maxWidth,
          cardInset: quickViewLayout.right + quickViewLayout.width - inlineToolsWidth,
          contentGutter: chatColumn.gutter,
        })
      : 0;
  const floatingDevice = useFloatingDevice(panel.activeChat.chatId);
  const dockDevice = React.useCallback(
    (chatId: string, key: string) => {
      deviceWorkspace.setFloating(chatId, null);
      deviceWorkspace.updateTabs(chatId, (tabs) => selectDeviceTab(tabs, key));
      panel.showTools("devices");
    },
    [panel.showTools],
  );

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
    if (!toolsOpen && !quickViewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      if (document.querySelector('[data-compact-sidebar-open="true"]')) return;
      if (panel.gitOperationBusy) return;
      const activeElement = document.activeElement;
      const focusedSurface =
        activeElement instanceof HTMLElement &&
        shouldRestoreEnvironmentFocus(activeElement, "quick-view")
          ? "quick-view"
          : activeElement instanceof HTMLElement && shouldRestoreEnvironmentFocus(activeElement, "tools")
            ? "tools"
            : panel.frontSurface;
      if (!focusedSurface) return;
      event.preventDefault();
      if (focusedSurface === "quick-view") panel.closeQuickView();
      else panel.closeTools();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    panel.closeQuickView,
    panel.closeTools,
    panel.frontSurface,
    panel.gitOperationBusy,
    quickViewOpen,
    toolsOpen,
  ]);

  const reportSurfaceLayout = panel.reportSurfaceLayout;
  React.useLayoutEffect(() => {
    reportSurfaceLayout(fullOpen ? { inline, width: renderedWidth } : null);
    return () => reportSurfaceLayout(null);
  }, [fullOpen, inline, renderedWidth, reportSurfaceLayout]);

  return (
    <div
      ref={containerRef}
      data-environment-surface-mode={panel.surfaceMode}
      data-quick-view-open={quickViewOpen ? "true" : "false"}
      data-environment-stacked={stacked ? "true" : "false"}
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
    >
      <div
        data-browser-floating-container
        data-chat-card-inset={quickViewOpen ? chatCardInset : undefined}
        style={
          quickViewOpen
            ? ({
                "--chat-card-inset-end": `${chatCardInset}px`,
                // Full-width chat has no max; the docked column then fills what the card leaves.
                "--chat-card-max-width": Number.isFinite(chatColumn.maxWidth) ? `${chatColumn.maxWidth}px` : "100000px",
              } as React.CSSProperties)
            : undefined
        }
        className="h-full min-h-0 min-w-0 flex-1"
      >
        {children}
      </div>
      {panel.devicesEnabled && floatingDevice && !suppressed ? (
        <React.Suspense fallback={null}>
          <DeviceMiniPlayerHost chatId={panel.activeChat.chatId} enabled onDock={dockDevice} />
        </React.Suspense>
      ) : null}
      <QuickViewCard
        width={quickViewLayout.width}
        right={quickViewLayout.right}
        presented={quickViewPresented}
      />
      <div
        aria-hidden="true"
        className={cn(
          "h-full shrink-0 transition-[width] duration-300 ease-out motion-reduce:transition-none",
          resizing && "transition-none",
        )}
        style={{ width: fullOpen && inline ? renderedWidth : 0 }}
      />
      <EnvironmentPanelSurface
        width={renderedWidth}
        containerWidth={containerWidth}
        inline={inline}
        presented={toolsPresented}
        resizing={resizing}
        setResizing={setResizing}
        setWidth={setPreferredWidth}
      />
    </div>
  );
}

export function EnvironmentPanelToggle({ disabled = false }: { disabled?: boolean }) {
  const panel = useEnvironmentPanel();
  const toggleShortcut = useShortcutLabel("environment.toggle");
  const toggleShortcutBinding = useShortcutBinding("environment.toggle");
  const active = panel.toolsOpen;
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      onClick={panel.toggleTools}
      disabled={disabled || panel.gitOperationBusy}
      aria-label={active ? "Hide Environment" : "Show Environment"}
      aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)}
      aria-pressed={active}
      aria-controls="environment-panel"
      title={`Toggle Environment (${toggleShortcut})`}
      data-environment-toggle
    >
      {active ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}

function QuickViewIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="2.5" />
      <path d="M12 7h7" />
      <circle cx="7" cy="17" r="2.5" />
      <path d="M12 17h7" />
    </svg>
  );
}

export function QuickViewToggle({ disabled = false }: { disabled?: boolean }) {
  const panel = useEnvironmentPanel();
  const active = panel.quickViewOpen;
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      onClick={panel.toggleQuickView}
      disabled={disabled || panel.gitOperationBusy}
      aria-label={active ? "Hide Quick View" : "Show Quick View"}
      aria-pressed={active}
      aria-controls="quick-view-card"
      title="Toggle Quick View"
      data-quick-view-toggle
    >
      <QuickViewIcon />
    </Button>
  );
}
