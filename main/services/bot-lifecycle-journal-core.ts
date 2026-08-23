import {
  BOT_MANAGED_IDENTIFIER_CHARS,
  isBotManagedWorkspaceId,
  isPathSafeBotManagedIdentifier,
} from "./bot-managed-workspace-core.js";

export const BOT_LIFECYCLE_JOURNAL_VERSION = 2 as const;
export const BOT_LIFECYCLE_JOURNAL_LIMIT = 512;

export type BotLifecycleKind =
  | "create_bot"
  | "create_chat"
  | "copy_chat"
  | "delete_chat"
  | "archive_bot"
  | "restore_bot";

export type BotLifecycleStage =
  | "prepared"
  | "workspace_provisioned"
  | "identity_committed"
  | "policy_committed"
  | "chat_committed"
  | "authority_fenced"
  | "authority_archived"
  | "chat_deleted"
  | "policy_removed"
  | "identity_archived"
  | "identity_restored"
  | "authority_restored";

export type BotLifecycleSubject =
  | { workspaceId: string; workspaceCreatedAt: number }
  | { sourceChatId: string; targetChatId: string }
  | { chatId: string; workspaceId: string }
  | { chatId: string }
  | { expectedRevision: string };

export interface BotLifecycleOperation {
  operationId: string;
  kind: BotLifecycleKind;
  botId: string;
  subject: BotLifecycleSubject;
  stage: BotLifecycleStage;
  startedAt: number;
  updatedAt: number;
}

export interface CompletedBotLifecycleOperation {
  operationId: string;
  kind: BotLifecycleKind;
  botId: string;
  subject: BotLifecycleSubject;
  outcome: "committed" | "rolled_back";
  terminalStage: BotLifecycleStage;
  completedAt: number;
}

export interface BotLifecycleJournalDocument {
  version: typeof BOT_LIFECYCLE_JOURNAL_VERSION;
  pending: BotLifecycleOperation[];
  completed: CompletedBotLifecycleOperation[];
}

export type BotLifecycleBeginInput =
  | {
      operationId: string;
      kind: "create_bot";
      botId: string;
      subject: { workspaceId: string; workspaceCreatedAt: number };
    }
  | {
      operationId: string;
      kind: "create_chat";
      botId: string;
      subject: { chatId: string; workspaceId: string };
    }
  | {
      operationId: string;
      kind: "copy_chat";
      botId: string;
      subject: { sourceChatId: string; targetChatId: string };
    }
  | {
      operationId: string;
      kind: "delete_chat";
      botId: string;
      subject: { chatId: string };
    }
  | {
      operationId: string;
      kind: "archive_bot" | "restore_bot";
      botId: string;
      subject: { expectedRevision: string };
    };

export type BotLifecycleLookup =
  | { status: "pending"; operation: BotLifecycleOperation }
  | { status: "completed"; operation: CompletedBotLifecycleOperation };

export interface BotLifecycleJournalStorage {
  read(): Promise<unknown | null>;
  write(document: BotLifecycleJournalDocument): Promise<void>;
}

export interface BotLifecycleJournalCoreOptions {
  storage: BotLifecycleJournalStorage;
  now?: () => number;
}

export class BotLifecycleJournalStateError extends Error {
  readonly name = "BotLifecycleJournalStateError";
}

export class BotLifecycleJournalConflictError extends Error {
  readonly name = "BotLifecycleJournalConflictError";
}

