import * as fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./durable-fs.js";

/** The original operation published, but its captured approval snapshot no longer matches.
 * This is historical settlement, never a pre-publication refusal or a grant. */
export class BotFolderGrantReplayStaleError extends Error {
  readonly name = "BotFolderGrantReplayStaleError";
}

export class BotFolderGrantJournalReadError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("The Bot folder grant journal could not be read. Check access to bot-folder-grants.json, preserve it for repair, then restart Aiden before allowing another folder.");
    this.name = "BotFolderGrantJournalReadError";
    this.cause = cause;
  }
}

export class BotFolderGrantJournalRepairError extends Error {
  constructor() {
    super("The Bot folder grant journal needs repair. Its evidence was preserved in bot-folder-grants.json. Restore a verified backup of that file, then restart Aiden before allowing another folder.");
    this.name = "BotFolderGrantJournalRepairError";
  }
}

export interface BotFolderGrantInput {
  audienceId: string;
  botId: string;
  folderPath: string;
  rootId?: string;
  expectedRevision: string;
  expectedIdentity: { device: string; inode: string };
  expectedInventoryRevision?: string;
  operationId: string;
}
export interface BotFolderGrantRecord {
  input: BotFolderGrantInput;
  /** Preallocated before root creation, so recovery also covers a crash inside add(). */
  rootId: string;
  ownsRoot: boolean;
  optionId?: string;
  resultRevision?: string;
  state: "pending" | "committed" | "rolled_back";
}
export interface BotFolderGrantJournal {
  list(): Promise<BotFolderGrantRecord[]>;
  put(record: BotFolderGrantRecord): Promise<void>;
}
export function createBotFolderGrantJournal(storage: {
  read(): Promise<unknown>;
  write(records: BotFolderGrantRecord[]): Promise<void>;
}): BotFolderGrantJournal {
  let tail: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<BotFolderGrantRecord[]> => {
    let records: unknown;
    try {
      records = await storage.read();
    } catch (error) {
      if (error instanceof BotFolderGrantJournalRepairError) throw error;
      throw new BotFolderGrantJournalReadError(error);
    }
    if (records === null) return [];
    if (!Array.isArray(records) || records.length > 4096)
      throw new BotFolderGrantJournalRepairError();
    const ids = new Set<string>();
    for (const value of records) {
      const r = value as BotFolderGrantRecord | null;
      if (
        !r ||
        typeof r !== "object" ||
        Object.keys(r).some(
          (key) =>
            !["input", "rootId", "ownsRoot", "optionId", "resultRevision", "state"].includes(key),
        ) ||
        !r.input ||
        typeof r.input !== "object"
      )
        throw new BotFolderGrantJournalRepairError();
      const input = r.input;
      const bounded = (v: unknown, max: number) =>
        typeof v === "string" && v.length > 0 && v.length <= max;
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "audienceId",
              "botId",
              "folderPath",
              "rootId",
              "expectedRevision",
              "expectedIdentity",
              "expectedInventoryRevision",
              "operationId",
            ].includes(key),
        ) ||
        !bounded(input.audienceId, 256) ||
        !bounded(input.botId, 256) ||
        !bounded(input.operationId, 256) ||
        !bounded(input.expectedRevision, 256) ||
        !bounded(input.folderPath, 4096) ||
        !path.isAbsolute(input.folderPath) ||
        !input.expectedIdentity ||
        !/^\d+$/u.test(input.expectedIdentity.device) ||
        !/^\d+$/u.test(input.expectedIdentity.inode) ||
        !bounded(r.rootId, 128) ||
        typeof r.ownsRoot !== "boolean" ||
        !["pending", "committed", "rolled_back"].includes(r.state) ||
        (input.expectedInventoryRevision !== undefined &&
          !/^[a-f0-9]{64}$/u.test(input.expectedInventoryRevision)) ||
        (input.rootId !== undefined && !bounded(input.rootId, 128)) ||
        (r.optionId !== undefined && !bounded(r.optionId, 256)) ||
        (r.resultRevision !== undefined && !bounded(r.resultRevision, 256)) ||
        (r.state === "committed" && (!r.optionId || !r.resultRevision)) ||
        ids.has(input.operationId)
      )
        throw new BotFolderGrantJournalRepairError();
      ids.add(input.operationId);
    }
    return structuredClone(records);
  };
  return {
    async list() {
      await tail;
      return read();
    },
    put(record) {
      const copy = structuredClone(record);
      const result = tail.then(async () => {
        const records = await read(),
          index = records.findIndex((entry) => entry.input.operationId === copy.input.operationId);
        if (index < 0) records.push(copy);
        else records[index] = copy;
        // These are durable replay receipts. Pruning a completed operation
        // without a separate replay tombstone could recreate removed authority.
        if (records.length > 4096) throw new Error("The Bot folder grant journal is full.");
        await storage.write(records);
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
export function fileBotFolderGrantJournal(directory: () => string): BotFolderGrantJournal {
  const file = () => path.join(directory(), "bot-folder-grants.json");
  return createBotFolderGrantJournal({
    read: async () => {
      try {
        const value: unknown = JSON.parse(await fs.readFile(file(), "utf8"));
        if (value === null) throw new BotFolderGrantJournalRepairError();
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) throw new BotFolderGrantJournalRepairError();
        throw error;
      }
    },
    write: (records) =>
      writeFileAtomic(file(), JSON.stringify(records), { mode: 0o600, mkdirMode: 0o700 }),
  });
}
