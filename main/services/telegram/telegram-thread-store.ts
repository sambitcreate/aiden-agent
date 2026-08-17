// Durable private-chat thread-to-Aiden-target routing for one Telegram profile.

import { DataStore } from "../data-store.js";

export interface TelegramThreadTarget {
  threadId: number;
  chatId: number;
  name: string;
  workspaceId?: string;
  createdAt: number;
}

interface TelegramThreadState {
  targets?: TelegramThreadTarget[];
}

function normalizeThreadState(value: unknown): TelegramThreadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = (value as TelegramThreadState).targets;
  if (!Array.isArray(raw)) return {};
  const targets = raw.filter((target): target is TelegramThreadTarget =>
    Boolean(
      target &&
      typeof target === "object" &&
      Number.isSafeInteger(target.threadId) && target.threadId > 0 &&
      Number.isSafeInteger(target.chatId) &&
      typeof target.name === "string" && target.name.length > 0 && target.name.length <= 128 &&
      (target.workspaceId === undefined || typeof target.workspaceId === "string") &&
      typeof target.createdAt === "number",
    ),
  ).slice(-256);
  return { targets };
}

export function createTelegramThreadStore(options: { root(): string; profile: string }) {
  const fileName = options.profile === "default"
    ? "telegram-threads.json"
    : `telegram-threads-${options.profile}.json`;
  const store = new DataStore<TelegramThreadState>(fileName, {}, options.root, {
    maxBytes: 256 * 1024,
    normalize: normalizeThreadState,
  });

  async function list(): Promise<TelegramThreadTarget[]> {
    return [...((await store.load()).targets ?? [])];
  }

  return {
    list,
    async find(threadId: number): Promise<TelegramThreadTarget | undefined> {
      return (await list()).find((target) => target.threadId === threadId);
    },
    async findWorkspace(workspaceId: string): Promise<TelegramThreadTarget | undefined> {
      return (await list()).find((target) => target.workspaceId === workspaceId);
    },
    async upsert(target: TelegramThreadTarget): Promise<void> {
      await store.update((draft) => {
        draft.targets = (draft.targets ?? []).filter((candidate) =>
          candidate.threadId !== target.threadId && candidate.workspaceId !== target.workspaceId,
        );
        draft.targets.push(target);
        draft.targets = draft.targets.slice(-256);
      });
    },
    async remove(threadId: number): Promise<void> {
      await store.update((draft) => {
        draft.targets = (draft.targets ?? []).filter((target) => target.threadId !== threadId);
      });
    },
    async retainWorkspaces(workspaceIds: ReadonlySet<string>, chatId: number): Promise<TelegramThreadTarget[]> {
      const removed: TelegramThreadTarget[] = [];
      await store.update((draft) => {
        draft.targets = (draft.targets ?? []).filter((target) => {
          const keep = target.chatId === chatId && target.workspaceId !== undefined && workspaceIds.has(target.workspaceId);
          if (!keep) removed.push(target);
          return keep;
        });
      });
      return removed;
    },
    async clear(): Promise<void> {
      await store.save({ targets: [] });
    },
  };
}
