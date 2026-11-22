import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import {
  MAX_SUBAGENT_TRANSCRIPT_BYTES,
  parseSubagentTranscript,
  subagentTranscriptBytes,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import { writeFileAtomic } from "../durable-fs.js";
import type { SubagentTranscriptFactory } from "./subagent-supervisor-core.js";
import { SubagentTranscriptRecorder } from "./subagent-transcript-recorder.js";

/** The folder inside a store root that holds one subfolder per chat. */
export const SUBAGENT_TRANSCRIPTS_DIRECTORY = "transcripts";
/** Matches the run store's own limit, so one chat cannot fill the disk. */
export const MAX_SUBAGENT_TRANSCRIPTS_PER_CHAT = 512;

export interface SubagentTranscriptWriteOptions {
  /** Flush to disk before returning. Used for a helper's final state. */
  durable?: boolean;
}

export interface SubagentTranscriptStore {
  write(chatId: string, transcript: SubagentTranscriptV1, options?: SubagentTranscriptWriteOptions): Promise<void>;
  /** The saved transcript, or null when there is none or it is unreadable. */
  read(chatId: string, runId: string): Promise<SubagentTranscriptV1 | null>;
  /** Remove every transcript of the chat. Later writes for it are dropped. */
  deleteChat(chatId: string): Promise<void>;
}

export interface SubagentTranscriptStoreOptions {
  maxPerChat?: number;
}

function chatFolderName(chatId: string): string {
  return createHash("sha256").update(chatId, "utf8").digest("hex");
}

function requireChatId(chatId: string): void {
  if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > 512) {
    throw new Error("Invalid chat id for a helper conversation.");
  }
}

/**
 * One file per helper, `transcripts/<sha256(chatId)>/<runId>.json`, inside
 * `root` (the desktop uses `subagent-runs-v2`, the server its Bot history
 * folder). Files are replaced atomically and are owner-only. Writes for one
 * chat run in order with its deletion, and a deleted chat accepts no more
 * writes in this process, so a helper still finishing cannot bring a file back.
 */
export function createSubagentTranscriptStore(
  resolveRoot: () => Promise<string>,
  options: SubagentTranscriptStoreOptions = {},
): SubagentTranscriptStore {
  const maxPerChat = options.maxPerChat ?? MAX_SUBAGENT_TRANSCRIPTS_PER_CHAT;
  const tails = new Map<string, Promise<void>>();
  const deleted = new Set<string>();
  const known = new Set<string>();

  async function chatDirectory(chatId: string): Promise<string> {
    const root = await resolveRoot();
    if (!path.isAbsolute(root)) throw new Error("Helper conversations need an absolute storage folder.");
    return path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY, chatFolderName(chatId));
  }

  function serialized<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const key = chatFolderName(chatId);
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  async function pruneOldest(directory: string, keep: string): Promise<void> {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    if (names.length <= maxPerChat) return;
    const dated = await Promise.all(
      names.map(async (name) => {
        const stat = await fs.stat(path.join(directory, name)).catch(() => null);
        return { name, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    dated.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
    let excess = names.length - maxPerChat;
    for (const { name } of dated) {
      if (excess <= 0) break;
      if (name === keep) continue;
      await fs.rm(path.join(directory, name), { force: true });
      excess -= 1;
    }
  }

  return {
    write(chatId, transcript, writeOptions = {}) {
      requireChatId(chatId);
      if (!isSafeSubagentIdentifier(transcript.runId) || parseSubagentTranscript(transcript) === undefined) {
        return Promise.reject(new Error("Invalid helper conversation."));
      }
      const serializedJson = JSON.stringify(transcript);
      if (Buffer.byteLength(serializedJson, "utf8") > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
        return Promise.reject(new Error("Helper conversation is over its size limit."));
      }
      return serialized(chatId, async () => {
        if (deleted.has(chatFolderName(chatId))) return;
        const directory = await chatDirectory(chatId);
        const file = `${transcript.runId}.json`;
        await writeFileAtomic(path.join(directory, file), serializedJson, {
          mode: 0o600,
          mkdirMode: 0o700,
          fsync: writeOptions.durable === true,
        });
        const runKey = `${chatFolderName(chatId)}/${file}`;
        if (!known.has(runKey)) {
          known.add(runKey);
          await pruneOldest(directory, file).catch(() => undefined);
        }
      });
    },

    async read(chatId, runId) {
      requireChatId(chatId);
      if (!isSafeSubagentIdentifier(runId)) return null;
      const file = path.join(await chatDirectory(chatId), `${runId}.json`);
      let contents: Buffer;
      try {
        const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SUBAGENT_TRANSCRIPT_BYTES) return null;
          contents = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(contents.toString("utf8"));
      } catch {
        return null;
      }
      const transcript = parseSubagentTranscript(value);
      if (!transcript || transcript.runId !== runId) return null;
      if (subagentTranscriptBytes(transcript) > MAX_SUBAGENT_TRANSCRIPT_BYTES) return null;
      return transcript;
    },

    deleteChat(chatId) {
      requireChatId(chatId);
      const key = chatFolderName(chatId);
      deleted.add(key);
      return serialized(chatId, async () => {
        const directory = await chatDirectory(chatId);
        await fs.rm(directory, { recursive: true, force: true });
        for (const runKey of [...known]) {
          if (runKey.startsWith(`${key}/`)) known.delete(runKey);
        }
      });
    },
  };
}

export interface SubagentTranscriptFactoryOptions {
  /** Stream each saved change to the chat's open windows. */
  publish?: (update: SubagentTranscriptUpdateV1, chatId: string) => void;
  onError?: (error: unknown) => void;
}

/** Records every helper of a supervisor into `store`, and optionally streams it. */
export function createSubagentTranscriptFactory(
  store: SubagentTranscriptStore,
  options: SubagentTranscriptFactoryOptions = {},
): SubagentTranscriptFactory {
  return ({ runId, chatId, task }) =>
    new SubagentTranscriptRecorder({
      runId,
      task,
      onError: options.onError,
      sink: {
        persist: (transcript, final) => store.write(chatId, transcript, { durable: final }),
        ...(options.publish
          ? { publish: (update: SubagentTranscriptUpdateV1) => options.publish!(update, chatId) }
          : {}),
      },
    });
}
