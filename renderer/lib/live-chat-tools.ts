// Window-side handlers for Aiden Live's chat tools. Main validates Gemini's
// arguments and forwards each call here through the Live session bus; these
// handlers check them again, use the open chat's controller for read, send and
// stop, and the app shell's navigation for find and start. Chat text comes back
// only in `untrusted_chat_content`, a send or Stop needs fresh speech from the
// person (LiveChatRequestGate), and none of them can answer a tool approval.

import {
  LIVE_CHAT_ERRORS,
  LIVE_CHAT_MAX_QUERY_CHARS,
  LIVE_CHAT_MAX_READ_MESSAGES,
  LIVE_CHAT_MAX_SEND_CHARS,
  LIVE_CHAT_MAX_WORKSPACE_CHARS,
  LIVE_CHAT_SEND_MODES,
  findLiveChat,
  findLiveWorkspace,
  liveChatFailure,
  redactLiveChatSecrets,
  type LiveChatCandidate,
  type LiveChatSendMode,
  type LiveChatToolName,
} from "../shared/live-chat-tools";
import { isUserVisibleChat, type ChatSurfaceInput } from "../shared/chat-visibility";
import type { LiveChatController } from "./live-chat-control";
import type { LiveRendererToolContext, LiveRendererToolHandler, LiveRendererToolResult } from "./live-session-bus";

/**
 * Whether the person has spoken since Live last saw chat content. Text in a
 * chat (or a chat title, or a note about a chat) is data that could ask Live
 * to send something; only fresh speech from the person authorizes a send,
 * steer, queue, Stop or a new chat with a message.
 */
export class LiveChatRequestGate {
  private seenAt: number;

  constructor(private readonly latestVoiceInputId: () => number) {
    this.seenAt = latestVoiceInputId();
  }

  /** Live just received chat content: a read_open_chat result or a note. */
  exposed(): void {
    this.seenAt = this.latestVoiceInputId();
  }

  /** A new session starts: speech from before it does not count. */
  reset(): void {
    this.seenAt = this.latestVoiceInputId();
  }

  /** The person said something after the latest chat content Live saw. */
  allows(): boolean {
    return this.latestVoiceInputId() > this.seenAt;
  }
}

export interface LiveChatToolDeps {
  /** "Let Live use the open chat" is on. */
  enabled(): boolean;
  /** The open chat's controller, or null when no regular chat is on screen. */
  controller(): LiveChatController | null;
  waitForController(
    predicate: (controller: LiveChatController) => boolean,
    signal: AbortSignal,
  ): Promise<LiveChatController | null>;
  /** Regular chats the person can open (see liveChatCandidates). */
  listChats(): Promise<LiveChatCandidate[]>;
  /** Opens a chat in the main window; false when navigation is blocked. */
  openChat(chatId: string): Promise<boolean>;
  listWorkspaces(): Promise<Array<{ id: string; name: string }>>;
  /** The workspace the person is in now. */
  currentWorkspaceId(): string | null;
  /** Opens (or reuses) an empty draft there; its chat id, or null when nothing opened. */
  openNewChatIn(workspaceId: string): Promise<string | null>;
  /** Fresh speech since Live last saw chat content. */
  requests: LiveChatRequestGate;
  /** Called on every chat tool use; shows the one-time notice the first time. */
  used(): void;
  /** Live sent to this chat: its finished, failed and approval moments become notes. */
  watch(chatId: string, title: string): void;
}

/** Chats Live may find and open: only ordinary user chats, never Bot, Assistant or feature chats. */
export function liveChatCandidates(
  chats: ReadonlyArray<ChatSurfaceInput & { id: string; title: string; updatedAt: number }>,
): LiveChatCandidate[] {
  return chats
    .filter((chat) => isUserVisibleChat(chat))
    .map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt }));
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function isSendMode(value: unknown): value is LiveChatSendMode {
  return typeof value === "string" && (LIVE_CHAT_SEND_MODES as readonly string[]).includes(value);
}

const cancelled = (): LiveRendererToolResult => liveChatFailure(LIVE_CHAT_ERRORS.cancelled);

/**
 * Moves chat-derived text (titles, workspace names) into
 * `untrusted_chat_content`, the one field Live is told is data, never
 * instructions.
 */
function withUntrustedTitle(result: LiveRendererToolResult): LiveRendererToolResult {
  if (typeof result.title !== "string") return result;
  const { title, ...rest } = result;
  return { ...rest, untrusted_chat_content: { title: redactLiveChatSecrets(title) } };
}

