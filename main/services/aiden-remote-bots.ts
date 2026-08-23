import { createHash } from "node:crypto";
import type {
  BotAccessUpdate,
  BotAccessView,
  BotCapabilityCatalog,
  BotChatAccessUpdate,
  BotChatAccessView,
} from "../../renderer/shared/bot-capabilities.js";
import type {
  BotCreateInput,
  BotDefinition,
  BotUpdateInput,
} from "../../renderer/shared/bots.js";
import {
  BotCapabilityCatalogConflictError,
  BotCapabilityRevisionConflictError,
  BotCapabilitySubsetError,
  BotCapabilityUnavailableError,
} from "./bot-capability-store-core.js";
import { BotIdentityRevisionConflictError } from "./bot-store-core.js";
import { projectAidenRemoteChat, type AidenRemoteChatProjection } from "./aiden-remote-chats.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  AidenOperationContractError,
} from "./aiden-remote-operation-contract.js";
import {
  parseAidenRemoteBotAvatarUploadRequest,
  parseAidenRemoteBotAccessUpdateRequest,
  parseAidenRemoteBotAccessView,
  parseAidenRemoteBotCapabilityCatalog,
  parseAidenRemoteBotChatAccessUpdateRequest,
  parseAidenRemoteBotChatAccessView,
  parseAidenRemoteBotChatCreateRequest,
  parseAidenRemoteBotCreateRequest,
  parseAidenRemoteBotDetail,
  parseAidenRemoteBotFavoritesUpdateRequest,
  parseAidenRemoteBotFavoritesView,
  parseAidenRemoteBotIdentityPatchRequest,
  parseAidenRemoteBotList,
  parseAidenRemoteBotSummary,
  type AidenRemoteBotAccessView,
  type AidenRemoteBotAvatarView,
  type AidenRemoteBotAvatarAsset,
  type AidenRemoteBotAvatarUploadRequest,
  type AidenRemoteBotCapabilityCatalog,
  type AidenRemoteBotChatAccessView,
  type AidenRemoteBotDetail,
  type AidenRemoteBotFavoritesUpdateRequest,
  type AidenRemoteBotFavoritesView,
  type AidenRemoteBotHealth,
  type AidenRemoteBotList,
  type AidenRemoteBotSummary,
  type AidenRemoteBotConversationPage,
  type AidenRemoteBotConversationQuery,
} from "./aiden-remote-protocol.js";
import type { BotAvatarApplicationAdapter } from "./bot-avatar-application-adapter.js";
import {
  BotAvatarInputError,
  BotAvatarReplayError,
  BotAvatarRevisionConflictError,
  BotAvatarStateError,
  BotAvatarUnavailableError,
  type BotAvatarContent,
} from "./bot-avatar-store-core.js";
import type { Chat } from "./types.js";
import { BotApplicationUnavailableError } from "./bot-application-service.js";
import { BotRuntimeInventoryLeaseInvalidError } from "./bot-runtime-inventory-lease.js";

const BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CHAT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/u;
const MAX_BOTS = 256;
const MAX_FAVORITES = 20;

async function mapBounded<Input, Output>(
  values: readonly Input[],
  limit: number,
  project: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await project(values[index]!);
    }
  }));
  return output;
}

export interface AidenRemoteBotFavoritesSnapshot {
  version: 1;
  botIds: string[];
}

export const EMPTY_AIDEN_REMOTE_BOT_FAVORITES: AidenRemoteBotFavoritesSnapshot = {
  version: 1,
  botIds: [],
};

export function normalizeAidenRemoteBotFavoritesSnapshot(
  value: unknown,
): AidenRemoteBotFavoritesSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { botIds?: unknown }).botIds)
  ) {
    throw new Error("Bot favorites storage is invalid.");
  }
  const keys = Object.keys(value);
  const botIds = (value as { botIds: unknown[] }).botIds;
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("botIds") ||
    botIds.length > MAX_FAVORITES ||
    botIds.some((id) => typeof id !== "string" || !BOT_ID.test(id)) ||
    new Set(botIds).size !== botIds.length
  ) {
    throw new Error("Bot favorites storage is invalid.");
  }
  return { version: 1, botIds: [...botIds] as string[] };
}

