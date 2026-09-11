import type { CredentialCipher } from "./pi-credential-store-core.js";
import {
  parseStoredPeerHosts,
  type PeerHostStorage,
  type StoredPeerHost,
} from "./peer-host-registry.js";

export interface PeerEncryptedDocument {
  version: 1;
  ciphertext: string | null;
}

/** One atomic encrypted document avoids a registry/credential two-file commit gap. */
export class EncryptedPeerHostStorage implements PeerHostStorage {
  constructor(
    private readonly storage: {
      load(): Promise<PeerEncryptedDocument>;
      save(
        value: PeerEncryptedDocument,
        isCurrent?: () => boolean,
      ): Promise<void>;
    },
    private readonly cipher: CredentialCipher,
  ) {}

  async load(): Promise<StoredPeerHost[]> {
    const document = await this.storage.load();
    if (document.version !== 1)
      throw new Error("Unsupported paired-device store.");
    if (document.ciphertext === null) return [];
    if (
      typeof document.ciphertext !== "string" ||
      document.ciphertext.length > 524288
    )
      throw new Error("Invalid paired-device store.");
    if (!(await this.cipher.isEncryptionAvailable()))
      throw new Error("Unlock secure storage to access paired devices.");
    const serialized = await this.cipher.decryptString(
      Buffer.from(document.ciphertext, "base64"),
    );
    if (Buffer.byteLength(serialized) > 262144)
      throw new Error("Paired-device store exceeds its limit.");
    return parseStoredPeerHosts(JSON.parse(serialized));
  }

  async save(
    hosts: StoredPeerHost[],
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const value = JSON.stringify(parseStoredPeerHosts(hosts));
    if (Buffer.byteLength(value) > 262144)
      throw new Error("Paired-device store exceeds its limit.");
    if (!(await this.cipher.isEncryptionAvailable()))
      throw new Error("Unlock secure storage before pairing devices.");
    const ciphertext = (await this.cipher.encryptString(value)).toString(
      "base64",
    );
    if (!isCurrent()) throw new Error("Pairing was cancelled.");
    await this.storage.save({ version: 1, ciphertext }, isCurrent);
  }
}
