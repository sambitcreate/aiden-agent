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
import { secrets } from "../secrets.js";
import type { Provider, StoredProvider } from "../types.js";
import {
  createFetchFileDownloader,
  createFetchTransport,
  createFetchUploadTransport,
  TelegramBotApi,
  TelegramApiError,
} from "./telegram-bot-api.js";
import { createTelegramConfig } from "./telegram-config.js";
import { isTelegramFolderWorkspace } from "./telegram-workspace-core.js";
import type { TelegramWorkspaceResolution } from "./telegram-turn.js";
import { createTelegramServiceCore } from "./telegram-service-core.js";
import { contextLifecycleService } from "../context-lifecycle-service-main.js";
import { createTelegramLifecycleAdapter } from "../context-lifecycle-adapters.js";
import { transcribe } from "../transcription.js";
import { skillRegistry } from "../skill-registry-main.js";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TelegramModelChoice } from "./telegram-controls.js";
import {
  TELEGRAM_COMMANDS,
  visibleTelegramModelChoices,
} from "./telegram-controls.js";
import { getTelegramExtensions } from "./telegram-extension-registry.js";
import {
  DEFAULT_TELEGRAM_PROFILE,
  listTelegramProfileNames,
  normalizeTelegramProfileName,
  projectTelegramProfile,
  telegramProfileFromSettings,
  telegramProfilePatch,
  telegramProfileRuntimeFile,
  telegramProfileTokenKey,
  telegramBotNoticeAudienceId,
} from "./telegram-profile-config.js";
import { createTelegramThreadStore } from "./telegram-thread-store.js";
import { createTelegramOwnershipLease } from "./telegram-ownership.js";
import {
  chunkForTelegram,
  chunkRichMarkdown,
  markdownToTelegramHtml,
} from "./telegram-markdown.js";
import { registerTelegramDirectRuntime } from "./telegram-direct-runtime.js";
import { firstVisibleModelForProvider } from "../../../renderer/shared/model-visibility.js";
import { canUseGeminiChatModel } from "../../../renderer/shared/gemini-usage-scope.js";
import { botStore } from "../bot-store.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botManagedWorkspace } from "../bot-capability-services-main.js";
import { resolveBotInboundAttachmentHome } from "../bot-inbound-attachment-home.js";
import { preflightBotTurnAuthority } from "../bot-runtime-authority-main.js";
import { writeBotInboundAttachment } from "../bot-inbound-attachment-inbox.js";
import {
  telegramBotBindingAuthority,
  telegramBotBindings,
} from "./telegram-bot-bindings.js";
import { createTelegramBotBindingValidator } from "./telegram-bot-binding-validation.js";
import { telegramProfileMutationFence } from "./telegram-profile-mutation-fence.js";
export const TELEGRAM_PROVIDER_ID = "telegram";

let profileSettingsMutation = Promise.resolve();

async function getProfileSettings(profile: string) {
  return projectTelegramProfile(await configStore.getSettings(), profile);
}

async function revokeTelegramBotNoticeForCurrentOwner(
  profile: string,
): Promise<void> {
  const ownerUserId = (await getProfileSettings(profile)).telegramAllowedUserId;
  if (ownerUserId === undefined) return;
  await botApplicationService.revokeNoticeAudience(
    telegramBotNoticeAudienceId(profile, ownerUserId),
  );
}

const validateTelegramBotBinding = createTelegramBotBindingValidator({
  getBot: (botId) => botStore.get(botId),
  getProfileOwnerUserId: async (profile) =>
    (await getProfileSettings(profile)).telegramAllowedUserId,
  getActiveBinding: (botId) => telegramBotBindings.get(botId),
  resolveManagedWorkspace: (botId) =>
    botApplicationService.resolveManagedWorkspace(botId),
  getChatAccess: (chatId) => botApplicationService.getChatAccess(chatId),
});

