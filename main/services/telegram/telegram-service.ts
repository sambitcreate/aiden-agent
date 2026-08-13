// Telegram service production singleton.
// Mirrors schedule-service.ts: factory + DI, export const at import time.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import { app, ipcMain, logger } from "../../platform.js";
import { configStore } from "../config-store.js";
import { chatStore } from "../chat-store.js";
import { llmClient } from "../llm-client.js";
import { providerRegistry } from "../provider-registry.js";
import { listProvidersWithLegacyPiCredentialMigration } from "../legacy-pi-credential-migration.js";
import { OPENAI_CODEX_PROVIDER_ID } from "../codex-provider.js";
import { resolveModelRuntime } from "../model-runtime.js";
import { piCompactionSessionStore } from "../pi-compaction-session-store.js";
import { secrets } from "../secrets.js";
import type { Provider, StoredProvider } from "../types.js";
import {
  createFetchFileDownloader,
  createFetchTransport,
  createFetchUploadTransport,
  TelegramBotApi,
} from "./telegram-bot-api.js";
import { createTelegramConfig } from "./telegram-config.js";
import { isTelegramFolderWorkspace } from "./telegram-workspace-core.js";
import type { TelegramWorkspaceResolution } from "./telegram-turn.js";
import { createTelegramServiceCore } from "./telegram-service-core.js";
import { compactTelegramSession } from "./telegram-session.js";
import { transcribe } from "../transcription.js";
import { skillRegistry } from "../skill-registry-main.js";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { TelegramModelChoice } from "./telegram-controls.js";
export const TELEGRAM_PROVIDER_ID = "telegram";

async function resolveProvider(): Promise<{
  providerId: string;
  model: string;
  provider: StoredProvider;
} | null> {
  const settings = await configStore.getSettings();
  // Prefer Telegram-specific provider/model, fall back to the global default.
  const providerId = settings.telegramProviderId ?? settings.lastProviderId;
  if (!providerId) return null;
  const provider =
    (await providerRegistry.selectionProvider(providerId)) ??
    (await configStore.getProvider(providerId));
  if (!provider) return null;
  const model =
    settings.telegramModel ?? settings.lastModel ?? provider.defaultModel ?? provider.models[0];
  if (!model) return null;
  return { providerId, model, provider };
}

async function resolveWorkspace(workspaceId?: string): Promise<TelegramWorkspaceResolution> {
  if (!workspaceId) return { kind: "assistant" };
  const workspace = await configStore.getWorkspace(workspaceId);

  if (!workspace || !isTelegramFolderWorkspace(workspace)) {
    return { kind: "stale" };
  }
  return { kind: "project", workspaceId: workspace.id };
}

async function listTelegramModels(): Promise<readonly TelegramModelChoice[]> {
  const [builtin, custom, codex] = await Promise.all([
    providerRegistry.listBuiltinProviders(),
    listProvidersWithLegacyPiCredentialMigration(),
    providerRegistry.codex.snapshot().catch(() => null),
  ]);
  const byId = new Map<string, Provider>();
  for (const provider of [...builtin, ...custom]) {
    if (provider.hasKey || !provider.needsKey) byId.set(provider.id, provider);
  }
  if (codex?.configured) {
    byId.set(OPENAI_CODEX_PROVIDER_ID, {
      id: OPENAI_CODEX_PROVIDER_ID,
      kind: "openai",
      label: codex.name,
      baseUrl: "",
      models: codex.models.map((model) => model.id),
      modelMetadata: Object.fromEntries(
        codex.models.map((model) => [model.id, {
          source: "provider" as const,
          name: model.name,
          type: "llm" as const,
          vision: model.vision,
          reasoning: model.reasoning,
          thinkingLevels: model.thinkingLevels,
          contextLength: model.contextWindow,
        }]),
      ),
      defaultModel: codex.models[0]?.id,
      needsKey: true,
      hasKey: true,
      isBuiltin: true,
    });
  }
  return [...byId.values()].flatMap((provider) =>
    provider.models.map((model) => {
      const metadata = provider.modelMetadata?.[model];
      return {
        providerId: provider.id,
        providerLabel: provider.label,
        model,
        modelLabel: metadata?.name,
        reasoning: metadata?.reasoning ?? false,
        thinkingLevels: metadata?.thinkingLevels,
      };
    }),
  );
}

function broadcastMetadata(chat: {
  id: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
}): void {
  ipcMain.broadcast("chats:metadata-updated", {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
  });
}

