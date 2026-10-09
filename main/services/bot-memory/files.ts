// On-disk layout and pure parsing of a Bot's memory (spec 2026-10-09 §5–§6).
//
// `<profile>/bots/<botDirectoryName(id)>/memory/MEMORY.md` holds the Bot's
// own notes and `USER.md` what it knows about the person. Each file is UTF-8
// with no header: entries separated by a line holding only `§`. A missing or
// empty file has no entries. The directory sits next to `session.sqlite`, so
// deleting the Bot's session directory erases its memory too.
//
// Everything here is pure except `readMemoryFile`. Every load validates
// (§6.3): the shell can write these files under Full access, so a blocked,
// oversize or duplicate entry is dropped on read rather than trusted.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BOT_MEMORY_ENTRY_DELIMITER,
  BOT_MEMORY_LIMITS,
  type BotMemoryEntry,
  type BotMemoryTarget,
} from "../../../renderer/shared/bot-memory.js";
import { botDirectoryName } from "../bot-runtime/harness-host.js";
import { scanMemoryText } from "./scan.js";

export const BOT_MEMORY_DIRECTORY = "memory";
export const BOT_MEMORY_TARGETS: readonly BotMemoryTarget[] = ["memory", "user"];
export const BOT_MEMORY_FILE_NAMES: Readonly<Record<BotMemoryTarget, string>> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

export function botMemoryDirectory(profileDir: string, botId: string): string {
  return path.join(profileDir, "bots", botDirectoryName(botId), BOT_MEMORY_DIRECTORY);
}

export function botMemoryFile(profileDir: string, botId: string, target: BotMemoryTarget): string {
  return path.join(botMemoryDirectory(profileDir, botId), BOT_MEMORY_FILE_NAMES[target]);
}

export function memoryLimit(target: BotMemoryTarget): number {
  return target === "memory" ? BOT_MEMORY_LIMITS.memoryChars : BOT_MEMORY_LIMITS.userChars;
}

/** Content-addressed: the first 16 hex characters of sha256(target + "\0" + text). */
export function memoryEntryId(target: BotMemoryTarget, text: string): string {
  return createHash("sha256").update(`${target}\0${text}`, "utf8").digest("hex").slice(0, 16);
}

/** Whitespace- and case-insensitive form used for duplicates and substring matches. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export type EntryProblem = "empty" | "too_long" | "invalid" | "blocked";

/** Trimmed, `\r\n` → `\n`. */
export function cleanEntryText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}

/** Why `text` (already cleaned) cannot be stored, or null. */
export function entryProblem(text: string): EntryProblem | null {
  if (text.length === 0) return "empty";
  if (text.length > BOT_MEMORY_LIMITS.entryChars) return "too_long";
  if (text.split("\n").some((line) => line.trim() === "§")) return "invalid";
  if (!scanMemoryText(text).ok) return "blocked";
  return null;
}

export function serializeEntries(texts: readonly string[]): string {
  return texts.join(BOT_MEMORY_ENTRY_DELIMITER);
}

/** Characters the entries use once serialized, which is what the budget counts. */
export function usedChars(texts: readonly string[]): number {
  return serializeEntries(texts).length;
}

/** Split file content into trimmed, non-empty raw entries (unvalidated). */
export function splitEntries(content: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of content.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trim() === "§") {
      parts.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  parts.push(current.join("\n"));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export interface ValidatedStore {
  /** Every entry that passed validation, in file order. */
  texts: string[];
  /** Entries dropped by the threat scan. */
  blockedCount: number;
  /** Entries dropped for being empty of meaning, too long or holding a delimiter line. */
  droppedCount: number;
}

/** Read validation (§6.3): drop blocked, oversize and duplicate entries. */
export function validateEntries(rawEntries: readonly string[]): ValidatedStore {
  const texts: string[] = [];
  const seen = new Set<string>();
  let blockedCount = 0;
  let droppedCount = 0;
  for (const raw of rawEntries) {
    const text = cleanEntryText(raw);
    const problem = entryProblem(text);
    if (problem === "blocked") {
      blockedCount += 1;
      continue;
    }
    if (problem !== null) {
      droppedCount += 1;
      continue;
    }
    const key = normalizeForMatch(text);
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return { texts, blockedCount, droppedCount };
}

/** The longest prefix of `texts` whose serialized size fits `limit`. */
export function prefixWithin(texts: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  for (const text of texts) {
    if (usedChars([...kept, text]) > limit) break;
    kept.push(text);
  }
  return kept;
}

export function toEntries(target: BotMemoryTarget, texts: readonly string[]): BotMemoryEntry[] {
  return texts.map((text) => ({ id: memoryEntryId(target, text), text }));
}

export type RawMemoryFile =
  | { kind: "missing" }
  | { kind: "ok"; content: string; bytes: Buffer; mtimeMs: number }
  | { kind: "unreadable"; reason: string };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** One memory file: missing, decoded strictly as UTF-8, or unreadable (bad bytes or an I/O error). */
export async function readMemoryFile(file: string): Promise<RawMemoryFile> {
  let bytes: Buffer;
  let mtimeMs: number;
  try {
    const [stat, data] = await Promise.all([fs.stat(file), fs.readFile(file)]);
    if (!stat.isFile()) return { kind: "unreadable", reason: "not a file" };
    bytes = data;
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: (error as Error).message };
  }
  try {
    return { kind: "ok", content: strictUtf8.decode(bytes), bytes, mtimeMs };
  } catch {
    return { kind: "unreadable", reason: "invalid UTF-8" };
  }
}

/** First 16 hex characters of sha256 over both files' bytes (missing = empty). */
export function memoryRevision(files: Readonly<Record<BotMemoryTarget, RawMemoryFile>>): string {
  const hash = createHash("sha256");
  for (const target of BOT_MEMORY_TARGETS) {
    const file = files[target];
    hash.update(`${target}:${file.kind}:`);
    if (file.kind === "ok") hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
