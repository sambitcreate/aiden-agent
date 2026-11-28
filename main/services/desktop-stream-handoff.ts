// Authoritative in-flight desktop stream accumulator and one-shot handoff
// ticket store for transferring drafts and active runs across desktop windows
// without losing deltas (>32 KiB), desktop approval previews, or queued messages.

import { randomUUID } from "node:crypto";
import type { AskUserQuestionPromptV1 } from "../../renderer/shared/ask-user-question.js";
import {
  chatArtifactIdentity,
  parseChatArtifactEventV1,
  type ChatArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import {
  parseChatContextPressureNotification,
  type ChatContextPressureV1,
} from "../../renderer/shared/context-pressure.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import {
  parseSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "../../renderer/shared/subagent-runs.js";
import { parseTodoSnapshotView, type TodoSnapshotViewV1 } from "../../renderer/shared/todo.js";
import type {
  DesktopHandoffLiveStreamSnapshot,
  HandoffApprovalPrompt,
  HandoffQueuedMessage,
} from "../../renderer/shared/chat-handoff.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";

/** Generous desktop handoff cap (2 MiB per stream) — avoids Remote's 32 KiB checkpoint truncation. */
const MAX_ACCUMULATED_CHARS = 2 * 1024 * 1024;
const MAX_ACCUMULATED_STREAMS = 64;
const DEFAULT_TICKET_TTL_MS = 30_000;
const MAX_PENDING_TICKETS = 16;

interface StreamAccumulatorState {
  streamId: string;
  chatId: string;
  workspaceId: string;
  content: string;
  reasoning: string;
  timeline: GenerationTimeline | null;
  artifacts: ChatArtifactV1[];
  uiVisuals: ChatUiVisualV1[];
  subagents: SubagentRunSnapshot[];
  todoSnapshot: TodoSnapshotViewV1 | null;
  contextPressure: ChatContextPressureV1 | null;
}

function appendBounded(current: string, delta: string): string {
  if (!delta) return current;
  if (current.length >= MAX_ACCUMULATED_CHARS) return current;
  const remaining = MAX_ACCUMULATED_CHARS - current.length;
  return delta.length <= remaining ? current + delta : current + delta.slice(0, remaining);
}

function upsertArtifact(list: ChatArtifactV1[], next: ChatArtifactV1): ChatArtifactV1[] {
  const identity = chatArtifactIdentity(next);
  const idx = list.findIndex((item) => chatArtifactIdentity(item) === identity);
  if (idx < 0) return [...list, next];
  const copy = [...list];
  copy[idx] = next;
  return copy;
}

function upsertSubagent(
  list: SubagentRunSnapshot[],
  next: SubagentRunSnapshot,
): SubagentRunSnapshot[] {
  const idx = list.findIndex((item) => item.runId === next.runId);
  if (idx < 0) return [...list, next];
  const copy = [...list];
  copy[idx] = next;
  return copy;
}

function applyUiVisualEvent(list: ChatUiVisualV1[], event: unknown): ChatUiVisualV1[] {
  if (!event || typeof event !== "object" || Array.isArray(event)) return list;
  const record = event as Record<string, unknown>;
  if (record.kind === "ui-visual-upsert" && record.visual && typeof record.visual === "object") {
    const visual = record.visual as ChatUiVisualV1;
    if (typeof visual.id !== "string") return list;
    const idx = list.findIndex((item) => item.id === visual.id);
    if (idx < 0) return [...list, visual];
    const copy = [...list];
    copy[idx] = visual;
    return copy;
  }
  return list;
}

/**
 * Synchronously tracks full desktop stream state per active `streamId` before
 * `deltaCoalescer` batches deltas, so transferring ownership to another desktop
 * window produces a complete, lossless snapshot.
 */
export class DesktopLiveStreamAccumulator {
  private readonly streams = new Map<string, StreamAccumulatorState>();

  begin(streamId: string, chatId: string, workspaceId = "default"): void {
    while (this.streams.size >= MAX_ACCUMULATED_STREAMS) {
      const oldest = this.streams.keys().next().value;
      if (oldest === undefined) break;
      this.streams.delete(oldest);
    }
    this.streams.set(streamId, {
      streamId,
      chatId,
      workspaceId,
      content: "",
      reasoning: "",
      timeline: null,
      artifacts: [],
      uiVisuals: [],
      subagents: [],
      todoSnapshot: null,
      contextPressure: null,
    });
  }

  setWorkspaceId(streamId: string, workspaceId: string): void {
    const state = this.streams.get(streamId);
    if (state) state.workspaceId = workspaceId;
  }

  record(
    streamId: string,
    chatId: string | undefined,
    channel: NotificationChannel,
    payload: unknown,
    workspaceId?: string,
  ): void {
    let state = this.streams.get(streamId);
    if (!state) {
      if (!chatId) return;
      this.begin(streamId, chatId, workspaceId);
      state = this.streams.get(streamId)!;
    } else if (workspaceId && state.workspaceId !== workspaceId) {
      state.workspaceId = workspaceId;
    }
    if (!payload || typeof payload !== "object") return;
    const data = payload as Record<string, unknown>;

    switch (channel) {
      case "chat:delta": {
        if (data.reset === true) {
          state.content = "";
          state.reasoning = "";
        }
        if (typeof data.delta === "string") {
          state.content = appendBounded(state.content, data.delta);
        }
        break;
      }
      case "chat:reasoning-delta": {
        if (typeof data.delta === "string") {
          state.reasoning = appendBounded(state.reasoning, data.delta);
        }
        break;
      }
      case "chat:timeline": {
        if (data.timeline && typeof data.timeline === "object") {
          state.timeline = structuredClone(data.timeline as GenerationTimeline);
        }
        break;
      }
      case "chat:artifact": {
        const parsed = parseChatArtifactEventV1(data.event);
        if (parsed) {
          if (parsed.operation === "present") {
            state.artifacts = upsertArtifact(state.artifacts, parsed.artifact);
          } else if (parsed.operation === "reset") {
            state.artifacts = [];
            state.uiVisuals = [];
          } else if (parsed.operation === "ui") {
            const visual = parsed.visual;
            const idx = state.uiVisuals.findIndex((item) => item.id === visual.id);
            state.uiVisuals =
              idx < 0
                ? [...state.uiVisuals, visual]
                : state.uiVisuals.map((item, i) => (i === idx ? visual : item));
          }
        } else {
          state.uiVisuals = applyUiVisualEvent(state.uiVisuals, data.event);
        }
        break;
      }
      case "chat:subagents": {
        const snap = parseSubagentRunSnapshot(data.snapshot);
        if (snap) state.subagents = upsertSubagent(state.subagents, snap);
        break;
      }
      case "chat:todo": {
        const todo = parseTodoSnapshotView(data.snapshot);
        if (todo) state.todoSnapshot = todo;
        break;
      }
      case "chat:context-pressure": {
        const notification = parseChatContextPressureNotification(data);
        if (notification) state.contextPressure = notification.pressure;
        break;
      }
      default:
        break;
    }
  }

  snapshot(
    streamId: string,
    pendingApprovals: readonly HandoffApprovalPrompt[],
    pendingQuestions: readonly AskUserQuestionPromptV1[],
    workspaceIdOverride?: string,
  ): DesktopHandoffLiveStreamSnapshot | null {
    const state = this.streams.get(streamId);
    if (!state) return null;
    return {
      streamId: state.streamId,
      chatId: state.chatId,
      workspaceId: workspaceIdOverride ?? state.workspaceId,
      content: state.content,
      reasoning: state.reasoning,
      timeline: state.timeline ? structuredClone(state.timeline) : null,
      artifacts: structuredClone(state.artifacts),
      uiVisuals: structuredClone(state.uiVisuals),
      subagents: structuredClone(state.subagents),
      todoSnapshot: state.todoSnapshot ? structuredClone(state.todoSnapshot) : null,
      contextPressure: state.contextPressure ? structuredClone(state.contextPressure) : null,
      pendingApprovals: structuredClone([...pendingApprovals]),
      pendingQuestions: structuredClone([...pendingQuestions]),
    };
  }

  delete(streamId: string): void {
    this.streams.delete(streamId);
  }

  clear(): void {
    this.streams.clear();
  }
}

export interface PendingDraftHandoffTicket {
  kind: "draft";
  ticketId: string;
  workspaceId: string;
  text: string;
  attachments: unknown[];
  providerId?: string;
  model?: string;
  ephemeral?: boolean;
  createdAt: number;
  onClaimed?: () => void;
}

export interface PendingChatHandoffTicket {
  kind: "chat";
  chatId: string;
  fromDocumentId: string;
  draftText?: string;
  draftAttachments?: unknown[];
  queuedMessages?: HandoffQueuedMessage[];
  createdAt: number;
  onClaimed?: () => void;
}

/**
 * One-shot short-lived ticket registry used when the floating window expands
 * a draft or active chat into the main window (avoiding packaged `file://`
 * `localStorage` partitions and race windows during window creation/navigation).
 */
interface DeferredDetachEntry {
  timer: ReturnType<typeof setTimeout>;
  onExpire: () => void;
}

export class DesktopHandoffTicketStore {
  private readonly drafts = new Map<string, PendingDraftHandoffTicket>();
  private readonly chats = new Map<string, PendingChatHandoffTicket>();
  private readonly deferredDetaches = new Map<string, DeferredDetachEntry[]>();

  constructor(
    private readonly options: {
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  }

  private cancelDeferredDetaches(chatId: string): void {
    const entries = this.deferredDetaches.get(chatId);
    if (!entries) return;
    this.deferredDetaches.delete(chatId);
    for (const entry of entries) clearTimeout(entry.timer);
  }

  private expireChatTicket(chatId: string): void {
    this.chats.delete(chatId);
    const entries = this.deferredDetaches.get(chatId);
    if (!entries) return;
    this.deferredDetaches.delete(chatId);
    for (const entry of entries) {
      clearTimeout(entry.timer);
      try {
        entry.onExpire();
      } catch {
        // Detach callbacks are best-effort cleanup.
      }
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs();
    for (const [id, ticket] of this.drafts) {
      if (ticket.createdAt <= cutoff) this.drafts.delete(id);
    }
    for (const [chatId, ticket] of this.chats) {
      if (ticket.createdAt <= cutoff) this.expireChatTicket(chatId);
    }
  }

  putDraft(input: Omit<PendingDraftHandoffTicket, "kind" | "ticketId" | "createdAt">): string {
    this.prune();
    while (this.drafts.size >= MAX_PENDING_TICKETS) {
      const oldest = this.drafts.keys().next().value;
      if (oldest === undefined) break;
      this.drafts.delete(oldest);
    }
    const ticketId = randomUUID();
    this.drafts.set(ticketId, {
      ...input,
      kind: "draft",
      ticketId,
      createdAt: this.now(),
    });
    return ticketId;
  }

  claimDraft(ticketId: string): PendingDraftHandoffTicket | null {
    this.prune();
    const ticket = this.drafts.get(ticketId);
    if (!ticket) return null;
    this.drafts.delete(ticketId);
    return ticket;
  }

  putChat(input: Omit<PendingChatHandoffTicket, "kind" | "createdAt">): void {
    this.prune();
    if (this.chats.has(input.chatId)) {
      this.expireChatTicket(input.chatId);
    }
    while (this.chats.size >= MAX_PENDING_TICKETS) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.expireChatTicket(oldest);
    }
    this.chats.set(input.chatId, {
      ...input,
      kind: "chat",
      createdAt: this.now(),
    });
  }

  /**
   * Hold off detaching the source window while a handoff ticket for this chat
   * is actively in flight so a fast hide/close cannot prematurely abort ownership
   * transfer. If the ticket expires unclaimed, `onExpire` runs to finish detaching.
   */
  deferDetachIfPending(chatId: string, fromDocumentId: string, onExpire: () => void): boolean {
    this.prune();
    const ticket = this.chats.get(chatId);
    if (!ticket || ticket.fromDocumentId !== fromDocumentId) return false;
    const remainingMs = Math.max(1, ticket.createdAt + this.ttlMs() - this.now());
    const timer = setTimeout(() => {
      this.expireChatTicket(chatId);
    }, remainingMs);
    timer.unref?.();
    const list = this.deferredDetaches.get(chatId) ?? [];
    list.push({ timer, onExpire });
    this.deferredDetaches.set(chatId, list);
    return true;
  }

  claimChat(chatId: string): PendingChatHandoffTicket | null {
    this.prune();
    const ticket = this.chats.get(chatId);
    if (!ticket) return null;
    this.chats.delete(chatId);
    this.cancelDeferredDetaches(chatId);
    return ticket;
  }

  /**
   * Abandon a failed chat handoff: remove any unclaimed ticket and immediately
   * run any deferred detach callbacks so approvals/questionnaires on a source
   * window that already detached are released right away instead of hanging.
   */
  abandonChat(chatId: string): boolean {
    const existed = this.chats.has(chatId) || this.deferredDetaches.has(chatId);
    this.expireChatTicket(chatId);
    return existed;
  }

  clear(): void {
    for (const chatId of [...this.deferredDetaches.keys()]) {
      this.cancelDeferredDetaches(chatId);
    }
    this.drafts.clear();
    this.chats.clear();
  }
}
