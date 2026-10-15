/**
 * Chat → ACP session bindings, so a restarted Aiden resumes the agent's own
 * session instead of rebuilding context. Holds only identifiers and content
 * fingerprints; never prompt text.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AcpSessionRecord {
  chatId: string;
  sessionId: string;
  cwd: string;
  /** Conversation messages the session had seen when last committed. */
  messageCount: number;
  historyFingerprint: string;
  /** Fingerprint of the assistant reply the session itself produced last. */
  expectedAssistantFingerprint?: string;
  updatedAt: number;
}

const MAX_RECORDS = 256;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class AcpSessionStore {
  private records: AcpSessionRecord[];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.records = read(file);
  }

  get(chatId: string): AcpSessionRecord | undefined {
    const record = this.records.find((candidate) => candidate.chatId === chatId);
    if (!record || this.now() - record.updatedAt > MAX_AGE_MS) return undefined;
    return { ...record };
  }

  save(record: Omit<AcpSessionRecord, "updatedAt">): void {
    this.records = [
      ...this.records.filter((candidate) => candidate.chatId !== record.chatId),
      { ...record, updatedAt: this.now() },
    ]
      .filter((candidate) => this.now() - candidate.updatedAt <= MAX_AGE_MS)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECORDS);
    this.persist();
  }

  remove(chatId: string): void {
    const before = this.records.length;
    this.records = this.records.filter((candidate) => candidate.chatId !== chatId);
    if (this.records.length !== before) this.persist();
  }

  clear(): void {
    this.records = [];
    this.persist();
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    const body = `${JSON.stringify({ version: 1, records: this.records })}\n`;
    const file = this.file;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, file);
      })
      .catch(() => undefined);
  }
}

function read(file: string): AcpSessionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; records?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(
      (record): record is AcpSessionRecord =>
        !!record &&
        typeof record === "object" &&
        typeof (record as AcpSessionRecord).chatId === "string" &&
        typeof (record as AcpSessionRecord).sessionId === "string" &&
        typeof (record as AcpSessionRecord).cwd === "string" &&
        Number.isSafeInteger((record as AcpSessionRecord).messageCount) &&
        typeof (record as AcpSessionRecord).historyFingerprint === "string" &&
        typeof (record as AcpSessionRecord).updatedAt === "number",
    );
  } catch {
    return [];
  }
}