export function createLiveChatToolHandlers(
  deps: LiveChatToolDeps,
): Record<LiveChatToolName, LiveRendererToolHandler> {
  // One chat tool at a time per window, so two calls never race on one chat.
  let tail: Promise<unknown> = Promise.resolve();

  /** Every handler: switch first, then the one-time notice, then the tool, in turn. */
  const guarded =
    (run: (args: Record<string, unknown>, context: LiveRendererToolContext) => Promise<LiveRendererToolResult> | LiveRendererToolResult): LiveRendererToolHandler =>
    (args, context) => {
      const next = tail.then(async () => {
        if (!deps.enabled()) return liveChatFailure(LIVE_CHAT_ERRORS.off);
        if (context.signal.aborted) return cancelled();
        deps.used();
        return run(args ?? {}, context);
      });
      tail = next.catch(() => undefined);
      return next;
    };

  /** Checks the cancel and hands the action over; after this the outcome is always reported. */
  const commit = (context: LiveRendererToolContext): boolean => {
    if (context.signal.aborted) return false;
    context.commit();
    return true;
  };

  const sendThrough = async (
    controller: LiveChatController,
    text: string,
    mode: LiveChatSendMode,
  ): Promise<LiveRendererToolResult> => {
    const before = controller.read(1).title;
    const result = await controller.send(text, mode);
    if (result.ok === true) deps.watch(controller.chatId, controller.read(1).title || before);
    return withUntrustedTitle(result);
  };

  return {
    read_open_chat: guarded((args) => {
      const controller = deps.controller();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.noChat);
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(LIVE_CHAT_MAX_READ_MESSAGES, Math.max(1, Math.floor(args.limit)))
          : undefined;
      const snapshot = controller.read(limit);
      // From here on, a send needs the person to speak again.
      deps.requests.exposed();
      return {
        ok: true,
        chat: {
          busy: snapshot.busy,
          ...(snapshot.waitingForApproval ? { waitingForApproval: true } : {}),
        },
        untrusted_chat_content: { title: redactLiveChatSecrets(snapshot.title), messages: snapshot.messages },
        ...(snapshot.truncated ? { olderMessagesLeftOut: true } : {}),
      };
    }),

    send_to_open_chat: guarded(async (args, context) => {
      const text = boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
      const mode = args.mode === undefined ? "auto" : args.mode;
      if (!text || !isSendMode(mode)) return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      const controller = deps.controller();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.noChat);
      if (!deps.requests.allows()) return liveChatFailure(LIVE_CHAT_ERRORS.needsUserRequest);
      if (!commit(context)) return cancelled();
      return sendThrough(controller, text, mode);
    }),

    stop_open_chat: guarded((_args, context) => {
      const controller = deps.controller();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.noChat);
      if (!deps.requests.allows()) return liveChatFailure(LIVE_CHAT_ERRORS.needsUserRequest);
      if (!commit(context)) return cancelled();
      return withUntrustedTitle(controller.stop());
    }),

    find_and_open_chat: guarded(async (args, context) => {
      const query = boundedText(args.query, LIVE_CHAT_MAX_QUERY_CHARS);
      if (!query) return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      const found = findLiveChat(await deps.listChats(), query);
      if (context.signal.aborted) return cancelled();
      if (found.kind === "none") return liveChatFailure(LIVE_CHAT_ERRORS.notFound);
      if (found.kind === "ambiguous") {
        return { ok: true, opened: false, untrusted_chat_content: { closeMatches: found.titles.map(redactLiveChatSecrets) } };
      }
      const title = { untrusted_chat_content: { title: redactLiveChatSecrets(found.chat.title) } };
      if (deps.controller()?.chatId === found.chat.id) {
        return { ok: true, opened: true, alreadyOpen: true, ...title };
      }
      if (!commit(context)) return cancelled();
      if (!(await deps.openChat(found.chat.id))) return liveChatFailure(LIVE_CHAT_ERRORS.navigationBlocked);
      return { ok: true, opened: true, ...title };
    }),

    start_new_chat: guarded(async (args, context) => {
      const workspaceName =
        args.workspace === undefined ? null : boundedText(args.workspace, LIVE_CHAT_MAX_WORKSPACE_CHARS);
      const text = args.text === undefined ? null : boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
      if ((args.workspace !== undefined && !workspaceName) || (args.text !== undefined && !text)) {
        return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      }
      if (text && !deps.requests.allows()) return liveChatFailure(LIVE_CHAT_ERRORS.needsUserRequest);
      const workspaces = await deps.listWorkspaces();
      const workspace = workspaceName
        ? findLiveWorkspace(workspaces, workspaceName)
        : (workspaces.find((entry) => entry.id === deps.currentWorkspaceId()) ?? null);
      if (!workspace) return liveChatFailure(LIVE_CHAT_ERRORS.workspaceNotFound);
      if (!commit(context)) return cancelled();
      const workspaceLabel = redactLiveChatSecrets(workspace.name);
      const started = { ok: true, started: true, untrusted_chat_content: { workspace: workspaceLabel } };
      let draftId: string | null;
      try {
        draftId = await deps.openNewChatIn(workspace.id);
      } catch {
        return liveChatFailure(LIVE_CHAT_ERRORS.newChatFailed);
      }
      if (!draftId) return liveChatFailure(LIVE_CHAT_ERRORS.navigationBlocked);
      // The chat opened; a cancel now only skips the message.
      const controller = await deps.waitForController(
        (candidate) => candidate.chatId === draftId,
        context.signal,
      );
      if (context.signal.aborted) return { ...started, sent: false };
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.newChatFailed);
      if (!text) return started;
      const sent = await sendThrough(controller, text, "auto");
      if (sent.ok !== true) return { ...sent, started: true };
      return {
        ...sent,
        started: true,
        untrusted_chat_content: {
          workspace: workspaceLabel,
          ...(sent.untrusted_chat_content as Record<string, unknown> | undefined),
        },
      };
    }),
  };
}

/** Shown once, the first time Live uses a chat tool. */
export const LIVE_CHAT_ACCESS_NOTICE = "Live can read and send to your chats. You can turn this off in Settings.";

/**
 * The one-time chat access notice: the first use shows it and remembers that
 * it was shown (`aidenLiveChatAccessNoticeShown`); later uses, and every use
 * once a saved setting says it was shown, do nothing.
 */
export function createLiveChatAccessNotice(input: {
  alreadyShown(): boolean;
  show(text: string): void;
  remember(): Promise<unknown>;
}): () => void {
  let shown = false;
  return () => {
    if (shown || input.alreadyShown()) return;
    shown = true;
    input.show(LIVE_CHAT_ACCESS_NOTICE);
    void input.remember().catch(() => {
      // Shown in this window either way; a failed save shows it once more next launch.
    });
  };
}
