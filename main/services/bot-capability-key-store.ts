import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { BOT_CAPABILITY_OPAQUE_KEY_BYTES } from "./bot-capability-bindings.js";

export const BOT_CAPABILITY_OPAQUE_KEY_FILENAME = "capability-opaque-key.bin";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function assertPrivateRoot(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error("Bot capability key storage requires an absolute private root.");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Bot capability key storage cannot use a filesystem root.");
  }
  return resolved;
}

function assertOwnedByCurrentUser(
  info: Awaited<ReturnType<typeof fs.lstat>>,
  label: string,
): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    throw new Error(`${label} is not owned by the current user.`);
  }
}

async function ensurePrivateRoot(candidate: string): Promise<string> {
  const requested = assertPrivateRoot(candidate);
  await fs.mkdir(requested, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await fs.lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Bot capability key root is not a private directory.");
  }
  assertOwnedByCurrentUser(info, "Bot capability key root");
  await fs.chmod(requested, PRIVATE_DIRECTORY_MODE);
  return fs.realpath(requested);
}

async function readExactPrivateKey(file: string): Promise<Uint8Array> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Bot capability key is not a private regular file.");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("Bot capability key is not a private regular file.");
    }
    assertOwnedByCurrentUser(info, "Bot capability key");
    if (info.size !== BOT_CAPABILITY_OPAQUE_KEY_BYTES) {
      throw new Error("Bot capability key has an invalid length and was preserved.");
    }
    if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE);
    const value = await handle.readFile();
    if (value.byteLength !== BOT_CAPABILITY_OPAQUE_KEY_BYTES) {
      throw new Error("Bot capability key changed while it was being read.");
    }
    return Uint8Array.from(value);
  } finally {
    await handle.close();
  }
}

/**
 * Load one installation-stable private key used only to mint opaque capability
 * identities. Corrupt or replaced files fail closed and are never regenerated.
 */
export function createBotCapabilityOpaqueKeyStore(options: {
  root(): string | Promise<string>;
  randomKey?: () => Uint8Array;
}) {
  let keyPromise: Promise<{ key: Uint8Array; created: boolean }> | undefined;

  const load = async (): Promise<{ key: Uint8Array; created: boolean }> => {
    const root = await ensurePrivateRoot(await options.root());
    const file = path.join(root, BOT_CAPABILITY_OPAQUE_KEY_FILENAME);
    if (path.dirname(file) !== root) {
      throw new Error("Bot capability key escaped its private root.");
    }
    try {
      return { key: await readExactPrivateKey(file), created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const generated = Uint8Array.from(
      options.randomKey?.() ?? randomBytes(BOT_CAPABILITY_OPAQUE_KEY_BYTES),
    );
    if (generated.byteLength !== BOT_CAPABILITY_OPAQUE_KEY_BYTES) {
      throw new Error("Bot capability key generator returned an invalid length.");
    }
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(generated);
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const rootHandle = await fs.open(root, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
      return { key: Uint8Array.from(generated), created: true };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { key: await readExactPrivateKey(file), created: false };
      }
      throw error;
    }
  };

  return {
    load(): Promise<Uint8Array> {
      keyPromise ??= load().catch((error) => {
        keyPromise = undefined;
        throw error;
      });
      return keyPromise.then(({ key }) => Uint8Array.from(key));
    },
    loadWithMetadata(): Promise<{ key: Uint8Array; created: boolean }> {
      keyPromise ??= load().catch((error) => {
        keyPromise = undefined;
        throw error;
      });
      return keyPromise.then(({ key, created }) => ({
        key: Uint8Array.from(key),
        created,
      }));
    },
  };
}

export type BotCapabilityOpaqueKeyStore = ReturnType<
  typeof createBotCapabilityOpaqueKeyStore
>;
