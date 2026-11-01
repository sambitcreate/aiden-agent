import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  AidenRemoteChatService,
  type AidenRemoteChatReadMarkers,
  type AidenRemoteChatRunTimes,
  type AidenRemoteChatTriage,
} from "./aiden-remote-chats.js";
import { ChatTriageStore } from "./chat-triage.js";
import { ChatReadMarkerStore } from "./chat-read-markers.js";
import {
  createChatApplicationService,
  type ChatApplicationDependencies,
} from "./chat-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";
import type { ChatActivitySnapshot } from "../../renderer/shared/chat-activity.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import {
  AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT,
  parseAidenRemoteChatSummaryPage,
  parseAidenRemoteChatSummaryProjection,
} from "./aiden-remote-protocol.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import { BotMutationGate } from "./bot-mutation-gate.js";
import { createChatStore } from "./chat-store-core.js";
import { chatSummaryRevision } from "./chat-summary-revision.js";
import type { ChatMeta } from "./types.js";

function metadata(id: string, updatedAt: number, overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    id,
    workspaceId: "workspace-1",
    title: `Title ${id}`,
    createdAt: Math.min(1_000, updatedAt),
    updatedAt,
    ...overrides,
  };
}

function summaryService(
  initial: ChatMeta[],
  options: {
    now?: () => number;
    active?: Set<string>;
    pending?: Set<string>;
    cursorSecretByte?: number;
    activity?: () => ChatActivitySnapshot;
    readMarkers?: AidenRemoteChatReadMarkers;
    triage?: AidenRemoteChatTriage;
    runTimes?: (chatId: string) => AidenRemoteChatRunTimes | undefined;
    /** The application's delete; a no-op unless a test wires a real one. */
    remove?: ConstructorParameters<typeof AidenRemoteChatService>[0]["application"]["remove"];
  } = {},
) {
  let rows = structuredClone(initial);
  let payloadReads = 0;
  const streams = new AidenRemoteStreamService({
    now: options.now ?? (() => 10_000),
    cancel: () => false,
    approve: () => false,
  });
  const service = new AidenRemoteChatService({
    application: {
      list: async () => structuredClone(rows),
      listRegular: async () => structuredClone(rows.filter((row) => row.botId === undefined)),
      listSummaryMetadata: async () => structuredClone(rows),
      get: async () => {
        payloadReads += 1;
        return {
          chat: null,
          imageArtifactRecoveryPending: false,
          imageArtifactRecoveryUnavailable: false,
          reconciliation: null,
        };
      },
      create: async () => { throw new Error("unused"); },
      rename: async () => { throw new Error("unused"); },
      moveEmptyToWorkspace: async () => { throw new Error("unused"); },
      remove: options.remove ?? (async () => undefined),
    },
    chatStore: {
      get: async () => null,
      appendMessage: async () => { throw new Error("unused"); },
    },
    generation: { beginChatTurn: () => null, start: async () => false },
    streams,
    models: { resolve: async () => { throw new Error("unused"); } },
    bots: { get: async () => null },
    botMutations: new BotMutationGate(),
    now: options.now,
    summaryCursorSecret: Buffer.alloc(32, options.cursorSecretByte ?? 7),
    isTitlePending: (id) => options.pending?.has(id) === true,
    activeChatIds: () => [...(options.active ?? [])],
    ...(options.activity ? { activitySnapshot: options.activity } : {}),
    ...(options.readMarkers ? { readMarkers: options.readMarkers } : {}),
    ...(options.triage ? { triage: options.triage } : {}),
    ...(options.runTimes ? { runTimes: options.runTimes } : {}),
  });
  return {
    service,
    replace(next: ChatMeta[]) { rows = structuredClone(next); },
    payloadReads: () => payloadReads,
  };
}

test("summary projection accepts additive fields but rejects recursively private fields", () => {
  const summary = {
    id: "chat-1",
    workspaceId: "workspace-1",
    title: "Release planning",
    titlePending: false,
    createdAt: "2026-08-30T20:00:00.000Z",
    updatedAt: "2026-08-30T21:00:00.000Z",
    revision: `rev_${"a".repeat(43)}`,
    activity: "idle",
    futurePresentationHint: { color: "green" },
  };
  assert.equal(parseAidenRemoteChatSummaryProjection(summary).id, "chat-1");
  assert.equal(
    parseAidenRemoteChatSummaryPage({ summaries: [summary], pageHint: "future" }).summaries.length,
    1,
  );
  assert.throws(
    () => parseAidenRemoteChatSummaryProjection({ ...summary, nested: { prompt: "private" } }),
    /private field nested\.prompt/u,
  );
  assert.throws(
    () => parseAidenRemoteChatSummaryPage({ summaries: [summary], credential: "private" }),
    /private field credential/u,
  );
  for (const privateKey of [
    "messages",
    "attachments",
    "htmlArtifacts",
    "outcome",
    "timeline",
    "reasoning",
    "botId",
    "providerId",
    "modelId",
    "preview",
  ]) {
    assert.throws(
      () => parseAidenRemoteChatSummaryProjection({
        ...summary,
        futureEnvelope: [{ [privateKey]: "private" }],
      }),
      new RegExp(`private field futureEnvelope\\.\\[\\]\\.${privateKey}`, "u"),
      `${privateKey} must be rejected recursively`,
    );
  }
  const { titlePending: _missing, ...withoutTitlePending } = summary;
  assert.throws(() => parseAidenRemoteChatSummaryProjection(withoutTitlePending), /titlePending/u);
  assert.throws(
    () => parseAidenRemoteChatSummaryProjection({ ...summary, revision: "other_revision" }),
    /revision is invalid/u,
  );
  assert.throws(
    () => parseAidenRemoteChatSummaryPage({ summaries: [summary], nextCursor: "cursor" }),
    /nextCursor is invalid/u,
  );
});

