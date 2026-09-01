import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type MemoryScope =
  | { kind: "bot"; id: string }
  | { kind: "workspace"; id: string };

export type MemoryProvenance =
  | { kind: "user_edit"; sourceId: string }
  | { kind: "chat_message"; chatId: string; messageId: string }
  | { kind: "model_proposal"; chatId: string; turnId: string; anchorMessageId: string };

export interface MemoryFact {
  id: string;
  scope: MemoryScope;
  text: string;
  provenance: MemoryProvenance;
  createdAt: number;
  updatedAt: number;
  confidence: number;
  expiresAt?: number;
  reviewState: "approved";
  state: "active" | "superseded";
  supersedesId?: string;
  alwaysOn: boolean;
}

export interface MemorySearchResult extends MemoryFact {
  citation: string;
  rank: number;
}

export interface MemoryMetadataInput {
  id: string;
  kind: "transcript" | "artifact";
  text: string;
  chatId: string;
  sourceId: string;
}

export interface MemoryRecallResult {
  kind: "fact" | "transcript" | "artifact";
  text: string;
  citation: string;
  rank: number;
}

export interface MemoryFactInput {
  id?: string;
  scope: MemoryScope;
  text: string;
  provenance: MemoryProvenance;
  confidence?: number;
  expiresAt?: number;
  supersedesId?: string;
  alwaysOn?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_FACT_CHARS = 512;
const MAX_ALWAYS_ON = 12;
const MAX_SCOPE_FACTS = 2_000;
const MAX_SCOPE_DOCUMENTS = 5_000;
const MAX_CHAT_DOCUMENTS = 1_000;
const SECRET_LIKE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|secret|password)\s*[:=]|\bbearer(?:\s*[:=]\s*|\s+)[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|https?:\/\/[^\s/:@]+:[^\s@/]+@)/iu;
const FORBIDDEN_MEMORY_CONTENT = /(?:\bcompaction summary\b|<\/?(?:compaction_?summary|thinking|analysis|tool_(?:call|result))\b|(?:^|\s)##\s*(?:goal|progress|critical context|context for suffix|original request)\b|\b(?:chain[- ]of[- ]thought|internal reasoning|retained tail)\b|\b(?:toolCallId|tool_result|tool payload)\b|\b(?:system prompt|AGENTS\.md|SKILL\.md)\b|\bignore (?:all|any|the|previous) instructions\b|\byou are now\b)/iu;

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`The memory ${label} is invalid.`);
  return value;
}

export function normalizeMemoryText(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > MAX_FACT_CHARS) {
    throw new Error(`Memory facts must contain 1-${MAX_FACT_CHARS} characters.`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(normalized) || SECRET_LIKE.test(normalized)) {
    throw new Error("Memory facts cannot contain control text or secret-like material.");
  }
  if (FORBIDDEN_MEMORY_CONTENT.test(normalized)) {
    throw new Error("Memory facts cannot contain internal reasoning, tool payloads, summaries, or authority instructions.");
  }
  return normalized;
}

function validateScope(scope: MemoryScope): MemoryScope {
  return { kind: scope.kind, id: safeId(scope.id, "scope") };
}

function validateProvenance(provenance: MemoryProvenance): MemoryProvenance {
  if (provenance.kind === "user_edit") {
    return { kind: provenance.kind, sourceId: safeId(provenance.sourceId, "source") };
  }
  if (provenance.kind === "chat_message") {
    return {
      kind: provenance.kind,
      chatId: safeId(provenance.chatId, "source chat"),
      messageId: safeId(provenance.messageId, "source message"),
    };
  }
  return {
    kind: provenance.kind,
    chatId: safeId(provenance.chatId, "source chat"),
    turnId: safeId(provenance.turnId, "source turn"),
    anchorMessageId: safeId(provenance.anchorMessageId, "anchor message"),
  };
}

function ftsQuery(value: string): string | undefined {
  const terms = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]{2,}/gu)
    ?.slice(0, 12);
  if (!terms?.length) return undefined;
  return [...new Set(terms)].map((term) => `"${term.replace(/"/gu, '""')}"`).join(" OR ");
}

