import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { ActiveTranscript, watchActiveConversation, type ActiveConversationView } from "./active-transcript-watch.js";
import { createBotSessionService, type BotSessionRuntime } from "./bot-session-service.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./test-support/faux.js";
import { recordingDeps } from "./test-support/fixtures.js";

const ctx = BACKGROUND_CONTEXT;
const NOTE = "aiden.test.note";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function botConversation(): Promise<{ service: BotSessionRuntime; conversation: Conversation }> {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-active-transcript-"));
  roots.push(profileDir);
  const service = await createBotSessionService({
    profileDir,
    models: createFauxModels().models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  return { service, conversation: await service.conversation("bot:a") };
}

async function appendNotes(conversation: Conversation, from: number, count: number): Promise<void> {
  await conversation.commit(async (tx) => {
    for (let n = from; n < from + count; n++) await tx.appendEntry(conversation.id, { kind: NOTE, data: { n } });
  }, ctx);
}

const ids = (entries: readonly EntryRecord[]): EntryId[] => entries.map((entry) => entry.id);
const activeIds = async (conversation: Conversation): Promise<EntryId[]> => ids((await conversation.context(ctx)).entries);
const notes = (entries: readonly EntryRecord[]): number[] =>
  entries.filter((entry) => entry.kind === NOTE).map((entry) => (entry.data as { n: number }).n);

test("a watch on a long Bot conversation shows the whole active transcript, not Pi's 50-entry window", async () => {
  const { service, conversation } = await botConversation();
  try {
    await appendNotes(conversation, 0, 150);
    const raw = await conversation.watch(ctx);
    const windowed = raw.value.entries.length;
    await raw.stop();
    // The oracle: Pi's own frame is a window, so a plain watch would lose most of the history.
    assert.ok(windowed < 150, `Pi's frame holds ${windowed} entries`);

    const watch = await watchActiveConversation(conversation, ctx);
    try {
      assert.deepEqual(ids(watch.value.entries), await activeIds(conversation));
      assert.deepEqual(notes(watch.value.entries), Array.from({ length: 150 }, (_, n) => n));
    } finally {
      await watch.stop();
    }
  } finally {
    await service.shutdown();
  }
});

test("frames keep the whole transcript through small appends, a burst past the window, and a reset", async () => {
  const { service, conversation } = await botConversation();
  try {
    await appendNotes(conversation, 0, 120);
    const watch = await watchActiveConversation(conversation, ctx);
    let latest: ActiveConversationView = watch.value;
    watch.start(async (view) => {
      latest = view;
    });
    const settlesOnActive = async (what: string) => {
      const expected = await activeIds(conversation);
      await waitFor(() => ids(latest.entries).join() === expected.join(), { what });
    };
    try {
      for (let n = 120; n < 125; n++) await appendNotes(conversation, n, 1);
      await settlesOnActive("small appends");
      assert.deepEqual(notes(latest.entries), Array.from({ length: 125 }, (_, n) => n));

      // More than a window in one commit: the frame skips entries it never showed.
      await appendNotes(conversation, 125, 130);
      await settlesOnActive("a burst past the window");
      assert.deepEqual(notes(latest.entries), Array.from({ length: 255 }, (_, n) => n));

      // A reset puts a head marker first; nothing before it is active any more.
      await conversation.reset("Carry on from the summary.", ctx);
      await appendNotes(conversation, 255, 3);
      await settlesOnActive("a reset");
      assert.deepEqual(notes(latest.entries), [255, 256, 257]);
      assert.notEqual(latest.entries[0]?.head, undefined, "the head marker leads the frame");
    } finally {
      await watch.stop();
    }
  } finally {
    await service.shutdown();
  }
});

test("a frame whose read waits behind a reset still gets its own active transcript", async () => {
  const { service, conversation } = await botConversation();
  try {
    await appendNotes(conversation, 0, 120);
    const raw = await conversation.watch(ctx);
    const before = raw.value;
    await raw.stop();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transcript = new ActiveTranscript({
      context: async (context, options) => {
        await gate;
        return conversation.context(context, options);
      },
    });
    const reading = transcript.start(before, ctx);
    // The conversation moves on while the frame's read waits.
    await conversation.reset("Carry on from the summary.", ctx);
    await appendNotes(conversation, 120, 2);
    release();

    assert.deepEqual(notes(await reading), Array.from({ length: 120 }, (_, n) => n));
    assert.deepEqual(notes((await conversation.context(ctx)).entries), [120, 121], "the live transcript did move on");
  } finally {
    await service.shutdown();
  }
});