test("summary pages are transcript-free, deterministic, and exclude reserved chats", async () => {
  const active = new Set(["chat-a"]);
  const pending = new Set(["chat-b"]);
  const fixture = summaryService([
    metadata("chat-b", 3_000),
    metadata("chat-a", 3_000),
    metadata("assistant-chat", 4_000, { workspaceId: "assistant" }),
    metadata("bot-chat", 5_000, { botId: "bot-1" }),
  ], { active, pending });

  const page = await fixture.service.listSummaries();
  assert.deepEqual(page.summaries.map(({ id }) => id), ["chat-a", "chat-b"]);
  assert.deepEqual(page.summaries.map(({ activity }) => activity), ["active", "idle"]);
  assert.deepEqual(page.summaries.map(({ titlePending }) => titlePending), [false, true]);
  assert.equal(page.nextCursor, undefined);
  assert.equal(fixture.payloadReads(), 0);
  assert.deepEqual(Object.keys(page.summaries[0]!).sort(), [
    "activity",
    "createdAt",
    "id",
    "inboxBucket",
    "inboxSortAt",
    "revision",
    "rowState",
    "title",
    "titlePending",
    "unread",
    "updatedAt",
    "workspaceId",
  ]);
  assert.deepEqual(page.summaries.map(({ rowState }) => rowState), ["working", "idle"]);
  // Without a read-marker store no summary can claim unread output.
  assert.deepEqual(page.summaries.map(({ unread }) => unread), [false, false]);
});

test("summaries project attention row states and honest unread from shared markers", async () => {
  const markers = { revision: 1, baselineAt: 1_500, readThrough: { "chat-seen": 2_500 } };
  const fixture = summaryService([
    metadata("chat-approve", 6_000, { lastAssistantAt: 1_200 }),
    metadata("chat-ask", 5_000),
    metadata("chat-busy", 4_000, { lastAssistantAt: 2_000 }),
    metadata("chat-seen", 3_000, { lastAssistantAt: 2_500 }),
    metadata("chat-new", 2_900, { lastAssistantAt: 2_800 }),
    metadata("chat-failed", 2_850, { lastAssistantAt: 2_700, lastAssistantFailed: true }),
  ], {
    activity: () => ({
      revision: 3,
      activeChatIds: ["chat-approve", "chat-ask", "chat-busy"],
      approvalChatIds: ["chat-approve"],
      inputChatIds: ["chat-ask"],
    }),
    readMarkers: {
      snapshot: async () => markers,
      markRead: async () => true,
    },
  });
  const page = parseAidenRemoteChatSummaryPage(await fixture.service.listSummaries());
  const byId = Object.fromEntries(page.summaries.map((summary) => [summary.id, summary]));
  assert.equal(byId["chat-approve"]!.rowState, "needs_approval");
  assert.equal(byId["chat-approve"]!.activity, "active");
  assert.equal(byId["chat-ask"]!.rowState, "needs_input");
  assert.equal(byId["chat-busy"]!.rowState, "working");
  assert.equal(byId["chat-new"]!.rowState, "idle");
  // Output before the install baseline, or already viewed, is not unread.
  assert.equal(byId["chat-approve"]!.unread, false);
  assert.equal(byId["chat-seen"]!.unread, false);
  assert.equal(byId["chat-busy"]!.unread, true);
  assert.equal(byId["chat-new"]!.unread, true);
  assert.equal(byId["chat-ask"]!.unread, false);
  // Only a chat whose newest output failed says so, and only as `true`.
  assert.equal(byId["chat-failed"]!.unread, true);
  assert.equal(byId["chat-failed"]!.lastRunFailed, true);
  assert.deepEqual(
    page.summaries.filter((summary) => "lastRunFailed" in summary).map(({ id }) => id),
    ["chat-failed"],
  );
  // The newest output's time goes out as RFC 3339 (revision 48), and only when there is one.
  assert.equal(byId["chat-new"]!.lastAssistantAt, new Date(2_800).toISOString());
  assert.equal("lastAssistantAt" in byId["chat-ask"]!, false);
  assert.ok(page.summaries.every((summary) => !("lastAssistantFailed" in summary)));
});

