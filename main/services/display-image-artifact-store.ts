import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import type { Attachment } from "./types.js";
import { parseChatArtifactV1, type ChatArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import {
  MAX_DISPLAY_IMAGE_BYTES_PER_CHAT,
  MAX_DISPLAY_IMAGE_PIXELS,
  MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT,
  MAX_DISPLAY_IMAGES_PER_CHAT,
  displayedAssistantImageUsage,
  validateDisplayImageDimensions,
} from "./display-image-extension.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";

const STORE_VERSION = 1 as const;
const STORE_FILE = "display-image-artifacts.json";
const MAX_STORE_BYTES = 48 * 1024 * 1024;
const MAX_STAGED_ARTIFACTS = 100;
const REQUIRED_RECORD_KEYS = new Set([
  "version",
  "chatId",
  "generationId",
  "artifact",
  "pixels",
  "stagedAt",
]);
const OPTIONAL_RECORD_KEYS = new Set(["model"]);
const DATABASE_KEYS = new Set(["version", "revision", "records"]);

interface StagedDisplayImageArtifact {
  version: typeof STORE_VERSION;
  chatId: string;
  generationId: string;
  model?: string;
  artifact: ChatArtifactV1;
  pixels: number;
  stagedAt: number;
}

interface DisplayImageArtifactDatabase {
  version: typeof STORE_VERSION;
  revision: number;
  records: StagedDisplayImageArtifact[];
}

export interface DisplayImageArtifactStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<DisplayImageArtifactDatabase>;
}

export interface DisplayImageArtifactRecoveryChat {
  id: string;
  messages: readonly { role: string; attachments?: readonly Attachment[] }[];
}

export interface RecoveredDisplayImageMessage {
  chatId: string;
  attachments: Attachment[];
  createdAt: number;
  model?: string;
}

export interface DisplayImageArtifactUsage {
  bytes: number;
  count: number;
  pixels: number;
}

function emptyDatabase(): DisplayImageArtifactDatabase {
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

function parseRecord(value: unknown): StagedDisplayImageArtifact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, REQUIRED_RECORD_KEYS, OPTIONAL_RECORD_KEYS) ||
    record.version !== STORE_VERSION ||
    !boundedIdentity(record.chatId) ||
    !boundedIdentity(record.generationId) ||
    (record.model !== undefined &&
      (typeof record.model !== "string" || record.model.length > 512)) ||
    !Number.isSafeInteger(record.pixels) ||
    (record.pixels as number) < 1 ||
    (record.pixels as number) > MAX_DISPLAY_IMAGE_PIXELS ||
    typeof record.stagedAt !== "number" ||
    !Number.isFinite(record.stagedAt) ||
    record.stagedAt < 0
  ) {
    return undefined;
  }
  const artifact = parseChatArtifactV1(record.artifact);
  if (!artifact || artifact.kind !== "image") return undefined;
  try {
    const dimensions = validateDisplayImageDimensions(
      Buffer.from(artifact.attachment.data, "base64"),
      artifact.attachment.mimeType,
      artifact.attachment.name,
    );
    if (dimensions.width * dimensions.height !== record.pixels) return undefined;
  } catch {
    return undefined;
  }
  return {
    version: STORE_VERSION,
    chatId: record.chatId,
    generationId: record.generationId,
    ...(record.model === undefined ? {} : { model: record.model }),
    artifact,
    pixels: record.pixels as number,
    stagedAt: record.stagedAt,
  };
}

function parseDatabase(value: unknown): DisplayImageArtifactDatabase | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const database = value as Record<string, unknown>;
  if (
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== STORE_VERSION ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.records) ||
    database.records.length > MAX_STAGED_ARTIFACTS
  ) {
    return undefined;
  }
  const records = database.records.map(parseRecord);
  if (records.some((record) => !record)) return undefined;
  const parsed = records as StagedDisplayImageArtifact[];
  const ids = new Set(parsed.map(({ artifact }) => artifact.attachment.id));
  if (ids.size !== parsed.length) return undefined;
  const bytes = parsed.reduce((total, record) => total + record.artifact.attachment.size, 0);
  const pixels = parsed.reduce((total, record) => total + record.pixels, 0);
  if (bytes > MAX_DISPLAY_IMAGE_BYTES_PER_CHAT || pixels > MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT) {
    return undefined;
  }
  return {
    version: STORE_VERSION,
    revision: database.revision as number,
    records: parsed,
  };
}

