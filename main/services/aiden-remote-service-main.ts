import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, logger } from "../platform.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import { recordRemoteRequestHealth } from "./diagnostic-health.js";
import { AidenRemoteApprovedRootService } from "./aiden-remote-approved-roots.js";
import { DataStore } from "./data-store.js";
import {
  AidenRemoteService,
  DnsSdAidenRemoteBonjourPublisher,
  type AidenRemoteServiceLogEntry,
} from "./aiden-remote-service.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  defaultAidenRemoteDisplayName,
  normalizeAidenRemoteStateForRuntimeProfile,
  parseAidenRemoteStateDocument,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import {
  aidenRemoteDefaultLanPort,
  aidenRemotePortCandidatesForProfile,
  isAidenRemoteReservedLanPort,
} from "./aiden-remote-ports.js";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
} from "./aiden-remote-tailscale.js";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import { AidenRemoteMemorySettingsService } from "./aiden-remote-memory-settings.js";
import { workspaceApplicationService } from "./workspace-application-service-main.js";
import {
  AidenIdempotencyLedger,
  MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import {
  AidenRemoteChatService,
  type AidenRemoteRetainedBotChatAuthorizationRequest,
} from "./aiden-remote-chats.js";
import { AidenRemoteModelService } from "./aiden-remote-models.js";
import {
  AidenRemoteStreamService,
  MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES,
  normalizeAidenRemoteStreamSnapshot,
  removeRevokedDeviceStreams,
  type AidenRemotePendingApproval,
  type AidenRemoteStreamSnapshot,
} from "./aiden-remote-streams.js";
import { revokeAidenRemoteRuntimeDevice } from "./aiden-remote-revocation.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import { startGenerationAndMaybeTitle } from "./chat-generation-start.js";
import { chatStore } from "./chat-store.js";
import { chatActivityRegistry } from "./chat-activity.js";
import { chatTitleService } from "./chat-title.js";
import { designProjectStore } from "./design-project-store-main.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import { AidenRemoteFileService } from "./aiden-remote-files.js";
import { AidenRemoteBotFileService } from "./aiden-remote-bot-files.js";
import { createBotArchivedFileReadAuthority } from "./bot-archived-file-read-authority.js";
import { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import { workspaceEnvironmentApplicationService } from "./workspace-environment-application-service-main.js";
import { workspaceWorktreeApplicationService } from "./workspace-worktree-application-service-main.js";
import { AidenRemoteGitService } from "./aiden-remote-git.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCompare,
  gitComparisonDiff,
  gitCreateBranch,
  gitDiff,
  gitPush,
  gitPushCapability,
  gitReview,
  gitWorktrees,
} from "./git.js";
import { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import { usageStore } from "./usage-store.js";
import { AidenRemoteSpeechService } from "./aiden-remote-speech.js";
import { scheduledTaskApplicationService } from "./scheduled-task-application-service-main.js";
import { botStore } from "./bot-store.js";
import { botMutationGate } from "./bot-mutation-gate.js";
import { botApplicationService } from "./bot-application-service-main.js";
import {
  botRuntimeAuthority,
  preflightBotTurnAuthority,
} from "./bot-runtime-authority-main.js";
import {
  AidenRemoteBotService,
} from "./aiden-remote-bots.js";
import {
  botCapabilityCatalog,
  botCapabilityStore,
  botManagedWorkspace,
} from "./bot-capability-services-main.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  createBotInboxProjectionService,
  mergeBotInboxActivityPreviews,
} from "./bot-inbox-projection.js";
import { createMainBotAvatarApplicationAdapter } from "./bot-avatar-store-main.js";
import { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";
import {
  botFavoritesStore,
  withBotFavoritesMutation,
} from "./bot-favorites-main.js";

const STATE_FILE = "aiden-remote-v1.json";
const OPERATIONS_FILE = "aiden-remote-operations-v1.json";
const STREAMS_FILE = "aiden-remote-streams-v1.json";
const MAX_STATE_BYTES = 512 * 1_024;
const execFileAsync = promisify(execFile);

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  limit: number,
  project: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await project(values[index]!);
    }
  }));
  return output;
}