test("revision 48 summaries carry a live run's times and the chat's triage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-signals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pinnedAt = Date.parse("2026-11-01T09:00:00.000Z");
  let now = pinnedAt;
  const triage = new ChatTriageStore(() => directory, { now: () => now });
  await triage.set("chat-pinned", { pinned: true });
  now += 60_000;
  await triage.set("chat-pinned", { snoozeUntil: pinnedAt + 8 * 3_600_000 });
  // A chat whose only write was undone has a revision but no times.
  await triage.set("chat-cleared", { done: true });
  await triage.set("chat-cleared", { done: false });
  const times: Record<string, AidenRemoteChatRunTimes> = {
    "chat-waiting": { runStartedAt: 3_000, attentionSince: 3_500 },
    "chat-ended": { runStartedAt: 1_000 },
  };
  const fixture = summaryService([
    metadata("chat-waiting", 4_000),
    metadata("chat-ended", 3_900),
    metadata("chat-pinned", 3_800),
    metadata("chat-cleared", 3_700),
  ], { active: new Set(["chat-waiting"]), runTimes: (chatId) => times[chatId], triage });
  const page = parseAidenRemoteChatSummaryPage(await fixture.service.listSummaries());
  const byId = Object.fromEntries(page.summaries.map((summary) => [summary.id, summary]));
  assert.equal(byId["chat-waiting"]!.runStartedAt, new Date(3_000).toISOString());
  assert.equal(byId["chat-waiting"]!.attentionSince, new Date(3_500).toISOString());
  // A chat with no live run reports no run times, whatever the registry last held.
  assert.equal("runStartedAt" in byId["chat-ended"]!, false);
  assert.equal(byId["chat-pinned"]!.triageRevision, 2);
  assert.equal(byId["chat-pinned"]!.pinnedAt, new Date(pinnedAt).toISOString());
  assert.equal(byId["chat-pinned"]!.snoozedUntil, new Date(pinnedAt + 8 * 3_600_000).toISOString());
  assert.equal(byId["chat-cleared"]!.triageRevision, 2);
  assert.equal("doneAt" in byId["chat-cleared"]!, false);
  // A chat never triaged carries no revision, so a client can tell "never" from "cleared".
  assert.equal("triageRevision" in byId["chat-waiting"]!, false);
});

test("summaries carry the host's Inbox bucket and sort time for each kind of row", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-buckets-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const N = Date.parse("2026-11-01T12:00:00.000Z");
  let triageNow = N - day;
  const triage = new ChatTriageStore(() => directory, { now: () => triageNow });
  // A snooze set before the approval: the live prompt still wins.
  await triage.set("chat-approve", { snoozeUntil: N + 3 * hour });
  triageNow = N - 30 * minute;
  await triage.set("chat-pinned", { pinned: true });
  triageNow = N - 3 * hour;
  await triage.set("chat-done", { done: true });
  triageNow = N - 2 * hour;
  await triage.set("chat-done-then-output", { done: true });
  triageNow = N - 6 * hour;
  await triage.set("chat-snoozed", { snoozeUntil: N + 3 * hour });
  // Snoozes that a failure the person hasn't seen, and a running chat, outrank.
  await triage.set("chat-failed-snoozed", { snoozeUntil: N + 3 * hour });
  await triage.set("chat-working-snoozed", { snoozeUntil: N + 3 * hour });
  // Done and Snooze both held: Done holds until newer output, so it wins.
  triageNow = N - 3 * hour;
  await triage.set("chat-done-snoozed", { done: true, snoozeUntil: N + 3 * hour });
  const readThrough = {
    "chat-failed-seen": N - 2 * hour,
    "chat-pinned": N - 3 * day,
    "chat-snoozed": N - 5 * hour,
    "chat-recent": N - day,
    "chat-old": N - 30 * day,
  };
  const times: Record<string, AidenRemoteChatRunTimes> = {
    "chat-approve": { runStartedAt: N - 10 * minute, attentionSince: N - 5 * minute },
    "chat-working": { runStartedAt: N - 2 * minute },
    "chat-question": { runStartedAt: N - 15 * minute, attentionSince: N - 7 * minute },
    "chat-working-snoozed": { runStartedAt: N - 3 * minute },
  };
  let now = N;
  const fixture = summaryService([
    metadata("chat-approve", N - 4 * minute),
    metadata("chat-working", N - minute),
    metadata("chat-question", N - 6 * minute),
    metadata("chat-working-snoozed", N - 2 * minute),
    metadata("chat-failed-snoozed", N - 90 * minute, { lastAssistantAt: N - 90 * minute, lastAssistantFailed: true }),
    metadata("chat-done-snoozed", N - 4 * hour, { lastAssistantAt: N - 4 * hour }),
    metadata("chat-failed", N - hour, { lastAssistantAt: N - hour, lastAssistantFailed: true }),
    metadata("chat-failed-seen", N - 2 * hour, { lastAssistantAt: N - 2 * hour, lastAssistantFailed: true }),
    metadata("chat-pinned", N - 3 * day, { lastAssistantAt: N - 3 * day }),
    metadata("chat-done", N - 4 * hour, { lastAssistantAt: N - 4 * hour }),
    metadata("chat-done-then-output", N - hour, { lastAssistantAt: N - hour }),
    metadata("chat-snoozed", N - 5 * hour, { lastAssistantAt: N - 5 * hour }),
    metadata("chat-new", N - 20 * minute, { lastAssistantAt: N - 20 * minute }),
    metadata("chat-recent", N - day, { lastAssistantAt: N - day }),
    metadata("chat-old", N - 30 * day, { lastAssistantAt: N - 30 * day }),
  ], {
    now: () => now,
    activity: () => ({
      revision: 1,
      activeChatIds: ["chat-approve", "chat-working", "chat-question", "chat-working-snoozed"],
      approvalChatIds: ["chat-approve"],
      inputChatIds: ["chat-question"],
    }),
    readMarkers: { snapshot: async () => ({ revision: 1, baselineAt: 0, readThrough }), markRead: async () => true },
    triage,
    runTimes: (chatId) => times[chatId],
  });
  const placed = async () => {
    const page = parseAidenRemoteChatSummaryPage(await fixture.service.listSummaries());
    return Object.fromEntries(page.summaries.map((row) => [row.id, [row.inboxBucket, row.inboxSortAt]]));
  };
  const iso = (at: number) => new Date(at).toISOString();
  assert.deepEqual(await placed(), {
    // Needs you orders by the wait, falling back to the row's update time.
    "chat-approve": ["needs_you", iso(N - 5 * minute)],
    "chat-failed": ["needs_you", iso(N - hour)],
    "chat-question": ["needs_you", iso(N - 7 * minute)],
    "chat-failed-snoozed": ["needs_you", iso(N - 90 * minute)],
    // A failure the person has seen is an ordinary read chat.
    "chat-failed-seen": ["earlier", iso(N - 2 * hour)],
    "chat-working": ["working", iso(N - 2 * minute)],
    "chat-working-snoozed": ["working", iso(N - 3 * minute)],
    "chat-pinned": ["pinned", iso(N - 30 * minute)],
    // Done and snoozed rows carry the time they order by once they come back.
    "chat-done": ["done", iso(N - 4 * hour)],
    "chat-done-snoozed": ["done", iso(N - 4 * hour)],
    "chat-done-then-output": ["updates", iso(N - hour)],
    "chat-snoozed": ["snoozed", iso(N - 5 * hour)],
    "chat-new": ["updates", iso(N - 20 * minute)],
    "chat-recent": ["earlier", iso(N - day)],
    // The host applies no recent window: an old read chat is still Earlier.
    "chat-old": ["earlier", iso(N - 30 * day)],
  });
  // The snooze is judged on the host's clock when the row is computed.
  now = N + 4 * hour;
  assert.deepEqual((await placed())["chat-snoozed"], ["earlier", iso(N - 5 * hour)]);
});

