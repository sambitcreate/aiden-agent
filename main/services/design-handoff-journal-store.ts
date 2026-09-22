import { DataStore } from "./data-store.js";
import {
  DESIGN_HANDOFF_JOURNAL_LIMIT,
  DESIGN_HANDOFF_JOURNAL_VERSION,
  type DesignHandoffJournalDocumentV1,
  type DesignHandoffJournalRecordV1,
  parseDesignHandoffJournalDocument,
  parseDesignHandoffJournalRecord,
} from "./design-handoff-contract.js";

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const TERMINAL_STAGES = new Set(["published", "rolled-back"]);
const NEXT_STAGES: Readonly<Record<DesignHandoffJournalRecordV1["stage"], readonly DesignHandoffJournalRecordV1["stage"][]>> = {
  prepared: ["workspace-ready", "rolling-back", "recoverable"],
  "workspace-ready": ["chat-ready", "rolling-back", "recoverable"],
  "chat-ready": ["context-ready", "rolling-back", "recoverable"],
  "context-ready": ["published", "rolling-back", "recoverable"],
  published: ["recoverable"],
  "rolling-back": ["rolled-back", "recoverable"],
  "rolled-back": [],
  recoverable: [],
};

export class DesignHandoffJournalConflictError extends Error {
  readonly name = "DesignHandoffJournalConflictError";
}

export interface DesignHandoffJournalPort {
  get(operationId: string): Promise<DesignHandoffJournalRecordV1 | null>;
  create(record: DesignHandoffJournalRecordV1): Promise<DesignHandoffJournalRecordV1>;
  replace(
    operationId: string,
    expectedRevision: number,
    next: DesignHandoffJournalRecordV1,
  ): Promise<DesignHandoffJournalRecordV1>;
  listRecoverable(): Promise<DesignHandoffJournalRecordV1[]>;
}

function emptyDocument(): DesignHandoffJournalDocumentV1 {
  return { version: DESIGN_HANDOFF_JOURNAL_VERSION, operations: [] };
}

function sameBeginning(
  left: DesignHandoffJournalRecordV1,
  right: DesignHandoffJournalRecordV1,
): boolean {
  return left.operationId === right.operationId &&
    JSON.stringify(left.packet) === JSON.stringify(right.packet) &&
    JSON.stringify(left.target) === JSON.stringify(right.target);
}

function assertStoredTransition(
  previous: DesignHandoffJournalRecordV1,
  next: DesignHandoffJournalRecordV1,
): void {
  if (next.startedAt !== previous.startedAt || next.updatedAt < previous.updatedAt) {
    throw new DesignHandoffJournalConflictError("The handoff journal timestamps are invalid.");
  }
  if (previous.cancellationRequested && !next.cancellationRequested) {
    throw new DesignHandoffJournalConflictError("A handoff cancellation cannot be cleared.");
  }
  if (previous.stage === next.stage) {
    const before = { ...previous, revision: 0, updatedAt: 0, cancellationRequested: false };
    const after = { ...next, revision: 0, updatedAt: 0, cancellationRequested: false };
    if (
      previous.cancellationRequested || !next.cancellationRequested ||
      JSON.stringify(before) !== JSON.stringify(after)
    ) throw new DesignHandoffJournalConflictError("Only a cancellation request may retain the same handoff stage.");
    return;
  }
  if (!NEXT_STAGES[previous.stage].includes(next.stage)) {
    throw new DesignHandoffJournalConflictError("The handoff journal stage transition is invalid.");
  }
  if (previous.workspace && JSON.stringify(previous.workspace) !== JSON.stringify(next.workspace)) {
    throw new DesignHandoffJournalConflictError("The handoff workspace identity cannot change.");
  }
  if (previous.chat && JSON.stringify(previous.chat) !== JSON.stringify(next.chat)) {
    throw new DesignHandoffJournalConflictError("The handoff chat identity cannot change.");
  }
  if (previous.linkage && JSON.stringify(previous.linkage) !== JSON.stringify(next.linkage)) {
    throw new DesignHandoffJournalConflictError("The published handoff linkage cannot change.");
  }
}

