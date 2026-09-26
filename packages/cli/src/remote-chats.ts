import { deleteCliBotSubagentHistory } from "./bot-subagents.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createChatApplicationService } from "../../../main/services/chat-application-service.js";
import { AidenRemoteChatService } from "../../../main/services/aiden-remote-chats.js";
import { AidenRemoteModelService } from "../../../main/services/aiden-remote-models.js";
import { AidenRemoteStreamService, normalizeAidenRemoteStreamSnapshot, removeRevokedDeviceStreams, type AidenRemoteStreamSnapshot } from "../../../main/services/aiden-remote-streams.js";
import type { AidenIdempotencyLedger, AidenIdempotencySnapshot } from "../../../main/services/aiden-remote-operation-contract.js";
import type { AidenRemoteStateRegistry } from "../../../main/services/aiden-remote-state.js";
import type { createDaemonChats } from "./daemon-chats.ts";
import type { createCliWorkspaceApplication } from "./workspace-application.ts";
import type { createCliBots } from "./bots.ts";
import { listCliProviders } from "./providers.ts";
import { JsonStore, readJson } from "./state.ts";

export async function createCliRemoteChats(agentDir: string, daemon: ReturnType<typeof createDaemonChats>, workspace: ReturnType<typeof createCliWorkspaceApplication>, state: AidenRemoteStateRegistry,
  idempotency: AidenIdempotencyLedger, persistIdempotency: (value: AidenIdempotencySnapshot) => Promise<void>, bots: Awaited<ReturnType<typeof createCliBots>>) {
  const deleting = new JsonStore<string[]>(join(agentDir, "daemon-chat-deletions.json"), []);
  // A journal deletion is a durable roll-forward checkpoint, including after a crash.
  for (const id of await deleting.load()) {
    await deleteCliBotSubagentHistory(agentDir, id);
    await rm(daemon.sessionPath(id), { force: true });
    if (await daemon.chatStore.get(id)) await daemon.chatStore.remove(id);
    await deleting.update((values) => { values.splice(values.indexOf(id), 1); });
  }
  const privateHistory = {
    async deleteChat(id: string) { await deleting.update((values) => { if (!values.includes(id)) values.push(id); }); await deleteCliBotSubagentHistory(agentDir, id); },
    async completeChatDeletion(id: string) { await deleting.update((values) => { const index = values.indexOf(id); if (index >= 0) values.splice(index, 1); }); },
    pendingChatDeletions: () => deleting.load(),
  };
  // This daemon's current tool profile cannot create staged image or HTML artifacts.
  const artifacts = { availability: () => ({ available: true as const }), hasPending: async () => false, deleteChat: async () => {} };
  const application = createChatApplicationService({ chatStore: daemon.chatStore, configStore: workspace.configStore,
    llmClient: {
      isChatOwnedByInactiveRenderer: () => false,
      isChatBusy: daemon.llmClient.isChatBusy, waitForChatIdle: daemon.llmClient.waitForChatIdle,
      requiresAppendReconciliation: (id) => daemon.admission.requiresAppendReconciliation(id), markAppendReconciliationRequired: (id) => daemon.admission.markAppendReconciliationRequired(id), clearAppendReconciliationRequired: (id) => daemon.admission.clearAppendReconciliationRequired(id),
      beginChatWorkspaceChange: (id) => daemon.llmClient.isChatBusy(id) ? null : daemon.deletion.begin(id),
      beginChatDeletion: (id) => daemon.deletion.begin(id),
      cancelChat: async (id) => { await daemon.llmClient.cancelChat(id); await daemon.llmClient.waitForChatIdle(id); },
    },
    displayImageArtifactStore: artifacts, generativeUiArtifactStore: artifacts,
    subagentRunStore: privateHistory,
    piRuntimeEffectStore: { deleteChat: async (id) => { await rm(daemon.sessionPath(id), { force: true }); } },
    piCompactionSessionStore: { deleteChat: async () => {} }, // Compaction checkpoints are in that same pi journal.
    workspaceMutationGate: workspace.mutationGate, workspaceOperationRegistry: workspace.operationRegistry,
    logError: (area, message) => process.stderr.write(`aiden: ${area}: ${message}\n`),
  });
  const modelService = new AidenRemoteModelService({
    listProviders: () => listCliProviders(agentDir),
    getSettings: async () => { const settings = readJson<{ defaultProvider?: string; defaultModel?: string }>(join(agentDir, "settings.json"), {}); return { lastProviderId: settings.defaultProvider, lastModel: settings.defaultModel }; },
  });
  const snapshots = new JsonStore<AidenRemoteStreamSnapshot>(join(agentDir, "remote-streams.json"), { version: 1, streams: [] });
  const revoked = new Set((await state.snapshot()).devices.filter((device) => device.revokedAt !== undefined).map((device) => device.id));
  const snapshot = removeRevokedDeviceStreams(normalizeAidenRemoteStreamSnapshot(await snapshots.load()), revoked);
  await snapshots.save(snapshot);
  const streams = new AidenRemoteStreamService({ now: Date.now, cancel: daemon.llmClient.cancel, approve: daemon.llmClient.approve,
    snapshot, persist: (value) => snapshots.save(value), idempotency, persistIdempotency,
    onPersistenceError: () => process.stderr.write("aiden: Remote stream persistence failed.\n"),
  });
  const chats = new AidenRemoteChatService({ application, chatStore: daemon.chatStore, generation: daemon.llmClient,
    streams, models: modelService, bots: bots.botStore, botMutations: bots.mutationGate,
    retainedBotChatAuthorizer: (input) => bots.application.authorizeRetainedChat({ ...input, audienceId: input.deviceId }),
    botTurnAuthorityPreflight: (input) => bots.preflight(input),
    idempotency, persistIdempotency, activeChatIds: () => daemon.activity.snapshot().activeChatIds,
  });
  return { chats, streams, models: modelService, application };
}