test("a failing marker store hides unread dots instead of failing the list", async () => {
  const fixture = summaryService([metadata("chat-a", 2_000, { lastAssistantAt: 1_900 })], {
    readMarkers: {
      snapshot: async () => { throw new Error("disk unavailable"); },
      markRead: async () => true,
    },
  });
  const page = await fixture.service.listSummaries();
  assert.equal(page.summaries[0]!.unread, false);
});

test("summary parser accepts additive row state and rejects unknown values", () => {
  const summary = {
    id: "chat-1",
    workspaceId: "workspace-1",
    title: "Release planning",
    titlePending: false,
    createdAt: "2026-08-30T20:00:00.000Z",
    updatedAt: "2026-08-30T21:00:00.000Z",
    revision: `rev_${"a".repeat(43)}`,
    activity: "active",
  };
  assert.equal(parseAidenRemoteChatSummaryProjection(summary).rowState, undefined);
  const parsed = parseAidenRemoteChatSummaryProjection({ ...summary, rowState: "needs_input", unread: true });
  assert.equal(parsed.rowState, "needs_input");
  assert.equal(parsed.unread, true);
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...summary, rowState: "blocked" }), /rowState/u);
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...summary, unread: "yes" }), /unread/u);
  assert.equal(parseAidenRemoteChatSummaryProjection({ ...summary, lastRunFailed: true }).lastRunFailed, true);
  assert.equal("lastRunFailed" in parseAidenRemoteChatSummaryProjection(summary), false);
  assert.throws(
    () => parseAidenRemoteChatSummaryProjection({ ...summary, lastRunFailed: false }),
    /lastRunFailed/u,
  );
  // Revision 48: RFC 3339 times, and triage times only beside the revision that wrote them.
  const signals = parseAidenRemoteChatSummaryProjection({
    ...summary,
    attentionSince: "2026-08-30T21:05:00Z",
    lastAssistantAt: "2026-08-30T21:04:00.000Z",
    triageRevision: 3,
    doneAt: "2026-08-30T21:10:00.000Z",
  });
  assert.equal(signals.triageRevision, 3);
  assert.equal(signals.doneAt, "2026-08-30T21:10:00.000Z");
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...summary, pinnedAt: "2026-08-30T21:10:00.000Z" }), /triageRevision/u);
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...summary, triageRevision: 0 }), /triageRevision/u);
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...summary, runStartedAt: 1_700_000_000_000 }), /runStartedAt/u);
  // The host's bucket travels with its sort time; a pair the desktop can't use is dropped, never fatal.
  const bucketed = parseAidenRemoteChatSummaryProjection({ ...summary, inboxBucket: "snoozed", inboxSortAt: "2026-08-30T21:00:00Z" });
  assert.equal(bucketed.inboxBucket, "snoozed");
  assert.equal(bucketed.inboxSortAt, "2026-08-30T21:00:00Z");
  const later = parseAidenRemoteChatSummaryProjection({ ...summary, inboxBucket: "archived", inboxSortAt: "2026-08-30T21:00:00Z" });
  assert.equal("inboxBucket" in later, false);
  assert.equal("inboxSortAt" in later, false);
  for (const unusable of [
    { inboxBucket: "done" },
    { inboxSortAt: "2026-08-30T21:00:00Z" },
    { inboxBucket: 3, inboxSortAt: "2026-08-30T21:00:00Z" },
    { inboxBucket: "done", inboxSortAt: "yesterday" },
  ]) {
    const row = parseAidenRemoteChatSummaryProjection({ ...summary, ...unusable });
    assert.equal("inboxBucket" in row, false);
    assert.equal("inboxSortAt" in row, false);
    assert.equal(row.title, "Release planning");
  }
});

