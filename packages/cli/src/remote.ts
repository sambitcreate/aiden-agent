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
import { aidenRemoteLanHostnames } from "../../../main/services/aiden-remote-lan-hostname.js";
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

/**
 * Linux discovery is best effort: a missing or exiting publisher only logs a
 * warning and never stops the Remote listeners. It is not harmless for LAN
 * pairing, though. The pairing payload seals `<host>.local` as the endpoint
 * and the phone apps require that exact endpoint, so the name must resolve on
 * the phone's network (an mDNS responder such as avahi-daemon), or the person
 * pairs over Tailscale instead.
 */
function bonjourPublisher() {
  if (process.platform === "darwin") return new DnsSdAidenRemoteBonjourPublisher();
  let child: ChildProcess | undefined;
  const warn = (line: string) => process.stderr.write(`aiden: ${line}\n`);
  return {
    async start(input: { instanceId: string; displayName: string; port: number; hostname?: string }) {
      const host = input.hostname ?? `${hostname()}.local`;
      const current = spawn("avahi-publish-service", [input.displayName, "_aiden-agent._tcp", String(input.port), "v=1", `instance=${input.instanceId}`], { stdio: "ignore" });
      child = current;
      const started = await new Promise<boolean>((resolve) => {
        current.once("spawn", () => resolve(true));
        current.once("error", (error: NodeJS.ErrnoException) => {
          warn(error.code === "ENOENT"
            ? `avahi-publish-service is not installed, so phones will not discover this server. LAN pairing still needs ${host} to resolve on the phone's network; if no mDNS responder answers for it, install one (\`sudo apt install avahi-daemon avahi-utils\`) or pair over Tailscale with \`aiden remote pair tailscale\`.`
            : `Local network discovery could not start (${error.message}). LAN pairing needs ${host} to resolve on the phone's network; otherwise pair over Tailscale with \`aiden remote pair tailscale\`.`);
          resolve(false);
        });
      });
      current.on("error", () => undefined);
      if (!started) { if (child === current) child = undefined; return; }
      current.once("exit", (code) => {
        if (child !== current) return;
        child = undefined;
        warn(`avahi-publish-service exited (code ${code}), usually because avahi-daemon is not running, so ${host} may not resolve and phones cannot pair over LAN. Start it (\`sudo apt install avahi-daemon && sudo systemctl enable --now avahi-daemon\`) and restart \`aiden serve\`, or pair over Tailscale with \`aiden remote pair tailscale\`.`);
      });
    },
    stop() { const current = child; child = undefined; current?.kill(); },
  };
}

const PAIR_TAILSCALE_AGAIN = "then run `aiden remote pair tailscale`.";

/** What to do next for each Tailscale setup failure, naming the exact commands. */
export function tailscaleSetupMessage(code: string): string | undefined {
  switch (code) {
    case "tailscale_not_installed": return `Tailscale is not installed on this server. Install it (https://tailscale.com/download), sign in with \`sudo tailscale up\`, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_not_connected":
    case "tailscale_status_unavailable": return `Tailscale is not signed in or not running on this server. Run \`sudo tailscale up\`, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_https_unavailable": return `HTTPS certificates are off for this tailnet. Turn on HTTPS in the Tailscale admin console (DNS, HTTPS Certificates), ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_permission_denied": return `Tailscale refused to change Serve settings for this user. Run \`sudo tailscale set --operator=$USER\` once, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_funnel_conflict": return `Tailscale Funnel is on for HTTPS port 443 on this machine, and Aiden will not put its private route behind a public Funnel. Turn that Funnel off, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_route_conflict": return "The Tailscale Serve path /api/aiden/v1 on this machine already points somewhere else, so Aiden left it unchanged. If it belongs to another Aiden install that is no longer running, run `aiden remote mode both`, then `aiden remote tailscale-review`, then `aiden remote tailscale-takeover <token>` with the token it prints; otherwise remove that route yourself (`tailscale serve status` shows it). Then run `aiden remote pair tailscale`.";
    case "tailscale_route_live": return "Another running Aiden install owns the Tailscale Serve path /api/aiden/v1 on this machine. Stop it (or pair through it) before pairing this server over Tailscale.";
    case "tailscale_reconciliation_required": return `A previous Tailscale route change did not report its outcome. Run \`aiden remote tailscale-reconcile\`, ${PAIR_TAILSCALE_AGAIN}`;
    default: return undefined;
  }
}

