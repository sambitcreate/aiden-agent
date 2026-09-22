import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import {
  BOT_AVATAR_CANONICAL_MAX_BYTES,
  type BotAvatarAssetIncarnation,
  type BotAvatarStorage,
  type BotAvatarStoreDocument,
  type BotAvatarStoredAsset,
  BotAvatarStateError,
  createBotAvatarStore,
  type BotAvatarNormalizer,
} from "./bot-avatar-store-core.js";

export const BOT_AVATAR_MANIFEST = "manifest.json";
export const BOT_AVATAR_ASSETS_DIRECTORY = "assets";
const MANIFEST_MAX_BYTES = 4 * 1_048_576;
const ASSET_FILENAME = /^avatar-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.png$/u;

export interface FileBotAvatarStorageOptions {
  root(): string;
  beforeManifestPublish?: () => Promise<void>;
}

function incarnation(info: { dev: number | bigint; ino: number | bigint }): BotAvatarAssetIncarnation {
  return { device: String(info.dev), inode: String(info.ino) };
}

function sameIncarnation(
  info: { dev: number | bigint; ino: number | bigint },
  expected: BotAvatarAssetIncarnation,
): boolean {
  return String(info.dev) === expected.device && String(info.ino) === expected.inode;
}

function ownedRegular(info: Awaited<ReturnType<typeof stat>>): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return info.isFile() && (uid === undefined || info.uid === uid) &&
    (Number(info.mode) & 0o077) === 0;
}

async function ensureOwnedDirectory(directory: string): Promise<BotAvatarAssetIncarnation> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new BotAvatarStateError("The Bot avatar directory is not privately owned.");
  }
  if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
  return incarnation(info);
}

