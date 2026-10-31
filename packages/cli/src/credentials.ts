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

function assertCurrent(isCurrent: (() => boolean) | undefined): void {
  if (isCurrent && !isCurrent()) throw new Error("This credential changed while the operation was in progress.");
}

/** Writes to one credential file run one at a time in this process. */
const writerQueues = new Map<string, Promise<unknown>>();
const LEASE_WAIT_MS = 10_000;

/**
 * Run `operation` holding the cross-process writer lease. Writers in this
 * process queue; a lease held by another process (an `aiden` command
 * next to `aiden serve`) is retried with bounded backoff before failing.
 */
export function withCredentialWriterLease<T>(lease: string, operation: () => Promise<T>, waitMs = LEASE_WAIT_MS): Promise<T> {
  const run = async () => {
    const deadline = Date.now() + waitMs;
    let delay = 10;
    let release: () => void;
    for (;;) {
      try { release = acquireLease(lease); break; }
      catch (error) {
        if (!(error instanceof Error && error.message.startsWith("Another Aiden process owns")) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - Date.now()))));
        delay = Math.min(delay * 2, 250);
      }
    }
    try { return await operation(); } finally { release(); }
  };
  const previous = writerQueues.get(lease) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  writerQueues.set(lease, settled);
  void settled.then(() => { if (writerQueues.get(lease) === settled) writerQueues.delete(lease); });
  return next;
}

export function insightCredentials(agentDir: string) {
  const directory = join(agentDir, "credentials"), lease = join(directory, "insights-writer");
  const store = new EncryptedPiCredentialStore({ filePath: () => join(directory, "insights.json"), cipher: fileCredentialCipher(agentDir) });
  const valueOf = (credential: Awaited<ReturnType<typeof store.read>>) => credential?.type === "api_key" ? credential.key : undefined;
  return {
    async read(source: string) { return valueOf(await store.read(source)); },
    /** `isCurrent` is checked under the writer lease; a superseded writer changes nothing. */
    write(source: string, value: string, isCurrent?: () => boolean) { return withCredentialWriterLease(lease, async () => { assertCurrent(isCurrent); await store.modify(source, async () => ({ type: "api_key", key: value })); }); },
    /**
     * Read-modify-write under the lease: `mutate` sees the stored value and
     * returns the next one, or undefined to leave it unchanged.
     */
    update(source: string, mutate: (current: string | undefined) => string | undefined, isCurrent?: () => boolean) {
      return withCredentialWriterLease(lease, async () => {
        assertCurrent(isCurrent);
        await store.modify(source, async (current) => { const next = mutate(valueOf(current)); return next === undefined ? undefined : { type: "api_key", key: next }; });
      });
    },
    delete(source: string, isCurrent?: () => boolean) { return withCredentialWriterLease(lease, async () => { assertCurrent(isCurrent); await store.delete(source); }); },
  };
}
