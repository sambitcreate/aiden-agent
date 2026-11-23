// Owner-filtered notifications for one generation stream. ChatPane's
// startGeneration subscribes here before invoking main, so no opening tokens
// are dropped.
import { parseAgentsInstructionNotices } from "../shared/agents-instructions-notice";
import { parseAskUserQuestionPrompt, type AskUserQuestionPromptV1 } from "../shared/ask-user-question";
import { chatArtifactIdentity, parseChatArtifactEventV1, type ChatArtifactV1 } from "../shared/chat-artifacts";
import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import { reduceUiVisuals } from "./ui-visual-transcript";
import { parseChatContextPressureNotification } from "../shared/context-pressure";
import { parseModelCallRetryView } from "../shared/model-call-retry";
import type { ChatTimelineNotification, GenerationTimeline } from "../shared/generation-timeline";
import { parseSubagentRunSnapshot, type SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  foldLiveSubagentTranscript,
  parseSubagentTranscriptNotification,
  type LiveSubagentTranscripts,
} from "../shared/subagent-transcript";
import { parseToolApprovalScope } from "../shared/tool-approval-scope";
import { parseToolApprovalPreview } from "../shared/tool-approval-preview";
import { parseTodoSnapshotView } from "../shared/todo";
import { restoreUndeliveredGuidance, undeliveredGuidanceFromTerminal } from "./composer-draft-store";
import type { ApprovalPrompt, ChatStatusPhase, StreamCallbacks, ToolPhase } from "./ipc";
import { onNotification } from "./ipc-bridge";
import { mergeSubagentSnapshots } from "./subagent-view-state";
import type { Chat } from "./types";

interface ChatDelta {
  streamId: string;
  delta: string;
  /** Discard deltas from a failed overflow attempt before its retry starts. */
  reset?: boolean;
}
interface ChatReasoningDelta {
  streamId: string;
  delta: string;
}
interface ChatArtifactNotification {
  streamId: string;
  event: unknown;
}
interface ChatStatus {
  streamId: string;
  phase: ChatStatusPhase | "agents_instructions_limited" | "retrying" | "hook_messages";
  notices?: unknown;
  retry?: unknown;
  messages?: unknown;
}

/** At most this many hook messages per notification, each at most this long. */
const MAX_HOOK_MESSAGES = 8;
const MAX_HOOK_MESSAGE_CHARS = 500;

function parseHookMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is string => typeof message === "string" && message.trim().length > 0)
    .slice(0, MAX_HOOK_MESSAGES)
    .map((message) =>
      message.length > MAX_HOOK_MESSAGE_CHARS ? `${message.slice(0, MAX_HOOK_MESSAGE_CHARS - 1)}…` : message,
    );
}
interface ChatDone {
  streamId: string;
  content: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
  undeliveredGuidance?: string[];
}
interface ChatError {
  streamId: string;
  message: string;
  content?: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
  undeliveredGuidance?: string[];
}
interface ChatTool {
  streamId: string;
  phase: ToolPhase;
  toolName: string;
}
interface ChatApproval extends ApprovalPrompt {
  streamId: string;
}
type ChatQuestionnaire = AskUserQuestionPromptV1;
interface ChatSubagents {
  streamId: string;
  snapshot: unknown;
}
interface ChatTodo {
  streamId: string;
  snapshot: unknown;
}

export interface GenerationStreamScope {
  chatId: string;
  workspaceId?: string;
}

export interface GenerationStreamProjection {
  content: string;
  lastTextDeltaAt: number | null;
  reasoning: string;
  timeline: GenerationTimeline | null;
  artifacts: ChatArtifactV1[];
  /** Native (render_ui) visuals presented so far. */
  uiVisuals?: ChatUiVisualV1[];
  subagents: SubagentRunSnapshot[];
  /** Live helper conversation updates folded so far, by run id. */
  subagentTranscripts?: LiveSubagentTranscripts;
}

export interface GenerationStreamSubscription {
  dispose(): void;
  projection(): GenerationStreamProjection;
  /** Synchronously replay pre-subscribe notifications captured before attach. */
  replay(bufferedNotifications: readonly BufferedGenerationNotification[]): void;
  /** True once a terminal `chat:done` or `chat:error` event has been processed. */
  settled(): boolean;
}

