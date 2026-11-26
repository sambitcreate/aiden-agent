// Floating Chat Starter (State 1) -> Floating Mini-Modal (State 2) application.
// Defaults to Temporary (ephemeral) chats that can be saved to Chats, attached
// in-place to a real project workspace, or expanded seamlessly mid-stream /
// mid-approval into Aiden's main window.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark,
  ChevronDown,
  Clock,
  Folder,
  FolderPlus,
  Maximize2,
  MessageCircle,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ScrollArea,
  Text,
  toast,
} from "../components/ui";
import { cn } from "../lib/ui-utils";
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
  shortcutApi,
  startGeneration,
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
} from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { newChatUuid } from "../shared/chat-identity";
import { applyChatMetadataUpdate } from "../shared/chat-metadata-update";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import { isNoWorkspace, noWorkspaceHome, workspaceChoices } from "../lib/no-workspace";
import { resolveVisibleModelSelection } from "../lib/use-model-selection";
import { isComposingKey, isEscapeKey } from "../lib/dismiss-key";
import { agentSliderComposerState, agentSliderStepTarget } from "../lib/agent-slider-view";
import { matchesAccelerator, type KeybindingSnapshot } from "../shared/keybindings";
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

/** The model a Quick Chat turn runs on, with an Agent Slider stop's effort. */
interface QuickChatSelection {
  providerId: string;
  model: string;
  thinkingLevel?: GenerationThinkingLevel;
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

  // `thinkingLevel` is set only by an Agent Slider stop (or the main window's
  // new-chat pick); a model from the list runs at its saved level.
  const [selectedModel, setSelectedModel] = React.useState<QuickChatSelection>({
    providerId: "",
    model: "",
  });
  const modelTouchedRef = React.useRef(false);

