// Spoken update notes for Aiden Live. While a Live session is on, each chat
// Live sent a message to in that session is watched; when its reply to Live's
// message finishes, fails, or starts waiting for an approval or an answer,
// Live gets one short note it may mention. Replies to messages the person
// typed get no note, and notes never carry the reply's text.

import { liveChatNoteText, type LiveChatNoteKind } from "../shared/live-chat-tools";

/** Activity for the chats the window knows, as main reports it. */
export interface LiveChatActivity {
  activeChatIds: ReadonlySet<string>;
  approvalChatIds: ReadonlySet<string>;
  inputChatIds: ReadonlySet<string>;
}

/** How a chat's last reply ended, read once its run stops. */
export type LiveChatEnding = "finished" | "failed" | "stopped" | null;

/** The chat's latest turn: whose message started it, and how its reply ended. */
export interface LiveChatTurn {
  /** The newest message from the user's side is one Live sent ("By voice"). */
  byVoice: boolean;
  /** How the reply to that message ended; null while there is none. */
  ending: LiveChatEnding;
}

interface Watched {
  title: string;
  active: boolean;
  approval: boolean;
  input: boolean;
  /** No activity seen yet: the first observation only records the state. */
  fresh: boolean;
}

/** At most this many chats are watched; the oldest is dropped first. */
const MAX_WATCHED = 12;

export class LiveChatNoteWatcher {
  private readonly watched = new Map<string, Watched>();
  private generation = 0;
  private last: LiveChatActivity | null = null;

  constructor(
    private readonly deps: {
      note(text: string): void;
      /** Reads the chat's latest turn; null when it can't be read. */
      turn(chatId: string): Promise<LiveChatTurn | null>;
    },
  ) {}

  /** Live sent a message to this chat in this session. */
  watch(chatId: string, title: string): void {
    const entry = this.watched.get(chatId);
    if (entry) {
      entry.title = title || entry.title;
      return;
    }
    if (this.watched.size >= MAX_WATCHED) {
      const oldest = this.watched.keys().next().value;
      if (oldest !== undefined) this.watched.delete(oldest);
    }
    // Seeded from the latest activity, so a chat already running when Live
    // first sends to it still gets its note when it finishes.
    const last = this.last;
    this.watched.set(chatId, {
      title,
      active: last?.activeChatIds.has(chatId) ?? false,
      approval: last?.approvalChatIds.has(chatId) ?? false,
      input: last?.inputChatIds.has(chatId) ?? false,
      fresh: last === null,
    });
  }

  /** The session ended (or chat access went off): forget everything and drop reads in flight. */
  reset(): void {
    this.watched.clear();
    this.last = null;
    this.generation += 1;
  }

  isWatching(chatId: string): boolean {
    return this.watched.has(chatId);
  }

  /** Compares new activity with what each watched chat had and sends notes for the changes. */
  observe(activity: LiveChatActivity): void {
    this.last = activity;
    for (const [chatId, entry] of this.watched) {
      const active = activity.activeChatIds.has(chatId);
      const approval = activity.approvalChatIds.has(chatId);
      const input = activity.inputChatIds.has(chatId);
      if (entry.fresh) {
        Object.assign(entry, { active, approval, input, fresh: false });
        continue;
      }
      if (approval && !entry.approval) this.noteTurn(chatId, entry.title, "approval");
      if (input && !entry.input) this.noteTurn(chatId, entry.title, "question");
      if (entry.active && !active) this.noteTurn(chatId, entry.title, "ending");
      Object.assign(entry, { active, approval, input });
    }
  }

  /** Notes only a turn Live started; an ending note says how the reply ended. */
  private noteTurn(chatId: string, title: string, kind: "approval" | "question" | "ending"): void {
    const generation = this.generation;
    void this.deps
      .turn(chatId)
      .catch(() => null)
      .then((turn) => {
        if (generation !== this.generation || !this.watched.has(chatId) || !turn?.byVoice) return;
        if (kind !== "ending") this.send(kind, title);
        else if (turn.ending === "finished" || turn.ending === "failed") this.send(turn.ending, title);
      });
  }

  private send(kind: LiveChatNoteKind, title: string): void {
    this.deps.note(liveChatNoteText(kind, title));
  }
}

type TurnMessage = {
  role: string;
  inputSource?: string;
  /** Set when a UserPromptSubmit hook refused the message; no model read it. */
  hookBlocked?: unknown;
  notice?: unknown;
  providerFailure?: unknown;
  timeline?: { status?: string };
};

/** How a reply ended, from the chat's newest assistant message. */
export function liveChatEnding(messages: readonly TurnMessage[]): LiveChatEnding {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last) return null;
  if (last.timeline?.status === "cancelled") return "stopped";
  if (last.providerFailure || last.timeline?.status === "failed") return "failed";
  return "finished";
}

/** The newest turn: was its message Live's, and how did the reply after it end. */
export function liveChatTurn(messages: readonly TurnMessage[]): LiveChatTurn {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !message.notice) {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return { byVoice: false, ending: null };
  return {
    // A message a hook refused was never answered, so no reply after it is Live's.
    byVoice: messages[lastUser]!.inputSource === "voice" && !messages[lastUser]!.hookBlocked,
    ending: liveChatEnding(messages.slice(lastUser + 1)),
  };
}
