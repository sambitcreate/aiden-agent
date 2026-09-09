import * as path from "node:path";
import { app } from "../platform.js";
import { DataStore } from "./data-store.js";
import { readRegularFile, decodeUtf8 } from "./regular-file-read.js";
import { chatStore } from "./chat-store.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { configStore } from "./config-store.js";
import { subagentRunStore } from "./subagents/subagent-run-store.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import {
  isEmptyChatMigrationState,
  isLegacyEmptyWorkspaceChat,
  migrateEmptyWorkspaceChats,
  type EmptyChatMigrationState,
} from "./empty-chat-migration.js";

const migration = new DataStore<EmptyChatMigrationState>(
  "empty-workspace-chats-migration-v1.json",
  { version: 1, pending: null, complete: false },
  undefined,
  { fileMode: 0o600, maxBytes: 4 * 1024 * 1024, isSafe: isEmptyChatMigrationState,
    rejectCorruptWrite: true, rejectUnsafeWrite: true },
);

/** Protect even disabled tasks and retained historical runs, without normalizing away invalid records. */
async function scheduledChatIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of ["schedules.json", "schedule-runs.json"]) {
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(path.join(app.getPath("userData"), file), 16 * 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const records: unknown = JSON.parse(decodeUtf8(bytes));
    if (!Array.isArray(records)) throw new Error("Scheduled chat references could not be read safely.");
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("Scheduled chat references could not be read safely.");
      }
      if (typeof record.chatId === "string") ids.add(record.chatId);
    }
  }
  return ids;
}

export async function migrateLegacyEmptyWorkspaceChats(): Promise<number> {
  const state = await migration.load();
  if (await migration.loadedFromCorruptFile() || await migration.loadedFromUnsafeFile()) {
    throw new Error("Empty-chat migration receipt could not be read safely.");
  }
  if (state.complete) return 0;
  if (!displayImageArtifactStore.availability().available || !generativeUiArtifactStore.availability().available) {
    throw new Error("Empty-chat cleanup requires readable artifact recovery stores.");
  }
  const workspaceIds = new Set((await configStore.listWorkspaces()).map((workspace) => workspace.id));
  const reservedChatIds = await scheduledChatIds();
  return migrateEmptyWorkspaceChats({
    load: async () => state,
    save: async (next) => { await migration.update((current) => Object.assign(current, next)); },
    list: () => chatStore.list(),
    get: (id) => chatStore.get(id),
    eligible: async (chat) => isLegacyEmptyWorkspaceChat(chat, workspaceIds, reservedChatIds) &&
      !(await displayImageArtifactStore.hasPending(chat.id)) &&
      !(await generativeUiArtifactStore.hasPending(chat.id)) &&
      (await subagentRunStore.listByChat(chat.id)).length === 0 &&
      (await piRuntimeEffectStore.listOperationsByChat(chat.id)).length === 0 &&
      (await piRuntimeEffectStore.listEffectsByChat(chat.id)).length === 0 &&
      !(await piCompactionSessionStore.hasChatHistory(chat.id)),
    remove: (id, assertCurrent) => chatApplicationService.remove(id, { assertCurrent }),
  });
}
