import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createBotLifecycleJournalCore,
  type BotLifecycleJournalDocument,
  type BotLifecycleJournalStorage,
} from "./bot-lifecycle-journal-core.js";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

export const BOT_LIFECYCLE_JOURNAL_FILENAME = "bot-lifecycle-journal.json";

const JOURNAL_MAX_BYTES = 512 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type MaybePromise<Value> = Value | Promise<Value>;

export interface FileBotLifecycleJournalOptions {
  /** Dedicated private Bot-service root inside Electron's userData directory. */
  root(): MaybePromise<string>;
  now?: () => number;
  onDurabilityWarning?(error: Error): void;
  syncDirectory?(directory: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertSafeRoot(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error("Bot lifecycle journal requires an absolute private root.");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Bot lifecycle journal cannot use a filesystem root.");
  }
  return resolved;
}

function assertOwnedByCurrentUser(info: Awaited<ReturnType<typeof fs.lstat>>, label: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    throw new Error(`${label} is not owned by the current user.`);
  }
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
    callback?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // The rename is already committed; diagnostics cannot turn it into failure.
  }
}

/** Strict, atomic, private-file adapter for the Bot lifecycle journal. */
export function createFileBotLifecycleJournalStorage(
  options: Pick<FileBotLifecycleJournalOptions, "root" | "onDurabilityWarning" | "syncDirectory">,
): BotLifecycleJournalStorage {
  let rootPromise: Promise<{ root: string; journal: string }> | undefined;
  const syncDirectory = options.syncDirectory ?? defaultSyncDirectory;

  const establishRoot = async () => {
    const requested = assertSafeRoot(await options.root());
    await fs.mkdir(requested, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const info = await fs.lstat(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Bot lifecycle journal root is not an owned directory.");
    }
    assertOwnedByCurrentUser(info, "Bot lifecycle journal root");
    await fs.chmod(requested, PRIVATE_DIRECTORY_MODE);
    const canonical = await fs.realpath(requested);
    return { root: canonical, journal: path.join(canonical, BOT_LIFECYCLE_JOURNAL_FILENAME) };
  };

  const paths = async () => {
    rootPromise ??= establishRoot();
    const value = await rootPromise;
    const info = await fs.lstat(value.root);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await fs.realpath(value.root)) !== value.root
    ) {
      throw new Error("Bot lifecycle journal root changed or became unsafe.");
    }
    assertOwnedByCurrentUser(info, "Bot lifecycle journal root");
    if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      await fs.chmod(value.root, PRIVATE_DIRECTORY_MODE);
    }
    return value;
  };

  return {
    async read(): Promise<unknown | null> {
      const { journal } = await paths();
      let info: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        info = await fs.lstat(journal);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        throw new Error("Bot lifecycle journal is not a private regular file.");
      }
      assertOwnedByCurrentUser(info, "Bot lifecycle journal");
      if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) await fs.chmod(journal, PRIVATE_FILE_MODE);
      return JSON.parse(decodeUtf8(await readRegularFile(journal, JOURNAL_MAX_BYTES))) as unknown;
    },

    async write(document: BotLifecycleJournalDocument): Promise<void> {
      const { root, journal } = await paths();
      if (path.dirname(journal) !== root) {
        throw new Error("Bot lifecycle journal escaped its private root.");
      }
      const temporary = path.join(root, `.${BOT_LIFECYCLE_JOURNAL_FILENAME}.${randomUUID()}.tmp`);
      if (path.dirname(temporary) !== root) {
        throw new Error("Bot lifecycle journal staging path escaped its private root.");
      }
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(temporary, "wx", PRIVATE_FILE_MODE);
        await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
        await handle.chmod(PRIVATE_FILE_MODE);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, journal);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      try {
        await syncDirectory(root);
      } catch (error) {
        reportDurabilityWarning(error, options.onDurabilityWarning);
      }
    },
  };
}

export function mintBotLifecycleOperationId(): string {
  return randomUUID();
}

export function createBotLifecycleJournal(options: FileBotLifecycleJournalOptions) {
  return createBotLifecycleJournalCore({
    storage: createFileBotLifecycleJournalStorage(options),
    now: options.now,
  });
}

export type BotLifecycleJournal = ReturnType<typeof createBotLifecycleJournal>;