  // Sync default persistence preference before user touches the target chip.
  React.useEffect(() => {
    if (targetModeTouchedRef.current || !settings) return;
    setTargetMode(
      resolveDefaultTargetMode(
        settings.quickChatDefaultPersistence,
        workspaces,
        settings.lastWorkspaceId,
      ),
    );
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
      const level =
        resolved.providerId === saved.providerId && resolved.model === saved.model
          ? settings?.lastThinkingLevel
          : undefined;
      setSelectedModel({
        providerId: resolved.providerId,
        model: resolved.model,
        ...(level ? { thinkingLevel: level } : {}),
      });
    }
  }, [providers, settings]);

  // Composer & active chat state
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [chat, setChat] = React.useState<Chat | null>(null);
  const [sending, setSendingState] = React.useState(false);
  // Read synchronously by model picks: once Send starts, a pick can't overtake
  // the selection that send captured.
  const sendingRef = React.useRef(false);
  // A stop reassignment still saving: Send waits so the turn runs on that stop.
  const [selectionSaving, setSelectionSavingState] = React.useState(false);
  const selectionSavingRef = React.useRef(false);
  const setSelectionSaving = React.useCallback((value: boolean) => {
    selectionSavingRef.current = value;
    setSelectionSavingState(value);
  }, []);
  const setSending = React.useCallback((value: boolean) => {
    sendingRef.current = value;
    setSendingState(value);
  }, []);
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
  const [statusMenuOpen, setStatusMenuOpen] = React.useState(false);
  const [promoting, setPromoting] = React.useState(false);
  const [expanding, setExpanding] = React.useState(false);
  const [starterPopoverResetSeq, setStarterPopoverResetSeq] = React.useState(0);

  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationIntentRef = React.useRef(0);
  const stageRef = React.useRef(stage);
  stageRef.current = stage;
  const popoverOpenGenRef = React.useRef(0);
  const starterPopoverActiveRef = React.useRef(false);
  const popoverShrinkTimerRef = React.useRef<number | null>(null);
  const streamedTextRef = React.useRef("");
  const streamedReasoningRef = React.useRef("");
  const queuedMessagesRef = React.useRef<HandoffQueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;
  const chatRef = React.useRef<Chat | null>(null);
  chatRef.current = chat;

  const isGenerating = streamingText !== null;

  const clearPopoverShrinkTimer = React.useCallback(() => {
    if (popoverShrinkTimerRef.current !== null) {
      window.clearTimeout(popoverShrinkTimerRef.current);
      popoverShrinkTimerRef.current = null;
    }
  }, []);

  const dismissStarterPopovers = React.useCallback(
    (options: { syncMainMode?: boolean } = {}) => {
      popoverOpenGenRef.current += 1;
      clearPopoverShrinkTimer();
      if (stageRef.current !== "starter") return;
      const hadActivePopover = starterPopoverActiveRef.current;
      starterPopoverActiveRef.current = false;
      setStarterPopoverResetSeq((seq) => seq + 1);
      if (options.syncMainMode && hadActivePopover) {
        void quickChatApi.setMode("starter").catch(() => undefined);
      }
    },
    [clearPopoverShrinkTimer],
  );

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
      dismissStarterPopovers({ syncMainMode: false });
      clearStreamingState();
      setChat(null);
      setSending(false);
      setText("");
      setAttachments([]);
      setQueuedMessages([]);
      setError(null);
      setAttachDialogOpen(false);
      setStatusMenuOpen(false);
      setStage("starter");
      void quickChatApi.setMode("starter").catch(() => undefined);
    },
    [clearStreamingState, dismissStarterPopovers],
  );

  // Listen for main-process `quickChat:opened`, `quickChat:hidden`, and `quickChat:handoff-complete`.
  React.useEffect(() => {
    const offOpened = onNotification("quickChat:opened", () => {
      dismissStarterPopovers({ syncMainMode: true });
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
    const offHidden = onNotification("quickChat:hidden", () => {
      dismissStarterPopovers({ syncMainMode: false });
    });
    const offHandoff = onNotification("quickChat:handoff-complete", () => {
      // Ownership was ALREADY transferred to mainWindow; reset UI cleanly
      // WITHOUT cancelling the active stream!
      resetToStarter({ cancelActive: false });
      setExpanding(false);
    });
    const offMeta = onNotification<{
      chatId?: string;
      title?: string;
      workspaceId?: string;
      updatedAt?: number;
      ephemeral?: boolean;
      thinkingLevel?: GenerationThinkingLevel | null;
    }>(
      "chats:metadata-updated",
      (payload) => {
        if (!payload?.chatId || chatRef.current?.id !== payload.chatId) return;
        // Main reconciled the chat's own level (a clamp): the slider follows the
        // level that actually ran while this window still has the chat's model.
        const reconciled = payload.thinkingLevel;
        if (reconciled !== undefined) {
          const owned = chatRef.current;
          setSelectedModel((prev) => {
            if (!owned || prev.providerId !== owned.providerId || prev.model !== owned.model) return prev;
            const { thinkingLevel: _previous, ...rest } = prev;
            return reconciled ? { ...rest, thinkingLevel: reconciled } : rest;
          });
        }
        setChat((prev) =>
          prev && prev.id === payload.chatId
            ? applyChatMetadataUpdate(prev, {
                chatId: payload.chatId,
                title: payload.title ?? prev.title,
                ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
                updatedAt: payload.updatedAt ?? prev.updatedAt,
                ...(payload.ephemeral !== undefined ? { ephemeral: payload.ephemeral } : {}),
                ...(payload.thinkingLevel !== undefined ? { thinkingLevel: payload.thinkingLevel } : {}),
              })
            : prev,
        );
      },
    );
    const offControls = onNotification("settings:controls-changed", () => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
    });
    // A hand edit of config.json (the Agent Slider among it) reaches this window too.
    const offConfig = onNotification("app:config-externally-changed", () => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
    });
    return () => {
      offOpened();
      offHidden();
      offHandoff();
      offMeta();
      offControls();
      offConfig();
    };
  }, [dismissStarterPopovers, qc, resetToStarter]);

  // The Agent Slider step shortcuts (⌥⌘[ / ⌥⌘] unless rebound). Quick Chat has
  // no command system, so it reads the bindings when the window opens.
  const [shortcutBindings, setShortcutBindings] = React.useState<KeybindingSnapshot["effective"] | null>(null);
  React.useEffect(() => {
    let live = true;
    const load = () =>
      void shortcutApi.get().then(
        (snapshot) => {
          if (live) setShortcutBindings(snapshot.effective);
        },
        () => undefined,
      );
    load();
    const offOpened = onNotification("quickChat:opened", load);
    return () => {
      live = false;
      offOpened();
    };
  }, []);
  const agentSliderState = React.useMemo(
    () =>
      agentSliderComposerState(
        settings?.agentSlider,
        { providers, hiddenModelsByProvider: settings?.hiddenModelsByProvider },
        selectedModel,
      ),
    [settings?.agentSlider, settings?.hiddenModelsByProvider, providers, selectedModel],
  );
  // Before the first send the pick is local and goes with the first message.
  // Once the chat exists, main holds its selection (`chats:setModel`), so a
  // handoff, a reopen and the clamp write-back all see the stop chosen here.
  // `level`: a stop's effort, or null for a stop without one; left out, a list
  // pick keeps the chat's level only while the model stays the same.
  const selectionPickRef = React.useRef(0);
  // The latest pick's save, resolving to the selection main now holds (the
  // saved pick, or the chat's own selection again if main refused it). Send
  // waits on it, so a turn never overtakes the pick it was meant to run on.
  const pendingSelectionRef = React.useRef<Promise<QuickChatSelection> | null>(null);
  const applySelection = React.useCallback(
    (providerId: string, model: string, level?: GenerationThinkingLevel | null) => {
      // A send in flight already captured its selection; a pick now would let
      // the turn and the chat's saved model and effort disagree.
      if (sendingRef.current) return;
      modelTouchedRef.current = true;
      const picked: QuickChatSelection = { providerId, model, ...(level ? { thinkingLevel: level } : {}) };
      setSelectedModel(picked);
      const owned = chatRef.current;
      if (!owned) return;
      const pick = ++selectionPickRef.current;
      const isLatest = () => pick === selectionPickRef.current && chatRef.current?.id === owned.id;
      const authoritative = (chat: Chat): QuickChatSelection | undefined =>
        chat.providerId && chat.model
          ? {
              providerId: chat.providerId,
              model: chat.model,
              ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
            }
          : undefined;
      const save = chatsApi.setModel(owned.id, providerId, model, level).then(
        (saved) => {
          const selection = saved ? authoritative(saved) : undefined;
          if (saved && isLatest()) {
            setChat(saved);
            if (selection) setSelectedModel(selection);
          }
          return selection ?? picked;
        },
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t change this chat’s model.");
          // Main kept the chat's own selection: show that again, not the refused pick.
          const kept = authoritative(chatRef.current ?? owned) ?? picked;
          if (isLatest()) setSelectedModel(kept);
          return kept;
        },
      );
      pendingSelectionRef.current = save;
      void save.finally(() => {
        if (pendingSelectionRef.current === save) pendingSelectionRef.current = null;
      });
    },
    [],
  );
  const selectAgentSliderStop = React.useCallback(
    (providerId: string, model: string, thinkingLevel: GenerationThinkingLevel | undefined) => {
      applySelection(providerId, model, thinkingLevel ?? null);
    },
    [applySelection],
  );
  React.useEffect(() => {
    if (!shortcutBindings) return;
    const next = shortcutBindings["agentSlider.next"];
    const previous = shortcutBindings["agentSlider.previous"];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isComposingKey(event)) return;
      const direction =
        next && matchesAccelerator(event, next) ? 1 : previous && matchesAccelerator(event, previous) ? -1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      if (isGenerating || sending) return;
      const target = agentSliderStepTarget(agentSliderState, direction);
      if (target?.providerId && target.model) {
        selectAgentSliderStop(target.providerId, target.model, target.thinkingLevel);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [agentSliderState, isGenerating, selectAgentSliderStop, sending, shortcutBindings]);

  // Global Escape handler: close popovers/dialogs first, then hide floating window.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeKey(event) || event.defaultPrevented) return;
      if (attachDialogOpen || hasOpenLayer()) return;
      event.preventDefault();
      dismissStarterPopovers({ syncMainMode: false });
      if (stageRef.current === "starter") {
        void quickChatApi.setMode("starter").catch(() => undefined);
      }
      void quickChatApi.hide().catch(() => undefined);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attachDialogOpen, dismissStarterPopovers]);

  const startTurnStream = React.useCallback(
    (
      activeChat: Chat,
      turnId: string,
      modelChoice: { providerId: string; model: string; thinkingLevel?: GenerationThinkingLevel },
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
          ...(modelChoice.thinkingLevel ? { thinkingLevel: modelChoice.thinkingLevel } : {}),
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
    if (isGenerating || sending || selectionSaving || error || !chat || queuedMessages.length === 0) return;
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
  }, [chat, error, isGenerating, queuedMessages, selectedModel, selectionSaving, sending, startTurnStream]);

  const handleSend = async () => {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    if (selectionSavingRef.current) return;
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
          // Insert optimistically so activeWorkspace resolves immediately without header pill flicker.
          qc.setQueryData<Workspace[]>(queryKeys.workspaces, (prev) => {
            if (!prev) return [scratch];
            return prev.some((ws) => ws.id === scratch.id) ? prev : [...prev, scratch];
          });
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
          ...(selectedModel.thinkingLevel ? { thinkingLevel: selectedModel.thinkingLevel } : {}),
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
          ...(selectedModel.thinkingLevel ? { thinkingLevel: selectedModel.thinkingLevel } : {}),
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
        // A pick made just before Send is saved on the chat first, so the turn
        // and the chat's stored model and effort agree.
        const pendingSelection = pendingSelectionRef.current;
        const choice = pendingSelection ? await pendingSelection : selectedModel;
        if (generationIntentRef.current !== sendIntent || chatRef.current?.id !== activeChatId) return;
        const turnId = createChatTurnId();
        const updated = await chatsApi.appendMessage(
          activeChatId,
          {
            role: "user",
            content,
            ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
          },
          {
            providerId: choice.providerId,
            model: choice.model,
            turnId,
          },
        );
        if (generationIntentRef.current !== sendIntent || chatRef.current?.id !== activeChatId) {
          return;
        }
        setChat(updated);
        startTurnStream(updated, turnId, choice);
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
      if (
        attachments.length === 0 &&
        Array.isArray(firstQueued?.attachments) &&
        firstQueued.attachments.length > 0
      ) {
        setAttachments(firstQueued.attachments as Attachment[]);
      }
    }
    generationRef.current?.cancel("user_stop");
  };

  const handleExpand = async () => {
    if (expanding) return;
    setExpanding(true);
    try {
      if (stage === "starter" || !chat) {
        let fallbackWorkspaceId: string;
        if (targetMode.kind === "workspace") {
          fallbackWorkspaceId = targetMode.workspaceId;
        } else {
          const existingHome = noWorkspaceHome(workspaces);
          if (existingHome) {
            fallbackWorkspaceId = existingHome.id;
          } else {
            const scratch = await workspacesApi.createNoWorkspace();
            fallbackWorkspaceId = scratch.id;
            void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
          }
        }
        const result = await quickChatApi.expandToMain({
          kind: "draft",
          workspaceId: fallbackWorkspaceId,
          text,
          attachments,
          ...(targetMode.kind === "ephemeral" ? { ephemeral: true } : {}),
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

  React.useEffect(() => {
    if (stage !== "starter") {
      popoverOpenGenRef.current += 1;
      starterPopoverActiveRef.current = false;
      clearPopoverShrinkTimer();
    }
    return () => {
      popoverOpenGenRef.current += 1;
      starterPopoverActiveRef.current = false;
      clearPopoverShrinkTimer();
    };
  }, [stage, clearPopoverShrinkTimer]);

  // Expand the floating window upward BEFORE Radix mounts the popover so the
  // viewport is already at full height on frame 1 (zero jump or flip).
  const prepareStarterPopoverOpen = React.useCallback(async (): Promise<boolean> => {
    const gen = ++popoverOpenGenRef.current;
    starterPopoverActiveRef.current = true;
    clearPopoverShrinkTimer();
    await quickChatApi.setMode("starter-popover").catch(() => undefined);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return popoverOpenGenRef.current === gen && stageRef.current === "starter";
  }, [clearPopoverShrinkTimer]);

  const handleStarterPopoverOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) {
        starterPopoverActiveRef.current = true;
        clearPopoverShrinkTimer();
        return;
      }
      clearPopoverShrinkTimer();
      popoverShrinkTimerRef.current = window.setTimeout(() => {
        popoverShrinkTimerRef.current = null;
        if (stageRef.current === "starter") {
          starterPopoverActiveRef.current = false;
          void quickChatApi.setMode("starter").catch(() => undefined);
        }
      }, 150);
    },
    [clearPopoverShrinkTimer],
  );

  // State 1: Compact floating starter bar anchored to the bottom of the stage
  // so opening popovers expands the window upward without shifting the bar.
  if (stage === "starter") {
    return (
      <div
        className="flex h-screen w-screen flex-col items-center justify-end bg-transparent px-14 pt-10 pb-[68px]"
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
            onModelChange={(providerId, model) => applySelection(providerId, model)}
            thinkingLevel={selectedModel.thinkingLevel}
            agentSlider={settings?.agentSlider}
            settingsLoaded={settings !== undefined}
            onSelectStop={selectAgentSliderStop}
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
            selectionSaving={selectionSaving}
            onSelectionSavingChange={setSelectionSaving}
            onSend={() => void handleSend()}
            onStop={handleStop}
            onExpand={() => void handleExpand()}
            onBeforePopoverOpen={prepareStarterPopoverOpen}
            onPopoverOpenChange={handleStarterPopoverOpenChange}
            popoverResetSeq={starterPopoverResetSeq}
            textareaRef={textareaRef}
          />
        </div>
      </div>
    );
  }

  // State 2: Floating Mini-Modal with one unified draggable header, live
  // transcript, approvals/questions, and docked composer.
  const currentApproval = approvals[0];
  const hasLifecycleMenu = Boolean(chat && (chat.ephemeral || isNoWorkspace(activeWorkspace)));

  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-end bg-transparent px-14 pt-10 pb-[68px]"
      data-testid="quick-chat-stage-modal"
    >
      <div
        className="qc-modal-card flex h-full w-full flex-col overflow-hidden rounded-sheet bg-background shadow-dialog"
        role="dialog"
        aria-label="Aiden Quick Chat"
        data-testid="quick-chat-mini-modal"
      >
        {/* Single unified draggable header bar */}
        <header className="qc-drag-region flex shrink-0 items-center justify-between gap-2 border-b border-separator/60 px-3 py-2.5">
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

          <div className="flex min-w-0 flex-1 items-center justify-center">
            {hasLifecycleMenu && chat ? (
              <div className="qc-no-drag">
                <DropdownMenu open={statusMenuOpen} onOpenChange={setStatusMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="transparent"
                      size="small"
                      className={cn(
                        "h-7 max-w-[190px] gap-1.5 px-2.5 text-xs font-medium",
                        chat.ephemeral
                          ? "bg-status-warning-surface text-status-warning hover:brightness-95 dark:hover:brightness-110"
                          : "bg-control/70 text-secondary hover:bg-control hover:text-primary",
                      )}
                      aria-label={
                        chat.ephemeral
                          ? "Temporary chat options"
                          : "Chats options"
                      }
                      title={chat.title || (chat.ephemeral ? "Temporary chat" : "Saved to Chats")}
                      data-testid="quick-chat-status-pill"
                    >
                      {chat.ephemeral ? (
                        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <MessageCircle className="size-3.5 shrink-0" aria-hidden="true" />
                      )}
                      <span className="min-w-0 truncate">
                        {chat.ephemeral ? "Temporary" : "Chats"}
                      </span>
                      <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="center"
                    sideOffset={8}
                    className="w-60"
                    data-testid="quick-chat-status-menu"
                  >
                    <div className="px-2.5 py-1.5">
                      <Text variant="small-strong" className="block truncate">
                        {chat.title || "Quick Chat"}
                      </Text>
                      <Text variant="small" color="tertiary" className="block text-mini">
                        {chat.ephemeral
                          ? "Hidden from sidebar until saved"
                          : "Saved in Chats · No workspace"}
                      </Text>
                    </div>
                    <DropdownMenuSeparator />
                    {chat.ephemeral ? (
                      <DropdownMenuItem
                        disabled={promoting || sending}
                        onSelect={() => void handlePromoteEphemeral()}
                        data-testid="quick-chat-save-btn"
                      >
                        <Bookmark className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>Save to Chats</span>
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      disabled={!canAttachWorkspace || sending}
                      onSelect={() => setAttachDialogOpen(true)}
                      data-testid="quick-chat-attach-workspace-btn"
                    >
                      <FolderPlus className="size-3.5 shrink-0" aria-hidden="true" />
                      <span>Attach to workspace…</span>
                    </DropdownMenuItem>
                    {chat.ephemeral ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          color="status-red"
                          onSelect={() => void handleDiscard()}
                          data-testid="quick-chat-discard-btn"
                        >
                          <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
                          <span>Discard temporary chat</span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : chat && !chat.ephemeral && activeWorkspace && !isNoWorkspace(activeWorkspace) ? (
              <span
                className="inline-flex max-w-full items-center gap-1.5 truncate text-xs font-medium text-secondary"
                title={chat.title || activeWorkspace.name}
                data-testid="quick-chat-attached-workspace"
              >
                <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{activeWorkspace.name}</span>
              </span>
            ) : (
              <Text variant="small-strong" className="max-w-full truncate text-center">
                {chat?.title || "Quick Chat"}
              </Text>
            )}
          </div>

          <div className="qc-no-drag flex items-center gap-1">
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

        {/* Transcript scroll area */}
        <ScrollArea
          className="min-h-0 flex-1 bg-transparent"
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
            onModelChange={(providerId, model) => applySelection(providerId, model)}
            thinkingLevel={selectedModel.thinkingLevel}
            agentSlider={settings?.agentSlider}
            settingsLoaded={settings !== undefined}
            onSelectStop={selectAgentSliderStop}
            hiddenModelsByProvider={settings?.hiddenModelsByProvider}
            workspaces={workspaces}
            targetMode={targetMode}
            isGenerating={isGenerating}
            sending={sending}
            selectionSaving={selectionSaving}
            onSelectionSavingChange={setSelectionSaving}
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