test("equal timestamps use ordinal chat ID ordering", async () => {
  const fixture = summaryService([
    metadata("chat_1", 3_000),
    metadata("chat:1", 3_000),
    metadata("chat.1", 3_000),
    metadata("chat-1", 3_000),
    metadata("Chat-1", 3_000),
  ]);

  const page = await fixture.service.listSummaries();
  assert.deepEqual(page.summaries.map(({ id }) => id), [
    "Chat-1",
    "chat-1",
    "chat.1",
    "chat:1",
    "chat_1",
  ]);
});

test("snapshot cursors avoid duplicates across creates, updates, and deletes", async () => {
  const initial = [
    metadata("chat-a", 5_000),
    metadata("chat-b", 4_000),
    metadata("chat-c", 3_000),
    metadata("chat-d", 2_000),
  ];
  const fixture = summaryService(initial);
  const first = await fixture.service.listSummaries(2);
  assert.deepEqual(first.summaries.map(({ id }) => id), ["chat-a", "chat-b"]);
  assert.match(first.nextCursor!, /^cur_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);

  fixture.replace([
    metadata("chat-new", 9_000),
    metadata("chat-a", 8_000, { title: "Updated after snapshot" }),
    metadata("chat-c", 7_000, { title: "Updated before its page" }),
    // chat-d was deleted.
  ]);
  const second = await fixture.service.listSummaries(2, first.nextCursor);
  assert.deepEqual(second.summaries.map(({ id }) => id), ["chat-c"]);
  assert.equal(second.summaries[0]?.title, "Title chat-c", "snapshot metadata stays frozen");
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual(
    await fixture.service.listSummaries(2, first.nextCursor),
    second,
    "retrying a terminal cursor is deterministic until expiry",
  );
  assert.equal(fixture.payloadReads(), 0);
});

test("summary cursors reject malformed, forged, expired, and evicted snapshots", async () => {
  let now = 1_000;
  const fixture = summaryService([metadata("chat-a", 2_000), metadata("chat-b", 1_500)], {
    now: () => now,
  });
  const first = await fixture.service.listSummaries(1);
  const cursor = first.nextCursor!;
  await assert.rejects(() => fixture.service.listSummaries(1, "not-a-cursor"), /cursor is invalid/u);
  const forged = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    () => fixture.service.listSummaries(1, forged),
    /cursor is invalid/u,
  );
  const otherInstallation = summaryService(
    [metadata("chat-a", 2_000), metadata("chat-b", 1_500)],
    { now: () => now, cursorSecretByte: 8 },
  );
  await assert.rejects(
    () => otherInstallation.service.listSummaries(1, cursor),
    /cursor is invalid/u,
  );
  for (let index = 0; index < 16; index += 1) {
    await fixture.service.listSummaries(1);
  }
  await assert.rejects(() => fixture.service.listSummaries(1, cursor), /invalid or expired/u);
  const expiring = (await fixture.service.listSummaries(1)).nextCursor!;
  now += 5 * 60_000;
  await assert.rejects(() => fixture.service.listSummaries(1, expiring), /invalid or expired/u);
});

test("summary query enforces chat:read, defaults, and hard bounds over HTTP", async (t) => {
  const fixture = summaryService([metadata("chat-a", 2_000)]);
  let observedLimit: number | undefined;
  const original = fixture.service.listSummaries.bind(fixture.service);
  fixture.service.listSummaries = async (limit, cursor) => {
    observedLimit = limit;
    return original(limit, cursor);
  };
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Test Mac",
    appVersion: "0.1.0",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) => credential === "a".repeat(43)
        ? {
            id: "device-1",
            revoked: false,
            capabilities: new Set(["chat:read", "server:read"] as const),
          }
        : null,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    chats: fixture.service,
    connectionMode: () => "lan",
    now: () => 1_000,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const protocolHeaders = { "aiden-protocol-version": "1" };
  const unauthorized = await fetch(`${base}/chat-summaries`, { headers: protocolHeaders });
  assert.equal(unauthorized.status, 401);
  const headers = {
    ...protocolHeaders,
    authorization: `Bearer ${"a".repeat(43)}`,
  };
  const valid = await fetch(`${base}/chat-summaries`, { headers });
  assert.equal(valid.status, 200);
  assert.equal(observedLimit, 100);
  for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=201", "limit=1&limit=2", "extra=1"]) {
    assert.equal((await fetch(`${base}/chat-summaries?${query}`, { headers })).status, 400, query);
  }
  assert.equal(
    (await fetch(`${base}/chat-summaries?limit=${AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT}`, { headers })).status,
    200,
  );
  const serverProjection = await (await fetch(`${base}/server`, {
    headers,
  })).json() as { features?: string[] };
  // The read-only messages window is advertised to every device that can read chats.
  assert.deepEqual(serverProjection.features, ["chat-summaries-v1", "chat-skills-v1", "chat-messages-window-v1", "chat-messages-window-metadata-v1", "chat-visuals-v1"]);
});

