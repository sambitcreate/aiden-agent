import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  parseChatHtmlArtifactV1,
  type ChatHtmlArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import {
  MAX_HTML_ARTIFACT_BYTES,
  MAX_HTML_ARTIFACT_BYTES_PER_CHAT,
  MAX_HTML_ARTIFACTS_PER_CHAT,
} from "../../renderer/shared/generative-ui.js";
import { displayedAssistantHtmlUsage } from "./generative-ui-extension.js";
import { validateGenerativeUiHtml } from "./generative-ui-html.js";

const STORE_VERSION = 1 as const;
const STORE_FILE = "generative-ui-artifacts.json";
const MAX_STORE_BYTES = 48 * 1024 * 1024;
const MAX_STORE_RECORDS = 2_000;
const MAX_UNCOMMITTED_ARTIFACTS = 200;
const REQUIRED_RECORD_KEYS = new Set([
  "version",
  "chatId",
  "generationId",
  "artifact",
  "html",
  "committed",
  "stagedAt",
]);
const OPTIONAL_RECORD_KEYS = new Set(["model"]);
const DATABASE_KEYS = new Set(["version", "revision", "records"]);

interface StagedHtmlArtifact {
  version: typeof STORE_VERSION;
  chatId: string;
  generationId: string;
  model?: string;
  artifact: ChatHtmlArtifactV1;
  html: string;
  committed: boolean;
  stagedAt: number;
}

interface GenerativeUiArtifactDatabase {
  version: typeof STORE_VERSION;
  revision: number;
  records: StagedHtmlArtifact[];
}

export interface GenerativeUiArtifactStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<GenerativeUiArtifactDatabase>;
}

export interface GenerativeUiArtifactRecoveryChat {
  id: string;
  messages: readonly {
    role: string;
    htmlArtifacts?: readonly ChatHtmlArtifactV1[];
  }[];
}

export interface RecoveredHtmlMessage {
  chatId: string;
  htmlArtifacts: ChatHtmlArtifactV1[];
  createdAt: number;
  model?: string;
}

function emptyDatabase(): GenerativeUiArtifactDatabase {
  return { version: STORE_VERSION, revision: 0, records: [] };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= expected.size &&
    keys.length <= expected.size + optional.size &&
    expected.size === [...expected].filter((key) => key in value).length &&
    keys.every((key) => expected.has(key) || optional.has(key))
  );
}

function boundedIdentity(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function parseRecord(value: unknown): StagedHtmlArtifact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, REQUIRED_RECORD_KEYS, OPTIONAL_RECORD_KEYS) ||
    record.version !== STORE_VERSION ||
    !boundedIdentity(record.chatId) ||
    !boundedIdentity(record.generationId) ||
    (record.model !== undefined &&
      (typeof record.model !== "string" || record.model.length > 512)) ||
    typeof record.html !== "string" ||
    typeof record.committed !== "boolean" ||
    typeof record.stagedAt !== "number" ||
    !Number.isFinite(record.stagedAt) ||
    record.stagedAt < 0
  ) {
    return undefined;
  }
  const artifact = parseChatHtmlArtifactV1(record.artifact);
  if (!artifact) return undefined;
  if (record.html.includes("\0") || Buffer.byteLength(record.html, "utf8") !== artifact.size) {
    return undefined;
  }
  if (Buffer.byteLength(record.html, "utf8") > MAX_HTML_ARTIFACT_BYTES) return undefined;
  return {
    version: STORE_VERSION,
    chatId: record.chatId,
    generationId: record.generationId,
    ...(record.model === undefined ? {} : { model: record.model }),
    artifact,
    html: record.html,
    committed: record.committed,
    stagedAt: record.stagedAt,
  };
}

function parseDatabase(value: unknown): GenerativeUiArtifactDatabase | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const database = value as Record<string, unknown>;
  if (
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== STORE_VERSION ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.records) ||
    database.records.length > MAX_STORE_RECORDS
  ) {
    return undefined;
  }
  const records = database.records.map(parseRecord);
  if (records.some((record) => !record)) return undefined;
  const parsed = records as StagedHtmlArtifact[];
  const ids = new Set(parsed.map(({ artifact }) => artifact.mediaId));
  if (ids.size !== parsed.length) return undefined;
  const bytes = parsed.reduce((total, record) => total + record.artifact.size, 0);
  if (bytes > MAX_STORE_BYTES) return undefined;
  return {
    version: STORE_VERSION,
    revision: database.revision as number,
    records: parsed,
  };
}

