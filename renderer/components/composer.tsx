// Message composer. On a new chat the top-row folder opens the workspace picker;
// established chats reveal that folder in Finder. Git workspaces also show the
// current branch. The input
// row carries a new-chat button, a per-workspace permission control, the model
// picker, voice input, and send/stop.

import * as React from "react";
import {
  AlertDialog,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Textarea,
  Text,
  toast,
} from "./ui";
import { cn } from "../lib/ui-utils";
import {
  ArrowUp,
  ChevronDown,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
  Lock,
  Mic,
  Monitor,
  MousePointer2,
  OctagonAlert,
  Plus,
  ShieldQuestion,
  Square,
  X,
} from "lucide-react";
import { AidenIcon } from "./aiden-icon";
import { GitBranchPicker } from "./git-branch-picker";
import { WorkspacePicker } from "./workspace-picker";
import { useVoiceRecorder } from "../lib/use-voice-recorder";
import {
  GEMINI_RECORDED_RETRY_DESCRIPTION,
  GEMINI_RECORDED_RETRY_TITLE,
} from "../lib/gemini-recorded-retry";
import { attachmentsApi } from "../lib/ipc";
import { useDiscoveredSkills, useSettings } from "../lib/queries";
import type { Attachment, Chat, Workspace, WorkspacePermission } from "../lib/types";
import { composerSubmissionAllowed, computerUseControlState } from "../lib/computer-use-control";
import {
  dismissComputerUseNotice,
  shouldShowComputerUseNotice,
  useComputerUseNoticeDismissed,
} from "../lib/computer-use-notice";
import { composerPlaceholder } from "../lib/composer-placeholder";
import { useCommandSystem } from "../lib/command-system";
import {
  consumeSlashToken,
  deriveSlashSession,
  failedSendAttachments,
  failedSendDraft,
  moveSlashSelectionId,
  pageSlashSelectionId,
  rankSlashResults,
  slashActionCommitIsCurrent,
  slashActionDraftCommitIsCurrent,
  slashTabAcceptsSelection,
  updateSlashSessionTracker,
  type SelectedSkillInvocation,
  type SlashResult,
  type SlashSessionTracker,
  selectedSkillComposerReducer,
  selectedSkillStatus,
} from "../lib/slash-command-core";
import {
  attemptSlashCommandAction,
  slashCommandAvailability,
  validateSlashCommandArgument,
} from "../lib/slash-command-actions";
import { isAppendReconciliationRequired } from "../shared/chat-message-contract";
import {
  COMPOSER_SLASH_PALETTE_ID,
  COMPOSER_SLASH_RETRY_ID,
  ComposerSlashPalette,
  ComposerSlashPalettePresence,
} from "./composer-slash-palette";
import type { SettingsSection } from "../shared/settings-section";
import type { SkillInvocationV1, SkillSource } from "../shared/slash-commands";
import { filterForkTurnChoices, forkTurnEligibility } from "../lib/chat-copy-view";
import { MAX_FORK_QUERY_CODE_UNITS } from "../shared/chat-copy-contract";
import {
  attachmentInlineBytesRemaining,
  attachmentSlotsRemaining,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../shared/attachment-contract";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../shared/chat-message-contract";

const CLIPBOARD_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
]);
const MAX_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

interface ComposerProps {
  /** Optional surface-specific prompt shown when the composer is ready. */
  placeholder?: string;
  /** True when a provider + model are selected and a message can be sent. */
  ready: boolean;
  /** Actionable explanation for a disabled send state. */
  readinessMessage?: string;
  /** True once this chat has a persisted message. */
  hasMessages: boolean;
  /** Stable identifier used to select an empty-chat prompt. */
  chatId: string;
  onSend: (
    text: string,
    attachments: Attachment[],
    skillInvocation?: SkillInvocationV1,
    options?: { visualize?: boolean; btw?: boolean },
  ) => Promise<void>;
  onStop: () => void;
  isGenerating: boolean;
  canStopGeneration?: boolean;
  /** Blocks both click and Enter submission while a model-scoped option is being saved. */
  configurationBusy?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Places the same composer state inside the compact Design conversation rail. */
  placement?: "chat" | "design-conversation";
  /** Keeps a containing surface visible while private or asynchronous controls need attention. */
  onVisibilityRequirementChange?: (required: boolean) => void;
  workspace?: Workspace;
  /** Current git branch of the workspace folder, or undefined if not a repo. */
  gitBranch?: string;
  gitDetached?: boolean;
  gitUnborn?: boolean;
  onOpenFolder?: () => void;
  onChangePermission?: (permission: WorkspacePermission) => void | Promise<void>;
  workspacePickerEnabled?: boolean;
  workspaces?: Workspace[];
  onSelectWorkspace?: (workspaceId: string) => Promise<void>;
  onCreateScratchWorkspace?: () => Promise<void>;
  onCreateGitWorktree?: (branchName: string) => Promise<void>;
  onGitOperationBusyChange?: (busy: boolean) => void;
  gitOperationBusy?: boolean;
  workspaceChangeBlockedReason?: string;
  gitWorktreeDescription?: string;
  gitMutationBlockedReason?: string;
  /** Whether the selected model accepts image input. */
  visionSupported?: boolean;
  /** Ephemeral canvas selections attached to the next Design turn. */
  designContextItems?: readonly {
    id: string;
    label: string;
    kind: "design" | "element" | "image";
  }[];
  onRemoveDesignContextItem?: (id: string) => void;
  /** The model picker element, rendered in the input row. */
  modelPicker?: React.ReactNode;
  /** Native model reasoning effort control, rendered only for supported models. */
  thinkingControl?: React.ReactNode;
  /** Global-beta readiness plus this chat's local Computer Use opt-in. */
  computerUse?: {
    enabled: boolean;
    ready: boolean;
    checking: boolean;
    saving: boolean;
    detail: string;
  };
  onChangeComputerUse?: (enabled: boolean) => void | Promise<void>;
  currentChatTitle?: string;
  latestAssistantResponse?: string;
  slashNavigationBlockedReason?: string;
  slashSessionBlockedReason?: string;
  sideQuestionBlockedReason?: string;
  onOpenSettings?: (section?: SettingsSection) => void;
  onRenameChat?: (title: string) => void | Promise<void>;
  onOpenReview?: () => void;
  sessionChat?: Chat;
  authenticatedProviders?: Array<{ id: string; label: string; detail: string }>;
  onCloneChat?: () => Promise<void>;
  onForkChat?: (throughAssistantMessageId: string) => Promise<void>;
  onExportChat?: () => Promise<"saved" | "cancelled">;
  onCompactChat?: () => Promise<
    | { compacted: true; tokensBefore?: number }
    | {
        compacted: false;
        reason:
          | "already_compact"
          | "busy"
          | "archived"
          | "not_canonical"
          | "provider_unavailable"
          | "context_metadata_invalid"
          | "cancelled"
          | "compaction_failed";
      }
  >;
  onCancelCompact?: () => Promise<boolean>;
  onLogoutProvider?: (providerId: string) => Promise<{ remainingAuthenticated: boolean | null }>;
  slashPaletteBlocked?: boolean;
  slashActionBusy?: boolean;
}
const PERMISSION_META: Record<
  WorkspacePermission,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    className: string;
  }
> = {
  full: {
    label: "Full access",
    icon: OctagonAlert,
    className: "text-support-warning",
  },
  ask: {
    label: "Ask first",
    icon: ShieldQuestion,
    className: "text-secondary",
  },
  none: {
    label: "No access",
    icon: Lock,
    className: "text-tertiary",
  },
};
const PERMISSION_ORDER: readonly WorkspacePermission[] = ["full", "ask", "none"];

function skillSourceLabel(source: SkillSource): string {
  return source === "configured" ? "Configured" : source === "workspace" ? "Workspace" : "Global";
}

interface ComposerDraftState {
  text: string;
  slashTracker: SlashSessionTracker;
}

type ComposerDraftAction =
  | { type: "update"; value: React.SetStateAction<string> }
  | { type: "dismiss-slash" };

function composerDraftReducer(
  state: ComposerDraftState,
  action: ComposerDraftAction,
): ComposerDraftState {
  if (action.type === "dismiss-slash") {
    return {
      ...state,
      slashTracker: {
        ...state.slashTracker,
        dismissedEpoch: state.slashTracker.epoch,
      },
    };
  }
  const text = typeof action.value === "function" ? action.value(state.text) : action.value;
  return {
    text,
    slashTracker: updateSlashSessionTracker(state.slashTracker, text),
  };
}

