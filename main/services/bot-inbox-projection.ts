import { createHash } from "node:crypto";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type {
  AidenRemoteBotConversationItem,
  AidenRemoteBotConversationPage,
  AidenRemoteBotConversationQuery,
} from "./aiden-remote-protocol.js";
import type { ChatMeta } from "./types.js";
import { selectCanonicalBotChat } from "./bot-canonical-chat.js";

const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CURSOR_PATTERN =
  /^bi1\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/u;

export const BOT_INBOX_PROJECTION_LIMITS = Object.freeze({
  botCount: 256,
  favoriteCount: 20,
  indexEntries: 20_000,
  defaultPageSize: 30,
  pageSize: 50,
  searchCandidates: 200,
  queryScalars: 200,
  queryBytes: 800,
  titleScalars: 1_024,
  previewScalars: 500,
  cursorChars: 128,
  responseBytes: 256 * 1_024,
});

export type BotInboxActivity =
  | {
      activityState: "waiting_for_approval";
      canRespondToApproval: boolean;
    }
  | {
      activityState: "idle" | "queued" | "running" | "reconciling";
      canRespondToApproval: false;
    };

export type BotInboxBatchItem = BotInboxActivity & {
  chatId: string;
  /** A precomputed visible-message preview. Never pass a full chat payload here. */
  preview?: string;
};

export interface BotInboxBatchRequestItem {
  chatId: string;
  botId: string;
  updatedAt: number;
  /** Bounded value already maintained by the chat metadata index. */
  preview?: string;
}

export interface BotInboxProjectionDependencies {
  /** One main-owned Bot store read, including archived Bots. */
  listBots: () => Promise<readonly BotDefinition[]>;
  /** One indexed metadata read. This must not hydrate chat payloads. */
  listChatMetadata: () => Promise<readonly ChatMeta[]>;
  /**
   * One bounded lookup for precomputed previews and authoritative activity.
   * It must return one activity row for every requested chat; preview itself
   * remains optional when no bounded precomputed value is available.
   */
  projectBatch: (
    request: readonly BotInboxBatchRequestItem[],
  ) => Promise<readonly BotInboxBatchItem[]>;
}

/** Join the indexed bounded preview with the independently owned activity batch. */
export function mergeBotInboxActivityPreviews(
  request: readonly BotInboxBatchRequestItem[],
  activities: readonly BotInboxBatchItem[],
): BotInboxBatchItem[] {
  const previews = new Map(
    request.map(({ chatId, preview }) => [chatId, preview] as const),
  );
  return activities.map((activity) => ({
    ...activity,
    ...(previews.get(activity.chatId)
      ? { preview: previews.get(activity.chatId) }
      : {}),
  }));
}

interface IndexedBotChat {
  id: string;
  chatId: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  tieBreaker: string;
  preview?: string;
}

interface BotSearchIdentity {
  name: string;
  purpose: string;
}

interface CursorBoundary {
  updatedAt: number;
  tieBreaker: string;
}

export class BotInboxProjectionError extends Error {
  constructor(message = "The Bot inbox could not be projected safely.") {
    super(message);
    this.name = "BotInboxProjectionError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function scalarPrefix(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function isSafeTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/**
 * Preview and title text are deliberately more conservative than full-chat
 * projection. The inbox is ambient UI, so path-like and credential-like text
 * is redacted instead of surfacing private content outside the conversation.
 */
export function sanitizeBotInboxText(
  value: unknown,
  maximumScalars: number,
): string {
  if (typeof value !== "string") return "";
  const boundedInput = scalarPrefix(value, Math.min(maximumScalars * 8, 8_192));
  const withoutControls = Array.from(boundedInput, (character) => {
    const code = character.codePointAt(0)!;
    return (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
      ? " "
      : character;
  }).join("");
  const redacted = withoutControls
    .replace(
      /\b(?:authorization|proxy-authorization)\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/giu,
      "[private]",
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]+/giu,
      "[private]",
    )
    .replace(
      /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
      "[private]",
    )
    .replace(/\b(?:https?|file):\/\/[^\s<>()]+/giu, "[link]")
    .replace(
      /(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s<>()]+/gu,
      (match) => `${match.startsWith(" ") ? " " : ""}[file]`,
    )
    .replace(
      /(?:^|\s)(?:[A-Za-z]:\\|\\\\)[^\s<>()]+/gu,
      (match) => `${match.startsWith(" ") ? " " : ""}[file]`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  return scalarPrefix(redacted, maximumScalars);
}

function validateQuery(value: unknown): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    scalarLength(value) > BOT_INBOX_PROJECTION_LIMITS.queryScalars ||
    Buffer.byteLength(value, "utf8") > BOT_INBOX_PROJECTION_LIMITS.queryBytes
  ) {
    throw new BotInboxProjectionError("The Bot inbox search is invalid.");
  }
  return normalizedSearchText(value.trim());
}

function validateBotFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SAFE_BOT_ID.test(value)) {
    throw new BotInboxProjectionError("The Bot inbox filter is invalid.");
  }
  return value;
}

