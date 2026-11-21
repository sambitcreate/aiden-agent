// Floating Chat Starter (State 1) -> Floating Mini-Modal (State 2) application.
// Defaults to Temporary (ephemeral) chats that can be saved to Chats, attached
// in-place to a real project workspace, or expanded seamlessly mid-stream /
// mid-approval into Aiden's main window.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark,
  Folder,
  FolderPlus,
  Maximize2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { Badge, Button, ScrollArea, Text, toast } from "../components/ui";
import { MessageList } from "../components/message-list";
import { ChatApprovalCard } from "../components/chat-approval-card";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { AttachWorkspaceDialog } from "../components/attach-workspace-dialog";
import {
  chatsApi,
  createChatTurnId,
  onNotification,
  providersApi,
  quickChatApi,
  settingsApi,
  startGeneration,
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
} from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { newChatUuid } from "../shared/chat-identity";
import { isNoWorkspace, noWorkspaceHome, workspaceChoices } from "../lib/no-workspace";
import { resolveVisibleModelSelection } from "../lib/use-model-selection";
import { isEscapeKey } from "../lib/dismiss-key";
import { hasOpenLayer } from "../lib/layer-stack";
import { reduceVisualDrafts, type VisualDrafts } from "../lib/html-artifact-transcript";
import { reduceUiDrafts, reduceUiVisuals, type UiDrafts } from "../lib/ui-visual-transcript";
import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";
import type { GenerationTimeline } from "../shared/generation-timeline";
import type { AskUserQuestionPromptV1, AskUserQuestionResponseV1 } from "../shared/ask-user-question";
import type { HandoffQueuedMessage } from "../shared/chat-handoff";
import type { Attachment, Chat, Workspace } from "../lib/types";
import {
  FloatingComposer,
  type QuickChatTargetMode,
} from "./floating-composer";

const NO_VISUAL_DRAFTS: VisualDrafts = new Map();
const NO_UI_DRAFTS: UiDrafts = new Map();
const NO_UI_VISUALS: ChatUiVisualV1[] = [];

function resolveDefaultTargetMode(
  preference: "ephemeral" | "noWorkspace" | "lastWorkspace" | undefined,
  workspaces: readonly Workspace[],
  lastWorkspaceId: string | undefined,
): QuickChatTargetMode {
  if (preference === "noWorkspace") return { kind: "noWorkspace" };
  if (preference === "lastWorkspace") {
    const real = workspaceChoices(workspaces);
    const chosen =
      (lastWorkspaceId ? real.find((w) => w.id === lastWorkspaceId) : undefined) ?? real[0];
    if (chosen) return { kind: "workspace", workspaceId: chosen.id };
  }
  return { kind: "ephemeral" };
}

