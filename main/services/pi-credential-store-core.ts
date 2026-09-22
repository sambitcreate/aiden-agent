import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { readRegularUtf8File } from "./regular-file-read.js";

type MaybePromise<T> = T | Promise<T>;

export interface CredentialCipher {
  isEncryptionAvailable(): MaybePromise<boolean>;
  encryptString(value: string): MaybePromise<Buffer>;
  decryptString(value: Buffer): MaybePromise<string>;
}

interface StoredCredential {
  type: Credential["type"];
  ciphertext: string;
}

interface CredentialDocument {
  version: 1;
  entries: Record<string, StoredCredential>;
}

interface EncryptedPiCredentialStoreOptions {
  filePath(): MaybePromise<string>;
  cipher: CredentialCipher;
  /** Optional diagnostics hook used to make lock-order tests deterministic. */
  onLockQueued?(scope: string): void;
  /** A committed write stays successful when directory fsync is unsupported. */
  onDurabilityWarning?(error: Error): void;
  syncDirectory?(directory: string): Promise<void>;
  beforeWritePublish?(): void;
  afterWritePublish?(): void;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>, onQueued?: () => void): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    onQueued?.();
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Cancel callers promptly without releasing locks held by unfinished work. */
function credentialOperation<T>(
  options: AuthOperationOptions | undefined,
  operation: (beginPublication: () => void) => Promise<T>,
): Promise<T> {
  const signal = options?.signal;
  if (!signal) return operation(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    const beginPublication = (): void => {
      signal.throwIfAborted();
      // Atomic rename is the point of no return. Its result, including any
      // persistence failure, must win over cancellation from this point on.
      signal.removeEventListener("abort", abort);
    };
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(beginPublication);
    }).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Aiden is single-instance; share locks across every store object in that process. */
const sharedMutexes = new Map<string, AsyncMutex>();

function sharedMutex(key: string): AsyncMutex {
  let mutex = sharedMutexes.get(key);
  if (!mutex) {
    mutex = new AsyncMutex();
    sharedMutexes.set(key, mutex);
  }
  return mutex;
}

function emptyDocument(): CredentialDocument {
  return { version: 1, entries: Object.create(null) as Record<string, StoredCredential> };
}

function validateProviderId(providerId: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(providerId)) {
    throw new Error("Invalid provider credential identifier.");
  }
}

function validateCredential(value: unknown): Credential {
  if (!value || typeof value !== "object")
    throw new Error("Stored provider credential is invalid.");
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    if (candidate.key !== undefined && typeof candidate.key !== "string") {
      throw new Error("Stored API-key credential is invalid.");
    }
    if (candidate.env !== undefined && (!candidate.env || typeof candidate.env !== "object")) {
      throw new Error("Stored API-key credential environment is invalid.");
    }
    return value as Credential;
  }
  if (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  ) {
    return value as Credential;
  }
  throw new Error("Stored OAuth credential is invalid.");
}

function parseDocument(text: string): CredentialDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Provider credential store is not valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Provider credential store has an invalid shape.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    throw new Error("Provider credential store version is unsupported.");
  }

  const entries = Object.create(null) as Record<string, StoredCredential>;
  for (const [providerId, rawEntry] of Object.entries(candidate.entries)) {
    validateProviderId(providerId);
    if (!rawEntry || typeof rawEntry !== "object") {
      throw new Error("Provider credential store contains an invalid entry.");
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      (entry.type !== "api_key" && entry.type !== "oauth") ||
      typeof entry.ciphertext !== "string" ||
      entry.ciphertext.length === 0
    ) {
      throw new Error("Provider credential store contains an invalid entry.");
    }
    entries[providerId] = { type: entry.type, ciphertext: entry.ciphertext };
  }
  return { version: 1, entries };
}

export class EncryptedPiCredentialStore implements CredentialStore {
  constructor(private readonly options: EncryptedPiCredentialStoreOptions) {}

  private async resolvedFilePath(): Promise<string> {
    return path.resolve(await this.options.filePath());
  }

  private async mutex(scope: string): Promise<AsyncMutex> {
    const file = await this.resolvedFilePath();
    return sharedMutex(`${file}\0${scope}`);
  }

