import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf-8");
}

function ipcHandlerStart(contents: string, channel: string): number {
  const channelIndex = contents.indexOf(`"${channel}"`);
  assert.ok(channelIndex >= 0, `Missing IPC handler for ${channel}`);
  const start = contents.lastIndexOf("ipcMain.handle", channelIndex);
  assert.ok(start >= 0, `Missing IPC registration for ${channel}`);
  return start;
}

function ipcHandlerSource(contents: string, channel: string): string {
  const channelIndex = contents.indexOf(`"${channel}"`);
  const start = ipcHandlerStart(contents, channel);
  const next = contents.indexOf("ipcMain.handle", channelIndex + channel.length + 2);
  return contents.slice(start, next === -1 ? undefined : next);
}

test("live child snapshots are durable before owner-bound renderer delivery", async () => {
  const llm = await source("main/services/llm-client.ts");
  const prepare = llm.indexOf(
    "prepareSnapshot: (snapshot) => subagentPersistence.prepare(snapshot)",
  );
  const persist = llm.indexOf("await subagentPersistence.upsert(snapshot)");
  const notify = llm.indexOf('sendGeneration(streamId, "chat:subagents"', persist);
  assert.ok(prepare >= 0);
  assert.ok(persist >= 0);
  assert.ok(notify > persist);
  assert.match(llm, /await subagentSupervisor\?\.flush\(\);[\s\S]{0,500}chatStore\.appendMessage/u);
});

