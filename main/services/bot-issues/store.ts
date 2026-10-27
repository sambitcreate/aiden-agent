// The per-Bot issue store: one durable file beside the Bot's session
// (`<profile>/bots/<dir>/issues.json`), newest first.
//
// Writes are atomic and serialized per Bot, the same way the delivery log and
// routine notes are kept. A change is a serialized read-modify-write, so a
// concurrent raise and resolve can never overwrite each other. Reads are
// tolerant: unreadable or malformed content reads as no issues, and a row for
// another Bot is dropped.

import { promises as fs } from "node:fs";
import path from "node:path";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { BOT_ISSUE_LIMITS, botIssueOf, type BotIssue } from "../../../renderer/shared/bot-issues.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_ISSUES_FILE = "issues.json";

/**
 * A stored row: the issue the rest of the app reads, plus the service's own
 * bookkeeping. Neither flag is part of the shared contract or the chat card;
 * they only say which side effects a raise has already finished, so a retry
 * can send what is still missing instead of repeating a whole raise.
 */
export interface StoredBotIssue extends BotIssue {
  entryAppended?: boolean;
  delivered?: boolean;
}

export interface BotIssueChange<T> {
  /** The full file after the change, newest first. */
  issues: readonly StoredBotIssue[];
  /** What the caller gets back. */
  result: T;
}

export interface BotIssueStore {
  /** Every issue this Bot kept, newest first. */
  read(botId: string): Promise<StoredBotIssue[]>;
  /**
   * One read-modify-write for this Bot, serialized with every other change to
   * it. The change returns the whole file, so a caller never patches a row.
   */
  change<T>(botId: string, change: (issues: readonly StoredBotIssue[]) => BotIssueChange<T>): Promise<T>;
  forgetBot(botId: string): Promise<void>;
}

/** Keep the newest open issues and the newest settled ones; older rows fall off. */
function retain(issues: readonly StoredBotIssue[]): StoredBotIssue[] {
  let open = 0;
  let settled = 0;
  const kept: StoredBotIssue[] = [];
  for (const issue of issues) {
    if (issue.resolvedAt === undefined) {
      if (open >= BOT_ISSUE_LIMITS.openPerBot) continue;
      open += 1;
    } else {
      if (settled >= BOT_ISSUE_LIMITS.retainedResolved) continue;
      settled += 1;
    }
    kept.push(issue);
  }
  return kept;
}

/** One row, or null when it is malformed, another Bot's, or not an issue at all. */
function storedOf(row: unknown, botId: string): StoredBotIssue | null {
  const issue = botIssueOf(row, botId);
  if (issue === null) return null;
  const fields = row as Record<string, unknown>;
  return {
    ...issue,
    ...(typeof fields.entryAppended === "boolean" ? { entryAppended: fields.entryAppended } : {}),
    ...(typeof fields.delivered === "boolean" ? { delivered: fields.delivered } : {}),
  };
}

/** Every issue this Bot kept; unreadable or malformed content reads as none. */
function parseFile(text: string, botId: string): StoredBotIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return retain(
    parsed
      .map((row) => storedOf(row, botId))
      .filter((issue): issue is StoredBotIssue => issue !== null),
  );
}

export function createBotIssueStore(options: { profileDir(): string }): BotIssueStore {
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_ISSUES_FILE);

  async function load(botId: string): Promise<StoredBotIssue[]> {
    try {
      return parseFile(await fs.readFile(fileOf(botId), "utf8"), botId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function save(botId: string, issues: readonly StoredBotIssue[]): Promise<void> {
    await writeJsonAtomic(fileOf(botId), retain(issues), { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    read: (botId) => load(botId),

    change<T>(botId: string, apply: (issues: readonly StoredBotIssue[]) => BotIssueChange<T>): Promise<T> {
      return serial(botId, async () => {
        const { issues, result } = apply(await load(botId));
        await save(botId, issues);
        return result;
      });
    },

    forgetBot(botId) {
      return serial(botId, async () => {
        await fs.rm(fileOf(botId), { force: true });
      });
    },
  };
}
