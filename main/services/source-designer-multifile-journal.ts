import { DataStore } from "./data-store.js";
import {
  SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT,
  SOURCE_DESIGNER_MULTIFILE_VERSION,
  type SourceDesignerMultifileEffectPhase,
  type SourceDesignerMultifileFileV1,
  type SourceDesignerMultifileJournalV1,
  type SourceDesignerMultifileRecordV1,
  type SourceDesignerMultifileStage,
  parseSourceDesignerMultifileJournal,
  parseSourceDesignerMultifileRecord,
} from "./source-designer-multifile-contract.js";

export const SOURCE_DESIGNER_MULTIFILE_JOURNAL_FILENAME = "source-designer-multifile-actions.json";
export const SOURCE_DESIGNER_MULTIFILE_JOURNAL_MAX_BYTES = 24 * 1024 * 1024;

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const TERMINAL_STAGES = new Set<SourceDesignerMultifileStage>([
  "committed",
  "rolled-back",
  "undone",
]);
const INTERRUPTED_STAGES = new Set<SourceDesignerMultifileStage>([
  "applying",
  "verifying",
  "rolling-back",
  "undoing",
]);
const NEXT_STAGES: Readonly<
  Record<SourceDesignerMultifileStage, readonly SourceDesignerMultifileStage[]>
> = {
  prepared: ["applying", "recoverable"],
  applying: ["applying", "verifying", "rolling-back", "recoverable"],
  verifying: ["committed", "rolling-back", "recoverable"],
  committed: ["undoing", "recoverable"],
  "rolling-back": ["rolling-back", "rolled-back", "recoverable"],
  "rolled-back": [],
  undoing: ["undoing", "undone", "recoverable"],
  undone: [],
  recoverable: [],
};
const NEXT_PHASE: Readonly<
  Record<SourceDesignerMultifileEffectPhase, SourceDesignerMultifileEffectPhase | null>
> = {
  pending: "write-intent",
  "write-intent": "verifying",
  verifying: "verified",
  verified: null,
};

export class SourceDesignerMultifileJournalConflictError extends Error {
  readonly name = "SourceDesignerMultifileJournalConflictError";
}

export interface SourceDesignerMultifileJournalPort {
  get(actionId: string): Promise<SourceDesignerMultifileRecordV1 | null>;
  create(record: SourceDesignerMultifileRecordV1): Promise<SourceDesignerMultifileRecordV1>;
  replace(
    actionId: string,
    expectedRevision: number,
    next: SourceDesignerMultifileRecordV1,
  ): Promise<SourceDesignerMultifileRecordV1>;
  listInterrupted(): Promise<SourceDesignerMultifileRecordV1[]>;
  listProject?(projectId: string): Promise<SourceDesignerMultifileRecordV1[]>;
  remove?(actionId: string): Promise<void>;
}

function emptyJournal(): SourceDesignerMultifileJournalV1 {
  return { version: SOURCE_DESIGNER_MULTIFILE_VERSION, actions: [] };
}

function immutableFile(file: SourceDesignerMultifileFileV1): unknown {
  return {
    path: file.path,
    before: file.before,
    after: file.after,
    applyEffectId: file.apply.effectId,
    rollbackEffectId: file.rollback.effectId,
    undoEffectId: file.undo.effectId,
  };
}

function immutableRecord(record: SourceDesignerMultifileRecordV1): unknown {
  return {
    version: record.version,
    actionId: record.actionId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    chatId: record.chatId,
    projectRevision: record.projectRevision,
    sourceNodeId: record.sourceNodeId,
    sourceSelectionId: record.sourceSelectionId,
    sourceManifestHash: record.sourceManifestHash,
    sourcePath: record.sourcePath,
    sourceStart: record.sourceStart,
    sourceEnd: record.sourceEnd,
    sourceLineNumber: record.sourceLineNumber,
    sourceColumnNumber: record.sourceColumnNumber,
    sourceComponentName: record.sourceComponentName,
    sourceSelector: record.sourceSelector,
    sourceTagName: record.sourceTagName,
    sourceElementId: record.sourceElementId,
    sourceAfterManifestHash: record.sourceAfterManifestHash,
    sourceAfterVersion: record.sourceAfterVersion,
    sourceAfterStart: record.sourceAfterStart,
    sourceAfterEnd: record.sourceAfterEnd,
    sourceAfterLineNumber: record.sourceAfterLineNumber,
    sourceAfterColumnNumber: record.sourceAfterColumnNumber,
    rootFingerprint: record.rootFingerprint,
    label: record.label,
    createdAt: record.createdAt,
    files: record.files.map(immutableFile),
  };
}

