// In-memory read cache for the encrypted MCP OAuth session store. Kept free of
// Electron imports: the store supplies how to read the file and decrypt an
// entry. The SDK asks for tokens on every request, so without this cache each
// request re-read and re-decrypted mcp-oauth.json.

import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { secretKeyEntry, type SecretKeyMap } from "./secret-map-core.js";

/**
 * The saved sign-in exists but cannot be read (the store file is unreadable,
 * or the OS credential storage cannot decrypt it). Distinct from "never
 * authorized", which is an empty session.
 */
export class McpOAuthCredentialStorageError extends Error {
  override readonly name = "McpOAuthCredentialStorageError";
  constructor(options?: { cause?: unknown }) {
    super(
      "Aiden could not read the saved sign-in for this MCP server because secure credential storage is unavailable. Unlock the keychain or sign in again in Settings → Plugins.",
    );
    if (options) Object.defineProperty(this, "cause", { value: options.cause, configurable: true, writable: true });
  }
}

export interface McpOAuthSessionSource {
  /** The serverId → ciphertext map; `{}` when no file exists. */
  readMap(): Promise<Readonly<SecretKeyMap>>;
  /** Decrypt and parse one entry. */
  decrypt(ciphertext: string): McpOAuthSession;
}

/**
 * Sessions are cached per server after their first successful read. Every
 * write, clear and rollback calls `invalidate`, which also discards reads that
 * were in flight when it happened, so a stale read can never repopulate the
 * cache. Failures are never cached. Callers get their own copy.
 */
export function createMcpOAuthSessionCache(source: McpOAuthSessionSource) {
  let generation = 0;
  let map: { generation: number; value: Promise<Readonly<SecretKeyMap>> } | undefined;
  const sessions = new Map<string, McpOAuthSession>();

  async function readMap(): Promise<Readonly<SecretKeyMap>> {
    if (map?.generation !== generation) {
      const loading = source.readMap();
      const entry = { generation, value: loading };
      map = entry;
      loading.catch(() => { if (map === entry) map = undefined; });
    }
    return map.value;
  }

  return {
    async get(serverId: string): Promise<McpOAuthSession> {
      const cached = sessions.get(serverId);
      if (cached) return structuredClone(cached);
      const started = generation;
      let entries: Readonly<SecretKeyMap>;
      try {
        entries = await readMap();
      } catch (error) {
        throw new McpOAuthCredentialStorageError({ cause: error });
      }
      const ciphertext = secretKeyEntry(entries, serverId);
      if (!ciphertext) return {};
      let session: McpOAuthSession;
      try {
        session = source.decrypt(ciphertext);
      } catch (error) {
        throw new McpOAuthCredentialStorageError({ cause: error });
      }
      if (started === generation) sessions.set(serverId, structuredClone(session));
      return session;
    },
    invalidate(): void {
      generation += 1;
      map = undefined;
      sessions.clear();
    },
  };
}