function withTailscaleSetupMessage(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const setup = tailscaleSetupMessage(message);
  return setup ? new Error(setup, { cause: error }) : error instanceof Error ? error : new Error(message);
}

type TailscaleTransportService = Pick<AidenRemoteService, "status" | "setConnectionMode" | "connectTailscale">;
type TailscalePairingService = TailscaleTransportService & Pick<AidenRemoteService, "beginPairing">;

/**
 * Make Tailscale reachable, in `mode` when given, otherwise next to LAN:
 * check the node, set the connection mode, and connect Serve through the
 * ownership-safe operation. A route someone else owns is never replaced;
 * that needs the explicit review and takeover. A mode this call changed is
 * put back when the route cannot be connected.
 */
export async function connectTailscaleTransport(service: TailscaleTransportService, tailscale: Pick<AidenRemoteTailscaleController, "status">, mode?: "tailscale" | "both") {
  const before = await service.status();
  const target = mode ?? (before.connectionMode === "lan" ? "both" : before.connectionMode);
  if (before.tailscaleConnected && before.connectionMode === target) return;
  if (!before.tailscaleConnected) {
    const node = await tailscale.status();
    const blocked = !node.installed ? "tailscale_not_installed" : node.errorCode ? `tailscale_${node.errorCode}`
      : !node.dnsName ? "tailscale_not_connected" : node.httpsAvailable !== true ? "tailscale_https_unavailable" : undefined;
    if (blocked) throw withTailscaleSetupMessage(blocked);
  }
  const changed = before.connectionMode !== target;
  try {
    if (changed) await service.setConnectionMode(target);
    if (!(await service.status()).tailscaleConnected) await service.connectTailscale();
    if ((await service.status()).tailscaleErrorCode === "permission_denied") throw new Error("tailscale_permission_denied");
  } catch (error) {
    if (changed) await service.setConnectionMode(before.connectionMode).catch(() => undefined);
    throw withTailscaleSetupMessage(error);
  }
}

/** Pair over Tailscale, first preparing the transport when it is not ready. */
export async function beginTailscalePairing(service: TailscalePairingService, tailscale: Pick<AidenRemoteTailscaleController, "status">) {
  await connectTailscaleTransport(service, tailscale);
  try { return await service.beginPairing("tailscale"); } catch (error) { throw withTailscaleSetupMessage(error); }
}

/** Who can reach this server: the local network only, Tailscale only, or both. */
export type RemoteNetwork = "local" | "tailscale" | "both";
export const REMOTE_NETWORKS: readonly RemoteNetwork[] = ["local", "tailscale", "both"];

/** Switch the server to `network`. Local only also removes Aiden's own Tailscale Serve route. */
export async function setRemoteNetwork(service: TailscaleTransportService, tailscale: Pick<AidenRemoteTailscaleController, "status">, network: RemoteNetwork) {
  if (network === "local") await service.setConnectionMode("lan");
  else await connectTailscaleTransport(service, tailscale, network);
  return service.status();
}