export function createTelegramService() {
  let tokenLogged = false;
  const resolveToken = async () => {
      const token = await secrets.getKey(TELEGRAM_PROVIDER_ID);
      if (token && !tokenLogged) {
        tokenLogged = true;
        const valid = /^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(token);
        logger.info(
          "telegram",
          `Bot token: ${token.length} chars, format ${valid ? "ok" : "INVALID"}, prefix "${token.slice(0, 5)}…"`,
        );
      }
      return token;
  };
  const api = new TelegramBotApi(
    createFetchTransport(resolveToken),
    createFetchFileDownloader(resolveToken),
    createFetchUploadTransport(resolveToken),
  );
  return createTelegramServiceCore({
    api,
    config: createTelegramConfig({
      getSettings: () => configStore.getSettings(),
      setSettings: (patch) => configStore.setSettings(patch),
      hasToken: () => secrets.hasKey(TELEGRAM_PROVIDER_ID),
      resolveRootDir: () => app.getPath("userData"),
    }),
    listWorkspaces: async () =>
      (await configStore.listWorkspaces())
        .filter(isTelegramFolderWorkspace)
        .map(({ id, name, folderPath }) => ({ id, name, folderPath: folderPath as string })),
    listModels: listTelegramModels,
    abortChat: (chatId) => llmClient.cancelChat(chatId),
    compactChat: (chatId) =>
      compactTelegramSession(
        {
          getChat: (id) => chatStore.get(id),
          openSession: (id) => piCompactionSessionStore.openChat(id),
          resolveProvider,
          resolveRuntime: resolveModelRuntime,
          resolveThinkingLevel: async () => (await configStore.getSettings()).telegramThinkingLevel,
        },
        chatId,
      ),
    transcribeAudio: transcribe,
    listPromptCommands: async (workspaceId) => {
      if (!workspaceId) return [];
      const snapshot = await skillRegistry.snapshot(workspaceId);
      const used = new Set<string>();
      return snapshot.available.flatMap((skill) => {
        const command = skill.name
          .toLowerCase()
          .replace(/[^a-z0-9_]+/gu, "_")
          .replace(/^_+|_+$/gu, "")
          .slice(0, 32);
        if (!command || !/^[a-z]/u.test(command) || used.has(command)) return [];
        used.add(command);
        return [{
          command,
          description: (skill.description || `Run ${skill.name}`).replace(/\s+/gu, " ").slice(0, 256),
          expand: (argument: string) => formatSkillInvocation({
            name: skill.name,
            description: skill.description,
            content: skill.instructions,
            filePath: skill.path ?? "/Aiden/Configured Skills/SKILL.md",
          }, argument),
        }];
      });
    },
    readOutboundAttachment: async (workspaceId, requestedPath) => {
      if (!workspaceId) throw new Error("Choose a folder workspace before attaching local files.");
      const workspace = await configStore.getWorkspace(workspaceId);
      if (!isTelegramFolderWorkspace(workspace)) throw new Error("The selected workspace is unavailable.");
      const folderPath = workspace?.folderPath;
      if (!folderPath) throw new Error("The selected workspace has no folder.");
      const root = await realpath(folderPath);
      const candidate = path.isAbsolute(requestedPath)
        ? requestedPath
        : path.resolve(root, requestedPath);
      const resolved = await realpath(candidate);
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Attachments must stay inside the selected workspace.");
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile()) throw new Error("The attachment is not a regular file.");
      if (metadata.size > 50 * 1024 * 1024) throw new Error("Telegram documents are limited to 50 MB.");
      const extension = path.extname(resolved).toLowerCase();
      const mimeType = ({
        ".pdf": "application/pdf",
        ".json": "application/json",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".zip": "application/zip",
      } as Record<string, string>)[extension] ?? "application/octet-stream";
      return { bytes: await readFile(resolved), name: path.basename(resolved), mimeType };
    },
    turn: {
      llmClient,
      chatStore,
      resolveProvider,
      resolveThinkingLevel: async () => (await configStore.getSettings()).telegramThinkingLevel,
      resolveWorkspace,
      broadcastMetadata,
    },
    getToken: () => secrets.getKey(TELEGRAM_PROVIDER_ID),
    now: () => Date.now(),
    sleep,
    warn: (message) => logger.warn("telegram", message),
    error: (message, cause) => logger.error("telegram", message, cause),
    info: (message) => logger.info("telegram", message),
  });
}

export const telegramService = createTelegramService();