function assertOnePhaseAdvance(
  previous: SourceDesignerMultifileRecordV1,
  next: SourceDesignerMultifileRecordV1,
  field: "apply" | "rollback" | "undo",
): void {
  let changes = 0;
  let changedIndex = -1;
  for (let index = 0; index < previous.files.length; index += 1) {
    const before = previous.files[index]![field].phase;
    const after = next.files[index]![field].phase;
    if (before === after) continue;
    changes += 1;
    changedIndex = index;
    if (NEXT_PHASE[before] !== after) {
      throw new SourceDesignerMultifileJournalConflictError(
        "The Designer Action effect phase transition is invalid.",
      );
    }
  }
  if (changes !== 1) {
    throw new SourceDesignerMultifileJournalConflictError(
      "A Designer Action checkpoint must advance exactly one file effect.",
    );
  }
  let expectedIndex = previous.files.findIndex((file) => file[field].phase !== "verified");
  if (field !== "apply") {
    expectedIndex = -1;
    for (let index = previous.files.length - 1; index >= 0; index -= 1) {
      if (previous.files[index]![field].phase !== "verified") {
        expectedIndex = index;
        break;
      }
    }
  }
  if (changedIndex !== expectedIndex) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action file effects must advance in deterministic order.",
    );
  }
}

function phases(
  record: SourceDesignerMultifileRecordV1,
  field: "apply" | "rollback" | "undo",
): string {
  return record.files.map((file) => file[field].phase).join("\0");
}

export function assertSourceDesignerMultifileJournalTransition(
  previous: SourceDesignerMultifileRecordV1,
  next: SourceDesignerMultifileRecordV1,
): void {
  parseSourceDesignerMultifileRecord(previous);
  parseSourceDesignerMultifileRecord(next);
  if (
    JSON.stringify(immutableRecord(previous)) !== JSON.stringify(immutableRecord(next)) ||
    next.revision !== previous.revision + 1 ||
    next.updatedAt < previous.updatedAt ||
    !NEXT_STAGES[previous.stage].includes(next.stage)
  ) {
    throw new SourceDesignerMultifileJournalConflictError(
      "The Designer Action journal transition is invalid.",
    );
  }
  if (previous.recovery) {
    const previousConflicts = new Map(
      previous.recovery.conflicts.map((conflict) => [conflict.path, conflict] as const),
    );
    const nextConflicts = new Map(
      next.recovery?.conflicts.map((conflict) => [conflict.path, conflict] as const) ?? [],
    );
    if (
      next.recovery?.kind !== previous.recovery.kind ||
      [...previousConflicts].some(
        ([path, conflict]) => JSON.stringify(nextConflicts.get(path)) !== JSON.stringify(conflict),
      )
    ) {
      throw new SourceDesignerMultifileJournalConflictError(
        "A recorded Designer Action recovery cause cannot change or be cleared.",
      );
    }
  }
  if (
    next.recovery &&
    next.stage !== "rolling-back" &&
    next.stage !== "rolled-back" &&
    next.stage !== "recoverable"
  ) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action recovery details are invalid for this stage.",
    );
  }

  const applyChanged = phases(previous, "apply") !== phases(next, "apply");
  const rollbackChanged = phases(previous, "rollback") !== phases(next, "rollback");
  const undoChanged = phases(previous, "undo") !== phases(next, "undo");
  const changedGroups = Number(applyChanged) + Number(rollbackChanged) + Number(undoChanged);

  if (previous.stage === next.stage) {
    const field =
      next.stage === "applying"
        ? "apply"
        : next.stage === "rolling-back"
          ? "rollback"
          : next.stage === "undoing"
            ? "undo"
            : undefined;
    if (!field || changedGroups !== 1) {
      throw new SourceDesignerMultifileJournalConflictError(
        "The Designer Action same-stage checkpoint is invalid.",
      );
    }
    assertOnePhaseAdvance(previous, next, field);
    return;
  }

  if (changedGroups !== 0) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action stage changes cannot also change file effects.",
    );
  }

  const allApplyVerified = next.files.every(({ apply }) => apply.phase === "verified");
  const allRollbackVerified = next.files.every(({ rollback }) => rollback.phase === "verified");
  const allUndoVerified = next.files.every(({ undo }) => undo.phase === "verified");
  if (
    (["verifying", "committed", "undoing"] as SourceDesignerMultifileStage[]).includes(
      next.stage,
    ) &&
    !allApplyVerified
  ) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action apply effects are incomplete for this stage.",
    );
  }
  if (next.stage === "rolled-back" && !allRollbackVerified) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action rollback effects are incomplete.",
    );
  }
  if (next.stage === "undone" && !allUndoVerified) {
    throw new SourceDesignerMultifileJournalConflictError(
      "Designer Action undo effects are incomplete.",
    );
  }
}

function sameBeginning(
  left: SourceDesignerMultifileRecordV1,
  right: SourceDesignerMultifileRecordV1,
): boolean {
  return JSON.stringify(immutableRecord(left)) === JSON.stringify(immutableRecord(right));
}

