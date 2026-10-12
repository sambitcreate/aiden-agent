import { createHmac } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import { mcpOAuthGrantIdentity, type McpOAuthSession } from "./mcp-oauth-session.js";
import { piCredentialGrantIdentity } from "./pi-credential-store-core.js";
import type { McpServer, Provider } from "./types.js";

export interface BotProviderCredentialSignatureDependencies {
  readBuiltinCredential(providerId: string): Promise<Credential | undefined>;
  readCustomCredential(provider: Provider): Promise<unknown>;
}

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

export function botCredentialSignature(key: Uint8Array, domain: string, value: unknown): string {
  if (key.byteLength !== 32) throw new Error("Bot credential signature key is invalid.");
  return createHmac("sha256", key)
    .update(`aiden-bot-${domain}-credential-v1\0`, "utf8")
    .update(canonical(value), "utf8")
    .digest("hex");
}

/** Main-only keyed signature; raw provider authority never leaves this call. */
export function createBotProviderCredentialSignatureCore(
  dependencies: BotProviderCredentialSignatureDependencies,
) {
  return async (
    provider: Provider,
    key: Uint8Array,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (signal.aborted) throw signal.reason;
    let credential: unknown;
    if (provider.isBuiltin) {
      if (provider.needsKey === true) {
        const stored = await dependencies.readBuiltinCredential(provider.id);
        if (
          !stored ||
          (stored.type === "api_key" && !stored.key?.trim())
        ) return undefined;
        // OAuth subscription logins refresh their access token in place; sign
        // the grant, not the token, so a refresh is not a credential change.
        credential = { source: "stored", value: piCredentialGrantIdentity(stored) };
      } else {
        credential = { source: "keyless", value: null };
      }
    } else {
      credential = await dependencies.readCustomCredential(provider);
    }
    if (signal.aborted) throw signal.reason;
    return botCredentialSignature(key, "provider", {
      providerId: provider.id,
      connection: providerConnectionSnapshot(provider),
      credential: credential ?? null,
    });
  };
}

/**
 * MCP connection authority: server config (stdio env, headers), a preset API
 * key, and the OAuth grant identity. OAuth access tokens and expiry are left
 * out so a routine refresh keeps the same credential incarnation; see
 * `mcpOAuthGrantIdentity` for what does change it.
 */
export function botMcpCredentialSignatureCore(
  key: Uint8Array,
  input: {
    server: McpServer;
    presetKey: unknown;
    oauthSession: McpOAuthSession | null;
  },
): string {
  return botCredentialSignature(key, "mcp", {
    server: input.server,
    presetKey: input.presetKey,
    oauthSession: input.oauthSession ? mcpOAuthGrantIdentity(input.oauthSession) : null,
  });
}
