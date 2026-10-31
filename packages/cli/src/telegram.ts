import { join } from "node:path";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AppSettings } from "../../../main/services/types.js";
import type { TelegramConfig } from "../../../main/services/telegram/telegram-config.js";
import { createTelegramServiceCore } from "../../../main/services/telegram/telegram-service-core.js";
import { TelegramBotApi, createFetchTransport, createFetchFileDownloader, createFetchUploadTransport } from "../../../main/services/telegram/telegram-bot-api.js";
import { createTelegramOwnershipLease } from "../../../main/services/telegram/telegram-ownership.js";
import { JsonStore, acquireLease } from "./state.ts";
import { insightCredentials } from "./credentials.ts";
import { createCliModelRuntime } from "./providers.ts";
import { workspaceStore, accessFor } from "./workspaces.ts";
import { createDaemonChats } from "./daemon-chats.ts";

const settingsStore = (root: string) => new JsonStore<AppSettings>(join(root, "telegram.json"), {});
const tokenFor = (root: string) => async () => process.env.AIDEN_TELEGRAM_TOKEN?.trim() || await insightCredentials(root).read("telegram") || null;

export function createCliTelegram(agentDir: string, chats: ReturnType<typeof createDaemonChats>, apiOverride?: TelegramBotApi) {
  const settings = settingsStore(agentDir), offsets = new JsonStore<{ lastUpdateId?: number }>(join(agentDir, "telegram-runtime.json"), {});
  const getToken = tokenFor(agentDir);
  const config: TelegramConfig = {
    getSettings: () => settings.load(),
    setSettings: (patch) => settings.update((value) => { Object.assign(value, patch); return value; }),
    hasToken: async () => !!await getToken(),
    getOffset: async () => (await offsets.load()).lastUpdateId,
    clearOffset: async () => { await offsets.save({}); },
    persistOffset: async (id) => { await offsets.update((value) => { value.lastUpdateId = Math.max(id, value.lastUpdateId ?? -1); }); },
    snapshot: async () => {
      const value = await settings.load();
      // Owner identity is chosen on the local terminal; never auto-pair the first stranger.
      const enabled = value.telegramEnabled === true && Number.isSafeInteger(value.telegramAllowedUserId) && value.telegramAllowedUserId! > 0;
      return { enabled, hasToken: !!await getToken(), allowedUserId: value.telegramAllowedUserId, lastUpdateId: await config.getOffset() };
    },
  };
  const api = apiOverride ?? new TelegramBotApi(createFetchTransport(getToken), createFetchFileDownloader(getToken), createFetchUploadTransport(getToken));
  const ownership = createTelegramOwnershipLease({ root: () => agentDir, profile: "default" });
  return createTelegramServiceCore({ api, config, getToken, now: Date.now,
    sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); },
    warn: (message) => process.stderr.write(`aiden: ${message}\n`), error: (message) => process.stderr.write(`aiden: ${message}\n`), info: () => {},
    acquireOwnership: () => ownership.acquire(), releaseOwnership: () => ownership.release(),
    listWorkspaces: async () => (await workspaceStore(agentDir).load()).filter((item) => accessFor(agentDir, item.folderPath) === "full"),
    listModels: async () => (await createCliModelRuntime(agentDir)).getAvailableSnapshot().map((model) => ({ providerId: model.provider, providerLabel: model.provider, model: model.id, modelLabel: model.name, reasoning: model.reasoning })),
    abortChat: (id) => chats.llmClient.cancelChat!(id),
    turn: {
      chatStore: chats.chatStore, llmClient: chats.llmClient, broadcastMetadata: () => {},
      resolveThinkingLevel: async () => (await settings.load()).telegramThinkingLevel,
      resolveWorkspace: async (id) => {
        const item = (await workspaceStore(agentDir).load()).find((item) => item.id === id);
        return item && accessFor(agentDir, item.folderPath) === "full" ? { kind: "project", workspaceId: item.id } : { kind: "stale" };
      },
      resolveProvider: async (id, modelId) => {
        const saved = await settings.load();
        const providerId = id ?? saved.telegramProviderId, model = modelId ?? saved.telegramModel;
        if (!providerId || !model) return null;
        const runtime = await createCliModelRuntime(agentDir), selected = runtime.getModel(providerId, model);
        if (!selected) return null;
        return { providerId, model, provider: { id: providerId, kind: "openai", label: providerId, baseUrl: selected.baseUrl, needsKey: true, isBuiltin: true } };
      },
    },
  });
}

export async function telegramCommand(agentDir: string, args: string[]) {
  const [action = "status", file] = args;
  const store = settingsStore(agentDir);
  if (action === "status") return { ...await store.load(), hasToken: !!await tokenFor(agentDir)() };
  const release = acquireLease(join(agentDir, "serve"));
  try {
    if (action === "disable") { await store.update((value) => { value.telegramEnabled = false; }); return { enabled: false }; }
    if (action === "disconnect") { await store.save({ telegramEnabled: false }); await insightCredentials(agentDir).delete("telegram"); return { disconnected: true }; }
    if (action === "connect") {
      const token = process.env.AIDEN_TELEGRAM_TOKEN?.trim();
      if (!token) throw new Error("Set AIDEN_TELEGRAM_TOKEN for this explicit connection check.");
      const bot = await new TelegramBotApi(createFetchTransport(async () => token)).getMe();
      await insightCredentials(agentDir).write("telegram", token);
      return { username: bot.username, connected: true };
    }
    if (action !== "configure" || !file) throw new Error("Usage: telegram status|connect|configure <settings.json>|disable|disconnect (stop serve before changing configuration)");
    const value = JSON.parse(readFileSync(file, "utf8")) as AppSettings;
    if (!Number.isSafeInteger(value.telegramAllowedUserId) || value.telegramAllowedUserId! <= 0 || typeof value.telegramEnabled !== "boolean" || !value.telegramWorkspaceId || !value.telegramProviderId || !value.telegramModel) throw new Error("Provide telegramEnabled, telegramAllowedUserId, telegramWorkspaceId, telegramProviderId and telegramModel.");
    const workspace = (await workspaceStore(agentDir).load()).find((item) => item.id === value.telegramWorkspaceId);
    if (!workspace || accessFor(agentDir, workspace.folderPath) !== "full") throw new Error("Select a registered workspace with explicitly granted full access.");
    if (!(await createCliModelRuntime(agentDir)).getModel(value.telegramProviderId, value.telegramModel)) throw new Error("The provider/model is unavailable.");
    const normalized: AppSettings = { telegramEnabled: value.telegramEnabled, telegramAllowedUserId: value.telegramAllowedUserId, telegramWorkspaceId: value.telegramWorkspaceId, telegramProviderId: value.telegramProviderId, telegramModel: value.telegramModel };
    await store.save(normalized); return normalized;
  } finally { release(); }
}
