/**
 * Which outside app started a chat through Aiden's MCP server.
 *
 * This is a local record only. It is never projected to a phone, a paired Mac
 * or an outside app: the chat itself looks the same as any other, and this
 * note exists so Aiden on this computer can say "Started by Claude Code".
 */

/** One chat an outside app started. */
export interface AidenMcpChatProvenance {
  kind: "app";
  appId: string;
  name: string;
  /** Epoch milliseconds. */
  startedAt: number;
}

export interface AidenMcpProvenanceDocument {
  version: 1;
  /** Oldest first; bounded by the log's limit. */
  entries: Array<{ chatId: string } & AidenMcpChatProvenance>;
}

export interface AidenMcpProvenanceStorage {
  load(): Promise<AidenMcpProvenanceDocument>;
  save(document: AidenMcpProvenanceDocument): Promise<void>;
}

export const AIDEN_MCP_PROVENANCE_LIMIT = 1_000;

export function emptyAidenMcpProvenanceDocument(): AidenMcpProvenanceDocument {
  return { version: 1, entries: [] };
}

/** Drops anything that is not a well-formed entry, keeping the newest `limit`. */
export function parseAidenMcpProvenanceDocument(
  value: unknown,
  limit = AIDEN_MCP_PROVENANCE_LIMIT,
): AidenMcpProvenanceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyAidenMcpProvenanceDocument();
  const record = value as { version?: unknown; entries?: unknown };
  if (record.version !== 1 || !Array.isArray(record.entries)) return emptyAidenMcpProvenanceDocument();
  const entries: AidenMcpProvenanceDocument["entries"] = [];
  for (const candidate of record.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (
      entry.kind !== "app" ||
      !shortString(entry.chatId, 128) ||
      !shortString(entry.appId, 128) ||
      !shortString(entry.name, 80) ||
      !Number.isSafeInteger(entry.startedAt) ||
      (entry.startedAt as number) < 0
    ) {
      continue;
    }
    entries.push({
      chatId: entry.chatId,
      kind: "app",
      appId: entry.appId,
      name: entry.name,
      startedAt: entry.startedAt as number,
    });
  }
  return { version: 1, entries: entries.slice(-limit) };
}

export class AidenMcpProvenanceLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: AidenMcpProvenanceStorage,
    private readonly limit = AIDEN_MCP_PROVENANCE_LIMIT,
  ) {}

  /** Notes that `chatId` was started by an outside app. The first note for a chat wins. */
  record(chatId: string, provenance: AidenMcpChatProvenance): Promise<void> {
    return this.serialize(async () => {
      const document = parseAidenMcpProvenanceDocument(await this.storage.load(), this.limit);
      if (document.entries.some((entry) => entry.chatId === chatId)) return;
      document.entries.push({ chatId, ...provenance });
      await this.storage.save({ version: 1, entries: document.entries.slice(-this.limit) });
    });
  }

  async get(chatId: string): Promise<AidenMcpChatProvenance | undefined> {
    const document = parseAidenMcpProvenanceDocument(
      await this.serialize(() => this.storage.load()),
      this.limit,
    );
    const entry = document.entries.find((candidate) => candidate.chatId === chatId);
    if (!entry) return undefined;
    const { chatId: _chatId, ...provenance } = entry;
    return provenance;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