function validateLimit(value: unknown): number {
  if (value === undefined) return BOT_INBOX_PROJECTION_LIMITS.defaultPageSize;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > BOT_INBOX_PROJECTION_LIMITS.pageSize
  ) {
    throw new BotInboxProjectionError("The Bot inbox page size is invalid.");
  }
  return value as number;
}

function scopeDigest(query: string, botId: string | undefined): string {
  return digest(JSON.stringify({ query, botId: botId ?? null })).slice(0, 22);
}

function encodeCursor(item: IndexedBotChat, scope: string): string {
  return `bi1.${item.updatedAt.toString(36)}.${item.tieBreaker}.${scope}`;
}

function parseCursor(
  value: unknown,
  expectedScope: string,
): CursorBoundary | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > BOT_INBOX_PROJECTION_LIMITS.cursorChars
  ) {
    throw new BotInboxProjectionError("The Bot inbox cursor is invalid.");
  }
  const match = CURSOR_PATTERN.exec(value);
  if (!match || match[3] !== expectedScope) {
    throw new BotInboxProjectionError("The Bot inbox cursor is invalid.");
  }
  const updatedAt = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new BotInboxProjectionError("The Bot inbox cursor is invalid.");
  }
  return { updatedAt, tieBreaker: match[2]! };
}

function isAfterCursor(item: IndexedBotChat, cursor: CursorBoundary): boolean {
  return (
    item.updatedAt < cursor.updatedAt ||
    (item.updatedAt === cursor.updatedAt && item.tieBreaker < cursor.tieBreaker)
  );
}

function conversationRevision(item: IndexedBotChat): string {
  return `chat_${digest(
    JSON.stringify({
      id: item.chatId,
      botId: item.botId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }),
  )}`;
}

function projectActivity(
  value: BotInboxBatchItem | undefined,
): BotInboxActivity {
  if (!value) return { activityState: "idle", canRespondToApproval: false };
  if (value.activityState === "waiting_for_approval") {
    if (typeof value.canRespondToApproval !== "boolean") {
      throw new BotInboxProjectionError();
    }
    return {
      activityState: value.activityState,
      canRespondToApproval: value.canRespondToApproval,
    };
  }
  if (
    value.activityState === "idle" ||
    value.activityState === "queued" ||
    value.activityState === "running" ||
    value.activityState === "reconciling"
  ) {
    if (value.canRespondToApproval !== false) {
      throw new BotInboxProjectionError();
    }
    return { activityState: value.activityState, canRespondToApproval: false };
  }
  throw new BotInboxProjectionError();
}

function validatedBatch(
  requested: readonly IndexedBotChat[],
  values: readonly BotInboxBatchItem[],
): Map<string, BotInboxBatchItem> {
  if (values.length > requested.length) throw new BotInboxProjectionError();
  const requestedIds = new Set(requested.map((item) => item.chatId));
  const result = new Map<string, BotInboxBatchItem>();
  for (const value of values) {
    if (
      !value ||
      typeof value !== "object" ||
      !SAFE_CHAT_ID.test(value.chatId) ||
      !requestedIds.has(value.chatId) ||
      result.has(value.chatId)
    ) {
      throw new BotInboxProjectionError();
    }
    projectActivity(value);
    result.set(value.chatId, value);
  }
  if (result.size !== requested.length) throw new BotInboxProjectionError();
  return result;
}

