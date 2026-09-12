import { createHash, randomBytes } from "node:crypto";
import type { ChatMeta } from "./types.js";

const SUMMARY_REVISION = /^rev_[A-Za-z0-9_-]{43}$/u;

/**
 * The summary revision is intentionally stored with both the chat payload and
 * its metadata row. New writes use an unpredictable token so two mutations in
 * the same millisecond remain distinguishable. Legacy rows get a deterministic
 * metadata-only token and can therefore be projected without opening a chat
 * transcript.
 */
export function chatSummaryRevision(meta: Readonly<ChatMeta>): string {
  if (typeof meta.summaryRevision === "string" && SUMMARY_REVISION.test(meta.summaryRevision)) {
    return meta.summaryRevision;
  }
  const legacy = {
    id: meta.id,
    workspaceId: meta.workspaceId ?? "default",
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  return `rev_${createHash("sha256").update(JSON.stringify(legacy)).digest("base64url")}`;
}

export function newChatSummaryRevision(): string {
  return `rev_${randomBytes(32).toString("base64url")}`;
}

export function isChatSummaryRevision(value: unknown): value is string {
  return typeof value === "string" && SUMMARY_REVISION.test(value);
}
