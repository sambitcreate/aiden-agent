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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { GitBranchPicker } from "./git-branch-picker";
import { WorkspacePicker } from "./workspace-picker";
import { useVoiceRecorder } from "../lib/use-voice-recorder";
import { attachmentsApi, pickFiles } from "../lib/ipc";
import { useDiscoveredSkills, useSettings } from "../lib/queries";
import type { Attachment, Workspace, WorkspacePermission } from "../lib/types";
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
  moveSlashSelectionId,
  pageSlashSelectionId,
  rankSlashResults,
  slashActionCommitIsCurrent,
  slashTabAcceptsSelection,
  updateSlashSessionTracker,
  type SlashResult,
  type SlashSessionTracker,
} from "../lib/slash-command-core";
import {
  attemptSlashCommandAction,
  slashCommandAvailability,
  validateSlashCommandArgument,
} from "../lib/slash-command-actions";
import {
  COMPOSER_SLASH_PALETTE_ID,
  COMPOSER_SLASH_RETRY_ID,
  ComposerSlashPalette,
  ComposerSlashPalettePresence,
} from "./composer-slash-palette";
import type { SettingsSection } from "../shared/settings-section";

interface ComposerProps {
  /** True when a provider + model are selected and a message can be sent. */
  ready: boolean;
  /** Actionable explanation for a disabled send state. */
  readinessMessage?: string;
  /** True once this chat has a persisted message. */
  hasMessages: boolean;
  /** Stable identifier used to select an empty-chat prompt. */
  chatId: string;
  onSend: (text: string, attachments: Attachment[]) => Promise<void>;
  onStop: () => void;
  isGenerating: boolean;
  canStopGeneration?: boolean;
  /** Blocks both click and Enter submission while a model-scoped option is being saved. */
  configurationBusy?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  onOpenSettings?: (section?: SettingsSection) => void;
  onRenameChat?: (title: string) => void | Promise<void>;
  onOpenReview?: () => void;
  slashPaletteBlocked?: boolean;
  slashActionBusy?: boolean;
}
const PERMISSION_META: Record<
  WorkspacePermission,
  {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    className: string;
  }
> = {
  full: {
    label: "Full access",
    description: "Read and edit files, and run commands without asking.",
    icon: OctagonAlert,
    className: "text-support-warning",
  },
  ask: {
    label: "Ask first",
    description: "Read freely; confirm every edit and command.",
    icon: ShieldQuestion,
    className: "text-secondary",
  },
  none: {
    label: "No access",
    description: "Keep workspace files and commands unavailable.",
    icon: Lock,
    className: "text-tertiary",
  },
};

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
      slashTracker: { ...state.slashTracker, dismissedEpoch: state.slashTracker.epoch },
    };
  }
  const text = typeof action.value === "function" ? action.value(state.text) : action.value;
  return {
    text,
    slashTracker: updateSlashSessionTracker(state.slashTracker, text),
  };
}