  private async readDocument(): Promise<CredentialDocument> {
    try {
      return parseDocument(await readRegularUtf8File(await this.resolvedFilePath()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw error;
    }
  }

  private async writeDocument(
    document: CredentialDocument,
    beginPublication: () => void,
  ): Promise<void> {
    const destination = await this.resolvedFilePath();
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(document, null, 2), "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.options.beforeWritePublish?.();
      beginPublication();
      await fs.rename(temporary, destination);
      this.options.afterWritePublish?.();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await (this.options.syncDirectory ?? syncDirectory)(directory);
    } catch (error) {
      try {
        this.options.onDurabilityWarning?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // The file is already committed. Diagnostics must not turn success into failure.
      }
    }
  }

  private async ensureEncryption(): Promise<void> {
    if (!(await this.options.cipher.isEncryptionAvailable())) {
      throw new Error("Secure storage is unavailable; provider credentials cannot be accessed.");
    }
  }

  private async decrypt(entry: StoredCredential): Promise<Credential> {
    await this.ensureEncryption();
    let plaintext: string;
    try {
      plaintext = await this.options.cipher.decryptString(Buffer.from(entry.ciphertext, "base64"));
    } catch {
      throw new Error("Stored provider credential could not be decrypted.");
    }
    let credential: Credential;
    try {
      credential = validateCredential(JSON.parse(plaintext) as unknown);
    } catch {
      throw new Error("Stored provider credential is invalid or corrupted.");
    }
    if (credential.type !== entry.type) {
      throw new Error("Stored provider credential metadata does not match its encrypted value.");
    }
    return credential;
  }

  private async encrypt(credential: Credential): Promise<StoredCredential> {
    await this.ensureEncryption();
    const validated = validateCredential(credential);
    const encrypted = await this.options.cipher.encryptString(JSON.stringify(validated));
    return { type: validated.type, ciphertext: Buffer.from(encrypted).toString("base64") };
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validateProviderId(providerId);
    return credentialOperation(options, async () => {
      const entry = (await this.readDocument()).entries[providerId];
      options?.signal?.throwIfAborted();
      return entry ? this.decrypt(entry) : undefined;
    });
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return credentialOperation(options, async () => {
      const document = await this.readDocument();
      return Object.entries(document.entries)
        .map(([providerId, entry]) => ({ providerId, type: entry.type }))
        .sort((left, right) => left.providerId.localeCompare(right.providerId));
    });
  }

  async modify(
    providerId: string,
    modifier: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    validateProviderId(providerId);
    return credentialOperation(options, async (beginPublication) => {
      const providerMutex = await this.mutex(`provider:${providerId}`);
      return providerMutex.run(
        async () => {
          options?.signal?.throwIfAborted();
          const current = await this.read(providerId, options);
          options?.signal?.throwIfAborted();
          const next = await modifier(current);
          options?.signal?.throwIfAborted();
          if (next === undefined) return current;
          const encrypted = await this.encrypt(next);
          options?.signal?.throwIfAborted();
          const documentMutex = await this.mutex("document");
          await documentMutex.run(async () => {
            options?.signal?.throwIfAborted();
            const document = await this.readDocument();
            options?.signal?.throwIfAborted();
            document.entries[providerId] = encrypted;
            await this.writeDocument(document, beginPublication);
          });
          return next;
        },
        () => this.options.onLockQueued?.(`provider:${providerId}`),
      );
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    validateProviderId(providerId);
    return credentialOperation(options, async (beginPublication) => {
      const providerMutex = await this.mutex(`provider:${providerId}`);
      await providerMutex.run(
        async () => {
          options?.signal?.throwIfAborted();
          const documentMutex = await this.mutex("document");
          await documentMutex.run(async () => {
            options?.signal?.throwIfAborted();
            const document = await this.readDocument();
            options?.signal?.throwIfAborted();
            if (!document.entries[providerId]) return;
            delete document.entries[providerId];
            await this.writeDocument(document, beginPublication);
          });
        },
        () => this.options.onLockQueued?.(`provider:${providerId}`),
      );
    });
  }
}