const STAGES: Readonly<Record<BotLifecycleKind, readonly BotLifecycleStage[]>> = {
  // Identity is the visible commit point. Before it exists, recovery can safely
  // roll back the journal-addressed home and policy without persisting editable
  // identity or Custom-policy payloads in this private coordination file.
  create_bot: ["prepared", "workspace_provisioned", "policy_committed", "identity_committed"],
  create_chat: ["prepared", "policy_committed", "chat_committed"],
  copy_chat: ["prepared", "policy_committed", "chat_committed"],
  delete_chat: ["prepared", "authority_fenced", "chat_deleted", "policy_removed"],
  archive_bot: ["prepared", "authority_archived", "identity_archived"],
  restore_bot: ["prepared", "identity_restored", "authority_restored"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOperationId(value: unknown): value is string {
  return isBotManagedWorkspaceId(value);
}

function isChatId(value: unknown): value is string {
  return (
    isPathSafeBotManagedIdentifier(value) &&
    (value as string).length <= BOT_MANAGED_IDENTIFIER_CHARS
  );
}

function parseKind(value: unknown): BotLifecycleKind {
  if (
    value === "create_bot" ||
    value === "create_chat" ||
    value === "copy_chat" ||
    value === "delete_chat" ||
    value === "archive_bot" ||
    value === "restore_bot"
  ) {
    return value;
  }
  throw new BotLifecycleJournalStateError("Bot lifecycle journal contains an unknown operation.");
}

function parseSubject(kind: BotLifecycleKind, value: unknown): BotLifecycleSubject {
  if (!isRecord(value)) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal subject is corrupt.");
  }
  switch (kind) {
    case "create_bot":
      if (
        !hasExactKeys(value, ["workspaceId", "workspaceCreatedAt"]) ||
        !isBotManagedWorkspaceId(value.workspaceId) ||
        !isTimestamp(value.workspaceCreatedAt)
      ) {
        throw new BotLifecycleJournalStateError("Bot create lifecycle subject is corrupt.");
      }
      return { workspaceId: value.workspaceId, workspaceCreatedAt: value.workspaceCreatedAt };
    case "copy_chat":
      if (
        !hasExactKeys(value, ["sourceChatId", "targetChatId"]) ||
        !isChatId(value.sourceChatId) ||
        !isChatId(value.targetChatId) ||
        value.sourceChatId === value.targetChatId
      ) {
        throw new BotLifecycleJournalStateError("Bot copy lifecycle subject is corrupt.");
      }
      return { sourceChatId: value.sourceChatId, targetChatId: value.targetChatId };
    case "create_chat":
      if (
        !hasExactKeys(value, ["chatId", "workspaceId"]) ||
        !isChatId(value.chatId) ||
        !isBotManagedWorkspaceId(value.workspaceId)
      ) {
        throw new BotLifecycleJournalStateError("Bot chat-create lifecycle subject is corrupt.");
      }
      return { chatId: value.chatId, workspaceId: value.workspaceId };
    case "delete_chat":
      if (!hasExactKeys(value, ["chatId"]) || !isChatId(value.chatId)) {
        throw new BotLifecycleJournalStateError("Bot delete lifecycle subject is corrupt.");
      }
      return { chatId: value.chatId };
    case "archive_bot":
    case "restore_bot":
      if (
        !hasExactKeys(value, ["expectedRevision"]) ||
        typeof value.expectedRevision !== "string" ||
        value.expectedRevision.length === 0 ||
        value.expectedRevision.length > 256 ||
        value.expectedRevision.normalize("NFKC") !== value.expectedRevision ||
        !/^[A-Za-z0-9:_-]+$/u.test(value.expectedRevision)
      ) {
        throw new BotLifecycleJournalStateError("Bot lifecycle subject is corrupt.");
      }
      return { expectedRevision: value.expectedRevision };
  }
}

function parseBase(value: Record<string, unknown>): {
  operationId: string;
  kind: BotLifecycleKind;
  botId: string;
  subject: BotLifecycleSubject;
} {
  const kind = parseKind(value.kind);
  if (!isOperationId(value.operationId) || !isPathSafeBotManagedIdentifier(value.botId)) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal identifiers are corrupt.");
  }
  return {
    operationId: value.operationId,
    kind,
    botId: value.botId,
    subject: parseSubject(kind, value.subject),
  };
}

function parsePending(value: unknown): BotLifecycleOperation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operationId",
      "kind",
      "botId",
      "subject",
      "stage",
      "startedAt",
      "updatedAt",
    ])
  ) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal entry is corrupt.");
  }
  const base = parseBase(value);
  if (
    !STAGES[base.kind].includes(value.stage as BotLifecycleStage) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.startedAt
  ) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal checkpoint is corrupt.");
  }
  return {
    ...base,
    stage: value.stage as BotLifecycleStage,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}

