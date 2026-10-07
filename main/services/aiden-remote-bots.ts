import { createHash } from "node:crypto";
import {
  BotCapabilityValidationError,
  type BotAccessUpdate,
  type BotAccessView,
  type BotCapabilityCatalog,
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
  parseAidenRemoteBotChatCreateRequest,
  parseAidenRemoteBotCreateRequest,
  parseAidenRemoteBotDetail,
  parseAidenRemoteBotIdentityPatchRequest,
  parseAidenRemoteBotList,
  parseAidenRemoteBotSummary,
  type AidenRemoteBotAccessView,
  type AidenRemoteBotAvatarView,
  type AidenRemoteBotAvatarAsset,
  type AidenRemoteBotAvatarUploadRequest,
  type AidenRemoteBotCapabilityCatalog,
  type AidenRemoteBotDetail,
  type AidenRemoteBotHealth,
  type AidenRemoteBotList,
  type AidenRemoteBotSummary,
  type AidenRemoteBotConversationPage,
  type AidenRemoteBotConversationQuery,
  type AidenRemoteBotSessionStateKind,
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
import {
  BotApplicationUnavailableError,
  BotHistoricalChatReadOnlyError,
} from "./bot-application-service.js";
import { BotRuntimeInventoryLeaseInvalidError } from "./bot-runtime-inventory-lease.js";

const BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/u;
const MAX_BOTS = 256;

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

function safeBotId(value: string): string {
  if (!BOT_ID.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The Bot identifier is invalid.", 400);
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

function archiveRetiredError(): AidenRemoteServiceError {
  return new AidenRemoteServiceError(
    "invalid_request",
    "Bots can no longer be archived or restored. Delete the Bot on your Mac instead.",
    400,
  );
}

function mapBotMutationError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  if (error instanceof BotApplicationUnavailableError) {
    throw new AidenRemoteServiceError(
      "not_found",
      "This Bot no longer exists.",
      404,
    );
  }
  if (error instanceof BotHistoricalChatReadOnlyError) {
    throw new AidenRemoteServiceError(
      "operation_stale",
      "This historical Bot chat is read-only. Open the Bot's current chat.",
      409,
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
  if (error instanceof BotCapabilityValidationError) {
    throw new AidenRemoteServiceError(
      "operation_stale",
      "Bot capabilities changed. Refresh and review the current access choices.",
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

function recipe(avatar: BotDefinition["avatar"]): AidenRemoteBotAvatarView["semantic"] {
  return { version: 1, shape: avatar.shape, color: avatar.color };
}

function defaultAvatar(bot: BotDefinition): AidenRemoteBotAvatarView {
  return { semantic: recipe(bot.avatar) };
}

export function projectAidenRemoteBotSummary(
  bot: BotDefinition,
  avatar: AidenRemoteBotAvatarView = defaultAvatar(bot),
  health: AidenRemoteBotHealth = "ready",
  sessionState?: AidenRemoteBotSessionStateKind,
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
  return parseAidenRemoteBotSummary({
    ...base,
    health,
    ...(sessionState === undefined ? {} : { sessionState }),
  });
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
  createChat(input: {
    audienceId: string;
    botId: string;
    providerId?: string;
    model?: string;
    assertCurrent?: () => void;
  }): Promise<Chat>;
  getCanonicalChat(botId: string): Promise<Chat | null>;
  capabilityCatalog(audienceId: string, botId?: string): Promise<BotCapabilityCatalog>;
  getBotAccess(botId: string): Promise<BotAccessView>;
  modelSelection?(
    audienceId: string,
    botId: string,
  ): Promise<{ providerId: string; modelId: string } | undefined>;
  visionModelSelection?(
    audienceId: string,
    botId: string,
  ): Promise<{ providerId: string; modelId: string } | undefined>;
  updateBotAccess(input: {
    audienceId: string;
    botId: string;
    expectedRevision: string;
    access: BotAccessUpdate;
  }): Promise<BotAccessView>;
  withBotMutation?<Result>(
    botId: string,
    action: () => Promise<Result>,
  ): Promise<Result>;
};

export interface AidenRemoteBotServiceOptions {
  application: BotApplicationPort;
  chatStore: { get(chatId: string): Promise<Chat | null> };
  /** Permanently erases a Bot (the durable session's `deleteBot`). */
  deleteBot?(botId: string): Promise<void>;
  /** Durable session state per Bot, for `sessionState` on summaries. */
  sessionStates?(botIds: readonly string[]): Promise<ReadonlyMap<string, AidenRemoteBotSessionStateKind>>;
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
  health?: (botId: string) => Promise<AidenRemoteBotHealth>;
  healthBatch?: (
    botIds: readonly string[],
  ) => Promise<ReadonlyMap<string, AidenRemoteBotHealth>>;
  idempotency?: AidenIdempotencyLedger;
  persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
  notifyBotsChanged?: (botId?: string) => void;
  notifyChatsChanged?: (chatId?: string) => void;
}

export class AidenRemoteBotService {
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(private readonly options: AidenRemoteBotServiceOptions) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  /** Shared with the durable-session routes so every Bot POST uses one ledger. */
  executeIdempotent<Result>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<Result>,
  ): Promise<Result> {
    return this.executeIdempotentInternal(scope, input, action);
  }

  private async executeIdempotentInternal<Result>(
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

  /** A live Bot. A deleted Bot (a retired record) reads as missing. */
  async bot(botId: string): Promise<BotDefinition> {
    const bot = await this.options.application.get(safeBotId(botId));
    if (!bot || bot.archivedAt !== undefined) {
      throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
    }
    return bot;
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
      const view = await this.options.avatar.view(bot.id, bot.avatar);
      return {
        semantic: recipe(view.semantic as BotDefinition["avatar"]),
        ...(view.asset ? { asset: structuredClone(view.asset) } : {}),
      };
    } catch {
      // Asset corruption or a rollback companion failure must not make the Bot
      // identity unreadable. The semantic avatar is the canonical safe fallback.
      return defaultAvatar(bot);
    }
  }

  private async summary(
    bot: BotDefinition,
    projectedHealth?: AidenRemoteBotHealth,
    projectedSession?: AidenRemoteBotSessionStateKind,
  ): Promise<AidenRemoteBotSummary> {
    const health = projectedHealth ?? await this.options.health?.(bot.id) ?? "ready";
    const sessionState = projectedSession ??
      (await this.options.sessionStates?.([bot.id]))?.get(bot.id);
    return projectAidenRemoteBotSummary(bot, await this.avatar(bot), health, sessionState);
  }

  /** The public summary of one live Bot (presets, list rows). */
  async summaryOf(botId: string): Promise<AidenRemoteBotSummary> {
    return this.summary(await this.bot(botId));
  }

  private async detail(
    bot: BotDefinition,
    audienceId?: string,
  ): Promise<AidenRemoteBotDetail> {
    const [summary, access, modelSelection, visionModelSelection] = await Promise.all([
      this.summary(bot),
      this.options.application.getBotAccess(bot.id),
      audienceId === undefined || !this.options.application.modelSelection
        ? Promise.resolve(undefined)
        : this.options.application.modelSelection(audienceId, bot.id),
      audienceId === undefined || !this.options.application.visionModelSelection
        ? Promise.resolve(undefined)
        : this.options.application.visionModelSelection(audienceId, bot.id),
    ]);
    return parseAidenRemoteBotDetail({
      ...summary,
      instructions: bot.instructions,
      ...(bot.openingGreeting === undefined ? {} : { openingGreeting: bot.openingGreeting }),
      access: parseAidenRemoteBotAccessView(access),
      ...(modelSelection ? { modelSelection } : {}),
      ...(visionModelSelection ? { visionModelSelection } : {}),
    });
  }

  async list(): Promise<AidenRemoteBotList> {
    // Deleted Bots are retired records and never leave the host.
    const bots = (await this.options.application.list(false))
      .filter(({ archivedAt }) => archivedAt === undefined);
    if (bots.length > MAX_BOTS) {
      throw new AidenRemoteServiceError("internal_error", "Aiden has too many Bots to project safely.", 500);
    }
    const ids = bots.map(({ id }) => id);
    const [health, sessions] = await Promise.all([
      this.options.healthBatch?.(ids),
      this.options.sessionStates?.(ids),
    ]);
    const summaries = await mapBounded(bots, 8, (bot) =>
      this.summary(bot, health?.get(bot.id) ?? "ready", sessions?.get(bot.id)));
    return parseAidenRemoteBotList({ bots: summaries, maxBots: MAX_BOTS });
  }

  async get(botId: string, audienceId?: string): Promise<AidenRemoteBotDetail> {
    return this.detail(await this.bot(botId), audienceId);
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
          const current = await this.bot(botId);
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
        const current = await this.bot(botId);
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
    await this.bot(botId);
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
              avatar: recipe(parsed.avatar),
            },
            // Omitted access is Full; a missing AI model leaves the Bot in `needs_model`.
            ...(parsed.access ? { access: parsed.access as BotAccessUpdate } : {}),
          });
          this.options.notifyBotsChanged?.(created.id);
          return this.detail(created, deviceId);
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
    audienceId?: string,
  ): Promise<AidenRemoteBotDetail> {
    const parsed = parseRequest(
      parseAidenRemoteBotIdentityPatchRequest,
      input,
      "The Bot identity update is invalid.",
    );
    const existing = await this.bot(botId);
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
        avatar: recipe(parsed.avatar ?? existing.avatar),
      });
      this.options.notifyBotsChanged?.(updated.id);
      return this.detail(updated, audienceId);
    } catch (error) {
      return mapBotMutationError(error);
    }
  }

  /**
   * Archive and restore were removed: Bots are deleted, never archived. The
   * routes stay until the Remote contract revision replaces them with
   * `DELETE /bots/{id}`; until then they refuse without changing anything.
   */
  async archive(botId: string, expectedRevision: string): Promise<AidenRemoteBotDetail> {
    await this.bot(botId);
    void expectedRevision;
    throw archiveRetiredError();
  }

  async restore(
    deviceId: string,
    botId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): Promise<AidenRemoteBotDetail> {
    await this.bot(botId);
    void deviceId;
    void expectedRevision;
    void idempotencyKey;
    throw archiveRetiredError();
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
    try {
      const access = await this.options.application.updateBotAccess({
        audienceId: deviceId,
        botId: existing.id,
        expectedRevision,
        access: parsed as BotAccessUpdate,
      });
      this.options.notifyBotsChanged?.(existing.id);
      const canonical = await this.options.application.getCanonicalChat(existing.id);
      if (canonical) this.options.notifyChatsChanged?.(canonical.id);
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
    try {
      const replayedOrCreated = await this.executeIdempotent(
        {
          deviceId,
          route: "POST /bots/{id}/chats",
          resourceId: existing.id,
          key: idempotencyKey,
        },
        parsed,
        async () => {
          const canonical = await this.options.application.getCanonicalChat(existing.id);
          if (canonical) {
            if (canonical.botId !== existing.id) {
              throw new AidenRemoteServiceError(
                "internal_error",
                "Aiden could not verify the canonical Bot chat.",
                500,
              );
            }
            return projectAidenRemoteChat(canonical);
          }
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
          let chat: Chat;
          if (parsed.providerId === undefined && parsed.modelId === undefined) {
            chat = await this.options.application.createChat({
              audienceId: deviceId,
              botId: existing.id,
            });
          } else {
            const provider = await this.resolveProviderModel(deviceId, existing.id, {
              providerId: parsed.providerId!,
              modelId: parsed.modelId!,
            });
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
      if (replayedOrCreated.botId !== existing.id) {
        throw new AidenRemoteServiceError(
          "internal_error",
          "Aiden could not verify the Bot chat result.",
          500,
        );
      }
      // A durable idempotency entry written before the one-chat invariant can
      // contain a now-historical duplicate. Keep the key replayable, but make
      // every public replay converge on the Bot's persistent canonical chat.
      const canonical = await this.options.application.getCanonicalChat(existing.id);
      if (!canonical || canonical.botId !== existing.id) {
        throw new AidenRemoteServiceError(
          "internal_error",
          "Aiden could not verify the canonical Bot chat.",
          500,
        );
      }
      return projectAidenRemoteChat(canonical);
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
}