export type GenerationStreamChannel =
  | "chat:delta"
  | "chat:reasoning-delta"
  | "chat:status"
  | "chat:context-pressure"
  | "chat:done"
  | "chat:error"
  | "chat:timeline"
  | "chat:artifact"
  | "chat:subagents"
  | "chat:subagent-transcript"
  | "chat:tool"
  | "chat:approval"
  | "chat:questionnaire"
  | "chat:todo";

export interface BufferedGenerationNotification {
  channel: GenerationStreamChannel;
  payload: unknown;
}

export interface GenerationStreamBuffer {
  /** Stop capturing and return all buffered notifications in arrival order. */
  drain(): BufferedGenerationNotification[];
  /** Stop capturing and discard buffered notifications. */
  dispose(): void;
}

const MAX_BUFFERED_HANDOFF_NOTIFICATIONS = 2048;

/**
 * Capture incoming `chat:*` IPC notifications before invoking `chat:claimHandoff`
 * so events emitted by main right after `transferGenerationOwner` are never
 * dropped in the async IPC gap before `attachGenerationStream` subscribes.
 */
export function createGenerationStreamBuffer(): GenerationStreamBuffer {
  const buffered: BufferedGenerationNotification[] = [];
  let active = true;
  const capture = (channel: GenerationStreamChannel) => (payload: unknown) => {
    if (!active) return;
    if (buffered.length < MAX_BUFFERED_HANDOFF_NOTIFICATIONS) {
      buffered.push({ channel, payload });
    }
  };
  const unsubs = [
    onNotification<unknown>("chat:delta", capture("chat:delta")),
    onNotification<unknown>("chat:reasoning-delta", capture("chat:reasoning-delta")),
    onNotification<unknown>("chat:status", capture("chat:status")),
    onNotification<unknown>("chat:context-pressure", capture("chat:context-pressure")),
    onNotification<unknown>("chat:done", capture("chat:done")),
    onNotification<unknown>("chat:error", capture("chat:error")),
    onNotification<unknown>("chat:timeline", capture("chat:timeline")),
    onNotification<unknown>("chat:artifact", capture("chat:artifact")),
    onNotification<unknown>("chat:subagents", capture("chat:subagents")),
    onNotification<unknown>("chat:subagent-transcript", capture("chat:subagent-transcript")),
    onNotification<unknown>("chat:tool", capture("chat:tool")),
    onNotification<unknown>("chat:approval", capture("chat:approval")),
    onNotification<unknown>("chat:questionnaire", capture("chat:questionnaire")),
    onNotification<unknown>("chat:todo", capture("chat:todo")),
  ];
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const u of unsubs) u();
    unsubs.length = 0;
  };
  return {
    drain: () => {
      dispose();
      return buffered.splice(0, buffered.length);
    },
    dispose: () => {
      dispose();
      buffered.length = 0;
    },
  };
}