async function macComputerName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/scutil",
      ["--get", "ComputerName"],
      { timeout: 1_000, maxBuffer: 4_096, encoding: "utf8" },
    );
    return stdout;
  } catch {
    return os.hostname();
  }
}

function normalizeIdempotency(value: unknown): AidenIdempotencySnapshot {
  return new AidenIdempotencyLedger(value as AidenIdempotencySnapshot).snapshot();
}

function safeIdempotency(value: unknown): boolean {
  try {
    normalizeIdempotency(value);
    return true;
  } catch {
    return false;
  }
}

function remoteRouteCategory(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  if (value === "health") return "health";
  if (value.startsWith("pairing")) return "pairing";
  if (value.startsWith("bot")) return value === "botFiles" ? "files" : "bots";
  if (value.toLowerCase().includes("workspace")) return "workspaces";
  if (value.toLowerCase().includes("file") || value.toLowerCase().includes("attachment")) return "files";
  if (value.toLowerCase().includes("git")) return "git";
  if (value.toLowerCase().includes("schedule")) return "schedules";
  if (value.toLowerCase().includes("usage")) return "usage";
  if (value.toLowerCase().includes("speech")) return "speech";
  if (/chat|turn|stream|approval|model/iu.test(value)) return "chats";
  return "unknown";
}

function writeRemoteLog(entry: AidenRemoteServiceLogEntry): void {
  const details = entry.details ?? {};
  if (entry.event === "request") {
    const status = typeof details.status === "number" ? details.status : 0;
    const latencyMs = typeof details.latencyMs === "number" ? Math.max(0, details.latencyMs) : 0;
    recordRemoteRequestHealth(status, latencyMs);
    const profile = currentRuntimeProfile();
    if (profile.id === "production") {
      if (status >= 400 || latencyMs >= 2_000) {
        writeDiagnosticEvent({
          level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          area: "remote",
          event: status >= 400 ? "remote-request-failed" : "remote-request-slow",
          outcome: status >= 500 ? "failed" : "degraded",
          ...(status >= 500 ? { code: "internal-error" as const } : {}),
          fields: {
            routeCategory: remoteRouteCategory(details.route),
            statusClass: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx",
            latencyBucket: latencyMs >= 10_000 ? "10s-plus" : latencyMs >= 5_000 ? "5s-plus" : "2s-plus",
            remoteCode: typeof details.errorCode === "string" ? details.errorCode : null,
          },
        });
      }
      return;
    }
    const { deviceIdSuffix: _deviceIdSuffix, ...developmentDetails } = details;
    logger.info("aiden-remote", entry.event, developmentDetails);
    return;
  }
  if (entry.level === "error") logger.error("aiden-remote", entry.event, details);
  else if (entry.level === "warn") logger.warn("aiden-remote", entry.event, details);
  else logger.info("aiden-remote", entry.event, details);
}

async function authorizeRemoteRetainedBotChat(
  request: Readonly<AidenRemoteRetainedBotChatAuthorizationRequest>,
): Promise<boolean> {
  return botApplicationService.authorizeRetainedChat({
    audienceId: request.deviceId,
    botId: request.botId,
    chatId: request.chatId,
    access: request.access,
  });
}

export interface AidenRemoteRuntime {
  service: AidenRemoteService;
  state: AidenRemoteStateRegistry;
  approvedRoots: AidenRemoteApprovedRootService;
  revokeDevice(deviceId: string): Promise<boolean>;
  pendingApprovalForChat(chatId: string): AidenRemotePendingApproval | null;
  respondApprovalFromHost(
    chatId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): boolean;
}

let runtimePromise: Promise<AidenRemoteRuntime> | null = null;

