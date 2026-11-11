// A Bot conversation watch whose frames carry the whole active transcript.
//
// Since Pi Durable 1.5.0 `Conversation.watch()` frames hold a window over the
// fork-aware history: the newest 50 entries, then appends, spliced back to 50
// past 100, with head markers (compaction summaries, resets, hand-offs) in
// place instead of cutting the entries before them. The Bot chat, the live
// feed and the Remote session projection were built on the 1.4.0 frame, the
// active transcript the model sees, and page it down themselves (the Remote
// snapshot budget). This wrapper keeps that frame: it reads the active
// transcript from `Conversation.context()` once, extends it with each frame's
// newer entries, and reads it again when a frame carries a head marker or the
// window skipped entries it never showed.

import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryId, EntryRecord, WatchEnd } from "@earendil-works/pi-durable";

/** One frame: the conversation's documents and its active transcript, head marker first. */
export type ActiveConversationView = Omit<ConversationView, "entries" | "before"> & {
  readonly entries: readonly EntryRecord[];
};

export interface ActiveConversationWatch {
  /** The newest frame (the first one before `start`). */
  readonly value: ActiveConversationView;
  /** Install the sole listener; frames the source folded arrive as one. */
  start(listener: (view: ActiveConversationView) => Promise<void>): void;
  stop(): Promise<WatchEnd>;
  readonly closed: Promise<WatchEnd>;
}

type ActiveReader = Pick<Conversation, "context">;

/** Newest entry ID a window shows, or what the window starts after when it is empty. */
function newestShown(view: Pick<ConversationView, "entries" | "before">): EntryId | undefined {
  let newest = view.before;
  for (const entry of view.entries) if (newest === undefined || entry.id > newest) newest = entry.id;
  return newest;
}

/**
 * Fold windowed views into the active transcript. `through` is the newest entry
 * ID the held transcript accounts for; a read is capped there so the entries
 * always match the frame's documents.
 */
export class ActiveTranscript {
  #entries: readonly EntryRecord[] = [];
  #through: EntryId | undefined;

  constructor(private readonly conversation: ActiveReader) {}

  get entries(): readonly EntryRecord[] {
    return this.#entries;
  }

  async #read(through: EntryId | undefined, context: Context): Promise<void> {
    if (through === undefined) {
      this.#entries = [];
    } else {
      // Read as of `through`, so a reset or compaction committed while the read
      // waits cannot replace the range this frame's documents belong to.
      const active = await this.conversation.context(context, { at: through });
      this.#entries = active.entries.filter((entry) => entry.id <= through);
    }
    this.#through = through;
  }

  /** The first frame of a watch: read the active transcript up to what the window shows. */
  async start(view: Pick<ConversationView, "entries" | "before">, context: Context): Promise<readonly EntryRecord[]> {
    await this.#read(newestShown(view), context);
    return this.#entries;
  }

  /** A later frame: append its newer entries, or read again after a head marker or a skipped stretch. */
  async advance(view: Pick<ConversationView, "entries" | "before">, context: Context): Promise<readonly EntryRecord[]> {
    const through = newestShown(view);
    if (through === undefined || (this.#through !== undefined && through <= this.#through)) return this.#entries;
    const held = this.#through;
    const skipped = view.before !== undefined && (held === undefined || view.before > held);
    const newer = view.entries.filter((entry) => held === undefined || entry.id > held);
    if (skipped || newer.some((entry) => entry.head !== undefined)) {
      await this.#read(through, context);
    } else {
      this.#entries = [...this.#entries, ...newer];
      this.#through = through;
    }
    return this.#entries;
  }
}

/** `conversation.watch(context)` with frames of the whole active transcript instead of a window. */
export async function watchActiveConversation(
  conversation: Pick<Conversation, "watch" | "context">,
  context: Context,
): Promise<ActiveConversationWatch> {
  const watch = await conversation.watch(context);
  const transcript = new ActiveTranscript(conversation);
  const frame = (view: ConversationView, entries: readonly EntryRecord[]): ActiveConversationView => ({
    conversation: view.conversation,
    docs: view.docs,
    entries,
  });
  let value: ActiveConversationView;
  try {
    value = frame(watch.value, await transcript.start(watch.value, context));
  } catch (error) {
    await watch.stop().catch(() => undefined);
    throw error;
  }
  return {
    get value() {
      return value;
    },
    start(listener) {
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        value = frame(call.value, await transcript.advance(call.value, context));
        await listener(value);
      });
    },
    stop: () => watch.stop(),
    closed: watch.closed,
  };
}
