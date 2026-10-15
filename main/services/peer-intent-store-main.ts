import { app } from "../platform.js";
import { DataStore } from "./data-store.js";
import { secureStorage } from "./secure-storage.js";
import { getPeerHostRegistry } from "./peer-host-service-main.js";
import { PeerIntentStore, type BoundIntent } from "./peer-intent-store.js";
let store: PeerIntentStore | undefined;
export function getPeerIntentStore(): PeerIntentStore {
  if (store) return store;
  const disk = new DataStore<{ ciphertext: string | null }>("peer-pending-requests.json", { ciphertext: null },
    () => app.getPath("userData"), { maxBytes: 8 * 1024 * 1024, fileMode: 0o600, rejectCorruptWrite: true, rejectUnsafeWrite: true });
  store = new PeerIntentStore({
    async load() {
      const value = await disk.load();
      if (await disk.loadedFromCorruptFile() || await disk.loadedFromUnsafeFile()) throw new Error("Saved requests need recovery.");
      if (value.ciphertext === null) return [];
      if (typeof value.ciphertext !== "string") throw new Error("Saved requests need recovery.");
      return JSON.parse(secureStorage.decryptString(Buffer.from(value.ciphertext, "base64"))) as BoundIntent[];
    },
    async save(value) {
      await disk.save({ ciphertext: secureStorage.encryptString(JSON.stringify(value)).toString("base64") });
    },
  }, id => getPeerHostRegistry().credentialIdentity(id));
  return store;
}