interface FactRow {
  id: string;
  scope_kind: "bot" | "workspace";
  scope_id: string;
  normalized_text: string;
  provenance_kind: "user_edit" | "chat_message";
  source_id: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
  source_turn_id: string | null;
  created_at: number;
  updated_at: number;
  confidence: number;
  expires_at: number | null;
  review_state: "approved";
  state: "active" | "superseded";
  supersedes_id: string | null;
  always_on: number;
}

function factFromRow(row: FactRow): MemoryFact {
  return {
    id: row.id,
    scope: { kind: row.scope_kind, id: row.scope_id },
    text: row.normalized_text,
    provenance: row.provenance_kind === "user_edit"
      ? { kind: "user_edit", sourceId: row.source_id! }
      : row.source_turn_id
        ? {
            kind: "model_proposal",
            chatId: row.source_chat_id!,
            turnId: row.source_turn_id,
            anchorMessageId: row.source_message_id!,
          }
      : {
          kind: "chat_message",
          chatId: row.source_chat_id!,
          messageId: row.source_message_id!,
        },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confidence: row.confidence,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    reviewState: row.review_state,
    state: row.state,
    ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
    alwaysOn: row.always_on === 1,
  };
}

export class MemoryStore {
  private database?: DatabaseSync;
  private databaseFile?: string;

