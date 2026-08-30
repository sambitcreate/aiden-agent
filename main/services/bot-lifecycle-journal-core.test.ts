import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BotLifecycleJournalConflictError,
  BotLifecycleJournalStateError,
  createBotLifecycleJournalCore,
  parseBotLifecycleJournalDocument,
  reconcilePendingBotLifecycles,
  type BotLifecycleBeginInput,
  type BotLifecycleJournalDocument,
  type BotLifecycleStage,
} from "./bot-lifecycle-journal-core.js";
import {
  BOT_LIFECYCLE_JOURNAL_FILENAME,
  createBotLifecycleJournal,
} from "./bot-lifecycle-journal.js";

const OPERATION_A = "10000000-0000-4000-8000-000000000001";
const OPERATION_B = "20000000-0000-4000-8000-000000000002";
const OPERATION_C = "30000000-0000-4000-8000-000000000003";
const OPERATION_D = "40000000-0000-4000-8000-000000000004";
const OPERATION_E = "50000000-0000-4000-8000-000000000005";
const WORKSPACE_A = "60000000-0000-4000-8000-000000000006";
const OPERATION_F = "70000000-0000-4000-8000-000000000007";
const OPERATION_G = "80000000-0000-4000-8000-000000000008";
const OPERATION_H = "90000000-0000-4000-8000-000000000009";

async function temporaryRoot(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return { parent, root: join(parent, "bot-private") };
}

function mode(value: { mode: number }): number {
  return value.mode & 0o777;
}

const operations: readonly BotLifecycleBeginInput[] = [
  {
    operationId: OPERATION_A,
    kind: "create_bot",
    botId: "bot-1",
    subject: { workspaceId: WORKSPACE_A, workspaceCreatedAt: 10 },
  },
  {
    operationId: OPERATION_B,
    kind: "create_chat",
    botId: "bot-1",
    subject: { chatId: "chat-new", workspaceId: WORKSPACE_A },
  },
  {
    operationId: OPERATION_C,
    kind: "copy_chat",
    botId: "bot-1",
    subject: { sourceChatId: "chat-source", targetChatId: "chat-copy" },
  },
  {
    operationId: OPERATION_D,
    kind: "delete_chat",
    botId: "bot-1",
    subject: { chatId: "chat-delete" },
  },
  {
    operationId: OPERATION_E,
    kind: "archive_bot",
    botId: "bot-1",
    subject: { expectedRevision: "botrev:before-archive" },
  },
  {
    operationId: OPERATION_F,
    kind: "restore_bot",
    botId: "bot-1",
    subject: { expectedRevision: "botrev:before-restore" },
  },
  {
    operationId: OPERATION_H,
    kind: "update_model",
    botId: "bot-1",
    subject: { chatId: "chat-model", expectedRevision: "botrev:before-model" },
  },
];

const stageSequences: Readonly<
  Record<BotLifecycleBeginInput["kind"], readonly BotLifecycleStage[]>
> = {
  create_bot: ["prepared", "workspace_provisioned", "policy_committed", "identity_committed"],
  create_chat: ["prepared", "policy_committed", "chat_committed"],
  copy_chat: ["prepared", "policy_committed", "chat_committed"],
  delete_chat: ["prepared", "authority_fenced", "chat_deleted", "policy_removed"],
  update_model: ["prepared", "policy_committed", "chat_committed"],
  archive_bot: ["prepared", "authority_archived", "identity_archived"],
  restore_bot: ["prepared", "identity_restored", "authority_restored"],
};