function evictTerminalUntilBound(document: SourceDesignerMultifileJournalV1): void {
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (
      document.actions.length <= SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT &&
      bytes <= MAX_DOCUMENT_BYTES
    ) {
      return;
    }
    const terminal = document.actions
      .filter(({ stage }) => TERMINAL_STAGES.has(stage))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (!terminal) {
      throw new Error("The Designer Action journal is full of active or recoverable transactions.");
    }
    document.actions = document.actions.filter(({ actionId }) => actionId !== terminal.actionId);
  }
}

export class SourceDesignerMultifileJournalStore implements SourceDesignerMultifileJournalPort {
  private readonly persistence: DataStore<SourceDesignerMultifileJournalV1>;

  constructor(rootResolver?: () => string) {
    this.persistence = new DataStore<SourceDesignerMultifileJournalV1>(
      SOURCE_DESIGNER_MULTIFILE_JOURNAL_FILENAME,
      emptyJournal(),
      rootResolver,
      {
        maxBytes: SOURCE_DESIGNER_MULTIFILE_JOURNAL_MAX_BYTES,
        fileMode: 0o600,
        normalize: parseSourceDesignerMultifileJournal,
        isSafe: (value) => {
          try {
            parseSourceDesignerMultifileJournal(value);
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
      throw new Error("The Designer Action journal is corrupt and was preserved for recovery.");
    }
    if (await this.persistence.loadedFromUnsafeFile()) {
      throw new Error("The Designer Action journal is unsafe and was preserved for recovery.");
    }
  }

  async get(actionId: string): Promise<SourceDesignerMultifileRecordV1 | null> {
    await this.healthy();
    const document = parseSourceDesignerMultifileJournal(await this.persistence.load());
    return structuredClone(document.actions.find((entry) => entry.actionId === actionId) ?? null);
  }

  async listProject(projectId: string): Promise<SourceDesignerMultifileRecordV1[]> {
    await this.healthy();
    const document = parseSourceDesignerMultifileJournal(await this.persistence.load());
    return structuredClone(
      document.actions
        .filter((entry) => entry.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }

  async create(record: SourceDesignerMultifileRecordV1): Promise<SourceDesignerMultifileRecordV1> {
    const parsed = parseSourceDesignerMultifileRecord(record);
    if (parsed.revision !== 0 || parsed.stage !== "prepared") {
      throw new SourceDesignerMultifileJournalConflictError(
        "A new Designer Action must begin at the prepared checkpoint.",
      );
    }
    await this.healthy();
    return this.persistence.update((draft) => {
      const document = parseSourceDesignerMultifileJournal(draft);
      const existing = document.actions.find(({ actionId }) => actionId === parsed.actionId);
      if (existing) {
        if (!sameBeginning(existing, parsed)) {
          throw new SourceDesignerMultifileJournalConflictError(
            "The Designer Action ID is already used by another transaction.",
          );
        }
        return structuredClone(existing);
      }
      document.actions.push(structuredClone(parsed));
      evictTerminalUntilBound(document);
      Object.assign(draft, document);
      return structuredClone(parsed);
    });
  }

  async replace(
    actionId: string,
    expectedRevision: number,
    next: SourceDesignerMultifileRecordV1,
  ): Promise<SourceDesignerMultifileRecordV1> {
    const parsed = parseSourceDesignerMultifileRecord(next);
    if (parsed.actionId !== actionId || parsed.revision !== expectedRevision + 1) {
      throw new SourceDesignerMultifileJournalConflictError(
        "The Designer Action replacement identity is invalid.",
      );
    }
    await this.healthy();
    return this.persistence.update((draft) => {
      const document = parseSourceDesignerMultifileJournal(draft);
      const index = document.actions.findIndex((entry) => entry.actionId === actionId);
      const previous = document.actions[index];
      if (!previous || previous.revision !== expectedRevision) {
        throw new SourceDesignerMultifileJournalConflictError(
          "The Designer Action changed before this checkpoint.",
        );
      }
      assertSourceDesignerMultifileJournalTransition(previous, parsed);
      document.actions[index] = structuredClone(parsed);
      Object.assign(draft, document);
      return structuredClone(parsed);
    });
  }

  async listInterrupted(): Promise<SourceDesignerMultifileRecordV1[]> {
    await this.healthy();
    const document = parseSourceDesignerMultifileJournal(await this.persistence.load());
    return document.actions
      .filter(({ stage }) => INTERRUPTED_STAGES.has(stage))
      .map((entry) => structuredClone(entry));
  }

  async remove(actionId: string): Promise<void> {
    await this.healthy();
    await this.persistence.update((draft) => {
      const document = parseSourceDesignerMultifileJournal(draft);
      document.actions = document.actions.filter((entry) => entry.actionId !== actionId);
      Object.assign(draft, document);
    });
  }
}