function projectConversation(
  item: IndexedBotChat,
  batch: BotInboxBatchItem,
): AidenRemoteBotConversationItem {
  const title = sanitizeBotInboxText(
    item.title,
    BOT_INBOX_PROJECTION_LIMITS.titleScalars,
  );
  const preview = sanitizeBotInboxText(
    batch.preview,
    BOT_INBOX_PROJECTION_LIMITS.previewScalars,
  );
  return {
    chatId: item.chatId,
    botId: item.botId,
    title,
    ...(preview ? { preview } : {}),
    ...projectActivity(batch),
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
    revision: conversationRevision(item),
  };
}

function boundedResponse(
  selected: readonly IndexedBotChat[],
  conversations: AidenRemoteBotConversationItem[],
  scope: string,
  hasMore: boolean,
): AidenRemoteBotConversationPage {
  let retained = conversations;
  while (retained.length > 0) {
    const last = selected[retained.length - 1]!;
    const page: AidenRemoteBotConversationPage = {
      conversations: retained,
      ...(hasMore || retained.length < conversations.length
        ? { nextCursor: encodeCursor(last, scope) }
        : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify(page), "utf8") <=
      BOT_INBOX_PROJECTION_LIMITS.responseBytes
    ) {
      return page;
    }
    retained = retained.slice(0, -1);
  }
  if (selected.length > 0) {
    return { conversations: [], nextCursor: encodeCursor(selected[0]!, scope) };
  }
  return { conversations: [] };
}

function indexBotChats(
  metadata: readonly ChatMeta[],
  bots: ReadonlyMap<string, BotSearchIdentity>,
  botFilter: string | undefined,
): IndexedBotChat[] {
  if (metadata.length > BOT_INBOX_PROJECTION_LIMITS.indexEntries) {
    throw new BotInboxProjectionError(
      "The Bot inbox is too large to project safely.",
    );
  }
  const candidates: IndexedBotChat[] = [];
  for (const chat of metadata) {
    if (
      typeof chat.botId !== "string" ||
      !bots.has(chat.botId) ||
      (botFilter !== undefined && chat.botId !== botFilter) ||
      !SAFE_CHAT_ID.test(chat.id) ||
      !SAFE_BOT_ID.test(chat.botId) ||
      typeof chat.title !== "string" ||
      !isSafeTimestamp(chat.createdAt) ||
      !isSafeTimestamp(chat.updatedAt) ||
      chat.updatedAt < chat.createdAt
    ) {
      continue;
    }
    candidates.push({
      id: chat.id,
      chatId: chat.id,
      botId: chat.botId,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      tieBreaker: digest(chat.id),
      ...(typeof chat.preview === "string" ? { preview: chat.preview } : {}),
    });
  }
  const newestFirst = candidates.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (left.tieBreaker === right.tieBreaker) return 0;
    return left.tieBreaker < right.tieBreaker ? 1 : -1;
  });
  const byBot = new Map<string, IndexedBotChat[]>();
  for (const candidate of newestFirst) {
    const entries = byBot.get(candidate.botId) ?? [];
    entries.push(candidate);
    byBot.set(candidate.botId, entries);
  }
  const canonicalIds = new Set(
    [...byBot.values()]
      .map((entries) => selectCanonicalBotChat(entries)?.chatId)
      .filter((chatId): chatId is string => chatId !== undefined),
  );
  return newestFirst.filter((candidate) => canonicalIds.has(candidate.chatId));
}

function searchableIdentity(bot: BotDefinition): BotSearchIdentity {
  return {
    name: normalizedSearchText(
      sanitizeBotInboxText(bot.name, BOT_INBOX_PROJECTION_LIMITS.titleScalars),
    ),
    purpose: normalizedSearchText(
      sanitizeBotInboxText(
        bot.description ?? "",
        BOT_INBOX_PROJECTION_LIMITS.previewScalars,
      ),
    ),
  };
}

/**
 * Preserves the exact main-owned favorite order while dropping only corrupt,
 * unknown, duplicate, or archived entries from a read projection.
 */
