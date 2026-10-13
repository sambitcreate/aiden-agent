import {
  botMcpCredentialSignatureCore,
  createBotProviderCredentialSignatureCore,
  type BotProviderCredentialSignatureDependencies,
} from "./bot-capability-credential-signatures-core.js";
import { mcpPresetKeyBinding } from "./mcp-credential-cleanup-core.js";
import { McpOAuthCredentialStorageError } from "./mcp-oauth-session-cache.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { assertMcpPresetServer, presetSecretId } from "./mcp-presets.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import { secrets } from "./secrets.js";
import type { McpServer } from "./types.js";

const providerCredentialDependencies: BotProviderCredentialSignatureDependencies = {
  readBuiltinCredential: (providerId) => piCredentialStore.read(providerId),
  readCustomCredential: (provider) =>
    secrets.getProviderKey(
      provider.id,
      JSON.stringify(providerConnectionSnapshot(provider)),
    ),
};

/** Main-only keyed signature; neither credential bytes nor a reusable plain digest is persisted. */
export function createBotProviderCredentialSignature(
  overrides: Partial<BotProviderCredentialSignatureDependencies> = {},
) {
  return createBotProviderCredentialSignatureCore({
    ...providerCredentialDependencies,
    ...overrides,
  });
}

export const botProviderCredentialSignature = createBotProviderCredentialSignature();

/** Covers stdio env/config, configured headers, preset API keys, and the durable OAuth grant. */
export async function botMcpCredentialSignature(
  server: McpServer,
  key: Uint8Array,
): Promise<string> {
  const preset = assertMcpPresetServer(server);
  const presetKey = preset?.auth.kind === "apiKey"
    ? await secrets.getOrBindLegacyProviderKey(
        presetSecretId(server.id),
        mcpPresetKeyBinding(server),
      )
    : null;
  // Unreadable credential storage reads as "no grant" for this one server, so
  // it cannot take every other server out of the Bot catalog with it.
  const oauthSession = server.oauth
    ? await mcpOAuthStore.get(server.id).catch((error: unknown) => {
        if (error instanceof McpOAuthCredentialStorageError) return {};
        throw error;
      })
    : null;
  return botMcpCredentialSignatureCore(key, { server, presetKey, oauthSession });
}
