// Message composer. On a new chat the top-row folder opens the workspace picker;
// established chats reveal that folder in Finder. Git workspaces also show the
// current branch. The input
// row carries a new-chat button, a per-workspace permission control, the model
// picker, voice input, and send/stop.

import * as React from "react";
import {
  AlertDialog,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
import { attachmentsApi, onNotification, pickFiles } from "../lib/ipc";
import { useSettings } from "../lib/queries";
import type { Attachment, Workspace, WorkspacePermission } from "../lib/types";
import { composerSubmissionAllowed, computerUseControlState } from "../lib/computer-use-control";
import {
  dismissComputerUseNotice,
  shouldShowComputerUseNotice,
  useComputerUseNoticeDismissed,
} from "../lib/computer-use-notice";
import { composerPlaceholder } from "../lib/composer-placeholder";

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
  /** Global-beta readiness plus this chat's local Computer Use opt-in. */
  computerUse?: {
    enabled: boolean;
    ready: boolean;
    checking: boolean;
    saving: boolean;
    detail: string;
  };
  onChangeComputerUse?: (enabled: boolean) => void | Promise<void>;
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

export function Composer({
  ready,
  readinessMessage,
  hasMessages,
  chatId,
  onSend,
  onStop,
  isGenerating,
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
}: ComposerProps) {
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attaching, setAttaching] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [permissionSaving, setPermissionSaving] = React.useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = React.useState(false);
  const computerUseDescriptionId = React.useId();
  const computerUseNoticeDismissed = useComputerUseNoticeDismissed();
  const showComputerUseNotice = shouldShowComputerUseNotice(
    computerUse?.enabled === true,
    computerUseNoticeDismissed,
  );
  const submissionAllowed = composerSubmissionAllowed({
    ready,
    isGenerating,
    sending,
    permissionSaving,
    computerUseSaving: computerUse?.saving === true,
    gitOperationBusy,
  });
  const canSend = (text.trim().length > 0 || attachments.length > 0) && submissionAllowed;

  const settings = useSettings();
  const voice = useVoiceRecorder(
    (transcript) => setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript)),
    {
      provider: settings.data?.voiceProvider ?? "openai",
      localModel: settings.data?.localVoiceModel,
    },
  );

  // Global dictation hotkey toggles the same recorder (uses the selected provider).
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  const isGeneratingRef = React.useRef(isGenerating);
  isGeneratingRef.current = isGenerating;
  React.useEffect(() => {
    return onNotification("app:dictate-toggle", () => {
      const v = voiceRef.current;
      if (v.transcribing || isGeneratingRef.current) return;
      if (v.recording) v.stop();
      else void v.start();
    });
  }, []);

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
      <div className="pointer-events-none mx-auto w-full max-w-3xl px-3 pb-4 pt-3 sm:px-5 sm:pb-5">
        <div className="pointer-events-auto isolate">
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

          <div className="relative z-10 -mt-1 rounded-2xl bg-popover p-2.5 shadow-composer outline outline-1 outline-field/80 transition-[outline-color,box-shadow] duration-150 ease-out focus-within:outline-focus-ring">
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
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-tertiary outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-primary active:bg-list-selection focus-visible:ring-2 focus-visible:ring-focus-ring"
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
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={composerPlaceholder({ ready, readinessMessage, hasMessages, chatId })}
              className="max-h-48 border-0 bg-transparent px-1.5 focus-visible:ring-0"
              rows={1}
            />
            {!ready && readinessMessage && text.trim().length > 0 ? (
              <Text as="p" role="status" variant="small" color="tertiary" className="px-1.5 pb-1">
                {readinessMessage}
              </Text>
            ) : null}
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-1.5">
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
                <DropdownMenu>
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
              <div className="flex min-w-0 items-center justify-end gap-1.5">
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
                {isGenerating ? (
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
    </>
  );
}