test("historical inspector reads require a live document and matching chat owner", async () => {
  const [handler, historyRead, rendererIpc] = await Promise.all([
    source("main/handlers/subagents.ts"),
    source("main/services/subagents/subagent-history-read-core.ts"),
    source("renderer/lib/ipc.ts"),
  ]);
  assert.match(handler, /rendererDocumentOwner\(/u);
  assert.match(handler, /readSubagentHistoryDetailForOwner\(/u);
  assert.match(handler, /listEffectActivityForRun/u);
  assert.match(handler, /owner\.isDestroyed\(\)/u);
  assert.match(historyRead, /owner\.onInvalidated\(\(\) => undefined\)/u);
  assert.match(historyRead, /finally \{\s+removeOwnerInvalidation\(\);/u);
  assert.match(historyRead, /requireActiveOwner\(owner\)/u);
  assert.match(historyRead, /snapshot\?\.chatId === chat\.id/u);
  assert.match(
    historyRead,
    /snapshot\.workspaceId === persistedChatWorkspaceId\(chat\.workspaceId\)/u,
  );
  assert.match(historyRead, /persistedChatReferencesSubagentRun\(/u);
  assert.doesNotMatch(handler, /broadcast\(/u);
  assert.doesNotMatch(handler, /throw error|error\.message/u);
  assert.match(handler, /Aiden could not load subagent history/u);
  assert.match(rendererIpc, /parseSubagentRunSnapshot\(/u);
  assert.match(rendererIpc, /snapshot\?\.generationId === streamId/u);
});

test("run-store failures keep filesystem details out of renderer-visible errors", async () => {
  const [llm, historyHandler, chatHandler, chatApplicationService] = await Promise.all([
    source("main/services/llm-client.ts"),
    source("main/handlers/subagents.ts"),
    source("main/handlers/chats.ts"),
    source("main/services/chat-application-service.ts"),
  ]);
  assert.match(llm, /error: "local storage failed"/u);
  assert.match(historyHandler, /Aiden could not load subagent history/u);
  assert.match(chatHandler, /chatApplicationService\.remove\(/u);
  assert.match(chatApplicationService, /Aiden could not delete this chat's subagent history/u);
});

test("private run-store I/O is descriptor-bound, generation-checked, and packaged", async () => {
  const [store, transport, nativeStore, packageJson, verifier] = await Promise.all([
    source("main/services/subagents/subagent-run-store-core.ts"),
    source("main/services/subagents/subagent-run-store-io.ts"),
    source("native/subagent-run-store/main.c"),
    source("package.json"),
    source("scripts/verify-macos-package.mjs"),
  ]);
  assert.match(store, /\(await storage\(\)\)\.cleanup\(\)/u);
  assert.match(store, /\(await storage\(\)\)\.read\(\)/u);
  assert.match(store, /\.write\(generation, contents\)/u);
  assert.doesNotMatch(store, /fs\.(?:open|readFile|rename|rm|readdir)\(/u);
  assert.match(
    transport,
    /process\.resourcesPath[\s\S]+"Helpers"[\s\S]+"aiden-subagent-run-store"/u,
  );
  assert.match(transport, /shell: false/u);
  assert.match(nativeStore, /openat\(directory_fd, STORE_FILE/u);
  assert.match(nativeStore, /renameatx_np\([\s\S]+RENAME_SWAP/u);
  assert.match(nativeStore, /renameatx_np\([\s\S]+RENAME_EXCL/u);
  assert.match(nativeStore, /same_renamed_file_identity/u);
  assert.match(
    packageJson,
    /"from": "build\/native\/aiden-subagent-run-store"[\s\S]+"to": "Helpers\/aiden-subagent-run-store"/u,
  );
  assert.match(
    verifier,
    /verifyUniversalMacOSHelper\(subagentRunStore,\s+"Private subagent run store"\)/u,
  );
  assert.match(verifier, /run\("\/usr\/bin\/lipo", \["-archs", file\]\)/u);
  assert.match(verifier, /"-arch",\s+architecture,\s+"-show-build"/u);
  assert.match(verifier, /verifySignature\(subagentRunStore/u);
  assert.match(verifier, /readEntitlements\(subagentRunStore\)/u);
});

test("chat removal deletes private child history before the chat can disappear", async () => {
  const [handler, applicationService, llm] = await Promise.all([
    source("main/handlers/chats.ts"),
    source("main/services/chat-application-service.ts"),
    source("main/services/llm-client.ts"),
  ]);
  const removalStart = handler.indexOf('ipcMain.handle("chats:remove"');
  const removalEnd = handler.indexOf('ipcMain.handle("chats:appendMessage"', removalStart);
  const removal = handler.slice(removalStart, removalEnd);
  const parseChatId = removal.indexOf('const chatId = asString(id, "id")');
  const botDelete = removal.indexOf("botApplicationService.deleteChat", parseChatId);
  const routeDesignDeletion = removal.indexOf("designProjectLifecycle.routeChatDeletion", botDelete);
  const ordinaryDelete = removal.indexOf("chatApplicationService.remove(ordinaryChatId)", routeDesignDeletion);
  assert.ok(removalStart >= 0);
  assert.ok(removalEnd > removalStart);
  assert.ok(parseChatId >= 0);
  assert.ok(botDelete > parseChatId);
  assert.ok(routeDesignDeletion > botDelete);
  assert.ok(ordinaryDelete > routeDesignDeletion);
  assert.doesNotMatch(removal, /chatStore\.remove\(/u);
  const beginDeletion = applicationService.indexOf("deps.llmClient.beginChatDeletion(chatId)");
  const cancel = applicationService.indexOf("deps.llmClient.cancelChat(chatId)");
  const deleteRuns = applicationService.indexOf(
    "await deps.subagentRunStore.deleteChat(chatId)",
    cancel,
  );
  const deleteChat = applicationService.indexOf("await deps.chatStore.remove(chatId,", deleteRuns);
  const deleteArtifacts = applicationService.indexOf(
    "await deps.displayImageArtifactStore.deleteChat(chatId)",
    deleteRuns,
  );
  const completeDeletion = applicationService.indexOf(
    "await deps.subagentRunStore.completeChatDeletion(chatId)",
    deleteChat,
  );
  const pendingDeletionCheck = applicationService.indexOf(
    "await deps.subagentRunStore.pendingChatDeletions()",
    completeDeletion,
  );
  const releaseAdmission = applicationService.indexOf(
    "if (releaseAdmission) finishDeletion()",
    completeDeletion,
  );
  assert.ok(beginDeletion >= 0);
  assert.ok(cancel > beginDeletion);
  assert.ok(deleteRuns > cancel);
  assert.ok(deleteArtifacts > deleteRuns);
  assert.ok(deleteChat > deleteArtifacts);
  assert.ok(completeDeletion > deleteChat);
  assert.ok(pendingDeletionCheck > completeDeletion);
  assert.ok(releaseAdmission > pendingDeletionCheck);

  const admissionCheck = llm.indexOf("chatDeletionGate.isDeleting(params.chatId)");
  const registerInitialization = llm.indexOf(
    "initializing.set(streamId, initialization)",
    admissionCheck,
  );
  const requireExistingChat = llm.indexOf(
    "await chatStore.get(params.chatId)",
    registerInitialization,
  );
  assert.ok(admissionCheck >= 0);
  assert.ok(registerInitialization > admissionCheck);
  assert.ok(requireExistingChat > registerInitialization);
  assert.doesNotMatch(
    applicationService.slice(beginDeletion, deleteRuns),
    /if \(!\(await deps\.chatStore\.get/u,
  );
});

test("renderer invalidation detaches while authority changes and shutdown still cancel", async () => {
  const [llm, workspaces, workspaceApplicationService, main] = await Promise.all([
    source("main/services/llm-client.ts"),
    source("main/handlers/workspaces.ts"),
    source("main/services/workspace-application-service.ts"),
    source("main/index.ts"),
  ]);
  assert.match(
    llm,
    /owner\.onInvalidated\(\(\) => \{\s+this\.detachRenderer\(streamId, owner\.documentId\);/u,
  );
  assert.match(llm, /this\.cancel\(streamId, "workspace_authority_change"\)/u);
  assert.match(llm, /this\.cancel\(streamId, "application_shutdown"\)/u);
  assert.match(workspaces, /workspaceApplicationService\.update\(/u);
  assert.match(workspaces, /workspaceApplicationService\.remove\(/u);
  assert.match(
    workspaceApplicationService,
    /await deps\.llmClient\.cancelWorkspaceAndSettle\(existing\.id\)/u,
  );
  assert.match(
    workspaceApplicationService,
    /await deps\.llmClient\.cancelWorkspaceAndSettle\(id\)/u,
  );
  assert.match(llm, /subagentRuntimeRegistry\.abortGeneration\(streamId\)/u);
  assert.match(llm, /subagentRuntimeRegistry\.abortChat\(chatId\)/u);
  assert.match(llm, /subagentRuntimeRegistry\.hasChatChildren\(chatId\)/u);
  assert.match(
    llm,
    /abortChildren: \(targetWorkspaceId\) => \{\s+subagentRuntimeRegistry\.abortWorkspace\(targetWorkspaceId\);/u,
  );
  assert.match(
    llm,
    /hasChildren: \(targetWorkspaceId\) =>\s+subagentRuntimeRegistry\.hasWorkspaceChildren\(targetWorkspaceId\)/u,
  );
  assert.match(main, /subagentRuntimeRegistry\.abortAll\(\)/u);
  assert.match(main, /subagentRuntimeRegistry\.shutdown\(\)/u);
});

test("empty-chat workspace moves serialize against generation authority and terminal persistence", async () => {
  const [handler, applicationService, llm, chatStore] = await Promise.all([
    source("main/handlers/chats.ts"),
    source("main/services/chat-application-service.ts"),
    source("main/services/llm-client.ts"),
    source("main/services/chat-store-core.ts"),
  ]);

  const moveHandler = handler.indexOf('ipcMain.handle(\n    "chats:moveEmptyToWorkspace"');
  assert.match(handler.slice(moveHandler), /chatApplicationService\.moveEmptyToWorkspace\(/u);
  const beginMove = applicationService.indexOf("deps.llmClient.beginChatWorkspaceChange(chatId)");
  const workspaceLookup = applicationService.indexOf(
    "await deps.configStore.getWorkspace(workspaceId)",
    beginMove,
  );
  const moveCommit = applicationService.indexOf(
    "await deps.chatStore.moveEmptyChatToWorkspace(",
    workspaceLookup,
  );
  assert.ok(moveHandler >= 0);
  assert.ok(beginMove >= 0);
  assert.ok(workspaceLookup > beginMove);
  assert.ok(moveCommit > workspaceLookup);

  const admissionCheck = llm.indexOf("chatWorkspaceMutationGate.isChanging(params.chatId)");
  const registerInitialization = llm.indexOf(
    "initializing.set(streamId, initialization)",
    admissionCheck,
  );
  assert.ok(admissionCheck >= 0);
  assert.ok(registerInitialization > admissionCheck);
  assert.match(
    llm,
    /beginChatWorkspaceChange\(chatId: string\)[\s\S]{0,240}chatWorkspaceMutationGate\.tryBegin\(chatId, this\.isChatBusy\(chatId\)\)/u,
  );
  assert.match(
    llm,
    /chatStore\.appendMessage\([\s\S]{0,900}expectedWorkspaceId: initialization\.workspaceId/u,
  );
  assert.match(
    chatStore,
    /meta\?\.expectedWorkspaceId !== undefined[\s\S]{0,240}chat\.workspaceId \?\? DEFAULT_WORKSPACE_ID/u,
  );
});

test("renderer message appends serialize against detached terminal persistence", async () => {
  const [handler, generationHandler, llm, schedule, surfaces] = await Promise.all([
    source("main/handlers/chats.ts"),
    source("main/handlers/chat.ts"),
    source("main/services/llm-client.ts"),
    source("main/services/schedule-execution.ts"),
    source("main/services/conversation-surface-generation.ts"),
  ]);
  const appendHandler = ipcHandlerStart(handler, "chats:appendMessage");
  const beginAppend = handler.indexOf(
    "llmClient.beginChatTurn(chatId, turnId, owner.documentId)",
    appendHandler,
  );
  const persist = handler.indexOf("chatStore.appendMessage(", beginAppend);
  const failureRelease = handler.indexOf("if (!appended) turn.release();", persist);

  assert.ok(appendHandler >= 0);
  assert.ok(beginAppend > appendHandler);
  assert.ok(persist > beginAppend);
  assert.ok(failureRelease > persist);
  const beginChatTurn = llm.indexOf(
    "beginChatTurn(",
    llm.indexOf("Claim one append-to-generation turn"),
  );
  const claimTurn = llm.indexOf("chatTurnAdmission.tryBegin(", beginChatTurn);
  assert.ok(beginChatTurn >= 0);
  assert.ok(claimTurn > beginChatTurn);
  const handoff = llm.indexOf("chatTurnAdmission.handoff(");
  const registerGeneration = llm.indexOf("initializing.set(streamId, initialization)", handoff);
  assert.ok(handoff >= 0);
  assert.ok(registerGeneration > handoff);
  assert.match(generationHandler, /turnId: messageTurnId/u);
  assert.match(
    schedule,
    /beginSurfaceGeneration\(llmClient\.beginChatTurn\.bind\(llmClient\), surface\)[\s\S]{0,900}chatStore\.appendMessage\([\s\S]{0,1600}startSurfaceGeneration\(/u,
  );
  assert.match(
    surfaces,
    /return beginChatTurn\(entry\.chatId, entry\.turnId, entry\.ownerId\)/u,
  );
  assert.match(surfaces, /turnId: input\.streamId/u);
  assert.match(
    schedule,
    /beginChatTurn\(\s*chatId,\s*turnId,\s*`scheduled-script:\$\{task\.id\}`,?\s*\)[\s\S]{0,1600}appendClaimedChatMessage/u,
  );
  assert.equal(
    (schedule.match(/turn\.settleAsyncWork\(\)/gu) ?? []).length,
    3,
    "every scheduled turn path must settle its claimed append frame",
  );
  assert.match(
    handler,
    /"chats:waitUntilIdle"[\s\S]{0,180}chatApplicationService\.waitUntilIdle\(asString\(id, "id"\)\)/u,
  );
  const applicationService = await source("main/services/chat-application-service.ts");
  assert.match(applicationService, /return deps\.llmClient\.waitForChatIdle\(chatId\)/u);
});

test("renderer turn tokens cross append and generation IPC without an admission gap", async () => {
  const [ipc, pane, assistant] = await Promise.all([
    source("renderer/lib/ipc.ts"),
    source("renderer/main/chat-pane.tsx"),
    source("renderer/components/assistant/use-assistant-chat.ts"),
  ]);

  assert.match(ipc, /appendMessage:[\s\S]{0,500}turnId: string[\s\S]{0,260}"chats:appendMessage"/u);
  assert.match(
    ipc,
    /startGeneration\([\s\S]{0,180}messageTurnId: string[\s\S]{0,220}const streamId = messageTurnId/u,
  );
  assert.match(ipc, /"chat:start",\s*streamId,\s*params,\s*messageTurnId/u);
  const turn = pane.indexOf("const messageTurnId = createChatTurnId()");
  const append = pane.indexOf("turnId: messageTurnId", turn);
  const generation = pane.indexOf("runGeneration(messageTurnId", append);
  assert.ok(turn >= 0 && append > turn && generation > append);
  assert.match(
    assistant,
    /const messageTurnId = createChatTurnId\(\)[\s\S]{0,4200}startGeneration\([\s\S]{0,2600}messageTurnId/u,
  );
  assert.match(assistant, /appendMessage\([\s\S]{0,360}turnId: messageTurnId/u);
  assert.match(assistant, /chatsApi\.abandonTurn\(chat\.id, messageTurnId\)/u);
});

test("main announces normalized settlement only after generation ownership exits", async () => {
  const llm = await source("main/services/llm-client.ts");
  const initializingExit =
    /initializing\.delete\(streamId\);\s*initialization\.removeOwnerInvalidation\(\);\s*approvals\.releaseStream\(streamId\);\s*questionnaires\.releaseStream\(streamId\);\s*broadcastChatSettled\(/gu;
  const activeExit =
    /active\.delete\(streamId\);\s*activeGeneration\.removeOwnerInvalidation\(\);\s*approvals\.releaseStream\(streamId\);\s*questionnaires\.releaseStream\(streamId\);\s*broadcastChatSettled\(/gu;

  assert.equal([...llm.matchAll(initializingExit)].length, 5);
  assert.equal([...llm.matchAll(activeExit)].length, 2);
  assert.match(
    llm,
    /const normalizedWorkspaceId = persistedChatWorkspaceId\(\s*workspaceId \?\? fallbackWorkspaceId,?\s*\)/u,
  );
  assert.match(
    llm,
    /!isSafeSubagentIdentifier\(chatId\)[\s\S]{0,100}!isSafeSubagentIdentifier\(normalizedWorkspaceId\)/u,
  );
  assert.match(llm, /ipcMain\.broadcast\("chats:settled", \{/u);
});

test("replacement chat reads mark bounded wait timeouts for retained renderer reconciliation", async () => {
  const [handler, applicationService, llm] = await Promise.all([
    source("main/handlers/chats.ts"),
    source("main/services/chat-application-service.ts"),
    source("main/services/llm-client.ts"),
  ]);
  const getHandler = ipcHandlerStart(handler, "chats:get");
  assert.match(handler.slice(getHandler), /chatApplicationService\.get\(asString\(id, "id"\)\)/u);
  const inactiveCheck = applicationService.indexOf(
    "deps.llmClient.isChatOwnedByInactiveRenderer(chatId)",
  );
  const idleWait = applicationService.indexOf(
    "await deps.llmClient.waitForChatIdle(chatId)",
    inactiveCheck,
  );
  const read = applicationService.indexOf("deps.chatStore.get(chatId)", idleWait);
  const response = applicationService.indexOf("reconciliation: reconciliationRequired", read);

  assert.ok(getHandler >= 0);
  assert.ok(inactiveCheck >= 0);
  assert.ok(idleWait > inactiveCheck);
  assert.ok(read > idleWait);
  assert.ok(response > read);
  assert.match(
    applicationService,
    /reconciliationRequired = !\(await deps\.llmClient\.waitForChatIdle\(chatId\)\)/u,
  );
  assert.match(
    applicationService,
    /reconciliationRequired \|\|= deps\.llmClient\.isChatOwnedByInactiveRenderer\(chatId\)/u,
  );
  const inactiveOwnerStart = llm.indexOf("isChatOwnedByInactiveRenderer(chatId: string)");
  const inactiveOwnerEnd = llm.indexOf("async waitForChatIdle", inactiveOwnerStart);
  assert.ok(inactiveOwnerStart >= 0);
  assert.ok(inactiveOwnerEnd > inactiveOwnerStart);
  const inactiveOwnerMethod = llm.slice(inactiveOwnerStart, inactiveOwnerEnd);
  assert.equal(
    [
      ...inactiveOwnerMethod.matchAll(
        /entry\.chatId === chatId\s*&&\s*entry\.owner\.id !== 0\s*&&\s*entry\.owner\.isDestroyed\(\)/gu,
      ),
    ].length,
    2,
  );
});

test("application startup reconciles private runs and worktree deletions before UI and schedules", async () => {
  const main = await source("main/index.ts");
  const initialize = main.indexOf("await subagentRunStore.initialize()");
  const recoverDesignProjects = main.indexOf("await designProjectLifecycle.recover()", initialize);
  const recoverDesignHandoffs = main.indexOf(
    "await designHandoffApplicationService.reconcileAtStartup()",
    initialize,
  );
  const reconcileDeletions = main.indexOf("await reconcilePendingChatDeletions(", initialize);
  const reconcileWorktrees = main.indexOf(
    "await reconcilePendingManagedWorktreeDeletions({",
    reconcileDeletions,
  );
  const finalizeOrphanedJournals = main.indexOf(
    "await gitFinalizeOrphanedManagedWorktreeDeletionJournals(",
    reconcileWorktrees,
  );
  const createWindow = main.indexOf("await createMainWindow()", finalizeOrphanedJournals);
  const startSchedules = main.indexOf("await scheduleService.start()", createWindow);
  assert.ok(initialize >= 0);
  assert.ok(recoverDesignProjects > initialize);
  assert.ok(recoverDesignHandoffs > initialize);
  assert.ok(reconcileDeletions > initialize);
  assert.ok(reconcileWorktrees > reconcileDeletions);
  assert.ok(finalizeOrphanedJournals > reconcileWorktrees);
  assert.ok(createWindow > finalizeOrphanedJournals);
  assert.ok(startSchedules > finalizeOrphanedJournals);
});

test("persisted chat workspace ownership closes generation admission before setup", async () => {
  const [llm, workspaces, workspaceApplicationService] = await Promise.all([
    source("main/services/llm-client.ts"),
    source("main/handlers/workspaces.ts"),
    source("main/services/workspace-application-service.ts"),
  ]);
  const chatRead = llm.indexOf("const chat = await chatStore.get(params.chatId)");
  const authority = llm.indexOf("authoritativeChatWorkspaceId(", chatRead);
  const designAuthority = llm.indexOf(
    "authoritativeDesignGenerationWorkspaceId(",
    authority,
  );
  const bindInitialization = llm.indexOf(
    "initialization.workspaceId = authoritativeWorkspaceId",
    designAuthority,
  );
  const admissionCheck = llm.indexOf(
    "workspaceMutationGate.isChanging(generationWorkspaceId)",
    bindInitialization,
  );
  const prepare = llm.indexOf("workspaceId: generationWorkspaceId", admissionCheck);
  const registerInitialization = llm.indexOf("initializing.set(streamId, initialization)");
  assert.ok(registerInitialization >= 0);
  assert.ok(chatRead > registerInitialization);
  assert.ok(authority > chatRead);
  assert.ok(designAuthority > authority);
  assert.ok(bindInitialization > designAuthority);
  assert.ok(admissionCheck > bindInitialization);
  assert.ok(prepare > admissionCheck);

  const updateHandler = ipcHandlerStart(workspaces, "workspaces:update");
  assert.match(
    workspaces.slice(updateHandler),
    /workspaceApplicationService\.update\(asString\(id, "id"\), patch\)/u,
  );
  const beginMutation = workspaceApplicationService.indexOf("deps.workspaceMutationGate.begin(id)");
  const drainWorkspaceOperations = workspaceApplicationService.indexOf(
    "await deps.workspaceOperationRegistry.cancelAndSettle(id)",
    beginMutation,
  );
  const cancelGeneration = workspaceApplicationService.indexOf(
    "await deps.llmClient.cancelWorkspaceAndSettle(existing.id)",
    beginMutation,
  );
  const saveWorkspace = workspaceApplicationService.indexOf(
    "deps.configStore.saveWorkspace(next)",
    cancelGeneration,
  );
  assert.ok(updateHandler >= 0);
  assert.ok(beginMutation >= 0);
  assert.ok(drainWorkspaceOperations > beginMutation);
  assert.ok(cancelGeneration > beginMutation);
  assert.ok(cancelGeneration > drainWorkspaceOperations);
  assert.ok(saveWorkspace > cancelGeneration);
  assert.match(
    workspaceApplicationService.slice(beginMutation, saveWorkspace),
    /await deps\.llmClient\.cancelWorkspaceAndSettle\(existing\.id\)/u,
  );
});

test("managed worktree deletion and terminal creation share workspace mutation admission", async () => {
  const [workspaces, worktreeApplicationService, terminal, terminalService, git] =
    await Promise.all([
      source("main/handlers/workspaces.ts"),
      source("main/services/workspace-worktree-application-service.ts"),
      source("main/handlers/terminal.ts"),
      source("main/services/terminal.ts"),
      source("main/services/git.ts"),
    ]);
  const deleteHandler = ipcHandlerStart(workspaces, "git:deleteManagedWorktree");
  const beginMutation = worktreeApplicationService.indexOf(
    "dependencies.beginWorkspaceMutation(workspaceId)",
  );
  const destructiveDelete = worktreeApplicationService.indexOf(
    "dependencies.deleteManagedWorktree(managed, signal)",
    beginMutation,
  );
  assert.ok(deleteHandler >= 0);
  assert.match(
    workspaces.slice(deleteHandler),
    /workspaceWorktreeApplicationService\.remove\(owner, id\)/u,
  );
  assert.ok(beginMutation >= 0);
  assert.ok(destructiveDelete > beginMutation);
  assert.match(
    worktreeApplicationService,
    /environment\.runRecord\([\s\S]+worktreeRegistered:[\s\S]+managedWorktreeRegistered\(managed\)/u,
  );
  assert.match(
    worktreeApplicationService.slice(beginMutation),
    /reconciledResult: \(\) => \(\{ branchDeleted: false \}\)/u,
  );
  assert.match(
    git,
    /rollbackWorktree\([\s\S]+created\.createdFromHead,[\s\S]+worktreeGitDir: created\.worktreeGitDir,[\s\S]+ownershipToken: created\.ownershipToken,[\s\S]+worktreeDevice: created\.worktreeDevice,[\s\S]+worktreeInode: created\.worktreeInode/u,
  );
  assert.doesNotMatch(git, /rollbackWorktreeCheckoutIdentity/u);

  assert.match(terminal, /workspaceMutationGate\.admit\(workspaceId\)/u);
  assert.match(terminal, /rendererDocumentOwner\(/u);
  assert.match(terminal, /owner\.onInvalidated\(onDestroyed\)/u);
  assert.match(terminal, /async \(\) => \{[\s\S]+const latest = await workspaceFolder/u);
  const revalidate = terminalService.indexOf("await revalidateAccess?.()");
  const finalAbortCheck = terminalService.indexOf("if (ownerInvalidated())", revalidate);
  const spawn = terminalService.indexOf("const { pty,", finalAbortCheck);
  const postSpawnCheck = terminalService.indexOf("if (ownerInvalidated())", spawn);
  assert.ok(revalidate >= 0);
  assert.ok(finalAbortCheck > revalidate);
  assert.ok(spawn > finalAbortCheck);
  assert.ok(postSpawnCheck > spawn);
});

test("managed worktree cleanup is root-bound, resumable, and packaged as signed native code", async () => {
  const [git, remover, nativeRemover, packageJson] = await Promise.all([
    source("main/services/git.ts"),
    source("main/services/managed-worktree-remover.ts"),
    source("native/worktree-remover/main.c"),
    source("package.json"),
  ]);
  assert.match(
    git,
    /await this\.worktreeDirectoryRemover\(\{[\s\S]+path: checkoutRemovalPath![\s\S]+inode: worktreeInode[\s\S]+authorize: async \(scannedPath, manifestDigest\)[\s\S]+`--work-tree=\$\{scannedPath\}`/u,
  );
  assert.match(
    git,
    /await this\.worktreeDirectoryRemover\(\{[\s\S]+path: adminRemovalPath![\s\S]+inode: adminIdentity\.inode/u,
  );
  assert.match(git, /"checkout_cleanup_started"/u);
  assert.match(git, /"admin_cleanup_started"/u);
  assert.match(git, /\.aiden-authorizing-/u);
  assert.match(git, /finalizeMissingWorktreeRemovalRoot\(/u);
  assert.match(git, /manifestDigest === null/u);
  assert.match(git, /worktreeRemovalManifestInspector\(targetPath\)/u);
  assert.match(
    git,
    /error\.failure === "identity_changed" \|\| error\.failure === "mutation_detected"/u,
  );
  assert.doesNotMatch(git, /fs\.rm\(removal\.(?:checkout|gitDir)/u);
  assert.match(remover, /shell: false/u);
  assert.match(remover, /const expectedAuthorizationName = `\.aiden-authorizing-\$\{token\}`/u);
  assert.match(remover, /identity\.authorize\?\.\(scannedPath, scannedManifestDigest\)/u);
  assert.match(remover, /child\.stdin\.end\("abort\\n"\)/u);
  assert.match(remover, /"--manifest-mode"/u);
  assert.match(remover, /path\.basename\(binary\) !== "aiden-worktree-remover-test"/u);
  assert.match(remover, /managedWorktreeRemovalManifestPresent/u);
  assert.match(remover, /await syncDirectory\(path\.dirname\(manifestPath\)\)/u);
  assert.match(remover, /`\$\{manifestPath\}\.finalizing`/u);
  assert.match(remover, /`\$\{manifestPath\}\.deleting`/u);
  assert.match(
    remover,
    /"finalize-manifest",[\s\S]+"--parent",[\s\S]+"--token",[\s\S]+"--digest"/u,
  );
  assert.match(remover, /PATH: "\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/u);
  assert.doesNotMatch(remover, /fs\.rename\(/u);
  assert.doesNotMatch(remover, /createHash/u);
  assert.doesNotMatch(remover, /\.\.\.additionalEnvironment/u);
  assert.match(nativeRemover, /renameatx_np\([\s\S]+RENAME_EXCL/u);
  assert.match(nativeRemover, /AUTHORIZATION_PREFIX/u);
  assert.match(
    nativeRemover,
    /entry_binding\([\s\S]+parent_binding[\s\S]+entry->identity\.st_ino/u,
  );
  assert.match(nativeRemover, /if \(original_exists && isolated_exists\)/u);
  assert.match(
    nativeRemover,
    /validate_manifest_subset\([\s\S]+isolated_name[\s\S]+seen\[current_index\]/u,
  );
  assert.match(nativeRemover, /MANIFEST_FINALIZING_SUFFIX "\.finalizing"/u);
  assert.match(nativeRemover, /MANIFEST_DELETING_SUFFIX "\.deleting"/u);
  assert.match(nativeRemover, /"finalize-manifest"/u);
  assert.match(nativeRemover, /finalize_manifest_command[\s\S]+O_DIRECTORY \| O_NOFOLLOW/u);
  assert.match(nativeRemover, /inspect_manifest_stages/u);
  assert.match(
    nativeRemover,
    /renameatx_np\(parent_fd, manifest_name, parent_fd, finalizing_name,[\s\S]+verify_manifest_capture[\s\S]+renameatx_np\(parent_fd, finalizing_name, parent_fd, deleting_name,/u,
  );
  const captureNameStart = nativeRemover.indexOf("static int make_capture_name");
  const captureNameEnd = nativeRemover.indexOf(
    "static int capture_validated_entry",
    captureNameStart,
  );
  assert.ok(captureNameStart >= 0 && captureNameEnd > captureNameStart);
  const captureNameSource = nativeRemover.slice(captureNameStart, captureNameEnd);
  assert.match(nativeRemover, /#define CAPTURE_PREFIX "\.aiden-capture-"/u);
  assert.match(captureNameSource, /unsigned char random\[16\]/u);
  assert.match(captureNameSource, /arc4random_buf\(random, sizeof\(random\)\)/u);
  assert.equal(nativeRemover.match(/arc4random_buf/gu)?.length, 1);
  const entryBindingStart = nativeRemover.indexOf("entry_binding(");
  const entryBindingEnd = nativeRemover.indexOf("static int root_binding", entryBindingStart);
  assert.ok(entryBindingStart >= 0 && entryBindingEnd > entryBindingStart);
  assert.doesNotMatch(nativeRemover.slice(entryBindingStart, entryBindingEnd), /arc4random/u);
  assert.match(
    nativeRemover,
    /renameatx_np\(directory_fd, source_name, directory_fd, capture_name,[\s\S]+RENAME_EXCL/u,
  );
  assert.match(remover, /process\.resourcesPath[\s\S]+"Helpers"[\s\S]+"aiden-worktree-remover"/u);
  assert.match(
    packageJson,
    /"from": "build\/native\/aiden-worktree-remover"[\s\S]+"to": "Helpers\/aiden-worktree-remover"/u,
  );
  assert.match(
    packageJson,
    /"pretest:subagents": "npm run build:worktree-remover[\s\S]+build:subagent-run-store/u,
  );
});

test("every workspace path capability is renderer-document owned and mutation admitted", async () => {
  const [workspaces, environment, operations, git] = await Promise.all([
    source("main/handlers/workspaces.ts"),
    source("main/services/workspace-environment-application-service.ts"),
    source("main/services/workspace-operation-registry.ts"),
    source("main/services/git.ts"),
  ]);

  assert.match(workspaces, /rendererDocumentOwner\(\s*event,/u);
  assert.match(workspaces, /workspaceEnvironmentApplicationService\.run(?:Optional)?\(/u);
  assert.match(environment, /admitOwnedWorkspaceOperation\(/u);
  assert.doesNotMatch(workspaces, /sender\.once\("destroyed"/u);
  assert.match(operations, /owner\.onInvalidated\(cancel\)/u);

  for (const channel of ["git:worktrees", "workspaces:openFolder", "workspaces:openInEditor"]) {
    assert.match(
      ipcHandlerSource(workspaces, channel),
      /withWorkspaceOperation\(\s*event,\s*workspaceId,/u,
      `${channel} must use workspace operation admission`,
    );
  }
  for (const channel of ["workspaces:gitInfo", "git:branches"]) {
    assert.match(
      ipcHandlerSource(workspaces, channel),
      /withOptionalWorkspaceOperation\(\s*event,\s*workspaceId,/u,
      `${channel} must preserve no-access fallback through operation admission`,
    );
  }

  assert.match(ipcHandlerSource(workspaces, "workspaces:gitInfo"), /gitInfo\(.+signal\)/u);
  assert.match(ipcHandlerSource(workspaces, "git:branches"), /gitBranches\(.+signal\)/u);
  assert.match(ipcHandlerSource(workspaces, "git:worktrees"), /gitWorktrees\(.+signal\)/u);
  assert.match(git, /async info\(cwd: string, signal\?: AbortSignal\)/u);
  assert.match(git, /async branches\(cwd: string, signal\?: AbortSignal\)/u);
  assert.match(git, /async worktrees\(cwd: string, signal\?: AbortSignal\)/u);
});

test("managed worktree identity gates generation, terminal, scheduled, and workspace capabilities", async () => {
  const [llm, terminal, scheduled, workspaces, environment, admission] = await Promise.all([
    source("main/services/llm-client.ts"),
    source("main/handlers/terminal.ts"),
    source("main/services/schedule-execution.ts"),
    source("main/handlers/workspaces.ts"),
    source("main/services/workspace-environment-application-service.ts"),
    source("main/services/managed-worktree-admission.ts"),
  ]);
  assert.match(
    llm,
    /if \(workspace && !botBound\) await assertManagedWorktreeAdmission\(workspace\)/u,
  );
  assert.match(llm, /botContext\?\.prepared\.workspace/u);
  assert.match(terminal, /workspaceFolder[\s\S]+assertManagedWorktreeAdmission\(workspace\)/u);
  assert.match(terminal, /ensureSessionAccess[\s\S]+assertManagedWorktreeAdmission\(workspace\)/u);
  assert.match(scheduled, /executeScript[\s\S]+assertManagedWorktreeAdmission\(workspace\)/u);
  assert.match(scheduled, /executeLlm[\s\S]+assertManagedWorktreeAdmission\(workspace\)/u);
  assert.match(environment, /resolve[\s\S]+assertManagedWorktreeAdmission\(workspace\)/u);
  assert.match(
    workspaces,
    /workspaces:openInEditor[\s\S]+withWorkspaceOperation\(event, workspaceId,/u,
  );
  const deletionIntent = admission.indexOf("await deletionPending(");
  const usabilityCheck = admission.indexOf("usable = await verify(");
  assert.ok(deletionIntent >= 0);
  assert.ok(usabilityCheck > deletionIntent);
});

test("terminal writes pause across workspace mutations and documents lose PTYs on reload", async () => {
  const [terminal, workspaces, workspaceApplicationService, worktreeApplicationService, main] =
    await Promise.all([
      source("main/handlers/terminal.ts"),
      source("main/handlers/workspaces.ts"),
      source("main/services/workspace-application-service.ts"),
      source("main/services/workspace-worktree-application-service.ts"),
      source("main/index.ts"),
    ]);
  const accessCheck = terminal.indexOf("async function ensureSessionAccess");
  const admissionWrapper = terminal.indexOf("commitWithWorkspaceMutationAdmission(", accessCheck);
  const permissionRead = terminal.indexOf(
    "await configStore.getWorkspace(workspaceId)",
    accessCheck,
  );
  const managedAdmission = terminal.indexOf(
    "await assertManagedWorktreeAdmission(workspace)",
    permissionRead,
  );
  const finalMutationCheck = terminal.indexOf("if (mutationSignal.aborted)", managedAdmission);
  const writeHandler = ipcHandlerStart(terminal, "terminal:write");
  const guardedWrite = terminal.indexOf("withSessionAccess(owner, id", writeHandler);
  assert.ok(accessCheck >= 0);
  assert.ok(admissionWrapper > accessCheck);
  assert.ok(permissionRead > accessCheck);
  assert.ok(managedAdmission > permissionRead);
  assert.ok(finalMutationCheck > managedAdmission);
  assert.ok(guardedWrite > writeHandler);

  const updateHandler = ipcHandlerStart(workspaces, "workspaces:update");
  assert.match(
    workspaces.slice(updateHandler),
    /workspaceApplicationService\.update\(asString\(id, "id"\), patch\)/u,
  );
  const updateMethod = workspaceApplicationService.indexOf("async update(");
  const permissionChange = workspaceApplicationService.indexOf(
    "if (next.permission === existing.permission)",
    updateMethod,
  );
  const updateTerminalClose = workspaceApplicationService.indexOf(
    "deps.terminalService.closeForWorkspace(existing.id)",
    permissionChange,
  );
  const updateScheduleRestoration = workspaceApplicationService.lastIndexOf(
    "withWorkspaceScheduleRestoration(",
    updateTerminalClose,
  );
  const updateScheduleCancel = workspaceApplicationService.indexOf(
    "await deps.scheduleService.cancelWorkspace(existing.id)",
    permissionChange,
  );
  assert.ok(updateTerminalClose > permissionChange);
  assert.ok(updateScheduleRestoration > permissionChange);
  assert.ok(updateTerminalClose > updateScheduleRestoration);
  const updateGenerationDrain = workspaceApplicationService.indexOf(
    "await deps.llmClient.cancelWorkspaceAndSettle(existing.id)",
    permissionChange,
  );
  assert.ok(updateGenerationDrain > updateTerminalClose);
  assert.ok(updateScheduleCancel > updateTerminalClose);
  const updateSave = workspaceApplicationService.indexOf(
    "await deps.configStore.saveWorkspace(next)",
    updateScheduleCancel,
  );
  const armPostSaveResume = workspaceApplicationService.indexOf(
    "ensureResumedOnExit()",
    updateSave,
  );
  const firstPostSaveResume = workspaceApplicationService.indexOf(
    "await deps.scheduleService.resumeWorkspace(saved.id)",
    armPostSaveResume,
  );
  assert.ok(updateSave > updateScheduleCancel);
  assert.ok(armPostSaveResume > updateSave);
  assert.ok(firstPostSaveResume > armPostSaveResume);

  const removeHandler = ipcHandlerStart(workspaces, "workspaces:remove");
  assert.match(
    workspaces.slice(removeHandler),
    /workspaceApplicationService\.remove\(asString\(id, "id"\)\)/u,
  );
  const removeMethod = workspaceApplicationService.indexOf("async remove(");
  const removeTerminalClose = workspaceApplicationService.indexOf(
    "deps.terminalService.closeForWorkspace(id)",
    removeMethod,
  );
  const removeWorkspaceRead = workspaceApplicationService.indexOf(
    "await deps.configStore.getWorkspace(id)",
    removeMethod,
  );
  const managedRemovalGuard = workspaceApplicationService.indexOf(
    "assertWorkspaceRecordRemovalAllowed(existing)",
    removeWorkspaceRead,
  );
  const removeOperationDrain = workspaceApplicationService.indexOf(
    "await deps.workspaceOperationRegistry.cancelAndSettle(id)",
    removeMethod,
  );
  const removeScheduleRestoration = workspaceApplicationService.indexOf(
    "withWorkspaceScheduleRestoration(",
    removeWorkspaceRead,
  );
  assert.ok(removeTerminalClose > removeMethod);
  assert.ok(removeOperationDrain > removeMethod);
  assert.ok(removeWorkspaceRead > removeOperationDrain);
  assert.ok(removeTerminalClose > removeWorkspaceRead);
  assert.ok(managedRemovalGuard > removeTerminalClose);
  assert.ok(removeScheduleRestoration > managedRemovalGuard);
  const removeGenerationDrain = workspaceApplicationService.indexOf(
    "await deps.llmClient.cancelWorkspaceAndSettle(id)",
    removeWorkspaceRead,
  );
  const removeRecord = workspaceApplicationService.indexOf(
    "await deps.configStore.removeWorkspace(id)",
    removeGenerationDrain,
  );
  assert.ok(removeGenerationDrain > removeWorkspaceRead);
  assert.ok(removeGenerationDrain > removeScheduleRestoration);
  assert.ok(removeRecord > removeGenerationDrain);

  const managedDelete = ipcHandlerStart(workspaces, "git:deleteManagedWorktree");
  assert.match(
    workspaces.slice(managedDelete),
    /workspaceWorktreeApplicationService\.remove\(owner, id\)/u,
  );
  const managedRemove = worktreeApplicationService.indexOf("const remove = async (");
  const managedTerminalClose = worktreeApplicationService.indexOf(
    "dependencies.closeWorkspaceTerminals(workspaceId)",
    managedRemove,
  );
  const managedScheduleCancel = worktreeApplicationService.indexOf(
    "await dependencies.cancelWorkspaceSchedules(workspaceId)",
    managedTerminalClose,
  );
  const managedScheduleRestoration = worktreeApplicationService.indexOf(
    "withWorkspaceScheduleRestoration(",
    managedRemove,
  );
  assert.ok(managedTerminalClose > managedRemove);
  assert.ok(managedScheduleRestoration > managedRemove);
  assert.ok(managedTerminalClose > managedScheduleRestoration);
  const managedGenerationDrain = worktreeApplicationService.indexOf(
    "await dependencies.cancelWorkspaceGeneration(workspaceId)",
    managedTerminalClose,
  );
  const managedOperationDrain = worktreeApplicationService.indexOf(
    "await dependencies.cancelWorkspaceOperations(workspaceId, signal)",
    managedRemove,
  );
  const managedWorktreeRemoval = worktreeApplicationService.indexOf(
    "const deletion = await removeManagedWorkspace",
    managedGenerationDrain,
  );
  const managedDeletionFinalize = worktreeApplicationService.indexOf(
    "await dependencies.finalizeManagedWorktreeDeletion(managed)",
    managedWorktreeRemoval,
  );
  const managedDeleteReturn = worktreeApplicationService.indexOf(
    "return deletion",
    managedDeletionFinalize,
  );
  assert.ok(managedGenerationDrain > managedTerminalClose);
  assert.ok(managedOperationDrain > managedRemove);
  assert.ok(managedGenerationDrain > managedOperationDrain);
  assert.ok(managedWorktreeRemoval > managedGenerationDrain);
  assert.ok(managedDeletionFinalize > managedWorktreeRemoval);
  assert.ok(managedDeleteReturn > managedDeletionFinalize);
  assert.ok(managedScheduleCancel > managedTerminalClose);
  assert.match(
    worktreeApplicationService.slice(managedRemove),
    /destructiveMutationAttempted:[\s\S]+GitManagedWorktreeDeleteError[\s\S]+destructiveMutationAttempted/u,
  );
  assert.match(
    worktreeApplicationService.slice(managedRemove),
    /worktreeUsable:[\s\S]+managedWorktreeUsable\(managed\)/u,
  );
  assert.match(
    worktreeApplicationService.slice(managedRemove),
    /deletionPending:[\s\S]+managedWorktreeDeletionPending\(managed\)/u,
  );
  assert.match(
    worktreeApplicationService,
    /commitManagedWorktreeCreation\([\s\S]+removeWorkspaceRecord:[\s\S]+removeWorkspace\(savedWorkspace\.id\)[\s\S]+rollbackWorktree:/u,
  );

  const didStartLoading = main.indexOf('webContents.on("did-start-loading"');
  const renderProcessGone = main.indexOf('webContents.on("render-process-gone"');
  const readyToShow = main.indexOf('createdWindow.once("ready-to-show"', renderProcessGone);
  assert.match(
    main.slice(didStartLoading, renderProcessGone),
    /terminalService\.closeForWebContents\(createdWebContentsId\)/u,
  );
  assert.match(
    main.slice(renderProcessGone, readyToShow),
    /terminalService\.closeForWebContents\(createdWebContentsId\)/u,
  );
});

test("subagent history IPC applies the shared privacy validator before storage and logging", async () => {
  const handler = await source("main/handlers/subagents.ts");
  const featureGate = handler.indexOf("assertSubagentHistoryEnabled();");
  const ownerResolution = handler.indexOf("rendererDocumentOwner(", featureGate);
  const validation = handler.indexOf("parseSubagentHistoryRequestIds(");
  const guardedRead = handler.indexOf("try {", validation);
  const chatRead = handler.indexOf("getChat:", guardedRead);
  const snapshotRead = handler.indexOf("getSnapshot:", guardedRead);
  const logging = handler.indexOf('logger.error("subagents"', guardedRead);
  assert.ok(featureGate >= 0);
  assert.ok(ownerResolution > featureGate);
  assert.ok(validation > ownerResolution);
  assert.ok(validation >= 0);
  assert.ok(guardedRead > validation);
  assert.ok(chatRead > guardedRead);
  assert.ok(snapshotRead > guardedRead);
  assert.ok(logging > guardedRead);
  assert.doesNotMatch(handler, /const SAFE_ID|function asId/u);
});

test("child tool telemetry stops before crossing its execution cap", async () => {
  const runner = await source("main/services/subagents/subagent-child-runner.ts");
  const toolEvent = runner.indexOf('event.type === "tool_execution_start"');
  const cap = runner.indexOf("if (toolCalls >= policy.maxToolCalls)", toolEvent);
  const telemetry = runner.indexOf("input.telemetry?.toolStarted", toolEvent);
  assert.ok(toolEvent >= 0);
  assert.ok(cap > toolEvent);
  assert.ok(telemetry > cap);
});

test("foreground child egress reaches the owner-bound approval UI and consumes at effect time", async () => {
  const [llm, persistence, runner, runtime, chatPane] = await Promise.all([
    source("main/services/llm-client.ts"),
    source("main/services/subagents/subagent-foreground-persistence-v2.ts"),
    source("main/services/subagents/subagent-child-runner.ts"),
    source("main/services/subagents/child-agent-runtime.ts"),
    source("renderer/main/chat-pane.tsx"),
  ]);
  const requestApproval = llm.indexOf(
    "requestApproval: (descriptor, approvalSignal, approvalOwnerDocumentId)",
  );
  const approvalDispatch = llm.indexOf(
    ".request(descriptor, approvalSignal, approvalOwnerDocumentId)",
    requestApproval,
  );
  assert.ok(requestApproval >= 0);
  assert.ok(approvalDispatch > requestApproval);
  assert.match(persistence, /createSubagentOutboundApprovalBrokerV2\(/u);
  assert.match(persistence, /revokedRuns\.has\(runId\) \? undefined : authorities\.get\(runId\)/u);
  const consume = runner.indexOf("outboundApproval.consume({");
  const execute = runner.indexOf("return execute(toolCallId, args, signal);", consume);
  assert.ok(consume >= 0);
  assert.ok(execute > consume);
  assert.match(runtime, /beforeToolCall: spec\.beforeToolCall/u);
  assert.match(chatPane, /needs approval/u);
  assert.match(chatPane, /"Allow once"/u);
});

test("independent child egress rollbacks are evaluated before Web Search readiness or MCP inventory", async () => {
  const llm = await source("main/services/llm-client.ts");
  const webRollout = llm.indexOf("const childWebRollout = subagentChildWebEnabled()");
  const webReadiness = llm.indexOf("await webSearchService.availability()", webRollout);
  const mcpRollout = llm.indexOf("const childMcpRollout = subagentChildMcpEnabled()");
  const mcpInventory = llm.indexOf("resolveProductionSubagentMcpInventory(signal)", mcpRollout);
  assert.ok(webRollout >= 0);
  assert.ok(webReadiness > webRollout);
  assert.match(llm.slice(webRollout, webReadiness), /childWebRollout\s*&&/u);
  assert.ok(mcpRollout >= 0);
  assert.ok(mcpInventory > mcpRollout);
  assert.match(llm.slice(mcpRollout, mcpInventory), /childMcpRollout\s*&&/u);
});

test("production OAuth transport observes bounded credentials before use or persistence", async () => {
  const [mcp, oauth, clientCore, credentialCore] = await Promise.all([
    source("main/services/mcp.ts"),
    source("main/services/mcp-oauth.ts"),
    source("main/services/subagents/subagent-mcp-client-core.ts"),
    source("main/services/subagents/subagent-mcp-credential-core.ts"),
  ]);
  assert.match(mcp, /createSubagentMcpOAuthTokenObserver\(options\.registerCredentialRedactor\)/u);
  assert.match(
    mcp,
    /oauthProviderFor\(server, isCurrent, \(tokens\) =>[\s\S]{0,180}observeOAuthTokens/u,
  );
  assert.match(
    clientCore,
    /makeTransport\([\s\S]{0,320}authenticated[\s\S]{0,320}registerCredentialRedactor/u,
  );
  assert.match(
    credentialCore,
    /observed\.has\(fingerprint\)[\s\S]{0,260}MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS[\s\S]{0,220}register\(createSubagentMcpOAuthTokenRedactor\(tokens\)\)/u,
  );

  const tokensMethod = oauth.slice(
    oauth.indexOf("async tokens():"),
    oauth.indexOf("async saveTokens(", oauth.indexOf("async tokens():")),
  );
  assert.ok(tokensMethod.indexOf("this.observeTokens?.(tokens)") >= 0);
  assert.ok(
    tokensMethod.indexOf("this.observeTokens?.(tokens)") < tokensMethod.indexOf("return tokens"),
  );
  const saveTokensMethod = oauth.slice(
    oauth.indexOf("async saveTokens("),
    oauth.indexOf("async saveCodeVerifier(", oauth.indexOf("async saveTokens(")),
  );
  assert.ok(saveTokensMethod.indexOf("this.observeTokens?.(tokens)") >= 0);
  assert.ok(
    saveTokensMethod.indexOf("this.observeTokens?.(tokens)") <
      saveTokensMethod.indexOf("await this.boundSession()"),
  );
});