async function setProfileSettings(
  profile: string,
  patch: Partial<import("../types.js").AppSettings>,
) {
  let result: import("../types.js").AppSettings | undefined;
  const operation = profileSettingsMutation.then(async () => {
    const current = await configStore.getSettings();
    result = projectTelegramProfile(
      await configStore.setSettings(
        telegramProfilePatch(current, profile, patch),
      ),
      profile,
    );
  });
  profileSettingsMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  return result!;
}

async function resolveProvider(
  profile = DEFAULT_TELEGRAM_PROFILE,
  requestedProviderId?: string,
  requestedModel?: string,
): Promise<{
  providerId: string;
  model: string;
  provider: StoredProvider;
} | null> {
  const settings = await getProfileSettings(profile);
  // Prefer Telegram-specific provider/model, fall back to the global default.
  if ((requestedProviderId === undefined) !== (requestedModel === undefined)) {
    return null;
  }
  const providerId = requestedProviderId ?? settings.telegramProviderId ?? settings.lastProviderId;
  if (!providerId) return null;
  const provider =
    (await providerRegistry.selectionProvider(providerId)) ??
    (await configStore.getProvider(providerId));
  if (!provider) return null;
  if (!canUseGeminiChatModel(settings.geminiUsageScope, providerId)) return null;
  const model =
    requestedModel ?? settings.telegramModel ??
    firstVisibleModelForProvider(
      settings.hiddenModelsByProvider,
      providerId,
      provider.models,
      [
        settings.lastProviderId === providerId ? settings.lastModel : undefined,
        provider.defaultModel,
      ],
    );
  if (!model) return null;
  return { providerId, model, provider };
}

async function resolveWorkspace(
  workspaceId?: string,
): Promise<TelegramWorkspaceResolution> {
  if (!workspaceId) return { kind: "assistant" };
  const workspace = await configStore.getWorkspace(workspaceId);

  if (!workspace || !isTelegramFolderWorkspace(workspace)) {
    return { kind: "stale" };
  }
  return { kind: "project", workspaceId: workspace.id };
}

async function listTelegramModels(): Promise<readonly TelegramModelChoice[]> {
  const [builtin, custom, codex, settings] = await Promise.all([
    providerRegistry.listBuiltinProviders(),
    listProvidersWithLegacyPiCredentialMigration(),
    providerRegistry.codex.snapshot().catch(() => null),
    configStore.getSettings(),
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
        codex.models.map((model) => [
          model.id,
          {
            source: "provider" as const,
            name: model.name,
            type: "llm" as const,
            vision: model.vision,
            reasoning: model.reasoning,
            thinkingLevels: model.thinkingLevels,
            contextLength: model.contextWindow,
          },
        ]),
      ),
      defaultModel: codex.models[0]?.id,
      needsKey: true,
      hasKey: true,
      isBuiltin: true,
    });
  }
  const models = [...byId.values()].flatMap((provider) =>
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
  return visibleTelegramModelChoices(models, settings.hiddenModelsByProvider);
}