test("typed lifecycle checkpoints survive restart and completed replay is idempotent", async () => {
  const paths = await temporaryRoot("aiden-bot-journal-");
  let clock = 100;
  try {
    const journal = createBotLifecycleJournal({ root: () => paths.root, now: () => clock++ });
    for (const input of operations) {
      const admitted = await journal.begin(input);
      assert.equal(admitted.status, "pending");
      if (admitted.status === "pending") assert.equal(admitted.operation.stage, "prepared");
      const sequence = stageSequences[input.kind];
      for (let index = 1; index < sequence.length; index += 1) {
        const expected = sequence[index - 1]!;
        const next = sequence[index]!;
        const checkpoint = await journal.checkpoint(input.operationId, expected, next);
        assert.equal(checkpoint.stage, next);
        assert.equal((await journal.checkpoint(input.operationId, expected, next)).stage, next);
      }
      await journal.complete(input.operationId, sequence[sequence.length - 1]!);
      await journal.complete(input.operationId, sequence[sequence.length - 1]!);
      const completed = await journal.lookup(input.operationId);
      assert.equal(completed?.status, "completed");
      if (completed?.status === "completed") assert.equal(completed.operation.outcome, "committed");
      assert.equal((await journal.begin(input)).status, "completed");
    }
    assert.deepEqual(await journal.listPending(), []);

    const rolledBack: BotLifecycleBeginInput = {
      operationId: OPERATION_G,
      kind: "create_chat",
      botId: "bot-1",
      subject: { chatId: "chat-rolled-back", workspaceId: WORKSPACE_A },
    };
    await journal.begin(rolledBack);
    await journal.checkpoint(OPERATION_G, "prepared", "policy_committed");
    await journal.rollback(OPERATION_G, "policy_committed");
    await journal.rollback(OPERATION_G, "policy_committed");
    await assert.rejects(
      journal.rollback(OPERATION_G, "prepared"),
      BotLifecycleJournalConflictError,
    );
    await assert.rejects(
      journal.complete(OPERATION_G, "chat_committed"),
      BotLifecycleJournalConflictError,
    );
    assert.equal((await journal.begin(rolledBack)).status, "completed");
    await assert.rejects(
      journal.begin({
        ...rolledBack,
        subject: { chatId: "another-chat", workspaceId: WORKSPACE_A },
      }),
      /reused/u,
    );
    await assert.rejects(
      journal.rollback(OPERATION_A, "identity_committed"),
      BotLifecycleJournalConflictError,
    );

    const restarted = createBotLifecycleJournal({ root: () => paths.root });
    assert.equal((await restarted.lookup(OPERATION_A))?.status, "completed");
    const recoveredRollback = await restarted.lookup(OPERATION_G);
    assert.equal(recoveredRollback?.status, "completed");
    if (recoveredRollback?.status === "completed") {
      assert.equal(recoveredRollback.operation.outcome, "rolled_back");
      assert.equal(recoveredRollback.operation.terminalStage, "policy_committed");
    }
    await restarted.rollback(OPERATION_G, "policy_committed");
    assert.equal(mode(await lstat(paths.root)), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_LIFECYCLE_JOURNAL_FILENAME))), 0o600);
    assert.equal(
      (await readFile(join(paths.root, BOT_LIFECYCLE_JOURNAL_FILENAME), "utf8")).includes(
        paths.parent,
      ),
      false,
      "journal never persists filesystem paths",
    );
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});

test("checkpoint transitions cannot skip, reverse, or complete early", async () => {
  let document: BotLifecycleJournalDocument | null = null;
  const journal = createBotLifecycleJournalCore({
    storage: {
      read: async () => structuredClone(document),
      write: async (next) => {
        document = structuredClone(next);
      },
    },
    now: () => 1,
  });
  await journal.begin(operations[0]!);
  await assert.rejects(
    journal.checkpoint(OPERATION_A, "prepared", "policy_committed"),
    /skip or reverse/u,
  );
  await assert.rejects(journal.complete(OPERATION_A, "prepared"), BotLifecycleJournalConflictError);
  await journal.checkpoint(OPERATION_A, "prepared", "workspace_provisioned");
  await assert.rejects(
    journal.checkpoint(OPERATION_A, "prepared", "identity_committed"),
    /skip or reverse/u,
  );
  await assert.rejects(
    journal.checkpoint(OPERATION_A, "policy_committed", "identity_committed"),
    BotLifecycleJournalConflictError,
  );

  await assert.rejects(
    journal.begin({
      ...operations[0]!,
      botId: "another-bot",
    } as BotLifecycleBeginInput),
    /reused/u,
  );

  await journal.begin(operations[2]!);
  await assert.rejects(
    journal.checkpoint(OPERATION_C, "prepared", "chat_committed"),
    /skip or reverse/u,
  );
  assert.equal(
    (await journal.checkpoint(OPERATION_C, "prepared", "policy_committed")).stage,
    "policy_committed",
  );

  await journal.begin(operations[5]!);
  await assert.rejects(
    journal.checkpoint(OPERATION_F, "prepared", "authority_restored"),
    /skip or reverse/u,
  );
  assert.equal(
    (await journal.checkpoint(OPERATION_F, "prepared", "identity_restored")).stage,
    "identity_restored",
  );

  await journal.begin(operations[1]!);
  await assert.rejects(
    journal.checkpoint(OPERATION_B, "prepared", "chat_committed"),
    /skip or reverse/u,
  );
  await journal.checkpoint(OPERATION_B, "prepared", "policy_committed");
  await assert.rejects(journal.rollback(OPERATION_B, "prepared"), BotLifecycleJournalConflictError);
  await journal.checkpoint(OPERATION_B, "policy_committed", "chat_committed");
  await assert.rejects(
    journal.rollback(OPERATION_B, "chat_committed"),
    /visible Bot lifecycle commit/u,
  );
});

