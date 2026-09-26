import { createCliMcpPool } from "./mcp.ts";
import { selectedMcpServers } from "../../../main/services/mcp-selection.js";
import { createCliBots } from "./bots.ts";
import { createCliRemoteBots } from "./remote-bots.ts";
import { join } from "node:path";
import { hostname } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { AidenRemoteService, DnsSdAidenRemoteBonjourPublisher, type AidenRemoteBonjourPublisher } from "../../../main/services/aiden-remote-service.js";
import { AidenRemoteStateRegistry, createDefaultAidenRemoteState } from "../../../main/services/aiden-remote-state.js";
import { AidenRemoteApprovedRootService } from "../../../main/services/aiden-remote-approved-roots.js";
import { AidenRemoteTailscaleController, createSystemTailscaleCommandRunner } from "../../../main/services/aiden-remote-tailscale.js";
import { loadOrCreateAidenRemoteTlsIdentity } from "../../../main/services/aiden-remote-tls-identity.js";
import { AidenRemoteWorkspaceBrowserService } from "../../../main/services/aiden-remote-workspace-browser.js";
import { AidenRemoteWorkspaceService } from "../../../main/services/aiden-remote-workspaces.js";
import { AidenRemoteWorkspaceOwnerRegistry } from "../../../main/services/aiden-remote-workspace-owners.js";
import { AidenRemoteFileService } from "../../../main/services/aiden-remote-files.js";
import { AidenRemoteGitService } from "../../../main/services/aiden-remote-git.js";
import { AidenRemoteMemorySettingsService } from "../../../main/services/aiden-remote-memory-settings.js";
import { AidenIdempotencyLedger, type AidenIdempotencySnapshot } from "../../../main/services/aiden-remote-operation-contract.js";
import * as git from "../../../main/services/git.js";
import type { AppSettings } from "../../../main/services/types.js";
import { createUsageStore, createEmptyUsageDatabase } from "../../../main/services/usage-store-core.js";
import { JsonStore, readJson, atomicJson } from "./state.ts";
import { createCliWorkspaceApplication } from "./workspace-application.ts";
import type { createDaemonChats } from "./daemon-chats.ts";
import type { createCliScheduler } from "./schedules.ts";
import { createCliSpeech } from "./speech.ts";
import { createCliRemoteChats } from "./remote-chats.ts";
import { revokeAidenRemoteRuntimeDevice } from "../../../main/services/aiden-remote-revocation.js";
import { AidenRemoteScheduleService } from "../../../main/services/aiden-remote-schedules.js";
import { createScheduledTaskApplicationService } from "../../../main/services/scheduled-task-application-service.js";
import { listScheduledScripts } from "../../../main/services/schedule-script.js";
import { nextScheduledRuns, systemTimezone, validateTimezone } from "../../../main/services/schedule-store-core.js";
import { scheduledSettingsPatch } from "../../../main/services/scheduled-settings-core.js";
import { createCliGitService } from "./git-commands.ts";
import { createCliRemoteWorktrees } from "./remote-worktrees.ts";

function bonjourPublisher() {
  if (process.platform === "darwin") return new DnsSdAidenRemoteBonjourPublisher();
  let child: ChildProcess | undefined;
  return {
    async start(input: { instanceId: string; displayName: string; port: number }, failed: (error: Error) => void) {
      child = spawn("avahi-publish-service", [input.displayName, "_aiden-agent._tcp", String(input.port), "v=1", `instance=${input.instanceId}`], { stdio: "ignore" });
      const current = child;
      await new Promise<void>((resolve, reject) => {
        current.once("spawn", resolve); current.once("error", reject);
      });
      current.on("error", failed);
      current.once("exit", (code) => { if (child === current) { child = undefined; failed(new Error(`Local discovery stopped (${code}).`)); } });
    },
    stop() { const current = child; child = undefined; current?.kill(); },
  };
}

