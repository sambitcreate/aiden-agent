import { DataStore } from "./data-store.js";
import {
  type DesignHandoffChatResult,
  type DesignHandoffLinkResult,
  type DesignHandoffPacketV1,
  type DesignHandoffWorkspaceResult,
  parseDesignHandoffPacket,
} from "./design-handoff-contract.js";

const EFFECT_STORE_VERSION = 1 as const;
const MAX_EFFECT_RECORDS = 128;
const MAX_EFFECT_STORE_BYTES = 2 * 1024 * 1024;

export interface DesignHandoffEffectIdentityV1 {
  operationId: string;
  targetKind: "managed-worktree" | "existing-workspace";
  targetPreviewDigest: string;
  sourceWorkspaceId: string;
  branchIntent?: string;
}

export interface DesignHandoffEffectRecordV1 extends DesignHandoffEffectIdentityV1 {
  version: typeof EFFECT_STORE_VERSION;
  revision: number;
  workspaceAttempted: boolean;
  workspace?: DesignHandoffWorkspaceResult;
  workspaceRolledBack: boolean;
  chatTitle?: string;
  chatAttempted: boolean;
  chat?: DesignHandoffChatResult;
  chatRolledBack: boolean;
  context?: DesignHandoffPacketV1;
  contextRolledBack: boolean;
  linkage?: DesignHandoffLinkResult;
  createdAt: number;
  updatedAt: number;
}

interface DesignHandoffEffectDocumentV1 {
  version: typeof EFFECT_STORE_VERSION;
  records: DesignHandoffEffectRecordV1[];
}

export class DesignHandoffEffectStoreConflictError extends Error {
  readonly name = "DesignHandoffEffectStoreConflictError";
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function safeString(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    value.normalize("NFKC") === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function safeId(value: unknown): value is string {
  return safeString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function safeDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseWorkspace(value: unknown): DesignHandoffWorkspaceResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    !exactKeys(
      input,
      ["workspaceId", "workspaceLabel", "branchLabel", "managed"],
      ["createdFromHead"],
    ) ||
    !safeId(input.workspaceId) ||
    !safeString(input.workspaceLabel, 160) ||
    !safeString(input.branchLabel, 160) ||
    typeof input.managed !== "boolean"
  )
    return undefined;
  if (input.managed && !safeCommit(input.createdFromHead)) return undefined;
  if (!input.managed && input.createdFromHead !== undefined) return undefined;
  return {
    workspaceId: input.workspaceId,
    workspaceLabel: input.workspaceLabel,
    branchLabel: input.branchLabel,
    managed: input.managed,
    ...(input.managed ? { createdFromHead: input.createdFromHead as string } : {}),
  };
}

function parseChat(value: unknown): DesignHandoffChatResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return exactKeys(input, ["chatId", "taskId"]) && safeId(input.chatId) && safeId(input.taskId)
    ? { chatId: input.chatId, taskId: input.taskId }
    : undefined;
}

function parseLink(value: unknown): DesignHandoffLinkResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    !exactKeys(input, ["projectId", "workspaceId", "chatId", "taskId", "branchLabel"]) ||
    !safeId(input.projectId) ||
    !safeId(input.workspaceId) ||
    !safeId(input.chatId) ||
    !safeId(input.taskId) ||
    !safeString(input.branchLabel, 160)
  )
    return undefined;
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    taskId: input.taskId,
    branchLabel: input.branchLabel,
  };
}

