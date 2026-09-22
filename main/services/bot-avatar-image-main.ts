import { nativeImage } from "../platform.js";
import {
  BOT_AVATAR_CANONICAL_EDGE,
  type BotAvatarDimensions,
  BotAvatarInputError,
  type BotAvatarNormalizer,
  type BotAvatarSource,
  inspectCanonicalBotAvatarPng,
} from "./bot-avatar-store-core.js";

function normalizedSize(dimensions: BotAvatarDimensions): BotAvatarDimensions {
  const scale = BOT_AVATAR_CANONICAL_EDGE / Math.min(dimensions.width, dimensions.height);
  return {
    width: Math.max(BOT_AVATAR_CANONICAL_EDGE, Math.round(dimensions.width * scale)),
    height: Math.max(BOT_AVATAR_CANONICAL_EDGE, Math.round(dimensions.height * scale)),
  };
}

/**
 * Production decoder boundary. Electron/Chromium performs a real decode, then
 * Aiden center-crops, resamples, and re-encodes; source containers and metadata
 * are never persisted. Any unavailable/empty native decoder fails closed.
 */
export function createNativeBotAvatarNormalizer(): BotAvatarNormalizer {
  return {
    async normalize(source: BotAvatarSource, dimensions: BotAvatarDimensions): Promise<Buffer> {
      if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
        throw new BotAvatarInputError("Bot photo normalization is unavailable.");
      }
      const decoded = nativeImage.createFromBuffer(source.bytes, { scaleFactor: 1 });
      if (decoded.isEmpty()) throw new BotAvatarInputError("Aiden could not decode that Bot photo.");
      const decodedSize = decoded.getSize(1);
      if (decodedSize.width !== dimensions.width || decodedSize.height !== dimensions.height) {
        throw new BotAvatarInputError("The Bot photo container has inconsistent dimensions.");
      }
      const target = normalizedSize(dimensions);
      const resized = decoded.resize({ ...target, quality: "best" });
      const resizedSize = resized.getSize(1);
      if (resized.isEmpty() || resizedSize.width < BOT_AVATAR_CANONICAL_EDGE ||
          resizedSize.height < BOT_AVATAR_CANONICAL_EDGE) {
        throw new BotAvatarInputError("Aiden could not normalize that Bot photo.");
      }
      const cropped = resized.crop({
        x: Math.floor((resizedSize.width - BOT_AVATAR_CANONICAL_EDGE) / 2),
        y: Math.floor((resizedSize.height - BOT_AVATAR_CANONICAL_EDGE) / 2),
        width: BOT_AVATAR_CANONICAL_EDGE,
        height: BOT_AVATAR_CANONICAL_EDGE,
      });
      const canonical = cropped.toPNG({ scaleFactor: 1 });
      inspectCanonicalBotAvatarPng(canonical);
      return canonical;
    },
  };
}
