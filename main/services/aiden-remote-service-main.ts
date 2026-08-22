import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, logger } from "../platform.js";
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
  parseAidenRemoteStateDocument,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
} from "./aiden-remote-tailscale.js";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import { workspaceApplicationService } from "./workspace-application-service-main.js";
import {
  AidenIdempotencyLedger,
  MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
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
import { chatTitleService } from "./chat-title.js";
import { configStore } from "./config-store.js";
import { llmClient } from "./llm-client.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import { AidenRemoteFileService } from "./aiden-remote-files.js";
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
import { scheduledTaskApplicationService } from "./scheduled-task-application-service-main.js";

const STATE_FILE = "aiden-remote-v1.json";
const OPERATIONS_FILE = "aiden-remote-operations-v1.json";
const STREAMS_FILE = "aiden-remote-streams-v1.json";
const MAX_STATE_BYTES = 512 * 1_024;
const execFileAsync = promisify(execFile);

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

function writeRemoteLog(entry: AidenRemoteServiceLogEntry): void {
  const details = entry.details ?? {};
  if (entry.level === "error") logger.error("aiden-remote", entry.event, details);
  else if (entry.level === "warn") logger.warn("aiden-remote", entry.event, details);
  else logger.info("aiden-remote", entry.event, details);
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
  const userData = app.getPath("userData");
  const hostname = os.hostname();
  const defaultDisplayName = defaultAidenRemoteDisplayName(await macComputerName());
  const store = new DataStore<AidenRemoteStateDocument>(
    STATE_FILE,
    createDefaultAidenRemoteState(undefined, defaultDisplayName),
    () => userData,
    {
      maxBytes: MAX_STATE_BYTES,
      fileMode: 0o600,
      normalize: (value) => parseAidenRemoteStateDocument(value, defaultDisplayName),
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
          || !("displayName" in raw) || !("lanPortCommitted" in raw);
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
        git: AidenRemoteGitService;
        schedules: AidenRemoteScheduleService;
        usage: typeof usageStore;
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
            idempotency,
            persistIdempotency: (snapshot) => operationStore.save(snapshot),
            notifyChanged: () => ipcMain.broadcast("chats:changed", {}),
            isTitlePending: (chatId) => chatTitleService.isFirstTurnPending(chatId),
          });
          activeChats = chats;
          const files = new AidenRemoteFileService({
            instanceId,
            application: workspaceEnvironmentApplicationService,
            owners: workspaceOwners,
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
          return {
            instanceId,
            workspaceBrowser,
            chats,
            models,
            streams,
            files,
            git,
            schedules,
            usage: usageStore,
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
    revokeDevice: (deviceId) => revokeAidenRemoteRuntimeDevice({
      state,
      streams: activeStreams,
      chats: activeChats,
      workspaceOwners,
    }, deviceId),
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
