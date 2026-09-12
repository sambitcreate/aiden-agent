import { createHash } from "node:crypto";
import { DataStore } from "./data-store.js";
import { isDesignProjectOpaqueId } from "./design-project-contract.js";
import type { DesignProjectDeletePlanV1 } from "./design-project-store.js";

const JOURNAL_VERSION = 1 as const;
const JOURNAL_FILE = "design-project-lifecycle.json";
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_OPERATIONS = 100;
const HASH = /^[a-f0-9]{64}$/u;

export type DesignProjectDuplicateLifecycleRecordV1 = {
  version: typeof JOURNAL_VERSION;
  kind: "duplicate";
  operationId: string;
  revision: number;
  stage: "preparing" | "prepared";
  sourceProjectId: string;
  sourceProjectRevision: number;
  targetProjectId: string;
  targetChatId: string;
  startedAt: number;
  updatedAt: number;
};

export type DesignProjectDeleteLifecycleRecordV1 = {
  version: typeof JOURNAL_VERSION;
  kind: "delete";
  operationId: string;
  revision: number;
  stage: "planned" | "project-deleted";
  plan: DesignProjectDeletePlanV1;
  startedAt: number;
  updatedAt: number;
};

export type DesignProjectLifecycleRecordV1 =
  | DesignProjectDuplicateLifecycleRecordV1
  | DesignProjectDeleteLifecycleRecordV1;

interface DesignProjectLifecycleDocumentV1 {
  version: typeof JOURNAL_VERSION;
  revision: number;
  operations: DesignProjectLifecycleRecordV1[];
}

export interface DesignProjectLifecycleJournalPort {
  create(record: DesignProjectLifecycleRecordV1): Promise<DesignProjectLifecycleRecordV1>;
  replace(
    operationId: string,
    expectedRevision: number,
    record: DesignProjectLifecycleRecordV1,
  ): Promise<DesignProjectLifecycleRecordV1>;
  remove(operationId: string): Promise<void>;
  list(): Promise<DesignProjectLifecycleRecordV1[]>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const values = value.filter(isDesignProjectOpaqueId);
  return values.length === value.length && new Set(values).size === values.length
    ? values
    : undefined;
}

function parseDeletePlan(value: unknown): DesignProjectDeletePlanV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  if (
    !exactKeys(plan, [
      "version",
      "projectId",
      "expectedRevision",
      "expectedDatabaseRevision",
      "chatId",
      "artifactMediaIds",
      "detachedReferenceAssetIds",
      "unreferencedReferenceAssetIds",
      "commentIds",
      "designerActionIds",
    ]) ||
    plan.version !== 1 ||
    !isDesignProjectOpaqueId(plan.projectId) ||
    !safeInteger(plan.expectedRevision, 1) ||
    !safeInteger(plan.expectedDatabaseRevision, 0) ||
    !isDesignProjectOpaqueId(plan.chatId)
  ) {
    return undefined;
  }
  const artifactMediaIds = parseStringArray(plan.artifactMediaIds);
  const detachedReferenceAssetIds = parseStringArray(plan.detachedReferenceAssetIds);
  const unreferencedReferenceAssetIds = parseStringArray(plan.unreferencedReferenceAssetIds);
  const commentIds = parseStringArray(plan.commentIds);
  const designerActionIds = parseStringArray(plan.designerActionIds);
  if (
    !artifactMediaIds ||
    !detachedReferenceAssetIds ||
    !unreferencedReferenceAssetIds ||
    !commentIds ||
    !designerActionIds ||
    unreferencedReferenceAssetIds.some((id) => !detachedReferenceAssetIds.includes(id))
  ) {
    return undefined;
  }
  return {
    version: 1,
    projectId: plan.projectId as string,
    expectedRevision: plan.expectedRevision,
    expectedDatabaseRevision: plan.expectedDatabaseRevision,
    chatId: plan.chatId as string,
    artifactMediaIds,
    detachedReferenceAssetIds,
    unreferencedReferenceAssetIds,
    commentIds,
    designerActionIds,
  };
}

function parseRecord(value: unknown): DesignProjectLifecycleRecordV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== JOURNAL_VERSION ||
    typeof record.operationId !== "string" ||
    !HASH.test(record.operationId) ||
    !safeInteger(record.revision, 0) ||
    !safeInteger(record.startedAt, 0) ||
    !safeInteger(record.updatedAt, record.startedAt as number)
  ) {
    return undefined;
  }
  if (record.kind === "duplicate") {
    if (
      !exactKeys(record, [
        "version",
        "kind",
        "operationId",
        "revision",
        "stage",
        "sourceProjectId",
        "sourceProjectRevision",
        "targetProjectId",
        "targetChatId",
        "startedAt",
        "updatedAt",
      ]) ||
      (record.stage !== "preparing" && record.stage !== "prepared") ||
      !isDesignProjectOpaqueId(record.sourceProjectId) ||
      !safeInteger(record.sourceProjectRevision, 1) ||
      !isDesignProjectOpaqueId(record.targetProjectId) ||
      !isDesignProjectOpaqueId(record.targetChatId)
    ) {
      return undefined;
    }
    return record as DesignProjectDuplicateLifecycleRecordV1;
  }
  if (record.kind === "delete") {
    const plan = parseDeletePlan(record.plan);
    if (
      !exactKeys(record, [
        "version",
        "kind",
        "operationId",
        "revision",
        "stage",
        "plan",
        "startedAt",
        "updatedAt",
      ]) ||
      (record.stage !== "planned" && record.stage !== "project-deleted") ||
      !plan
    ) {
      return undefined;
    }
    return { ...record, plan } as DesignProjectDeleteLifecycleRecordV1;
  }
  return undefined;
}