test("reconciliation runs in admission order, preserves failures, and exposes every lifecycle kind", async () => {
  let document: BotLifecycleJournalDocument | null = null;
  let clock = 1;
  const journal = createBotLifecycleJournalCore({
    storage: {
      read: async () => structuredClone(document),
      write: async (next) => {
        document = structuredClone(next);
      },
    },
    now: () => clock++,
  });
  for (const input of operations) await journal.begin(input);

  const handled: string[] = [];
  const failed: string[] = [];
  await reconcilePendingBotLifecycles({
    journal,
    handlers: {
      create_bot: async (operation) => {
        handled.push(operation.kind);
      },
      create_chat: async (operation) => {
        handled.push(operation.kind);
      },
      copy_chat: async () => {
        throw new Error("copy repair failed");
      },
      delete_chat: async (operation) => {
        handled.push(operation.kind);
      },
      archive_bot: async (operation) => {
        handled.push(operation.kind);
      },
      restore_bot: async (operation) => {
        handled.push(operation.kind);
      },
      update_model: async (operation) => {
        handled.push(operation.kind);
      },
    },
    onError: (operation, error) => {
      failed.push(`${operation.kind}:${String(error)}`);
    },
  });
  assert.deepEqual(handled, [
    "create_bot",
    "create_chat",
    "delete_chat",
    "archive_bot",
    "restore_bot",
    "update_model",
  ]);
  assert.match(failed[0]!, /^copy_chat:Error: copy repair failed$/u);
  assert.equal((await journal.listPending()).length, operations.length);
});

test("corrupt, future, duplicate, oversized, and path-like journal input fails closed", async () => {
  const invalidDocuments: unknown[] = [
    { version: 99, pending: [], completed: [] },
    { version: 2, pending: "wrong", completed: [] },
    {
      version: 2,
      pending: [
        {
          operationId: OPERATION_A,
          kind: "archive_bot",
          botId: "bot-1",
          subject: { expectedRevision: "botrev:before-archive" },
          stage: "prepared",
          startedAt: 1,
          updatedAt: 1,
        },
        {
          operationId: OPERATION_A,
          kind: "restore_bot",
          botId: "bot-1",
          subject: { expectedRevision: "botrev:before-restore" },
          stage: "prepared",
          startedAt: 1,
          updatedAt: 1,
        },
      ],
      completed: [],
    },
    { version: 2, pending: new Array(513).fill({}), completed: [] },
    {
      version: 2,
      pending: [],
      completed: [
        {
          operationId: OPERATION_G,
          kind: "create_chat",
          botId: "bot-1",
          subject: { chatId: "chat-invalid" },
          outcome: "rolled_back",
          terminalStage: "chat_committed",
          completedAt: 1,
        },
      ],
    },
  ];
  for (const invalid of invalidDocuments) {
    const journal = createBotLifecycleJournalCore({
      storage: { read: async () => invalid, write: async () => undefined },
    });
    await assert.rejects(journal.listPending(), BotLifecycleJournalStateError);
  }

  const journal = createBotLifecycleJournalCore({
    storage: { read: async () => null, write: async () => undefined },
  });
  await assert.rejects(
    journal.begin({ ...operations[3]!, botId: "../outside" } as BotLifecycleBeginInput),
    BotLifecycleJournalStateError,
  );
  await assert.rejects(
    journal.begin({ ...operations[3]!, operationId: "client-id" } as BotLifecycleBeginInput),
    BotLifecycleJournalStateError,
  );
});