export function Composer({
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
  computerUse,
  onChangeComputerUse,
  modelPicker,
  thinkingControl,
  currentChatTitle,
  latestAssistantResponse,
  slashNavigationBlockedReason,
  onOpenSettings,
  onRenameChat,
  onOpenReview,
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
  const slashPaletteBlockedRef = React.useRef(slashPaletteBlocked);
  const slashInteractionRevisionRef = React.useRef(0);
  const markSlashInteraction = React.useCallback(() => {
    slashInteractionRevisionRef.current += 1;
  }, []);
  const setText = React.useCallback((value: React.SetStateAction<string>) => {
    slashInteractionRevisionRef.current += 1;
    dispatchDraft({ type: "update", value });
  }, []);
  const dismissSlash = React.useCallback(() => {
    slashInteractionRevisionRef.current += 1;
    dispatchDraft({ type: "dismiss-slash" });
  }, []);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attaching, setAttaching] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [permissionSaving, setPermissionSaving] = React.useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = React.useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = React.useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false);
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);
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
    }) && !configurationBusy;
  const canSend = (text.trim().length > 0 || attachments.length > 0) && submissionAllowed;

  const settings = useSettings();
  const skillCatalog = useDiscoveredSkills(workspace?.id);
  const voice = useVoiceRecorder(
    (transcript) => setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript)),
    {
      provider: settings.data?.voiceProvider ?? "openai",
      localModel: settings.data?.localVoiceModel,
    },
  );

  React.useLayoutEffect(() => {
    slashPaletteBlockedRef.current = slashPaletteBlocked;
    if (slashPaletteBlocked) dismissSlash();
  }, [dismissSlash, slashPaletteBlocked]);

  const slashSession = React.useMemo(
    () =>
      slashPaletteBlocked || confirmFullAccess || renameDialogOpen || permissionMenuOpen
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
      permissionMenuOpen,
      renameDialogOpen,
      selection.end,
      selection.start,
      slashTracker,
      slashPaletteBlocked,
      text,
    ],
  );
  const rankedSlashResults = React.useMemo(
    () => rankSlashResults(slashSession?.query ?? "", skillCatalog.data ?? []),
    [skillCatalog.data, slashSession?.query],
  );
  const slashActionContext = React.useMemo(
    () => ({
      canExecuteCommand: commandSystem.canExecute,
      hasChat: Boolean(currentChatTitle),
      hasLatestAssistantResponse: Boolean(latestAssistantResponse),
      hasWorkspace: Boolean(workspace),
      idle: !slashActionBusy && !isGenerating && !sending,
      navigationBlockedReason: slashNavigationBlockedReason,
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
        ? Boolean(consumeSlashToken(text, slashSession).trim() || attachments.length > 0)
        : Boolean(text.trim() || attachments.length > 0),
    }),
    [
      attachments.length,
      commandSystem.canExecute,
      currentChatTitle,
      isGenerating,
      gitOperationBusy,
      latestAssistantResponse,
      permissionSaving,
      sending,
      slashActionBusy,
      slashNavigationBlockedReason,
      slashSession,
      text,
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
    (result: SlashResult) => result.kind === "command" && commandAvailability(result).available,
    [commandAvailability],
  );
  const selectableSlashIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const result of rankedSlashResults.results) {
      if (slashResultSelectable(result)) ids.push(result.id);
    }
    if (skillCatalog.isError) ids.push(COMPOSER_SLASH_RETRY_ID);
    return ids;
  }, [rankedSlashResults.results, skillCatalog.isError, slashResultSelectable]);
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

  const selectSlashResult = React.useCallback(
    async (result: SlashResult) => {
      if (
        slashActionPendingRef.current ||
        !slashSession ||
        !slashResultSelectable(result) ||
        result.kind !== "command"
      ) {
        return;
      }
      const argument = validateSlashCommandArgument(result.command, slashSession.argument);
      if (!argument.valid) {
        toast.info(argument.reason ?? "That command argument is invalid.");
        return;
      }
      const nextText =
        result.command.argument === "optional"
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
        openAccess: () => setPermissionMenuOpen(true),
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
      if (
        asyncAction &&
        !slashActionCommitIsCurrent(expectedCommit, {
          draft: draftRef.current.text,
          epoch: draftRef.current.slashTracker.epoch,
          interactionRevision: slashInteractionRevisionRef.current,
          blocked: slashPaletteBlockedRef.current,
        })
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
      onOpenReview,
      onOpenSettings,
      requestRename,
      slashResultSelectable,
      slashSession,
      text,
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

  const handleAttach = async () => {
    if (gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before attaching files.");
      return;
    }
    const paths = await pickFiles();
    if (paths.length === 0) return;
    setAttaching(true);
    try {
      let added = await attachmentsApi.read(paths);
      // Drop images when the model can't see them, with a hint.
      if (visionSupported === false && added.some((a) => a.kind === "image")) {
        added = added.filter((a) => a.kind !== "image");
        toast.info("The selected model can't read images — image attachments were skipped.");
      }
      setAttachments((prev) => [...prev, ...added]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't read that file.");
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const submit = async () => {
    if (gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before sending.");
      return;
    }
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !submissionAllowed) return;
    if (
      visionSupported === false &&
      attachments.some((attachment) => attachment.kind === "image")
    ) {
      toast.info("Switch to a vision-capable model before sending these images.");
      return;
    }
    setSending(true);
    try {
      await onSend(trimmed, attachments);
      setText("");
      setAttachments([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send this message.");
    } finally {
      setSending(false);
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
  const perm = PERMISSION_META[permission];
  const PermIcon = perm.icon;
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
    if (nextPermission === "full") {
      setConfirmFullAccess(true);
      return;
    }
    void applyPermission(nextPermission);
  };

  return (
    <>
      <div className="aiden-dock-inset chat-content-column pointer-events-none pb-4 pt-3 sm:pb-5">
        <div className="pointer-events-auto relative isolate">
          <ComposerSlashPalettePresence
            present={Boolean(slashSession)}
            immediate={
              slashPaletteBlocked || confirmFullAccess || renameDialogOpen || permissionMenuOpen
            }
          >
            {slashSession ? (
              <ComposerSlashPalette
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
          {/* Workspace context: folder (opens in Finder) · local execution · git branch. */}
          <div className="relative z-0 mx-3 flex min-h-8 min-w-0 items-center gap-0.5 rounded-t-xl bg-context-bar px-1.5 pb-2 pt-1 backdrop-blur-md">
            {workspacePickerEnabled && onSelectWorkspace && onCreateScratchWorkspace ? (
              <WorkspacePicker
                workspaces={workspaces}
                activeWorkspaceId={workspace?.id}
                onSelectWorkspace={onSelectWorkspace}
                onCreateScratchWorkspace={onCreateScratchWorkspace}
                trigger={
                  <Button
                    variant="transparent"
                    size="small"
                    className="h-7 min-w-0 max-w-[16rem] flex-1 shrink gap-1.5 px-2 text-secondary max-[520px]:max-w-[9rem]"
                    disabled={
                      isGenerating ||
                      sending ||
                      gitOperationBusy ||
                      Boolean(workspaceChangeBlockedReason)
                    }
                    aria-label="Choose a workspace"
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
                className="h-7 min-w-0 max-w-[16rem] flex-1 shrink gap-1.5 px-2 text-secondary max-[520px]:max-w-[9rem]"
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
              className="flex h-7 items-center gap-1.5 px-2 text-small text-tertiary max-[460px]:hidden"
              title="The agent runs locally on this Mac"
            >
              <Monitor className="size-4 shrink-0" />
              Local
            </span>
            {gitBranch && workspace?.folderPath ? (
              <GitBranchPicker
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
              />
            ) : null}
          </div>

          <div className="composer-shell relative z-10 -mt-1 rounded-2xl bg-popover p-2.5 shadow-composer outline outline-1 outline-field/80">
            {attachments.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap gap-2 px-1.5">
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
              ref={inputRef}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                updateSelection({
                  start: event.target.selectionStart,
                  end: event.target.selectionEnd,
                });
              }}
              onKeyDown={handleKeyDown}
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
                if (slashSession) dismissSlash();
              }}
              onFocus={markSlashInteraction}
              aria-autocomplete={slashSession ? "list" : undefined}
              aria-controls={slashSession ? COMPOSER_SLASH_PALETTE_ID : undefined}
              aria-activedescendant={slashSession ? effectiveActiveSlashId : undefined}
              placeholder={composerPlaceholder({
                ready,
                readinessMessage,
                hasMessages,
                chatId,
              })}
              className="max-h-48 border-0 bg-transparent px-1.5 outline-none hover:border-transparent focus:border-transparent focus:bg-transparent"
              rows={1}
            />
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
                  disabled={attaching || isGenerating || sending || gitOperationBusy}
                  aria-label="Attach files or images"
                >
                  {attaching ? <Loader2 className="animate-spin" /> : <Plus />}
                </Button>
                <DropdownMenu
                  open={permissionMenuOpen}
                  onOpenChange={(open) => {
                    setPermissionMenuOpen(open);
                    if (open) {
                      dismissSlash();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="transparent"
                      size="small"
                      className={cn("h-7 gap-1.5 px-2", perm.className)}
                      disabled={
                        !workspace ||
                        permissionSaving ||
                        isGenerating ||
                        sending ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason)
                      }
                      aria-label={
                        workspaceChangeBlockedReason
                          ? `Workspace access: ${perm.label}. ${workspaceChangeBlockedReason}.`
                          : isGenerating || sending
                            ? `Workspace access: ${perm.label}. Finish or stop the current response to change access.`
                            : `Workspace access: ${perm.label}`
                      }
                    >
                      <PermIcon className="size-4 shrink-0" />
                      {permissionSaving ? "Updating…" : perm.label}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel>Workspace access</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={permission === "full"}
                      sublabel={PERMISSION_META.full.description}
                      disabled={
                        permissionSaving ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason)
                      }
                      onCheckedChange={(checked) => checked && requestPermission("full")}
                    >
                      Full access
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={permission === "ask"}
                      sublabel={PERMISSION_META.ask.description}
                      disabled={
                        permissionSaving ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason)
                      }
                      onCheckedChange={(checked) => checked && requestPermission("ask")}
                    >
                      Ask first
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={permission === "none"}
                      sublabel={PERMISSION_META.none.description}
                      disabled={
                        permissionSaving ||
                        gitOperationBusy ||
                        Boolean(workspaceChangeBlockedReason)
                      }
                      onCheckedChange={(checked) => checked && requestPermission("none")}
                    >
                      No access
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                  thinkingControl && "max-[520px]:w-full",
                )}
              >
                {thinkingControl}
                {modelPicker}
                <Button
                  variant={voice.recording ? "destructive" : "transparent"}
                  size="small"
                  iconOnly
                  disabled={voice.transcribing || isGenerating || sending}
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
    </>
  );
}
