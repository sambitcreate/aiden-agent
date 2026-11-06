// Window-side handlers for Aiden Live's chat tools. Main validates Gemini's
// arguments and forwards each call here through the Live session bus; these
// handlers check them again, use the open chat's controller for read, send and
// stop, and the app shell's navigation for find and start. None of them can
// answer a tool approval.

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
  type LiveChatCandidate,
  type LiveChatSendMode,
  type LiveChatToolName,
} from "../shared/live-chat-tools";
import type { LiveChatController } from "./live-chat-control";
import type { LiveRendererToolContext, LiveRendererToolHandler, LiveRendererToolResult } from "./live-session-bus";

export interface LiveChatToolDeps {
  /** "Let Live use the open chat" is on. */
  enabled(): boolean;
  /** The open chat's controller, or null when no regular chat is on screen. */
  controller(): LiveChatController | null;
  waitForController(
    predicate: (controller: LiveChatController) => boolean,
    signal: AbortSignal,
  ): Promise<LiveChatController | null>;
  /** Regular chats the person can open (never Bot or Assistant chats). */
  listChats(): Promise<LiveChatCandidate[]>;
  /** Opens a chat in the main window; false when navigation is blocked. */
  openChat(chatId: string): Promise<boolean>;
  listWorkspaces(): Promise<Array<{ id: string; name: string }>>;
  /** The workspace the person is in now. */
  currentWorkspaceId(): string | null;
  /** Opens (or reuses) an empty draft there; false when navigation is blocked. */
  openNewChatIn(workspaceId: string): Promise<boolean>;
  /** Called on every chat tool use; shows the one-time notice the first time. */
  used(): void;
  /** Live sent to this chat: its finished, failed and approval moments become notes. */
  watch(chatId: string, title: string): void;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function isSendMode(value: unknown): value is LiveChatSendMode {
  return typeof value === "string" && (LIVE_CHAT_SEND_MODES as readonly string[]).includes(value);
}

function cancelled(): LiveRendererToolResult {
  return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
}

export function createLiveChatToolHandlers(
  deps: LiveChatToolDeps,
): Record<LiveChatToolName, LiveRendererToolHandler> {
  /** Every handler: switch first, then the one-time notice, then the tool. */
  const guarded =
    (run: (args: Record<string, unknown>, context: LiveRendererToolContext) => Promise<LiveRendererToolResult> | LiveRendererToolResult): LiveRendererToolHandler =>
    async (args, context) => {
      if (!deps.enabled()) return liveChatFailure(LIVE_CHAT_ERRORS.off);
      if (context.signal.aborted) return cancelled();
      deps.used();
      return run(args ?? {}, context);
    };

  const sendThrough = async (
    controller: LiveChatController,
    text: string,
    mode: LiveChatSendMode,
  ): Promise<LiveRendererToolResult> => {
    const before = controller.read(1).title;
    const result = await controller.send(text, mode);
    if (result.ok === true) deps.watch(controller.chatId, controller.read(1).title || before);
    return result;
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
      return {
        ok: true,
        chat: {
          title: snapshot.title,
          busy: snapshot.busy,
          ...(snapshot.waitingForApproval ? { waitingForApproval: true } : {}),
        },
        messages: snapshot.messages,
        ...(snapshot.truncated ? { olderMessagesLeftOut: true } : {}),
      };
    }),

    send_to_open_chat: guarded(async (args, context) => {
      const text = boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
      const mode = args.mode === undefined ? "auto" : args.mode;
      if (!text || !isSendMode(mode)) return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      const controller = deps.controller();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.noChat);
      if (context.signal.aborted) return cancelled();
      return sendThrough(controller, text, mode);
    }),

    stop_open_chat: guarded(() => {
      const controller = deps.controller();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.noChat);
      return controller.stop();
    }),

    find_and_open_chat: guarded(async (args, context) => {
      const query = boundedText(args.query, LIVE_CHAT_MAX_QUERY_CHARS);
      if (!query) return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      const found = findLiveChat(await deps.listChats(), query);
      if (context.signal.aborted) return cancelled();
      if (found.kind === "none") return liveChatFailure(LIVE_CHAT_ERRORS.notFound);
      if (found.kind === "ambiguous") {
        return { ok: true, opened: false, closeMatches: found.titles };
      }
      if (deps.controller()?.chatId === found.chat.id) {
        return { ok: true, opened: true, title: found.chat.title, alreadyOpen: true };
      }
      if (!(await deps.openChat(found.chat.id))) return liveChatFailure(LIVE_CHAT_ERRORS.navigationBlocked);
      return { ok: true, opened: true, title: found.chat.title };
    }),

    start_new_chat: guarded(async (args, context) => {
      const workspaceName =
        args.workspace === undefined ? null : boundedText(args.workspace, LIVE_CHAT_MAX_WORKSPACE_CHARS);
      const text = args.text === undefined ? null : boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
      if ((args.workspace !== undefined && !workspaceName) || (args.text !== undefined && !text)) {
        return liveChatFailure(LIVE_CHAT_ERRORS.invalid);
      }
      const workspaces = await deps.listWorkspaces();
      const workspace = workspaceName
        ? findLiveWorkspace(workspaces, workspaceName)
        : (workspaces.find((entry) => entry.id === deps.currentWorkspaceId()) ?? null);
      if (!workspace) return liveChatFailure(LIVE_CHAT_ERRORS.workspaceNotFound);
      if (context.signal.aborted) return cancelled();
      let opened: boolean;
      try {
        opened = await deps.openNewChatIn(workspace.id);
      } catch {
        return liveChatFailure(LIVE_CHAT_ERRORS.newChatFailed);
      }
      if (!opened) return liveChatFailure(LIVE_CHAT_ERRORS.navigationBlocked);
      const controller = await deps.waitForController(
        (candidate) => candidate.isDraft && candidate.workspaceId === workspace.id,
        context.signal,
      );
      if (context.signal.aborted) return cancelled();
      if (!controller) return liveChatFailure(LIVE_CHAT_ERRORS.newChatFailed);
      if (!text) return { ok: true, started: true, workspace: workspace.name };
      const sent = await sendThrough(controller, text, "auto");
      if (sent.ok !== true) return sent;
      return { ...sent, started: true, workspace: workspace.name };
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