function parseDocument(value: unknown): DesignProjectLifecycleDocumentV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  if (
    !exactKeys(document, ["version", "revision", "operations"]) ||
    document.version !== JOURNAL_VERSION ||
    !safeInteger(document.revision, 0) ||
    !Array.isArray(document.operations) ||
    document.operations.length > MAX_OPERATIONS
  ) {
    return undefined;
  }
  const operations = document.operations.map(parseRecord);
  if (operations.some((record) => !record)) return undefined;
  const parsed = operations as DesignProjectLifecycleRecordV1[];
  if (new Set(parsed.map(({ operationId }) => operationId)).size !== parsed.length) {
    return undefined;
  }
  return { version: JOURNAL_VERSION, revision: document.revision, operations: parsed };
}

function emptyDocument(): DesignProjectLifecycleDocumentV1 {
  return { version: JOURNAL_VERSION, revision: 0, operations: [] };
}

function sameOperation(
  left: DesignProjectLifecycleRecordV1,
  right: DesignProjectLifecycleRecordV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "duplicate" && right.kind === "duplicate") {
    return (
      left.sourceProjectId === right.sourceProjectId &&
      left.sourceProjectRevision === right.sourceProjectRevision &&
      left.targetProjectId === right.targetProjectId &&
      left.targetChatId === right.targetChatId
    );
  }
  return (
    left.kind === "delete" &&
    right.kind === "delete" &&
    JSON.stringify(left.plan) === JSON.stringify(right.plan)
  );
}

export function designProjectLifecycleOperationId(
  kind: DesignProjectLifecycleRecordV1["kind"],
  identity: string,
): string {
  return createHash("sha256").update(`design-project-${kind}\0${identity}`).digest("hex");
}

export class DesignProjectLifecycleJournalStore implements DesignProjectLifecycleJournalPort {
  private readonly data: DataStore<DesignProjectLifecycleDocumentV1>;

  constructor(root?: () => string) {
    this.data = new DataStore(JOURNAL_FILE, emptyDocument(), root, {
      maxBytes: MAX_JOURNAL_BYTES,
      fileMode: 0o600,
      normalize: (value) => parseDocument(value) ?? emptyDocument(),
      isSafe: (value) => parseDocument(value) !== undefined,
      reloadBeforeWrite: true,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    });
  }

  private async healthy(): Promise<DesignProjectLifecycleDocumentV1> {
    const document = await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      throw new Error("Design Project lifecycle recovery is corrupt and was preserved.");
    }
    if (await this.data.loadedFromUnsafeFile()) {
      throw new Error(
        "Design Project lifecycle recovery has an unsupported shape and was preserved.",
      );
    }
    return document;
  }

  async create(record: DesignProjectLifecycleRecordV1): Promise<DesignProjectLifecycleRecordV1> {
    const parsed = parseRecord(record);
    if (!parsed) throw new Error("Invalid Design Project lifecycle operation.");
    await this.healthy();
    return this.data.update((document) => {
      const existing = document.operations.find(
        ({ operationId }) => operationId === parsed.operationId,
      );
      if (existing) {
        if (!sameOperation(existing, parsed)) {
          throw new Error("Design Project lifecycle operation identity was reused.");
        }
        return structuredClone(existing);
      }
      if (document.operations.length >= MAX_OPERATIONS) {
        throw new Error("Design Project lifecycle recovery is at capacity.");
      }
      document.operations.push(structuredClone(parsed));
      document.revision += 1;
      return structuredClone(parsed);
    });
  }

  async replace(
    operationId: string,
    expectedRevision: number,
    record: DesignProjectLifecycleRecordV1,
  ): Promise<DesignProjectLifecycleRecordV1> {
    const parsed = parseRecord(record);
    if (!parsed || parsed.operationId !== operationId || parsed.revision !== expectedRevision + 1) {
      throw new Error("Invalid Design Project lifecycle transition.");
    }
    await this.healthy();
    return this.data.update((document) => {
      const index = document.operations.findIndex((entry) => entry.operationId === operationId);
      const current = document.operations[index];
      if (!current || current.revision !== expectedRevision || !sameOperation(current, parsed)) {
        throw new Error("Design Project lifecycle operation changed before transition.");
      }
      const allowed =
        current.kind === parsed.kind &&
        ((current.kind === "duplicate" &&
          current.stage === "preparing" &&
          parsed.stage === "prepared") ||
          (current.kind === "delete" &&
            current.stage === "planned" &&
            parsed.stage === "project-deleted"));
      if (
        !allowed ||
        parsed.startedAt !== current.startedAt ||
        parsed.updatedAt < current.updatedAt
      ) {
        throw new Error("Invalid Design Project lifecycle transition.");
      }
      document.operations[index] = structuredClone(parsed);
      document.revision += 1;
      return structuredClone(parsed);
    });
  }

  async remove(operationId: string): Promise<void> {
    await this.healthy();
    await this.data.update((document) => {
      const before = document.operations.length;
      document.operations = document.operations.filter(
        (entry) => entry.operationId !== operationId,
      );
      if (document.operations.length !== before) document.revision += 1;
    });
  }

  async list(): Promise<DesignProjectLifecycleRecordV1[]> {
    return structuredClone((await this.healthy()).operations);
  }
}