function assetFilename(assetId: string): string {
  const candidate = `avatar-${assetId}.png`;
  if (!ASSET_FILENAME.test(candidate)) {
    throw new BotAvatarStateError("The Bot avatar asset identity is invalid.");
  }
  return candidate;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFileBotAvatarStorage(
  options: FileBotAvatarStorageOptions,
): BotAvatarStorage {
  let directories: Promise<{
    root: string;
    assets: string;
    rootIncarnation: BotAvatarAssetIncarnation;
    assetsIncarnation: BotAvatarAssetIncarnation;
  }> | null = null;
  const resolveDirectories = () => {
    directories ??= (async () => {
      const root = options.root();
      const assets = join(root, BOT_AVATAR_ASSETS_DIRECTORY);
      const rootIncarnation = await ensureOwnedDirectory(root);
      const assetsIncarnation = await ensureOwnedDirectory(assets);
      return { root, assets, rootIncarnation, assetsIncarnation };
    })();
    return directories;
  };

  const assertDirectoriesCurrent = async (
    resolved: Awaited<ReturnType<typeof resolveDirectories>>,
  ): Promise<void> => {
    let rootInfo: Awaited<ReturnType<typeof lstat>>;
    let assetsInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      [rootInfo, assetsInfo] = await Promise.all([
        lstat(resolved.root),
        lstat(resolved.assets),
      ]);
    } catch {
      throw new BotAvatarStateError("The Bot avatar directory changed outside Aiden.");
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
        assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory() ||
        !sameIncarnation(rootInfo, resolved.rootIncarnation) ||
        !sameIncarnation(assetsInfo, resolved.assetsIncarnation)) {
      throw new BotAvatarStateError("The Bot avatar directory changed outside Aiden.");
    }
  };

  const removeIfDirectoriesCurrent = async (
    resolved: Awaited<ReturnType<typeof resolveDirectories>>,
    filePath: string,
  ): Promise<void> => {
    try {
      await assertDirectoriesCurrent(resolved);
      await rm(filePath, { force: true });
    } catch {
      // Never turn cleanup into a write through a replaced parent directory.
    }
  };

  const removeByAssetId = async (
    assetId: string,
    expected?: BotAvatarStoredAsset,
  ): Promise<boolean> => {
    const resolved = await resolveDirectories();
    await assertDirectoriesCurrent(resolved);
    const { assets } = resolved;
    const filePath = join(assets, assetFilename(assetId));
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!ownedRegular(info) || (expected && (!sameIncarnation(info, expected.incarnation) ||
          info.size !== expected.byteSize))) {
        throw new BotAvatarStateError("The Bot avatar asset changed outside Aiden.");
      }
      const current = await lstat(filePath);
      if (!current.isFile() || current.isSymbolicLink() || !sameIncarnation(current, incarnation(info))) {
        throw new BotAvatarStateError("The Bot avatar asset changed outside Aiden.");
      }
      await assertDirectoriesCurrent(resolved);
      await rm(filePath);
      await syncDirectory(assets);
      return true;
    } finally {
      await handle.close();
    }
  };

  return {
    async readManifest(): Promise<unknown | null> {
      const resolved = await resolveDirectories();
      await assertDirectoriesCurrent(resolved);
      const { root } = resolved;
      const filePath = join(root, BOT_AVATAR_MANIFEST);
      let handle;
      try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new BotAvatarStateError("The Bot avatar manifest is unavailable.");
      }
      try {
        const before = await handle.stat();
        if (!ownedRegular(before) || before.size < 2 || before.size > MANIFEST_MAX_BYTES) {
          throw new BotAvatarStateError("The Bot avatar manifest is invalid.");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (!sameIncarnation(after, incarnation(before)) || after.size !== before.size ||
            bytes.length !== before.size) {
          throw new BotAvatarStateError("The Bot avatar manifest changed while it was read.");
        }
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error) {
        if (error instanceof BotAvatarStateError) throw error;
        throw new BotAvatarStateError("The Bot avatar manifest is corrupt.");
      } finally {
        await handle.close();
      }
    },

    async writeManifest(document: BotAvatarStoreDocument): Promise<void> {
      const resolved = await resolveDirectories();
      await assertDirectoriesCurrent(resolved);
      const { root } = resolved;
      const destination = join(root, BOT_AVATAR_MANIFEST);
      const staged = join(root, `.manifest-${randomUUID()}.tmp`);
      const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      if (bytes.length > MANIFEST_MAX_BYTES) {
        throw new BotAvatarStateError("The Bot avatar manifest exceeds its private-store limit.");
      }
      const handle = await open(
        staged,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o600);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeIfDirectoriesCurrent(resolved, staged);
        throw error;
      }
      await handle.close();
      try {
        await options.beforeManifestPublish?.();
        await assertDirectoriesCurrent(resolved);
        await rename(staged, destination);
        // The rename is the publication boundary. A directory-fsync failure
        // afterward must not be reported as a safe rollback opportunity: the
        // manifest may already name the new asset. Keep the live mutation
        // committed and let restart validation classify any crash loss.
        await syncDirectory(root).catch(() => undefined);
      } catch (error) {
        await removeIfDirectoriesCurrent(resolved, staged);
        throw error;
      }
    },

    async writeAsset(assetId: string, bytes: Buffer): Promise<BotAvatarStoredAsset> {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > BOT_AVATAR_CANONICAL_MAX_BYTES) {
        throw new BotAvatarStateError("The canonical Bot avatar bytes are invalid.");
      }
      const resolved = await resolveDirectories();
      await assertDirectoriesCurrent(resolved);
      const { assets } = resolved;
      const filePath = join(assets, assetFilename(assetId));
      const handle = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o600);
        const info = await handle.stat();
        if (!ownedRegular(info) || info.size !== bytes.length) {
          throw new BotAvatarStateError("The canonical Bot avatar was not stored privately.");
        }
        await assertDirectoriesCurrent(resolved);
        await syncDirectory(assets);
        return {
          assetId,
          byteSize: bytes.length,
          digest: createHash("sha256").update(bytes).digest("hex"),
          incarnation: incarnation(info),
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeIfDirectoriesCurrent(resolved, filePath);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async readAsset(asset: BotAvatarStoredAsset): Promise<Buffer | null> {
      const resolved = await resolveDirectories();
      await assertDirectoriesCurrent(resolved);
      const { assets } = resolved;
      const filePath = join(assets, assetFilename(asset.assetId));
      let handle;
      try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new BotAvatarStateError("The Bot avatar asset is unavailable.");
      }
      try {
        const before = await handle.stat();
        if (!ownedRegular(before) || !sameIncarnation(before, asset.incarnation) ||
            before.size !== asset.byteSize || before.size > BOT_AVATAR_CANONICAL_MAX_BYTES) {
          throw new BotAvatarStateError("The Bot avatar asset changed outside Aiden.");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (!sameIncarnation(after, asset.incarnation) || after.size !== before.size ||
            bytes.length !== before.size) {
          throw new BotAvatarStateError("The Bot avatar asset changed while it was read.");
        }
        return bytes;
      } finally {
        await handle.close();
      }
    },

    removeAsset(asset: BotAvatarStoredAsset): Promise<boolean> {
      return removeByAssetId(asset.assetId, asset);
    },

    removeOrphanAsset(assetId: string): Promise<boolean> {
      return removeByAssetId(assetId);
    },

    async listAssetIds(): Promise<readonly string[]> {
      const resolved = await resolveDirectories();
      await assertDirectoriesCurrent(resolved);
      const { assets } = resolved;
      return (await readdir(assets, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => ASSET_FILENAME.exec(entry.name)?.[1])
        .filter((assetId): assetId is string => Boolean(assetId));
    },
  };
}

export interface FileBotAvatarStoreOptions extends FileBotAvatarStorageOptions {
  normalizer: BotAvatarNormalizer;
  now?: () => number;
  mintAssetId?: () => string;
  mintAssetRevision?: () => string;
}

/** Main-owned integration API for BotApplicationService/Remote route adapters. */
export function createFileBotAvatarStore(options: FileBotAvatarStoreOptions) {
  return createBotAvatarStore({
    storage: createFileBotAvatarStorage(options),
    normalizer: options.normalizer,
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintAssetId ? { mintAssetId: options.mintAssetId } : {}),
    ...(options.mintAssetRevision ? { mintAssetRevision: options.mintAssetRevision } : {}),
  });
}
