import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";

const VERSION = 1 as const;
const FILE = "bot-capability-migration-seal.json";
const MAX_BYTES = 512;

export interface BotCapabilityMigrationSeal {
  isSealed(): Promise<boolean>;
  seal(): Promise<void>;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertOwned(info: Awaited<ReturnType<fs.FileHandle["stat"]>>, label: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    throw new Error(`${label} has the wrong owner.`);
  }
}

async function privateRoot(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || path.resolve(candidate) === path.parse(candidate).root) {
    throw new Error("Bot capability migration seal requires a private absolute root.");
  }
  const requested = path.resolve(candidate);
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Bot capability migration seal root is not a private directory.");
  }
  assertOwned(info, "Bot capability migration seal root");
  await fs.chmod(requested, 0o700);
  return fs.realpath(requested);
}

async function readPrivateSeal(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Bot capability migration seal is not a private regular file.");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("Bot capability migration seal is not a private regular file.");
    }
    assertOwned(info, "Bot capability migration seal");
    if (info.size === 0 || info.size > MAX_BYTES) {
      throw new Error("Bot capability migration seal is invalid.");
    }
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseSeal(bytes: Buffer): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new Error("Bot capability migration seal is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Bot capability migration seal is invalid.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 2 ||
    (value as { version?: unknown }).version !== VERSION ||
    !validTimestamp((value as { sealedAt?: unknown }).sealedAt)
  ) {
    throw new Error("Bot capability migration seal is invalid.");
  }
}

export function createBotCapabilityMigrationSeal(options: {
  root(): string;
  now?: () => number;
}): BotCapabilityMigrationSeal {
  const now = options.now ?? Date.now;
  return {
    async isSealed(): Promise<boolean> {
      const root = await privateRoot(options.root());
      const file = path.join(root, FILE);
      try {
        parseSeal(await readPrivateSeal(file));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },

    async seal(): Promise<void> {
      if (await this.isSealed()) return;
      const root = await privateRoot(options.root());
      const sealedAt = now();
      if (!validTimestamp(sealedAt)) throw new Error("Invalid Bot migration seal clock.");
      const staged = path.join(root, `.${FILE}.${randomUUID()}.tmp`);
      const bytes = Buffer.from(JSON.stringify({ version: VERSION, sealedAt }), "utf8");
      try {
        const handle = await fs.open(staged, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const destination = path.join(root, FILE);
        await fs.rename(staged, destination);
        parseSeal(await readPrivateSeal(destination));
        const directory = await fs.open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await fs.rm(staged, { force: true }).catch(() => undefined);
      }
    },
  };
}