function parseCompleted(value: unknown): CompletedBotLifecycleOperation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operationId",
      "kind",
      "botId",
      "subject",
      "outcome",
      "terminalStage",
      "completedAt",
    ])
  ) {
    throw new BotLifecycleJournalStateError("Completed Bot lifecycle entry is corrupt.");
  }
  const base = parseBase(value);
  if (
    (value.outcome !== "committed" && value.outcome !== "rolled_back") ||
    !STAGES[base.kind].includes(value.terminalStage as BotLifecycleStage) ||
    !isTimestamp(value.completedAt)
  ) {
    throw new BotLifecycleJournalStateError("Completed Bot lifecycle timestamp is corrupt.");
  }
  const stages = STAGES[base.kind];
  const finalStage = stages[stages.length - 1]!;
  if (
    (value.outcome === "committed" && value.terminalStage !== finalStage) ||
    (value.outcome === "rolled_back" && value.terminalStage === finalStage)
  ) {
    throw new BotLifecycleJournalStateError("Completed Bot lifecycle outcome is corrupt.");
  }
  return {
    ...base,
    outcome: value.outcome,
    terminalStage: value.terminalStage as BotLifecycleStage,
    completedAt: value.completedAt,
  };
}

export function parseBotLifecycleJournalDocument(value: unknown): BotLifecycleJournalDocument {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "pending", "completed"])) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal is corrupt.");
  }
  if (value.version !== BOT_LIFECYCLE_JOURNAL_VERSION) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal version is unsupported.");
  }
  if (
    !Array.isArray(value.pending) ||
    !Array.isArray(value.completed) ||
    value.pending.length > BOT_LIFECYCLE_JOURNAL_LIMIT ||
    value.completed.length > BOT_LIFECYCLE_JOURNAL_LIMIT
  ) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal is corrupt.");
  }
  const pending = value.pending.map(parsePending);
  const completed = value.completed.map(parseCompleted);
  const identifiers = [...pending, ...completed].map(({ operationId }) => operationId);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new BotLifecycleJournalStateError("Bot lifecycle journal contains duplicate operations.");
  }
  return { version: BOT_LIFECYCLE_JOURNAL_VERSION, pending, completed };
}

function cloneSubject(subject: BotLifecycleSubject): BotLifecycleSubject {
  return { ...subject } as BotLifecycleSubject;
}

function clonePending(operation: BotLifecycleOperation): BotLifecycleOperation {
  return { ...operation, subject: cloneSubject(operation.subject) };
}

function cloneCompleted(operation: CompletedBotLifecycleOperation): CompletedBotLifecycleOperation {
  return { ...operation, subject: cloneSubject(operation.subject) };
}

function cloneDocument(document: BotLifecycleJournalDocument): BotLifecycleJournalDocument {
  return {
    version: BOT_LIFECYCLE_JOURNAL_VERSION,
    pending: document.pending.map(clonePending),
    completed: document.completed.map(cloneCompleted),
  };
}

function parseBeginInput(input: BotLifecycleBeginInput): BotLifecycleBeginInput {
  if (!isRecord(input)) {
    throw new BotLifecycleJournalStateError("Bot lifecycle operation is invalid.");
  }
  const expectedKeys = ["operationId", "kind", "botId", "subject"];
  if (!hasExactKeys(input, expectedKeys)) {
    throw new BotLifecycleJournalStateError("Bot lifecycle operation is invalid.");
  }
  const base = parseBase(input);
  return base as BotLifecycleBeginInput;
}

function sameOperation(
  existing: Pick<BotLifecycleOperation, "operationId" | "kind" | "botId" | "subject">,
  input: BotLifecycleBeginInput,
): boolean {
  return (
    existing.operationId === input.operationId &&
    existing.kind === input.kind &&
    existing.botId === input.botId &&
    JSON.stringify(existing.subject) === JSON.stringify(input.subject)
  );
}