export function FloatingChatApp() {
  const qc = useQueryClient();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => settingsApi.get(),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.providers,
    queryFn: () => providersApi.list(),
  });
  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => workspacesApi.list(),
  });

  const providers = React.useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const workspaces = React.useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const settings = settingsQuery.data;

  const [stage, setStage] = React.useState<"starter" | "modal">("starter");
  const [targetMode, setTargetMode] = React.useState<QuickChatTargetMode>({ kind: "ephemeral" });
  const targetModeTouchedRef = React.useRef(false);

  const [selectedModel, setSelectedModel] = React.useState<{ providerId: string; model: string }>({
    providerId: "",
    model: "",
  });
  const modelTouchedRef = React.useRef(false);

  // Sync default persistence preference before user touches the target chip.
  React.useEffect(() => {
    if (targetModeTouchedRef.current || !settings) return;
    const pref = (settings as { quickChatDefaultPersistence?: "ephemeral" | "noWorkspace" | "lastWorkspace" })
      .quickChatDefaultPersistence;
    setTargetMode(resolveDefaultTargetMode(pref, workspaces, undefined));
  }, [settings, workspaces]);

  // Resolve initial model from configured providers + saved host new-chat model.
  React.useEffect(() => {
    if (modelTouchedRef.current || providers.length === 0) return;
    const saved = {
      providerId: settings?.lastProviderId ?? "",
      model: settings?.lastModel ?? "",
    };
    const resolved = resolveVisibleModelSelection(
      saved,
      providers,
      settings?.hiddenModelsByProvider,
    );
    if (resolved?.providerId && resolved.model) {
      setSelectedModel(resolved);
    }
  }, [providers, settings]);

  // Composer & active chat state
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [chat, setChat] = React.useState<Chat | null>(null);
  const [sending, setSending] = React.useState(false);
  const [queuedMessages, setQueuedMessages] = React.useState<HandoffQueuedMessage[]>([]);

  // Live streaming state
  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = React.useState<string | null>(null);
  const [timeline, setTimeline] = React.useState<GenerationTimeline | null>(null);
  const [streamingArtifacts, setStreamingArtifacts] = React.useState<ChatArtifactV1[]>([]);
  const [visualDrafts, setVisualDrafts] = React.useState<VisualDrafts>(NO_VISUAL_DRAFTS);
  const [streamingUiVisuals, setStreamingUiVisuals] = React.useState<readonly ChatUiVisualV1[]>(NO_UI_VISUALS);
  const [uiDrafts, setUiDrafts] = React.useState<UiDrafts>(NO_UI_DRAFTS);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [approvalDeciding, setApprovalDeciding] = React.useState(false);
  const [questionnaire, setQuestionnaire] = React.useState<AskUserQuestionPromptV1 | null>(null);
  const [questionnaireSubmitting, setQuestionnaireSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Attach-to-workspace & promote state
  const [attachDialogOpen, setAttachDialogOpen] = React.useState(false);
  const [promoting, setPromoting] = React.useState(false);
  const [expanding, setExpanding] = React.useState(false);

  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationIntentRef = React.useRef(0);
  const streamedTextRef = React.useRef("");
  const streamedReasoningRef = React.useRef("");
  const queuedMessagesRef = React.useRef<HandoffQueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;
  const chatRef = React.useRef<Chat | null>(null);
  chatRef.current = chat;

  const isGenerating = streamingText !== null;

  const clearStreamingState = React.useCallback(() => {
    generationRef.current = null;
    streamedTextRef.current = "";
    streamedReasoningRef.current = "";
    setStreamingText(null);
    setStreamingReasoning(null);
    setTimeline(null);
    setStreamingArtifacts([]);
    setVisualDrafts(NO_VISUAL_DRAFTS);
    setStreamingUiVisuals(NO_UI_VISUALS);
    setUiDrafts(NO_UI_DRAFTS);
    setApprovals([]);
    setQuestionnaire(null);
    setQuestionnaireSubmitting(false);
  }, []);

  const resetToStarter = React.useCallback(
    (options: { cancelActive?: boolean } = {}) => {
      generationIntentRef.current += 1;
      if (options.cancelActive && generationRef.current) {
        generationRef.current.cancel("user_stop");
      }
      clearStreamingState();
      setChat(null);
      setSending(false);
      setText("");
      setAttachments([]);
      setQueuedMessages([]);
      setError(null);
      setAttachDialogOpen(false);
      setStage("starter");
      void quickChatApi.setMode("starter").catch(() => undefined);
    },
    [clearStreamingState],
  );

  // Listen for main-process `quickChat:opened` and `quickChat:handoff-complete`.
  React.useEffect(() => {
    const offOpened = onNotification("quickChat:opened", () => {
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
    const offHandoff = onNotification("quickChat:handoff-complete", () => {
      // Ownership was ALREADY transferred to mainWindow; reset UI cleanly
      // WITHOUT cancelling the active stream!
      resetToStarter({ cancelActive: false });
      setExpanding(false);
    });
    const offMeta = onNotification<{ chatId?: string; title?: string; workspaceId?: string }>(
      "chats:metadata-updated",
      (payload) => {
        if (!payload?.chatId || chatRef.current?.id !== payload.chatId) return;
        setChat((prev) =>
          prev && prev.id === payload.chatId
            ? {
                ...prev,
                ...(payload.title ? { title: payload.title } : {}),
                ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
              }
            : prev,
        );
      },
    );
    return () => {
      offOpened();
      offHandoff();
      offMeta();
    };
  }, [qc, resetToStarter]);

  // Global Escape handler: close popovers/dialogs first, then hide floating window.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeKey(event) || event.defaultPrevented) return;
      if (attachDialogOpen || hasOpenLayer()) return;
      event.preventDefault();
      void quickChatApi.hide().catch(() => undefined);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attachDialogOpen]);

  const startTurnStream = React.useCallback(
    (
      activeChat: Chat,
      turnId: string,
      modelChoice: { providerId: string; model: string },
    ) => {
      const intent = (generationIntentRef.current += 1);
      streamedTextRef.current = "";
      streamedReasoningRef.current = "";
      setError(null);
      setStreamingText("");
      setStreamingReasoning(null);
      setTimeline(null);
      setStreamingArtifacts([]);
      setVisualDrafts(NO_VISUAL_DRAFTS);
      setStreamingUiVisuals(NO_UI_VISUALS);
      setUiDrafts(NO_UI_DRAFTS);
      setApprovals([]);
      setQuestionnaire(null);

      const handle = startGeneration(
        {
          chatId: activeChat.id,
          workspaceId: activeChat.workspaceId,
          providerId: modelChoice.providerId,
          model: modelChoice.model,
          inlineVisuals: "automatic",
        },
        {
          onDelta: (delta) => {
            if (generationIntentRef.current !== intent) return;
            streamedTextRef.current += delta;
            setStreamingText(streamedTextRef.current);
          },
          onReset: () => {
            if (generationIntentRef.current !== intent) return;
            streamedTextRef.current = "";
            streamedReasoningRef.current = "";
            setStreamingText("");
            setStreamingReasoning(null);
          },
          onReasoningDelta: (delta) => {
            if (generationIntentRef.current !== intent) return;
            streamedReasoningRef.current += delta;
            setStreamingReasoning(streamedReasoningRef.current);
          },
          onTimeline: (next) => {
            if (generationIntentRef.current !== intent) return;
            setTimeline(next);
          },
          onArtifactEvent: (event) => {
            if (generationIntentRef.current !== intent) return;
            setVisualDrafts((curr) => reduceVisualDrafts(curr, event));
            setUiDrafts((curr) => reduceUiDrafts(curr, event));
            setStreamingUiVisuals((curr) => reduceUiVisuals(curr, event));
            if (event.operation === "reset") {
              setStreamingArtifacts([]);
            } else if (event.operation === "present") {
              const { artifact } = event;
              setStreamingArtifacts((curr) => {
                if (artifact.kind === "html") {
                  const idx = curr.findIndex(
                    (c) => c.kind === "html" && c.mediaId === artifact.mediaId,
                  );
                  return idx >= 0
                    ? curr.map((c, i) => (i === idx ? artifact : c))
                    : [...curr, artifact];
                }
                if (
                  curr.some(
                    (c) => c.kind === "image" && c.attachment.id === artifact.attachment.id,
                  )
                ) {
                  return curr;
                }
                return [...curr, artifact];
              });
            }
          },
          onApproval: (prompt) => {
            if (generationIntentRef.current !== intent) return;
            setApprovals((prev) =>
              prev.some((p) => p.approvalId === prompt.approvalId) ? prev : [...prev, prompt],
            );
          },
          onQuestionnaire: (prompt) => {
            if (generationIntentRef.current !== intent) return;
            setQuestionnaireSubmitting(false);
            setQuestionnaire(prompt);
          },
          onDone: async (_full, _finalTimeline, updatedChat) => {
            if (generationIntentRef.current !== intent) return;
            if (updatedChat) {
              setChat(updatedChat);
              clearStreamingState();
              return;
            }
            try {
              const fresh = await chatsApi.get(activeChat.id);
              if (generationIntentRef.current !== intent) return;
              if (fresh && chatRef.current?.id === activeChat.id) setChat(fresh);
            } catch {
              // Keep existing chat state when refresh fails.
            }
            if (generationIntentRef.current === intent) {
              clearStreamingState();
            }
          },
          onError: (message, _partial, _finalTimeline, updatedChat) => {
            if (generationIntentRef.current !== intent) return;
            clearStreamingState();
            if (updatedChat) setChat(updatedChat);
            const persistedFailure =
              updatedChat?.messages[updatedChat.messages.length - 1]?.role === "assistant" &&
              updatedChat.messages[updatedChat.messages.length - 1]?.providerFailure;
            setError(persistedFailure ? null : message);
          },
        },
        turnId,
      );
      generationRef.current = handle;
      void handle.started.then((result) => {
        if (generationIntentRef.current !== intent) return;
        if (!result.ok) {
          clearStreamingState();
          setError(result.error.message || "Could not start generation.");
        }
      });
    },
    [clearStreamingState],
  );

  // Drain next queued follow-up automatically once idle and without errors.
  const drainingQueueRef = React.useRef(false);
  React.useEffect(() => {
    if (isGenerating || sending || error || !chat || queuedMessages.length === 0) return;
    if (drainingQueueRef.current) return;
    drainingQueueRef.current = true;
    const drainIntent = generationIntentRef.current;
    const drainChatId = chat.id;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    const turnId = createChatTurnId();
    void chatsApi
      .appendMessage(
        drainChatId,
        {
          role: "user",
          content: next.content,
          ...(next.attachments && next.attachments.length > 0
            ? { attachments: next.attachments as Attachment[] }
            : {}),
        },
        {
          providerId: selectedModel.providerId,
          model: selectedModel.model,
          turnId,
        },
      )
      .then((updated) => {
        if (generationIntentRef.current !== drainIntent || chatRef.current?.id !== drainChatId) {
          return;
        }
        setChat(updated);
        startTurnStream(updated, turnId, selectedModel);
      })
      .catch((err) => {
        if (generationIntentRef.current !== drainIntent || chatRef.current?.id !== drainChatId) {
          return;
        }
        setError(err instanceof Error ? err.message : "Could not send queued message.");
      })
      .finally(() => {
        drainingQueueRef.current = false;
      });
  }, [chat, error, isGenerating, queuedMessages, selectedModel, sending, startTurnStream]);

  const handleSend = async () => {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    if (!selectedModel.providerId || !selectedModel.model) {
      toast.info("Choose a model before sending.");
      return;
    }

    // If a turn is already streaming in State 2, queue the follow-up.
    if (stage === "modal" && chat && isGenerating) {
      const queued: HandoffQueuedMessage = {
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      setQueuedMessages((prev) => [...prev, queued]);
      setText("");
      setAttachments([]);
      return;
    }

    const isFirstMessage = stage === "starter" || !chat;
    const sendIntent = (generationIntentRef.current += 1);
    const outgoingAttachments = attachments;
    setText("");
    setAttachments([]);
    setSending(true);
    setError(null);

    try {
      if (isFirstMessage) {
        // Morph atomically into State 2 Mini-Modal immediately.
        setStage("modal");
        void quickChatApi.setMode("modal").catch(() => undefined);

        let targetWorkspaceId: string;
        if (targetMode.kind === "workspace") {
          targetWorkspaceId = targetMode.workspaceId;
        } else {
          const scratch = await workspacesApi.createNoWorkspace();
          if (generationIntentRef.current !== sendIntent) return;
          targetWorkspaceId = scratch.id;
          void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        }

        const draftId = newChatUuid(() => crypto.randomUUID());
        const turnId = createChatTurnId();
        const optimistic: Chat = {
          id: draftId,
          workspaceId: targetWorkspaceId,
          ...(targetMode.kind === "ephemeral" ? { ephemeral: true as const } : {}),
          title: content.slice(0, 48) || "Quick Chat",
          providerId: selectedModel.providerId,
          model: selectedModel.model,
          messages: [
            {
              id: `optimistic-${turnId}`,
              role: "user",
              content,
              ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
              createdAt: Date.now(),
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setChat(optimistic);

        const created = await chatsApi.createWithFirstMessage({
          draftId,
          workspaceId: targetWorkspaceId,
          ...(targetMode.kind === "ephemeral" ? { ephemeral: true as const } : {}),
          providerId: selectedModel.providerId,
          model: selectedModel.model,
          turnId,
          message: {
            role: "user",
            content,
            ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
          },
        });
        if (generationIntentRef.current !== sendIntent) {
          if (created.ephemeral) {
            void chatsApi.remove(created.id).catch(() => undefined);
          }
          return;
        }
        setChat(created);
        startTurnStream(created, turnId, selectedModel);
      } else {
        const activeChatId = chat.id;
        const turnId = createChatTurnId();
        const updated = await chatsApi.appendMessage(
          activeChatId,
          {
            role: "user",
            content,
            ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
          },
          {
            providerId: selectedModel.providerId,
            model: selectedModel.model,
            turnId,
          },
        );
        if (generationIntentRef.current !== sendIntent || chatRef.current?.id !== activeChatId) {
          return;
        }
        setChat(updated);
        startTurnStream(updated, turnId, selectedModel);
      }
    } catch (err) {
      if (generationIntentRef.current !== sendIntent) return;
      const message = err instanceof Error ? err.message : "Could not send message.";
      if (isFirstMessage) {
        setChat(null);
        setStage("starter");
        void quickChatApi.setMode("starter").catch(() => undefined);
        toast.error(message);
      } else {
        setError(message);
      }
      setText(content);
      setAttachments(outgoingAttachments);
    } finally {
      setSending(false);
    }
  };

  const handleStop = () => {
    if (queuedMessages.length > 0) {
      const [firstQueued] = queuedMessages;
      setQueuedMessages([]);
      if (!text.trim() && firstQueued?.content) {
        setText(firstQueued.content);
      }
    }
    generationRef.current?.cancel("user_stop");
  };

  const handleExpand = async () => {
    if (expanding) return;
    setExpanding(true);
    try {
      if (stage === "starter" || !chat) {
        const fallbackWorkspaceId =
          targetMode.kind === "workspace"
            ? targetMode.workspaceId
            : noWorkspaceHome(workspaces)?.id ?? workspaceChoices(workspaces)[0]?.id ?? "default";
        const result = await quickChatApi.expandToMain({
          kind: "draft",
          workspaceId: fallbackWorkspaceId,
          text,
          attachments,
          ...(selectedModel.providerId && selectedModel.model
            ? { providerId: selectedModel.providerId, model: selectedModel.model }
            : {}),
        });
        if (!result.ok) {
          toast.error("Could not open Aiden's main window.");
          setExpanding(false);
        }
        return;
      }

      const result = await quickChatApi.expandToMain({
        kind: "chat",
        chatId: chat.id,
        ...(text.trim() ? { draftText: text } : {}),
        ...(attachments.length > 0 ? { draftAttachments: attachments } : {}),
        ...(queuedMessages.length > 0 ? { queuedMessages } : {}),
      });
      if (!result.ok) {
        toast.error("Could not expand chat into Aiden's main window.");
        setExpanding(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not expand into Aiden.");
      setExpanding(false);
    }
  };

  const handlePromoteEphemeral = async () => {
    if (!chat || !chat.ephemeral || promoting) return;
    setPromoting(true);
    try {
      const promoted = await chatsApi.promoteEphemeral(chat.id);
      if (promoted) {
        setChat(promoted);
        toast.success("Saved to Chats.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save temporary chat.");
    } finally {
      setPromoting(false);
    }
  };

  const handleDiscard = async () => {
    const active = chat;
    resetToStarter({ cancelActive: true });
    if (active?.ephemeral) {
      await chatsApi.remove(active.id).catch(() => undefined);
    }
  };

  const handleNewChat = async () => {
    const previous = chat;
    resetToStarter({ cancelActive: true });
    if (previous?.ephemeral) {
      await chatsApi.remove(previous.id).catch(() => undefined);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleApprovalDecision = async (
    decision: "allow" | "deny",
    options?: { formFillExcludedOrders?: number[]; scope?: "once" | "chat" | "always" | "workspace" },
  ) => {
    const current = approvals[0];
    if (!current || approvalDeciding) return;
    setApprovalDeciding(true);
    try {
      await chatsApi.approve(current.approvalId, decision, options);
      setApprovals((prev) => prev.filter((item) => item.approvalId !== current.approvalId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit approval decision.");
    } finally {
      setApprovalDeciding(false);
    }
  };

  const handleQuestionnaireRespond = async (response: AskUserQuestionResponseV1) => {
    if (!questionnaire || questionnaireSubmitting) return;
    setQuestionnaireSubmitting(true);
    try {
      await chatsApi.answerQuestionnaire(questionnaire.promptId, response);
      setQuestionnaire(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit answer.");
    } finally {
      setQuestionnaireSubmitting(false);
    }
  };

  const activeWorkspace = React.useMemo(
    () => (chat?.workspaceId ? workspaces.find((w) => w.id === chat.workspaceId) : undefined),
    [chat?.workspaceId, workspaces],
  );
  const canAttachWorkspace = Boolean(
    chat && !isGenerating && (chat.ephemeral || isNoWorkspace(activeWorkspace)),
  );

  // State 1: Compact floating starter bar anchored to the bottom of the stage
  // so opening popovers expands the window upward without shifting the bar.
  if (stage === "starter") {
    return (
      <div
        className="flex h-screen w-screen flex-col items-center justify-end bg-transparent p-6"
        data-testid="quick-chat-stage-starter"
      >
        <div className="w-full max-w-[512px]">
          <FloatingComposer
            variant="starter"
            text={text}
            onTextChange={setText}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            providers={providers}
            providerId={selectedModel.providerId}
            model={selectedModel.model}
            onModelChange={(providerId, model) => {
              modelTouchedRef.current = true;
              setSelectedModel({ providerId, model });
            }}
            hiddenModelsByProvider={settings?.hiddenModelsByProvider}
            workspaces={workspaces}
            targetMode={targetMode}
            onTargetModeChange={(mode) => {
              targetModeTouchedRef.current = true;
              setTargetMode(mode);
            }}
            onWorkspaceCreated={() => {
              void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
            }}
            isGenerating={false}
            sending={sending}
            onSend={() => void handleSend()}
            onStop={handleStop}
            onExpand={() => void handleExpand()}
            onPopoverOpenChange={(open) => {
              void quickChatApi.setMode(open ? "starter-popover" : "starter").catch(() => undefined);
            }}
            textareaRef={textareaRef}
          />
        </div>
      </div>
    );
  }

  // State 2: Floating Mini-Modal with draggable header, status strip, live
  // transcript, approvals/questions, and docked composer.
  const currentApproval = approvals[0];

  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-end bg-transparent p-6"
      data-testid="quick-chat-stage-modal"
    >
      <div
        className="qc-modal-card flex h-full w-full flex-col overflow-hidden rounded-2xl bg-popover shadow-modal"
        role="dialog"
        aria-label="Aiden Quick Chat"
        data-testid="quick-chat-mini-modal"
      >
        {/* Draggable header bar */}
        <header className="qc-drag-region flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
          <div className="qc-no-drag flex items-center gap-1">
            <Button
              variant="transparent"
              size="small"
              iconOnly
              className="text-secondary hover:text-primary"
              aria-label="Hide Quick Chat"
              title="Hide (Esc)"
              onClick={() => void quickChatApi.hide().catch(() => undefined)}
              data-testid="quick-chat-close-btn"
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="flex min-w-0 flex-1 flex-col items-center justify-center">
            <Text variant="small-strong" className="max-w-full truncate text-center">
              {chat?.title || "Quick Chat"}
            </Text>
            {chat && !chat.ephemeral && activeWorkspace && !isNoWorkspace(activeWorkspace) ? (
              <span
                className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-secondary"
                data-testid="quick-chat-attached-workspace"
              >
                <Folder className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{activeWorkspace.name}</span>
              </span>
            ) : null}
          </div>

          <div className="qc-no-drag flex items-center gap-1">
            {chat?.ephemeral ? (
              <Button
                variant="transparent"
                size="small"
                iconOnly
                className="text-secondary hover:text-primary"
                aria-label="Discard temporary chat"
                title="Discard temporary chat"
                onClick={() => void handleDiscard()}
                data-testid="quick-chat-discard-btn"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="transparent"
              size="small"
              iconOnly
              className="text-secondary hover:text-primary"
              aria-label="New quick chat"
              title="New quick chat"
              onClick={() => void handleNewChat()}
              data-testid="quick-chat-new-btn"
            >
              <SquarePen className="size-3.5" />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              className="text-secondary hover:text-primary"
              aria-label="Expand to Aiden"
              title="Expand to Aiden"
              disabled={expanding || sending}
              onClick={() => void handleExpand()}
              data-testid="quick-chat-expand-modal"
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </div>
        </header>

        {/* Subtle status strip for Temporary / No workspace / attached workspace */}
        {chat && (chat.ephemeral || isNoWorkspace(activeWorkspace)) ? (
          <div
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 bg-well px-3.5 py-2"
            data-testid="quick-chat-status-strip"
          >
            <div className="flex items-center gap-1.5">
              {chat.ephemeral ? (
                <Badge color="warning">Temporary</Badge>
              ) : (
                <Badge>No workspace</Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {chat.ephemeral ? (
                <Button
                  variant="transparent"
                  size="small"
                  className="h-7 gap-1 px-2 text-xs text-secondary hover:text-primary"
                  disabled={promoting || sending}
                  onClick={() => void handlePromoteEphemeral()}
                  data-testid="quick-chat-save-btn"
                >
                  <Bookmark className="size-3" aria-hidden="true" />
                  <span>Save</span>
                </Button>
              ) : null}
              <Button
                variant="transparent"
                size="small"
                className="h-7 gap-1 px-2 text-xs text-secondary hover:text-primary"
                disabled={!canAttachWorkspace || sending}
                onClick={() => setAttachDialogOpen(true)}
                data-testid="quick-chat-attach-workspace-btn"
              >
                <FolderPlus className="size-3" aria-hidden="true" />
                <span>Attach to workspace…</span>
              </Button>
            </div>
          </div>
        ) : null}

        {/* Transcript scroll area */}
        <ScrollArea
          className="min-h-0 flex-1"
          autoScrollToBottom
          autoScrollDeps={[chat?.messages.length, streamingText, approvals.length, questionnaire?.promptId]}
          streaming={isGenerating}
          showScrollToBottomButton
        >
          <MessageList
            compact
            chatId={chat?.id ?? "quick-chat"}
            messages={chat?.messages ?? []}
            streamingText={streamingText}
            streamingReasoning={streamingReasoning}
            streamingArtifacts={streamingArtifacts}
            streamingVisualDrafts={visualDrafts}
            streamingUiVisuals={streamingUiVisuals}
            streamingUiDrafts={uiDrafts}
            timeline={timeline}
            liveSubagents={[]}
            subagentsEnabled={false}
            onOpenSubagent={() => undefined}
            agentActivity={
              isGenerating && !streamingText
                ? { phase: "thinking", label: "Thinking…", mark: "helix-calm" }
                : null
            }
            error={error}
            storedImageActions={false}
            forkBeforeFirstPrompt={false}
          />
        </ScrollArea>

        {/* Footer stack: approvals, questions, queued indicator, docked composer */}
        <div className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-2">
          {currentApproval ? (
            <ChatApprovalCard
              pending={currentApproval}
              deciding={approvalDeciding}
              pendingCount={approvals.length}
              onDecide={(decision, options) => void handleApprovalDecision(decision, options)}
            />
          ) : null}

          {questionnaire ? (
            <AskUserQuestionComposer
              prompt={questionnaire}
              submitting={questionnaireSubmitting}
              onRespond={(response) => void handleQuestionnaireRespond(response)}
            />
          ) : null}

          {queuedMessages.length > 0 ? (
            <div className="flex items-center justify-between rounded-lg bg-well px-3 py-1.5 text-xs text-secondary">
              <span>
                {queuedMessages.length === 1
                  ? "1 follow-up queued"
                  : `${queuedMessages.length} follow-ups queued`}
              </span>
              <Button
                variant="transparent"
                size="small"
                className="h-6 px-1.5 text-xs"
                onClick={() => setQueuedMessages([])}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <FloatingComposer
            variant="modal"
            text={text}
            onTextChange={setText}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            providers={providers}
            providerId={selectedModel.providerId}
            model={selectedModel.model}
            onModelChange={(providerId, model) => {
              modelTouchedRef.current = true;
              setSelectedModel({ providerId, model });
            }}
            hiddenModelsByProvider={settings?.hiddenModelsByProvider}
            workspaces={workspaces}
            targetMode={targetMode}
            isGenerating={isGenerating}
            sending={sending}
            onSend={() => void handleSend()}
            onStop={handleStop}
            textareaRef={textareaRef}
          />
        </div>
      </div>

      {chat ? (
        <AttachWorkspaceDialog
          open={attachDialogOpen}
          onOpenChange={setAttachDialogOpen}
          chatId={chat.id}
          workspaces={workspaces}
          beforeAttach={() => void quickChatApi.suppressBlur(10_000).catch(() => undefined)}
          onWorkspaceCreated={() => {
            void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
          }}
          onAttached={(result) => {
            setChat(result.chat);
            void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
            toast.success("Attached to workspace.");
          }}
        />
      ) : null}
    </div>
  );
}