  constructor(
    private readonly options: {
      root(): string | Promise<string>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async db(): Promise<DatabaseSync> {
    if (this.database) {
      await this.repairPrivateModes();
      return this.database;
    }
    const root = await this.options.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const file = path.join(root, "memory-v1.sqlite");
    const handle = await open(file, "a", 0o600);
    await handle.close();
    await chmod(file, 0o600);
    const database = new DatabaseSync(file);
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('bot', 'workspace')),
        scope_id TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('user_edit', 'chat_message')),
        source_id TEXT,
        source_chat_id TEXT,
        source_message_id TEXT,
        source_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        expires_at INTEGER,
        review_state TEXT NOT NULL CHECK (review_state = 'approved'),
        state TEXT NOT NULL CHECK (state IN ('active', 'superseded')),
        supersedes_id TEXT REFERENCES memory_facts(id),
        always_on INTEGER NOT NULL CHECK (always_on IN (0, 1)),
        CHECK (
          (provenance_kind = 'user_edit' AND source_id IS NOT NULL AND source_chat_id IS NULL AND source_message_id IS NULL)
          OR
          (provenance_kind = 'chat_message' AND source_id IS NULL AND source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_active_text
        ON memory_facts(scope_kind, scope_id, normalized_text) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS memory_scope_state
        ON memory_facts(scope_kind, scope_id, state, always_on, updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
        normalized_text,
        content='memory_facts',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(rowid, normalized_text) VALUES (new.rowid, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, normalized_text)
          VALUES ('delete', old.rowid, old.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE OF normalized_text ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, normalized_text)
          VALUES ('delete', old.rowid, old.normalized_text);
        INSERT INTO memory_facts_fts(rowid, normalized_text) VALUES (new.rowid, new.normalized_text);
      END;
      CREATE TABLE IF NOT EXISTS memory_documents (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('bot', 'workspace')),
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'artifact')),
        normalized_text TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_documents_scope
        ON memory_documents(scope_kind, scope_id, source_chat_id, updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_fts USING fts5(
        normalized_text,
        content='memory_documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memory_documents_ai AFTER INSERT ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(rowid, normalized_text) VALUES (new.rowid, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_documents_ad AFTER DELETE ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(memory_documents_fts, rowid, normalized_text)
          VALUES ('delete', old.rowid, old.normalized_text);
      END;
    `);
    const factColumns = database.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>;
    if (!factColumns.some(({ name }) => name === "source_turn_id")) {
      database.exec("ALTER TABLE memory_facts ADD COLUMN source_turn_id TEXT");
    }
    this.databaseFile = file;
    await this.repairPrivateModes();
    this.database = database;
    return database;
  }

  private async repairPrivateModes(): Promise<void> {
    if (!this.databaseFile) return;
    await Promise.all(
      [this.databaseFile, `${this.databaseFile}-wal`, `${this.databaseFile}-shm`].map(async (file) => {
        try {
          await chmod(file, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
    );
  }

  async put(input: MemoryFactInput): Promise<MemoryFact> {
    const database = await this.db();
    const scope = validateScope(input.scope);
    const text = normalizeMemoryText(input.text);
    const provenance = validateProvenance(input.provenance);
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("Memory confidence must be between 0 and 1.");
    }
    const now = this.now();
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) {
      throw new Error("Memory expiry must be a future millisecond timestamp.");
    }
    const supersedesId = input.supersedesId === undefined
      ? undefined
      : safeId(input.supersedesId, "superseded fact");
    const prior = supersedesId
      ? database.prepare(`
          SELECT * FROM memory_facts WHERE id = ? AND scope_kind = ? AND scope_id = ? AND state = 'active'
        `).get(supersedesId, scope.kind, scope.id) as unknown as FactRow | undefined
      : undefined;
    if (supersedesId && !prior) {
      throw new Error("The superseded memory fact is unavailable in this scope.");
    }
    const existing = database.prepare(`
      SELECT * FROM memory_facts
      WHERE scope_kind = ? AND scope_id = ? AND normalized_text = ? AND state = 'active'
    `).get(scope.kind, scope.id, text) as unknown as FactRow | undefined;
    if (existing && !supersedesId) return factFromRow(existing);
    if (existing && existing.id !== supersedesId) {
      throw new Error("The replacement duplicates another active fact in this scope.");
    }
    const count = database.prepare(`
      SELECT count(*) AS count FROM memory_facts
      WHERE scope_kind = ? AND scope_id = ? AND state = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND (? IS NULL OR id <> ?)
    `).get(scope.kind, scope.id, now, supersedesId ?? null, supersedesId ?? null) as { count: number };
    if (Number(count.count) >= MAX_SCOPE_FACTS) throw new Error("This memory scope is full.");
    if (input.alwaysOn) {
      const alwaysOn = database.prepare(`
        SELECT count(*) AS count FROM memory_facts
        WHERE scope_kind = ? AND scope_id = ? AND state = 'active' AND always_on = 1
          AND (expires_at IS NULL OR expires_at > ?)
          AND (? IS NULL OR id <> ?)
      `).get(scope.kind, scope.id, now, supersedesId ?? null, supersedesId ?? null) as { count: number };
      if (Number(alwaysOn.count) >= MAX_ALWAYS_ON) {
        throw new Error("This memory scope already has the maximum always-on facts.");
      }
    }
    const id = safeId(input.id ?? `memory-${randomUUID()}`, "fact ID");
    database.exec("BEGIN IMMEDIATE");
    try {
      if (supersedesId) {
        database.prepare("UPDATE memory_facts SET state = 'superseded', updated_at = ? WHERE id = ?")
          .run(now, supersedesId);
      }
      database.prepare(`
        INSERT INTO memory_facts (
          id, scope_kind, scope_id, normalized_text, provenance_kind,
          source_id, source_chat_id, source_message_id, source_turn_id, created_at, updated_at,
          confidence, expires_at, review_state, state, supersedes_id, always_on
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'active', ?, ?)
      `).run(
        id,
        scope.kind,
        scope.id,
        text,
        provenance.kind === "user_edit" ? "user_edit" : "chat_message",
        provenance.kind === "user_edit" ? provenance.sourceId : null,
        provenance.kind === "user_edit" ? null : provenance.chatId,
        provenance.kind === "chat_message"
          ? provenance.messageId
          : provenance.kind === "model_proposal" ? provenance.anchorMessageId : null,
        provenance.kind === "model_proposal" ? provenance.turnId : null,
        now,
        now,
        confidence,
        input.expiresAt ?? null,
        supersedesId ?? null,
        input.alwaysOn ? 1 : 0,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await this.repairPrivateModes();
    return factFromRow(database.prepare("SELECT * FROM memory_facts WHERE id = ?").get(id) as unknown as FactRow);
  }

  async alwaysOn(scope: MemoryScope, limit = 6): Promise<MemoryFact[]> {
    const database = await this.db();
    const valid = validateScope(scope);
    const now = this.now();
    const capped = Math.max(0, Math.min(MAX_ALWAYS_ON, Math.trunc(limit)));
    return (database.prepare(`
      SELECT * FROM memory_facts
      WHERE scope_kind = ? AND scope_id = ? AND state = 'active' AND always_on = 1
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, id ASC LIMIT ?
    `).all(valid.kind, valid.id, now, capped) as unknown as FactRow[]).map(factFromRow);
  }

  async search(scope: MemoryScope, query: string, limit = 8): Promise<MemorySearchResult[]> {
    const database = await this.db();
    const valid = validateScope(scope);
    const match = ftsQuery(query);
    if (!match) return [];
    const capped = Math.max(1, Math.min(8, Math.trunc(limit)));
    const rows = database.prepare(`
      SELECT memory_facts.*, bm25(memory_facts_fts) AS rank
      FROM memory_facts_fts
      JOIN memory_facts ON memory_facts.rowid = memory_facts_fts.rowid
      WHERE memory_facts_fts MATCH ?
        AND memory_facts.scope_kind = ? AND memory_facts.scope_id = ?
        AND memory_facts.state = 'active'
        AND (memory_facts.expires_at IS NULL OR memory_facts.expires_at > ?)
      ORDER BY rank ASC, memory_facts.updated_at DESC, memory_facts.id ASC
      LIMIT ?
    `).all(match, valid.kind, valid.id, this.now(), capped) as unknown as Array<FactRow & { rank: number }>;
    return rows.map((row) => ({
      ...factFromRow(row),
      citation: `memory:${row.id}`,
      rank: row.rank,
    }));
  }

  async replaceChatMetadata(
    scope: MemoryScope,
    chatId: string,
    documents: readonly MemoryMetadataInput[],
  ): Promise<number> {
    const database = await this.db();
    const valid = validateScope(scope);
    const sourceChatId = safeId(chatId, "source chat");
    const prepared = documents.slice(-MAX_CHAT_DOCUMENTS).flatMap((document) => {
      try {
        if (document.chatId !== sourceChatId) return [];
        return [{
          id: safeId(document.id, "document ID"),
          kind: document.kind,
          text: normalizeMemoryText(document.text),
          sourceId: safeId(document.sourceId, "document source"),
        }];
      } catch {
        // Secret-like, internal, oversized, or malformed source material is not indexed.
        return [];
      }
    });
    database.exec("BEGIN IMMEDIATE");
    let inserted = 0;
    try {
      database.prepare("DELETE FROM memory_documents WHERE source_chat_id = ?")
        .run(sourceChatId);
      const existing = database.prepare(`
        SELECT count(*) AS count FROM memory_documents WHERE scope_kind = ? AND scope_id = ?
      `).get(valid.kind, valid.id) as { count: number };
      const remaining = Math.max(0, MAX_SCOPE_DOCUMENTS - Number(existing.count));
      const insert = database.prepare(`
        INSERT INTO memory_documents (
          id, scope_kind, scope_id, kind, normalized_text, source_chat_id, source_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const accepted = remaining === 0 ? [] : prepared.slice(-remaining);
      for (const document of accepted) {
        insert.run(
          document.id,
          valid.kind,
          valid.id,
          document.kind,
          document.text,
          sourceChatId,
          document.sourceId,
          this.now(),
        );
        inserted += 1;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await this.repairPrivateModes();
    return inserted;
  }

  async recall(scope: MemoryScope, query: string, limit = 8): Promise<MemoryRecallResult[]> {
    const database = await this.db();
    const valid = validateScope(scope);
    const match = ftsQuery(query);
    if (!match) return [];
    const capped = Math.max(1, Math.min(8, Math.trunc(limit)));
    const facts = await this.search(valid, query, capped);
    if (facts.length >= capped) {
      return facts.map(({ text, citation, rank }) => ({ kind: "fact", text, citation, rank }));
    }
    const rows = database.prepare(`
      SELECT memory_documents.*, bm25(memory_documents_fts) AS rank
      FROM memory_documents_fts
      JOIN memory_documents ON memory_documents.rowid = memory_documents_fts.rowid
      WHERE memory_documents_fts MATCH ?
        AND memory_documents.scope_kind = ? AND memory_documents.scope_id = ?
      ORDER BY rank ASC, memory_documents.updated_at DESC, memory_documents.id ASC
      LIMIT ?
    `).all(match, valid.kind, valid.id, capped - facts.length) as unknown as Array<{
      kind: "transcript" | "artifact";
      normalized_text: string;
      source_chat_id: string;
      source_id: string;
      rank: number;
    }>;
    return [
      ...facts.map(({ text, citation, rank }) => ({ kind: "fact" as const, text, citation, rank })),
      ...rows.map((row) => ({
        kind: row.kind,
        text: row.normalized_text,
        citation: `${row.kind}:${row.source_chat_id}/${row.source_id}`,
        rank: row.rank,
      })),
    ];
  }

  async list(scope: MemoryScope): Promise<MemoryFact[]> {
    const database = await this.db();
    const valid = validateScope(scope);
    return (database.prepare(`
      SELECT * FROM memory_facts WHERE scope_kind = ? AND scope_id = ?
      ORDER BY state ASC, updated_at DESC, id ASC
    `).all(valid.kind, valid.id) as unknown as FactRow[]).map(factFromRow);
  }

  async remove(scope: MemoryScope, id: string): Promise<boolean> {
    const database = await this.db();
    const valid = validateScope(scope);
    const factId = safeId(id, "fact ID");
    database.exec("BEGIN IMMEDIATE");
    let removed = false;
    try {
      database.prepare(`
        UPDATE memory_facts SET supersedes_id = NULL
        WHERE supersedes_id IN (
          SELECT id FROM memory_facts WHERE id = ? AND scope_kind = ? AND scope_id = ?
        )
      `).run(factId, valid.kind, valid.id);
      const result = database.prepare(
        "DELETE FROM memory_facts WHERE id = ? AND scope_kind = ? AND scope_id = ?",
      ).run(factId, valid.kind, valid.id);
      removed = Number(result.changes) === 1;
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await this.repairPrivateModes();
    return removed;
  }

  async deleteSourceChat(chatId: string): Promise<number> {
    const database = await this.db();
    const sourceChatId = safeId(chatId, "source chat");
    database.exec("BEGIN IMMEDIATE");
    let removed = 0;
    try {
      database.prepare(`
        UPDATE memory_facts SET supersedes_id = NULL
        WHERE supersedes_id IN (
          SELECT id FROM memory_facts WHERE provenance_kind = 'chat_message' AND source_chat_id = ?
        )
      `).run(sourceChatId);
      const facts = database.prepare(
        "DELETE FROM memory_facts WHERE provenance_kind = 'chat_message' AND source_chat_id = ?",
      ).run(sourceChatId);
      removed = Number(facts.changes);
      database.prepare("DELETE FROM memory_documents WHERE source_chat_id = ?").run(sourceChatId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await this.repairPrivateModes();
    return removed;
  }

  async deleteScope(scope: MemoryScope): Promise<number> {
    const database = await this.db();
    const valid = validateScope(scope);
    database.exec("BEGIN IMMEDIATE");
    let removed = 0;
    try {
      database.prepare(`
        UPDATE memory_facts SET supersedes_id = NULL
        WHERE supersedes_id IN (
          SELECT id FROM memory_facts WHERE scope_kind = ? AND scope_id = ?
        )
      `).run(valid.kind, valid.id);
      const facts = database.prepare(
        "DELETE FROM memory_facts WHERE scope_kind = ? AND scope_id = ?",
      ).run(valid.kind, valid.id);
      removed = Number(facts.changes);
      database.prepare("DELETE FROM memory_documents WHERE scope_kind = ? AND scope_id = ?")
        .run(valid.kind, valid.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    await this.repairPrivateModes();
    return removed;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    await this.repairPrivateModes();
    this.databaseFile = undefined;
  }
}
