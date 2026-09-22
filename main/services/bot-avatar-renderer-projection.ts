import type { BotDefinition, BotRendererCanonicalPhoto } from "../../renderer/shared/bots.js";
import type { BotAvatarApplicationAdapter } from "./bot-avatar-application-adapter.js";

export interface BotAvatarRendererProjectionOptions {
  bots: { get(botId: string): Promise<BotDefinition | null> };
  avatar: Pick<BotAvatarApplicationAdapter, "view" | "content">;
}

/**
 * Renderer-safe canonical Bot photo projection.
 *
 * The private store path and manifest never cross IPC. A missing, corrupt, or
 * concurrently replaced asset is intentionally indistinguishable from no
 * raster asset so every desktop surface can retain the semantic identity.
 */
export async function projectBotAvatarForRenderer(
  botId: string,
  options: BotAvatarRendererProjectionOptions,
): Promise<BotRendererCanonicalPhoto | null> {
  try {
    const bot = await options.bots.get(botId);
    if (!bot) return null;
    // A replacement removes the prior asset after publishing its new manifest.
    // Re-read once so a view/read race resolves to the new canonical photo.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await options.avatar.view(bot.id, bot.avatar);
      if (!view.asset) return null;
      try {
        const content = await options.avatar.content(bot.id, view.asset.assetRevision);
        if (
          content.metadata.assetRevision !== view.asset.assetRevision ||
          content.metadata.mimeType !== "image/png" ||
          content.metadata.width !== 512 ||
          content.metadata.height !== 512 ||
          content.metadata.byteSize !== content.bytes.length ||
          content.metadata.byteSize !== view.asset.byteSize
        ) {
          continue;
        }
        return {
          assetRevision: content.metadata.assetRevision,
          dataUrl: `data:image/png;base64,${content.bytes.toString("base64")}`,
        };
      } catch {
        // Retry only the current main-owned view/read pair; never a mutation.
      }
    }
    return null;
  } catch {
    return null;
  }
}