/** Shared protocol services retain their own identity, revision and authorization checks. */
export async function createCliRemote(agentDir: string, chats: ReturnType<typeof createDaemonChats>, scheduler: ReturnType<typeof createCliScheduler>, options: { port?: number; discovery?: AidenRemoteBonjourPublisher; bots?: Awaited<ReturnType<typeof createCliBots>> } = {}) {
  const bots = options.bots ?? await createCliBots(agentDir, chats);
  chats.setBots(bots);
  const stateStore = new JsonStore(join(agentDir, "remote.json"), createDefaultAidenRemoteState(undefined, "Aiden CLI", options.port ?? 49320));
  const state = new AidenRemoteStateRegistry(stateStore);
  await state.initialize();
  const owners = new AidenRemoteWorkspaceOwnerRegistry();
  const roots = new AidenRemoteApprovedRootService(state);
  const speech = createCliSpeech(agentDir);
  const gitService = createCliGitService();
  const cancelGeneration = async (id: string) => {
    for (const chat of await chats.chatStore.list(id)) await chats.llmClient.cancelChat(chat.id);
    for (const chat of await chats.chatStore.list(id)) await chats.llmClient.waitForChatIdle(chat.id);
  };
  const workspaces = createCliWorkspaceApplication(agentDir, {
    cancelGeneration,
    assertManagedWorktreeAdmission: async (workspace) => {
      const managed = workspace.managedWorktree;
      if (managed && !await gitService.managedWorktreeUsable(managed.repositoryPath, managed.worktreePath, managed.branch, managed.worktreeGitDir, managed.ownershipToken, managed.worktreeDevice, managed.worktreeInode)) throw new Error("The managed worktree identity is no longer usable.");
    },
    cancelSchedules: (id) => scheduler.service.cancelWorkspace(id), resumeSchedules: (id) => scheduler.service.resumeWorkspace(id),
  });
  const worktreeApplication = createCliRemoteWorktrees(workspaces, scheduler, gitService, cancelGeneration);
  const operations = new JsonStore<AidenIdempotencySnapshot>(join(agentDir, "remote-operations.json"), new AidenIdempotencyLedger().snapshot());
  const idempotency = new AidenIdempotencyLedger(await operations.load());
  const persistIdempotency = (snapshot: AidenIdempotencySnapshot) => operations.save(snapshot);
  const settings = new JsonStore<AppSettings>(join(agentDir, "aiden.json"), {});
  const scheduledMcp = createCliMcpPool(agentDir);
  const scheduleApplication = createScheduledTaskApplicationService({ store: scheduler.store, service: scheduler.service,
    getSettings: () => settings.load(), setSettings: (patch) => settings.update((value) => { Object.assign(value, patch); return value; }),
    getWorkspace: workspaces.configStore.getWorkspace, listMcpServers: scheduledMcp.listServers,
    validateMcpSelection: (configured, selected) => { selectedMcpServers(configured, selected); },
    listScripts: listScheduledScripts, nextRuns: nextScheduledRuns, systemTimezone, validateTimezone,
    settingsPatch: (input) => scheduledSettingsPatch(input, validateTimezone), notifyChanged: () => {},
  });
  let chatApi: Awaited<ReturnType<typeof createCliRemoteChats>> | undefined;
  const tailscale = new AidenRemoteTailscaleController(await createSystemTailscaleCommandRunner(), { outcomeStore: {
    begin: (outcome) => state.beginTailscalePendingOutcome(outcome), snapshot: async () => (await state.snapshot()).tailscalePendingOutcome,
    commit: (ownership) => state.commitTailscaleOutcome(ownership), clear: () => state.clearTailscalePendingOutcome(),
  } });
  const service = new AidenRemoteService({ state, appVersion: VERSION, hostname: hostname(), tailscale, bonjour: options.discovery ?? bonjourPublisher(),
    loadTlsIdentity: () => loadOrCreateAidenRemoteTlsIdentity({ directory: join(agentDir, "remote-tls"), hostnames: [hostname()], opensslPath: "openssl" }),
    workspaceApi: async (instanceId) => {
      const browser = new AidenRemoteWorkspaceBrowserService({ instanceId, state });
      chatApi ??= await createCliRemoteChats(agentDir, chats, workspaces, state, idempotency, persistIdempotency, bots);
      return {
        ...createCliRemoteBots(agentDir, instanceId, bots, chats, chatApi, idempotency, persistIdempotency),
        chats: chatApi.chats, streams: chatApi.streams, models: chatApi.models,
        schedules: new AidenRemoteScheduleService({ application: scheduleApplication, models: chatApi.models, idempotency, persistIdempotency }),
        workspaceBrowser: browser,
        workspaces: new AidenRemoteWorkspaceService({ application: workspaces.application, browser, idempotency, persistIdempotency }),
        files: new AidenRemoteFileService({ instanceId, application: workspaces.environment, owners }),
        git: new AidenRemoteGitService({ application: workspaces.environment, owners, worktrees: worktreeApplication, listWorkspaces: workspaces.configStore.listWorkspaces, idempotency, persistIdempotency,
          git: { review: git.gitReview, diff: git.gitDiff, branches: git.gitBranches, checkout: git.gitCheckout, createBranch: git.gitCreateBranch, commit: git.gitCommit,
            pushCapability: git.gitPushCapability, push: git.gitPush, compare: git.gitCompare, comparisonDiff: git.gitComparisonDiff, worktrees: git.gitWorktrees },
        }),
        memorySettings: new AidenRemoteMemorySettingsService({ getSettings: () => settings.load(), setSettings: (patch) => settings.update((value) => { Object.assign(value, patch); return value; }) }),
        usage: createUsageStore({ load: async () => readJson(join(agentDir, "usage.json"), createEmptyUsageDatabase()), save: async (value) => atomicJson(join(agentDir, "usage.json"), value) }),
        speech: speech.service,
        settle: () => chatApi!.streams.settlePersistence(),
      };
    },
  });
  return { service, state, workspaces, roots, bots,
    async start() { await service.initialize(); await service.setEnabled(true); const status = await service.status(); if (!status.running) throw new Error(status.error ?? "Remote listeners could not start."); },
    async stop() { await chats.stop(); await service.stopAndSettle(); await speech.stop(); await scheduledMcp.close(); if (!options.bots) await bots.stop(); },
    async command(args: string[]) {
      const [action = "status", value] = args;
      switch (action) {
        case "status": return service.status();
        case "devices": return state.listDevices();
        case "revoke": { if (!value) throw new Error("Provide a paired device id."); const revoked = await revokeAidenRemoteRuntimeDevice({ state, streams: chatApi?.streams, chats: chatApi?.chats, workspaceOwners: owners }, value); await bots.application.revokeNoticeAudience(value); return { revoked }; }
        case "pair": { if (value !== "lan" && value !== "tailscale") throw new Error("Usage: remote pair lan|tailscale"); const pairing = await service.beginPairing(value); return pairing; }
        case "pair-status": return service.pairingStatus() ?? { state: "none" };
        case "pair-cancel": { if (!value) throw new Error("Provide a pairing session id."); return { closed: await service.closePairing(value) }; }
        case "roots": return (await state.snapshot()).approvedRoots.map(({ id, label }) => ({ id, label }));
        case "approve-root": return roots.addLocalFolder(value, { confirmHomeDirectory: args[2] === "--entire-home" });
        case "remove-root": return roots.removeLocalRoot(value);
        case "mode": { if (!["lan", "tailscale", "both"].includes(value)) throw new Error("Usage: remote mode lan|tailscale|both"); await service.setConnectionMode(value as "lan" | "tailscale" | "both"); return service.status(); }
        case "tailscale-connect": await service.connectTailscale(); return service.status();
        case "tailscale-disconnect": await service.disconnectTailscale(); return service.status();
        case "tailscale-review": return service.reviewTailscaleTakeover();
        case "tailscale-takeover": await service.takeOverTailscale(value); return service.status();
        default: throw new Error("Usage: remote status|devices|revoke <id>|pair lan|tailscale|pair-status|pair-cancel <session-id>|roots|approve-root <path>|remove-root <id>|mode lan|tailscale|both|tailscale-connect|tailscale-disconnect|tailscale-review|tailscale-takeover <token>");
      }
    },
  };
}