function favoriteRevision(botIds: readonly string[]): string {
  return `botfavrev_${createHash("sha256")
    .update(JSON.stringify(botIds), "utf8")
    .digest("base64url")}`;
}

function safeBotId(value: string): string {
  if (!BOT_ID.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The Bot identifier is invalid.", 400);
  }
  return value;
}

function safeChatId(value: string): string {
  if (!CHAT_ID.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The chat identifier is invalid.", 400);
  }
  return value;
}

function parseRequest<Result>(
  parser: (value: unknown) => Result,
  value: unknown,
  message: string,
): Result {
  try {
    return parser(value);
  } catch {
    throw new AidenRemoteServiceError("invalid_request", message, 400);
  }
}

function mapBotMutationError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  if (error instanceof BotApplicationUnavailableError) {
    throw error.reason === "archived"
      ? new AidenRemoteServiceError(
          "bot_archived",
          "Restore this Bot before making changes.",
          409,
        )
      : new AidenRemoteServiceError(
          "not_found",
          "This Bot no longer exists.",
          404,
        );
  }
  if (
    error instanceof BotIdentityRevisionConflictError ||
    error instanceof BotCapabilityRevisionConflictError ||
    error instanceof BotCapabilityCatalogConflictError
  ) {
    throw new AidenRemoteServiceError(
      "revision_conflict",
      "This Bot changed. Refresh it before trying again.",
      409,
      false,
      { currentRevision: error.currentRevision },
    );
  }
  if (error instanceof BotCapabilitySubsetError) {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "This chat cannot use more access than its Bot allows.",
      403,
    );
  }
  if (error instanceof BotCapabilityUnavailableError) {
    throw new AidenRemoteServiceError(
      "operation_stale",
      "Some selected Bot access is unavailable. Refresh and review it on your Mac.",
      409,
      true,
    );
  }
  if (error instanceof BotRuntimeInventoryLeaseInvalidError) {
    throw new AidenRemoteServiceError(
      "operation_stale",
      "Bot capabilities changed. Refresh and try again.",
      409,
      true,
    );
  }
  if (error instanceof AidenOperationContractError) {
    throw new AidenRemoteServiceError(
      error.code,
      "This Bot request cannot be safely repeated.",
      error.code === "idempotency_capacity" ? 429 : 409,
      error.code === "idempotency_capacity",
    );
  }
  throw error;
}

function defaultAvatar(bot: BotDefinition): AidenRemoteBotAvatarView {
  return { semantic: structuredClone(bot.avatar) };
}

export function projectAidenRemoteBotSummary(
  bot: BotDefinition,
  avatar: AidenRemoteBotAvatarView = defaultAvatar(bot),
  health: Exclude<AidenRemoteBotHealth, "archived"> = "ready",
): AidenRemoteBotSummary {
  const base = {
    id: bot.id,
    name: bot.name,
    purpose: bot.description ?? "",
    avatar,
    createdAt: new Date(bot.createdAt).toISOString(),
    updatedAt: new Date(bot.updatedAt).toISOString(),
    revision: bot.revision,
  };
  return parseAidenRemoteBotSummary(
    bot.archivedAt === undefined
      ? { ...base, health }
      : { ...base, health: "archived", archivedAt: new Date(bot.archivedAt).toISOString() },
  );
}