export function Composer({
  placeholder,
  ready,
  readinessMessage,
  hasMessages,
  chatId,
  onSend,
  onStop,
  isGenerating,
  canStopGeneration = isGenerating,
  configurationBusy = false,
  inputRef,
  placement = "chat",
  onVisibilityRequirementChange,
  workspace,
  gitBranch,
  gitDetached,
  gitUnborn,
  onOpenFolder,
  onChangePermission,
  workspacePickerEnabled,
  workspaces = [],
  onSelectWorkspace,
  onCreateScratchWorkspace,
  onCreateGitWorktree,
  onGitOperationBusyChange,
  gitOperationBusy = false,
  workspaceChangeBlockedReason,
  gitWorktreeDescription = "Creates a separate workspace and keeps this checkout unchanged.",
  gitMutationBlockedReason,
  visionSupported,
  designContextItems = [],
  onRemoveDesignContextItem,
  computerUse,
  onChangeComputerUse,
  modelPicker,
  thinkingControl,
  currentChatTitle,
  latestAssistantResponse,
  slashNavigationBlockedReason,
  slashSessionBlockedReason,
  sideQuestionBlockedReason,
  onOpenSettings,
  onRenameChat,
  onOpenReview,
  sessionChat,
  authenticatedProviders = [],
  onCloneChat,
  onForkChat,
  onExportChat,
  onCompactChat,
  onCancelCompact,
  onLogoutProvider,
  slashPaletteBlocked = false,
  slashActionBusy = false,
}: ComposerProps) {
  const [draft, dispatchDraft] = React.useReducer(composerDraftReducer, {
    text: "",
    slashTracker: { epoch: 0, active: false },
  });
  const { text, slashTracker } = draft;
  const draftRef = React.useRef(draft);
  React.useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const slashActionPendingRef = React.useRef(false);
  const sessionCommandBusyRef = React.useRef(false);
  const slashPaletteBlockedRef = React.useRef(slashPaletteBlocked);
  const slashInteractionRevisionRef = React.useRef(0);
  const textRevisionRef = React.useRef(0);
  const attachmentRevisionRef = React.useRef(0);
  const markSlashInteraction = React.useCallback(() => {
    slashInteractionRevisionRef.current += 1;
  }, []);
  const setText = React.useCallback((value: React.SetStateAction<string>) => {
    const current = draftRef.current;
    const text = typeof value === "function" ? value(current.text) : value;
    draftRef.current = {
      text,
      slashTracker: updateSlashSessionTracker(current.slashTracker, text),
    };
    slashInteractionRevisionRef.current += 1;
    textRevisionRef.current += 1;
    dispatchDraft({ type: "update", value: text });
  }, []);
  const dismissSlash = React.useCallback(() => {
    slashInteractionRevisionRef.current += 1;
    dispatchDraft({ type: "dismiss-slash" });
  }, []);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const attachmentsRef = React.useRef<Attachment[]>([]);
  const updateAttachments = React.useCallback((value: React.SetStateAction<Attachment[]>) => {
    const next = typeof value === "function" ? value(attachmentsRef.current) : value;
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const [skillSelection, dispatchSkillSelection] = React.useReducer(selectedSkillComposerReducer, {
    selected: undefined,
    revision: 0,
  });
  const selectedSkill = skillSelection.selected;
  const [attaching, setAttaching] = React.useState(false);
  const [attachmentStatus, setAttachmentStatus] = React.useState("");
  const attachmentOperationRef = React.useRef(false);
  const attachmentDescriptionId = React.useId();
  const [sending, setSending] = React.useState(false);
  const sendPendingRef = React.useRef(false);
  const [permissionSaving, setPermissionSaving] = React.useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = React.useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = React.useState(false);
  const permissionControlRef = React.useRef<HTMLButtonElement>(null);
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false);
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);
  const [forkDialogOpen, setForkDialogOpen] = React.useState(false);
  const [forkQuery, setForkQuery] = React.useState("");
  const [sessionDialogOpen, setSessionDialogOpen] = React.useState(false);
  const [logoutChooserOpen, setLogoutChooserOpen] = React.useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = React.useState(false);
  const [logoutProvider, setLogoutProvider] = React.useState<{
    id: string;
    label: string;
    detail: string;
  }>();
  const [sessionCommandStatus, setSessionCommandStatus] = React.useState<string | null>(null);
  const sessionCommandBusy = sessionCommandStatus !== null;
  const [worktreeRequest, setWorktreeRequest] = React.useState(0);
  const [selection, setSelection] = React.useState({ start: 0, end: 0 });
  const [composing, setComposing] = React.useState(false);
  const [activeSlashId, setActiveSlashId] = React.useState<string>();
  const updateSelection = React.useCallback(
    (next: React.SetStateAction<{ start: number; end: number }>) => {
      markSlashInteraction();
      setSelection(next);
    },
    [markSlashInteraction],
  );
  React.useLayoutEffect(
    () => () => {
      slashInteractionRevisionRef.current += 1;
    },
    [],
  );
  const commandSystem = useCommandSystem();
  const computerUseDescriptionId = React.useId();
  const computerUseNoticeDismissed = useComputerUseNoticeDismissed();
  const showComputerUseNotice = shouldShowComputerUseNotice(
    computerUse?.enabled === true,
    computerUseNoticeDismissed,
  );
  const submissionAllowed =
    composerSubmissionAllowed({
      ready,
      isGenerating,
      sending,
      permissionSaving,
      computerUseSaving: computerUse?.saving === true,
      gitOperationBusy,
      attaching,
    }) &&
    !configurationBusy &&
    !sessionCommandBusy;
  const settings = useSettings();
  const skillCatalog = useDiscoveredSkills(workspace?.id);
  const selectedSkillState = React.useMemo(
    () =>
      selectedSkill
        ? selectedSkillStatus(
            selectedSkill,
            workspace?.id,
            skillCatalog.data,
            skillCatalog.isError ? "error" : skillCatalog.isFetching ? "loading" : "ready",
          )
        : undefined,
    [
      selectedSkill,
      skillCatalog.data,
      skillCatalog.isError,
      skillCatalog.isFetching,
      workspace?.id,
    ],
  );
  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    submissionAllowed &&
    !composing &&
    (!selectedSkillState || selectedSkillState.state === "valid");
  const voice = useVoiceRecorder(
    (transcript) => setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript)),
    {
      provider: settings.data?.voiceProvider ?? "openai",
      localModel: settings.data?.localVoiceModel,
      model: settings.data?.voiceModel,
    },
  );
  const requiresVisibleComposer =
    voice.recording || voice.transcribing || attaching || sending || sessionCommandBusy;

  React.useEffect(() => {
    onVisibilityRequirementChange?.(requiresVisibleComposer);
  }, [onVisibilityRequirementChange, requiresVisibleComposer]);

  React.useEffect(
    () => () => onVisibilityRequirementChange?.(false),
    [onVisibilityRequirementChange],
  );

  React.useLayoutEffect(() => {
    slashPaletteBlockedRef.current = slashPaletteBlocked;
    if (slashPaletteBlocked) dismissSlash();
  }, [dismissSlash, slashPaletteBlocked]);

  const forkEligibility = React.useMemo(() => {
    if (!sessionChat) return { turns: [], cloneBlocked: false };
    return forkTurnEligibility(sessionChat.messages);
  }, [sessionChat]);
  const completedForkTurns = forkEligibility.turns;
  const visibleForkTurns = React.useMemo(() => {
    return filterForkTurnChoices(completedForkTurns, forkQuery);
  }, [completedForkTurns, forkQuery]);

  const slashSession = React.useMemo(
    () =>
      slashPaletteBlocked ||
      confirmFullAccess ||
      renameDialogOpen ||
      forkDialogOpen ||
      sessionDialogOpen ||
      logoutChooserOpen ||
      logoutConfirmOpen ||
      permissionMenuOpen
        ? null
        : deriveSlashSession({
            draft: text,
            selectionStart: selection.start,
            selectionEnd: selection.end,
            composing,
            tracker: slashTracker,
          }),
    [
      composing,
      confirmFullAccess,
      forkDialogOpen,
      logoutChooserOpen,
      logoutConfirmOpen,
      permissionMenuOpen,
      renameDialogOpen,
      sessionDialogOpen,
      selection.end,
      selection.start,
      slashTracker,
      slashPaletteBlocked,
      text,
    ],
  );
  const rankedSlashResults = React.useMemo(
    () =>
      rankSlashResults(
        slashSession?.query ?? "",
        skillCatalog.data ?? [],
        slashSession?.kind ?? "command",
      ),
    [skillCatalog.data, slashSession?.kind, slashSession?.query],
  );
  const slashActionContext = React.useMemo(
    () => ({
      canExecuteCommand: commandSystem.canExecute,
      hasChat: Boolean(sessionChat),
      hasCompletedTurn: completedForkTurns.length > 0,
      hasLatestAssistantResponse: Boolean(latestAssistantResponse),
      hasAuthenticatedProvider: authenticatedProviders.length > 0,
      hasWorkspace: Boolean(workspace),
      hasWorkspaceArtifactAccess: workspace?.permission !== "none",
      hasManagedWorktreeFlow: Boolean(
        workspace?.folderPath && gitBranch && onCreateGitWorktree && !gitUnborn,
      ),
      idle:
        !slashActionBusy &&
        !isGenerating &&
        !sending &&
        !sessionCommandBusy &&
        !attaching &&
        !voice.recording &&
        !voice.transcribing,
      idleBlockedReason: attaching
        ? "Wait for the selected attachments to finish loading."
        : voice.recording || voice.transcribing
          ? "Finish voice input before changing this session."
          : undefined,
      navigationBlockedReason: slashNavigationBlockedReason,
      sessionActionBlockedReason: slashSessionBlockedReason,
      sideQuestionBlockedReason,
      chatCloneBlockedReason: forkEligibility.cloneBlocked
        ? "This chat has too many messages to clone safely. Fork from an earlier turn instead."
        : undefined,
      worktreeBlockedReason:
        gitMutationBlockedReason ??
        workspaceChangeBlockedReason ??
        (gitOperationBusy ? "Wait for the current Git operation to finish." : undefined),
      composerControlBlockedReason: permissionSaving
        ? "Wait for workspace access to finish updating."
        : workspaceChangeBlockedReason
          ? workspaceChangeBlockedReason
          : gitOperationBusy
            ? "Wait for the current Git operation to finish."
            : slashActionBusy || isGenerating || sending
              ? "Finish the current response first."
              : undefined,
      environmentBlockedReason: gitOperationBusy
        ? "Wait for the current Git operation to finish before changing panels."
        : undefined,
      payloadAfterToken: slashSession
        ? Boolean(
            consumeSlashToken(text, slashSession).trim() || attachments.length > 0 || selectedSkill,
          )
        : Boolean(text.trim() || attachments.length > 0 || selectedSkill),
      hasAttachmentsOrSelectedSkill: attachments.length > 0 || Boolean(selectedSkill),
    }),
    [
      attachments.length,
      attaching,
      commandSystem.canExecute,
      authenticatedProviders.length,
      completedForkTurns.length,
      sessionChat,
      isGenerating,
      gitBranch,
      forkEligibility.cloneBlocked,
      gitOperationBusy,
      gitMutationBlockedReason,
      gitUnborn,
      latestAssistantResponse,
      permissionSaving,
      onCreateGitWorktree,
      sending,
      sessionCommandBusy,
      slashActionBusy,
      slashNavigationBlockedReason,
      slashSessionBlockedReason,
      sideQuestionBlockedReason,
      slashSession,
      selectedSkill,
      text,
      voice.recording,
      voice.transcribing,
      workspace,
      workspaceChangeBlockedReason,
    ],
  );
  const commandAvailability = React.useCallback(
    (result: Extract<SlashResult, { kind: "command" }>) =>
      slashCommandAvailability(result.command, slashActionContext),
    [slashActionContext],
  );
  const slashResultSelectable = React.useCallback(
    (result: SlashResult) =>
      result.kind === "skill" ? result.skill.available : commandAvailability(result).available,
    [commandAvailability],
  );
  const selectableSlashIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const result of rankedSlashResults.results) {
      if (slashResultSelectable(result)) ids.push(result.id);
    }
    if (slashSession?.kind === "skill" && skillCatalog.isError) {
      ids.push(COMPOSER_SLASH_RETRY_ID);
    }
    return ids;
  }, [rankedSlashResults.results, skillCatalog.isError, slashResultSelectable, slashSession?.kind]);
  const effectiveActiveSlashId = slashSession
    ? selectableSlashIds.includes(activeSlashId ?? "")
      ? activeSlashId
      : selectableSlashIds[0]
    : undefined;

  const requestRename = React.useCallback(
    (initialTitle?: string) => {
      setRenameTitle(initialTitle ?? currentChatTitle ?? "");
      setRenameDialogOpen(true);
    },
    [currentChatTitle],
  );

  const cloneChat = React.useCallback(async () => {
    if (!onCloneChat || sessionCommandBusy) return;
    sessionCommandBusyRef.current = true;
    setSessionCommandStatus("Cloning chat…");
    try {
      await onCloneChat();
      toast.success("Chat cloned");
    } finally {
      sessionCommandBusyRef.current = false;
      setSessionCommandStatus(null);
      requestAnimationFrame(() => inputRef?.current?.focus({ preventScroll: true }));
    }
  }, [inputRef, onCloneChat, sessionCommandBusy]);

  const exportChat = React.useCallback(async () => {
    if (!onExportChat || sessionCommandBusy) return;
    sessionCommandBusyRef.current = true;
    setSessionCommandStatus("Exporting chat…");
    try {
      const status = await onExportChat();
      if (status === "saved") toast.success("Aiden chat exported");
    } finally {
      sessionCommandBusyRef.current = false;
      setSessionCommandStatus(null);
      requestAnimationFrame(() => inputRef?.current?.focus({ preventScroll: true }));
    }
  }, [inputRef, onExportChat, sessionCommandBusy]);

  const compactChat = React.useCallback(async () => {
    if (!onCompactChat || sessionCommandBusy) return;
    sessionCommandBusyRef.current = true;
    setSessionCommandStatus("Compacting chat…");
    try {
      const result = await onCompactChat();
      if (result.compacted) {
        toast.success(
          result.tokensBefore
            ? `Chat compacted from about ${result.tokensBefore.toLocaleString()} tokens`
            : "Chat compacted",
        );
      } else {
        const copy = {
          already_compact: "This chat is already compact enough.",
          busy: "Finish the current response or approval first.",
          archived: "This chat is archived or unavailable.",
          not_canonical: "This legacy Bot conversation is read-only.",
          provider_unavailable: "The saved provider is unavailable.",
          context_metadata_invalid: "The saved model context is invalid.",
          cancelled: "Compaction was cancelled.",
          compaction_failed: "Compaction failed.",
        } as const;
        toast.info(copy[result.reason]);
      }
    } finally {
      sessionCommandBusyRef.current = false;
      setSessionCommandStatus(null);
      requestAnimationFrame(() => inputRef?.current?.focus({ preventScroll: true }));
    }
  }, [inputRef, onCompactChat, sessionCommandBusy]);

  const createWorktreeFromSlash = React.useCallback(
    async (branchName?: string) => {
      if (!branchName) {
        setWorktreeRequest((request) => request + 1);
        return;
      }
      if (!onCreateGitWorktree || sessionCommandBusy) return;
      sessionCommandBusyRef.current = true;
      setSessionCommandStatus("Creating worktree…");
      onGitOperationBusyChange?.(true);
      try {
        await onCreateGitWorktree(branchName);
        toast.success("Isolated worktree created");
      } finally {
        onGitOperationBusyChange?.(false);
        sessionCommandBusyRef.current = false;
        setSessionCommandStatus(null);
        requestAnimationFrame(() => inputRef?.current?.focus({ preventScroll: true }));
      }
    },
    [inputRef, onCreateGitWorktree, onGitOperationBusyChange, sessionCommandBusy],
  );

  const forkFromTurn = React.useCallback(
    async (messageId: string) => {
      if (!onForkChat || sessionCommandBusy) return;
      sessionCommandBusyRef.current = true;
      setSessionCommandStatus("Forking chat…");
      try {
        await onForkChat(messageId);
        setForkDialogOpen(false);
        toast.success("Chat forked");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't fork this chat.");
      } finally {
        sessionCommandBusyRef.current = false;
        setSessionCommandStatus(null);
      }
    },
    [onForkChat, sessionCommandBusy],
  );

  const logoutSelectedProvider = React.useCallback(async () => {
    if (!logoutProvider || !onLogoutProvider || sessionCommandBusy) return;
    sessionCommandBusyRef.current = true;
    setSessionCommandStatus("Signing out…");
    try {
      const result = await onLogoutProvider(logoutProvider.id);
      setLogoutConfirmOpen(false);
      setLogoutProvider(undefined);
      toast.success(
        result.remainingAuthenticated === true
          ? `Removed Aiden's saved ${logoutProvider.label} credential. Another system credential is still available.`
          : result.remainingAuthenticated === false
            ? `Signed out of ${logoutProvider.label} on this Mac.`
            : `Removed Aiden's saved ${logoutProvider.label} credential. Provider availability will refresh.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Provider sign-out did not complete. Try again.",
      );
    } finally {
      sessionCommandBusyRef.current = false;
      setSessionCommandStatus(null);
    }
  }, [logoutProvider, onLogoutProvider, sessionCommandBusy]);

  const sendComposerPayload = React.useCallback(
    async (payload: {
      draftText: string;
      sendText: string;
      attachments: Attachment[];
      selectedSkill?: SelectedSkillInvocation;
      skillRevision: number;
      visualize?: boolean;
      btw?: boolean;
    }): Promise<boolean> => {
      // React state does not close the same-tick Enter + click window. Claim
      // the send synchronously before making any optimistic UI changes.
      if (sendPendingRef.current) return false;
      sendPendingRef.current = true;
      setSending(true);

      setText("");
      const optimisticTextRevision = textRevisionRef.current;
      attachmentRevisionRef.current += 1;
      const optimisticAttachmentRevision = attachmentRevisionRef.current;
      updateAttachments([]);
      const optimisticSkillRevision = payload.skillRevision + 1;
      dispatchSkillSelection({
        type: "send-started",
        submittedRevision: payload.skillRevision,
      });

      try {
        await onSend(
          payload.sendText,
          payload.attachments,
          payload.selectedSkill?.invocation,
          payload.visualize || payload.btw
            ? { visualize: payload.visualize, btw: payload.btw }
            : undefined,
        );
        return true;
      } catch (error) {
        // An unknown append result may already be durable. ChatPane blocks
        // another send until reload, so restoring it here would invite a
        // duplicate message with a new turn identity.
        if (!isAppendReconciliationRequired(error)) {
          const currentDraft = draftRef.current.text;
          const restoredDraft = failedSendDraft(payload.draftText, currentDraft);
          if (
            textRevisionRef.current === optimisticTextRevision ||
            restoredDraft !== currentDraft
          ) {
            setText(restoredDraft);
          }

          const currentAttachments = attachmentsRef.current;
          const restoredAttachments = failedSendAttachments(
            payload.attachments,
            currentAttachments,
          );
          if (
            attachmentRevisionRef.current === optimisticAttachmentRevision ||
            restoredAttachments.length !== currentAttachments.length
          ) {
            attachmentRevisionRef.current += 1;
            updateAttachments(restoredAttachments);
          }
          dispatchSkillSelection({
            type: "send-failed",
            optimisticRevision: optimisticSkillRevision,
            submitted: payload.selectedSkill,
          });
        }
        throw error;
      } finally {
        sendPendingRef.current = false;
        setSending(false);
      }
    },
    [onSend, setText, updateAttachments],
  );

  const selectSlashResult = React.useCallback(
    async (result: SlashResult) => {
      if (
        slashActionPendingRef.current ||
        !slashSession ||
        result.kind !== slashSession.kind ||
        !slashResultSelectable(result)
      ) {
        return;
      }
      if (result.kind === "skill") {
        if (!workspace?.id) return;
        const nextText = consumeSlashToken(text, slashSession);
        const nextCaret = slashSession.tokenStart;
        dispatchSkillSelection({
          type: "select",
          selected: {
            workspaceId: workspace.id,
            invocation: {
              version: 1,
              invocationId: result.skill.invocationId,
              displayName: result.skill.name,
              source: result.skill.source,
            },
          },
        });
        setText(nextText);
        dismissSlash();
        setActiveSlashId(undefined);
        requestAnimationFrame(() => {
          const textarea = inputRef?.current;
          if (!textarea) return;
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(nextCaret, nextCaret);
          setSelection({ start: nextCaret, end: nextCaret });
        });
        return;
      }
      const argument = validateSlashCommandArgument(result.command, slashSession.argument);
      if (!argument.valid) {
        toast.info(argument.reason ?? "That command argument is invalid.");
        return;
      }
      const nextText =
        result.command.argument !== "none"
          ? text.slice(0, slashSession.tokenStart)
          : consumeSlashToken(text, slashSession);
      const nextCaret = slashSession.tokenStart;
      const expectedCommit = {
        draft: text,
        epoch: slashTracker.epoch,
        interactionRevision: slashInteractionRevisionRef.current,
        blocked: slashPaletteBlockedRef.current,
      };
      const attempted = attemptSlashCommandAction(result.command, argument.value ?? "", {
        executeCommand: commandSystem.execute,
        openSettings: (section) => onOpenSettings?.(section),
        requestRename,
        copyLatestResponse: async () => {
          if (!latestAssistantResponse) return;
          await navigator.clipboard.writeText(latestAssistantResponse);
          toast.success("Latest response copied");
        },
        openReview: () => onOpenReview?.(),
        openAccess: () => {
          setPermissionMenuOpen(true);
          requestAnimationFrame(() => permissionControlRef.current?.focus());
        },
        openFork: () => {
          setForkQuery("");
          setForkDialogOpen(true);
        },
        cloneChat,
        exportChat,
        compactChat,
        openSessionDetails: () => setSessionDialogOpen(true),
        openLogout: () => setLogoutChooserOpen(true),
        openWorktree: createWorktreeFromSlash,
        submitComposerInstruction: async (instruction, prompt) => {
          if (instruction !== "visualize" && instruction !== "btw") return false;
          const nextPrompt = prompt.trim() || consumeSlashToken(text, slashSession).trim();
          const missingPromptMessage =
            instruction === "btw"
              ? "Add a question after /btw, then send."
              : "Add what to visualize after /visualize, then send.";
          if (!nextPrompt) {
            toast.info(missingPromptMessage);
            return false;
          }
          if (instruction === "btw" && (attachments.length > 0 || selectedSkill)) {
            toast.info("Remove attachments and the selected skill before asking a side question.");
            return false;
          }
          if (selectedSkillState && selectedSkillState.state !== "valid") {
            toast.info(selectedSkillState.reason);
            return false;
          }
          const submittedAttachments = attachments;
          const submittedSkillRevision = skillSelection.revision;
          if (instruction === "visualize") {
            return sendComposerPayload({
              draftText: text,
              sendText: nextPrompt,
              attachments: submittedAttachments,
              selectedSkill,
              skillRevision: submittedSkillRevision,
              visualize: true,
            });
          }
          return sendComposerPayload({
            draftText: text,
            sendText: nextPrompt,
            attachments: submittedAttachments,
            selectedSkill,
            skillRevision: submittedSkillRevision,
            btw: true,
          });
        },
      });
      const asyncAction = attempted.kind === "async";
      if (asyncAction) slashActionPendingRef.current = true;
      const attempt = asyncAction ? await attempted.completion : attempted;
      if (asyncAction) slashActionPendingRef.current = false;
      if (attempt.error) {
        toast.error(
          attempt.error instanceof Error
            ? attempt.error.message
            : "That command could not be completed.",
        );
        return;
      }
      if (!attempt.handled) {
        toast.info("That app action is unavailable right now.");
        return;
      }
      // Composer instructions own their optimistic clear and guarded rollback.
      // A generic late slash-token commit would overwrite the next-turn draft.
      if (result.command.action.kind === "composer-instruction") return;
      const usesDraftOnlyCommit =
        result.command.action.kind === "session" &&
        (result.command.action.action === "clone" ||
          result.command.action.action === "export" ||
          result.command.action.action === "worktree");
      if (
        asyncAction &&
        !(usesDraftOnlyCommit
          ? slashActionDraftCommitIsCurrent(expectedCommit, {
              draft: draftRef.current.text,
              epoch: draftRef.current.slashTracker.epoch,
            })
          : slashActionCommitIsCurrent(expectedCommit, {
              draft: draftRef.current.text,
              epoch: draftRef.current.slashTracker.epoch,
              interactionRevision: slashInteractionRevisionRef.current,
              blocked: slashPaletteBlockedRef.current,
            }))
      ) {
        toast.info("Command completed; your newer draft and slash session were left unchanged.");
        return;
      }
      setText(nextText);
      dismissSlash();
      setActiveSlashId(undefined);
      requestAnimationFrame(() => {
        const textarea = inputRef?.current;
        if (!textarea || document.activeElement !== textarea) return;
        textarea.setSelectionRange(nextCaret, nextCaret);
        setSelection({ start: nextCaret, end: nextCaret });
      });
    },
    [
      commandSystem.execute,
      slashTracker.epoch,
      dismissSlash,
      inputRef,
      latestAssistantResponse,
      cloneChat,
      createWorktreeFromSlash,
      exportChat,
      compactChat,
      onOpenReview,
      onOpenSettings,
      sendComposerPayload,
      attachments,
      selectedSkill,
      selectedSkillState,
      skillSelection.revision,
      requestRename,
      slashResultSelectable,
      slashSession,
      text,
      workspace?.id,
    ],
  );

  const saveRename = React.useCallback(async () => {
    const title = renameTitle.trim();
    if (!title || !onRenameChat || renaming) return;
    setRenaming(true);
    try {
      await onRenameChat(title);
      setRenameDialogOpen(false);
      toast.success("Chat renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't rename this chat.");
    } finally {
      setRenaming(false);
    }
  }, [onRenameChat, renameTitle, renaming]);

  const beginAttachmentRead = (status: string): boolean => {
    if (gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before attaching files.");
      return false;
    }
    if (attachmentOperationRef.current) {
      toast.info("Wait for the current attachments to finish loading.");
      return false;
    }
    attachmentOperationRef.current = true;
    setAttaching(true);
    setAttachmentStatus(status);
    return true;
  };

  const finishAttachmentRead = () => {
    attachmentOperationRef.current = false;
    setAttaching(false);
    requestAnimationFrame(() => inputRef?.current?.focus({ preventScroll: true }));
  };

  const acceptReadAttachments = (added: Attachment[], emptyStatus: string): number => {
    if (visionSupported === false && added.some((attachment) => attachment.kind === "image")) {
      added = added.filter((attachment) => attachment.kind !== "image");
      toast.info("The selected model can't read images — image attachments were skipped.");
    }
    if (added.length === 0) {
      setAttachmentStatus(emptyStatus);
      return 0;
    }
    attachmentRevisionRef.current += 1;
    updateAttachments((current) => [...current, ...added]);
    setAttachmentStatus(
      `${added.length} ${added.length === 1 ? "attachment is" : "attachments are"} ready.`,
    );
    return added.length;
  };

  const handleAttach = async () => {
    if (!beginAttachmentRead("Attachment picker open. Selected files will load before sending.")) {
      return;
    }
    try {
      const remainingSlots = attachmentSlotsRemaining(attachments.length);
      if (remainingSlots <= 0) {
        setAttachmentStatus("The attachment count limit has been reached.");
        toast.info(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
        return;
      }
      const remainingInlineBytes = attachmentInlineBytesRemaining(attachments);
      if (remainingInlineBytes <= 0) {
        setAttachmentStatus("The attachment data limit has been reached.");
        toast.info("This message has reached the attachment data limit.");
        return;
      }
      const picked = await attachmentsApi.pickAndRead(
        remainingSlots,
        visionSupported !== false,
        remainingInlineBytes,
      );
      if (picked.skipped > 0) {
        toast.info(
          `${picked.skipped} selected ${picked.skipped === 1 ? "file was" : "files were"} skipped because of the attachment limit or model support.`,
        );
      }
      acceptReadAttachments(picked.attachments, "No compatible attachments were added.");
    } catch (error) {
      setAttachmentStatus("Attachments could not be loaded.");
      toast.error(error instanceof Error ? error.message : "Couldn't read that file.");
    } finally {
      finishAttachmentRead();
    }
  };

  const readDroppedAttachments = async (files: File[]) => {
    if (!beginAttachmentRead("Dropped files are loading before sending.")) return;
    try {
      const remainingSlots = attachmentSlotsRemaining(attachments.length);
      const remainingInlineBytes = attachmentInlineBytesRemaining(attachments);
      if (remainingSlots <= 0 || remainingInlineBytes <= 0) {
        toast.info("This message has reached its attachment limit.");
        setAttachmentStatus("The attachment limit has been reached.");
        return;
      }
      const added = await attachmentsApi.readDroppedFiles(
        files,
        remainingSlots,
        visionSupported !== false,
        remainingInlineBytes,
      );
      const accepted = acceptReadAttachments(added, "No compatible dropped files were added.");
      if (accepted < files.length) {
        toast.info(
          `${files.length - accepted} dropped ${files.length - accepted === 1 ? "file was" : "files were"} skipped because of the attachment limit or model support.`,
        );
      }
    } catch (error) {
      setAttachmentStatus("Dropped files could not be loaded.");
      toast.error(error instanceof Error ? error.message : "Couldn't read that dropped file.");
    } finally {
      finishAttachmentRead();
    }
  };

  const readClipboardImages = async (files: File[]) => {
    if (!beginAttachmentRead("Clipboard images are loading before sending.")) return;
    try {
      const remainingSlots = attachmentSlotsRemaining(attachments.length);
      const remainingInlineBytes = attachmentInlineBytesRemaining(attachments);
      const eligible: File[] = [];
      let plannedBytes = 0;
      for (const file of files) {
        if (
          eligible.length >= remainingSlots ||
          file.size <= 0 ||
          file.size > MAX_CLIPBOARD_IMAGE_BYTES ||
          !CLIPBOARD_IMAGE_MIME_TYPES.has(file.type.toLowerCase()) ||
          plannedBytes + file.size > remainingInlineBytes
        ) {
          continue;
        }
        plannedBytes += file.size;
        eligible.push(file);
      }
      if (eligible.length === 0 || remainingInlineBytes <= 0) {
        setAttachmentStatus("No compatible clipboard images were added.");
        toast.info("Clipboard images were empty, unsupported, or beyond the attachment limit.");
        return;
      }
      const payload = await Promise.all(
        eligible.map(async (file) => ({
          mimeType: file.type.toLowerCase(),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      const added = await attachmentsApi.readClipboardImages(
        payload,
        remainingSlots,
        remainingInlineBytes,
      );
      const accepted = acceptReadAttachments(added, "No clipboard images were added.");
      if (accepted < files.length) {
        toast.info(
          `${files.length - accepted} clipboard ${files.length - accepted === 1 ? "image was" : "images were"} skipped because of the attachment limit or model support.`,
        );
      }
    } catch (error) {
      setAttachmentStatus("Clipboard images could not be loaded.");
      toast.error(error instanceof Error ? error.message : "Couldn't read that clipboard image.");
    } finally {
      finishAttachmentRead();
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    void readDroppedAttachments(files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).flatMap((item) => {
      if (item.kind !== "file" || !CLIPBOARD_IMAGE_MIME_TYPES.has(item.type.toLowerCase())) {
        return [];
      }
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    if (images.length === 0) return;
    event.preventDefault();

    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const cursor = start + pastedText.length;
      setText((current) => `${current.slice(0, start)}${pastedText}${current.slice(end)}`);
      requestAnimationFrame(() => {
        target.setSelectionRange(cursor, cursor);
        updateSelection({ start: cursor, end: cursor });
      });
    }
    void readClipboardImages(images);
  };

  const removeAttachment = (id: string) => {
    attachmentRevisionRef.current += 1;
    updateAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = async () => {
    if (sendPendingRef.current || composing) return;
    if (attachmentOperationRef.current || attaching) {
      toast.info("Wait for the selected attachments to finish loading before sending.");
      return;
    }
    if (gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before sending.");
      return;
    }
    const trimmed = text.trim();
    if (new TextEncoder().encode(trimmed).byteLength > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
      toast.info("Message text exceeds the 1 MB limit.");
      return;
    }
    if ((!trimmed && attachments.length === 0) || !submissionAllowed) return;
    if (selectedSkillState && selectedSkillState.state !== "valid") {
      toast.info(selectedSkillState.reason);
      return;
    }
    if (
      visionSupported === false &&
      attachments.some((attachment) => attachment.kind === "image")
    ) {
      toast.info("Switch to a vision-capable model before sending these images.");
      return;
    }
    try {
      await sendComposerPayload({
        draftText: text,
        sendText: trimmed,
        attachments,
        selectedSkill,
        skillRevision: skillSelection.revision,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send this message.");
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashSession && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissSlash();
        setActiveSlashId(undefined);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        markSlashInteraction();
        setActiveSlashId((current) =>
          moveSlashSelectionId(
            selectableSlashIds,
            selectableSlashIds.includes(current ?? "") ? current : effectiveActiveSlashId,
            event.key === "ArrowDown" ? 1 : -1,
          ),
        );
        return;
      }
      if (
        event.key === "PageDown" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        event.preventDefault();
        markSlashInteraction();
        setActiveSlashId((current) =>
          event.key === "Home" || event.key === "End"
            ? moveSlashSelectionId(selectableSlashIds, undefined, event.key === "Home" ? 1 : -1)
            : pageSlashSelectionId(
                selectableSlashIds,
                selectableSlashIds.includes(current ?? "") ? current : effectiveActiveSlashId,
                event.key === "PageDown" ? 1 : -1,
              ),
        );
        return;
      }
      const selectableCount = selectableSlashIds.length;
      const acceptsSelection =
        (event.key === "Enter" && !event.shiftKey) ||
        (event.key === "Tab" &&
          slashTabAcceptsSelection(selectableCount, slashActionPendingRef.current));
      if (acceptsSelection && effectiveActiveSlashId) {
        if (effectiveActiveSlashId === COMPOSER_SLASH_RETRY_ID) {
          event.preventDefault();
          event.stopPropagation();
          markSlashInteraction();
          void skillCatalog.refetch();
          return;
        }
        const active = rankedSlashResults.results.find(
          (result) => result.id === effectiveActiveSlashId,
        );
        if (active && slashResultSelectable(active)) {
          event.preventDefault();
          event.stopPropagation();
          void selectSlashResult(active);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const permission = workspace?.permission ?? "ask";
  const PermissionIcon = PERMISSION_META[permission].icon;
  const folderName = workspace?.folderPath
    ? workspace.folderPath.split("/").filter(Boolean).pop()
    : workspace?.name;
  const computerUseControl = computerUseControlState({
    enabled: computerUse?.enabled ?? false,
    ready: computerUse?.ready ?? false,
    busy: computerUse?.saving === true || isGenerating || sending || gitOperationBusy,
  });

  const applyPermission = async (nextPermission: WorkspacePermission) => {
    if (workspaceChangeBlockedReason) {
      toast.info(workspaceChangeBlockedReason);
      return;
    }
    if (
      !onChangePermission ||
      nextPermission === permission ||
      permissionSaving ||
      isGenerating ||
      sending ||
      gitOperationBusy
    )
      return;
    setPermissionSaving(true);
    try {
      await onChangePermission(nextPermission);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't change workspace access.");
    } finally {
      setPermissionSaving(false);
    }
  };

  const requestPermission = (nextPermission: WorkspacePermission) => {
    if (workspaceChangeBlockedReason) {
      toast.info(workspaceChangeBlockedReason);
      return;
    }
    if (
      nextPermission === permission ||
      permissionSaving ||
      isGenerating ||
      sending ||
      gitOperationBusy
    )
      return;
    setPermissionMenuOpen(false);
    if (nextPermission === "full") {
      setConfirmFullAccess(true);
      return;
    }
    void applyPermission(nextPermission);
  };

  return (
    <>
      <div
        className={cn(
          "pointer-events-none",
          placement === "design-conversation"
            ? "w-full px-3 pb-3 pt-2"
            : "aiden-dock-inset chat-content-column pb-4 pt-3 sm:pb-5",
        )}
      >
        <div className="composer-responsive pointer-events-auto relative isolate">
          <ComposerSlashPalettePresence
            present={Boolean(slashSession)}
            immediate={
              slashPaletteBlocked || confirmFullAccess || renameDialogOpen || permissionMenuOpen
            }
          >
            {slashSession ? (
              <ComposerSlashPalette
                mode={slashSession.kind}
                results={rankedSlashResults.results}
                activeId={effectiveActiveSlashId}
                skillsLoading={skillCatalog.isLoading}
                skillsError={skillCatalog.isError}
                truncated={rankedSlashResults.truncated}
                commandAvailability={commandAvailability}
                onActiveIdChange={(id) => {
                  markSlashInteraction();
                  setActiveSlashId(id);
                }}
                onSelect={(result) => void selectSlashResult(result)}
                onRetrySkills={() => {
                  markSlashInteraction();
                  void skillCatalog.refetch();
                }}
                skillSelectionEnabled
              />
            ) : null}
          </ComposerSlashPalettePresence>
          {computerUse ? (
            <span id={computerUseDescriptionId} className="sr-only">
              Computer Use may send screenshots and accessibility text to the selected model. Every
              input action asks for approval.
            </span>
          ) : null}
          {showComputerUseNotice ? (
            <aside
              aria-label="Computer Use privacy notice"
              className="mx-3 mb-2 flex min-h-8 items-center gap-2 rounded-control bg-popover px-2.5 py-1.5 outline outline-1 outline-accent/20"
            >
              <MousePointer2 aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
              <Text as="p" variant="small" color="secondary" className="min-w-0 flex-1 text-pretty">
                <span className="font-medium text-primary">Computer Use is on.</span> Screen details
                may go to your model; actions still ask.
              </Text>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="transparent"
                    size="small"
                    className="h-6 shrink-0 gap-1 px-1.5 text-secondary"
                    aria-label="Hide Computer Use privacy notice"
                  >
                    Hide
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => dismissComputerUseNotice("session")}>
                    Hide for this session
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dismissComputerUseNotice("permanent")}>
                    Don’t show again
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </aside>
          ) : null}
          {/* Design Projects are local-first; workspace connection remains a later project action. */}
          {placement === "chat" ? (
            <div className="relative z-0 mx-3 flex min-h-8 min-w-0 items-center gap-0.5 rounded-t-xl bg-context-bar px-1.5 pb-2 pt-1 backdrop-blur-md">
              {workspacePickerEnabled && onSelectWorkspace && onCreateScratchWorkspace ? (
                <WorkspacePicker
                  key={workspaceChangeBlockedReason ? "blocked" : "available"}
                  workspaces={workspaces}
                  activeWorkspaceId={workspace?.id}
                  onSelectWorkspace={onSelectWorkspace}
                  onCreateScratchWorkspace={onCreateScratchWorkspace}
                  blockedReason={workspaceChangeBlockedReason}
                  trigger={
                    <Button
                      variant="transparent"
                      size="small"
                      className="composer-workspace-trigger h-7 min-w-0 max-w-[16rem] flex-1 shrink gap-1.5 px-2 text-secondary max-[520px]:max-w-[9rem]"
                      disabled={
                        isGenerating ||
                        sending ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason)
                      }
                      aria-label={
                        workspaceChangeBlockedReason
                          ? `Workspace unavailable: ${workspaceChangeBlockedReason}`
                          : "Choose a workspace"
                      }
                    >
                      <Folder className="size-4 shrink-0" />
                      <span className="max-w-[16rem] truncate">{folderName ?? "Workspace"}</span>
                    </Button>
                  }
                />
              ) : (
                <Button
                  variant="transparent"
                  size="small"
                  className="composer-workspace-trigger h-7 min-w-0 max-w-[16rem] flex-1 shrink gap-1.5 px-2 text-secondary max-[520px]:max-w-[9rem]"
                  onClick={onOpenFolder}
                  disabled={!workspace?.folderPath}
                  aria-label={workspace?.folderPath ? "Open folder in Finder" : "Workspace"}
                >
                  <Folder className="size-4 shrink-0" />
                  <span className="max-w-[16rem] truncate">{folderName ?? "Workspace"}</span>
                </Button>
              )}
              {/* Execution location — Pi runs locally on this Mac. */}
              <span
                className="composer-local-label flex h-7 items-center gap-1.5 px-2 text-small text-tertiary max-[460px]:hidden"
                title="The agent runs locally on this Mac"
              >
                <Monitor className="size-4 shrink-0" />
                Local
              </span>
              {gitBranch && workspace?.folderPath ? (
                <GitBranchPicker
                  key={`git-branch-picker-${worktreeRequest}`}
                  workspaceId={workspace.id}
                  branch={gitBranch}
                  detached={gitDetached}
                  unborn={gitUnborn}
                  disabled={
                    isGenerating ||
                    sending ||
                    attaching ||
                    permissionSaving ||
                    Boolean(gitMutationBlockedReason)
                  }
                  disabledReason={gitMutationBlockedReason}
                  onCreateWorktree={onCreateGitWorktree}
                  onBusyChange={onGitOperationBusyChange}
                  worktreeDescription={gitWorktreeDescription}
                  openWorktreeOnMount={worktreeRequest > 0}
                  programmaticReturnFocusRef={inputRef}
                />
              ) : null}
            </div>
          ) : null}

          <div
            className="composer-shell relative z-10 -mt-1 rounded-2xl bg-popover p-2.5 shadow-composer outline outline-1 outline-field/80"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <span id={attachmentDescriptionId} className="sr-only">
              Drag files here or paste an image to attach it. Use Attach files or images to choose
              files with the keyboard.
            </span>
            {selectedSkill ? (
              <div className="mb-1.5 flex items-center px-1.5">
                <div
                  className={cn(
                    "flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-small",
                    selectedSkillState?.state === "valid"
                      ? "border-accent/25 bg-accent/10 text-primary"
                      : selectedSkillState?.state === "checking"
                        ? "border-field bg-control text-secondary"
                        : "border-support-warning/35 bg-support-warning/10 text-primary",
                  )}
                  title={
                    selectedSkillState?.state === "valid"
                      ? `${skillSourceLabel(selectedSkill.invocation.source)} skill`
                      : selectedSkillState?.reason
                  }
                >
                  {selectedSkillState?.state === "checking" ? (
                    <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <AidenIcon aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
                  )}
                  <span className="truncate font-medium">
                    {selectedSkill.invocation.displayName}
                  </span>
                  <span className="shrink-0 text-mini text-tertiary">
                    {selectedSkillState?.state === "valid"
                      ? skillSourceLabel(selectedSkill.invocation.source)
                      : selectedSkillState?.state === "checking"
                        ? "Checking"
                        : "Unavailable"}
                  </span>
                  <button
                    type="button"
                    disabled={sessionCommandBusy}
                    onClick={() => {
                      dispatchSkillSelection({ type: "remove" });
                      requestAnimationFrame(() =>
                        inputRef?.current?.focus({ preventScroll: true }),
                      );
                    }}
                    aria-label={`Remove ${selectedSkill.invocation.displayName} skill from message`}
                    className="-mr-1 rounded-full p-0.5 text-tertiary transition-colors hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection focus-visible:text-primary"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
                <span className="sr-only" role="status" aria-live="polite">
                  {selectedSkillState?.state === "valid"
                    ? `${selectedSkill.invocation.displayName} skill selected.`
                    : selectedSkillState?.reason}
                </span>
              </div>
            ) : null}
            {designContextItems.length > 0 ? (
              <div
                className={cn(
                  "mb-1.5 flex flex-wrap gap-1.5 px-1.5",
                  placement === "design-conversation" && "max-h-16 overflow-y-auto",
                )}
                aria-label="Canvas context for next message"
              >
                {designContextItems.map((item) => {
                  const ContextIcon = item.kind === "image" ? ImageIcon : MousePointer2;
                  return (
                    <div
                      key={item.id}
                      className="group relative flex h-7 max-w-[14rem] items-center gap-1.5 rounded-control bg-list-selection py-1 pl-2 pr-6 text-accent"
                    >
                      <ContextIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate text-small-strong">{item.label}</span>
                      <button
                        type="button"
                        disabled={sessionCommandBusy}
                        onClick={() => onRemoveDesignContextItem?.(item.id)}
                        aria-label={`Remove ${item.label} from canvas context`}
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-accent outline-none transition-colors hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {attachments.length > 0 ? (
              <div
                className={cn(
                  "mb-1.5 flex flex-wrap gap-2 px-1.5",
                  placement === "design-conversation" && "max-h-20 overflow-y-auto",
                )}
              >
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative flex items-center gap-1.5 rounded-lg border border-field bg-background py-1 pl-1.5 pr-6"
                  >
                    {a.kind === "image" && a.data ? (
                      <img
                        src={`data:${a.mimeType};base64,${a.data}`}
                        alt={a.name}
                        className="size-7 rounded object-cover"
                      />
                    ) : (
                      <FileText className="size-4 shrink-0 text-tertiary" />
                    )}
                    <span className="max-w-[10rem] truncate text-small">{a.name}</span>
                    <button
                      type="button"
                      disabled={sessionCommandBusy}
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.name}`}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-tertiary outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-primary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <Textarea
              data-chat-composer
              ref={inputRef}
              value={text}
              readOnly={sessionCommandBusy}
              aria-busy={sessionCommandBusy || undefined}
              onChange={(event) => {
                setText(event.target.value);
                updateSelection({
                  start: event.target.selectionStart,
                  end: event.target.selectionEnd,
                });
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onSelect={(event) =>
                updateSelection({
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                })
              }
              onCompositionStart={() => {
                markSlashInteraction();
                setComposing(true);
              }}
              onCompositionEnd={(event) => {
                markSlashInteraction();
                setComposing(false);
                updateSelection({
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                });
              }}
              onBlur={() => {
                if (slashSession && !sessionCommandBusyRef.current) dismissSlash();
              }}
              onFocus={markSlashInteraction}
              aria-autocomplete={slashSession ? "list" : undefined}
              aria-describedby={attachmentDescriptionId}
              aria-controls={slashSession ? COMPOSER_SLASH_PALETTE_ID : undefined}
              aria-activedescendant={slashSession ? effectiveActiveSlashId : undefined}
              placeholder={
                ready && placeholder
                  ? placeholder
                  : composerPlaceholder({
                      ready,
                      readinessMessage,
                      hasMessages,
                      chatId,
                    })
              }
              className="max-h-48 border-0 bg-transparent px-1.5 outline-none hover:border-transparent focus:border-transparent focus:bg-transparent"
              rows={1}
            />
            {sessionCommandStatus ? (
              <div className="flex items-center justify-between gap-2 px-1.5 pb-1">
                <Text as="p" role="status" aria-live="polite" variant="small" color="tertiary">
                  {sessionCommandStatus}
                </Text>
                {sessionCommandStatus === "Compacting chat…" && onCancelCompact ? (
                  <Button
                    type="button"
                    variant="transparent"
                    size="small"
                    onClick={() => void onCancelCompact()}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!ready && readinessMessage && text.trim().length > 0 ? (
              <Text as="p" role="status" variant="small" color="tertiary" className="px-1.5 pb-1">
                {readinessMessage}
              </Text>
            ) : null}
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-1.5 gap-y-1">
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  className="rounded-full"
                  onClick={handleAttach}
                  disabled={
                    attaching || isGenerating || sending || gitOperationBusy || sessionCommandBusy
                  }
                  aria-label={
                    attaching ? "Choosing or loading attachments" : "Attach files or images"
                  }
                  aria-busy={attaching || undefined}
                >
                  {attaching ? <Loader2 className="animate-spin" /> : <Plus />}
                </Button>
                <span className="sr-only" role="status" aria-live="polite">
                  {attachmentStatus}
                </span>
                {/* Design has full authority inside its project scope and no workspace access mode. */}
                {placement === "chat" ? (
                  <div
                    className="composer-permission-control group/access relative h-8 w-34 shrink-0 max-[520px]:w-8"
                    data-open={permissionMenuOpen || undefined}
                    onPointerEnter={dismissSlash}
                    onPointerLeave={() => setPermissionMenuOpen(false)}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        setPermissionMenuOpen(false);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      setPermissionMenuOpen(false);
                      inputRef?.current?.focus();
                    }}
                  >
                    <button
                      type="button"
                      aria-label={`Workspace access: ${PERMISSION_META[permission].label}. Show access options.`}
                      aria-haspopup="true"
                      onFocus={() => setPermissionMenuOpen(true)}
                      onClick={() => setPermissionMenuOpen(true)}
                      onKeyDown={(event) => {
                        if (!["ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
                        event.preventDefault();
                        setPermissionMenuOpen(true);
                        requestAnimationFrame(() => permissionControlRef.current?.focus());
                      }}
                      className="absolute inset-0 flex items-center gap-2 overflow-hidden whitespace-nowrap rounded-pill bg-transparent px-3 text-regular outline-none transition-opacity duration-100 ease-out group-hover/access:opacity-0 group-focus-within/access:opacity-0 group-data-[open=true]/access:opacity-0 max-[520px]:justify-center max-[520px]:px-0"
                    >
                      <PermissionIcon
                        className={cn("size-4 shrink-0", PERMISSION_META[permission].className)}
                      />
                      <span className="truncate max-[520px]:sr-only">
                        {permissionSaving ? "Updating…" : PERMISSION_META[permission].label}
                      </span>
                    </button>
                    <div
                      role="radiogroup"
                      aria-label="Workspace access"
                      aria-disabled={
                        !workspace ||
                        permissionSaving ||
                        isGenerating ||
                        sending ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason) ||
                        undefined
                      }
                      className="invisible pointer-events-none absolute bottom-full left-0 z-20 flex min-w-34 translate-y-1 flex-col items-stretch overflow-hidden rounded-[16px] bg-control/80 p-1 opacity-0 shadow-control-hover transition-[opacity,transform,visibility] duration-100 ease-out group-hover/access:visible group-hover/access:pointer-events-auto group-hover/access:translate-y-0 group-hover/access:opacity-100 group-focus-within/access:visible group-focus-within/access:pointer-events-auto group-focus-within/access:translate-y-0 group-focus-within/access:opacity-100 group-data-[open=true]/access:visible group-data-[open=true]/access:pointer-events-auto group-data-[open=true]/access:translate-y-0 group-data-[open=true]/access:opacity-100"
                    >
                      {PERMISSION_ORDER.map((value, index) => {
                        const meta = PERMISSION_META[value];
                        const Icon = meta.icon;
                        const selected = value === permission;
                        const disabled =
                          !workspace ||
                          permissionSaving ||
                          isGenerating ||
                          sending ||
                          gitOperationBusy ||
                          Boolean(workspaceChangeBlockedReason);
                        return (
                          <button
                            ref={selected ? permissionControlRef : undefined}
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={
                              workspaceChangeBlockedReason
                                ? `Workspace access: ${meta.label}. ${workspaceChangeBlockedReason}.`
                                : isGenerating || sending
                                  ? `Workspace access: ${meta.label}. Finish or stop the current response to change access.`
                                  : `Workspace access: ${meta.label}`
                            }
                            tabIndex={selected ? 0 : -1}
                            aria-disabled={disabled || undefined}
                            onClick={() => {
                              if (!disabled) requestPermission(value);
                            }}
                            onKeyDown={(event) => {
                              if (disabled) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                if (value !== permission) requestPermission(value);
                                return;
                              }
                              let nextIndex: number | undefined;
                              if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                                nextIndex = (index + 1) % PERMISSION_ORDER.length;
                              }
                              if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                                nextIndex =
                                  (index - 1 + PERMISSION_ORDER.length) % PERMISSION_ORDER.length;
                              }
                              if (event.key === "Home") nextIndex = 0;
                              if (event.key === "End") nextIndex = PERMISSION_ORDER.length - 1;
                              if (nextIndex === undefined) return;
                              event.preventDefault();
                              const radios =
                                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                                  '[role="radio"]',
                                );
                              radios?.[nextIndex]?.focus();
                            }}
                            className={cn(
                              "flex h-8 w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-pill px-3 text-regular outline-none transition-[background-color,box-shadow,color] duration-100 ease-out focus-visible:outline-none aria-disabled:cursor-default",
                              selected
                                ? "bg-popover shadow-control"
                                : "hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection",
                            )}
                          >
                            <Icon className={cn("size-4 shrink-0", meta.className)} />
                            <span className="truncate">{meta.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {computerUse && onChangeComputerUse ? (
                  <Button
                    variant={computerUse.enabled ? "muted" : "transparent"}
                    size="small"
                    className={cn(
                      "h-7 gap-1.5 px-2 aria-disabled:opacity-45",
                      computerUse.enabled ? "text-accent" : "text-secondary",
                    )}
                    disabled={computerUseControl.disabled}
                    aria-disabled={computerUseControl.ariaDisabled || undefined}
                    aria-describedby={computerUseDescriptionId}
                    onClick={() => {
                      if (computerUseControl.ariaDisabled) {
                        toast.info(computerUse.detail);
                        return;
                      }
                      void onChangeComputerUse(!computerUse.enabled);
                    }}
                    aria-pressed={computerUse.enabled}
                    aria-label={
                      computerUse.enabled
                        ? "Turn off Computer Use for this chat"
                        : `Turn on Computer Use for this chat. ${computerUse.detail}`
                    }
                    title={
                      computerUse.ready || computerUse.enabled
                        ? "Computer Use (Beta) · every input action asks for approval"
                        : computerUse.detail
                    }
                  >
                    {computerUse.checking || computerUse.saving ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <MousePointer2 />
                    )}
                    Computer
                  </Button>
                ) : null}
              </div>
              <div
                className={cn(
                  "ml-auto flex min-w-0 items-center justify-end gap-1.5",
                  thinkingControl && "composer-action-row max-[520px]:w-full",
                )}
              >
                {voice.recording &&
                (voice.liveTranscript.committed || voice.liveTranscript.tentative) ? (
                  <span
                    className="max-w-56 truncate text-small"
                    role="status"
                    aria-live="polite"
                    aria-label="Live transcription"
                  >
                    <span className="text-primary">{voice.liveTranscript.committed}</span>{" "}
                    <span className="text-tertiary">{voice.liveTranscript.tentative}</span>
                  </span>
                ) : null}
                {thinkingControl}
                {modelPicker}
                <Button
                  variant={voice.recording ? "destructive" : "transparent"}
                  size="small"
                  iconOnly
                  disabled={voice.transcribing || isGenerating || sending || sessionCommandBusy}
                  onClick={() => (voice.recording ? voice.stop() : voice.start())}
                  aria-label={voice.recording ? "Stop recording" : "Start voice input"}
                >
                  {voice.transcribing ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Mic className={cn(voice.recording && "animate-pulse")} />
                  )}
                </Button>
                {isGenerating && canStopGeneration ? (
                  <Button
                    variant="filled"
                    size="small"
                    iconOnly
                    onClick={onStop}
                    aria-label="Stop generating"
                  >
                    <Square className="fill-current" />
                  </Button>
                ) : (
                  <Button
                    variant="accent"
                    size="small"
                    iconOnly
                    disabled={!canSend}
                    onClick={() => void submit()}
                    aria-label="Send message"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <AlertDialog
        open={voice.awaitingRecordedRetryConsent}
        onOpenChange={(open) => {
          if (!open) voice.resolveRecordedRetryConsent(false);
        }}
        title={GEMINI_RECORDED_RETRY_TITLE}
        description={GEMINI_RECORDED_RETRY_DESCRIPTION}
        confirmLabel="Retry with recording"
        returnFocus={() => inputRef?.current ?? null}
        onConfirm={() => voice.resolveRecordedRetryConsent(true)}
      />
      <AlertDialog
        open={confirmFullAccess}
        onOpenChange={setConfirmFullAccess}
        title="Enable Full Access?"
        description={
          <Text variant="small" color="secondary">
            Aiden will be able to read and edit files, and run commands in “
            {folderName ?? "this workspace"}” without asking each time. You can change this any time
            from the composer.
          </Text>
        }
        confirmLabel="Enable Full Access"
        onConfirm={() => void applyPermission("full")}
      />
      <Dialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title="Rename chat"
        description="Choose a concise title for this conversation."
        confirmLabel="Rename"
        confirmDisabled={!renameTitle.trim() || !onRenameChat}
        busy={renaming}
        returnFocus={() => inputRef?.current ?? null}
        onConfirm={saveRename}
      >
        <Input
          value={renameTitle}
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void saveRename();
            }
          }}
          maxLength={120}
          autoFocus
          aria-label="Chat title"
        />
      </Dialog>
      <Dialog
        open={forkDialogOpen && !slashSessionBlockedReason}
        onOpenChange={(open) => {
          setForkDialogOpen(open);
          if (!open) setForkQuery("");
        }}
        title="Fork from a completed turn"
        description="The new chat copies visible messages and attachments through the selected response. Private reasoning, tool state, and subagent runtime records are omitted."
        confirmHidden
        busy={sessionCommandBusy}
        returnFocus={() => inputRef?.current ?? null}
      >
        <Input
          value={forkQuery}
          onChange={(event) => setForkQuery(event.target.value.slice(0, MAX_FORK_QUERY_CODE_UNITS))}
          maxLength={MAX_FORK_QUERY_CODE_UNITS}
          placeholder="Search completed turns"
          aria-label="Search completed turns"
          autoFocus
        />
        <Text
          variant="small"
          color="tertiary"
          className="mb-2 mt-2"
          role="status"
          aria-live="polite"
        >
          {visibleForkTurns.length === completedForkTurns.length
            ? `${completedForkTurns.length} completed ${completedForkTurns.length === 1 ? "turn" : "turns"}`
            : `${visibleForkTurns.length} shown · search by text or turn number`}
        </Text>
        <ul className="flex flex-col gap-1" aria-label="Completed turns">
          {visibleForkTurns.length > 0 ? (
            visibleForkTurns.map((turn) => (
              <li key={turn.id}>
                <Button
                  variant="transparent"
                  className="h-auto min-h-11 w-full justify-start px-3 py-2 text-left"
                  disabled={sessionCommandBusy}
                  onClick={() => void forkFromTurn(turn.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-small-strong">
                      Turn {turn.turnNumber}: {turn.label}
                    </span>
                    <span className="block text-small text-tertiary">
                      Completed {new Date(turn.createdAt).toLocaleString()}
                    </span>
                  </span>
                </Button>
              </li>
            ))
          ) : (
            <li>
              <Text variant="small" color="secondary">
                {forkQuery.trim()
                  ? "No completed turns match that search."
                  : "This chat does not have a completed assistant turn yet."}
              </Text>
            </li>
          )}
        </ul>
      </Dialog>
      <Dialog
        open={sessionDialogOpen}
        onOpenChange={setSessionDialogOpen}
        title="Session details"
        description="Stored Aiden chat information"
        confirmHidden
        returnFocus={() => inputRef?.current ?? null}
      >
        {sessionChat ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-2 text-small">
            <dt className="text-tertiary">Title</dt>
            <dd className="min-w-0 break-words text-primary">{sessionChat.title}</dd>
            <dt className="text-tertiary">Workspace</dt>
            <dd className="min-w-0 break-words text-primary">
              {workspace?.name ?? sessionChat.workspaceId ?? "Default"}
            </dd>
            <dt className="text-tertiary">Provider</dt>
            <dd className="min-w-0 break-words text-primary">
              {sessionChat.providerId ?? "Not stored"}
            </dd>
            <dt className="text-tertiary">Model</dt>
            <dd className="min-w-0 break-words text-primary">
              {sessionChat.model ?? "Not stored"}
            </dd>
            <dt className="text-tertiary">Messages</dt>
            <dd className="text-primary">{sessionChat.messages.length}</dd>
            <dt className="text-tertiary">Attachments</dt>
            <dd className="text-primary">
              {sessionChat.messages.reduce(
                (count, message) => count + (message.attachments?.length ?? 0),
                0,
              )}
            </dd>
            <dt className="text-tertiary">Created</dt>
            <dd className="text-primary">{new Date(sessionChat.createdAt).toLocaleString()}</dd>
            <dt className="text-tertiary">Last updated</dt>
            <dd className="text-primary">{new Date(sessionChat.updatedAt).toLocaleString()}</dd>
          </dl>
        ) : null}
      </Dialog>
      <Dialog
        open={logoutChooserOpen}
        onOpenChange={setLogoutChooserOpen}
        title="Sign out of a provider"
        description="Choose an authenticated provider on this Mac."
        confirmHidden
        returnFocus={() => inputRef?.current ?? null}
      >
        {authenticatedProviders.length > 0 ? (
          <div className="space-y-1">
            {authenticatedProviders.map((provider) => (
              <Button
                key={provider.id}
                variant="transparent"
                className="h-auto min-h-11 w-full justify-start px-3 py-2 text-left"
                onClick={() => {
                  setLogoutProvider(provider);
                  setLogoutChooserOpen(false);
                  setLogoutConfirmOpen(true);
                }}
              >
                <span>
                  <span className="block text-small-strong">{provider.label}</span>
                  <span className="block text-small text-tertiary">{provider.detail}</span>
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <Text variant="small" color="secondary">
            There is no authenticated provider to sign out.
          </Text>
        )}
      </Dialog>
      <AlertDialog
        open={logoutConfirmOpen}
        onOpenChange={(open) => {
          setLogoutConfirmOpen(open);
          if (!open && !sessionCommandBusy) setLogoutProvider(undefined);
        }}
        title={`Sign out of ${logoutProvider?.label ?? "this provider"}?`}
        description={
          <Text variant="small" color="secondary">
            This removes Aiden&apos;s encrypted {logoutProvider?.label ?? "provider"} credential
            from this Mac. Existing chats remain. If no system credential is available, those models
            cannot run until you sign in again.
          </Text>
        }
        confirmLabel="Sign out"
        confirmVariant="destructive"
        busy={sessionCommandBusy}
        keepOpenOnConfirm
        returnFocus={() => inputRef?.current ?? null}
        onConfirm={logoutSelectedProvider}
      />
    </>
  );
}
