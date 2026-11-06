import * as React from "react";
import { liveChatControl, type LiveChatController } from "../lib/live-chat-control";
import type { LiveRendererToolResult } from "../lib/live-session-bus";
import type { ChatMessage } from "../lib/types";
import { steerRejectionMessage } from "../lib/chat-message-queue";
import type { ChatRunInputAdmissionResult } from "../shared/chat-run-input";
import {
  LIVE_CHAT_ERRORS,
  decideLiveChatSend,
  liveChatFailure,
  liveChatTranscript,
  type LiveChatSendMode,
} from "../shared/live-chat-tools";

/** What the open chat's composer knows right now, plus its own send paths. */
export interface LiveChatPaneState {
  chatId: string;
  workspaceId: string | null;
  isDraft: boolean;
  title: string;
  messages: readonly ChatMessage[];
  /** A reply is starting or running (this window's or a phone's). */
  busy: boolean;
  steerAvailable: boolean;
  queueAvailable: boolean;
  hasQueued: boolean;
  /** The composer could send (model ready, nothing to repair). */
  ready: boolean;
  /** A draft's first message is still being saved. */
  firstSending: boolean;
  waitingForApproval: boolean;
  /** Composer Send with "By voice". Resolves once the message is saved. */
  send(text: string): Promise<void>;
  /** Composer Queue with "By voice". */
  queue(text: string): Promise<void>;
  /** Composer Steer with "By voice"; null when no run can take it now. */
  steer(text: string): Promise<ChatRunInputAdmissionResult | null>;
  /** Composer Stop; false when there is nothing it can stop yet. */
  stop(): boolean;
  /** Shows a failure the way the composer would. */
  showError(message: string): void;
}

/** Builds the controller Live's chat tools use from the pane's latest state. */
export function createLiveChatController(read: () => LiveChatPaneState): LiveChatController {
  const initial = read();
  return {
    chatId: initial.chatId,
    workspaceId: initial.workspaceId,
    isDraft: initial.isDraft,
    read(limit) {
      const state = read();
      const transcript = liveChatTranscript(state.messages, limit);
      return {
        title: state.title,
        busy: state.busy,
        waitingForApproval: state.waitingForApproval,
        messages: transcript.messages,
        truncated: transcript.truncated,
      };
    },
    async send(text: string, mode: LiveChatSendMode): Promise<LiveRendererToolResult> {
      const state = read();
      if (state.firstSending) return liveChatFailure(LIVE_CHAT_ERRORS.firstSending);
      if (!state.ready) return liveChatFailure(LIVE_CHAT_ERRORS.notReady);
      const action = decideLiveChatSend(mode, state);
      if (typeof action === "object") return liveChatFailure(action.refuse);
      try {
        if (action === "send") {
          await state.send(text);
          return { ok: true, status: "sent", title: read().title };
        }
        if (action === "queue") {
          await state.queue(text);
          return { ok: true, status: "queued", title: state.title };
        }
        const receipt = await state.steer(text);
        if (!receipt) return liveChatFailure(LIVE_CHAT_ERRORS.cannotSteer);
        if (receipt.admitted) return { ok: true, status: "steered", title: state.title };
        if (receipt.committed) {
          // Saved in the transcript, but the reply ended before it read it.
          return { ok: true, status: "saved_not_read", title: state.title };
        }
        return { ok: false, error: { code: "steer_rejected", message: steerRejectionMessage(receipt.reason) } };
      } catch (error) {
        state.showError(error instanceof Error ? error.message : LIVE_CHAT_ERRORS.sendFailed.message);
        return liveChatFailure(LIVE_CHAT_ERRORS.sendFailed);
      }
    },
    stop() {
      const state = read();
      if (!state.busy) return liveChatFailure(LIVE_CHAT_ERRORS.nothingRunning);
      return state.stop()
        ? { ok: true, status: "stopping", title: state.title }
        : liveChatFailure(LIVE_CHAT_ERRORS.cannotStop);
    },
  };
}

/**
 * Registers the open chat with Live's chat tools while this pane shows it.
 * The controller always reads the pane's latest render, so a voice send
 * follows exactly the rules the composer would apply at that moment.
 */
export function useLiveChatController(state: LiveChatPaneState): void {
  const latest = React.useRef(state);
  React.useLayoutEffect(() => {
    latest.current = state;
  });
  const owner = React.useMemo(() => Symbol("live-chat-controller"), []);
  const { chatId, workspaceId, isDraft } = state;
  React.useEffect(
    () => liveChatControl.register(owner, createLiveChatController(() => latest.current)),
    [chatId, isDraft, owner, workspaceId],
  );
}
