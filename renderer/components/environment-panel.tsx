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
import { SubagentOrb } from "./subagent-chips";
import { SubagentsPanel } from "./subagents-panel";
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_EDGE_GUTTER,
  clampEnvironmentPanelWidth,
  resolveEnvironmentPanelLayout,
} from "../lib/environment-panel-layout";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { subagentsApi } from "../lib/ipc";
import type { SubagentEffectActivityV1, SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  buildSubagentRunViews,
  captureSubagentDetailRequest,
  isSubagentSelectionValid,
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
import { subagentPanelOwnerKey, subagentPanelSelectionState } from "../lib/subagent-panel-state";
import {
  SubagentLiveAnnouncer,
  type SubagentDetailAnnouncementRequest,
} from "./subagent-live-announcer";
import { useAppCapabilities } from "../lib/app-capabilities";
import {
  availableEnvironmentPanelTabs,
  environmentCompactModalFocusableTargets,
  environmentCompactModalTabWrapTarget,
  focusEnvironmentCompactModalTransition,
  normalizeEnvironmentPanelTab,
  storedEnvironmentPanelTab,
  type EnvironmentSurfaceMode,
  type EnvironmentPanelTab,
} from "../lib/environment-panel-state";

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

interface EnvironmentPanelContextValue {
  open: boolean;
  compactModalOpen: boolean;
  tab: EnvironmentPanelTab;
  subagentsEnabled: boolean;
  reviewMode: EnvironmentReviewMode;
  fileRequest: EnvironmentFileRequest | null;
  close: () => void;
  setCompactModalOpen: (open: boolean) => void;
  setTab: (tab: EnvironmentPanelTab) => void;
  show: (tab?: EnvironmentPanelTab) => void;
  toggle: (tab?: EnvironmentPanelTab) => void;
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
  announceSubagentDetail: (ownerKey: string, message: string) => void;
  setSubagentAnnouncerHost: (host: HTMLElement | null) => void;
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
const OPEN_STORAGE_KEY = "aiden-agent.environment.open";
const TAB_STORAGE_KEY = "aiden-agent.environment.tab";
const WIDTH_STORAGE_KEY = "aiden-agent.environment.width";
const SUMMARY_CARD_EXIT_MS = 120;
const EMPTY_EDITOR_STATE: FilesEditorState = {
  workspaceId: undefined,
  path: null,
  dirty: false,
  saving: false,
};
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

export function EnvironmentPanelProvider({ children }: React.PropsWithChildren) {
  const { activeId } = useActiveWorkspace();
  const { subagents: subagentsEnabled } = useAppCapabilities();
  const [open, setOpen] = React.useState(() => localStorage.getItem(OPEN_STORAGE_KEY) === "1");
  const [compactModalOpen, setCompactModalOpen] = React.useState(false);
  const [tab, setTabState] = React.useState<EnvironmentPanelTab>(() =>
    storedEnvironmentPanelTab(localStorage, TAB_STORAGE_KEY, subagentsEnabled),
  );
  const [reviewMode, setReviewMode] = React.useState<EnvironmentReviewMode>("changes");
  const [fileRequest, setFileRequest] = React.useState<EnvironmentFileRequest | null>(null);
  const [editorState, setEditorState] = React.useState<FilesEditorState>(EMPTY_EDITOR_STATE);
  const [agentBusy, setAgentBusy] = React.useState(false);
  const [subagents, setSubagents] =
    React.useState<EnvironmentSubagentContext>(EMPTY_SUBAGENT_CONTEXT);
  const [selectedSubagentRunId, setSelectedSubagentRunId] = React.useState<string | null>(null);
  const [subagentFocusDetailVersion, setSubagentFocusDetailVersion] = React.useState(0);
  const [subagentDetailLoading, setSubagentDetailLoading] = React.useState(false);
  const [subagentDetailError, setSubagentDetailError] = React.useState<string | null>(null);
  const [subagentEffectDetail, setSubagentEffectDetail] = React.useState<{
    ownerKey: string;
    runId: string;
    effects: SubagentEffectActivityV1[];
  } | null>(null);
  const [subagentDetailRequestVersion, setSubagentDetailRequestVersion] = React.useState(0);
  const [subagentDetailAnnouncement, setSubagentDetailAnnouncement] =
    React.useState<SubagentDetailAnnouncementRequest | null>(null);
  const [subagentAnnouncerHost, setSubagentAnnouncerHost] = React.useState<HTMLElement | null>(
    null,
  );
  const [gitOperationBusy, setGitOperationBusyState] = React.useState(false);
  const [createWorktree, setCreateWorktree] = React.useState<
    ((branchName: string) => Promise<void>) | undefined
  >();
  const [cancelAgent, setCancelAgent] = React.useState<(() => void) | undefined>();
  const fileRequestIdRef = React.useRef(0);
  const gitBusyCountRef = React.useRef(0);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const returnSubagentRunIdRef = React.useRef<string | null>(null);
  const subagentChatIdRef = React.useRef<string | null>(null);
  const subagentWorkspaceIdRef = React.useRef<string | null>(null);
  const subagentDetailRequestRef = React.useRef<SubagentDetailRequest | undefined>(undefined);
  const subagentDetailAnnouncementIdRef = React.useRef(0);
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
  const selectedSubagentSnapshotRevision = selectedSubagentView?.snapshot?.revision;

  const rememberFocus = React.useCallback(() => {
    if (document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement;
  }, []);

  const show = React.useCallback(
    (nextTab?: EnvironmentPanelTab) => {
      const resolvedTab = nextTab
        ? normalizeEnvironmentPanelTab(nextTab, subagentsEnabled)
        : undefined;
      if (!open) rememberFocus();
      if (resolvedTab) {
        setTabState(resolvedTab);
        localStorage.setItem(TAB_STORAGE_KEY, resolvedTab);
      }
      setOpen(true);
      localStorage.setItem(OPEN_STORAGE_KEY, "1");
    },
    [open, rememberFocus, subagentsEnabled],
  );

  const close = React.useCallback(() => {
    setOpen(false);
    localStorage.setItem(OPEN_STORAGE_KEY, "0");
    const replacementChip = Array.from(
      document.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]"),
    ).find((element) => element.dataset.subagentChipRunId === returnSubagentRunIdRef.current);
    const returnTarget = returnFocusRef.current?.isConnected
      ? returnFocusRef.current
      : (replacementChip ??
        document.querySelector<HTMLElement>("[data-environment-toggle]") ??
        document.querySelector<HTMLElement>("[data-app-focus-root]"));
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  }, []);

  const setTab = React.useCallback(
    (nextTab: EnvironmentPanelTab) => {
      const resolvedTab = normalizeEnvironmentPanelTab(nextTab, subagentsEnabled);
      setTabState(resolvedTab);
      localStorage.setItem(TAB_STORAGE_KEY, resolvedTab);
    },
    [subagentsEnabled],
  );

  const toggle = React.useCallback(
    (nextTab?: EnvironmentPanelTab) => {
      const resolvedTab = nextTab
        ? normalizeEnvironmentPanelTab(nextTab, subagentsEnabled)
        : undefined;
      if (open && (!resolvedTab || resolvedTab === tab)) close();
      else show(resolvedTab);
    },
    [close, open, show, subagentsEnabled, tab],
  );

  const openFile = React.useCallback(
    (path: string) => {
      if (activeId) {
        setFileRequest({
          id: ++fileRequestIdRef.current,
          path,
          workspaceId: activeId,
        });
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
      if (changedOwner) {
        subagentDetailRequestRef.current = undefined;
        setSelectedSubagentRunId(null);
        setSubagentDetailLoading(false);
        setSubagentDetailError(null);
      }
      setSubagents((current) => {
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
    [subagentsEnabled],
  );

  const releaseSubagents = React.useCallback((chatId: string, workspaceId: string) => {
    if (subagentChatIdRef.current !== chatId || subagentWorkspaceIdRef.current !== workspaceId) {
      return;
    }
    subagentChatIdRef.current = null;
    subagentWorkspaceIdRef.current = null;
    subagentDetailRequestRef.current = undefined;
    returnSubagentRunIdRef.current = null;
    setSubagents(EMPTY_SUBAGENT_CONTEXT);
    setSelectedSubagentRunId(null);
    setSubagentDetailLoading(false);
    setSubagentDetailError(null);
  }, []);

  const openSubagent = React.useCallback(
    (runId: string, returnTarget?: HTMLElement | null) => {
      if (!subagentsEnabled) return;
      if (returnTarget?.isConnected) returnFocusRef.current = returnTarget;
      returnSubagentRunIdRef.current = runId;
      subagentDetailRequestRef.current = undefined;
      setSelectedSubagentRunId(runId);
      setSubagentDetailLoading(
        Boolean(subagentViews.find((entry) => entry.runId === runId && !entry.snapshot)),
      );
      setSubagentFocusDetailVersion((version) => version + 1);
      setSubagentDetailRequestVersion((version) => version + 1);
      setSubagentDetailError(null);
      show("subagents");
    },
    [show, subagentViews, subagentsEnabled],
  );

  const selectSubagent = React.useCallback(
    (runId: string | null) => {
      if (!subagentsEnabled) return;
      subagentDetailRequestRef.current = undefined;
      setSelectedSubagentRunId(runId);
      setSubagentDetailLoading(
        Boolean(runId && subagentViews.find((entry) => entry.runId === runId && !entry.snapshot)),
      );
      setSubagentDetailRequestVersion((version) => version + 1);
      setSubagentDetailError(null);
    },
    [subagentViews, subagentsEnabled],
  );

  const retrySubagentDetail = React.useCallback(() => {
    if (!subagentsEnabled || !selectedSubagentRunId) return;
    subagentDetailRequestRef.current = undefined;
    setSubagentDetailLoading(true);
    setSubagentDetailError(null);
    setSubagentDetailRequestVersion((version) => version + 1);
  }, [selectedSubagentRunId, subagentsEnabled]);

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
      const result = await subagentsApi.stop(chatId, run.runId);
      if (result.action !== "stop") {
        throw new Error("Aiden returned an invalid Stop result.");
      }
      setSubagents((current) => {
        if (current.chatId !== chatId || current.workspaceId !== workspaceId) return current;
        return {
          ...current,
          liveSnapshots: mergeSubagentSnapshots(current.liveSnapshots, [result.snapshot], {
            chatId,
            workspaceId,
          }),
        };
      });
    },
    [subagentsEnabled],
  );

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
    if (open && tab === "subagents" && !selectedSubagentRunId && resolved) {
      setSelectedSubagentRunId(resolved);
      setSubagentDetailLoading(
        Boolean(subagentViews.find((entry) => entry.runId === resolved && !entry.snapshot)),
      );
    }
  }, [open, selectedSubagentRunId, subagentViews, subagentsEnabled, tab]);

  React.useEffect(() => {
    if (!subagentsEnabled) return;
    const chatId = subagents.chatId;
    const workspaceId = subagents.workspaceId;
    const runId = selectedSubagentRunId;
    subagentDetailRequestRef.current = undefined;
    if (!chatId || !workspaceId || !runId || !selectedSubagentGenerationId) return;
    if (selectedSubagentSnapshotRevision !== undefined) {
      setSubagentDetailLoading(false);
    }
    const request = captureSubagentDetailRequest(
      chatId,
      {
        runId,
        generationId: selectedSubagentGenerationId,
      },
      workspaceId,
    );
    subagentDetailRequestRef.current = request;
    setSubagentDetailLoading(selectedSubagentSnapshotRevision === undefined);
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
        );
        if (!safeSnapshot) return;
        setSubagentEffectDetail({
          ownerKey: subagentPanelOwnerKey(chatId, workspaceId),
          runId,
          effects: detail?.effects ?? [],
        });
        setSubagents((current) => {
          if (current.chatId !== chatId || current.workspaceId !== workspaceId) return current;
          const existing = current.loadedSnapshots.find((entry) => entry.runId === runId);
          if (existing && existing.revision >= safeSnapshot.revision) return current;
          return {
            ...current,
            loadedSnapshots: [
              ...current.loadedSnapshots.filter((entry) => entry.runId !== runId),
              safeSnapshot,
            ],
          };
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
    selectedSubagentSnapshotRevision,
    subagents.chatId,
    subagents.workspaceId,
    subagentDetailRequestVersion,
    subagentsEnabled,
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

  const activeEditorState = editorState.workspaceId === activeId ? editorState : EMPTY_EDITOR_STATE;
  const displayedSubagentSelection = subagentPanelSelectionState(
    subagentViews,
    selectedSubagentRunId,
    open && tab === "subagents",
    subagentDetailLoading,
    subagentDetailError,
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

  const value = React.useMemo(
    () => ({
      open,
      compactModalOpen,
      tab,
      subagentsEnabled,
      reviewMode,
      fileRequest,
      close,
      setCompactModalOpen,
      setTab,
      show,
      toggle,
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
        subagentEffectDetail.runId === displayedSubagentSelection.runId
          ? subagentEffectDetail.effects
          : [],
      announceSubagentDetail,
      setSubagentAnnouncerHost,
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
      activeEditorState,
      agentBusy,
      announceSubagentDetail,
      cancelAgent,
      close,
      compactModalOpen,
      createWorktree,
      fileRequest,
      gitOperationBusy,
      gitMutationBlockedReason,
      open,
      openFile,
      openReview,
      openSubagent,
      reportEditorState,
      releaseSubagents,
      reviewMode,
      retrySubagentDetail,
      stopSubagent,
      selectSubagent,
      selectedSubagentRunId,
      displayedSubagentSelection.loading,
      displayedSubagentSelection.runId,
      subagentFocusDetailVersion,
      setCancelAgentHandler,
      setCompactModalOpen,
      setCreateWorktreeHandler,
      setTab,
      show,
      subagentDetailError,
      subagentEffectDetail,
      subagentDetailLoading,
      subagents,
      subagentCounts,
      subagentViews,
      subagentsEnabled,
      syncSubagents,
      tab,
      toggle,
    ],
  );
  return (
    <EnvironmentPanelContext.Provider value={value}>
      {subagentsEnabled ? (
        <SubagentLiveAnnouncer
          ownerKey={subagentPanelOwnerKey(subagents.chatId, subagents.workspaceId)}
          runs={subagents.liveSnapshots}
          detailRequest={subagentDetailAnnouncement}
          portalHost={open && tab !== "overview" ? subagentAnnouncerHost : null}
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
  const toggleShortcut = useShortcutLabel("environment.toggle");
  const toggleShortcutBinding = useShortcutBinding("environment.toggle");
  const { active } = useActiveWorkspace();
  const fullOpen = panel.open && panel.tab !== "overview";
  const compactModal = fullOpen && !inline;
  const compactTabs = width < 520;
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const setSubagentAnnouncerHost = panel.setSubagentAnnouncerHost;
  const setSurfaceRef = React.useCallback(
    (node: HTMLElement | null) => {
      surfaceRef.current = node;
      setSubagentAnnouncerHost(node);
    },
    [setSubagentAnnouncerHost],
  );
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const handledSubagentFocusRef = React.useRef(0);
  const widthRef = React.useRef(width);
  const previousSurfaceModeRef = React.useRef<EnvironmentSurfaceMode>({
    fullOpen,
    compactModal,
  });
  const activeFileRequest =
    panel.fileRequest?.workspaceId === active?.id ? panel.fileRequest : null;
  const representativeSubagent =
    panel.subagentViews.find((view) => !view.terminal) ?? panel.subagentViews[0];
  const panelTabs = availableEnvironmentPanelTabs(panel.subagentsEnabled);
  widthRef.current = width;

  React.useLayoutEffect(() => {
    if (!fullOpen) return;
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
  }, [fullOpen, panel.subagentFocusDetailVersion, panel.tab]);

  React.useLayoutEffect(() => {
    const previous = previousSurfaceModeRef.current;
    const next = { fullOpen, compactModal };
    previousSurfaceModeRef.current = next;
    focusEnvironmentCompactModalTransition(
      previous,
      next,
      surfaceRef.current,
      document.activeElement,
      activeTabRef.current,
    );
  }, [compactModal, fullOpen]);

  React.useEffect(() => {
    if (!compactModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Tab") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"]',
        )
      )
        return;
      const target = environmentCompactModalTabWrapTarget(
        environmentCompactModalFocusableTargets(surfaceRef.current),
        document.activeElement,
        event.shiftKey,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [compactModal]);

  const commitWidth = React.useCallback(
    (nextWidth: number) => {
      const clamped = clampEnvironmentPanelWidth(nextWidth, containerWidth);
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
        setWidth(
          clampEnvironmentPanelWidth(startWidth + startX - moveEvent.clientX, containerWidth),
        );
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
      ref={setSurfaceRef}
      id="environment-panel"
      inert={!fullOpen ? true : undefined}
      aria-hidden={!fullOpen ? true : undefined}
      role={compactModal ? "dialog" : undefined}
      aria-modal={compactModal ? true : undefined}
      aria-label="Environment work surface"
      tabIndex={compactModal ? -1 : undefined}
      className={cn(
        "environment-panel absolute inset-y-0 right-0 z-30 flex h-full min-h-0 flex-col overflow-hidden bg-popover text-primary",
        fullOpen ? "border-l border-separator" : "border-l-0",
        !inline && "shadow-dialog",
        resizing
          ? "transition-none"
          : "transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
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
        aria-valuemin={Math.min(MIN_PANEL_WIDTH, Math.max(0, containerWidth - PANEL_EDGE_GUTTER))}
        aria-valuemax={Math.min(MAX_PANEL_WIDTH, Math.max(0, containerWidth - PANEL_EDGE_GUTTER))}
        aria-valuenow={Math.round(width)}
        tabIndex={fullOpen ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-y-0 left-0 z-40 -ml-1 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-accent"
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
          {panelTabs.map((tab) => {
            const selected = panel.tab === tab;
            const Icon = tab === "review" ? GitCompareArrows : Files;
            const label = tab === "review" ? "Review" : tab === "subagents" ? "Subagents" : "Files";
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
                aria-label={label}
                title={compactTabs ? label : undefined}
                onClick={() => panel.setTab(tab)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const currentIndex = panelTabs.indexOf(tab);
                  const nextTab =
                    event.key === "Home"
                      ? panelTabs[0]
                      : event.key === "End"
                        ? panelTabs[panelTabs.length - 1]
                        : panelTabs[
                            (currentIndex +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              panelTabs.length) %
                              panelTabs.length
                          ];
                  panel.setTab(nextTab);
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[9px] px-2 text-small-strong outline-none transition-[background-color,box-shadow,color] duration-150 ease-out focus-visible:outline-none",
                  selected
                    ? "bg-popover text-primary shadow-control focus-visible:bg-popover"
                    : "text-secondary hover:bg-list-hover hover:text-primary active:bg-list-selection focus-visible:bg-list-selection",
                )}
              >
                {tab === "subagents" ? (
                  <SubagentOrb
                    role={representativeSubagent?.role}
                    state={representativeSubagent?.state ?? "finished"}
                    activity={representativeSubagent?.snapshot?.activity}
                    size={20}
                  />
                ) : (
                  <Icon className="size-3.5" />
                )}
                <span className={compactTabs ? "sr-only" : undefined}>{label}</span>
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
          aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)}
          title={`Close environment panel (${toggleShortcut})`}
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
              onDetailAnnouncement={panel.announceSubagentDetail}
              detailRequestVersion={panel.subagentFocusDetailVersion}
              compact={width < 620}
              active={panel.open && panel.tab === "subagents"}
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
  const subagentCounts = panel.subagentCounts;
  const hasSubagents = panel.subagentsEnabled && subagentCounts.active + subagentCounts.done > 0;
  const representativeSubagent =
    panel.subagentViews.find((view) => !view.terminal) ?? panel.subagentViews[0];

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
          <div className="flex min-h-0 flex-1 flex-col">
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
            {hasSubagents ? (
              <div className="shrink-0 border-t border-separator px-3 py-3">
                <Text as="h2" variant="small-strong" color="tertiary" className="mb-1 px-2">
                  Subagents
                </Text>
                <button
                  type="button"
                  onClick={() => panel.show("subagents")}
                  aria-label={`Open Subagents, ${subagentCounts.active} working, ${subagentCounts.done} done`}
                  className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none"
                >
                  <SubagentOrb
                    role={representativeSubagent?.role}
                    state={representativeSubagent?.state ?? "finished"}
                    activity={representativeSubagent?.snapshot?.activity}
                    size={20}
                  />
                  <span className="min-w-0 text-regular text-primary">
                    {subagentCounts.active} working
                  </span>
                  <span className="text-small tabular-nums text-tertiary">
                    {subagentCounts.done} done
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

export function EnvironmentWorkbench({ children }: React.PropsWithChildren) {
  const panel = useEnvironmentPanel();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const [resizing, setResizing] = React.useState(false);
  const [preferredWidth, setPreferredWidth] = React.useState(storedPanelWidth);
  const fullOpen = panel.open && panel.tab !== "overview";
  const { width: renderedWidth, inline } = resolveEnvironmentPanelLayout(
    preferredWidth,
    containerWidth,
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
  const setCompactModalOpen = panel.setCompactModalOpen;
  React.useLayoutEffect(() => {
    setCompactModalOpen(overlayOpen);
    return () => {
      setCompactModalOpen(false);
    };
  }, [overlayOpen, setCompactModalOpen]);

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
  return (
    <Button
      iconOnly
      variant="toolbar"
      size="large"
      onClick={() => (panel.open ? panel.close() : panel.show("overview"))}
      disabled={disabled}
      aria-label={panel.open ? "Hide environment" : "Show environment"}
      aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)}
      aria-pressed={panel.open}
      aria-controls={
        panel.open && panel.tab !== "overview" ? "environment-panel" : "environment-summary-card"
      }
      title={`Toggle environment (${toggleShortcut})`}
      data-environment-toggle
    >
      {panel.open ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}