test("pathological synthetic history keeps summary responses bounded without payload reads", async () => {
  const fixture = summaryService(
    Array.from({ length: 2_000 }, (_, index) =>
      metadata(`chat-${String(index).padStart(4, "0")}`, 10_000 - Math.floor(index / 2), {
        title: `${index} ${"x".repeat(2_000)}`,
      }),
    ),
  );
  const first = await fixture.service.listSummaries(AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT);
  assert.equal(first.summaries.length, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") < 1_048_576);
  assert.equal(fixture.payloadReads(), 0);
});

test("deterministic performance fixtures record full-history and summary costs", async () => {
  const definitions = [
    { name: "small", chats: 50, messages: () => 10, messageChars: () => 64 },
    { name: "medium", chats: 250, messages: () => 50, messageChars: () => 256 },
    { name: "large", chats: 1_000, messages: () => 100, messageChars: () => 1_024 },
    {
      name: "pathological",
      chats: 2_000,
      messages: (index: number) => [1, 100, 10_000][index % 3]!,
      messageChars: (index: number) => [0, 1_024, 200_000][index % 3]!,
    },
  ] as const;

  const exactProjectedChatBytes = (id: string, messageCount: number, messageChars: number) => {
    const empty = JSON.stringify({
      id,
      workspaceId: "workspace-benchmark",
      title: `Synthetic ${id}`,
      messages: [],
      createdAt: "2026-08-30T20:00:00.000Z",
      updatedAt: "2026-08-30T21:00:00.000Z",
      revision: `rev_${"a".repeat(43)}`,
    });
    const message = JSON.stringify({
      id: "message-benchmark",
      role: "assistant",
      text: "x".repeat(messageChars),
      createdAt: "2026-08-30T21:00:00.000Z",
    });
    return Buffer.byteLength(empty, "utf8") - 2
      + 2
      + messageCount * Buffer.byteLength(message, "utf8")
      + Math.max(0, messageCount - 1);
  };

  const metrics: Array<Record<string, string | number>> = [];
  for (const definition of definitions) {
    const rows = Array.from({ length: definition.chats }, (_, index) =>
      metadata(`chat-${String(index).padStart(4, "0")}`, 100_000 - index),
    );
    const fixture = summaryService(rows);
    const heapBefore = process.memoryUsage().heapUsed;
    const projectionStarted = performance.now();
    const page = await fixture.service.listSummaries(AIDEN_REMOTE_CHAT_SUMMARY_MAX_LIMIT);
    const projectionMs = performance.now() - projectionStarted;
    const serialized = JSON.stringify(page);
    const decodeStarted = performance.now();
    JSON.parse(serialized);
    const decodeMs = performance.now() - decodeStarted;
    const heapAfter = process.memoryUsage().heapUsed;
    const fullChatsBytes = Buffer.byteLength('{"chats":[', "utf8")
      + rows.reduce(
        (total, row, index) =>
          total
          + exactProjectedChatBytes(
            row.id,
            definition.messages(index),
            definition.messageChars(index),
          )
          + (index > 0 ? 1 : 0),
        0,
      )
      + Buffer.byteLength("]}", "utf8");
    assert.ok(Buffer.byteLength(serialized, "utf8") < 1_048_576);
    assert.equal(fixture.payloadReads(), 0);
    metrics.push({
      fixture: definition.name,
      chats: definition.chats,
      fullChatsBytes,
      summaryPageBytes: Buffer.byteLength(serialized, "utf8"),
      projectionMs: projectionMs.toFixed(3),
      jsonDecodeMs: decodeMs.toFixed(3),
      retainedHeapDeltaBytes: heapAfter - heapBefore,
      transcriptFileOpens: fixture.payloadReads(),
    });
  }
  console.log(`# chat-summary-benchmark ${JSON.stringify(metrics)}`);
});

test("chat store performs bounded legacy summary migration without transcript reads", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-summary-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify([metadata("chat-legacy", 2_000, { preview: "Index-only preview" })]),
    "utf8",
  );
  await fs.writeFile(path.join(directory, ".chat-transaction.chat-legacy.pending"), "1\n", "utf8");
  await fs.writeFile(
    path.join(directory, "chat-legacy.json"),
    JSON.stringify({ ...metadata("chat-legacy", 2_000), messages: [] }),
    "utf8",
  );
  let transcriptReads = 0;
  const store = createChatStore(
    async () => directory,
    async (providerId) => providerId,
    {
      readFile: async (target) => {
        if (target.endsWith("chat-legacy.json")) transcriptReads += 1;
        return fs.readFile(target, "utf8");
      },
      syncDirectory: async () => undefined,
      syncFile: async () => undefined,
    },
  );
  const summaries = await store.listSummaryMetadata();
  assert.match(summaries[0]?.summaryRevision ?? "", /^rev_[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    summaries[0]?.summaryRevision,
    chatSummaryRevision({ ...metadata("chat-legacy", 2_000), preview: undefined }),
    "legacy index-only previews do not create a revision that its payload cannot match",
  );
  assert.equal(transcriptReads, 0);
  const migrated = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8")) as ChatMeta[];
  assert.equal(migrated[0]?.summaryRevision, summaries[0]?.summaryRevision);
});

