// Encrypted persistence for MCP OAuth sessions (dynamic client registration +
// tokens + PKCE verifier), keyed by MCP server id. Stored as base64 ciphertext
// via safeStorage, exactly like provider API keys — nothing plaintext, nothing
// returned to the renderer.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { app, logger } from "../platform.js";
import { secureStorage } from "./secure-storage.js";
import {
  parseMcpOAuthSession,
  sameMcpOAuthGrant,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import {
  deleteSecretKeyEntry,
  parseSecretKeyMap,
  secretKeyEntry,
  setSecretKeyEntry,
  type SecretKeyMap,
} from "./secret-map-core.js";
import { readRegularUtf8File } from "./regular-file-read.js";
import { commitOwnedMutation } from "./mcp-oauth-store-core.js";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";
import { syncDirectory } from "./durable-fs.js";

const FILE = "mcp-oauth.json";

type SessionMap = SecretKeyMap; // serverId -> base64 ciphertext of McpOAuthSession JSON
type MutationGuard = () => boolean;
let mutationQueue: Promise<void> = Promise.resolve();

async function filePath(): Promise<string> {
  const userDataPath = app.getPath("userData");
  await fs.mkdir(userDataPath, { recursive: true });
  return path.join(userDataPath, FILE);
}

async function readMap(): Promise<SessionMap> {
  try {
    return parseSecretKeyMap(JSON.parse(await readRegularUtf8File(await filePath())));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Fence Bot runtime authority only for grant changes. A routine token refresh
 * rewrites this file (often in the middle of a Bot's own catalog snapshot,
 * which opens fresh MCP clients); invalidating then would abort the very Bot
 * create or turn admission that caused the refresh.
 */
function fenceBotAuthority(grantChanged: boolean): void {
  if (grantChanged) invalidateBotRuntimeInventoryAuthority("mcp_credential");
}

/** Decrypt a stored entry for grant comparison; unreadable means "changed". */
function storedSession(map: SessionMap, serverId: string): McpOAuthSession | undefined {
  const b64 = secretKeyEntry(map, serverId);
  if (!b64) return {};
  try {
    return parseMcpOAuthSession(
      JSON.parse(secureStorage.decryptString(Buffer.from(b64, "base64"))),
    );
  } catch {
    return undefined;
  }
}

async function writeMap(
  map: SessionMap,
  previousMap: SessionMap,
  isCurrent: MutationGuard = () => true,
  grantChanged = true,
): Promise<void> {
  const target = await filePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  const rollback = `${target}.${randomUUID()}.rollback.tmp`;
  try {
    for (const [staged, value] of [
      [temporary, map],
      [rollback, previousMap],
    ] as const) {
      await fs.writeFile(staged, JSON.stringify(value, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      const handle = await fs.open(staged, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await commitOwnedMutation({
      isCurrent,
      publish: async () => {
        fenceBotAuthority(grantChanged);
        await fs.rename(temporary, target);
        fenceBotAuthority(grantChanged);
        await fs.chmod(target, 0o600);
        await syncDirectory(path.dirname(target));
      },
      rollback: async () => {
        fenceBotAuthority(grantChanged);
        await fs.rename(rollback, target);
        fenceBotAuthority(grantChanged);
        await fs.chmod(target, 0o600);
        await syncDirectory(path.dirname(target));
      },
    });
  } finally {
    await Promise.all([
      fs.rm(temporary, { force: true }).catch(() => undefined),
      fs.rm(rollback, { force: true }).catch(() => undefined),
    ]);
  }
}

function mutate(operation: () => Promise<void>): Promise<void> {
  const pending = mutationQueue.then(operation, operation);
  mutationQueue = pending.catch(() => {});
  return pending;
}

function assertMutationCurrent(isCurrent: MutationGuard): void {
  if (!isCurrent()) {
    throw new Error("MCP OAuth credentials changed while this operation was in progress.");
  }
}

export const mcpOAuthStore = {
  async get(serverId: string, isCurrent: MutationGuard = () => true): Promise<McpOAuthSession> {
    // Credential-bearing reads must observe every mutation admitted before
    // them, then prove their generation is still current after I/O/decryption.
    await mutationQueue;
    assertMutationCurrent(isCurrent);
    let map: SessionMap;
    try {
      map = await readMap();
    } catch (error) {
      logger.error("mcp-oauth", "Could not read the encrypted OAuth session store.", error);
      assertMutationCurrent(isCurrent);
      return {};
    }
    assertMutationCurrent(isCurrent);
    const b64 = secretKeyEntry(map, serverId);
    if (!b64) return {};
    let session: McpOAuthSession;
    try {
      const json = secureStorage.decryptString(Buffer.from(b64, "base64"));
      session = parseMcpOAuthSession(JSON.parse(json));
    } catch (error) {
      logger.error("mcp-oauth", `Failed to decrypt OAuth session for ${serverId}`, error);
      assertMutationCurrent(isCurrent);
      return {};
    }
    assertMutationCurrent(isCurrent);
    return session;
  },

  async set(
    serverId: string,
    session: McpOAuthSession,
    isCurrent: MutationGuard = () => true,
  ): Promise<void> {
    if (!secureStorage.isEncryptionAvailable()) {
      throw new Error(`${secureStorage.unavailableMessage()} Cannot save the sign-in.`);
    }
    const encrypted = secureStorage.encryptString(JSON.stringify(session));
    await mutate(async () => {
      assertMutationCurrent(isCurrent);
      const map = await readMap();
      const previousMap = { ...map };
      assertMutationCurrent(isCurrent);
      const previous = storedSession(map, serverId);
      const grantChanged = previous === undefined || !sameMcpOAuthGrant(previous, session);
      setSecretKeyEntry(map, serverId, Buffer.from(encrypted).toString("base64"));
      await writeMap(map, previousMap, isCurrent, grantChanged);
    });
  },

  async has(serverId: string): Promise<boolean> {
    const session = await this.get(serverId);
    return Boolean(session.tokens);
  },

  async clear(serverId: string, isCurrent: MutationGuard = () => true): Promise<void> {
    await mutate(async () => {
      assertMutationCurrent(isCurrent);
      const map = await readMap();
      const previousMap = { ...map };
      assertMutationCurrent(isCurrent);
      if (deleteSecretKeyEntry(map, serverId)) {
        await writeMap(map, previousMap, isCurrent);
      }
    });
  },

  async clearAll(isCurrent: MutationGuard = () => true): Promise<void> {
    await mutate(async () => {
      assertMutationCurrent(isCurrent);
      const previousMap = await readMap();
      assertMutationCurrent(isCurrent);
      if (Object.keys(previousMap).length > 0) {
        await writeMap({}, previousMap, isCurrent);
      }
    });
  },
};