function createDataStore(
  options: DisplayImageArtifactStoreOptions,
): DataStore<DisplayImageArtifactDatabase> {
  return new DataStore(options.filename ?? STORE_FILE, emptyDatabase(), options.root, {
    maxBytes: MAX_STORE_BYTES,
    fileMode: 0o600,
    normalize: (value) => parseDatabase(value) ?? emptyDatabase(),
    isSafe: (value) => parseDatabase(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  });
}

function stagedUsage(records: readonly StagedDisplayImageArtifact[]): DisplayImageArtifactUsage {
  return records.reduce<DisplayImageArtifactUsage>(
    (usage, record) => ({
      bytes: usage.bytes + record.artifact.attachment.size,
      count: usage.count + 1,
      pixels: usage.pixels + record.pixels,
    }),
    { bytes: 0, count: 0, pixels: 0 },
  );
}

/** Durable payload staging for non-replayable display effects. */
export class DisplayImageArtifactStore {
  private data: DataStore<DisplayImageArtifactDatabase>;
  private readonly options: DisplayImageArtifactStoreOptions;
  private readonly ownsDataStore: boolean;
  private readonly now: () => number;
  private initialized = false;
  private unavailableReason: string | null = null;
  private quarantinedStorePath: string | null = null;

  constructor(options: DisplayImageArtifactStoreOptions = {}) {
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
        throw new Error("The replacement display-image artifact store is unavailable.");
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
      unavailableReason = "Display-image artifact staging is unreadable.";
    } else if (await this.data.loadedFromUnsafeFile()) {
      unavailableReason = "Display-image artifact staging has an unsupported shape.";
    }
    if (unavailableReason && !(await this.quarantineInvalidStore(unavailableReason))) {
      this.unavailableReason ??= unavailableReason;
    }
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Display-image artifact staging is not initialized.");
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
    artifact: ChatArtifactV1;
    pixels: number;
  }): Promise<"inserted" | "existing"> {
    this.requireAvailable();
    const parsed = parseRecord({
      version: STORE_VERSION,
      ...input,
      stagedAt: this.now(),
    });
    if (!parsed) throw new Error("Invalid display-image artifact staging payload.");
    return this.data.update((database) => {
      const id = parsed.artifact.attachment.id;
      const existing = database.records.find((record) => record.artifact.attachment.id === id);
      if (existing) {
        if (
          existing.chatId === parsed.chatId &&
          existing.generationId === parsed.generationId &&
          existing.model === parsed.model &&
          existing.pixels === parsed.pixels &&
          JSON.stringify(existing.artifact) === JSON.stringify(parsed.artifact)
        ) {
          return "existing" as const;
        }
        throw new Error("Display-image artifact identity was reused.");
      }
      if (database.records.length >= MAX_STAGED_ARTIFACTS) {
        throw new Error("Display-image artifact staging is at capacity.");
      }
      const bytes = database.records.reduce(
        (total, record) => total + record.artifact.attachment.size,
        parsed.artifact.attachment.size,
      );
      const pixels = database.records.reduce(
        (total, record) => total + record.pixels,
        parsed.pixels,
      );
      if (bytes > MAX_DISPLAY_IMAGE_BYTES_PER_CHAT || pixels > MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT) {
        throw new Error("Display-image artifact staging reached its process-wide limit.");
      }
      database.records.push(parsed);
      database.revision += 1;
      return "inserted" as const;
    });
  }

  async remove(chatId: string, artifactIds: readonly string[]): Promise<void> {
    this.requireAvailable();
    if (!boundedIdentity(chatId) || artifactIds.some((id) => !boundedIdentity(id))) {
      throw new Error("Invalid display-image artifact cleanup identity.");
    }
    const ids = new Set(artifactIds);
    if (ids.size === 0) return;
    await this.data.update((database) => {
      const before = database.records.length;
      database.records = database.records.filter(
        (record) => record.chatId !== chatId || !ids.has(record.artifact.attachment.id),
      );
      if (database.records.length !== before) database.revision += 1;
    });
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

  async pending(): Promise<readonly StagedDisplayImageArtifact[]> {
    this.requireAvailable();
    return structuredClone((await this.data.load()).records);
  }

  async pendingChatIds(): Promise<string[]> {
    return [...new Set((await this.pending()).map((record) => record.chatId))];
  }

  async usageByChat(chatId: string): Promise<DisplayImageArtifactUsage> {
    this.requireAvailable();
    if (!boundedIdentity(chatId)) throw new Error("Invalid display-image artifact chat identity.");
    return stagedUsage((await this.data.load()).records.filter((record) => record.chatId === chatId));
  }

  async hasPending(chatId: string): Promise<boolean> {
    this.requireInitialized();
    if (!boundedIdentity(chatId)) throw new Error("Invalid display-image artifact chat identity.");
    if (this.unavailableReason) return true;
    const usage = await this.usageByChat(chatId);
    return usage.count > 0;
  }

  /** Recover crash-left payloads into ChatStore before any renderer can read chats. */
  async recover(
    chats: readonly DisplayImageArtifactRecoveryChat[],
    append: (message: RecoveredDisplayImageMessage) => Promise<void>,
  ): Promise<void> {
    this.requireAvailable();
    const chatById = new Map(chats.map((chat) => [chat.id, chat]));
    const records = await this.pending();
    const recordsByChat = new Map<string, StagedDisplayImageArtifact[]>();
    for (const record of records) {
      const group = recordsByChat.get(record.chatId) ?? [];
      group.push(record);
      recordsByChat.set(record.chatId, group);
    }
    for (const [chatId, group] of recordsByChat) {
      const chat = chatById.get(chatId);
      // A missing/corrupt payload is unresolved, not proof that the user
      // deleted it. Retain the only durable artifact copy for a later repair.
      if (!chat) continue;
      const persistedIds = new Set(
        chat.messages.flatMap((message) =>
          (message.attachments ?? []).map((attachment) => attachment.id),
        ),
      );
      const pending = group.filter((record) => !persistedIds.has(record.artifact.attachment.id));
      const persistedUsage = displayedAssistantImageUsage(chat.messages);
      const recoveryUsage = stagedUsage(pending);
      if (
        persistedUsage.bytes + recoveryUsage.bytes > MAX_DISPLAY_IMAGE_BYTES_PER_CHAT ||
        persistedUsage.count + recoveryUsage.count > MAX_DISPLAY_IMAGES_PER_CHAT ||
        persistedUsage.pixels + recoveryUsage.pixels > MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT
      ) {
        throw new Error(`Recovered image artifacts would exceed chat ${chatId}'s limits.`);
      }
      const byGeneration = new Map<string, StagedDisplayImageArtifact[]>();
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
        for (let offset = 0; offset < generation.length; offset += MAX_ATTACHMENTS_PER_MESSAGE) {
          const chunk = generation.slice(offset, offset + MAX_ATTACHMENTS_PER_MESSAGE);
          if (chunk.length === 0) continue;
          await append({
            chatId,
            attachments: chunk.map((record) => record.artifact.attachment),
            createdAt: Math.min(...chunk.map((record) => record.stagedAt)),
            ...(chunk[0]?.model ? { model: chunk[0].model } : {}),
          });
        }
      }
      await this.remove(
        chatId,
        group.map((record) => record.artifact.attachment.id),
      );
    }
  }
}

export const displayImageArtifactStore = new DisplayImageArtifactStore();
