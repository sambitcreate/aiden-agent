// Floating composer shared between State 1 (compact starter bar) and State 2
// (docked mini-modal composer). Supports + file/image attach, clipboard image
// paste, drag-and-drop, inline target mode selector (Temporary / No workspace /
// workspace), the Agent Slider model popover, and voice mic (useVoiceRecorder).

import * as React from "react";
import {
  ArrowUp,
  ChevronDown,
  Clock,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Plus,
  Square,
  X,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Text,
  toast,
} from "../components/ui";
import { AgentModelPopover } from "../components/agent-model-popover";
import type { AgentSliderSettings } from "../shared/agent-slider";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import { cn } from "../lib/ui-utils";
import { attachmentsApi, quickChatApi, workspacesApi } from "../lib/ipc";
import { useVoiceRecorder } from "../lib/use-voice-recorder";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../shared/attachment-contract";
import type { Attachment, Provider, Workspace } from "../lib/types";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import { workspaceChoices } from "../lib/no-workspace";
import { isComposingKey } from "../lib/dismiss-key";

export type QuickChatTargetMode =
  | { kind: "ephemeral" }
  | { kind: "noWorkspace" }
  | { kind: "workspace"; workspaceId: string };

export interface FloatingComposerProps {
  variant: "starter" | "modal";
  text: string;
  onTextChange: (next: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: React.Dispatch<React.SetStateAction<Attachment[]>>;
  providers: Provider[];
  providerId: string;
  model: string;
  onModelChange: (providerId: string, model: string) => void;
  /** The pick's own effort, from an Agent Slider stop. */
  thinkingLevel?: GenerationThinkingLevel;
  agentSlider?: AgentSliderSettings;
  settingsLoaded: boolean;
  /** An Agent Slider stop: its model and effort. */
  onSelectStop: (
    providerId: string,
    model: string,
    thinkingLevel: GenerationThinkingLevel | undefined,
  ) => void;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  workspaces: Workspace[];
  targetMode: QuickChatTargetMode;
  onTargetModeChange?: (mode: QuickChatTargetMode) => void;
  onWorkspaceCreated?: (workspace: Workspace) => void;
  isGenerating: boolean;
  sending: boolean;
  onSend: () => void;
  onStop: () => void;
  onExpand?: () => void;
  onBeforePopoverOpen?: () => Promise<boolean | void>;
  onPopoverOpenChange?: (open: boolean) => void;
  /** Incrementing signal that closes any mounted starter popover and cancels pending opens. */
  popoverResetSeq?: number;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function targetChipLabel(mode: QuickChatTargetMode, workspaces: readonly Workspace[]): string {
  if (mode.kind === "ephemeral") return "Temporary";
  if (mode.kind === "noWorkspace") return "No workspace";
  return workspaces.find((ws) => ws.id === mode.workspaceId)?.name ?? "Workspace";
}

function targetChipIcon(mode: QuickChatTargetMode) {
  if (mode.kind === "ephemeral") return <Clock className="size-3.5 text-status-warning" aria-hidden="true" />;
  if (mode.kind === "noWorkspace") return <MessageCircle className="size-3.5 text-secondary" aria-hidden="true" />;
  return <Folder className="size-3.5 text-secondary" aria-hidden="true" />;
}

function targetModeValue(mode: QuickChatTargetMode): string {
  if (mode.kind === "ephemeral") return "ephemeral";
  if (mode.kind === "noWorkspace") return "noWorkspace";
  return `workspace:${mode.workspaceId}`;
}

export function FloatingComposer({
  variant,
  text,
  onTextChange,
  attachments,
  onAttachmentsChange,
  providers,
  providerId,
  model,
  onModelChange,
  thinkingLevel,
  agentSlider,
  settingsLoaded,
  onSelectStop,
  hiddenModelsByProvider,
  workspaces,
  targetMode,
  onTargetModeChange,
  onWorkspaceCreated,
  isGenerating,
  sending,
  onSend,
  onStop,
  onExpand,
  onBeforePopoverOpen,
  onPopoverOpenChange,
  popoverResetSeq,
  textareaRef,
}: FloatingComposerProps) {
  const internalTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const inputRef = textareaRef ?? internalTextareaRef;
  const [targetOpen, setTargetOpen] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [pickingFiles, setPickingFiles] = React.useState(false);
  const targetOpenRef = React.useRef(false);
  const modelOpenRef = React.useRef(false);
  const targetOpenReqRef = React.useRef(0);
  const prevPopoverResetSeqRef = React.useRef(popoverResetSeq);

  React.useEffect(() => () => {
    targetOpenReqRef.current += 1;
  }, []);

  React.useEffect(() => {
    if (popoverResetSeq === prevPopoverResetSeqRef.current) return;
    prevPopoverResetSeqRef.current = popoverResetSeq;
    targetOpenReqRef.current += 1;
    targetOpenRef.current = false;
    modelOpenRef.current = false;
    setTargetOpen(false);
  }, [popoverResetSeq]);

  const reportPopover = React.useCallback(
    (nextTarget: boolean, nextModel: boolean) => {
      targetOpenRef.current = nextTarget;
      modelOpenRef.current = nextModel;
      onPopoverOpenChange?.(nextTarget || nextModel);
    },
    [onPopoverOpenChange],
  );

  const handleTargetOpenChange = (open: boolean) => {
    const req = ++targetOpenReqRef.current;
    if (open && onBeforePopoverOpen) {
      void onBeforePopoverOpen().then(
        (proceed) => {
          if (proceed === false || targetOpenReqRef.current !== req) return;
          setTargetOpen(true);
          reportPopover(true, modelOpenRef.current);
        },
        () => undefined,
      );
      return;
    }
    setTargetOpen(open);
    reportPopover(open, modelOpenRef.current);
  };

  const handleModelOpenChange = (open: boolean) => {
    reportPopover(targetOpenRef.current, open);
  };

  const realWorkspaces = React.useMemo(() => workspaceChoices(workspaces), [workspaces]);

  // Auto-grow textarea height smoothly up to 140px.
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text, inputRef]);