async function createRuntime(): Promise<AidenRemoteRuntime> {
  const runtimeProfile = currentRuntimeProfile();
  const userData = app.getPath("userData");
  const hostname = os.hostname();
  const defaultDisplayName = defaultAidenRemoteDisplayName(await macComputerName());
  const store = new DataStore<AidenRemoteStateDocument>(
    STATE_FILE,
    createDefaultAidenRemoteState(
      undefined,
      defaultDisplayName,
      aidenRemoteDefaultLanPort(runtimeProfile.id),
    ),
    () => userData,
    {
      maxBytes: MAX_STATE_BYTES,
      fileMode: 0o600,
      normalize: (value) => normalizeAidenRemoteStateForRuntimeProfile(
        parseAidenRemoteStateDocument(value, defaultDisplayName),
        runtimeProfile.id,
      ),
      isSafe: (value) => {
        try {
          parseAidenRemoteStateDocument(value, defaultDisplayName);
          return true;
        } catch {
          return false;
        }
      },
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    },
  );
  const state = new AidenRemoteStateRegistry({
    load: () => store.load(),
    needsSaveAfterLoad: async () => {
      const contents = await store.loadedDiskContents();
      if (contents === null) return true;
      try {
        const raw = JSON.parse(contents.toString("utf8")) as unknown;
        return !raw || typeof raw !== "object" || Array.isArray(raw)
          || !("displayName" in raw) || !("lanPortCommitted" in raw)
          || (
            runtimeProfile.id === "development"
            && "lanPort" in raw
            && typeof raw.lanPort === "number"
            && isAidenRemoteReservedLanPort(raw.lanPort, "production")
            && !("tailscalePendingOutcome" in raw)
          );
      } catch {
        return false;
      }
    },
    save: async (document) => {
      await store.save(document);
      ipcMain.broadcast("remote:changed", {});
    },
  });
  const operationStore = new DataStore<AidenIdempotencySnapshot>(
    OPERATIONS_FILE,
    new AidenIdempotencyLedger().snapshot(),
    () => userData,
    {
      maxBytes: MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
      fileMode: 0o600,
      normalize: normalizeIdempotency,
      isSafe: safeIdempotency,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    },
  );
  const streamStore = new DataStore<AidenRemoteStreamSnapshot>(
    STREAMS_FILE,
    { version: 1, streams: [] },
    () => userData,
    {
      maxBytes: MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES,
      fileMode: 0o600,
      normalize: normalizeAidenRemoteStreamSnapshot,
      isSafe: (value) => {
        try {
          normalizeAidenRemoteStreamSnapshot(value);
          return true;
        } catch {
          return false;
        }
      },
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    },
  );
  const tailscale = new AidenRemoteTailscaleController(
    await createSystemTailscaleCommandRunner(),
    {
      onStatusReadFailure: ({ phase, attempt, final, category }) => {
        if (!final) return;
        writeDiagnosticEvent({
          level: "warn",
          area: "remote",
          event: "tailscale-status-read-unavailable",
          outcome: "unavailable",
          fields: {
            tailscalePhase: phase,
            failureCategory: category,
            attempts: attempt,
          },
        });
      },
      outcomeStore: {
        begin: (outcome) => state.beginTailscalePendingOutcome(outcome),
        snapshot: async () => (await state.snapshot()).tailscalePendingOutcome,
        commit: (ownership) => state.commitTailscaleOutcome(ownership),
        clear: () => state.clearTailscalePendingOutcome(),
      },
    },
  );
  let workspaceApi:
    | Promise<{
        instanceId: string;
        workspaces: AidenRemoteWorkspaceService;
        workspaceBrowser: AidenRemoteWorkspaceBrowserService;
        chats: AidenRemoteChatService;
        models: AidenRemoteModelService;
        streams: AidenRemoteStreamService;
        files: AidenRemoteFileService;
        botFiles: AidenRemoteBotFileService;
        git: AidenRemoteGitService;
        schedules: AidenRemoteScheduleService;
        memorySettings: AidenRemoteMemorySettingsService;
        usage: typeof usageStore;
        speech: AidenRemoteSpeechService;
        bots: AidenRemoteBotService;
        botNotice: {
          status: typeof botApplicationService.noticeStatus;
          acknowledge: typeof botApplicationService.acknowledgeNotice;
        };
      }>
    | undefined;
  let workspaceApiInstanceId: string | undefined;
  let activeStreams: AidenRemoteStreamService | undefined;
  let activeChats: AidenRemoteChatService | undefined;
  const workspaceOwners = new AidenRemoteWorkspaceOwnerRegistry();
  const service = new AidenRemoteService({
    state,
    appVersion: app.getVersion(),
    hostname,
    tailscale,
    portCandidates: (preferredPort) => aidenRemotePortCandidatesForProfile(
      runtimeProfile.id,
      preferredPort,
    ),
    bonjour: new DnsSdAidenRemoteBonjourPublisher(writeRemoteLog),
    notifyPairingChanged: () => ipcMain.broadcast("remote:changed", {}),
    workspaceApi: async (instanceId) => {
      if (!workspaceApi || workspaceApiInstanceId !== instanceId) {
        workspaceApiInstanceId = instanceId;
        workspaceApi = (async () => {
          const idempotency = new AidenIdempotencyLedger(
            await operationStore.load(),
          );
          await operationStore.save(idempotency.snapshot());
          const workspaceBrowser = new AidenRemoteWorkspaceBrowserService({
            instanceId,
            state,
          });
          const models = new AidenRemoteModelService({
            listProviders: listConfiguredProviders,
            getSettings: () => configStore.getSettings(),
          });
          const loadedStreamSnapshot = normalizeAidenRemoteStreamSnapshot(await streamStore.load());
          const revokedDeviceIds = new Set(
            (await state.snapshot()).devices
              .filter(({ revokedAt }) => revokedAt !== undefined)
              .map(({ id }) => id),
          );
          const streamSnapshot = removeRevokedDeviceStreams(
            loadedStreamSnapshot,
            revokedDeviceIds,
          );
          if (streamSnapshot.streams.length !== loadedStreamSnapshot.streams.length) {
            await streamStore.save(streamSnapshot);
          }
          const streams = new AidenRemoteStreamService({
            now: Date.now,
            cancel: (streamId, ownerDocumentId) =>
              llmClient.cancel(streamId, "user_stop", ownerDocumentId),
            approve: (approvalId, decision, ownerDocumentId) =>
              llmClient.approve(approvalId, decision, ownerDocumentId),
            notifyChatChanged: () => ipcMain.broadcast("chats:changed", {}),
            notifyApprovalChanged: (chatId) =>
              ipcMain.broadcast("remote:approval-changed", { chatId }),
            snapshot: streamSnapshot,
            persist: (snapshot) => streamStore.save(snapshot),
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
            onPersistenceError: (error) =>
              logger.error("aiden-remote", "Could not persist the remote stream journal.", error),
          });
          activeStreams = streams;
          const chats = new AidenRemoteChatService({
            application: chatApplicationService,
            chatStore,
            generation: {
              beginChatTurn: (chatId, turnId, ownerId) =>
                llmClient.beginChatTurn(chatId, turnId, ownerId),
              start: (streamId, params, owner, options) =>
                startGenerationAndMaybeTitle(
                  {
                    start: (id, input) => llmClient.start(id, input, owner, options),
                    startTitle: (input) => chatTitleService.startForFirstTurn(input),
                  },
                  streamId,
                  params,
                ),
            },
            streams,
            models,
            bots: botStore,
            botMutations: botMutationGate,
            retainedBotChatAuthorizer: authorizeRemoteRetainedBotChat,
            botTurnAuthorityPreflight: preflightBotTurnAuthority,
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
            notifyChanged: () => ipcMain.broadcast("chats:changed", {}),
            isTitlePending: (chatId) => chatTitleService.isFirstTurnPending(chatId),
            activeChatIds: () => chatActivityRegistry.snapshot().activeChatIds,
            isDesignProjectChat: async (chatId) =>
              (await designProjectStore.getByChatId(chatId)) !== undefined,
          });
          activeChats = chats;
          const projectBotHealth = async (
            botId: string,
            fullReady?: boolean,
          ): Promise<"ready" | "degraded" | "unavailable"> => {
            const policy = await botCapabilityStore.getBotPolicy(botId);
            if (policy.accessMode === "full") {
              if (fullReady !== undefined) return fullReady ? "ready" : "unavailable";
              const snapshot = await botCapabilityCatalog.snapshot({
                audienceId: instanceId,
                botId,
              });
              return snapshot.resources.providers.some(
                (provider) => provider.option.available &&
                  provider.models.some((model) => model.option.available),
              ) ? "ready" : "unavailable";
            }
            const binding = await botCapabilityStore.getBotBinding(botId);
            if (!binding) return "unavailable";
            try {
              const reconciled = await botCapabilityCatalog.reconcile(binding, {
                audienceId: instanceId,
                botId,
              });
              if (reconciled.issues.length === 0) return "ready";
              return reconciled.issues.some(
                ({ group }) => group === "provider" || group === "model",
              ) ? "unavailable" : "degraded";
            } catch {
              return "unavailable";
            }
          };
          const bots = new AidenRemoteBotService({
            application: botApplicationService,
            chatStore,
            avatar: createMainBotAvatarApplicationAdapter(instanceId),
            inbox: {
              list: (deviceId, input) =>
                createBotInboxProjectionService({
                  listBots: () => botApplicationService.list(true),
                  listChatMetadata: () => chatStore.list(),
                  projectBatch: async (request) => {
                    const activities = await streams.projectChatActivities(
                      deviceId,
                      request.map(({ chatId }) => chatId),
                    );
                    return mergeBotInboxActivityPreviews(request, activities);
                  },
                }).list(input),
            },
            favorites: {
              load: () => botFavoritesStore.load(),
              save: (snapshot) => botFavoritesStore.save(snapshot),
            },
            withFavoritesMutation: (action) => withBotFavoritesMutation(action),
            health: (botId) => projectBotHealth(botId),
            healthBatch: async (botIds) => {
              const snapshot = await botCapabilityCatalog.snapshot({
                audienceId: instanceId,
              });
              const fullReady = snapshot.resources.providers.some(
                (provider) => provider.option.available &&
                  provider.models.some((model) => model.option.available),
              );
              const rows = await mapWithConcurrency(botIds, 4, async (botId) =>
                [botId, await projectBotHealth(botId, fullReady)] as const,
              );
              return new Map(rows);
            },
            resolveProviderModel: async ({
              audienceId,
              botId,
              providerId,
              modelId,
            }) => {
              const inventoryLease = botRuntimeInventoryLeases.acquire();
              try {
                const defaultSelection = providerId === undefined || modelId === undefined
                  ? await models.resolve()
                  : undefined;
                const retained = await botCapabilityStore.getBotBinding(botId);
                const snapshot = await botCapabilityCatalog.snapshot({
                  audienceId,
                  botId,
                  ...(retained ? { retainedBindings: [retained] } : {}),
                });
                inventoryLease.assertCurrent();
                const provider = snapshot.resources.providers.find((candidate) =>
                  providerId !== undefined
                    ? candidate.option.id === providerId
                    : candidate.sourceId === defaultSelection?.providerId,
                );
                const model = provider?.models.find((candidate) =>
                  modelId !== undefined
                    ? candidate.option.id === modelId
                    : candidate.sourceId === defaultSelection?.modelId,
                );
                if (
                  !provider ||
                  !model ||
                  !provider.option.available ||
                  !model.option.available
                ) {
                  throw new AidenRemoteServiceError(
                    "operation_stale",
                    "Provider selection is unavailable. Refresh the Bot capability list.",
                    409,
                    true,
                  );
                }
                return {
                  providerId: provider.sourceId,
                  model: model.sourceId,
                  assertCurrent: () => {
                    try {
                      inventoryLease.assertCurrent();
                    } catch {
                      throw new AidenRemoteServiceError(
                        "operation_stale",
                        "Provider selection changed. Refresh the Bot capability list.",
                        409,
                        true,
                      );
                    }
                  },
                  release: () => inventoryLease.release(),
                };
              } catch (error) {
                inventoryLease.release();
                throw error;
              }
            },
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
            notifyBotsChanged: () => ipcMain.broadcast("bots:changed", {}),
            notifyChatsChanged: () => ipcMain.broadcast("chats:changed", {}),
          });
          const files = new AidenRemoteFileService({
            instanceId,
            application: workspaceEnvironmentApplicationService,
            owners: workspaceOwners,
          });
          const botFiles = new AidenRemoteBotFileService({
            instanceId,
            authority: botRuntimeAuthority,
            archivedRead: createBotArchivedFileReadAuthority({
              bots: botStore,
              chats: chatStore,
              capabilities: botCapabilityStore,
              catalog: botCapabilityCatalog,
              managedWorkspace: botManagedWorkspace,
              mutationGate: botMutationGate,
              inventoryLeases: botRuntimeInventoryLeases,
            }),
            chats: chatStore,
          });
          const git = new AidenRemoteGitService({
            application: workspaceEnvironmentApplicationService,
            owners: workspaceOwners,
            git: {
              review: gitReview,
              diff: gitDiff,
              branches: gitBranches,
              checkout: gitCheckout,
              createBranch: gitCreateBranch,
              commit: gitCommit,
              pushCapability: gitPushCapability,
              push: gitPush,
              compare: gitCompare,
              comparisonDiff: gitComparisonDiff,
              worktrees: gitWorktrees,
            },
            worktrees: workspaceWorktreeApplicationService,
            listWorkspaces: () => configStore.listWorkspaces(),
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
          });
          const schedules = new AidenRemoteScheduleService({
            application: scheduledTaskApplicationService,
            models,
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
          });
          const memorySettings = new AidenRemoteMemorySettingsService(configStore);
          const speech = new AidenRemoteSpeechService();
          return {
            instanceId,
            workspaceBrowser,
            chats,
            models,
            streams,
            files,
            botFiles,
            git,
            schedules,
            memorySettings,
            usage: usageStore,
            speech,
            bots,
            botNotice: {
              status: (deviceId) => botApplicationService.noticeStatus(deviceId),
              acknowledge: (deviceId, acknowledgement) =>
                botApplicationService.acknowledgeNotice(
                  deviceId,
                  acknowledgement,
                ),
            },
            settle: () => streams.settlePersistence(),
            workspaces: new AidenRemoteWorkspaceService({
              application: workspaceApplicationService,
              browser: workspaceBrowser,
              idempotency,
              persistIdempotency: (snapshot) => operationStore.save(snapshot),
              notifyChanged: () => ipcMain.broadcast("workspaces:changed", {}),
            }),
          };
        })();
      }
      return workspaceApi;
    },
    loadTlsIdentity: () => loadOrCreateAidenRemoteTlsIdentity({
      directory: path.join(userData, "aiden-remote-identity"),
      hostnames: [hostname],
    }),
    log: writeRemoteLog,
  });
  return {
    service,
    state,
    approvedRoots: new AidenRemoteApprovedRootService(state),
    revokeDevice: async (deviceId) => {
      const revoked = await revokeAidenRemoteRuntimeDevice({
        state,
        streams: activeStreams,
        chats: activeChats,
        workspaceOwners,
      }, deviceId);
      // Cleanup is intentionally idempotent: a retry after a crash between the
      // device tombstone and notice removal must still remove the acceptance.
      await botApplicationService.revokeNoticeAudience(deviceId);
      return revoked;
    },
    pendingApprovalForChat: (chatId) => activeStreams?.pendingApprovalForChat(chatId) ?? null,
    respondApprovalFromHost: (chatId, approvalId, decision) =>
      activeStreams?.respondApprovalFromHost(chatId, approvalId, decision) ?? false,
  };
}

export function getAidenRemoteService(): Promise<AidenRemoteService> {
  runtimePromise ??= createRuntime();
  return runtimePromise.then((runtime) => runtime.service);
}

export function getAidenRemoteRuntime(): Promise<AidenRemoteRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

export async function initializeAidenRemoteService(): Promise<void> {
  const service = await getAidenRemoteService();
  await service.initialize();
}

export function stopAidenRemoteService(): void {
  void runtimePromise?.then((runtime) => runtime.service.stop());
}

export async function stopAidenRemoteServiceAndSettle(): Promise<void> {
  const runtime = await runtimePromise;
  await runtime?.service.stopAndSettle();
}