test("read reports require chat:read, validate the body, and advertise only when wired", async (t) => {
  const reports: Array<[string, string | undefined]> = [];
  const fixture = summaryService([metadata("chat-a", 2_000)], {
    readMarkers: {
      snapshot: async () => ({ revision: 0, baselineAt: 1, readThrough: {} }),
      markRead: async (chatId, throughMessageId) => {
        reports.push([chatId, throughMessageId]);
        return true;
      },
    },
  });
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Test Mac",
    appVersion: "0.1.0",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) => credential === "a".repeat(43)
        ? {
            id: "device-1",
            revoked: false,
            capabilities: new Set(["chat:read", "server:read"] as const),
          }
        : credential === "b".repeat(43)
          ? { id: "device-2", revoked: false, capabilities: new Set(["server:read"] as const) }
          : null,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    chats: fixture.service,
    connectionMode: () => "lan",
    now: () => 1_000,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const headers = {
    "aiden-protocol-version": "1",
    "content-type": "application/json",
    authorization: `Bearer ${"a".repeat(43)}`,
  };
  const post = (chatId: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/chats/${chatId}/read`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });

  assert.equal((await post("chat-a", { throughMessageId: "msg-1" })).status, 204);
  assert.equal((await post("chat-a", {})).status, 204);
  assert.deepEqual(reports, [["chat-a", "msg-1"], ["chat-a", undefined]]);

  for (const body of [{ throughMessageId: "../x" }, { throughMessageId: 1 }, { other: true }, []]) {
    assert.equal((await post("chat-a", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post("chat-missing", {})).status, 404);
  assert.equal(
    (await post("chat-a", {}, { authorization: `Bearer ${"b".repeat(43)}` })).status,
    403,
  );
  assert.equal(reports.length, 2);

  const serverProjection = await (await fetch(`${base}/server`, { headers })).json() as {
    features?: string[];
  };
  assert.ok(serverProjection.features?.includes("chat-read-state-v1"));
});

test("triage writes need chat:write and an Idempotency-Key, replay, and refuse a stale ifRevision", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-triage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-11-02T10:00:00.000Z");
  const triage = new ChatTriageStore(() => directory, { now: () => now });
  const fixture = summaryService([metadata("chat-a", 2_000), metadata("bot-chat", 2_100, { botId: "bot-1" })], { triage });
  const writer = "a".repeat(43);
  const reader = "b".repeat(43);
  const phone = "c".repeat(43);
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Test Mac",
    appVersion: "0.1.0",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) => credential === writer
        ? { id: "device-1", type: "mac" as const, revoked: false, capabilities: new Set(["chat:read", "chat:write", "server:read"] as const) }
        : credential === reader
          ? { id: "device-2", type: "mac" as const, revoked: false, capabilities: new Set(["chat:read", "server:read"] as const) }
          : credential === phone
            ? { id: "device-3", type: "iphone" as const, revoked: false, capabilities: new Set(["chat:read", "chat:write", "server:read"] as const) }
            : null,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    chats: fixture.service,
    connectionMode: () => "lan",
    now: () => 1_000,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const post = (chatId: string, body: unknown, key: string | null, credential = writer) =>
    fetch(`${base}/chats/${chatId}/triage`, {
      method: "POST",
      headers: {
        "aiden-protocol-version": "1",
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });

  const snoozed = await post("chat-a", { snoozeUntil: "2026-11-02T18:00:00+00:00", ifRevision: 0 }, "triage-key-0000001");
  assert.equal(snoozed.status, 200);
  assert.deepEqual(await snoozed.json(), {
    chatId: "chat-a",
    revision: 1,
    updatedAt: "2026-11-02T10:00:00.000Z",
    snoozedUntil: "2026-11-02T18:00:00.000Z",
  });

  // The same key replays the first answer instead of writing again.
  now += 60_000;
  const replay = await post("chat-a", { snoozeUntil: "2026-11-02T18:00:00+00:00", ifRevision: 0 }, "triage-key-0000001");
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).revision, 1);
  assert.equal((await triage.get("chat-a"))?.revision, 1);

  // An Undo built on an older revision is refused with the current one.
  assert.equal((await post("chat-a", { done: true }, "triage-key-0000002")).status, 200);
  const stale = await post("chat-a", { snoozeUntil: null, ifRevision: 1 }, "triage-key-0000003");
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as { error: { code: string; details?: { currentRevision?: string } } };
  assert.equal(conflict.error.code, "revision_conflict");
  assert.equal(conflict.error.details?.currentRevision, "2");
  assert.equal((await triage.get("chat-a"))?.snoozedUntil, Date.parse("2026-11-02T18:00:00.000Z"));

  // Writing needs chat:write and a key; the body is closed and bounded.
  assert.equal((await post("chat-a", { pinned: true }, "triage-key-0000004", reader)).status, 403);
  assert.equal((await post("chat-a", { pinned: true }, null)).status, 400);
  for (const body of [{}, { pinned: "yes" }, { snoozeUntil: "tomorrow" }, { done: true, archived: true }, { done: true, ifRevision: -1 }, []]) {
    assert.equal((await post("chat-a", body, "triage-key-0000005")).status, 400, JSON.stringify(body));
  }
  assert.equal((await post("chat-a", { snoozeUntil: "2028-11-02T18:00:00Z" }, "triage-key-0000006")).status, 400);
  assert.equal((await post("chat-missing", { done: true }, "triage-key-0000007")).status, 404);
  assert.equal((await post("bot-chat", { done: true }, "triage-key-0000008")).status, 404);
  assert.equal((await triage.get("chat-a"))?.pinnedAt, undefined);

  const features = async (credential: string) => ((await (await fetch(`${base}/server`, {
    headers: { "aiden-protocol-version": "1", authorization: `Bearer ${credential}` },
  })).json()) as { features?: string[] }).features ?? [];
  assert.ok((await features(writer)).includes("chat-triage-v1"));
  assert.ok((await features(phone)).includes("chat-triage-v1"), "phones triage under chat:write (revision 48)");
  const fromPhone = await post("chat-a", { done: true }, "triage-key-0000009", phone);
  assert.equal(fromPhone.status, 200);
  assert.ok((await triage.get("chat-a"))?.doneAt);
  assert.ok((await features(writer)).includes("inbox-signals-v1"));
  assert.equal((await features(phone)).includes("inbox-signals-v1"), false, "phones decode the fields without the token");
});

test("a Remote delete drops the chat's read marker and triage through the shared deletion", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-delete-inbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => directory);
  await chatStore.create({ id: "chat-gone", title: "Gone" });
  await chatStore.create({ id: "chat-kept", title: "Kept" });
  const triage = new ChatTriageStore(() => directory);
  const readMarkers = new ChatReadMarkerStore(() => directory);
  for (const chatId of ["chat-gone", "chat-kept"]) {
    await triage.set(chatId, { pinned: true });
    assert.equal(await readMarkers.markRead(chatId, 5_000, 0), true);
  }
  // The cleanup is fire-and-forget; track it so the test can await it.
  const writes: Promise<unknown>[] = [];
  const track = (write: Promise<unknown>) => { writes.push(write); return write; };
  // The real chat application service, so the Remote route runs the same
  // deletion as the desktop and Bot deletes.
  const application = createChatApplicationService({
    chatStore,
    configStore: { getWorkspace: async () => null },
    llmClient: {
      isChatOwnedByInactiveRenderer: () => false,
      isChatBusy: () => false,
      waitForChatIdle: async () => true,
      requiresAppendReconciliation: () => false,
      markAppendReconciliationRequired: () => undefined,
      clearAppendReconciliationRequired: () => undefined,
      beginChatWorkspaceChange: () => () => undefined,
      beginChatDeletion: () => () => undefined,
      cancelChat: async () => undefined,
    },
    displayImageArtifactStore: { availability: () => ({ available: true }), hasPending: async () => false, deleteChat: async () => undefined },
    generativeUiArtifactStore: { availability: () => ({ available: true }), hasPending: async () => false, deleteChat: async () => undefined },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    subagentRunStore: { deleteChat: async () => undefined, completeChatDeletion: async () => undefined, pendingChatDeletions: async () => [] },
    piRuntimeEffectStore: { deleteChat: async () => undefined },
    piCompactionSessionStore: { deleteChat: async () => undefined },
    inboxState: {
      readMarkers: { remove: (chatId: string) => track(readMarkers.remove(chatId)) },
      triage: { remove: (chatId: string) => track(triage.remove(chatId)) },
    },
    logError: () => undefined,
  } as unknown as ChatApplicationDependencies);
  const fixture = summaryService(
    [metadata("chat-gone", 2_000), metadata("chat-kept", 2_100)],
    { triage, remove: (chatId, options) => application.remove(chatId, options) },
  );

  // A delete refused for a stale revision keeps everything.
  await assert.rejects(
    fixture.service.remove("chat-gone", `rev_${"a".repeat(43)}`),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
  await Promise.all(writes);
  assert.equal(typeof (await triage.get("chat-gone"))?.pinnedAt, "number");

  const current = await chatStore.get("chat-gone");
  assert.ok(current);
  await fixture.service.remove("chat-gone", chatSummaryRevision(current));
  await Promise.all(writes);
  assert.equal(await chatStore.get("chat-gone"), null);
  assert.equal(await triage.get("chat-gone"), null);
  const markers = await readMarkers.snapshot();
  assert.equal("chat-gone" in markers.readThrough, false);
  assert.equal(markers.readThrough["chat-kept"], 5_000);
  assert.equal(typeof (await triage.get("chat-kept"))?.pinnedAt, "number");
});

test("feature-owned chats never reach summaries or the host feed", async () => {
  const owner = { kind: "design-project" as const, projectId: "project-1" };
  const fixture = summaryService([
    metadata("chat-a", 3_000),
    metadata("design-chat", 4_000, { workspaceId: "default", owner }),
    metadata("owned-bot-chat", 4_500, { botId: "bot-1", owner }),
    metadata("bot-chat", 4_600, { botId: "bot-1" }),
    metadata("assistant-chat", 5_000, { workspaceId: "assistant" }),
  ], { active: new Set(["design-chat"]) });

  const page = await fixture.service.listSummaries();
  assert.deepEqual(page.summaries.map(({ id }) => id), ["chat-a"]);
  assert.equal(JSON.stringify(page).includes("design-chat"), false);

  const feed = await fixture.service.hostFeedChats();
  assert.deepEqual(feed.summaries.map(({ id }) => id), ["chat-a"]);
  // A Bot chat that is also feature-owned is a feature chat: it fails closed
  // out of the Bot id set too, while genuine Bot chats stay announced.
  assert.equal(feed.botChatIds.has("owned-bot-chat"), false);
  assert.equal(feed.botChatIds.has("bot-chat"), true);
});