type BotApplicationPort = {
  list(includeArchived?: boolean): Promise<BotDefinition[]>;
  get(botId: string): Promise<BotDefinition | null>;
  createBot(input: {
    audienceId: string;
    bot: BotCreateInput;
    access?: BotAccessUpdate;
  }): Promise<BotDefinition>;
  updateBot(input: BotUpdateInput): Promise<BotDefinition>;
  archiveBot(input: { botId: string; expectedRevision: string }): Promise<BotDefinition>;
  restoreBot(input: { botId: string; expectedRevision: string }): Promise<BotDefinition>;
  createChat(input: {
    audienceId: string;
    botId: string;
    providerId?: string;
    model?: string;
    assertCurrent?: () => void;
  }): Promise<Chat>;
  capabilityCatalog(audienceId: string, botId?: string): Promise<BotCapabilityCatalog>;
  getBotAccess(botId: string): Promise<BotAccessView>;
  updateBotAccess(input: {
    audienceId: string;
    botId: string;
    expectedRevision: string;
    access: BotAccessUpdate;
  }): Promise<BotAccessView>;
  getChatAccess(chatId: string): Promise<BotChatAccessView>;
  updateChatAccess(input: {
    audienceId: string;
    botId: string;
    chatId: string;
    expectedRevision: string;
    access: BotChatAccessUpdate;
  }): Promise<BotChatAccessView>;
  withBotMutation?<Result>(
    botId: string,
    action: () => Promise<Result>,
  ): Promise<Result>;
};

export interface AidenRemoteBotServiceOptions {
  application: BotApplicationPort;
  chatStore: { get(chatId: string): Promise<Chat | null> };
  favorites: {
    load(): Promise<AidenRemoteBotFavoritesSnapshot>;
    save(snapshot: AidenRemoteBotFavoritesSnapshot): Promise<void>;
  };
  withFavoritesMutation?<Result>(action: () => Promise<Result>): Promise<Result>;
  resolveProviderModel?: (input: {
    audienceId: string;
    botId: string;
    providerId?: string;
    modelId?: string;
  }) => Promise<{
    providerId: string;
    model: string;
    assertCurrent?: () => void;
    release?: () => void;
  }>;
  avatar?: Pick<BotAvatarApplicationAdapter, "view" | "put" | "delete" | "content">;
  inbox?: {
    list(
      deviceId: string,
      input: Readonly<AidenRemoteBotConversationQuery>,
    ): Promise<AidenRemoteBotConversationPage>;
  };
  health?: (botId: string) => Promise<Exclude<AidenRemoteBotHealth, "archived">>;
  healthBatch?: (
    botIds: readonly string[],
  ) => Promise<ReadonlyMap<string, Exclude<AidenRemoteBotHealth, "archived">>>;
  idempotency?: AidenIdempotencyLedger;
  persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
  notifyBotsChanged?: (botId?: string) => void;
  notifyChatsChanged?: (chatId?: string) => void;
}