export function projectBotFavoriteOrder(
  storedBotIds: readonly unknown[],
  bots: readonly Pick<BotDefinition, "id" | "archivedAt">[],
): string[] {
  const active = new Set(
    bots
      .slice(0, BOT_INBOX_PROJECTION_LIMITS.botCount)
      .filter((bot) => bot.archivedAt === undefined && SAFE_BOT_ID.test(bot.id))
      .map((bot) => bot.id),
  );
  const seen = new Set<string>();
  const projected: string[] = [];
  for (const value of storedBotIds) {
    if (
      projected.length >= BOT_INBOX_PROJECTION_LIMITS.favoriteCount ||
      typeof value !== "string" ||
      !active.has(value) ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    projected.push(value);
  }
  return projected;
}

export function createBotInboxProjectionService(
  dependencies: BotInboxProjectionDependencies,
) {
  return {
    async list(
      input: Readonly<AidenRemoteBotConversationQuery> = {},
    ): Promise<AidenRemoteBotConversationPage> {
      try {
        const query = validateQuery(input.query);
        const botFilter = validateBotFilter(input.botId);
        const limit = validateLimit(input.limit);
        const scope = scopeDigest(query, botFilter);
        const cursor = parseCursor(input.cursor, scope);

        const [botList, metadata] = await Promise.all([
          dependencies.listBots(),
          dependencies.listChatMetadata(),
        ]);
        if (botList.length > BOT_INBOX_PROJECTION_LIMITS.botCount) {
          throw new BotInboxProjectionError(
            "The Bot inbox contains too many Bots.",
          );
        }
        const bots = new Map<string, BotSearchIdentity>();
        for (const bot of botList) {
          if (!SAFE_BOT_ID.test(bot.id) || bots.has(bot.id)) continue;
          bots.set(bot.id, searchableIdentity(bot));
        }
        if (botFilter !== undefined && !bots.has(botFilter)) {
          return { conversations: [] };
        }

        const afterCursor = indexBotChats(metadata, bots, botFilter).filter(
          (item) => !cursor || isAfterCursor(item, cursor),
        );
        const candidateLimit = query
          ? BOT_INBOX_PROJECTION_LIMITS.searchCandidates
          : limit;
        const candidates = afterCursor.slice(0, candidateLimit);
        if (candidates.length === 0) return { conversations: [] };
        const batchValues = await dependencies.projectBatch(
          candidates.map(({ chatId, botId, updatedAt, preview }) => ({
            chatId,
            botId,
            updatedAt,
            ...(preview !== undefined ? { preview } : {}),
          })),
        );
        const batch = validatedBatch(candidates, batchValues);

        const matching = query
          ? candidates.filter((item) => {
              const identity = bots.get(item.botId)!;
              const title = normalizedSearchText(
                sanitizeBotInboxText(
                  item.title,
                  BOT_INBOX_PROJECTION_LIMITS.titleScalars,
                ),
              );
              const preview = normalizedSearchText(
                sanitizeBotInboxText(
                  batch.get(item.chatId)?.preview,
                  BOT_INBOX_PROJECTION_LIMITS.previewScalars,
                ),
              );
              return (
                identity.name.includes(query) ||
                identity.purpose.includes(query) ||
                title.includes(query) ||
                preview.includes(query)
              );
            })
          : candidates;
        const selected = matching.slice(0, limit);
        const conversations = selected.map((item) =>
          projectConversation(item, batch.get(item.chatId)!),
        );
        const scannedTo = candidates[candidates.length - 1];
        const moreMatchingInBatch = matching.length > selected.length;
        const moreCandidates = afterCursor.length > candidates.length;
        const hasMore = moreMatchingInBatch || moreCandidates;

        if (selected.length === 0 && hasMore && scannedTo) {
          return {
            conversations: [],
            nextCursor: encodeCursor(scannedTo, scope),
          };
        }
        return boundedResponse(selected, conversations, scope, hasMore);
      } catch (error) {
        if (error instanceof BotInboxProjectionError) throw error;
        throw new BotInboxProjectionError();
      }
    },
  };
}

export type BotInboxProjectionService = ReturnType<
  typeof createBotInboxProjectionService
>;
