import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EncryptedPiCredentialStore } from "../../../main/services/pi-credential-store-core.js";
import { fileCredentialCipher } from "./credentials.ts";
import { acquireLease, atomicJson, readJson } from "./state.ts";

const writers = new Map<string, Promise<unknown>>();

/** Compatible Pi credentials with atomic, owner-private migration of legacy auth.json. */
export function createCliProviderCredentials(file: string): CredentialStore {
  const cipher = fileCredentialCipher(dirname(file));
  const store = new EncryptedPiCredentialStore({ filePath: () => file, cipher });
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writers.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const release = acquireLease(`${file}.writer`);
      try {
        const current = readJson<Record<string, unknown> | null>(file, null);
        if (current === null) atomicJson(file, { version: 1, entries: {} });
        else if (current.version !== 1 || !current.entries) {
          const staged = join(dirname(file), `.auth-migration-${randomUUID()}.json`);
          const migration = new EncryptedPiCredentialStore({ filePath: () => staged, cipher });
          try {
            // Validate every legacy entry before replacing the original file.
            atomicJson(staged, { version: 1, entries: {} });
            for (const [provider, value] of Object.entries(current)) {
              if (!value || typeof value !== "object" || !["api_key", "oauth"].includes(String((value as Credential).type))) throw new Error("Invalid legacy provider credential.");
              await migration.modify(provider, async () => value as Credential);
            }
            await rename(staged, file);
          } finally { await rm(staged, { force: true }); }
        }
        return await operation();
      } finally { release(); }
    });
    writers.set(file, next);
    try { return await next; }
    finally { if (writers.get(file) === next) writers.delete(file); }
  }
  async function ready() {
    const current = readJson<Record<string, unknown> | null>(file, null);
    if (!current || current.version !== 1 || !current.entries) await locked(async () => {});
  }
  return {
    read: async (id) => { await ready(); return store.read(id); },
    list: async () => { await ready(); return store.list(); },
    modify: (id, update) => locked(() => store.modify(id, update)),
    delete: (id) => locked(() => store.delete(id)),
  };
}
