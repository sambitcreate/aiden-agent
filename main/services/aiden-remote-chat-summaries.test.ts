import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
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
      remove: async () => undefined,
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
    "revision",
    "title",
    "titlePending",
    "updatedAt",
    "workspaceId",
  ]);
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
  assert.deepEqual(serverProjection.features, ["chat-summaries-v1"]);
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
