import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { applyBotLiveEvent, type BotLiveEvent, type BotLiveSnapshot } from "../../../renderer/shared/bot-live.js";
import { createBotSessionService, type BotSessionRuntime, type BotSessionServiceDeps } from "./bot-session-service.js";
import {
  BOT_CONNECT_CARD_ENTRY_KIND,
  createBotLiveProjection,
  type BotLiveProjection,
  type BotLiveProjectionDeps,
} from "./live-projection.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-live-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  service: BotSessionRuntime;
  projection: BotLiveProjection;
  close(): Promise<void>;
}

async function start(
  fauxModels: FauxModels,
  options: { service?: Partial<BotSessionServiceDeps>; projection?: Partial<BotLiveProjectionDeps> } = {},
): Promise<Harness> {
  let projection: BotLiveProjection | undefined;
  const service = await createBotSessionService({
    profileDir: tempProfile(),
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
    onStateChange: (botId, state) => projection?.notifyState(botId, state),
    ...options.service,
  });
  projection = createBotLiveProjection({
    conversation: (botId) => service.conversation(botId),
    state: (botId) => service.state(botId),
    ...options.projection,
  });
  return {
    service,
    projection,
    async close() {
      await projection!.close();
      await service.shutdown();
    },
  };
}

/** A renderer stand-in: applies events like `useBotLive` and records what arrived. */
function recorder() {
  const events: BotLiveEvent[] = [];
  let view: BotLiveSnapshot | null = null;
  let gaps = 0;
  return {
    events,
    sink: {
      send(event: BotLiveEvent) {
        events.push(event);
        if (!view) return;
        const next = applyBotLiveEvent(view, event);
        if (next === null) gaps += 1;
        else view = next;
      },
    },
    start(snapshot: BotLiveSnapshot) {
      view = snapshot;
    },
    get view() {
      return view;
    },
    get gaps() {
      return gaps;
    },
  };
}

/** Wait, outside the projection, until the reply has streamed some text into `pi.live`. */
async function waitForStreamedText(service: BotSessionRuntime, botId: string): Promise<void> {
  const watch = await (await service.conversation(botId)).watch(ctx);
  const hasText = () => {
    const live = watch.value.docs["pi.live"] as { generation?: { message?: { content?: Array<{ text?: string }> } } } | undefined;
    return (live?.generation?.message?.content ?? []).some((part) => (part.text ?? "").length > 0);
  };
  watch.start(async () => undefined);
  try {
    await waitFor(hasText, { what: "streamed text" });
  } finally {
    await watch.stop();
  }
}

const visibleText =(snapshot: BotLiveSnapshot | null) =>
  (snapshot?.entries ?? []).map((entry) =>
    entry.type === "user" || entry.type === "assistant"
      ? `${entry.type}:${entry.text}`
      : entry.type === "routine"
        ? `routine:${entry.label}`
        : entry.type,
  );