/** Shared protocol services retain their own identity, revision and authorization checks. */
export async function createCliRemote(agentDir: string, chats: ReturnType<typeof createDaemonChats>, scheduler: ReturnType<typeof createCliScheduler>, options: { port?: number; discovery?: AidenRemoteBonjourPublisher; bots?: Awaited<ReturnType<typeof createCliBots>> } = {}) {
  const bots = options.bots ?? await createCliBots(agentDir, chats);
  chats.setBots(bots);
  bots.setScheduler(scheduler);
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
  let botSessions: import("../../../main/services/aiden-remote-bot-session.js").AidenRemoteBotSessionService | undefined;
  let chatApi: Awaited<ReturnType<typeof createCliRemoteChats>> | undefined;
  const tailscale = new AidenRemoteTailscaleController(await createSystemTailscaleCommandRunner(), { outcomeStore: {
    begin: (outcome) => state.beginTailscalePendingOutcome(outcome), snapshot: async () => (await state.snapshot()).tailscalePendingOutcome,
    commit: (ownership) => state.commitTailscaleOutcome(ownership), clear: () => state.clearTailscalePendingOutcome(),
  } });
  const lanHostnames = await aidenRemoteLanHostnames();
  const service = new AidenRemoteService({ state, appVersion: VERSION, hostname: lanHostnames.endpoint, tailscale, bonjour: options.discovery ?? bonjourPublisher(),
    loadTlsIdentity: () => loadOrCreateAidenRemoteTlsIdentity({ directory: join(agentDir, "remote-tls"), hostnames: lanHostnames.certificate, opensslPath: "openssl" }),
    workspaceApi: async (instanceId) => {
      const browser = new AidenRemoteWorkspaceBrowserService({ instanceId, state, approvalStore: agentDir });
      chatApi ??= await createCliRemoteChats(agentDir, chats, workspaces, state, idempotency, persistIdempotency, bots);
      await botSessions?.close();
      const botApi = createCliRemoteBots(agentDir, instanceId, bots, chats, chatApi, idempotency, persistIdempotency);
      botSessions = botApi.botSessions;
      return {
        ...botApi,
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
    async stop() { await botSessions?.close(); await chats.stop(); await service.stopAndSettle(); await speech.stop(); await scheduledMcp.close(); if (!options.bots) await bots.stop(); },
    async command(args: string[]) {
      const [action = "status", value] = args;
      switch (action) {
        case "status": return service.status();
        case "devices": return state.listDevices();
        case "revoke": { if (!value) throw new Error("Provide a paired device id."); const revoked = await revokeAidenRemoteRuntimeDevice({ state, streams: chatApi?.streams, chats: chatApi?.chats, workspaceOwners: owners }, value); await bots.application.revokeNoticeAudience(value); return { revoked }; }
        case "pair": { if (value !== "lan" && value !== "tailscale") throw new Error("Usage: remote pair lan|tailscale"); return value === "tailscale" ? beginTailscalePairing(service, tailscale) : service.beginPairing(value); }
        case "pair-status": return service.pairingStatus() ?? { state: "none" };
        case "pair-cancel": { if (!value) throw new Error("Provide a pairing session id."); return { closed: await service.closePairing(value) }; }
        case "roots": return (await state.snapshot()).approvedRoots.map(({ id, label }) => ({ id, label }));
        case "approve-root": return roots.addLocalFolder(value, { confirmHomeDirectory: args[2] === "--entire-home" });
        case "remove-root": return roots.removeLocalRoot(value);
        case "network": { if (!REMOTE_NETWORKS.includes(value as RemoteNetwork)) throw new Error("Usage: remote network local|tailscale|both"); return setRemoteNetwork(service, tailscale, value as RemoteNetwork); }
        case "mode": { if (!["lan", "tailscale", "both"].includes(value)) throw new Error("Usage: remote mode lan|tailscale|both"); await service.setConnectionMode(value as "lan" | "tailscale" | "both"); return service.status(); }
        case "tailscale-connect": await service.connectTailscale(); return service.status();
        case "tailscale-prepare": await connectTailscaleTransport(service, tailscale); return service.status();
        case "tailscale-disconnect": await service.disconnectTailscale(); return service.status();
        case "tailscale-review": return service.reviewTailscaleTakeover();
        case "tailscale-takeover": await service.takeOverTailscale(value); return service.status();
        case "tailscale-reconcile": await service.reconcileTailscale(); return service.status();
        default: throw new Error("Usage: remote status|devices|revoke <id>|pair lan|tailscale|pair-status|pair-cancel <session-id>|roots|approve-root <path>|remove-root <id>|network local|tailscale|both|mode lan|tailscale|both|tailscale-connect|tailscale-prepare|tailscale-disconnect|tailscale-review|tailscale-takeover <token>|tailscale-reconcile");
      }
    },
  };
}
