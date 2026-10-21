import { secrets } from "./secrets.js";
import { configStore } from "./config-store.js";
import type { McpServer } from "./types.js";
import { mcpRuntimeConnectionSnapshot, sameMcpRuntimeConnection } from "./mcp-credential-cleanup-core.js";
import {
  createMcpProviderAuthenticatedFetch,
  MCP_PROVIDER_KEY_SHARING_KEY,
  mcpProviderGrantBinding,
  mcpProviderGrantKey,
  parseMcpProviderKeySharing,
  resolveMcpProviderSharedKey,
  serializeMcpProviderKeySharing,
  type McpProviderCredentialSource,
  type McpProviderKeySharing,
} from "./mcp-provider-auth-core.js";

async function readKeySharing(): Promise<McpProviderKeySharing> {
  return parseMcpProviderKeySharing(await secrets.getKeyStrict(MCP_PROVIDER_KEY_SHARING_KEY));
}

async function providerCredentialSource(): Promise<McpProviderCredentialSource> {
  const { providerRegistry } = await import("./provider-registry.js");
  return {
    isBuiltin: (providerId) => providerRegistry.isBuiltinProvider(providerId),
    storedCredential: (providerId) => providerRegistry.storedCredential(providerId),
    sharedFingerprint: async (providerId) => (await readKeySharing()).get(providerId),
  };
}

/** Providers whose current saved API key is the one opted in for custom connectors. */
export async function mcpProviderKeySharingIds(): Promise<Set<string>> {
  const sharing = await readKeySharing();
  const source = await providerCredentialSource();
  const ids = new Set<string>();
  for (const providerId of sharing.keys()) {
    try {
      await resolveMcpProviderSharedKey(providerId, source);
      ids.add(providerId);
    } catch {
      // A replaced, signed-out or switched credential is no longer shared.
    }
  }
  return ids;
}

let sharingWrites: Promise<unknown> = Promise.resolve();

/**
 * Settings → Providers' "Let custom connectors use this key". Turning it on
 * records the fingerprint of the provider's current saved API key; only that
 * key is ever shared. Sign-in credentials are refused.
 */
export function setMcpProviderKeySharing(providerId: string, allowed: boolean, isCurrent: () => boolean): Promise<void> {
  const write = sharingWrites.then(async () => {
    const fingerprint = allowed
      ? (await resolveMcpProviderSharedKey(providerId, await providerCredentialSource(), { checkSharing: false })).fingerprint
      : undefined;
    const sharing = await readKeySharing();
    if (fingerprint) sharing.set(providerId, fingerprint);
    else if (!sharing.delete(providerId)) return;
    if (!isCurrent()) throw new Error("Provider changes must come from the active application document.");
    await secrets.setInternalKey(MCP_PROVIDER_KEY_SHARING_KEY, serializeMcpProviderKeySharing(sharing), 32_768, isCurrent);
  });
  sharingWrites = write.catch(() => undefined);
  return write;
}

export async function hasMcpProviderAuthGrant(server: McpServer): Promise<boolean> {
  if (!server.authProvider) return false;
  return await secrets.getKeyStrict(mcpProviderGrantKey(server.id)) === mcpProviderGrantBinding(server);
}

/** Called only by the explicit active-renderer consent action, inside the MCP publication lock. */
export async function setMcpProviderAuthGrant(server: McpServer, allowed: boolean, isCurrent: () => boolean): Promise<void> {
  const binding = mcpProviderGrantBinding(server);
  if (!allowed) { await secrets.deleteKey(mcpProviderGrantKey(server.id), isCurrent); return; }
  await resolveMcpProviderSharedKey(server.authProvider!, await providerCredentialSource());
  await secrets.setInternalKey(mcpProviderGrantKey(server.id), binding, 1024, isCurrent);
}

export function mcpProviderAuthenticatedFetch(server: McpServer, isCurrent: () => boolean): typeof fetch {
  const expected = mcpRuntimeConnectionSnapshot(server);
  return createMcpProviderAuthenticatedFetch({
    server,
    assertCurrent() { if (!isCurrent()) throw new Error("This MCP connection is no longer current."); },
    async readGrant() {
      const current = (await configStore.listMcpServers()).find((item) => item.id === server.id);
      if (!current?.enabled || !sameMcpRuntimeConnection(expected, mcpRuntimeConnectionSnapshot(current))) throw new Error("MCP provider authentication configuration changed.");
      return secrets.getKeyStrict(mcpProviderGrantKey(server.id));
    },
    async resolveToken(providerId) {
      // Checked on every request from one read of the stored credential: a
      // replaced key, a switch to a sign-in, a logout, or the opt-in turned
      // off stops the connector at once, and an OAuth token is never sent.
      return (await resolveMcpProviderSharedKey(providerId, await providerCredentialSource())).key;
    },
  });
}