test("model-update lifecycle has exact subject parsing and keeps version 2 documents compatible", async () => {
  const legacy = parseBotLifecycleJournalDocument({
    version: 2,
    pending: [
      {
        operationId: OPERATION_B,
        kind: "create_chat",
        botId: "bot-1",
        subject: { chatId: "chat-new", workspaceId: WORKSPACE_A },
        stage: "prepared",
        startedAt: 1,
        updatedAt: 1,
      },
    ],
    completed: [],
  });
  assert.equal(legacy.version, 2);
  assert.equal(legacy.pending[0]?.kind, "create_chat");

  let document: BotLifecycleJournalDocument | null = null;
  const journal = createBotLifecycleJournalCore({
    storage: {
      read: async () => structuredClone(document),
      write: async (next) => {
        document = structuredClone(next);
      },
    },
    now: () => 1,
  });
  const modelUpdate = operations.find(({ kind }) => kind === "update_model")!;
  assert.equal((await journal.begin(modelUpdate)).status, "pending");
  assert.equal(
    (await journal.checkpoint(OPERATION_H, "prepared", "policy_committed")).stage,
    "policy_committed",
  );
  assert.equal(
    (await journal.checkpoint(OPERATION_H, "policy_committed", "chat_committed")).stage,
    "chat_committed",
  );
  await journal.complete(OPERATION_H, "chat_committed");
  const completed = await journal.lookup(OPERATION_H);
  assert.equal(completed?.status, "completed");
  if (completed?.status === "completed") {
    assert.deepEqual(completed.operation.subject, {
      chatId: "chat-model",
      expectedRevision: "botrev:before-model",
    });
  }

  for (const subject of [
    { chatId: "chat-model" },
    { expectedRevision: "botrev:before-model" },
    { chatId: "chat-model", expectedRevision: "botrev:before-model", extra: true },
    { chatId: "../chat-model", expectedRevision: "botrev:before-model" },
    { chatId: "chat-model", expectedRevision: "revision with spaces" },
  ]) {
    const invalid = createBotLifecycleJournalCore({
      storage: { read: async () => null, write: async () => undefined },
    });
    await assert.rejects(
      invalid.begin({
        operationId: OPERATION_H,
        kind: "update_model",
        botId: "bot-1",
        subject,
      } as BotLifecycleBeginInput),
      BotLifecycleJournalStateError,
    );
  }
});

test("production journal rejects corrupt JSON and symlink substitution", async () => {
  const paths = await temporaryRoot("aiden-bot-journal-invalid-");
  const outside = await mkdtemp(join(tmpdir(), "aiden-bot-journal-outside-"));
  try {
    const journal = createBotLifecycleJournal({ root: () => paths.root });
    await journal.begin(operations[3]!);
    const target = join(paths.root, BOT_LIFECYCLE_JOURNAL_FILENAME);
    await writeFile(target, "{broken", { mode: 0o600 });
    await assert.rejects(journal.listPending());

    await unlink(target);
    const outsideFile = join(outside, "journal.json");
    await writeFile(outsideFile, JSON.stringify({ version: 1, pending: [], completed: [] }), {
      mode: 0o600,
    });
    await symlink(outsideFile, target);
    await assert.rejects(journal.listPending(), /private regular file/u);
    assert.match(await readFile(outsideFile, "utf8"), /"version":1/u);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("committed journal writes survive unsupported directory fsync and repair modes", async () => {
  const paths = await temporaryRoot("aiden-bot-journal-durability-");
  const warnings: string[] = [];
  try {
    const journal = createBotLifecycleJournal({
      root: () => paths.root,
      syncDirectory: async () => {
        throw new Error("fsync unsupported");
      },
      onDurabilityWarning: (error) => warnings.push(error.message),
    });
    await journal.begin(operations[3]!);
    assert.deepEqual(warnings, ["fsync unsupported"]);
    const target = join(paths.root, BOT_LIFECYCLE_JOURNAL_FILENAME);
    await chmod(paths.root, 0o777);
    await chmod(target, 0o666);
    assert.equal((await journal.listPending()).length, 1);
    assert.equal(mode(await lstat(paths.root)), 0o700);
    assert.equal(mode(await lstat(target)), 0o600);
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
  }
});
