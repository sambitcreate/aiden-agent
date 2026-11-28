import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathInside } from "../shared/path-containment.js";
import {
  botManagedHomeDirectoryName,
  createBotManagedWorkspaceCore,
  isBotManagedWorkspaceId,
  parseBotManagedHomeProvisioningReceipt,
  parseBotManagedHomeReceipt,
  type BotManagedHomeInspection,
  type BotManagedHomeProvisioningReceipt,
  type BotManagedHomeReceipt,
  type BotManagedWorkspaceDocument,
  type BotManagedWorkspaceIncarnation,
  type BotManagedWorkspaceStorage,
} from "./bot-managed-workspace-core.js";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

export const BOT_MANAGED_WORKSPACE_MANIFEST = "bot-managed-workspaces.json";
export const BOT_MANAGED_HOMES_DIRECTORY = "homes";
export const BOT_MANAGED_HOME_RECEIPTS_DIRECTORY = "receipts";
export const BOT_MANAGED_HOME_RECEIPT_SUFFIX = ".json";
/** Deleted homes are moved here first, then erased. Never listed as homes. */
export const BOT_MANAGED_REMOVED_HOMES_DIRECTORY = "removed";

const MANIFEST_MAX_BYTES = 256 * 1024;
const RECEIPT_MAX_BYTES = 8 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type MaybePromise<Value> = Value | Promise<Value>;

export interface FileBotManagedWorkspaceOptions {
  /** Dedicated private Bot-service root inside Electron's userData directory. */
  root(): MaybePromise<string>;
  now?: () => number;
  mintWorkspaceId?: () => string;
  onDurabilityWarning?(error: Error): void;
  syncDirectory?(directory: string): Promise<void>;
}

interface OwnedRoots {
  root: string;
  homes: string;
  receipts: string;
  manifest: string;
}

interface VerifiedOwnedRoots extends OwnedRoots {
  volumeDevice: string | null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertSafeRoot(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error("Bot managed workspace storage requires an absolute private root.");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Bot managed workspace storage cannot use a filesystem root.");
  }
  return resolved;
}

function assertOwnedByCurrentUser(info: { uid: number | bigint }, label: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function") {
    const uid = getuid();
    const matches = typeof info.uid === "bigint" ? info.uid === BigInt(uid) : info.uid === uid;
    if (!matches) {
      throw new Error(`${label} is not owned by the current user.`);
    }
  }
}

async function ensurePrivateDirectory(directory: string, recursive: boolean): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Bot managed workspace storage contains a non-directory or symbolic link.");
  }
  assertOwnedByCurrentUser(info, "Bot managed workspace directory");
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function defaultSyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function reportDurabilityWarning(
  error: unknown,
  callback: ((error: Error) => void) | undefined,
): void {
  try {
    callback?.(asError(error));
  } catch {
    // Publication already committed. Diagnostics cannot turn it into a rollback.
  }
}

function assertHomeDirectoryName(directoryName: string): void {
  const prefix = "home-";
  const workspaceId = directoryName.startsWith(prefix) ? directoryName.slice(prefix.length) : "";
  if (
    !isBotManagedWorkspaceId(workspaceId) ||
    botManagedHomeDirectoryName(workspaceId) !== directoryName
  ) {
    throw new Error("Bot managed home directory name is invalid.");
  }
}

function assertDirectChild(parent: string, candidate: string): void {
  if (
    !isPathInside(parent, candidate, { allowRoot: false }) ||
    path.relative(parent, candidate).includes(path.sep)
  ) {
    throw new Error("Bot managed workspace path escaped its private root.");
  }
}

async function parseJsonRegularFile(file: string, maxBytes: number): Promise<unknown> {
  return JSON.parse(decodeUtf8(await readRegularFile(file, maxBytes))) as unknown;
}