function parseRecord(value: unknown): DesignHandoffEffectRecordV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const required = [
    "version",
    "operationId",
    "revision",
    "targetKind",
    "targetPreviewDigest",
    "sourceWorkspaceId",
    "workspaceAttempted",
    "workspaceRolledBack",
    "chatAttempted",
    "chatRolledBack",
    "contextRolledBack",
    "createdAt",
    "updatedAt",
  ];
  const optional = ["branchIntent", "workspace", "chatTitle", "chat", "context", "linkage"];
  if (
    !exactKeys(input, required, optional) ||
    input.version !== EFFECT_STORE_VERSION ||
    !safeId(input.operationId) ||
    !safeInteger(input.revision) ||
    (input.targetKind !== "managed-worktree" && input.targetKind !== "existing-workspace") ||
    !safeDigest(input.targetPreviewDigest) ||
    !safeId(input.sourceWorkspaceId) ||
    !safeInteger(input.createdAt) ||
    !safeInteger(input.updatedAt) ||
    input.updatedAt < input.createdAt ||
    typeof input.workspaceAttempted !== "boolean" ||
    typeof input.workspaceRolledBack !== "boolean" ||
    typeof input.chatAttempted !== "boolean" ||
    typeof input.chatRolledBack !== "boolean" ||
    typeof input.contextRolledBack !== "boolean"
  )
    return undefined;
  if (input.branchIntent !== undefined && !safeString(input.branchIntent, 160)) return undefined;
  if ((input.targetKind === "managed-worktree") !== (input.branchIntent !== undefined))
    return undefined;
  if (input.chatTitle !== undefined && !safeString(input.chatTitle, 160)) return undefined;
  const workspace = input.workspace === undefined ? undefined : parseWorkspace(input.workspace);
  const chat = input.chat === undefined ? undefined : parseChat(input.chat);
  const linkage = input.linkage === undefined ? undefined : parseLink(input.linkage);
  let context: DesignHandoffPacketV1 | undefined;
  try {
    context = input.context === undefined ? undefined : parseDesignHandoffPacket(input.context);
  } catch {
    return undefined;
  }
  if (
    (input.workspace !== undefined && !workspace) ||
    (input.chat !== undefined && !chat) ||
    (input.linkage !== undefined && !linkage)
  )
    return undefined;
  if (
    (workspace && !input.workspaceAttempted) ||
    (chat && !input.chatAttempted) ||
    (chat && !workspace) ||
    (context && !chat) ||
    (linkage && !context)
  )
    return undefined;
  if (
    (input.workspaceRolledBack && workspace) ||
    (input.chatRolledBack && chat) ||
    (input.contextRolledBack && context) ||
    (linkage && (input.workspaceRolledBack || input.chatRolledBack))
  )
    return undefined;
  if (
    (workspace &&
      input.targetKind === "managed-worktree" &&
      (!workspace.managed || workspace.branchLabel !== input.branchIntent)) ||
    (workspace &&
      input.targetKind === "existing-workspace" &&
      (workspace.managed || workspace.workspaceId !== input.sourceWorkspaceId)) ||
    (chat && !input.chatTitle) ||
    (linkage &&
      (linkage.projectId !== context?.projectId ||
        linkage.workspaceId !== workspace?.workspaceId ||
        linkage.chatId !== chat?.chatId ||
        linkage.taskId !== chat?.taskId ||
        linkage.branchLabel !== workspace?.branchLabel))
  )
    return undefined;
  return structuredClone(input) as unknown as DesignHandoffEffectRecordV1;
}

function parseDocument(value: unknown): DesignHandoffEffectDocumentV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    !exactKeys(input, ["version", "records"]) ||
    input.version !== EFFECT_STORE_VERSION ||
    !Array.isArray(input.records) ||
    input.records.length > MAX_EFFECT_RECORDS
  )
    return undefined;
  const records = input.records.map(parseRecord);
  if (records.some((record) => record === undefined)) return undefined;
  const parsed = records as DesignHandoffEffectRecordV1[];
  if (new Set(parsed.map(({ operationId }) => operationId)).size !== parsed.length)
    return undefined;
  return { version: EFFECT_STORE_VERSION, records: structuredClone(parsed) };
}