function createDataStore(
  options: GenerativeUiArtifactStoreOptions,
): DataStore<GenerativeUiArtifactDatabase> {
  return new DataStore(options.filename ?? STORE_FILE, emptyDatabase(), options.root, {
    maxBytes: MAX_STORE_BYTES,
    fileMode: 0o600,
    normalize: (value) => parseDatabase(value) ?? emptyDatabase(),
    isSafe: (value) => parseDatabase(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  });
}

export class GenerativeUiArtifactStore {
  private data: DataStore<GenerativeUiArtifactDatabase>;
  private readonly options: GenerativeUiArtifactStoreOptions;
  private readonly ownsDataStore: boolean;
  private readonly now: () => number;
  private initialized = false;
  private unavailableReason: string | null = null;
  private quarantinedStorePath: string | null = null;

  constructor(options: GenerativeUiArtifactStoreOptions = {}) {
    this.options = options;
    this.ownsDataStore = options.dataStore === undefined;
    this.data = options.dataStore ?? createDataStore(options);
    this.now = options.now ?? Date.now;
  }

  private async quarantineInvalidStore(reason: string): Promise<boolean> {
    if (!this.ownsDataStore) return false;
    const source = await this.data.path();
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/gu, "-");
    const preserved = `${source}.invalid-${stamp}-${randomUUID()}`;
    try {
      await fs.rename(source, preserved);
      const replacement = createDataStore(this.options);
      await replacement.load();
      if (
        (await replacement.loadedFromCorruptFile()) ||
        (await replacement.loadedFromUnsafeFile())
      ) {
        throw new Error("The replacement generative-ui artifact store is unavailable.");
      }
      this.data = replacement;
      this.quarantinedStorePath = preserved;
      return true;
    } catch (error) {
      this.unavailableReason = `${reason} Aiden could not move ${source} to ${preserved}: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    let unavailableReason: string | null = null;
    if (await this.data.loadedFromCorruptFile()) {
      unavailableReason = "Generative UI artifact staging is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      unavailableReason = "Generative UI artifact staging has an unsupported shape.";
    }
    if (unavailableReason && !(await this.quarantineInvalidStore(unavailableReason))) {
      this.unavailableReason ??= unavailableReason;
    }
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Generative UI artifact staging is not initialized.");
  }

  availability(): { available: true } | { available: false; reason: string } {
    this.requireInitialized();
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  quarantinedPath(): string | null {
    this.requireInitialized();
    return this.quarantinedStorePath;
  }

  private requireAvailable(): void {
    this.requireInitialized();
    if (this.unavailableReason) throw new Error(this.unavailableReason);
  }

  async stage(input: {
    chatId: string;
    generationId: string;
    model?: string;
    artifact: ChatHtmlArtifactV1;
    html: string;
  }): Promise<"inserted" | "replaced" | "existing"> {
    this.requireAvailable();
    const parsed = parseRecord({
      version: STORE_VERSION,
      ...input,
      committed: false,
      stagedAt: this.now(),
    });
    if (!parsed) throw new Error("Invalid generative-ui artifact staging payload.");
    validateGenerativeUiHtml(parsed.html);
    return this.data.update((database) => {
      const id = parsed.artifact.mediaId;
      const existingIndex = database.records.findIndex((record) => record.artifact.mediaId === id);
      if (existingIndex >= 0) {
        const existing = database.records[existingIndex]!;
        if (
          existing.chatId === parsed.chatId &&
          existing.generationId === parsed.generationId &&
          existing.artifact.title === parsed.artifact.title &&
          !existing.committed
        ) {
          database.records[existingIndex] = parsed;
          database.revision += 1;
          return "replaced" as const;
        }
        if (
          existing.chatId === parsed.chatId &&
          existing.generationId === parsed.generationId &&
          existing.html === parsed.html &&
          JSON.stringify(existing.artifact) === JSON.stringify(parsed.artifact)
        ) {
          return "existing" as const;
        }
        throw new Error("Generative UI artifact identity was reused.");
      }
      const uncommitted = database.records.filter((record) => !record.committed);
      if (uncommitted.length >= MAX_UNCOMMITTED_ARTIFACTS) {
        throw new Error("Generative UI artifact staging is at capacity.");
      }
      if (database.records.length >= MAX_STORE_RECORDS) {
        throw new Error("Generative UI artifact storage is at capacity.");
      }
      const chatRecords = database.records.filter((record) => record.chatId === parsed.chatId);
      if (chatRecords.length >= MAX_HTML_ARTIFACTS_PER_CHAT) {
        throw new Error("This chat has reached its HTML artifact limit.");
      }
      const chatBytes = chatRecords.reduce(
        (total, record) => total + record.artifact.size,
        parsed.artifact.size,
      );
      if (chatBytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT) {
        throw new Error("Generative UI artifact staging reached this chat's storage limit.");
      }
      database.records.push(parsed);
      database.revision += 1;
      return "inserted" as const;
    });
  }

  async commit(chatId: string, mediaIds: readonly string[]): Promise<void> {
    this.requireAvailable();
    if (!boundedIdentity(chatId) || mediaIds.some((id) => !boundedIdentity(id))) {
      throw new Error("Invalid generative-ui artifact commit identity.");
    }
    const ids = new Set(mediaIds);
    if (ids.size === 0) return;
    await this.data.update((database) => {
      let changed = false;
      database.records = database.records.map((record) => {
        if (record.chatId !== chatId || !ids.has(record.artifact.mediaId) || record.committed) {
          return record;
        }
        changed = true;
        return { ...record, committed: true };
      });
      if (changed) database.revision += 1;
    });
  }

  async htmlFor(chatId: string, mediaId: string): Promise<string | undefined> {
    this.requireAvailable();
    if (!boundedIdentity(chatId) || !boundedIdentity(mediaId)) return undefined;
    const record = (await this.data.load()).records.find(
      (item) => item.chatId === chatId && item.artifact.mediaId === mediaId,
    );
    return record?.html;
  }

  async artifactFor(chatId: string, mediaId: string): Promise<ChatHtmlArtifactV1 | undefined> {
    this.requireAvailable();
    if (!boundedIdentity(chatId) || !boundedIdentity(mediaId)) return undefined;
    return (await this.data.load()).records.find(
      (item) => item.chatId === chatId && item.artifact.mediaId === mediaId,
    )?.artifact;
  }

  async pending(): Promise<readonly StagedHtmlArtifact[]> {
    this.requireAvailable();
    return structuredClone((await this.data.load()).records.filter((record) => !record.committed));
  }

  async pendingChatIds(): Promise<string[]> {
    return [...new Set((await this.pending()).map((record) => record.chatId))];
  }

  async usageByChat(chatId: string): Promise<{ bytes: number; count: number }> {
    this.requireAvailable();
    if (!boundedIdentity(chatId)) throw new Error("Invalid generative-ui artifact chat identity.");
    const pending = (await this.data.load()).records.filter(
      (record) => record.chatId === chatId && !record.committed,
    );
    return pending.reduce(
      (usage, record) => ({
        bytes: usage.bytes + record.artifact.size,
        count: usage.count + 1,
      }),
      { bytes: 0, count: 0 },
    );
  }

  async hasPending(chatId: string): Promise<boolean> {
    this.requireInitialized();
    if (!boundedIdentity(chatId)) throw new Error("Invalid generative-ui artifact chat identity.");
    if (this.unavailableReason) return true;
    const usage = await this.usageByChat(chatId);
    return usage.count > 0;
  }

  async deleteChat(chatId: string): Promise<void> {
    this.requireAvailable();
    if (!boundedIdentity(chatId)) return;
    await this.data.update((database) => {
      const before = database.records.length;
      database.records = database.records.filter((record) => record.chatId !== chatId);
      if (database.records.length !== before) database.revision += 1;
    });
  }

  async duplicateSelected(
    sourceChatId: string,
    targetChatId: string,
    mediaIds: readonly string[],
  ): Promise<ChatHtmlArtifactV1[]> {
    this.requireAvailable();
    if (!boundedIdentity(sourceChatId) || !boundedIdentity(targetChatId)) {
      throw new Error("Invalid generative-ui artifact copy identity.");
    }
    const wanted = new Set(mediaIds.filter((id) => boundedIdentity(id)));
    if (wanted.size === 0) return [];
    return this.data.update((database) => {
      const copies: ChatHtmlArtifactV1[] = [];
      const source = database.records.filter(
        (record) =>
          record.chatId === sourceChatId &&
          record.committed &&
          wanted.has(record.artifact.mediaId),
      );
      if (database.records.length + source.length > MAX_STORE_RECORDS) {
        throw new Error("Generative UI artifact storage is at capacity.");
      }
      const targetRecords = database.records.filter((record) => record.chatId === targetChatId);
      if (targetRecords.length + source.length > MAX_HTML_ARTIFACTS_PER_CHAT) {
        throw new Error("This chat has reached its HTML artifact limit.");
      }
      const targetBytes = targetRecords.reduce((total, record) => total + record.artifact.size, 0);
      const copyBytes = source.reduce((total, record) => total + record.artifact.size, 0);
      if (targetBytes + copyBytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT) {
        throw new Error("Generative UI artifact staging reached this chat's storage limit.");
      }
      for (const record of source) {
        const mediaId = remappedHtmlArtifactMediaId(targetChatId, record.artifact.mediaId);
        const artifact: ChatHtmlArtifactV1 = { ...record.artifact, id: mediaId, mediaId };
        database.records.push({
          ...record,
          chatId: targetChatId,
          artifact,
          stagedAt: this.now(),
        });
        copies.push(artifact);
      }
      if (copies.length > 0) database.revision += 1;
      return copies;
    });
  }

  async duplicateChat(sourceChatId: string, targetChatId: string): Promise<ChatHtmlArtifactV1[]> {
    this.requireAvailable();
    const sourceIds = (await this.data.load()).records
      .filter((record) => record.chatId === sourceChatId && record.committed)
      .map((record) => record.artifact.mediaId);
    return this.duplicateSelected(sourceChatId, targetChatId, sourceIds);
  }

  async recover(
    chats: readonly GenerativeUiArtifactRecoveryChat[],
    append: (message: RecoveredHtmlMessage) => Promise<void>,
  ): Promise<void> {
    this.requireAvailable();
    const chatById = new Map(chats.map((chat) => [chat.id, chat]));
    const records = await this.pending();
    const recordsByChat = new Map<string, StagedHtmlArtifact[]>();
    for (const record of records) {
      const group = recordsByChat.get(record.chatId) ?? [];
      group.push(record);
      recordsByChat.set(record.chatId, group);
    }
    for (const [chatId, group] of recordsByChat) {
      const chat = chatById.get(chatId);
      if (!chat) continue;
      const persistedIds = new Set(
        chat.messages.flatMap((message) =>
          (message.htmlArtifacts ?? []).map((artifact) => artifact.mediaId),
        ),
      );
      const alreadyPersisted = group.filter((record) => persistedIds.has(record.artifact.mediaId));
      if (alreadyPersisted.length > 0) {
        await this.commit(
          chatId,
          alreadyPersisted.map((record) => record.artifact.mediaId),
        );
      }
      const pending = group.filter((record) => !persistedIds.has(record.artifact.mediaId));
      const persistedUsage = displayedAssistantHtmlUsage(chat.messages);
      const recoveryBytes = pending.reduce((total, record) => total + record.artifact.size, 0);
      if (
        persistedUsage.bytes + recoveryBytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT ||
        persistedUsage.count + pending.length > MAX_HTML_ARTIFACTS_PER_CHAT
      ) {
        throw new Error(`Recovered HTML artifacts would exceed chat ${chatId}'s limits.`);
      }
      const byGeneration = new Map<string, StagedHtmlArtifact[]>();
      for (const record of pending) {
        const generation = byGeneration.get(record.generationId) ?? [];
        generation.push(record);
        byGeneration.set(record.generationId, generation);
      }
      const generations = [...byGeneration.values()].sort(
        (left, right) =>
          Math.min(...left.map((record) => record.stagedAt)) -
          Math.min(...right.map((record) => record.stagedAt)),
      );
      for (const generation of generations) {
        await append({
          chatId,
          htmlArtifacts: generation.map((record) => record.artifact),
          createdAt: Math.min(...generation.map((record) => record.stagedAt)),
          ...(generation[0]?.model ? { model: generation[0].model } : {}),
        });
        await this.commit(
          chatId,
          generation.map((record) => record.artifact.mediaId),
        );
      }
    }
  }
}

export function remappedHtmlArtifactMediaId(targetChatId: string, sourceMediaId: string): string {
  return createHash("sha256").update(targetChatId).update("\0").update(sourceMediaId).digest("hex");
}

export const generativeUiArtifactStore = new GenerativeUiArtifactStore();