export function subscribeGenerationStream(
  streamId: string,
  scope: GenerationStreamScope,
  callbacks: StreamCallbacks,
  initialProjection?: Partial<GenerationStreamProjection>,
  bufferedNotifications?: readonly BufferedGenerationNotification[],
): GenerationStreamSubscription {
  let projectedContent = initialProjection?.content ?? "";
  let projectedLastTextDeltaAt: number | null = initialProjection?.lastTextDeltaAt ?? null;
  let projectedReasoning = initialProjection?.reasoning ?? "";
  let projectedTimeline: GenerationTimeline | null = initialProjection?.timeline ?? null;
  let projectedArtifacts: ChatArtifactV1[] = initialProjection?.artifacts ? [...initialProjection.artifacts] : [];
  let projectedUiVisuals: ChatUiVisualV1[] = initialProjection?.uiVisuals ? [...initialProjection.uiVisuals] : [];
  let projectedSubagents: SubagentRunSnapshot[] = initialProjection?.subagents ? [...initialProjection.subagents] : [];
  // Folding never mutates a map, so the handed-over one can seed this as is.
  let projectedSubagentTranscripts: LiveSubagentTranscripts | undefined = initialProjection?.subagentTranscripts;
  const unsubs: Array<() => void> = [];
  const handlers = new Map<GenerationStreamChannel, (payload: unknown) => void>();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const u of unsubs) u();
    unsubs.length = 0;
  };
  const register = <T,>(
    channel: GenerationStreamChannel,
    handler: (payload: T) => void,
    unsubscribe: () => void,
  ) => {
    handlers.set(channel, handler as (payload: unknown) => void);
    unsubs.push(unsubscribe);
  };
  // Listeners stay on while an async onDone settles, so the first terminal event
  // has to close the door itself: a second one would restore guidance twice.
  let terminalSeen = false;

  const onDelta = (p: ChatDelta) => {
    if (p.streamId !== streamId) return;
    if (p.reset) {
      projectedContent = "";
      projectedLastTextDeltaAt = null;
      projectedReasoning = "";
      callbacks.onReset?.();
    } else {
      projectedContent += p.delta;
      if (p.delta) projectedLastTextDeltaAt = Date.now();
      callbacks.onDelta(p.delta);
    }
  };
  register("chat:delta", onDelta, onNotification<ChatDelta>("chat:delta", onDelta));

  const onReasoningDelta = (p: ChatReasoningDelta) => {
    if (p.streamId === streamId) {
      projectedReasoning += p.delta;
      callbacks.onReasoningDelta?.(p.delta);
    }
  };
  register(
    "chat:reasoning-delta",
    onReasoningDelta,
    onNotification<ChatReasoningDelta>("chat:reasoning-delta", onReasoningDelta),
  );

  const onStatus = (p: ChatStatus) => {
    if (p.streamId !== streamId) return;
    if (p.phase === "agents_instructions_limited") {
      const notices = parseAgentsInstructionNotices(p.notices);
      if (notices) callbacks.onAgentsInstructionNotices?.(notices);
    } else if (p.phase === "hook_messages") {
      const messages = parseHookMessages(p.messages);
      if (messages.length > 0) callbacks.onHookMessages?.(messages);
    } else if (p.phase === "retrying") {
      const retry = parseModelCallRetryView(p.retry);
      if (retry) callbacks.onRetrying?.(retry);
    } else {
      callbacks.onStatus?.(p.phase);
    }
  };
  register("chat:status", onStatus, onNotification<ChatStatus>("chat:status", onStatus));

  const onContextPressure = (p: unknown) => {
    const event = parseChatContextPressureNotification(p);
    if (event && event.streamId === streamId) {
      callbacks.onContextPressure?.(event.pressure);
    }
  };
  register(
    "chat:context-pressure",
    onContextPressure,
    onNotification<unknown>("chat:context-pressure", onContextPressure),
  );

  const onDone = (p: ChatDone) => {
    if (p.streamId !== streamId || terminalSeen) return;
    terminalSeen = true;
    restoreUndeliveredGuidance(scope.chatId, undeliveredGuidanceFromTerminal(p));
    void new Promise((resolve) => {
      resolve(callbacks.onDone(p.content, p.timeline, p.chat, p.reasoning));
    })
      .catch((error: unknown) =>
        callbacks.onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(dispose);
  };
  register("chat:done", onDone, onNotification<ChatDone>("chat:done", onDone));

  const onError = (p: ChatError) => {
    if (p.streamId !== streamId || terminalSeen) return;
    terminalSeen = true;
    restoreUndeliveredGuidance(scope.chatId, undeliveredGuidanceFromTerminal(p));
    try {
      callbacks.onError(p.message, p.content, p.timeline, p.chat, p.reasoning);
    } finally {
      dispose();
    }
  };
  register("chat:error", onError, onNotification<ChatError>("chat:error", onError));

  const onTimeline = (p: ChatTimelineNotification) => {
    if (p.streamId === streamId) {
      projectedTimeline = p.timeline;
      callbacks.onTimeline?.(p.timeline);
    }
  };
  register(
    "chat:timeline",
    onTimeline,
    onNotification<ChatTimelineNotification>("chat:timeline", onTimeline),
  );

  if (callbacks.onArtifactEvent) {
    const onArtifact = (p: ChatArtifactNotification) => {
      if (p.streamId !== streamId) return;
      const event = parseChatArtifactEventV1(p.event);
      if (!event) return;
      if (event.operation === "reset") {
        projectedArtifacts = [];
        projectedUiVisuals = [];
      } else if (event.operation === "ui") {
        projectedUiVisuals = [...reduceUiVisuals(projectedUiVisuals, event)];
      } else if (event.operation === "present") {
        const identity = chatArtifactIdentity(event.artifact);
        const index = projectedArtifacts.findIndex(
          (candidate) => chatArtifactIdentity(candidate) === identity,
        );
        projectedArtifacts =
          index >= 0
            ? projectedArtifacts.map((candidate, i) => (i === index ? event.artifact : candidate))
            : [...projectedArtifacts, event.artifact];
      }
      callbacks.onArtifactEvent?.(event);
    };
    register("chat:artifact", onArtifact, onNotification<ChatArtifactNotification>("chat:artifact", onArtifact));
  }
  if (callbacks.onSubagents) {
    const onSubagents = (p: ChatSubagents) => {
      if (p.streamId !== streamId) return;
      const snapshot = parseSubagentRunSnapshot(p.snapshot);
      if (snapshot?.generationId === streamId) {
        projectedSubagents = mergeSubagentSnapshots(projectedSubagents, [snapshot], {
          chatId: scope.chatId,
          workspaceId: scope.workspaceId ?? "default",
        });
        callbacks.onSubagents?.(snapshot);
      }
    };
    register("chat:subagents", onSubagents, onNotification<ChatSubagents>("chat:subagents", onSubagents));
  }
  // Folded whenever helpers are shown, so a detached run hands them over.
  if (callbacks.onSubagents || callbacks.onSubagentTranscript) {
    const onSubagentTranscript = (payload: unknown) => {
      const notification = parseSubagentTranscriptNotification(payload);
      if (!notification || notification.streamId !== streamId) return;
      projectedSubagentTranscripts = foldLiveSubagentTranscript(
        projectedSubagentTranscripts,
        notification.update,
      );
      callbacks.onSubagentTranscript?.(notification.update);
    };
    register(
      "chat:subagent-transcript",
      onSubagentTranscript,
      onNotification<unknown>("chat:subagent-transcript", onSubagentTranscript),
    );
  }
  const onTool = (p: ChatTool) => {
    if (p.streamId === streamId) callbacks.onTool?.(p.phase, p.toolName);
  };
  register("chat:tool", onTool, onNotification<ChatTool>("chat:tool", onTool));

  const onApproval = (p: ChatApproval) => {
    if (p.streamId === streamId)
      callbacks.onApproval?.({
        approvalId: p.approvalId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        summary: p.summary,
        details: p.details,
        ...(() => {
          const preview = parseToolApprovalPreview(p.preview);
          return preview ? { preview } : {};
        })(),
        // Offered allow scopes ("this chat", "always"); absent means once only.
        ...(Array.isArray(p.scopes) ? { scopes: p.scopes.filter((entry) => parseToolApprovalScope(entry)) } : {}),
        ...(typeof p.canAllow === "boolean" ? { canAllow: p.canAllow } : {}),
      });
  };
  register("chat:approval", onApproval, onNotification<ChatApproval>("chat:approval", onApproval));

  const onQuestionnaire = (payload: ChatQuestionnaire) => {
    if (payload.streamId !== streamId) return;
    const prompt = parseAskUserQuestionPrompt(payload);
    if (prompt) callbacks.onQuestionnaire?.(prompt);
  };
  register(
    "chat:questionnaire",
    onQuestionnaire,
    onNotification<ChatQuestionnaire>("chat:questionnaire", onQuestionnaire),
  );

  if (callbacks.onTodo) {
    const onTodo = (payload: ChatTodo) => {
      if (payload.streamId !== streamId) return;
      const snapshot = parseTodoSnapshotView(payload.snapshot);
      if (snapshot?.chatId === scope.chatId) callbacks.onTodo?.(snapshot);
    };
    register("chat:todo", onTodo, onNotification<ChatTodo>("chat:todo", onTodo));
  }

  const replay = (items: readonly BufferedGenerationNotification[]) => {
    for (const item of items) {
      if (disposed || terminalSeen) break;
      handlers.get(item.channel)?.(item.payload);
    }
  };

  if (bufferedNotifications && bufferedNotifications.length > 0) {
    replay(bufferedNotifications);
  }

  return {
    dispose,
    replay,
    settled: () => terminalSeen,
    projection: () => ({
      content: projectedContent,
      lastTextDeltaAt: projectedLastTextDeltaAt,
      reasoning: projectedReasoning,
      timeline: projectedTimeline,
      artifacts: projectedArtifacts,
      uiVisuals: projectedUiVisuals,
      subagents: projectedSubagents,
      ...(projectedSubagentTranscripts ? { subagentTranscripts: projectedSubagentTranscripts } : {}),
    }),
  };
}