function sameIdentity(
  record: DesignHandoffEffectRecordV1,
  identity: DesignHandoffEffectIdentityV1,
): boolean {
  return (
    record.operationId === identity.operationId &&
    record.targetKind === identity.targetKind &&
    record.targetPreviewDigest === identity.targetPreviewDigest &&
    record.sourceWorkspaceId === identity.sourceWorkspaceId &&
    record.branchIntent === identity.branchIntent
  );
}

export class DesignHandoffEffectStore {
  private readonly data: DataStore<DesignHandoffEffectDocumentV1>;
  private initialized = false;

  constructor(options: { root?: () => string; filename?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.data = new DataStore(
      options.filename ?? "design-handoff-effects.json",
      { version: EFFECT_STORE_VERSION, records: [] },
      options.root,
      {
        maxBytes: MAX_EFFECT_STORE_BYTES,
        fileMode: 0o600,
        normalize: (value) =>
          parseDocument(value) ?? { version: EFFECT_STORE_VERSION, records: [] },
        isSafe: (value) => parseDocument(value) !== undefined,
        reloadBeforeWrite: true,
        rejectCorruptWrite: true,
        rejectUnsafeWrite: true,
      },
    );
  }

  private readonly now: () => number;

  async initialize(): Promise<void> {
    await this.data.load();
    if (await this.data.loadedFromCorruptFile())
      throw new Error("The design handoff effect ledger is corrupt and was preserved.");
    if (await this.data.loadedFromUnsafeFile())
      throw new Error("The design handoff effect ledger is unsafe and was preserved.");
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("The design handoff effect ledger is not initialized.");
  }

  async get(operationId: string): Promise<DesignHandoffEffectRecordV1 | null> {
    this.requireInitialized();
    const document = parseDocument(await this.data.load());
    if (!document) throw new Error("The design handoff effect ledger is unavailable.");
    return structuredClone(
      document.records.find((record) => record.operationId === operationId) ?? null,
    );
  }

  async ensure(identity: DesignHandoffEffectIdentityV1): Promise<DesignHandoffEffectRecordV1> {
    this.requireInitialized();
    return this.data.update((draft) => {
      const document = parseDocument(draft);
      if (!document) throw new Error("The design handoff effect ledger is unavailable.");
      const existing = document.records.find(
        ({ operationId }) => operationId === identity.operationId,
      );
      if (existing) {
        if (!sameIdentity(existing, identity))
          throw new DesignHandoffEffectStoreConflictError("The handoff effect identity changed.");
        return structuredClone(existing);
      }
      if (document.records.length >= MAX_EFFECT_RECORDS) {
        const removable = document.records
          .filter(
            (record) =>
              !record.linkage &&
              record.workspaceRolledBack &&
              record.chatRolledBack &&
              record.contextRolledBack,
          )
          .sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (!removable) throw new Error("The design handoff effect ledger is full.");
        document.records = document.records.filter(
          ({ operationId }) => operationId !== removable.operationId,
        );
      }
      const timestamp = Math.max(0, Math.floor(this.now()));
      const created: DesignHandoffEffectRecordV1 = {
        version: EFFECT_STORE_VERSION,
        ...structuredClone(identity),
        revision: 0,
        workspaceAttempted: false,
        workspaceRolledBack: false,
        chatAttempted: false,
        chatRolledBack: false,
        contextRolledBack: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      document.records.push(created);
      Object.assign(draft, document);
      return structuredClone(created);
    });
  }

  private async mutate(
    operationId: string,
    mutation: (record: DesignHandoffEffectRecordV1) => void,
  ): Promise<DesignHandoffEffectRecordV1> {
    this.requireInitialized();
    return this.data.update((draft) => {
      const document = parseDocument(draft);
      if (!document) throw new Error("The design handoff effect ledger is unavailable.");
      const record = document.records.find((candidate) => candidate.operationId === operationId);
      if (!record) throw new Error("The design handoff effect record was not found.");
      mutation(record);
      record.revision += 1;
      record.updatedAt = Math.max(record.updatedAt, 0, Math.floor(this.now()));
      if (!parseRecord(record))
        throw new DesignHandoffEffectStoreConflictError(
          "The handoff effect transition is invalid.",
        );
      Object.assign(draft, document);
      return structuredClone(record);
    });
  }

  markWorkspaceAttempted(operationId: string): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      record.workspaceAttempted = true;
    });
  }

  recordWorkspace(
    operationId: string,
    workspace: DesignHandoffWorkspaceResult,
  ): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.workspace && JSON.stringify(record.workspace) !== JSON.stringify(workspace)) {
        throw new DesignHandoffEffectStoreConflictError("The handoff workspace identity changed.");
      }
      record.workspaceAttempted = true;
      record.workspaceRolledBack = false;
      record.workspace = structuredClone(workspace);
    });
  }

  setChatIntent(operationId: string, title: string): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.chatTitle && record.chatTitle !== title)
        throw new DesignHandoffEffectStoreConflictError("The handoff chat title changed.");
      record.chatTitle = title;
      record.chatAttempted = true;
    });
  }

  recordChat(
    operationId: string,
    chat: DesignHandoffChatResult,
  ): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.chat && JSON.stringify(record.chat) !== JSON.stringify(chat)) {
        throw new DesignHandoffEffectStoreConflictError("The handoff chat identity changed.");
      }
      record.chatAttempted = true;
      record.chatRolledBack = false;
      record.chat = structuredClone(chat);
    });
  }

  installContext(
    operationId: string,
    packet: DesignHandoffPacketV1,
  ): Promise<DesignHandoffEffectRecordV1> {
    const parsed = parseDesignHandoffPacket(packet);
    return this.mutate(operationId, (record) => {
      if (record.context && JSON.stringify(record.context) !== JSON.stringify(parsed)) {
        throw new DesignHandoffEffectStoreConflictError("The handoff context changed.");
      }
      record.contextRolledBack = false;
      record.context = structuredClone(parsed);
    });
  }

  publish(
    operationId: string,
    linkage: DesignHandoffLinkResult,
  ): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.linkage && JSON.stringify(record.linkage) !== JSON.stringify(linkage)) {
        throw new DesignHandoffEffectStoreConflictError("The handoff linkage changed.");
      }
      record.linkage = structuredClone(linkage);
    });
  }

  rollbackContext(operationId: string): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.linkage)
        throw new DesignHandoffEffectStoreConflictError(
          "Published handoff context cannot be removed.",
        );
      delete record.context;
      record.contextRolledBack = true;
    });
  }

  rollbackChat(operationId: string): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.linkage)
        throw new DesignHandoffEffectStoreConflictError(
          "A published handoff chat cannot be removed.",
        );
      delete record.chat;
      record.chatRolledBack = true;
    });
  }

  rollbackWorkspace(operationId: string): Promise<DesignHandoffEffectRecordV1> {
    return this.mutate(operationId, (record) => {
      if (record.linkage)
        throw new DesignHandoffEffectStoreConflictError(
          "A published handoff workspace cannot be removed.",
        );
      delete record.workspace;
      record.workspaceRolledBack = true;
    });
  }

  async contextForChat(chatId: string): Promise<DesignHandoffPacketV1 | null> {
    this.requireInitialized();
    const document = parseDocument(await this.data.load());
    if (!document) throw new Error("The design handoff effect ledger is unavailable.");
    const contexts = document.records.filter(
      (record) => record.chat?.chatId === chatId && record.context,
    );
    if (contexts.length > 1)
      throw new DesignHandoffEffectStoreConflictError(
        "The workspace chat has conflicting handoff context.",
      );
    return structuredClone(contexts[0]?.context ?? null);
  }

  async linksForProject(projectId: string): Promise<DesignHandoffLinkResult[]> {
    this.requireInitialized();
    const document = parseDocument(await this.data.load());
    if (!document) throw new Error("The design handoff effect ledger is unavailable.");
    return document.records
      .filter((record) => record.linkage?.projectId === projectId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record.linkage!));
  }
}
