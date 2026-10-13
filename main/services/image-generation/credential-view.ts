import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import {
  IMAGE_GENERATION_PROVIDER_IDS,
  isImageGenerationProviderId,
} from "../../../renderer/shared/image-generation/types.js";

/**
 * Stored-id prefix for image-generation keys. It deliberately never equals an
 * inference provider id, so an image key can never authorize chat, and the
 * view below can never read a chat key such as `openrouter`.
 */
export const IMAGE_CREDENTIAL_PREFIX = "aiden-internal:image-gen:";

export function imageCredentialStoredId(providerId: string): string {
  return `${IMAGE_CREDENTIAL_PREFIX}${providerId}`;
}

function outside(providerId: string): Error {
  return new Error(`Image generation has no credential slot for "${providerId.slice(0, 64)}".`);
}

/**
 * A namespaced view over the shared encrypted credential store. Provider id
 * `p` maps to the stored id `aiden-internal:image-gen:<p>`, only the three
 * image providers have a slot, and every other stored credential is invisible.
 */
export function createImageCredentialView(base: CredentialStore): CredentialStore {
  return {
    async read(providerId, options) {
      if (!isImageGenerationProviderId(providerId)) return undefined;
      return base.read(imageCredentialStoredId(providerId), options);
    },
    async list(options) {
      const stored = await base.list(options);
      const visible: CredentialInfo[] = [];
      for (const info of stored) {
        if (!info.providerId.startsWith(IMAGE_CREDENTIAL_PREFIX)) continue;
        const providerId = info.providerId.slice(IMAGE_CREDENTIAL_PREFIX.length);
        if (isImageGenerationProviderId(providerId)) visible.push({ providerId, type: info.type });
      }
      return visible;
    },
    async modify(providerId, fn, options) {
      if (!isImageGenerationProviderId(providerId)) throw outside(providerId);
      return base.modify(
        imageCredentialStoredId(providerId),
        async (current: Credential | undefined) => fn(current),
        options,
      );
    },
    async delete(providerId, options) {
      if (!isImageGenerationProviderId(providerId)) throw outside(providerId);
      await base.delete(imageCredentialStoredId(providerId), options);
    },
  };
}

/** Every stored id the view can own, for resets. */
export const IMAGE_CREDENTIAL_STORED_IDS: readonly string[] = IMAGE_GENERATION_PROVIDER_IDS.map(
  imageCredentialStoredId,
);