export class AidenRemoteBotService {
  private readonly idempotency: AidenIdempotencyLedger;
  private favoritesTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: AidenRemoteBotServiceOptions) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  private serializeFavorites<Result>(action: () => Promise<Result>): Promise<Result> {
    if (this.options.withFavoritesMutation) {
      return this.options.withFavoritesMutation(action);
    }
    const result = this.favoritesTail.then(action, action);
    this.favoritesTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private withBotMutationLocks<Result>(
    botIds: readonly string[],
    action: () => Promise<Result>,
  ): Promise<Result> {
    const ids = [...new Set(botIds)].sort();
    const lock = this.options.application.withBotMutation;
    if (!lock || ids.length === 0) return action();
    const acquire = (index: number): Promise<Result> =>
      index >= ids.length
        ? action()
        : lock(ids[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  private async executeIdempotent<Result>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<Result>,
  ): Promise<Result> {
    if (!IDEMPOTENCY_KEY.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    if (!this.options.persistIdempotency) {
      return this.idempotency.execute(scope, input, action);
    }
    let admit!: () => void;
    let reject!: (error: unknown) => void;
    const durableAdmission = new Promise<void>((resolve, rejectPromise) => {
      admit = resolve;
      reject = rejectPromise;
    });
    const pending = this.idempotency.execute(scope, input, async () => {
      await durableAdmission;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      admit();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      throw new AidenRemoteServiceError(
        "internal_error",
        "Aiden could not durably prepare this Bot request.",
        500,
      );
    }
    let result: Result | undefined;
    let failure: unknown;
    try {
      result = await pending;
    } catch (error) {
      failure = error;
    }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError(
        "idempotency_in_flight",
        "The Bot change may have completed, but Aiden could not record its outcome.",
        409,
      );
    }
    if (failure) throw failure;
    return result!;
  }

  private async bot(botId: string, includeArchived = true): Promise<BotDefinition> {
    const bot = await this.options.application.get(safeBotId(botId));
    if (!bot || (!includeArchived && bot.archivedAt !== undefined)) {
      throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
    }
    return bot;
  }

  private requireActive(bot: BotDefinition): void {
    if (bot.archivedAt !== undefined) {
      throw new AidenRemoteServiceError(
        "bot_archived",
        "Restore this Bot before making changes.",
        409,
      );
    }
  }

  private requireAvatarRevision(
    bot: BotDefinition,
    assetRevision: string | undefined,
    expectedRevision: string,
  ): void {
    const currentRevision = assetRevision ?? bot.revision;
    if (expectedRevision !== currentRevision) {
      throw new AidenRemoteServiceError(
        "revision_conflict",
        "This Bot photo changed. Refresh it before trying again.",
        409,
        false,
        { currentRevision },
      );
    }
  }

  private avatarOperationId(parts: readonly string[]): string {
    return `avatarop_${createHash("sha256")
      .update(JSON.stringify(parts), "utf8")
      .digest("base64url")}`;
  }

  private mapAvatarError(error: unknown): never {
    if (error instanceof AidenRemoteServiceError) throw error;
    if (
      error instanceof AidenOperationContractError ||
      error instanceof BotApplicationUnavailableError
    ) {
      return mapBotMutationError(error);
    }
    if (error instanceof BotAvatarInputError) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "That Bot photo could not be decoded safely.",
        400,
      );
    }
    if (error instanceof BotAvatarRevisionConflictError) {
      throw new AidenRemoteServiceError(
        "revision_conflict",
        "This Bot photo changed. Refresh it before trying again.",
        409,
      );
    }
    if (error instanceof BotAvatarUnavailableError) {
      throw new AidenRemoteServiceError("not_found", "This Bot photo is unavailable.", 404);
    }
    if (error instanceof BotAvatarReplayError) {
      throw new AidenRemoteServiceError(
        "idempotency_conflict",
        "This Bot photo request cannot be safely repeated.",
        409,
      );
    }
    if (error instanceof BotAvatarStateError) {
      throw new AidenRemoteServiceError(
        "internal_error",
        "Aiden could not verify its Bot photo store.",
        500,
      );
    }
    throw error;
  }

  private async avatar(bot: BotDefinition): Promise<AidenRemoteBotAvatarView> {
    if (!this.options.avatar) return defaultAvatar(bot);
    try {
      return structuredClone(await this.options.avatar.view(bot.id, bot.avatar));
    } catch {
      // Asset corruption or a rollback companion failure must not make the Bot
      // identity unreadable. The semantic avatar is the canonical safe fallback.
      return defaultAvatar(bot);
    }
  }

  private async summary(
    bot: BotDefinition,
    projectedHealth?: Exclude<AidenRemoteBotHealth, "archived">,
  ): Promise<AidenRemoteBotSummary> {
    const health = bot.archivedAt === undefined
      ? projectedHealth ?? await this.options.health?.(bot.id) ?? "ready"
      : "ready";
    return projectAidenRemoteBotSummary(bot, await this.avatar(bot), health);
  }

  private async detail(bot: BotDefinition): Promise<AidenRemoteBotDetail> {
    const [summary, access] = await Promise.all([
      this.summary(bot),
      this.options.application.getBotAccess(bot.id),
    ]);
    return parseAidenRemoteBotDetail({
      ...summary,
      instructions: bot.instructions,
      ...(bot.openingGreeting === undefined ? {} : { openingGreeting: bot.openingGreeting }),
      access: parseAidenRemoteBotAccessView(access),
    });
  }

  private async favoritesViewUnderLock(
    activeBotIds?: ReadonlySet<string>,
  ): Promise<AidenRemoteBotFavoritesView> {
    const snapshot = normalizeAidenRemoteBotFavoritesSnapshot(await this.options.favorites.load());
    const active = activeBotIds ?? new Set(
      (await this.options.application.list(false)).map(({ id }) => id),
    );
    const botIds = snapshot.botIds.filter((botId) => active.has(botId));
    if (botIds.length !== snapshot.botIds.length) {
      await this.options.favorites.save({ version: 1, botIds });
    }
    return parseAidenRemoteBotFavoritesView({
      botIds,
      revision: favoriteRevision(botIds),
    });
  }

  private favoritesView(activeBotIds?: ReadonlySet<string>): Promise<AidenRemoteBotFavoritesView> {
    return this.serializeFavorites(() => this.favoritesViewUnderLock(activeBotIds));
  }

  async list(includeArchived = false): Promise<AidenRemoteBotList> {
    const bots = await this.options.application.list(includeArchived);
    if (bots.length > MAX_BOTS) {
      throw new AidenRemoteServiceError("internal_error", "Aiden has too many Bots to project safely.", 500);
    }
    const active = new Set(bots.filter(({ archivedAt }) => archivedAt === undefined).map(({ id }) => id));
    const activeBots = bots.filter(({ archivedAt }) => archivedAt === undefined);
    const health = await this.options.healthBatch?.(activeBots.map(({ id }) => id));
    const [summaries, favorites] = await Promise.all([
      mapBounded(bots, 8, (bot) => this.summary(bot, health?.get(bot.id))),
      this.favoritesView(active),
    ]);
    return parseAidenRemoteBotList({ bots: summaries, maxBots: MAX_BOTS, favorites });
  }

  async get(botId: string): Promise<AidenRemoteBotDetail> {
    return this.detail(await this.bot(botId));
  }

  async listConversations(
    deviceId: string,
    input: Readonly<AidenRemoteBotConversationQuery>,
  ): Promise<AidenRemoteBotConversationPage> {
    if (!this.options.inbox) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return this.options.inbox.list(deviceId, input);
  }

  async putAvatar(
    deviceId: string,
    botId: string,
    expectedRevision: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<AidenRemoteBotAvatarAsset> {
    if (!this.options.avatar || !this.options.application.withBotMutation) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    const parsed = parseRequest(
      parseAidenRemoteBotAvatarUploadRequest,
      input,
      "The Bot photo upload is invalid.",
    );
    try {
      return await this.executeIdempotent(
        {
          deviceId,
          route: "PUT /bots/{id}/avatar",
          resourceId: safeBotId(botId),
          key: idempotencyKey,
        },
        { expectedRevision, upload: parsed },
        () => this.options.application.withBotMutation!(botId, async () => {
          const current = await this.bot(botId, false);
          const currentAsset = await this.options.avatar!.view(current.id, current.avatar);
          this.requireAvatarRevision(
            current,
            currentAsset.asset?.assetRevision,
            expectedRevision,
          );
          const result = await this.options.avatar!.put(
            {
              botId: current.id,
              expectedAssetRevision: currentAsset.asset?.assetRevision ?? null,
              operationId: this.avatarOperationId([
                "put",
                deviceId,
                current.id,
                idempotencyKey,
              ]),
            },
            parsed as AidenRemoteBotAvatarUploadRequest,
          );
          this.options.notifyBotsChanged?.(current.id);
          return result;
        }),
      );
    } catch (error) {
      return this.mapAvatarError(error);
    }
  }

  async deleteAvatar(
    botId: string,
    expectedRevision: string,
  ): Promise<AidenRemoteBotDetail> {
    if (!this.options.avatar || !this.options.application.withBotMutation) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    try {
      const bot = await this.options.application.withBotMutation(botId, async () => {
        const current = await this.bot(botId, false);
        const currentAsset = await this.options.avatar!.view(current.id, current.avatar);
        const assetRevision = currentAsset.asset?.assetRevision ?? null;
        this.requireAvatarRevision(
          current,
          currentAsset.asset?.assetRevision,
          expectedRevision,
        );
        await this.options.avatar!.delete({
          botId: current.id,
          expectedAssetRevision: assetRevision,
          operationId: this.avatarOperationId([
            "delete",
            current.id,
            expectedRevision,
            assetRevision ?? "semantic",
          ]),
        });
        return current;
      });
      this.options.notifyBotsChanged?.(bot.id);
      return this.detail(bot);
    } catch (error) {
      return this.mapAvatarError(error);
    }
  }

  async avatarContent(
    botId: string,
    assetRevision: string,
  ): Promise<BotAvatarContent> {
    if (!this.options.avatar) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    await this.bot(botId, true);
    try {
      return await this.options.avatar.content(botId, assetRevision);
    } catch (error) {
      return this.mapAvatarError(error);
    }
  }

  async create(
    deviceId: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<AidenRemoteBotDetail> {
    const parsed = parseRequest(
      parseAidenRemoteBotCreateRequest,
      input,
      "The Bot creation request is invalid.",
    );
    try {
      return await this.executeIdempotent(
        {
          deviceId,
          route: "POST /bots",
          resourceId: "bot-registry",
          key: idempotencyKey,
        },
        parsed,
        async () => {
          const created = await this.options.application.createBot({
            audienceId: deviceId,
            bot: {
              name: parsed.name,
              ...(parsed.purpose ? { description: parsed.purpose } : {}),
              instructions: parsed.instructions,
              ...(parsed.openingGreeting ? { openingGreeting: parsed.openingGreeting } : {}),
              avatar: structuredClone(parsed.avatar),
            },
            access: parsed.access as BotAccessUpdate,
          });
          this.options.notifyBotsChanged?.(created.id);
          return this.detail(created);
        },
      );
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async updateIdentity(
    botId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteBotDetail> {
    const parsed = parseRequest(
      parseAidenRemoteBotIdentityPatchRequest,
      input,
      "The Bot identity update is invalid.",
    );
    const existing = await this.bot(botId);
    this.requireActive(existing);
    try {
      const updated = await this.options.application.updateBot({
        id: existing.id,
        expectedRevision,
        name: parsed.name ?? existing.name,
        ...(parsed.purpose !== undefined
          ? parsed.purpose ? { description: parsed.purpose } : {}
          : existing.description ? { description: existing.description } : {}),
        instructions: parsed.instructions ?? existing.instructions,
        ...(parsed.openingGreeting !== undefined
          ? parsed.openingGreeting ? { openingGreeting: parsed.openingGreeting } : {}
          : existing.openingGreeting ? { openingGreeting: existing.openingGreeting } : {}),
        avatar: structuredClone(parsed.avatar ?? existing.avatar),
      });
      this.options.notifyBotsChanged?.(updated.id);
      return this.detail(updated);
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async archive(botId: string, expectedRevision: string): Promise<AidenRemoteBotDetail> {
    const existing = await this.bot(botId);
    this.requireActive(existing);
    try {
      // The application archive hook shares the process-wide favorites lane.
      // Do not hold that lane while invoking the hook or it would self-deadlock.
      const archived = await this.options.application.archiveBot({
        botId: existing.id,
        expectedRevision,
      });
      await this.favoritesView();
      this.options.notifyBotsChanged?.(archived.id);
      return this.detail(archived);
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async restore(
    deviceId: string,
    botId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): Promise<AidenRemoteBotDetail> {
    const existing = await this.bot(botId);
    try {
      return await this.executeIdempotent(
        {
          deviceId,
          route: "POST /bots/{id}/restore",
          resourceId: existing.id,
          key: idempotencyKey,
        },
        { expectedRevision },
        async () => {
          const restored = await this.options.application.restoreBot({
            botId: existing.id,
            expectedRevision,
          });
          this.options.notifyBotsChanged?.(restored.id);
          return this.detail(restored);
        },
      );
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async capabilityCatalog(
    deviceId: string,
    botId?: string,
  ): Promise<AidenRemoteBotCapabilityCatalog> {
    if (botId !== undefined) await this.bot(botId);
    return parseAidenRemoteBotCapabilityCatalog(
      await this.options.application.capabilityCatalog(deviceId, botId),
    );
  }

  async updateAccess(
    deviceId: string,
    botId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteBotAccessView> {
    const parsed = parseRequest(
      parseAidenRemoteBotAccessUpdateRequest,
      input,
      "The Bot access update is invalid.",
    );
    const existing = await this.bot(botId);
    this.requireActive(existing);
    try {
      const access = await this.options.application.updateBotAccess({
        audienceId: deviceId,
        botId: existing.id,
        expectedRevision,
        access: parsed as BotAccessUpdate,
      });
      this.options.notifyBotsChanged?.(existing.id);
      return parseAidenRemoteBotAccessView(access);
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async createChat(
    deviceId: string,
    botId: string,
    idempotencyKey: string,
    input: unknown,
  ): Promise<AidenRemoteChatProjection> {
    const parsed = parseRequest(
      parseAidenRemoteBotChatCreateRequest,
      input,
      "The Bot chat creation request is invalid.",
    );
    const existing = await this.bot(botId);
    this.requireActive(existing);
    try {
      return await this.executeIdempotent(
        {
          deviceId,
          route: "POST /bots/{id}/chats",
          resourceId: existing.id,
          key: idempotencyKey,
        },
        parsed,
        async () => {
          const access = await this.options.application.getBotAccess(existing.id);
          if (
            access.accessMode === "custom" &&
            ((parsed.providerId !== undefined && parsed.providerId !== access.custom.providerId) ||
              (parsed.modelId !== undefined && parsed.modelId !== access.custom.modelId))
          ) {
            throw new AidenRemoteServiceError(
              "capability_denied",
              "This Custom Bot must use its selected provider and model.",
              403,
            );
          }
          const provider = await this.resolveProviderModel(deviceId, existing.id,
            access.accessMode === "full" ? {
                ...(parsed.providerId !== undefined ? { providerId: parsed.providerId } : {}),
                ...(parsed.modelId !== undefined ? { modelId: parsed.modelId } : {}),
              } : {
                providerId: access.custom.providerId,
                modelId: access.custom.modelId,
              });
          let chat: Chat;
          try {
            chat = await this.options.application.createChat({
              audienceId: deviceId,
              botId: existing.id,
              providerId: provider.providerId,
              model: provider.model,
              assertCurrent: provider.assertCurrent,
            });
          } finally {
            provider.release?.();
          }
          if (chat.botId !== existing.id) {
            throw new AidenRemoteServiceError(
              "internal_error",
              "Aiden did not create an authoritative Bot chat.",
              500,
            );
          }
          this.options.notifyChatsChanged?.(chat.id);
          return projectAidenRemoteChat(chat);
        },
      );
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  private async resolveProviderModel(
    audienceId: string,
    botId: string,
    selection: { providerId?: string; modelId?: string },
  ): Promise<{
    providerId: string;
    model: string;
    assertCurrent?: () => void;
    release?: () => void;
  }> {
    if (!this.options.resolveProviderModel) {
      throw new AidenRemoteServiceError(
        "operation_stale",
        "Provider selection is unavailable. Refresh the Bot capability list.",
        409,
        true,
      );
    }
    return this.options.resolveProviderModel({
      audienceId,
      botId,
      ...(selection.providerId !== undefined ? { providerId: selection.providerId } : {}),
      ...(selection.modelId !== undefined ? { modelId: selection.modelId } : {}),
    });
  }

  async getChatAccess(chatId: string): Promise<AidenRemoteBotChatAccessView> {
    const chat = await this.options.chatStore.get(safeChatId(chatId));
    if (!chat?.botId) {
      throw new AidenRemoteServiceError("not_found", "This Bot chat no longer exists.", 404);
    }
    const access = await this.options.application.getChatAccess(chat.id);
    if (access.botId !== chat.botId || access.chatId !== chat.id) {
      throw new AidenRemoteServiceError("not_found", "This Bot chat no longer exists.", 404);
    }
    return parseAidenRemoteBotChatAccessView(access);
  }

  async updateChatAccess(
    deviceId: string,
    chatId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteBotChatAccessView> {
    const parsed = parseRequest(
      parseAidenRemoteBotChatAccessUpdateRequest,
      input,
      "The Bot chat access update is invalid.",
    );
    const chat = await this.options.chatStore.get(safeChatId(chatId));
    if (!chat?.botId) {
      throw new AidenRemoteServiceError("not_found", "This Bot chat no longer exists.", 404);
    }
    const bot = await this.bot(chat.botId);
    this.requireActive(bot);
    try {
      const access = await this.options.application.updateChatAccess({
        audienceId: deviceId,
        botId: bot.id,
        chatId: chat.id,
        expectedRevision,
        access: parsed as BotChatAccessUpdate,
      });
      this.options.notifyChatsChanged?.(chat.id);
      return parseAidenRemoteBotChatAccessView(access);
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  async favorites(): Promise<AidenRemoteBotFavoritesView> {
    return this.favoritesView();
  }

  async updateFavorites(
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteBotFavoritesView> {
    const parsed = parseRequest(
      parseAidenRemoteBotFavoritesUpdateRequest,
      input,
      "The Bot favorites update is invalid.",
    );
    const requested = (parsed as AidenRemoteBotFavoritesUpdateRequest).botIds;
    // Match the desktop archive lock order: sorted Bot gates, then the one
    // process-wide favorites lane. This makes update-vs-archive linearizable.
    try {
      return await this.withBotMutationLocks(requested, () => this.serializeFavorites(async () => {
      const snapshot = normalizeAidenRemoteBotFavoritesSnapshot(await this.options.favorites.load());
      const activeBots = await this.options.application.list(false);
      const allBots = await this.options.application.list(true);
      const activeIds = new Set(activeBots.map(({ id }) => id));
      const archivedIds = new Set(
        allBots.filter(({ archivedAt }) => archivedAt !== undefined).map(({ id }) => id),
      );
      const currentIds = snapshot.botIds.filter((id) => activeIds.has(id));
      const currentRevision = favoriteRevision(currentIds);
      if (expectedRevision !== currentRevision) {
        throw new AidenRemoteServiceError(
          "revision_conflict",
          "Bot favorites changed. Refresh them before trying again.",
          409,
          false,
          { currentRevision },
        );
      }
      const archived = requested.find((id) => archivedIds.has(id));
      if (archived) {
        throw new AidenRemoteServiceError(
          "bot_archived",
          "Archived Bots cannot be added to favorites.",
          409,
        );
      }
      if (requested.some((id) => !activeIds.has(id))) {
        throw new AidenRemoteServiceError("not_found", "A selected Bot no longer exists.", 404);
      }
      await this.options.favorites.save({ version: 1, botIds: [...requested] });
      this.options.notifyBotsChanged?.();
      return parseAidenRemoteBotFavoritesView({
        botIds: requested,
        revision: favoriteRevision(requested),
      });
      }));
    } catch (error) {
      return mapBotMutationError(error);
    }
  }
}
