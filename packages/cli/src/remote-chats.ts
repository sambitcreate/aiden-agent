import { deleteCliBotSubagentHistory } from "./bot-subagents.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createChatApplicationService } from "../../../main/services/chat-application-service.js";
import { AidenRemoteChatService } from "../../../main/services/aiden-remote-chats.js";
import { AidenRemoteModelService } from "../../../main/services/aiden-remote-models.js";
import { AidenRemoteStreamService, removeRevokedDeviceStreams } from "../../../main/services/aiden-remote-streams.js";
import { AidenRemoteStreamJournal } from "../../../main/services/aiden-remote-stream-journal.js";
import type { AidenIdempotencyLedger, AidenIdempotencySnapshot } from "../../../main/services/aiden-remote-operation-contract.js";
import type { AidenRemoteStateRegistry } from "../../../main/services/aiden-remote-state.js";
import type { createDaemonChats } from "./daemon-chats.ts";
import type { createCliWorkspaceApplication } from "./workspace-application.ts";
import type { createCliBots } from "./bots.ts";
import { listCliProviders } from "./providers.ts";
import { JsonStore, readJson } from "./state.ts";
import { createCliChatForks } from "./daemon-forks.ts";
import { ChatReadMarkerStore, markChatReadThrough } from "../../../main/services/chat-read-markers.js";
import { ChatTriageStore, wakeTriageOnAttention } from "../../../main/services/chat-triage.js";
import { liveRunAttention } from "../../../main/services/chat-pending-attention.js";

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
  // The desktop's own Inbox stores, kept in this data dir: read markers and triage (Pin, Done, Snooze).
  const inboxListeners = new Set<() => void>();
  const inboxChanged = () => { for (const listener of inboxListeners) listener(); };
  const readMarkers = new ChatReadMarkerStore(() => agentDir, { onChange: inboxChanged });
  // Stamp the unread baseline now, so only replies after this daemon first served the Inbox read as new.
  await readMarkers.snapshot().catch(() => undefined);
  const triage = new ChatTriageStore(() => agentDir, { onChange: inboxChanged,
    logError: (message, error) => process.stderr.write(`aiden: ${message} ${error instanceof Error ? error.message : String(error)}\n`) });
  // The snooze timer and the early wake (a run that starts waiting on the person) run with the daemon.
  const stopWaking = wakeTriageOnAttention(daemon.runs, triage);
  await triage.start().catch(() => undefined);
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
    // A deleted chat's read marker and triage go with it.
    inboxState: { readMarkers, triage },
  });
  const modelService = new AidenRemoteModelService({
    listProviders: () => listCliProviders(agentDir),
    getSettings: async () => { const settings = readJson<{ defaultProvider?: string; defaultModel?: string }>(join(agentDir, "settings.json"), {}); return { lastProviderId: settings.defaultProvider, lastModel: settings.defaultModel }; },
  });
  // Same policy as the desktop journal: an unreadable file is kept aside as a
  // rescue copy and replaced instead of failing startup and every persist.
  // Same two-file journal as the desktop: finished streams in remote-streams.json,
  // in-progress ones in remote-streams-live.json.
  const journal = new AidenRemoteStreamJournal("remote-streams.json", () => agentDir);
  const revoked = new Set((await state.snapshot()).devices.filter((device) => device.revokedAt !== undefined).map((device) => device.id));
  const snapshot = removeRevokedDeviceStreams(await journal.load(), revoked);
  await journal.replace(snapshot);
  const streams = new AidenRemoteStreamService({ now: Date.now, cancel: daemon.llmClient.cancel, approve: daemon.llmClient.approve,
    snapshot, persist: (write) => journal.save(write), idempotency, persistIdempotency,
    onPersistenceError: () => process.stderr.write("aiden: Remote stream persistence failed.\n"),
  });
  const chats = new AidenRemoteChatService({ application, chatStore: daemon.chatStore, generation: daemon.llmClient,
    streams, models: modelService, bots: bots.botStore, botMutations: bots.mutationGate,
    retainedBotChatAuthorizer: (input) => bots.application.authorizeRetainedChat({ ...input, audienceId: input.deviceId }),
    botTurnAuthorityPreflight: (input) => bots.preflight(input),
    // Refused before the ledger records anything, so the same key runs after `aiden bots unpause`.
    botPaused: (botId) => bots.isPaused(botId),
    idempotency, persistIdempotency, activeChatIds: () => daemon.activity.snapshot().activeChatIds,
    // Row state, unread, triage and live-run times: the summaries' `inbox-signals-v1` fields, as on the desktop.
    activitySnapshot: () => daemon.activity.snapshot(),
    readMarkers: { snapshot: () => readMarkers.snapshot(), markRead: async (chatId, throughMessageId) => markChatReadThrough(readMarkers, await daemon.chatStore.get(chatId), throughMessageId) },
    triage,
    runTimes: (chatId) => liveRunAttention(chatId, daemon.runs),
    // Plain forks only: the daemon has no summarizer, so it never advertises chat-fork-summary-v1.
    forks: createCliChatForks(daemon, workspace),
  });
  return { chats, streams, models: modelService, application, readMarkers, triage,
    /** A read marker or a triage entry changed. */
    onInboxChanged(listener: () => void) { inboxListeners.add(listener); return () => { inboxListeners.delete(listener); }; },
    stopInbox() { stopWaking(); triage.dispose(); },
  };
}