async function readWorkspaceAttachment(
  workspaceId: string | undefined,
  requestedPath: string,
) {
  if (!workspaceId)
    throw new Error("Choose a folder workspace before attaching local files.");
  const workspace = await configStore.getWorkspace(workspaceId);
  if (!isTelegramFolderWorkspace(workspace) || !workspace.folderPath)
    throw new Error("The selected workspace is unavailable.");
  const folderPath = workspace.folderPath;
  const root = await realpath(folderPath);
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(root, requestedPath);
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Attachments must stay inside the selected workspace.");
  const metadata = await stat(resolved);
  if (!metadata.isFile())
    throw new Error("The attachment is not a regular file.");
  if (metadata.size > 50 * 1024 * 1024)
    throw new Error("Telegram documents are limited to 50 MB.");
  const extension = path.extname(resolved).toLowerCase();
  const mimeType =
    (
      {
        ".pdf": "application/pdf",
        ".json": "application/json",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".zip": "application/zip",
        ".csv": "text/csv",
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream";
  return {
    bytes: await readFile(resolved),
    name: path.basename(resolved),
    mimeType,
  };
}

function validateVoiceResult(
  voice: import("./telegram-extension-registry.js").TelegramVoiceSynthesisResult,
) {
  if (!(voice.bytes instanceof Uint8Array) || voice.bytes.byteLength === 0) {
    throw new Error(
      "Telegram voice providers must return non-empty audio bytes.",
    );
  }
  if (voice.bytes.byteLength > 20 * 1024 * 1024) {
    throw new Error("Telegram voice messages are limited to 20 MB.");
  }
  const name = voice.name ?? "aiden-voice.ogg";
  if (
    !/\.(?:ogg|opus)$/iu.test(name) ||
    (voice.mimeType !== undefined &&
      voice.mimeType !== "audio/ogg" &&
      voice.mimeType !== "audio/opus")
  ) {
    throw new Error(
      "Telegram-native voice providers must return OGG/Opus audio.",
    );
  }
  return { ...voice, name };
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

export function createTelegramService(profileName = DEFAULT_TELEGRAM_PROFILE) {
  const profile = normalizeTelegramProfileName(profileName);
  const lifecycle = createTelegramLifecycleAdapter(contextLifecycleService, profile);
  const tokenKey = telegramProfileTokenKey(profile);
  const resolveToken = () => secrets.getKey(tokenKey);
  const api = new TelegramBotApi(
    createFetchTransport(resolveToken),
    createFetchFileDownloader(resolveToken),
    createFetchUploadTransport(resolveToken),
  );
  const threadStore = createTelegramThreadStore({
    root: () => app.getPath("userData"),
    profile,
  });
  const ownership = createTelegramOwnershipLease({
    root: () => app.getPath("userData"),
    profile,
  });
  let threadProvisioning = Promise.resolve();
  const core = createTelegramServiceCore({
    profile,
    assertBotBindingStoreHealthy: () => telegramBotBindings.assertHealthy(),
    resolveBotBinding: async ({
      profile: bindingProfile,
      chatId,
      threadId,
    }) => {
      if (bindingProfile !== profile) return undefined;
      const binding = await telegramBotBindings.resolve(
        profile,
        chatId,
        threadId,
      );
      if (!binding) return undefined;
      // Return the exact stored record and let service-core reject owner
      // mismatches. Treating a mismatched record as "unbound" would silently
      // fall back to the profile's ordinary Aiden conversation.
      return binding;
    },
    validateBotBinding: validateTelegramBotBinding,
    api,
    acquireOwnership: ownership.acquire,
    releaseOwnership: ownership.release,
    config: createTelegramConfig({
      getSettings: () => getProfileSettings(profile),
      setSettings: (patch) => setProfileSettings(profile, patch),
      hasToken: () => secrets.hasKey(tokenKey),
      resolveRootDir: () => app.getPath("userData"),
      runtimeFileName: telegramProfileRuntimeFile(profile),
    }),
    listWorkspaces: async () =>
      (await configStore.listWorkspaces())
        .filter(isTelegramFolderWorkspace)
        .map(({ id, name, folderPath }) => ({
          id,
          name,
          folderPath: folderPath as string,
        })),
    resolveThreadWorkspace: async (threadId) =>
      (await threadStore.find(threadId))?.workspaceId,
    ensureThreadTargets: (chatId) => {
      const operation = threadProvisioning.then(async () => {
        const settings = await getProfileSettings(profile);
        if (!settings.telegramThreadedMode) return;
        const workspaces = (await configStore.listWorkspaces()).filter(
          isTelegramFolderWorkspace,
        );
        const removed = await threadStore.retainWorkspaces(
          new Set(workspaces.map(({ id }) => id)),
          chatId,
        );
        for (const target of removed) {
          await api
            .deleteForumTopic(target.chatId, target.threadId)
            .catch((cause) => {
              logger.warn(
                "telegram",
                `[${profile}] Could not remove stale Telegram thread ${target.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            });
        }
        for (const workspace of workspaces) {
          if (await threadStore.findWorkspace(workspace.id)) continue;
          const topic = await api.createForumTopic(
            chatId,
            `Aiden · ${workspace.name}`.slice(0, 128),
          );
          await threadStore.upsert({
            threadId: topic.message_thread_id,
            chatId,
            name: workspace.name,
            workspaceId: workspace.id,
            createdAt: Date.now(),
          });
          await api.sendMessage({
            chatId,
            threadId: topic.message_thread_id,
            text: `🗂 This thread routes to the Aiden workspace “${workspace.name}”.`,
          });
        }
      });
      threadProvisioning = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    clearThreadTargets: async () => {
      const targets = await threadStore.list();
      for (const target of targets) {
        await api
          .deleteForumTopic(target.chatId, target.threadId)
          .catch((cause) => {
            logger.warn(
              "telegram",
              `[${profile}] Could not remove Telegram thread ${target.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          });
      }
      await threadStore.clear();
    },
    listModels: listTelegramModels,
    abortChat: async (chatId) => {
      lifecycle.cancelChat(chatId);
      await llmClient.cancelChat(chatId);
    },
    compactChat: lifecycle.compactChat,
    transcribeAudio: transcribe,
    storeInboundFile: async ({ bytes, name, workspaceId, botId }) => {
      const botHome = await resolveBotInboundAttachmentHome({
        botId,
        workspaceId,
        resolveManagedWorkspace: (id) =>
          botApplicationService.resolveManagedWorkspace(id),
        revalidateManagedWorkspace: (expected) =>
          botManagedWorkspace.revalidate(expected),
        canonicalize: realpath,
      });
      // Bot routes must never fall through to either a regular Workspace or
      // the global inbox. The resolver above throws for every Bot mismatch.
      const workspace = !botId && workspaceId
        ? await configStore.getWorkspace(workspaceId)
        : undefined;
      const workspaceRoot = botHome?.homePath ?? (
        isTelegramFolderWorkspace(workspace) && workspace.folderPath
          ? await realpath(workspace.folderPath)
          : undefined
      );
      const root = workspaceRoot
        ? path.join(workspaceRoot, ".aiden", "telegram-inbox", profile)
        : path.join(app.getPath("userData"), "telegram-inbox", profile);
      if (botHome) {
        const safeName =
          path
            .basename(name)
            .replace(/[^A-Za-z0-9._-]+/gu, "_")
            .slice(-120) || "telegram-file";
        const leaf = `${randomUUID()}-${safeName}`;
        return writeBotInboundAttachment({
          home: botHome,
          profile,
          leaf,
          bytes,
        });
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
      for (const entry of await readdir(root, { withFileTypes: true }).catch(
        () => [],
      )) {
        if (!entry.isFile()) continue;
        const candidate = path.join(root, entry.name);
        const metadata = await stat(candidate).catch(() => undefined);
        if (metadata && metadata.mtimeMs < cutoff)
          await unlink(candidate).catch(() => undefined);
      }
      const safeName =
        path
          .basename(name)
          .replace(/[^A-Za-z0-9._-]+/gu, "_")
          .slice(-120) || "telegram-file";
      const destination = path.join(root, `${randomUUID()}-${safeName}`);
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      return destination;
    },
    synthesizeVoice: async (text, options) => {
      for (const extension of getTelegramExtensions()) {
        if (!extension.synthesizeVoice) continue;
        try {
          const result = await extension.synthesizeVoice(text, {
            lang: options.lang,
            rate: options.rate,
            context: {
              profile,
              chatId: options.chatId,
              threadId: options.threadId,
              ownerUserId: options.ownerUserId,
              workspaceId: options.workspaceId,
            },
          });
          if (result) return validateVoiceResult(result);
        } catch (cause) {
          logger.warn(
            "telegram",
            `[${profile}] Voice provider ${extension.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      return undefined;
    },
    extensionStatus: async () => {
      const rows: string[] = [];
      const sections: Array<{ label: string; callbackData: string }> = [];
      for (const extension of getTelegramExtensions()) {
        if (extension.statusRows) rows.push(...(await extension.statusRows()));
        for (const section of extension.sections ?? []) {
          sections.push({
            label: section.label,
            callbackData: section.callbackData,
          });
        }
      }
      return { rows, sections };
    },
    handleExtensionCallback: async (data, context) => {
      const match = /^ext:([a-z][a-z0-9_-]{0,31}):/u.exec(data);
      const extension = match
        ? getTelegramExtensions().find(({ id }) => id === match[1])
        : undefined;
      if (!extension?.handleCallback)
        throw new Error("This extension control is no longer available.");
      return extension.handleCallback(data, { profile, ...context });
    },
    handleExtensionUpdate: async (update, context) => {
      for (const extension of getTelegramExtensions()) {
        if (
          extension.handleUpdate &&
          (await extension.handleUpdate(update, { profile, ...context }))
        ) {
          return true;
        }
      }
      return false;
    },
    transformInbound: async (content, message, context) => {
      let transformed = content;
      for (const extension of getTelegramExtensions()) {
        if (extension.transformInbound) {
          transformed = await extension.transformInbound(transformed, message, {
            profile,
            ...context,
          });
        }
      }
      return transformed;
    },
    transformOutbound: async (markdown, context) => {
      let transformed = markdown;
      for (const extension of getTelegramExtensions()) {
        if (extension.transformOutbound) {
          transformed = await extension.transformOutbound(transformed, {
            profile,
            ...context,
          });
        }
      }
      return transformed;
    },
    listPromptCommands: async (workspaceId) => {
      const used = new Set<string>(
        TELEGRAM_COMMANDS.map(({ command }) => command),
      );
      const extensionCommands = getTelegramExtensions().flatMap((extension) =>
        (extension.commands ?? []).flatMap((command) => {
          if (used.has(command.name)) return [];
          used.add(command.name);
          return [
            {
              command: command.name,
              description: command.description
                .replace(/\s+/gu, " ")
                .slice(0, 256),
              handle: (
                argument: string,
                message: Parameters<typeof command.handler>[0]["message"],
                context: Omit<
                  Parameters<typeof command.handler>[0]["context"],
                  "profile"
                >,
              ) =>
                command.handler({
                  argument,
                  message,
                  context: { profile, ...context },
                }),
            },
          ];
        }),
      );
      if (!workspaceId) return extensionCommands;
      const snapshot = await skillRegistry.snapshot(workspaceId);
      const skillCommands = snapshot.available.flatMap((skill) => {
        const command = skill.name
          .toLowerCase()
          .replace(/[^a-z0-9_]+/gu, "_")
          .replace(/^_+|_+$/gu, "")
          .slice(0, 32);
        if (!command || !/^[a-z]/u.test(command) || used.has(command))
          return [];
        used.add(command);
        return [
          {
            command,
            description: (skill.description || `Run ${skill.name}`)
              .replace(/\s+/gu, " ")
              .slice(0, 256),
            expand: (argument: string) =>
              formatSkillInvocation(
                {
                  name: skill.name,
                  description: skill.description,
                  content: skill.instructions,
                  filePath: skill.path ?? "/Aiden/Configured Skills/SKILL.md",
                },
                argument,
              ),
          },
        ];
      });
      return [...extensionCommands, ...skillCommands];
    },
    readOutboundAttachment: readWorkspaceAttachment,
    applyModelSelection: async (choice) => {
      await setProfileSettings(profile, {
        telegramProviderId: choice.providerId,
        telegramModel: choice.model,
        lastProviderId: choice.providerId,
        lastModel: choice.model,
        telegramThinkingLevel: choice.reasoning ? undefined : "off",
      });
      await configStore.setSettings({
        lastProviderId: choice.providerId,
        lastModel: choice.model,
      });
      ipcMain.broadcast("telegram:model-selection-changed", {
        providerId: choice.providerId,
        model: choice.model,
      });
    },
    turn: {
      llmClient,
      chatStore,
      resolveProvider: (providerId, model) => resolveProvider(profile, providerId, model),
      resolveThinkingLevel: async () =>
        (await getProfileSettings(profile)).telegramThinkingLevel,
      resolveWorkspace,
      preflightBotTurnAuthority,
      broadcastMetadata,
    },
    getToken: () => secrets.getKey(tokenKey),
    now: () => Date.now(),
    sleep,
    warn: (message) => logger.warn("telegram", `[${profile}] ${message}`),
    error: (message, cause) =>
      logger.error("telegram", `[${profile}] ${message}`, cause),
    info: (message) => logger.info("telegram", `[${profile}] ${message}`),
  });

  async function resolveDirectTarget(thread?: string | number) {
    const settings = await getProfileSettings(profile);
    const chatId = settings.telegramAllowedUserId;
    if (chatId === undefined)
      throw new Error(`Telegram profile ${profile} is not paired.`);
    if (thread === undefined)
      return { chatId, workspaceId: settings.telegramWorkspaceId };
    const targets = await threadStore.list();
    const target =
      typeof thread === "number"
        ? targets.find((candidate) => candidate.threadId === thread)
        : targets.find(
            (candidate) =>
              candidate.name.toLowerCase() === thread.trim().toLowerCase(),
          );
    if (!target || target.chatId !== chatId)
      throw new Error(`Unknown live Telegram thread target: ${String(thread)}`);
    return {
      chatId,
      threadId: target.threadId,
      workspaceId: target.workspaceId,
      name: target.name,
    };
  }

  return Object.assign(core, {
    profile,
    listTargets: () => threadStore.list(),
    async sendDirectMessage(input: { text: string; thread?: string | number }) {
      const target = await resolveDirectTarget(input.thread);
      const settings = await getProfileSettings(profile);
      if ((settings.telegramRendering ?? "rich") === "rich") {
        const sent = [];
        const richChunks = chunkRichMarkdown(input.text);
        for (let index = 0; index < richChunks.length; index += 1) {
          try {
            sent.push(
              await api.sendRichMessage({
                chatId: target.chatId,
                threadId: target.threadId,
                markdown: richChunks[index]!,
              }),
            );
          } catch (cause) {
            if (!(cause instanceof TelegramApiError) || cause.code !== 400)
              throw cause;
            for (const text of chunkForTelegram(
              markdownToTelegramHtml(richChunks.slice(index).join("\n\n")),
            )) {
              sent.push(
                await api.sendMessage({
                  chatId: target.chatId,
                  threadId: target.threadId,
                  text,
                  parseMode: "HTML",
                  disablePreview: true,
                }),
              );
            }
            break;
          }
        }
        return sent;
      }
      const sent = [];
      for (const text of chunkForTelegram(markdownToTelegramHtml(input.text))) {
        sent.push(
          await api.sendMessage({
            chatId: target.chatId,
            threadId: target.threadId,
            text,
            parseMode: "HTML",
            disablePreview: true,
          }),
        );
      }
      return sent;
    },
    async sendDirectAttachment(input: {
      path: string;
      caption?: string;
      thread?: string | number;
    }) {
      const target = await resolveDirectTarget(input.thread);
      const file = await readWorkspaceAttachment(
        target.workspaceId,
        input.path,
      );
      return api.sendDocument({
        chatId: target.chatId,
        threadId: target.threadId,
        ...file,
        caption: input.caption,
      });
    },
    async sendDirectVoice(input: {
      text: string;
      lang?: string;
      rate?: string;
      thread?: string | number;
    }) {
      const target = await resolveDirectTarget(input.thread);
      for (const extension of getTelegramExtensions()) {
        try {
          const voice = await extension.synthesizeVoice?.(input.text, {
            lang: input.lang,
            rate: input.rate,
            context: {
              profile,
              chatId: target.chatId,
              threadId: target.threadId,
              ownerUserId: target.chatId,
              workspaceId: target.workspaceId,
            },
          });
          if (voice)
            return api.sendVoice({
              chatId: target.chatId,
              threadId: target.threadId,
              ...validateVoiceResult(voice),
            });
        } catch (cause) {
          logger.warn(
            "telegram",
            `[${profile}] Voice provider ${extension.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      throw new Error("No Telegram voice synthesis provider is registered.");
    },
  });
}

type TelegramProfileService = ReturnType<typeof createTelegramService>;

export function createTelegramProfileManager() {
  const services = new Map<string, TelegramProfileService>();
  let activeProfile = DEFAULT_TELEGRAM_PROFILE;

  const serviceFor = (profile: string): TelegramProfileService => {
    const normalized = normalizeTelegramProfileName(profile);
    const existing = services.get(normalized);
    if (existing) return existing;
    const created = createTelegramService(normalized);
    services.set(normalized, created);
    return created;
  };

  async function refreshProfiles(): Promise<string[]> {
    const settings = await configStore.getSettings();
    const profiles = listTelegramProfileNames(settings);
    const requested = settings.telegramActiveProfile;
    activeProfile =
      requested && profiles.includes(requested)
        ? requested
        : DEFAULT_TELEGRAM_PROFILE;
    return profiles;
  }

  return {
    async start(): Promise<void> {
      await telegramBotBindings.assertHealthy();
      const profiles = await refreshProfiles();
      await Promise.all(profiles.map((profile) => serviceFor(profile).start()));
    },
    stop(): void {
      for (const service of services.values()) service.stop();
    },
    async stopAndSettle(): Promise<void> {
      await Promise.all(
        [...services.values()].map((service) => service.stopAndSettle()),
      );
    },
    getStatus() {
      return serviceFor(activeProfile).getStatus();
    },
    get queueSize() {
      return serviceFor(activeProfile).queueSize;
    },
    get isActive() {
      return serviceFor(activeProfile).isActive;
    },
    get activeProfile() {
      return activeProfile;
    },
    async listProfiles() {
      const settings = await configStore.getSettings();
      const profiles = listTelegramProfileNames(settings);
      return Promise.all(
        profiles.map(async (profile) => ({
          name: profile,
          settings: telegramProfileFromSettings(settings, profile),
          hasToken: await secrets.hasKey(telegramProfileTokenKey(profile)),
          status: serviceFor(profile).getStatus(),
        })),
      );
    },
    async selectProfile(value: string): Promise<string> {
      const profile = normalizeTelegramProfileName(value);
      const profiles = await refreshProfiles();
      if (!profiles.includes(profile))
        throw new Error(`Unknown Telegram profile: ${profile}`);
      activeProfile = profile;
      await configStore.setSettings({ telegramActiveProfile: profile });
      return profile;
    },
    async createProfile(value: string): Promise<string> {
      const profile = normalizeTelegramProfileName(value);
      const settings = await configStore.getSettings();
      if (listTelegramProfileNames(settings).includes(profile))
        throw new Error(`Telegram profile already exists: ${profile}`);
      if (Object.keys(settings.telegramProfiles ?? {}).length >= 16) {
        throw new Error("Aiden supports up to 16 named Telegram profiles.");
      }
      await configStore.setSettings({
        telegramProfiles: {
          ...(settings.telegramProfiles ?? {}),
          [profile]: {},
        },
        telegramActiveProfile: profile,
      });
      activeProfile = profile;
      serviceFor(profile);
      return profile;
    },
    async deleteProfile(value: string): Promise<void> {
      const profile = normalizeTelegramProfileName(value);
      if (profile === DEFAULT_TELEGRAM_PROFILE)
        throw new Error("The default Telegram profile cannot be deleted.");
      await telegramProfileMutationFence.runDestructive(profile, async () => {
        const service = services.get(profile);
        await service?.stopAndSettle();
        await telegramBotBindingAuthority.disableProfile(profile);
        await revokeTelegramBotNoticeForCurrentOwner(profile);
        await service?.resetPairing();
        services.delete(profile);
        await secrets.deleteKey(telegramProfileTokenKey(profile));
        const settings = await configStore.getSettings();
        const profiles = { ...(settings.telegramProfiles ?? {}) };
        delete profiles[profile];
        activeProfile = DEFAULT_TELEGRAM_PROFILE;
        await configStore.setSettings({
          telegramProfiles: profiles,
          telegramActiveProfile: activeProfile,
        });
      });
    },
    async getActiveSettings() {
      await refreshProfiles();
      return getProfileSettings(activeProfile);
    },
    async setActiveSettings(patch: Partial<import("../types.js").AppSettings>) {
      return setProfileSettings(activeProfile, patch);
    },
    async hasActiveToken(): Promise<boolean> {
      return secrets.hasKey(telegramProfileTokenKey(activeProfile));
    },
    async setActiveToken(token: string): Promise<void> {
      const key = telegramProfileTokenKey(activeProfile);
      if (token) await secrets.setKey(key, token);
      else await secrets.deleteKey(key);
    },
    async setEnabled(enabled: boolean): Promise<void> {
      await setProfileSettings(activeProfile, { telegramEnabled: enabled });
      if (enabled) {
        await telegramBotBindings.assertHealthy();
        await serviceFor(activeProfile).start();
      } else {
        serviceFor(activeProfile).stop();
      }
    },
    connect: () => serviceFor(activeProfile).connect(),
    disconnect: () => serviceFor(activeProfile).disconnect(),
    resetPairing: async () => {
      const profile = activeProfile;
      await telegramProfileMutationFence.runDestructive(profile, async () => {
        await telegramBotBindingAuthority.disableProfile(profile);
        await revokeTelegramBotNoticeForCurrentOwner(profile);
        await serviceFor(profile).resetPairing();
      });
    },
    ensureActiveThreads: () => serviceFor(activeProfile).ensureThreads(),
    clearActiveThreads: () => serviceFor(activeProfile).clearThreads(),
    async listTargets(profileName?: string) {
      const targetProfile = profileName
        ? normalizeTelegramProfileName(profileName)
        : activeProfile;
      return serviceFor(targetProfile).listTargets();
    },
    async sendDirectMessage(input: {
      profile?: string;
      thread?: string | number;
      text: string;
    }) {
      const targetProfile = input.profile
        ? normalizeTelegramProfileName(input.profile)
        : activeProfile;
      return serviceFor(targetProfile).sendDirectMessage(input);
    },
    async sendDirectAttachment(input: {
      profile?: string;
      thread?: string | number;
      path: string;
      caption?: string;
    }) {
      const targetProfile = input.profile
        ? normalizeTelegramProfileName(input.profile)
        : activeProfile;
      return serviceFor(targetProfile).sendDirectAttachment(input);
    },
    async sendDirectVoice(input: {
      profile?: string;
      thread?: string | number;
      text: string;
      lang?: string;
      rate?: string;
    }) {
      const targetProfile = input.profile
        ? normalizeTelegramProfileName(input.profile)
        : activeProfile;
      return serviceFor(targetProfile).sendDirectVoice(input);
    },
  };
}

export const telegramService = createTelegramProfileManager();
registerTelegramDirectRuntime(telegramService);
