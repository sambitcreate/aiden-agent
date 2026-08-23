import { createHmac } from "node:crypto";
import { mcpCredentialConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { assertMcpPresetServer, presetSecretId } from "./mcp-presets.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import { secrets } from "./secrets.js";
import type { McpServer, Provider } from "./types.js";

function canonical(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Bot credential signature value is invalid.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function signature(key: Uint8Array, domain: string, value: unknown): string {
  if (key.byteLength !== 32) throw new Error("Bot credential signature key is invalid.");
  return createHmac("sha256", key)
    .update(`aiden-bot-${domain}-credential-v1\0`, "utf8")
    .update(canonical(value), "utf8")
    .digest("hex");
}

/** Main-only keyed signature; neither credential bytes nor a reusable plain digest is persisted. */
export async function botProviderCredentialSignature(
  provider: Provider,
  key: Uint8Array,
): Promise<string> {
  const credential = provider.isBuiltin
    ? await piCredentialStore.read(provider.id)
    : await secrets.getProviderKey(
        provider.id,
        JSON.stringify(providerConnectionSnapshot(provider)),
      );
  return signature(key, "provider", {
    providerId: provider.id,
    connection: providerConnectionSnapshot(provider),
    credential: credential ?? null,
  });
}

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
  return signature(key, "mcp", {
    server,
    presetKey,
    oauthSession,
  });
}
