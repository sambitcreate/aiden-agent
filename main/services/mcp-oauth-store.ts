// Encrypted persistence for MCP OAuth sessions (dynamic client registration +
// tokens + PKCE verifier), keyed by MCP server id. Stored as base64 ciphertext
// via safeStorage, exactly like provider API keys — nothing plaintext, nothing
// returned to the renderer.

import * as fs from "fs/promises";
import * as path from "path";
import { app, safeStorage, logger } from "../platform.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";

const FILE = "mcp-oauth.json";

type SessionMap = Record<string, string>; // serverId -> base64 ciphertext of McpOAuthSession JSON
let mutationQueue: Promise<void> = Promise.resolve();

async function filePath(): Promise<string> {
  const userDataPath = app.getPath("userData");
  await fs.mkdir(userDataPath, { recursive: true });
  return path.join(userDataPath, FILE);
}

async function readMap(): Promise<SessionMap> {
  try {
    return JSON.parse(await fs.readFile(await filePath(), "utf-8")) as SessionMap;
  } catch {
    return {};
  }
}

async function writeMap(map: SessionMap): Promise<void> {
  const target = await filePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(map, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

function mutate(operation: () => Promise<void>): Promise<void> {
  const pending = mutationQueue.then(operation, operation);
  mutationQueue = pending.catch(() => {});
  return pending;
}

export const mcpOAuthStore = {
  async get(serverId: string): Promise<McpOAuthSession> {
    const map = await readMap();
    const b64 = map[serverId];
    if (!b64) return {};
    try {
      const json = await safeStorage.decryptString(Buffer.from(b64, "base64"));
      return JSON.parse(json) as McpOAuthSession;
    } catch (error) {
      logger.error("mcp-oauth", `Failed to decrypt OAuth session for ${serverId}`, error);
      return {};
    }
  },

  async set(serverId: string, session: McpOAuthSession): Promise<void> {
    if (!(await safeStorage.isEncryptionAvailable())) {
      throw new Error("Secure storage is unavailable on this system; cannot save the sign-in.");
    }
    const encrypted = await safeStorage.encryptString(JSON.stringify(session));
    await mutate(async () => {
      const map = await readMap();
      map[serverId] = Buffer.from(encrypted).toString("base64");
      await writeMap(map);
    });
  },

  async has(serverId: string): Promise<boolean> {
    const session = await this.get(serverId);
    return Boolean(session.tokens);
  },

  async clear(serverId: string): Promise<void> {
    await mutate(async () => {
      const map = await readMap();
      if (map[serverId]) {
        delete map[serverId];
        await writeMap(map);
      }
    });
  },
};