function trimTerminalOperations(document: DesignHandoffJournalDocumentV1): void {
  if (document.operations.length < DESIGN_HANDOFF_JOURNAL_LIMIT) return;
  const terminal = document.operations
    .filter(({ stage }) => TERMINAL_STAGES.has(stage))
    .sort((left, right) => left.updatedAt - right.updatedAt)[0];
  if (!terminal) throw new Error("The design handoff journal is full of active or recoverable operations.");
  document.operations = document.operations.filter(({ operationId }) => operationId !== terminal.operationId);
}

export class DesignHandoffJournalStore implements DesignHandoffJournalPort {
  private readonly persistence: DataStore<DesignHandoffJournalDocumentV1>;

  constructor(rootResolver?: () => string) {
    this.persistence = new DataStore<DesignHandoffJournalDocumentV1>(
      "design-handoffs.json",
      emptyDocument(),
      rootResolver,
      {
        maxBytes: MAX_JOURNAL_BYTES,
        fileMode: 0o600,
        normalize: parseDesignHandoffJournalDocument,
        isSafe: (value) => {
          try {
            parseDesignHandoffJournalDocument(value);
            return true;
          } catch {
            return false;
          }
        },
        reloadBeforeWrite: true,
        rejectCorruptWrite: true,
        rejectUnsafeWrite: true,
      },
    );
  }

  private async healthy(): Promise<void> {
    await this.persistence.load();
    if (await this.persistence.loadedFromCorruptFile()) {
      throw new Error("The design handoff journal is corrupt and was preserved for recovery.");
    }
    if (await this.persistence.loadedFromUnsafeFile()) {
      throw new Error("The design handoff journal is unsafe and was preserved for recovery.");
    }
  }

  async get(operationId: string): Promise<DesignHandoffJournalRecordV1 | null> {
    await this.healthy();
    const document = parseDesignHandoffJournalDocument(await this.persistence.load());
    return structuredClone(document.operations.find((entry) => entry.operationId === operationId) ?? null);
  }

  async create(record: DesignHandoffJournalRecordV1): Promise<DesignHandoffJournalRecordV1> {
    const parsed = parseDesignHandoffJournalRecord(record);
    await this.healthy();
    return this.persistence.update((draft) => {
      const document = parseDesignHandoffJournalDocument(draft);
      const existing = document.operations.find(({ operationId }) => operationId === parsed.operationId);
      if (existing) {
        if (!sameBeginning(existing, parsed)) throw new DesignHandoffJournalConflictError("The handoff operation ID is already used by a different request.");
        return structuredClone(existing);
      }
      trimTerminalOperations(document);
      document.operations.push(structuredClone(parsed));
      Object.assign(draft, document);
      return structuredClone(parsed);
    });
  }

  async replace(
    operationId: string,
    expectedRevision: number,
    next: DesignHandoffJournalRecordV1,
  ): Promise<DesignHandoffJournalRecordV1> {
    const parsed = parseDesignHandoffJournalRecord(next);
    if (parsed.operationId !== operationId || parsed.revision !== expectedRevision + 1) {
      throw new DesignHandoffJournalConflictError("The handoff journal transition is invalid.");
    }
    await this.healthy();
    return this.persistence.update((draft) => {
      const document = parseDesignHandoffJournalDocument(draft);
      const index = document.operations.findIndex((entry) => entry.operationId === operationId);
      if (index < 0 || document.operations[index]!.revision !== expectedRevision) {
        throw new DesignHandoffJournalConflictError("The handoff journal changed before this transition.");
      }
      if (!sameBeginning(document.operations[index]!, parsed)) {
        throw new DesignHandoffJournalConflictError("The handoff request identity changed.");
      }
      assertStoredTransition(document.operations[index]!, parsed);
      document.operations[index] = structuredClone(parsed);
      Object.assign(draft, document);
      return structuredClone(parsed);
    });
  }

  async listRecoverable(): Promise<DesignHandoffJournalRecordV1[]> {
    await this.healthy();
    const document = parseDesignHandoffJournalDocument(await this.persistence.load());
    return document.operations
      .filter(({ stage }) => stage !== "published" && stage !== "rolled-back")
      .map((entry) => structuredClone(entry));
  }
}
