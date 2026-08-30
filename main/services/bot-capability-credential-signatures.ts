import {
  botCredentialSignature,
  createBotProviderCredentialSignatureCore,
  type BotProviderCredentialSignatureDependencies,
} from "./bot-capability-credential-signatures-core.js";
import { mcpCredentialConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
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

/** Covers stdio env/config, configured headers, preset API keys, and durable OAuth sessions. */
export async function botMcpCredentialSignature(
  server: McpServer,
  key: Uint8Array,
): Promise<string> {
  const preset = assertMcpPresetServer(server);
  const presetKey = preset?.auth.kind === "apiKey"
    ? await secrets.getOrBindLegacyProviderKey(
        presetSecretId(server.id),
        JSON.stringify(mcpCredentialConnectionSnapshot(server)),
      )
    : null;
  const oauthSession = server.oauth ? await mcpOAuthStore.get(server.id) : null;
  return botCredentialSignature(key, "mcp", {
    server,
    presetKey,
    oauthSession,
  });
}
