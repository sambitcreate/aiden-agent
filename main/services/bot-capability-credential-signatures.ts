import {
  createBotMcpCredentialSignatureCore,
  createBotProviderCredentialSignatureCore,
  type BotProviderCredentialSignatureDependencies,
} from "./bot-capability-credential-signatures-core.js";
import { mcpCredentialConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { assertMcpPresetServer, presetSecretId } from "./mcp-presets.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import { secrets } from "./secrets.js";

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
export const botMcpCredentialSignature = createBotMcpCredentialSignatureCore({
  readPresetKey: async (server) => {
    const preset = assertMcpPresetServer(server);
    return preset?.auth.kind === "apiKey"
      ? secrets.getOrBindLegacyProviderKey(
          presetSecretId(server.id),
          JSON.stringify(mcpCredentialConnectionSnapshot(server)),
        )
      : null;
  },
  readOAuthSession: (serverId) => mcpOAuthStore.get(serverId),
});