test("subscribing mid-stream returns a snapshot that already has the partial reply", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    await live.service.send("bot:a", { text: "tell me a story", requestId: "desk-1" });
    await waitForStreamedText(live.service, "bot:a");

    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    try {
      assert.equal(snapshot.state.kind, "running");
      assert.match(snapshot.partial ?? "", /^word word/u);
      assert.deepEqual(visibleText(snapshot), ["user:tell me a story"]);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("events extend the snapshot, and a fresh subscription after a drop starts further along", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const first = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(first.snapshot);
    const sent = await live.service.send("bot:a", { text: "one", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    await waitFor(() => visibleText(tape.view).includes("assistant:first answer") && tape.view?.state.kind === "idle", {
      what: "the reply to reach the subscriber",
    });
    assert.equal(tape.gaps, 0);
    assert.deepEqual(visibleText(tape.view), ["user:one", "assistant:first answer"]);
    assert.equal(tape.view?.partial, null);

    // The renderer reloads: its subscription is gone while another turn runs.
    first.unsubscribe();
    const again = await live.service.send("bot:a", { text: "two", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", again.submissionId, new AbortController().signal);

    const reloaded = recorder();
    const second = await live.projection.subscribe("bot:a", reloaded.sink);
    try {
      assert.ok(second.snapshot.seq > tape.view!.seq, "a fresh snapshot is numbered after everything already seen");
      assert.deepEqual(visibleText(second.snapshot), [
        "user:one",
        "assistant:first answer",
        "user:two",
        "assistant:second answer",
      ]);
    } finally {
      second.unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("reopening the Bot's session starts a new epoch and re-sends a snapshot", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("before close"), fauxAssistantMessage("after reopen")]);
  const live = await start(fauxModels, { service: { idleCloseMs: 80 } });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const first = await live.service.send("bot:a", { text: "hi", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", first.submissionId, new AbortController().signal);
    // Idle close ends the watch; the next send reopens the harness.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await live.service.send("bot:a", { text: "again", requestId: "desk-2" });
    await live.service.awaitReply("bot:a", second.submissionId, new AbortController().signal);
    await waitFor(() => visibleText(tape.view).includes("assistant:after reopen"), { what: "the reopened feed" });
    try {
      assert.notEqual(tape.view?.epoch, snapshot.epoch);
      assert.ok(tape.events.some((event) => event.type === "snapshot" && event.epoch !== snapshot.epoch));
      assert.deepEqual(visibleText(tape.view), ["user:hi", "assistant:before close", "user:again", "assistant:after reopen"]);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("more than 100 undelivered events collapse into one snapshot", async () => {
  const fauxModels = createFauxModels([]);
  const flushes: Array<() => void> = [];
  const live = await start(fauxModels, { projection: { schedule: (flush) => flushes.push(flush) } });
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const conversation = await live.service.conversation("bot:a");
    for (let index = 0; index < 120; index += 1) {
      await conversation.submit(
        {
          type: "write",
          entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { type: "connect_card", pluginId: "notion", reason: `card ${index}`, status: "pending" } },
        },
        ctx,
      );
    }
    await live.projection.refresh("bot:a");
    for (const flush of flushes.splice(0)) flush();
    try {
      assert.equal(tape.events.length, 1);
      assert.equal(tape.events[0]!.type, "snapshot");
      assert.equal(tape.view?.entries.filter((entry) => entry.type === "connect_card").length, 120);
    } finally {
      unsubscribe();
    }
  } finally {
    await live.close();
  }
});

test("a routine turn shows as its label, and a [SILENT] answer hides the whole turn", async () => {
  const fauxModels = createFauxModels([
    fauxAssistantMessage("Here is your meal plan."),
    fauxAssistantMessage("[SILENT]"),
  ]);
  const live = await start(fauxModels);
  try {
    const shown = await live.service.send("bot:a", {
      text: "Plan this week's meals.",
      requestId: "routine:t1:1",
      label: "Weekly meal plan",
    });
    await live.service.awaitReply("bot:a", shown.submissionId, new AbortController().signal);
    const quiet = await live.service.send("bot:a", {
      text: "Anything new?",
      requestId: "routine:t2:1",
      label: "Inbox check",
    });
    await live.service.awaitReply("bot:a", quiet.submissionId, new AbortController().signal);
    await live.service.markSilent("bot:a", quiet.submissionId);

    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    unsubscribe();
    assert.deepEqual(visibleText(snapshot), ["routine:Weekly meal plan", "assistant:Here is your meal plan."]);
    const summary = await live.projection.summary("bot:a");
    assert.equal(summary.preview, "Here is your meal plan.");
  } finally {
    await live.close();
  }
});

test("a hidden prompt never shows, but its reply does", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("Hi! I'm your Meal Planner.")]);
  const live = await start(fauxModels);
  try {
    const intro = await live.service.send("bot:a", {
      text: "Introduce yourself.",
      requestId: "intro:bot:a",
      hidden: true,
    });
    await live.service.awaitReply("bot:a", intro.submissionId, new AbortController().signal);
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    unsubscribe();
    assert.deepEqual(visibleText(snapshot), ["assistant:Hi! I'm your Meal Planner."]);
  } finally {
    await live.close();
  }
});

test("Stop ends the running reply, keeps what was written, and the Bot is idle again", async () => {
  const fauxModels = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const live = await start(fauxModels);
  try {
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    await live.service.send("bot:a", { text: "go", requestId: "desk-1" });
    await waitFor(() => (tape.view?.partial ?? "").length > 0, { what: "a partial reply" });
    const state = await live.service.stop("bot:a");
    assert.equal(state.kind, "idle");
    await waitFor(() => tape.view?.partial === null && tape.view.state.kind === "idle", { what: "the stop to land" });
    const last = tape.view!.entries[tape.view!.entries.length - 1];
    assert.equal(last?.type, "assistant");
    assert.equal(last?.type === "assistant" ? last.stopReason : null, "aborted");
    assert.match(last?.type === "assistant" ? last.text : "", /^word/u);
    assert.equal(fauxModels.calls(), 1);
    unsubscribe();
  } finally {
    await live.close();
  }
});

test("connect cards carry their current status, and refresh re-sends a changed one", async () => {
  const dismissed = new Set<string>();
  const fauxModels = createFauxModels([]);
  const live = await start(fauxModels, {
    projection: {
      connectCardStatus: async (_botId, card) => (dismissed.has(card.pluginId) ? "dismissed" : card.status),
    },
  });
  try {
    const conversation = await live.service.conversation("bot:a");
    await conversation.submit(
      {
        type: "write",
        entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { type: "connect_card", pluginId: "notion", reason: "Notes", status: "pending" } },
      },
      ctx,
    );
    const tape = recorder();
    const { snapshot, unsubscribe } = await live.projection.subscribe("bot:a", tape.sink);
    tape.start(snapshot);
    const status = () => {
      const card = tape.view?.entries.find((entry) => entry.type === "connect_card");
      return card?.type === "connect_card" ? card.card.status : null;
    };
    assert.equal(status(), "pending");
    dismissed.add("notion");
    await live.projection.refresh("bot:a");
    await waitFor(() => status() === "dismissed", { what: "the dismissed status" });
    unsubscribe();
  } finally {
    await live.close();
  }
});
