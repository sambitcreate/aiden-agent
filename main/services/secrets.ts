// Encrypted per-provider API key storage using the OS keychain via safeStorage.
// Keys are stored as base64-encoded ciphertext and are NEVER returned to the renderer.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { app, safeStorage, logger } from "../platform.js";

const FILE = "provider-keys.json";

type KeyMap = Record<string, string>; // providerId -> base64 ciphertext
let mutationTail: Promise<void> = Promise.resolve();

async function filePath(): Promise<string> {
  const userDataPath = app.getPath("userData");
  await fs.mkdir(userDataPath, { recursive: true });
  return path.join(userDataPath, FILE);
}

async function readMap(): Promise<KeyMap> {
  try {
    const data = await fs.readFile(await filePath(), "utf-8");
    return JSON.parse(data) as KeyMap;
  } catch {
    return {};
  }
}

async function writeMap(map: KeyMap): Promise<void> {
  const destination = await filePath();
  const staged = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(staged, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(staged, destination);
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

function serialized<R>(operation: () => Promise<R>): Promise<R> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const secrets = {
  async setKey(providerId: string, key: string): Promise<void> {
    return serialized(async () => {
      if (!(await safeStorage.isEncryptionAvailable())) {
        throw new Error("Secure storage is unavailable on this system; cannot save the API key.");
      }
      const map = await readMap();
      const encrypted = await safeStorage.encryptString(key);
      map[providerId] = Buffer.from(encrypted).toString("base64");
      await writeMap(map);
    });
  },

  async getKey(providerId: string): Promise<string | null> {
    await mutationTail;
    const map = await readMap();
    const b64 = map[providerId];
    if (!b64) return null;
    try {
      return await safeStorage.decryptString(Buffer.from(b64, "base64"));
    } catch (error) {
      logger.error("secrets", `Failed to decrypt key for provider ${providerId}`, error);
      return null;
    }
  },

  async hasKey(providerId: string): Promise<boolean> {
    await mutationTail;
    const map = await readMap();
    return Boolean(map[providerId]);
  },

  async deleteKey(providerId: string): Promise<void> {
    return serialized(async () => {
      const map = await readMap();
      if (map[providerId]) {
        delete map[providerId];
        await writeMap(map);
      }
    });
  },

  async migrateKeys(migrate: (map: KeyMap) => boolean): Promise<void> {
    return serialized(async () => {
      const map = await readMap();
      if (migrate(map)) await writeMap(map);
    });
  },
};
