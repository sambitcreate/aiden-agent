// Message composer. Top row shows the active workspace folder (click to reveal
// in Finder) and, when the folder is a git repo, the current branch. The input
// row carries a new-chat button, a per-workspace permission control, the model
// picker, voice input, and send/stop.

import * as React from "react";
import {
  AlertDialog,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
  FileText,
  Folder,
  Loader2,
  Lock,
  Mic,
  Monitor,
  OctagonAlert,
  Plus,
  ShieldQuestion,
  Square,
  X,
} from "lucide-react";
import { GitBranchPicker } from "./git-branch-picker";
import { useVoiceRecorder } from "../lib/use-voice-recorder";
import { attachmentsApi, onNotification, pickFiles } from "../lib/ipc";
import { useSettings } from "../lib/queries";
import type { Attachment, Workspace, WorkspacePermission } from "../lib/types";

interface ComposerProps {
  /** True when a provider + model are selected and a message can be sent. */
  ready: boolean;
  onSend: (text: string, attachments: Attachment[]) => Promise<void>;
  onStop: () => void;
  isGenerating: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  workspace?: Workspace;
  /** Current git branch of the workspace folder, or undefined if not a repo. */
  gitBranch?: string;
  onOpenFolder?: () => void;
  onChangePermission?: (permission: WorkspacePermission) => void | Promise<void>;
  /** Whether the selected model accepts image input. */
  visionSupported?: boolean;
  /** The model picker element, rendered in the input row. */
  modelPicker?: React.ReactNode;
}

const PERMISSION_META: Record<
  WorkspacePermission,
  { label: string; description: string; icon: React.ComponentType<{ className?: string }>; className: string }
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
  onSend,
  onStop,
  isGenerating,
  inputRef,
  workspace,
  gitBranch,
  onOpenFolder,
  onChangePermission,
  visionSupported,
  modelPicker,
}: ComposerProps) {
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attaching, setAttaching] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [permissionSaving, setPermissionSaving] = React.useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = React.useState(false);
  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    ready &&
    !isGenerating &&
    !sending &&
    !permissionSaving;

  const settings = useSettings();
  const voice = useVoiceRecorder(
    (transcript) => setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript)),
    { provider: settings.data?.voiceProvider ?? "openai", localModel: settings.data?.localVoiceModel },
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

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !ready || isGenerating || sending || permissionSaving) return;
    if (visionSupported === false && attachments.some((attachment) => attachment.kind === "image")) {
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

  const applyPermission = async (nextPermission: WorkspacePermission) => {
    if (!onChangePermission || nextPermission === permission || permissionSaving || isGenerating || sending) return;
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
    if (nextPermission === permission || permissionSaving || isGenerating || sending) return;
    if (nextPermission === "full") {
      setConfirmFullAccess(true);
      return;
    }
    void applyPermission(nextPermission);
  };

  return (
    <>
    <div className="pointer-events-none mx-auto w-full max-w-3xl px-3 pb-4 pt-3 sm:px-5 sm:pb-5">
      <div className="pointer-events-auto">
      {/* Workspace context: folder (opens in Finder) · local execution · git branch. */}
      <div className="mx-3 flex min-h-8 items-center gap-0.5 rounded-t-xl bg-control/60 px-1.5 pb-2 pt-1">
        <Button
          variant="transparent"
          size="small"
          className="h-7 gap-1.5 px-2 text-secondary"
          onClick={onOpenFolder}
          disabled={!workspace?.folderPath}
          aria-label={workspace?.folderPath ? "Open folder in Finder" : "Workspace"}
        >
          <Folder className="size-4 shrink-0" />
          <span className="max-w-[16rem] truncate">{folderName ?? "Workspace"}</span>
        </Button>
        {/* Execution location — Pi runs locally on this Mac. */}
        <span className="flex h-7 items-center gap-1.5 px-2 text-small text-tertiary" title="The agent runs locally on this Mac">
          <Monitor className="size-4 shrink-0" />
          Local
        </span>
        {gitBranch && workspace?.folderPath ? (
          <GitBranchPicker folderPath={workspace.folderPath} branch={gitBranch} />
        ) : null}
      </div>

      <div className="-mt-1 rounded-2xl bg-popover p-2.5 shadow-[var(--shadow-composer)] outline outline-1 outline-field/80 transition-[outline-color,box-shadow] focus-within:outline-primary/30">
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
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-tertiary hover:bg-control hover:text-primary"
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
          placeholder="Do anything"
          className="max-h-48 border-0 bg-transparent px-1.5 focus-visible:ring-0"
          rows={1}
        />
        <div className="mt-1.5 flex min-w-0 items-center justify-between gap-1.5">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="transparent"
              size="small"
              iconOnly
              className="rounded-full"
              onClick={handleAttach}
              disabled={attaching || isGenerating || sending}
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
                  disabled={!workspace || permissionSaving || isGenerating || sending}
                  aria-label={
                    isGenerating || sending
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
                  disabled={permissionSaving}
                  onCheckedChange={(checked) => checked && requestPermission("full")}
                >
                  Full access
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={permission === "ask"}
                  sublabel={PERMISSION_META.ask.description}
                  disabled={permissionSaving}
                  onCheckedChange={(checked) => checked && requestPermission("ask")}
                >
                  Ask first
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={permission === "none"}
                  sublabel={PERMISSION_META.none.description}
                  disabled={permissionSaving}
                  onCheckedChange={(checked) => checked && requestPermission("none")}
                >
                  No access
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
              <Button variant="filled" size="small" iconOnly onClick={onStop} aria-label="Stop generating">
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
          Aiden will be able to read and edit files, and run commands in “{folderName ?? "this workspace"}”
          without asking each time. You can change this any time from the composer.
        </Text>
      }
      confirmLabel="Enable Full Access"
      onConfirm={() => void applyPermission("full")}
    />
    </>
  );
}