export function createBotLifecycleJournalCore(options: BotLifecycleJournalCoreOptions) {
  const now = options.now ?? Date.now;
  let mutationTail: Promise<void> = Promise.resolve();

  const serialized = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const load = async (): Promise<BotLifecycleJournalDocument> => {
    const raw = await options.storage.read();
    return raw === null
      ? { version: BOT_LIFECYCLE_JOURNAL_VERSION, pending: [], completed: [] }
      : parseBotLifecycleJournalDocument(raw);
  };

  const timestamp = (): number => {
    const value = now();
    if (!isTimestamp(value)) {
      throw new BotLifecycleJournalStateError("Bot lifecycle timestamp is invalid.");
    }
    return value;
  };

  return {
    begin(input: BotLifecycleBeginInput): Promise<BotLifecycleLookup> {
      return serialized(async () => {
        const validated = parseBeginInput(input);
        const document = await load();
        const pending = document.pending.find(
          ({ operationId }) => operationId === validated.operationId,
        );
        if (pending) {
          if (!sameOperation(pending, validated)) {
            throw new BotLifecycleJournalConflictError(
              "Bot lifecycle operation identifier was reused for another mutation.",
            );
          }
          return { status: "pending", operation: clonePending(pending) };
        }
        const completed = document.completed.find(
          ({ operationId }) => operationId === validated.operationId,
        );
        if (completed) {
          if (!sameOperation(completed, validated)) {
            throw new BotLifecycleJournalConflictError(
              "Completed Bot lifecycle operation identifier was reused.",
            );
          }
          return { status: "completed", operation: cloneCompleted(completed) };
        }
        if (document.pending.length >= BOT_LIFECYCLE_JOURNAL_LIMIT) {
          throw new BotLifecycleJournalStateError("Too many Bot lifecycle operations are pending.");
        }
        const startedAt = timestamp();
        const operation: BotLifecycleOperation = {
          ...validated,
          subject: cloneSubject(validated.subject),
          stage: "prepared",
          startedAt,
          updatedAt: startedAt,
        };
        const next = cloneDocument(document);
        next.pending.push(operation);
        await options.storage.write(next);
        return { status: "pending", operation: clonePending(operation) };
      });
    },

    checkpoint(
      operationId: string,
      expected: BotLifecycleStage,
      nextStage: BotLifecycleStage,
    ): Promise<BotLifecycleOperation> {
      return serialized(async () => {
        if (!isOperationId(operationId)) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation identifier is invalid.");
        }
        const document = await load();
        const operation = document.pending.find((entry) => entry.operationId === operationId);
        if (!operation) {
          if (document.completed.some((entry) => entry.operationId === operationId)) {
            throw new BotLifecycleJournalConflictError(
              "Completed Bot lifecycle operations cannot be advanced.",
            );
          }
          throw new BotLifecycleJournalStateError("Bot lifecycle operation is missing.");
        }
        const stages = STAGES[operation.kind];
        const expectedIndex = stages.indexOf(expected);
        if (expectedIndex < 0 || stages[expectedIndex + 1] !== nextStage) {
          throw new BotLifecycleJournalStateError(
            "Bot lifecycle checkpoint would skip or reverse a durable boundary.",
          );
        }
        if (operation.stage === nextStage) return clonePending(operation);
        if (operation.stage !== expected) {
          throw new BotLifecycleJournalConflictError(
            "Bot lifecycle operation changed before this checkpoint.",
          );
        }
        const next = cloneDocument(document);
        const durable = next.pending.find((entry) => entry.operationId === operationId)!;
        durable.stage = nextStage;
        durable.updatedAt = timestamp();
        await options.storage.write(next);
        return clonePending(durable);
      });
    },

    complete(operationId: string, expectedFinalStage: BotLifecycleStage): Promise<void> {
      return serialized(async () => {
        if (!isOperationId(operationId)) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation identifier is invalid.");
        }
        const document = await load();
        const completed = document.completed.find((entry) => entry.operationId === operationId);
        if (completed) {
          if (completed.outcome !== "committed") {
            throw new BotLifecycleJournalConflictError(
              "A rolled-back Bot lifecycle operation cannot be committed.",
            );
          }
          const completedStages = STAGES[completed.kind];
          if (
            expectedFinalStage !== completedStages[completedStages.length - 1] ||
            completed.terminalStage !== expectedFinalStage
          ) {
            throw new BotLifecycleJournalConflictError(
              "Completed Bot lifecycle operation used a mismatched final checkpoint.",
            );
          }
          return;
        }
        const index = document.pending.findIndex((entry) => entry.operationId === operationId);
        if (index < 0) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation is missing.");
        }
        const operation = document.pending[index]!;
        const stages = STAGES[operation.kind];
        if (
          operation.stage !== expectedFinalStage ||
          expectedFinalStage !== stages[stages.length - 1]
        ) {
          throw new BotLifecycleJournalConflictError(
            "Bot lifecycle operation has not reached its final durable checkpoint.",
          );
        }
        const next = cloneDocument(document);
        next.pending.splice(index, 1);
        next.completed.push({
          operationId: operation.operationId,
          kind: operation.kind,
          botId: operation.botId,
          subject: cloneSubject(operation.subject),
          outcome: "committed",
          terminalStage: operation.stage,
          completedAt: timestamp(),
        });
        next.completed.sort((left, right) => left.completedAt - right.completedAt);
        if (next.completed.length > BOT_LIFECYCLE_JOURNAL_LIMIT) {
          next.completed.splice(0, next.completed.length - BOT_LIFECYCLE_JOURNAL_LIMIT);
        }
        await options.storage.write(next);
      });
    },

    rollback(operationId: string, expectedCurrentStage: BotLifecycleStage): Promise<void> {
      return serialized(async () => {
        if (!isOperationId(operationId)) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation identifier is invalid.");
        }
        const document = await load();
        const completed = document.completed.find((entry) => entry.operationId === operationId);
        if (completed) {
          if (
            completed.outcome !== "rolled_back" ||
            completed.terminalStage !== expectedCurrentStage
          ) {
            throw new BotLifecycleJournalConflictError(
              "Bot lifecycle operation already ended with another outcome.",
            );
          }
          return;
        }
        const index = document.pending.findIndex((entry) => entry.operationId === operationId);
        if (index < 0) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation is missing.");
        }
        const operation = document.pending[index]!;
        const stages = STAGES[operation.kind];
        const finalStage = stages[stages.length - 1]!;
        if (!stages.includes(expectedCurrentStage) || operation.stage !== expectedCurrentStage) {
          throw new BotLifecycleJournalConflictError(
            "Bot lifecycle operation changed before rollback.",
          );
        }
        if (operation.stage === finalStage) {
          throw new BotLifecycleJournalConflictError(
            "A visible Bot lifecycle commit cannot be rolled back.",
          );
        }
        const next = cloneDocument(document);
        next.pending.splice(index, 1);
        next.completed.push({
          operationId: operation.operationId,
          kind: operation.kind,
          botId: operation.botId,
          subject: cloneSubject(operation.subject),
          outcome: "rolled_back",
          terminalStage: operation.stage,
          completedAt: timestamp(),
        });
        next.completed.sort((left, right) => left.completedAt - right.completedAt);
        if (next.completed.length > BOT_LIFECYCLE_JOURNAL_LIMIT) {
          next.completed.splice(0, next.completed.length - BOT_LIFECYCLE_JOURNAL_LIMIT);
        }
        await options.storage.write(next);
      });
    },

    lookup(operationId: string): Promise<BotLifecycleLookup | null> {
      return serialized(async () => {
        if (!isOperationId(operationId)) {
          throw new BotLifecycleJournalStateError("Bot lifecycle operation identifier is invalid.");
        }
        const document = await load();
        const pending = document.pending.find((entry) => entry.operationId === operationId);
        if (pending) return { status: "pending", operation: clonePending(pending) };
        const completed = document.completed.find((entry) => entry.operationId === operationId);
        return completed ? { status: "completed", operation: cloneCompleted(completed) } : null;
      });
    },

    listPending(): Promise<readonly BotLifecycleOperation[]> {
      return serialized(async () => {
        const document = await load();
        return document.pending
          .map(clonePending)
          .sort((left, right) => left.startedAt - right.startedAt);
      });
    },
  };
}

export type BotLifecycleJournalCore = ReturnType<typeof createBotLifecycleJournalCore>;

export interface BotLifecycleReconciliationOptions {
  journal: Pick<BotLifecycleJournalCore, "listPending">;
  handlers: Partial<Record<BotLifecycleKind, (operation: BotLifecycleOperation) => Promise<void>>>;
  onError?(operation: BotLifecycleOperation, error: unknown): void;
}

/**
 * Replay pending operations in durable admission order. Handlers own checkpoint
 * advancement and completion so a failed repair remains visible next startup.
 */
export async function reconcilePendingBotLifecycles(
  options: BotLifecycleReconciliationOptions,
): Promise<void> {
  for (const operation of await options.journal.listPending()) {
    try {
      const handler = options.handlers[operation.kind];
      if (!handler) {
        throw new BotLifecycleJournalStateError(
          `No reconciliation handler is registered for ${operation.kind}.`,
        );
      }
      await handler(clonePending(operation));
    } catch (error) {
      options.onError?.(clonePending(operation), error);
    }
  }
}
