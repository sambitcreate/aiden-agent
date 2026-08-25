import type { BotDefinition } from "../../renderer/shared/bots.js";
import type {
  AidenRemoteBotAvatarAsset,
  AidenRemoteBotAvatarUploadRequest,
  AidenRemoteBotAvatarView,
} from "./aiden-remote-protocol.js";
import type {
  BotAvatarContent,
  BotAvatarStore,
} from "./bot-avatar-store-core.js";

export interface BotAvatarApplicationAdapterOptions {
  store: BotAvatarStore;
  /** Stable local Aiden instance/profile identity; never a paired-device id. */
  ownerId: string;
}

export interface BotAvatarApplicationMutation {
  botId: string;
  expectedAssetRevision: string | null;
  /** Safe main-minted operation identity after Remote's durable admission. */
  operationId: string;
}

/**
 * Narrow integration surface for BotApplicationService and the authenticated
 * Remote adapter. Bot existence/archive/If-Match/device-grant checks remain in
 * those application layers; this adapter owns canonical asset isolation only.
 */
export function createBotAvatarApplicationAdapter(
  options: BotAvatarApplicationAdapterOptions,
) {
  return {
    async view(
      botId: string,
      semantic: BotDefinition["avatar"],
    ): Promise<AidenRemoteBotAvatarView> {
      const asset = await options.store.metadata(options.ownerId, botId);
      return {
        semantic: structuredClone(semantic),
        ...(asset ? { asset } : {}),
      };
    },

    async put(
      mutation: BotAvatarApplicationMutation,
      upload: AidenRemoteBotAvatarUploadRequest,
    ): Promise<AidenRemoteBotAvatarAsset> {
      return options.store.put({
        ownerId: options.ownerId,
        ...mutation,
        source: {
          mimeType: upload.mimeType,
          bytes: Buffer.from(upload.data, "base64"),
        },
      });
    },

    delete(mutation: BotAvatarApplicationMutation): Promise<void> {
      return options.store.delete({ ownerId: options.ownerId, ...mutation });
    },

    content(botId: string, assetRevision: string): Promise<BotAvatarContent> {
      return options.store.read(options.ownerId, botId, assetRevision);
    },
  };
}

export type BotAvatarApplicationAdapter = ReturnType<typeof createBotAvatarApplicationAdapter>;
