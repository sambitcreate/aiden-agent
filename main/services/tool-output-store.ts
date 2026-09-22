import { createHash, randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import { join } from "node:path";
import { readRegularFile } from "./regular-file-read.js";

export const MAX_STORED_TOOL_OUTPUT_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_RECORDS = 64;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;

interface StoredOutput {
  handle: string;
  chat: string;
  scope: string;
  tool: string;
  text: string;
  createdAt: number;
}

export function toolOutputScope(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Ciphertext-only authority evidence; conservatively invalidates on any key/token update. */
export async function toolOutputCredentialFingerprint(root: string): Promise<string[]> {
  return Promise.all(["provider-keys.json", "mcp-oauth.json"].map(async (filename) => {
    try {
      return createHash("sha256").update(await readRegularFile(join(root, filename), 4_000_000)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw new Error("Tool output credential authority is unavailable.");
    }
  }));
}

function normalize(value: unknown): StoredOutput[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return [];
  let total = 0;
  const seen = new Set<string>();
  return value.filter((entry): entry is StoredOutput => {
    if (!entry || typeof entry !== "object" || !HANDLE.test(entry.handle) ||
      !HASH.test(entry.chat) || !HASH.test(entry.scope) || typeof entry.tool !== "string" ||
      entry.tool.length > 160 || typeof entry.text !== "string" ||
      entry.text.length > MAX_STORED_TOOL_OUTPUT_CHARS ||
      !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || seen.has(entry.handle)) return false;
    total += entry.text.length;
    if (total > MAX_TOTAL_CHARS) return false;
    seen.add(entry.handle);
    return true;
  });
}

/** Private bounded text snapshots. Handles carry no authority without their host scope. */
export class ToolOutputStore {
  private readonly data: DataStore<StoredOutput[]>;
  constructor(root?: () => string, private readonly now = Date.now) {
    this.data = new DataStore("tool-output-spills.json", [], root, {
      fileMode: 0o600, maxBytes: 32_000_000, normalize,
    });
  }

  async put(chatId: string, scope: string, tool: string, text: string, isCurrent: () => boolean): Promise<string> {
    if (!HASH.test(scope) || !tool || tool.length > 160 || text.length > MAX_STORED_TOOL_OUTPUT_CHARS) {
      throw new Error("Tool output cannot be retained.");
    }
    const handle = randomUUID();
    await this.data.update((rows) => {
      const cutoff = this.now() - RETENTION_MS;
      const retained = rows.filter((row) => row.createdAt > cutoff && row.createdAt <= this.now());
      let total = retained.reduce((sum, row) => sum + row.text.length, 0);
      while (retained.length >= MAX_RECORDS || total + text.length > MAX_TOTAL_CHARS) {
        total -= retained.shift()!.text.length;
      }
      retained.push({ handle, chat: toolOutputScope(chatId), scope, tool, text, createdAt: this.now() });
      rows.splice(0, rows.length, ...retained);
    }, isCurrent);
    return handle;
  }

  async read(chatId: string, scope: string, tools: ReadonlySet<string>, handle: string, offset: number, length: number): Promise<string> {
    if (!HANDLE.test(handle) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 1 || length > 8_000) throw new Error("Invalid output window.");
    const row = (await this.data.load()).find((item) => item.handle === handle &&
      item.chat === toolOutputScope(chatId) && item.scope === scope && tools.has(item.tool) &&
      item.createdAt > this.now() - RETENTION_MS && item.createdAt <= this.now());
    if (!row) throw new Error("This output is unavailable or its access has changed.");
    if (offset > row.text.length) throw new Error("Output offset exceeds retained text.");
    const end = Math.min(row.text.length, offset + length);
    return `Retained output characters ${offset}–${end} of ${row.text.length}:\n${row.text.slice(offset, end)}`;
  }

  async deleteByChat(chatId: string): Promise<void> {
    const chat = toolOutputScope(chatId);
    await this.data.update((rows) => {
      const kept = rows.filter((row) => row.chat !== chat && row.createdAt > this.now() - RETENTION_MS);
      rows.splice(0, rows.length, ...kept);
    });
  }

  async pruneExpired(): Promise<void> {
    await this.data.update((rows) => {
      const kept = rows.filter((row) => row.createdAt > this.now() - RETENTION_MS && row.createdAt <= this.now());
      rows.splice(0, rows.length, ...kept);
    });
  }
}

export const toolOutputStore = new ToolOutputStore();