async function captureHomeIncarnation(candidate: string): Promise<BotManagedWorkspaceIncarnation> {
  const [info, resolvedResult] = await Promise.all([
    fs.lstat(candidate, { bigint: true }),
    fs.realpath(candidate).then(
      (resolved) => ({ ok: true as const, resolved }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Bot managed home is not an owned directory.");
  }
  assertOwnedByCurrentUser(info, "Bot managed home");
  if (!resolvedResult.ok) throw resolvedResult.error;
  if (resolvedResult.resolved !== candidate) {
    throw new Error("Bot managed home resolves outside its private root.");
  }
  if (info.ino <= 0n || info.dev < 0n) {
    throw new Error("Bot managed home has an invalid filesystem incarnation.");
  }
  return { device: info.dev.toString(10), inode: info.ino.toString(10) };
}

/**
 * Remount acceptance is a documented, deliberately narrow trust boundary.
 *
 * macOS assigns `st_dev` at mount time, so a legitimate remount changes the
 * live device while the owned home's inode survives. Accepting the inode alone
 * also accepts one case this comparison does not attempt to detect: a
 * *different* private volume mounted at the private root that presents the
 * persisted home inode. That case is out of scope because the durable manifest
 * and ownership receipt that describe the home live inside that same private
 * root, so an actor able to substitute the volume at that path already controls
 * every record that could identify it. Detecting it again needs a volume
 * identity that survives a remount (`statfs` `f_fsid`, which Node does not
 * expose); until then this is the reviewed behavior rather than an oversight.
 *
 * Every caller must still prove on the live filesystem that the home shares one
 * device with the `root`, `homes`, and `receipts` anchors (see
 * `assertOwnedVolume`), that the home and its receipt are owned by the current
 * user and are not symlinks, that the home resolves to its own path, and that
 * both hold private permissions. Substitutions that change the inode stay
 * rejected.
 */
function sameHomeByInode(
  left: BotManagedWorkspaceIncarnation,
  right: BotManagedWorkspaceIncarnation,
): boolean {
  return left.inode === right.inode;
}

function sameProvisioningReceipt(
  receipt: BotManagedHomeReceipt,
  expected: BotManagedHomeProvisioningReceipt,
): boolean {
  return (
    receipt.version === expected.version &&
    receipt.botId === expected.botId &&
    receipt.workspaceId === expected.workspaceId &&
    receipt.directoryName === expected.directoryName &&
    receipt.createdAt === expected.createdAt
  );
}

/** Node filesystem adapter with no Electron, renderer, or configStore dependency. */
export function createFileBotManagedWorkspaceStorage(
  options: Pick<FileBotManagedWorkspaceOptions, "root" | "onDurabilityWarning" | "syncDirectory">,
): BotManagedWorkspaceStorage {
  let rootsPromise: Promise<OwnedRoots> | undefined;
  const syncDirectory = options.syncDirectory ?? defaultSyncDirectory;

  const establishRoots = async (): Promise<OwnedRoots> => {
    const requested = assertSafeRoot(await options.root());
    await ensurePrivateDirectory(requested, true);
    const canonicalRoot = await fs.realpath(requested);
    const homes = path.join(canonicalRoot, BOT_MANAGED_HOMES_DIRECTORY);
    assertDirectChild(canonicalRoot, homes);
    await ensurePrivateDirectory(homes, false);
    const canonicalHomes = await fs.realpath(homes);
    const receipts = path.join(canonicalRoot, BOT_MANAGED_HOME_RECEIPTS_DIRECTORY);
    assertDirectChild(canonicalRoot, receipts);
    await ensurePrivateDirectory(receipts, false);
    const canonicalReceipts = await fs.realpath(receipts);
    return {
      root: canonicalRoot,
      homes: canonicalHomes,
      receipts: canonicalReceipts,
      manifest: path.join(canonicalRoot, BOT_MANAGED_WORKSPACE_MANIFEST),
    };
  };

  const roots = async (): Promise<VerifiedOwnedRoots> => {
    rootsPromise ??= establishRoots();
    const owned = await rootsPromise;
    // Re-prove these anchors on every operation so replacement cannot redirect
    // a previously cached path outside the Bot service.
    const anchorResults = await Promise.allSettled(
      [owned.root, owned.homes, owned.receipts].map(async (directory) => {
        const [info, resolvedResult] = await Promise.all([
          fs.lstat(directory, { bigint: true }),
          fs.realpath(directory).then(
            (resolved) => ({ ok: true as const, resolved }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        ]);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("Bot managed workspace root changed or became unsafe.");
        }
        assertOwnedByCurrentUser(info, "Bot managed workspace directory");
        if (!resolvedResult.ok) throw resolvedResult.error;
        if (resolvedResult.resolved !== directory) {
          throw new Error("Bot managed workspace root no longer resolves to its owned path.");
        }
        if (Number(info.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) {
          await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
        }
        return info.dev;
      }),
    );
    const devices: bigint[] = [];
    for (const result of anchorResults) {
      if (result.status === "rejected") throw result.reason;
      devices.push(result.value);
    }
    const [rootDev, homesDev, receiptsDev] = devices;
    const volumeDevice =
      rootDev !== undefined && rootDev === homesDev && rootDev === receiptsDev
        ? rootDev.toString(10)
        : null;
    return { ...owned, volumeDevice };
  };

  /** `<root>/removed`, created on first use and re-proven on every call. */
  const removedHomesDirectory = async (owned: OwnedRoots): Promise<string> => {
    const removed = path.join(owned.root, BOT_MANAGED_REMOVED_HOMES_DIRECTORY);
    assertDirectChild(owned.root, removed);
    await ensurePrivateDirectory(removed, false);
    if ((await fs.realpath(removed)) !== removed) {
      throw new Error("Bot managed removed-homes directory escaped its private root.");
    }
    return removed;
  };

  const homePath = (owned: OwnedRoots, directoryName: string): string => {
    assertHomeDirectoryName(directoryName);
    const candidate = path.join(owned.homes, directoryName);
    assertDirectChild(owned.homes, candidate);
    return candidate;
  };

  const receiptPath = (owned: OwnedRoots, directoryName: string): string => {
    assertHomeDirectoryName(directoryName);
    const candidate = path.join(
      owned.receipts,
      `${directoryName}${BOT_MANAGED_HOME_RECEIPT_SUFFIX}`,
    );
    assertDirectChild(owned.receipts, candidate);
    return candidate;
  };

  const assertOwnedVolume = (
    volumeDevice: string | null,
    incarnation: BotManagedWorkspaceIncarnation,
    receiptInfo?: { dev: number | bigint },
  ): void => {
    if (
      volumeDevice === null ||
      volumeDevice !== incarnation.device ||
      (receiptInfo && receiptInfo.dev.toString(10) !== incarnation.device)
    ) {
      throw new Error("Bot managed home is mounted outside its private volume.");
    }
  };

  const inspectHomeWithRoots = async (
    owned: VerifiedOwnedRoots,
    directoryName: string,
  ): Promise<BotManagedHomeInspection | null> => {
    const candidate = homePath(owned, directoryName);
    const ownedReceiptPath = receiptPath(owned, directoryName);
    const [info, receiptInfo] = await Promise.all([
      fs.lstat(candidate).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      }),
      fs.lstat(ownedReceiptPath).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      }),
    ]);
    if (!info && !receiptInfo) return null;
    if (!info || !receiptInfo) {
      throw new Error("Bot managed home provisioning is incomplete and requires reconciliation.");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Bot managed home is not an owned directory.");
    }
    assertOwnedByCurrentUser(info, "Bot managed home");
    if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.nlink !== 1) {
      if ((await fs.realpath(candidate)) !== candidate) {
        throw new Error("Bot managed home resolves outside its private root.");
      }
      throw new Error("Bot managed home is missing its private ownership receipt.");
    }
    assertOwnedByCurrentUser(receiptInfo, "Bot managed home ownership receipt");
    const [resolvedResult, receiptResult] = await Promise.all([
      (async () => {
        const resolved = await fs.realpath(candidate);
        if (resolved !== candidate) {
          throw new Error("Bot managed home resolves outside its private root.");
        }
        if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
          await fs.chmod(candidate, PRIVATE_DIRECTORY_MODE);
        }
      })().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      (async () => {
        if ((receiptInfo.mode & 0o777) !== PRIVATE_FILE_MODE) {
          await fs.chmod(ownedReceiptPath, PRIVATE_FILE_MODE);
        }
        return parseJsonRegularFile(ownedReceiptPath, RECEIPT_MAX_BYTES);
      })().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    if (!resolvedResult.ok) throw resolvedResult.error;
    if (!receiptResult.ok) throw receiptResult.error;
    const receipt = receiptResult.value;
    const parsedReceipt = parseBotManagedHomeReceipt(receipt);
    // Capture last so the returned token represents the pathname as close as
    // possible to handoff. Effect code must still call service.revalidate().
    const incarnation = await captureHomeIncarnation(candidate);
    assertOwnedVolume(owned.volumeDevice, incarnation, receiptInfo);
    if (!sameHomeByInode(parsedReceipt.incarnation, incarnation)) {
      throw new Error("Bot managed home was replaced after its ownership receipt was issued.");
    }
    return {
      homePath: candidate,
      incarnation,
      receipt,
    };
  };

  const inspectHome = async (directoryName: string): Promise<BotManagedHomeInspection | null> => {
    assertHomeDirectoryName(directoryName);
    const owned = await roots();
    return inspectHomeWithRoots(owned, directoryName);
  };

  const writeAtomicJson = async (
    owned: OwnedRoots,
    destination: string,
    value: unknown,
  ): Promise<void> => {
    if (path.dirname(destination) !== owned.root) {
      throw new Error("Bot managed workspace metadata escaped its private root.");
    }
    const temporary = path.join(owned.root, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    assertDirectChild(owned.root, temporary);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await syncDirectory(owned.root);
    } catch (error) {
      reportDurabilityWarning(error, options.onDurabilityWarning);
    }
  };

  return {
    async readManifest(): Promise<unknown | null> {
      const { manifest } = await roots();
      let info: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        info = await fs.lstat(manifest);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        throw new Error("Bot managed workspace manifest is not a private regular file.");
      }
      assertOwnedByCurrentUser(info, "Bot managed workspace manifest");
      if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) await fs.chmod(manifest, PRIVATE_FILE_MODE);
      return parseJsonRegularFile(manifest, MANIFEST_MAX_BYTES);
    },

    async writeManifest(document: BotManagedWorkspaceDocument): Promise<void> {
      const owned = await roots();
      await writeAtomicJson(owned, owned.manifest, document);
    },

    async listHomeDirectoryNames(): Promise<readonly string[]> {
      const owned = await roots();
      const [homeNames, receiptNames] = await Promise.all([
        fs.readdir(owned.homes),
        fs.readdir(owned.receipts),
      ]);
      const names = new Set<string>();
      for (const directoryName of homeNames) {
        assertHomeDirectoryName(directoryName);
        names.add(directoryName);
      }
      for (const filename of receiptNames) {
        if (!filename.endsWith(BOT_MANAGED_HOME_RECEIPT_SUFFIX)) {
          throw new Error("Bot managed receipt storage contains a foreign entry.");
        }
        const directoryName = filename.slice(0, -BOT_MANAGED_HOME_RECEIPT_SUFFIX.length);
        assertHomeDirectoryName(directoryName);
        names.add(directoryName);
      }
      return [...names];
    },

    inspectHome,

    async createHome(
      directoryName: string,
      receipt: BotManagedHomeProvisioningReceipt,
    ): Promise<BotManagedHomeInspection> {
      assertHomeDirectoryName(directoryName);
      const expectedReceipt = parseBotManagedHomeProvisioningReceipt(receipt);
      if (expectedReceipt.directoryName !== directoryName) {
        throw new Error("Bot managed home receipt targets another directory.");
      }
      const owned = await roots();
      const candidate = homePath(owned, directoryName);
      const ownedReceiptPath = receiptPath(owned, directoryName);
      let createdHome = false;
      try {
        await fs.mkdir(candidate, { mode: PRIVATE_DIRECTORY_MODE });
        createdHome = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await ensurePrivateDirectory(candidate, false);
      const existingReceiptInfo = await fs.lstat(ownedReceiptPath).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      let actualReceipt: BotManagedHomeReceipt | undefined;
      if (existingReceiptInfo) {
        if (
          existingReceiptInfo.isSymbolicLink() ||
          !existingReceiptInfo.isFile() ||
          existingReceiptInfo.nlink !== 1
        ) {
          throw new Error("Bot managed home ownership receipt is unsafe.");
        }
        assertOwnedByCurrentUser(existingReceiptInfo, "Bot managed home ownership receipt");
        if ((existingReceiptInfo.mode & 0o777) !== PRIVATE_FILE_MODE) {
          await fs.chmod(ownedReceiptPath, PRIVATE_FILE_MODE);
        }
        actualReceipt = parseBotManagedHomeReceipt(
          await parseJsonRegularFile(ownedReceiptPath, RECEIPT_MAX_BYTES),
        );
        if (!sameProvisioningReceipt(actualReceipt, expectedReceipt)) {
          if (createdHome && (await fs.readdir(candidate)).length === 0) {
            await fs.rmdir(candidate).catch(() => undefined);
          }
          throw new Error("Bot managed home is owned by another lifecycle reservation.");
        }
      } else if ((await fs.readdir(candidate)).length !== 0) {
        throw new Error("Bot managed home recovery refused unexpected content.");
      }

      const incarnation = await captureHomeIncarnation(candidate);
      assertOwnedVolume(owned.volumeDevice, incarnation, existingReceiptInfo ?? undefined);
      if (actualReceipt && !sameHomeByInode(actualReceipt.incarnation, incarnation)) {
        if (createdHome && (await fs.readdir(candidate)).length === 0) {
          await fs.rmdir(candidate).catch(() => undefined);
        }
        throw new Error("Bot managed home was replaced after its ownership receipt was issued.");
      }
      const durableReceipt: BotManagedHomeReceipt = {
        ...expectedReceipt,
        incarnation,
      };

      let handle: fs.FileHandle | undefined;
      try {
        if (!existingReceiptInfo) {
          handle = await fs.open(ownedReceiptPath, "wx", PRIVATE_FILE_MODE);
          await handle.writeFile(`${JSON.stringify(durableReceipt)}\n`, "utf8");
          await handle.chmod(PRIVATE_FILE_MODE);
          await handle.sync();
          await handle.close();
          handle = undefined;
        }
        const entries = await fs.readdir(candidate);
        if (entries.length !== 0) {
          throw new Error("Bot managed home creation found unexpected content.");
        }
        // Explicit assertion: provisioning itself never created Git metadata.
        await fs.lstat(path.join(candidate, ".git")).then(
          () => {
            throw new Error("Bot managed home provisioning must not create Git metadata.");
          },
          (error: unknown) => {
            if (!isMissing(error)) throw error;
          },
        );
        const directoryHandle = await fs.open(candidate, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        try {
          await Promise.all([syncDirectory(owned.homes), syncDirectory(owned.receipts)]);
        } catch (error) {
          reportDurabilityWarning(error, options.onDurabilityWarning);
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        const entries = await fs.readdir(candidate).catch(() => null);
        const currentIncarnation = await captureHomeIncarnation(candidate).catch(() => null);
        const stillCreatedHome = Boolean(
          currentIncarnation &&
            (await roots().then(
              (currentOwned) => {
                assertOwnedVolume(
                  currentOwned.volumeDevice,
                  currentIncarnation,
                  existingReceiptInfo ?? undefined,
                );
                return sameHomeByInode(currentIncarnation, incarnation);
              },
              () => false,
            )),
        );
        if (!existingReceiptInfo && entries?.length === 0 && stillCreatedHome) {
          await fs.rm(ownedReceiptPath, { force: true }).catch(() => undefined);
        }
        if (createdHome && entries?.length === 0 && stillCreatedHome) {
          await fs.rmdir(candidate).catch(() => undefined);
        }
        throw error;
      }
      const inspection = await inspectHomeWithRoots(owned, directoryName);
      if (!inspection) throw new Error("Bot managed home disappeared during creation.");
      return inspection;
    },

    async removeOwnedEmptyHome(
      directoryName: string,
      expectedReceipt: BotManagedHomeReceipt,
    ): Promise<boolean> {
      const expected = parseBotManagedHomeReceipt(expectedReceipt);
      if (expected.directoryName !== directoryName) {
        throw new Error("Bot managed home rollback receipt targets another directory.");
      }
      assertHomeDirectoryName(directoryName);
      const owned = await roots();
      const candidate = homePath(owned, directoryName);
      const ownedReceiptPath = receiptPath(owned, directoryName);
      const [homeInfo, receiptInfo] = await Promise.all([
        fs.lstat(candidate).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }),
        fs.lstat(ownedReceiptPath).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }),
      ]);
      if (receiptInfo) {
        if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.nlink !== 1) {
          throw new Error("Bot managed home rollback receipt is unsafe.");
        }
        const actual = parseBotManagedHomeReceipt(
          await parseJsonRegularFile(ownedReceiptPath, RECEIPT_MAX_BYTES),
        );
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("Bot managed home rollback refused a mismatched ownership receipt.");
        }
      }
      if (homeInfo) {
        if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
          throw new Error("Bot managed home rollback target is unsafe.");
        }
        assertOwnedByCurrentUser(homeInfo, "Bot managed home rollback target");
        if ((await fs.realpath(candidate)) !== candidate) {
          throw new Error("Bot managed home rollback target escaped its private root.");
        }
        const incarnation = await captureHomeIncarnation(candidate);
        assertOwnedVolume(owned.volumeDevice, incarnation, receiptInfo ?? undefined);
        if (!sameHomeByInode(expected.incarnation, incarnation)) {
          throw new Error("Bot managed home rollback refused a replaced directory.");
        }
        if ((await fs.readdir(candidate)).length !== 0) return false;
      }
      if (receiptInfo) await fs.unlink(ownedReceiptPath);
      try {
        if (homeInfo) await fs.rmdir(candidate);
      } catch (error) {
        // Preserve authority evidence if another writer raced content into the home.
        if (receiptInfo) {
          await fs
            .writeFile(ownedReceiptPath, `${JSON.stringify(expected)}\n`, {
              flag: "wx",
              mode: PRIVATE_FILE_MODE,
            })
            .catch(() => undefined);
        }
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
        throw error;
      }
      try {
        await Promise.all([syncDirectory(owned.homes), syncDirectory(owned.receipts)]);
      } catch (error) {
        reportDurabilityWarning(error, options.onDurabilityWarning);
      }
      return true;
    },

    async removeOwnedHome(
      directoryName: string,
      expectedReceipt: BotManagedHomeReceipt,
    ): Promise<void> {
      const expected = parseBotManagedHomeReceipt(expectedReceipt);
      if (expected.directoryName !== directoryName) {
        throw new Error("Bot managed home delete receipt targets another directory.");
      }
      assertHomeDirectoryName(directoryName);
      const owned = await roots();
      const candidate = homePath(owned, directoryName);
      const ownedReceiptPath = receiptPath(owned, directoryName);
      const [homeInfo, receiptInfo] = await Promise.all([
        fs.lstat(candidate).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }),
        fs.lstat(ownedReceiptPath).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }),
      ]);
      if (receiptInfo) {
        if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.nlink !== 1) {
          throw new Error("Bot managed home delete receipt is unsafe.");
        }
        const actual = parseBotManagedHomeReceipt(
          await parseJsonRegularFile(ownedReceiptPath, RECEIPT_MAX_BYTES),
        );
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("Bot managed home delete refused a mismatched ownership receipt.");
        }
      }
      if (homeInfo) {
        if (!receiptInfo) {
          throw new Error("Bot managed home delete refused a home without its receipt.");
        }
        if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
          throw new Error("Bot managed home delete target is unsafe.");
        }
        assertOwnedByCurrentUser(homeInfo, "Bot managed home delete target");
        if ((await fs.realpath(candidate)) !== candidate) {
          throw new Error("Bot managed home delete target escaped its private root.");
        }
        const incarnation = await captureHomeIncarnation(candidate);
        assertOwnedVolume(owned.volumeDevice, incarnation, receiptInfo);
        if (!sameHomeByInode(expected.incarnation, incarnation)) {
          throw new Error("Bot managed home delete refused a replaced directory.");
        }
        const removed = await removedHomesDirectory(owned);
        const target = path.join(removed, `${directoryName}-${randomUUID()}`);
        assertDirectChild(removed, target);
        // Same private volume (asserted above), so this rename is atomic.
        await fs.rename(candidate, target);
      }
      if (receiptInfo) await fs.unlink(ownedReceiptPath);
      if (homeInfo || receiptInfo) {
        try {
          await Promise.all([syncDirectory(owned.homes), syncDirectory(owned.receipts)]);
        } catch (error) {
          reportDurabilityWarning(error, options.onDurabilityWarning);
        }
      }
    },

    async purgeRemovedHomes(): Promise<void> {
      const owned = await roots();
      const removed = await removedHomesDirectory(owned);
      for (const entry of await fs.readdir(removed)) {
        const target = path.join(removed, entry);
        assertDirectChild(removed, target);
        // Recursive removal deletes symbolic links themselves and never follows them.
        await fs.rm(target, { recursive: true, force: true });
      }
    },
  };
}

/** Production-ready service; callers supply one dedicated Bot-service root. */
export function createBotManagedWorkspaceService(options: FileBotManagedWorkspaceOptions) {
  return createBotManagedWorkspaceCore({
    storage: createFileBotManagedWorkspaceStorage(options),
    now: options.now,
    mintWorkspaceId: options.mintWorkspaceId ?? randomUUID,
  });
}

export type BotManagedWorkspaceService = ReturnType<typeof createBotManagedWorkspaceService>;
