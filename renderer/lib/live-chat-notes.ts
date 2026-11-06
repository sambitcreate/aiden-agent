// Spoken update notes for Aiden Live. While a Live session is on, the chat on
// screen and every chat Live sent a message to are watched; when one finishes
// a reply, fails, or starts waiting for an approval or an answer, Live gets one
// short note it may mention. Notes never carry the reply's text.

import { liveChatNoteText, type LiveChatNoteKind } from "../shared/live-chat-tools";

/** Activity for the chats the window knows, as main reports it. */
export interface LiveChatActivity {
  activeChatIds: ReadonlySet<string>;
  approvalChatIds: ReadonlySet<string>;
  inputChatIds: ReadonlySet<string>;
}

/** How a chat's last reply ended, read once its run stops. */
export type LiveChatEnding = "finished" | "failed" | "stopped" | null;

interface Watched {
  title: string;
  /** Live sent to it (kept when the person opens another chat). */
  sent: boolean;
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
  private openChatId: string | null = null;
  private generation = 0;
  private last: LiveChatActivity | null = null;

  constructor(
    private readonly deps: {
      note(text: string): void;
      /** Reads how the chat's latest reply ended; null when unknown. */
      ending(chatId: string): Promise<LiveChatEnding>;
    },
  ) {}

  /** Live sent a message to this chat. */
  watch(chatId: string, title: string): void {
    const entry = this.watched.get(chatId);
    if (entry) {
      entry.sent = true;
      entry.title = title || entry.title;
      return;
    }
    this.add(chatId, title, true);
  }

  /** The chat on screen while Live is on (null when none). */
  setOpenChat(chatId: string | null, title: string): void {
    if (this.openChatId && this.openChatId !== chatId) {
      const previous = this.watched.get(this.openChatId);
      if (previous && !previous.sent) this.watched.delete(this.openChatId);
    }
    this.openChatId = chatId;
    if (!chatId) return;
    const entry = this.watched.get(chatId);
    if (entry) entry.title = title || entry.title;
    else this.add(chatId, title, false);
  }

  /** The session ended: forget everything and drop endings still being read. */
  reset(): void {
    this.watched.clear();
    this.last = null;
    this.openChatId = null;
    this.generation += 1;
  }

  isWatching(chatId: string): boolean {
    return this.watched.has(chatId);
  }

  /** Compares new activity with what each watched chat had and sends notes for the changes. */
  observe(activity: LiveChatActivity): void {
    this.last = activity;
    const generation = this.generation;
    for (const [chatId, entry] of this.watched) {
      const active = activity.activeChatIds.has(chatId);
      const approval = activity.approvalChatIds.has(chatId);
      const input = activity.inputChatIds.has(chatId);
      if (entry.fresh) {
        Object.assign(entry, { active, approval, input, fresh: false });
        continue;
      }
      if (approval && !entry.approval) this.send("approval", entry.title);
      if (input && !entry.input) this.send("question", entry.title);
      if (entry.active && !active) {
        const title = entry.title;
        void this.deps
          .ending(chatId)
          .catch(() => null)
          .then((ending) => {
            if (generation !== this.generation || !this.watched.has(chatId)) return;
            if (ending === "finished" || ending === "failed") this.send(ending, title);
          });
      }
      Object.assign(entry, { active, approval, input });
    }
  }

  private add(chatId: string, title: string, sent: boolean): void {
    if (this.watched.size >= MAX_WATCHED) {
      const oldest = [...this.watched.keys()].find((id) => id !== this.openChatId);
      if (oldest) this.watched.delete(oldest);
    }
    // Seeded from the latest activity, so a chat already running when Live
    // first sends to it still gets its note when it finishes.
    const last = this.last;
    this.watched.set(chatId, {
      title,
      sent,
      active: last?.activeChatIds.has(chatId) ?? false,
      approval: last?.approvalChatIds.has(chatId) ?? false,
      input: last?.inputChatIds.has(chatId) ?? false,
      fresh: last === null,
    });
  }

  private send(kind: LiveChatNoteKind, title: string): void {
    this.deps.note(liveChatNoteText(kind, title));
  }
}

/** How a reply ended, from the chat's newest assistant message. */
export function liveChatEnding(
  messages: ReadonlyArray<{
    role: string;
    providerFailure?: unknown;
    timeline?: { status?: string };
  }>,
): LiveChatEnding {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last) return null;
  if (last.timeline?.status === "cancelled") return "stopped";
  if (last.providerFailure || last.timeline?.status === "failed") return "failed";
  return "finished";
}