  const appendAttachments = React.useCallback(
    (incoming: Attachment[], skipped: number) => {
      if (incoming.length > 0) {
        onAttachmentsChange((prev) => {
          const remaining = MAX_ATTACHMENTS_PER_MESSAGE - prev.length;
          return remaining > 0 ? [...prev, ...incoming.slice(0, remaining)] : prev;
        });
      }
      if (skipped > 0) {
        toast.info(
          skipped === 1
            ? "1 attachment was skipped (size or slot limit)."
            : `${skipped} attachments were skipped (size or slot limit).`,
        );
      }
    },
    [onAttachmentsChange],
  );

  const currentInlineBytes = attachments.reduce((sum, item) => sum + item.size, 0);
  const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);
  const remainingInlineBytes = Math.max(0, MAX_ATTACHMENT_INLINE_BYTES - currentInlineBytes);

  const handlePickFiles = async () => {
    if (pickingFiles) return;
    if (remainingSlots <= 0 || remainingInlineBytes <= 0) {
      toast.info("Attachment limit reached for this message.");
      return;
    }
    setPickingFiles(true);
    try {
      await quickChatApi.suppressBlur(10_000).catch(() => undefined);
      const result = await attachmentsApi.pickAndRead(remainingSlots, true, remainingInlineBytes);
      appendAttachments(result.attachments, result.skipped);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not attach files.");
    } finally {
      setPickingFiles(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
    if (imageFiles.length === 0) return;
    event.preventDefault();
    if (remainingSlots <= 0 || remainingInlineBytes <= 0) {
      toast.info("Attachment limit reached for this message.");
      return;
    }
    try {
      const payload = await Promise.all(
        imageFiles.map(async (file) => ({
          mimeType: file.type || "image/png",
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      const result = await attachmentsApi.readClipboardImages(
        payload,
        remainingSlots,
        remainingInlineBytes,
      );
      appendAttachments(result, 0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not paste image.");
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    if (remainingSlots <= 0 || remainingInlineBytes <= 0) {
      toast.info("Attachment limit reached for this message.");
      return;
    }
    try {
      const result = await attachmentsApi.readDroppedFiles(files, remainingSlots, true, remainingInlineBytes);
      appendAttachments(result, 0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read dropped files.");
    }
  };

  const handleOpenFolder = async () => {
    handleTargetOpenChange(false);
    try {
      await quickChatApi.suppressBlur(10_000).catch(() => undefined);
      const created = await workspacesApi.createFromFolder();
      if (created) {
        onWorkspaceCreated?.(created);
        onTargetModeChange?.({ kind: "workspace", workspaceId: created.id });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open folder.");
    } finally {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const voice = useVoiceRecorder(
    (transcript) => {
      const trimmed = transcript.trim();
      if (!trimmed) return;
      onTextChange(text.trim() ? `${text.trimEnd()} ${trimmed}` : trimmed);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    {},
  );

  const canSend =
    !sending &&
    Boolean(providerId && model) &&
    (text.trim().length > 0 || attachments.length > 0);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const liveTranscript = [voice.liveTranscript.committed, voice.liveTranscript.tentative]
    .filter(Boolean)
    .join(" ")
    .trim();

  return (
    <div
      className={cn(
        "composer-shell flex flex-col gap-2 px-3.5 py-3 transition-colors",
        variant === "starter"
          ? "qc-starter-card bg-popover shadow-dialog"
          : "bg-popover shadow-composer",
        dragActive && "bg-list-hover",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => void handleDrop(event)}
      data-testid={variant === "starter" ? "quick-chat-starter-bar" : "quick-chat-modal-composer"}
    >
      {/* Attachment pills */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
          {attachments.map((att) => (
            <span
              key={att.id}
              className="inline-flex max-w-[180px] items-center gap-1.5 rounded-lg bg-control px-2 py-1 text-xs text-primary"
            >
              {att.kind === "image" && att.data ? (
                <img
                  src={`data:${att.mimeType};base64,${att.data}`}
                  alt={att.name}
                  className="size-4 rounded object-cover"
                />
              ) : (
                <FileText className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
              )}
              <span className="truncate">{att.name}</span>
              <button
                type="button"
                className="rounded p-0.5 text-tertiary hover:text-primary"
                aria-label={`Remove ${att.name}`}
                onClick={() =>
                  onAttachmentsChange((prev) => prev.filter((item) => item.id !== att.id))
                }
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Top row: textarea + (State 1 only) Expand button */}
      <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={liveTranscript ? `${text}${text ? " " : ""}${liveTranscript}` : text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder={variant === "starter" ? "Ask Aiden anything…" : "Follow up…"}
          aria-label={variant === "starter" ? "Ask Aiden anything" : "Reply in Quick Chat"}
          className="qc-textarea min-h-[28px] max-h-[140px] flex-1 py-0.5 text-sm leading-6 text-primary placeholder:text-tertiary"
          data-testid="quick-chat-input"
        />
        {variant === "starter" && onExpand ? (
          <Button
            variant="transparent"
            size="small"
            iconOnly
            className="shrink-0 text-secondary hover:text-primary"
            aria-label="Expand to Aiden"
            title="Expand to Aiden"
            onClick={onExpand}
            data-testid="quick-chat-expand-starter"
          >
            <Maximize2 className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {/* Bottom action row */}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 shrink items-center gap-1">
          <Button
            variant="transparent"
            size="small"
            iconOnly
            className="shrink-0 text-secondary hover:text-primary"
            aria-label="Attach files or images"
            title="Attach files or images"
            disabled={pickingFiles || remainingSlots <= 0 || remainingInlineBytes <= 0}
            onClick={() => void handlePickFiles()}
            data-testid="quick-chat-attach-btn"
          >
            {pickingFiles ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
          </Button>

          {variant === "starter" && onTargetModeChange ? (
            <DropdownMenu open={targetOpen} onOpenChange={handleTargetOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="transparent"
                  size="small"
                  className="min-w-0 max-w-[152px] shrink gap-1.5 px-2 text-xs text-secondary hover:text-primary"
                  aria-label={`Chat mode: ${targetChipLabel(targetMode, workspaces)}`}
                  data-testid="quick-chat-target-chip"
                >
                  {targetChipIcon(targetMode)}
                  <span className="min-w-0 truncate">{targetChipLabel(targetMode, workspaces)}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-64"
                data-testid="quick-chat-target-popover"
              >
                <DropdownMenuRadioGroup
                  value={targetModeValue(targetMode)}
                  onValueChange={(value) => {
                    if (value === "ephemeral") {
                      onTargetModeChange({ kind: "ephemeral" });
                    } else if (value === "noWorkspace") {
                      onTargetModeChange({ kind: "noWorkspace" });
                    } else if (value.startsWith("workspace:")) {
                      onTargetModeChange({
                        kind: "workspace",
                        workspaceId: value.slice("workspace:".length),
                      });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="ephemeral" className="items-start py-2">
                    <Clock className="mt-0.5 size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <Text variant="small-strong" className="block">
                        Temporary
                      </Text>
                      <Text variant="small" color="secondary" className="block text-mini">
                        Hidden from sidebar until saved or attached
                      </Text>
                    </div>
                  </DropdownMenuRadioItem>

                  <DropdownMenuRadioItem value="noWorkspace" className="items-start py-2">
                    <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <Text variant="small-strong" className="block">
                        No workspace
                      </Text>
                      <Text variant="small" color="secondary" className="block text-mini">
                        Saved to Chats without a project folder
                      </Text>
                    </div>
                  </DropdownMenuRadioItem>

                  {realWorkspaces.length > 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <div className="max-h-36 overflow-y-auto">
                        {realWorkspaces.map((ws) => (
                          <DropdownMenuRadioItem key={ws.id} value={`workspace:${ws.id}`}>
                            <Folder className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </div>
                    </>
                  ) : null}
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    void handleOpenFolder();
                  }}
                >
                  <FolderPlus className="size-3.5 shrink-0" aria-hidden="true" />
                  <span>Open folder…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <AgentModelPopover
            providers={providers}
            providerId={providerId}
            model={model}
            thinkingLevel={thinkingLevel}
            slider={agentSlider}
            settingsLoaded={settingsLoaded}
            onChange={onModelChange}
            onSelectStop={onSelectStop}
            disabled={isGenerating}
            hiddenModelsByProvider={hiddenModelsByProvider}
            onOpenSettings={(section) => void quickChatApi.openSettings(section)}
            beforeOpen={onBeforePopoverOpen}
            onOpenChange={handleModelOpenChange}
            closeSignal={popoverResetSeq}
            showDetails={false}
          />

          <Button
            variant={voice.recording ? "filled" : "transparent"}
            size="small"
            iconOnly
            className={cn(
              "shrink-0",
              voice.recording ? "text-status-red" : "text-secondary hover:text-primary",
            )}
            aria-label={voice.recording ? "Stop voice input" : "Voice input"}
            title={voice.recording ? "Stop voice input" : "Voice input"}
            disabled={voice.transcribing}
            onClick={() => {
              if (voice.recording) voice.stop();
              else void voice.start();
            }}
            data-testid="quick-chat-mic-btn"
          >
            {voice.transcribing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : voice.recording ? (
              <Square className="size-3 fill-current" />
            ) : (
              <Mic className="size-3.5" />
            )}
          </Button>

          {isGenerating && text.trim().length === 0 && attachments.length === 0 ? (
            <Button
              variant="filled"
              size="small"
              iconOnly
              aria-label="Stop response"
              title="Stop response"
              onClick={onStop}
              data-testid="quick-chat-stop-btn"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              variant="accent"
              size="small"
              iconOnly
              aria-label={isGenerating ? "Queue follow-up" : "Send"}
              title={isGenerating ? "Queue follow-up" : "Send"}
              disabled={!canSend}
              onClick={onSend}
              data-testid="quick-chat-send-btn"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
