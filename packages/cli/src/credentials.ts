import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EncryptedPiCredentialStore } from "../../../main/services/pi-credential-store-core.js";
import { acquireLease } from "./state.ts";

/** Portable file cipher; the wrapping key is protected by owner-only filesystem access. */
export function fileCredentialCipher(agentDir: string) {
  const directory = join(agentDir, "credentials");
  const keyFile = join(directory, "wrapping-key");
  function key() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { return readFileSync(keyFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const value = randomBytes(32);
      try { writeFileSync(keyFile, value, { flag: "wx", mode: 0o600 }); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
      return readFileSync(keyFile);
    }
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptString(value: Buffer) { const decipher = createDecipheriv("aes-256-gcm", key(), value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"); },
  };
}

export function insightCredentials(agentDir: string) {
  const directory = join(agentDir, "credentials");
  const store = new EncryptedPiCredentialStore({ filePath: () => join(directory, "insights.json"), cipher: fileCredentialCipher(agentDir) });
  return {
    async read(source: string) { const value = await store.read(source); return value?.type === "api_key" ? value.key : undefined; },
    async write(source: string, value: string) { const release = acquireLease(join(directory, "insights-writer")); try { await store.modify(source, async () => ({ type: "api_key", key: value })); } finally { release(); } },
    async delete(source: string) { const release = acquireLease(join(directory, "insights-writer")); try { await store.delete(source); } finally { release(); } },
  };
}
