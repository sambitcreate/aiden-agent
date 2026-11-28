/**
 * Handler Registration
 *
 * Registers every IPC channel synchronously before startup IPC admission opens,
 * forwarding subsystem channels through memoized dynamic `import()` loaders on
 * first invocation so cold startup only evaluates core window/bootstrap code.
 */

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain, logger } from "../platform.js";
import { analyticsService } from "../services/analytics/analytics-main.js";
import {
  hostPlatformCapabilities,
  type HostPlatformCapabilities,
} from "../services/host-platform-capabilities.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { createImagesEnabled } from "../services/studio/feature-flags.js";
import { registerAnalyticsHandlers } from "./analytics.js";
import { registerBotSurfaceLazyGroups } from "./bot-lazy-groups.js";
import { registerDiagnosticHandlers } from "./diagnostics.js";
import { registerLazyIpcGroup, type LazyIpcGroup } from "./lazy-ipc.js";

const APP_CONTROL_CHANNELS = [
  "settings:controls:navigation-ack",
  "settings:controls:get",
  "settings:controls:apply",
] as const;

const PROVIDER_CHANNELS = [
  "providers:list",
  "providers:normalizeArtwork",
  "providers:auth:status",
  "providers:auth:start",
  "providers:auth:respond",
  "providers:auth:cancel",
  "providers:logout",
  "providers:validateOnboardingApiKey",
  "providers:save",
  "providers:remove",
  "providers:test",
  "providers:listModels",
  "providers:setConnectorKeySharing",
  "providers:refresh",
  "providers:refreshIfStale",
  "providers:catalogStatus",
  "models:info",
  "providers:updateCatalogs",
  "settings:get",
  "settings:getAppearance",
  "settings:getAppearanceState",
  "settings:previewAppearance",
  "settings:setGoogleThinking",
  "settings:setCodexThinking",
  "settings:setCompactionModelBudget",
  "settings:setAnthropicThinking",
  "settings:setProviderThinking",
  "settings:setModelVisibility",
  "settings:showAllProviderModels",
  "settings:hideAllProviderModels",
  "settings:setGeminiVoiceSetup",
  "settings:setGeminiUsageScope",
  "settings:setAgentSlider",
  "settings:seedAgentSlider",
  "settings:set",
] as const;

const ACP_HARNESS_CHANNELS = [
  "providers:harness:status",
  "providers:harness:install",
  "providers:harness:cancel",
  "providers:harness:remove",
] as const;

const CHAT_HISTORY_CHANNELS = [
  "chats:createWithFirstMessage",
  "chats:activitySnapshot",
  "chats:readMarkers",
  "chats:triage",
  "chats:setTriage",
  "chats:markRead",
  "chats:list",
  "chats:get",
  "chats:replyInterrupted",
  "chats:interruptedWaits",
  "chats:dismissInterruptedWait",
  "chats:todoSnapshot",
  "chats:waitUntilIdle",
  "chats:contextPressure",
  "chats:compact",
  "chats:cancelCompact",
  "chats:releaseCacheWarming",
  "chats:create",
  "chats:rename",
  "chats:renameWithFoundationModels",
  "chats:setModel",
  "chats:setDesignMode",
  "chats:retryForkSummary",
  "chats:cancelForkSummary",
  "chats:skipForkSummary",
  "chats:copyVisibleHistory",
  "chats:export",
  "chats:moveEmptyToWorkspace",
  "chats:promoteEphemeral",
  "chats:inspectAttachFiles",
  "chats:attachToWorkspace",
  "chats:dismissComputerUseContinue",
  "chats:remove",
  "chats:appendMessage",
  "chats:htmlArtifactSrcdoc",
  "chats:updateUiVisualState",
  "chats:exportHtmlArtifact",
  "chats:abandonTurn",
] as const;

const DESIGN_WINDOW_CHANNELS = [
  "app:widenForDesign",
  "app:designWindowCanWiden",
] as const;

const CHAT_PENDING_ATTENTION_CHANNELS = [
  "chats:pendingAttention",
  "chats:dismissDetachedAttention",
] as const;

const CHAT_GENERATION_CHANNELS = [
  "chat:start",
  "chat:cancel",
  "chat:admitRunInput",
  "chat:approve",
  "chat:listApprovalRules",
  "chat:revokeApprovalRule",
  "chat:revokeAllApprovalRules",
  "chat:answerQuestionnaire",
  "chat:claimHandoff",
] as const;

const WORKSPACE_CHANNELS = [
  "workspaces:list",
  "workspaces:memoryFacts",
  "workspaces:deleteMemoryFact",
  "workspaces:get",
  "workspaces:create",
  "workspaces:createFromFolder",
  "workspaces:inspectPath",
  "workspaces:openPath",
  "workspaces:clonePreview",
  "workspaces:clone",
  "workspaces:cloneCancel",
  "workspaces:createScratch",
  "workspaces:createNoWorkspace",
  "workspaces:update",
  "workspaces:remove",
  "workspaces:gitInfo",
  "workspaces:repositoryIdentity",
  "git:pullRequestStatus",
  "workspaces:files",
  "workspaces:readFile",
  "workspaces:writeFile",
  "git:review",
  "git:diff",
  "git:commit",
  "git:pushCapability",
  "git:push",
  "git:compare",
  "git:comparisonDiff",
  "git:branches",
  "git:checkout",
  "git:createBranch",
  "git:worktrees",
  "git:createWorktree",
  "git:deleteManagedWorktree",
  "git:restoreManagedWorktree",
  "workspaces:folderPresence",
  "workspaces:restoreDeletedWorktree",
  "workspaces:openFolder",
  "workspaces:externalEditors",
  "workspaces:openInEditor",
] as const;

const PULL_REQUEST_CHANNELS = [
  "pullRequests:list",
  "pullRequests:current",
  "pullRequests:sidebar",
  "pullRequests:candidates",
  "pullRequests:link",
  "pullRequests:linkRef",
  "pullRequests:unlink",
  "pullRequests:refresh",
  "pullRequests:detectAfterPush",
  "pullRequests:create",
  "pullRequests:dismissPending",
  "pullRequests:pending",
  "pullRequests:adopt",
] as const;

const WORKSPACE_ARTIFACT_CHANNELS = [
  "workspaces:artifacts:list",
  "workspaces:artifacts:rename",
  "workspaces:artifacts:delete",
  "workspaces:artifacts:saveState",
  "workspaces:artifacts:approve",
  "workspaces:artifacts:history",
  "workspaces:artifacts:restore",
  "workspaces:artifacts:export",
  "workspaces:artifacts:importPreview",
  "workspaces:artifacts:importConfirm",
  "workspaces:artifacts:keepVisual",
  "workspaces:artifacts:importDiscard",
  "workspaces:artifacts:refresh",
  "workspaces:artifacts:run",
] as const;

const ATTACHMENT_CHANNELS = [
  "attachments:pickAndRead",
  "aiden:attachments:dropped-read",
  "aiden:attachments:clipboard-read",
] as const;

const CHAT_IMAGE_ACTION_CHANNELS = [
  "chats:saveImageToDownloads",
  "chats:copyImage",
  "chats:showSavedImage",
  "chats:imageData",
] as const;

const TRANSCRIPT_IMAGE_CHANNELS = ["chat:loadTranscriptImage"] as const;

const PHASE2_CHANNELS = [
  "skills:list",
  "skills:save",
  "skills:remove",
  "skills:catalog",
  "skills:workspaceChoices",
  "skills:discovered",
  "mcp:list",
  "mcp:presets",
  "mcp:setPresetKey",
  "mcp:save",
  "mcp:remove",
  "mcp:status",
  "mcp:providerAuth",
  "mcp:oauthStatus",
  "mcp:composioWatch:inspect",
  "mcp:authorize",
  "mcp:cancelAuthorize",
  "mcp:signOut",
  "mcp:testDraft",
  "mcp:dependents",
  "mcp:liveStatus",
  "mcp:launchApprovals",
  "mcp:approveLaunch",
  "mcp:toolList",
  "mcp:macAppStatus",
  "mcp:openMacApp",
  "mcp:reconnect",
  "webSearch:get",
  "webSearch:existingAuth:get",
  "webSearch:existingAuth:consent",
  "webSearch:existingAuth:revoke",
  "webSearch:setEnabled",
  "webSearch:setSelection",
  "webSearch:setAutomaticRoute",
  "webSearch:setProviderConfig",
  "webSearch:setCredential",
  "webSearch:removeCredential",
  "webSearch:keyPool:get",
  "webSearch:keyPool:add",
  "webSearch:keyPool:remove",
  "webSearch:keyPool:reorder",
  "webSearch:keyPool:setStrategy",
  "webSearch:keyPool:resetCooldown",
  "webSearch:pages:get",
  "webSearch:pages:setEnabled",
  "webSearch:pages:setExtractEnabled",
  "webSearch:pages:setExtractAccountId",
  "voice:transcribe",
  "voice:transcribeCancel",
  "voice:streamStart",
  "voice:streamPush",
  "voice:streamFinish",
  "voice:streamCancel",
] as const;

const LOCAL_VOICE_CHANNELS = [
  "localVoice:status",
  "localVoice:warm",
  "voice:resolveProvider",
  "localModels:list",
  "localModels:download",
  "localModels:cancel",
  "localModels:delete",
  "voice:transcribeLocal",
  "voice:localLiveStart",
  "voice:localLivePush",
  "voice:localLiveStop",
  "voice:transcribeLocalCancel",
] as const;

const TERMINAL_CHANNELS = [
  "terminal:create",
  "terminal:snapshot",
  "terminal:write",
  "terminal:resize",
  "terminal:close",
  "terminal:foregroundCommand",
] as const;

const TITLE_PROVIDER_CHANNELS = [
  "titleProviders:status",
  "titleProviders:refresh",
] as const;

const USAGE_CHANNELS = ["usage:summary"] as const;

const PROFILE_CHANNELS = [
  "profile:get",
  "profile:setName",
  "profile:shareImage",
] as const;

const COMPUTER_USE_CHANNELS = [
  "computerUse:status",
  "computerUse:setEnabled",
  "computerUse:resetChatGrants",
  "computerUse:requestPermissions",
] as const;

const FORM_FILL_CHANNELS = [
  "formFill:status",
  "formFill:setEnabled",
  "formFill:download",
  "formFill:cancel",
  "formFill:remove",
] as const;

const IMAGE_GENERATION_CHANNELS = [
  "imageGeneration:state",
  "imageGeneration:setKey",
  "imageGeneration:removeKey",
  "imageGeneration:setModelEnabled",
  "imageGeneration:setModelsEnabled",
  "imageGeneration:setDefaultModel",
  "imageGeneration:addCustomModel",
  "imageGeneration:removeCustomModel",
  "imageGeneration:fetchModels",
] as const;

const USAGE_LIMIT_CHANNELS = [
  "usageLimits:list",
  "usageLimits:retryNow",
] as const;

const SPENDING_CHANNELS = [
  "spending:status",
  "spending:allowMore",
  "spending:botLimit",
  "spending:setBotLimit",
] as const;

const HOOK_CHANNELS = [
  "hooks:list",
  "hooks:approveProposal",
  "hooks:rejectProposal",
  "hooks:save",
  "hooks:approveDigest",
  "hooks:setEnabled",
  "hooks:delete",
  "hooks:setPaused",
  "hooks:test",
  "hooks:runLog",
] as const;

const APPROVAL_RULE_CHANNELS = [
  "chat:approvalRules:list",
  "chat:approvalRules:picker",
  "chat:approvalRules:add",
  "chat:approvalRules:change",
  "chat:approvalRules:remove",
  "chat:approvalRules:refresh",
  "chat:approvalRules:setAside",
] as const;

const DICTATION_CHANNELS = [
  "dictation:result",
  "dictation:error",
  "dictation:progress",
  "dictation:cancel",
  "dictation:ready",
  "dictation:stop",
] as const;

const QUICK_CHAT_CHANNELS = [
  "quickChat:toggle",
  "quickChat:hide",
  "quickChat:setMode",
  "quickChat:suppressBlur",
  "quickChat:openSettings",
  "quickChat:expandToMain",
] as const;

const SCHEDULED_TASK_CHANNELS = [
  "schedule:list",
  "schedule:save",
  "schedule:remove",
  "schedule:pause",
  "schedule:resume",
  "schedule:trigger-link:rotate",
  "schedule:trigger-connector:find-sources",
  "schedule:trigger-link:state",
  "schedule:use-own-chat",
  "schedule:runNow",
  "schedule:preview",
  "schedule:scripts",
  "schedule:keepAwakeStatus",
  "schedule:settings",
] as const;

const SHORTCUT_CHANNELS = [
  "shortcut:get",
  "shortcut:set-recording",
  "shortcut:set",
] as const;

const TELEGRAM_CHANNELS = [
  "telegram:get",
  "telegram:setKey",
  "telegram:setEnabled",
  "telegram:resetPairing",
  "telegram:setProvider",
  "telegram:setWorkspace",
  "telegram:setExperience",
  "telegram:selectProfile",
  "telegram:createProfile",
  "telegram:deleteProfile",
] as const;

const SUBAGENT_CHANNELS = [
  "subagents:get",
  "subagents:manage",
] as const;

const ASSISTANT_LIVE_CHANNELS = [
  "assistant-live:status",
  "assistant-live:authorize-computer-use",
  "assistant-live:start",
  "assistant-live:stop",
  "assistant-live:audio",
  "assistant-live:display-sources",
  "assistant-live:display-bind",
  "assistant-live:display-release",
  "assistant-live:frame",
  "assistant-live:tool-result",
  "assistant-live:note",
] as const;

const AIDEN_REMOTE_CHANNELS = [
  "remote:get",
  "remote:getPendingQuestion",
  "remote:respondQuestionFromHost",
  "remote:getPendingApproval",
  "remote:respondApprovalFromHost",
  "remote:setEnabled",
  "remote:setConnectionMode",
  "remote:setDisplayName",
  "remote:moveToAvailablePort",
  "remote:tailscaleConnect",
  "remote:tailscaleDisconnect",
  "remote:tailscaleReconcile",
  "remote:tailscaleReviewTakeover",
  "remote:tailscaleTakeOver",
  "remote:setupPairing",
  "remote:beginPairing",
  "remote:closePairing",
  "remote:revokeDevice",
  "remote:addApprovedRoot",
  "remote:removeApprovedRoot",
  "remote:listPairingRequests",
  "remote:respondPairingRequest",
  "remote:setAcceptPairingRequests",
] as const;

const AIDEN_MCP_CHANNELS = [
  "remote:mcpStatus",
  "remote:mcpSetEnabled",
  "remote:mcpIssueApp",
  "remote:mcpListApps",
  "remote:mcpRevokeApp",
  "remote:mcpChatProvenance",
] as const;

const PEER_HOST_CHANNELS = [
  "workspaces:peerClonePreview",
  "workspaces:peerCloneCancel",
  "workspaces:peerClone",
  "remote:peerIntentsList",
  "remote:peerIntentsPut",
  "remote:peerIntentsRemove",
  "remote:peerRouteRemove",
  "remote:peerRoutesRestore",
  "remote:peersList",
  "remote:peersPair",
  "remote:peerHostStatuses",
  "remote:peerHostFeed",
  "remote:peerCall",
  "remote:peerOperation",
  "remote:peersSetEnabled",
  "remote:peersRemove",
  "remote:peerReconnect",
  "remote:peerRunSubscribe",
  "remote:peerRunUnsubscribe",
  "remote:peerBotSessionSubscribe",
  "remote:peerBotSessionUnsubscribe",
  "remote:peerDiscoveryStart",
  "remote:peerDiscoveryRefresh",
  "remote:peerDiscoveryStop",
  "remote:peerPairRequest",
  "remote:peerPairSetupCode",
  "remote:peerPairLink",
  "remote:peerPairCancel",
  "remote:peersRename",
] as const;

const LOCAL_RUN_CHANNELS = [
  "runs:observeLocal",
  "runs:unobserveLocal",
  "runs:stopLocal",
  "runs:settledLocal",
] as const;

const BTW_CHANNELS = [
  "chats:btwStart",
  "chats:btwCancel",
  "chats:btwClear",
] as const;

const FOLLOW_THROUGH_CHANNELS = [
  "chats:followThrough",
  "chats:followThroughJobOutput",
  "chats:followThroughStopJob",
  "chats:followThroughFollowPullRequest",
  "chats:followThroughStopFollow",
  "chats:followThroughNudgePullRequests",
  "chats:followThroughCancelCheckBack",
] as const;

const GOAL_CHANNELS = [
  "chats:goal:get",
  "chats:goal:set",
  "chats:goal:proposal",
  "chats:goal:dismissProposal",
  "chats:goal:pause",
  "chats:goal:resume",
  "chats:goal:clear",
  "chats:goal:view",
  "chats:goal:startWindowRound",
  "chats:goal:declineWindowRound",
] as const;

const CHILD_CHAT_CHANNELS = [
  "chats:childChats",
  "chats:childChatsStop",
  "chats:childChatsStopAll",
] as const;

const TTS_CHANNELS = [
  "tts:status",
  "tts:settings:get",
  "tts:settings:update",
  "tts:credential:set",
  "tts:credential:clear",
  "tts:voices:starter",
  "tts:voices:list",
  "tts:preview",
  "tts:start",
  "tts:audio:read",
  "tts:pause",
  "tts:resume",
  "tts:stop",
  "tts:cache:clear",
] as const;

const STORAGE_CHANNELS = [
  "storage:report",
  "storage:refresh",
  "storage:preview",
  "storage:cleanup",
] as const;

const DEVICE_CHANNELS = [
  "devices:get-state",
  "devices:consent",
  "devices:refresh",
  "devices:refresh-peers",
  "devices:open",
  "devices:close",
  "devices:action",
  "devices:settings",
  "devices:screenshot",
  "devices:stream-grant",
  "devices:toolchain",
  "devices:prune-tools",
  "devices:start-host",
  "devices:update-tool",
  "devices:inspect-tools",
  "devices:ssh-save",
  "devices:ssh-remove",
  "devices:ssh-test",
  "devices:remove-tools",
  "devices:erase",
  "devices:clipboard-paste",
  "devices:clipboard-copy",
  "devices:recordings-list",
  "devices:recording-start",
  "devices:recording-stop",
  "devices:recording-save",
  "devices:recording-discard",
  "devices:screenshot-save",
  "devices:framed-screenshot-save",
  "devices:reveal-saved",
] as const;

const CREATE_IMAGES_CHANNELS = [
  "imageWorkflows:list",
  "imageWorkflows:create",
  "imageWorkflows:get",
  "imageWorkflows:save",
  "imageWorkflows:mutate",
  "imageWorkflows:list-models",
  "imageWorkflows:import-image",
  "imageWorkflows:prepare-run",
  "imageWorkflows:start-run",
  "imageWorkflows:cancel-run",
  "imageWorkflows:get-run",
  "imageWorkflows:list-runs",
  "imageWorkflows:gallery",
  "imageWorkflows:image-action",
] as const;

const DESIGN_CANVAS_CHANNELS = [
  "designCanvas:snapshotAnswer",
  "designCanvas:consentAnswer",
  "designCanvas:get",
  "designCanvas:save",
  "designCanvas:placeArtifact",
  "designCanvas:grant",
  "designCanvas:watch",
  "designCanvas:pickFile",
  "designCanvas:export",
  "designCanvas:source",
  "designCanvas:editText",
  "designCanvas:bakeTweaks",
  "designCanvas:undoBakeTweaks",
  "designCanvas:capture",
] as const;

const BROWSER_CHANNELS = [
  "browser:popup-menu",
  "browser:dismiss-menu",
  "browser:get-state",
  "browser:command",
  "browser:recording",
  "browser:reveal-recording",
  "browser:link-preference",
  "browser:set-link-preference",
  "browser:open-external",
  "browser:open-file-external",
] as const;

let appHandlersPromise: Promise<typeof import("./app.js")> | null = null;
function loadAppHandlers(): Promise<typeof import("./app.js")> {
  appHandlersPromise ??= import("./app.js").catch((error: unknown) => {
    appHandlersPromise = null;
    throw error;
  });
  return appHandlersPromise;
}

export function registerLazyBrowserHandlers(): LazyIpcGroup {
  return registerLazyIpcGroup("browser", BROWSER_CHANNELS, async () => {
    const { registerBrowserHandlers } = await import("./browser.js");
    return () => registerBrowserHandlers();
  });
}

export async function startDeferredHandlerBackgroundServices(): Promise<void> {
  const [{ initializeAdvisorRuntime }, { initializeForkSummaries }] = await Promise.all([
    import("../services/advisor-runtime-main.js"),
    import("../services/fork-summary-service-main.js"),
  ]);
  initializeAdvisorRuntime();
  initializeForkSummaries();
}

export function registerHandlers(
  isMainWindow: (event: IpcMainInvokeEvent) => boolean,
  options?: {
    navigateMainWindow?: (path: string) => Promise<void>;
    capabilities?: Pick<HostPlatformCapabilities, "bots" | "botComputers">;
    createImages?: boolean;
  },
): LazyIpcGroup[] {
  logger.info("handlers", "Registering IPC handlers...");
  const capabilities = options?.capabilities ?? hostPlatformCapabilities();
  const createImages = options?.createImages ?? createImagesEnabled();
  const groups: LazyIpcGroup[] = [];

  ipcMain.handle("app:getInfo", async (_event) => {
    const { appHandlers } = await loadAppHandlers();
    return await appHandlers.getInfo();
  });

  registerDiagnosticHandlers();
  registerAnalyticsHandlers<IpcMainInvokeEvent>({
    owner: (event) => {
      const inactive = () => new Error("Usage data changes require the active application document.");
      if (!isMainWindow(event)) throw inactive();
      return rendererDocumentOwner(event, inactive);
    },
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    analytics: analyticsService(),
  });

  groups.push(
    registerLazyIpcGroup("providers", PROVIDER_CHANNELS, async () => {
      const { registerProviderHandlers } = await import("./providers.js");
      return () => registerProviderHandlers();
    }),
    registerLazyIpcGroup("app-controls", APP_CONTROL_CHANNELS, async () => {
      const { registerAppControlHandlers } = await import("./app-controls.js");
      return () => registerAppControlHandlers();
    }),
    registerLazyIpcGroup("acp-harnesses", ACP_HARNESS_CHANNELS, async () => {
      const { registerAcpHarnessHandlers } = await import("./acp-harnesses.js");
      return () => registerAcpHarnessHandlers();
    }),
    registerLazyIpcGroup("chats", CHAT_HISTORY_CHANNELS, async () => {
      const { registerChatHistoryHandlers } = await import("./chats.js");
      return () => registerChatHistoryHandlers();
    }),
    registerLazyIpcGroup("design-window", DESIGN_WINDOW_CHANNELS, async () => {
      const { registerDesignWindowHandlers } = await import("./design-window.js");
      return () => registerDesignWindowHandlers();
    }),
    registerLazyIpcGroup("chat-pending-attention", CHAT_PENDING_ATTENTION_CHANNELS, async () => {
      const { registerChatPendingAttentionIpc } = await import("./chat-pending-attention-main.js");
      return () => registerChatPendingAttentionIpc();
    }),
    registerLazyIpcGroup("chat", CHAT_GENERATION_CHANNELS, async () => {
      const { registerChatGenerationHandlers } = await import("./chat.js");
      return () => registerChatGenerationHandlers();
    }),
    registerLazyIpcGroup("workspaces", WORKSPACE_CHANNELS, async () => {
      const { registerWorkspaceHandlers } = await import("./workspaces.js");
      return () => registerWorkspaceHandlers();
    }),
    registerLazyIpcGroup("pull-requests", PULL_REQUEST_CHANNELS, async () => {
      const { registerPullRequestHandlers } = await import("./pull-requests.js");
      return () => registerPullRequestHandlers();
    }),
    registerLazyIpcGroup("workspace-artifacts", WORKSPACE_ARTIFACT_CHANNELS, async () => {
      const [
        { registerWorkspaceArtifactHandlers },
        {
          notifyWorkspaceArtifactsChanged,
          workspaceArtifactFiles,
          workspaceArtifactRunner,
          workspaceArtifactStore,
        },
        { workspaceEnvironmentApplicationService },
        { chatStore },
        { configStore },
      ] = await Promise.all([
        import("./workspace-artifacts.js"),
        import("../services/workspace-artifacts/main.js"),
        import("../services/workspace-environment-application-service-main.js"),
        import("../services/chat-store.js"),
        import("../services/config-store.js"),
      ]);
      return () =>
        registerWorkspaceArtifactHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          store: workspaceArtifactStore,
          workspaceExists: async (id) => Boolean(await configStore.getWorkspace(id)),
          notify: notifyWorkspaceArtifactsChanged,
          chatVisual: async (chatId, messageId, visualId) => {
            const chat = await chatStore.get(chatId);
            if (!chat) return null;
            const message = chat.messages.find((entry) => entry.id === messageId && entry.role === "assistant");
            return { chat, visual: message?.uiVisuals?.find((visual) => visual.id === visualId) };
          },
          files: workspaceArtifactFiles,
          owner: (event) => {
            const owner = rendererDocumentOwner(event as IpcMainInvokeEvent, () => new Error("Artifacts need the active window."));
            return `${owner.id}:${owner.documentId}`;
          },
          runner: workspaceArtifactRunner,
          runInWorkspace: (event, workspaceId, operation) =>
            workspaceEnvironmentApplicationService.run(
              rendererDocumentOwner(event as IpcMainInvokeEvent, () => new Error("Artifacts need the active window.")),
              workspaceId,
              ({ folderPath, workspace }, signal) => operation({ folderPath, permission: workspace.permission }, signal),
            ),
        });
    }),
    registerLazyIpcGroup("attachments", ATTACHMENT_CHANNELS, async () => {
      const { registerAttachmentHandlers } = await import("./attachments.js");
      return () => registerAttachmentHandlers();
    }),
    registerLazyIpcGroup("chat-image-actions", CHAT_IMAGE_ACTION_CHANNELS, async () => {
      const { registerChatImageActionHandlers } = await import("./chat-image-actions.js");
      return () => registerChatImageActionHandlers();
    }),
    registerLazyIpcGroup("transcript-images", TRANSCRIPT_IMAGE_CHANNELS, async () => {
      const [{ registerTranscriptImageHandlers }, { fetchTranscriptImage }] = await Promise.all([
        import("./transcript-images.js"),
        import("../services/transcript-image-fetch.js"),
      ]);
      return () =>
        registerTranscriptImageHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          owner: (event) =>
            rendererDocumentOwner(
              event as IpcMainInvokeEvent,
              () => new Error("Image loading requires the active application window."),
            ),
          fetch: fetchTranscriptImage,
        });
    }),
    registerLazyIpcGroup("phase2", PHASE2_CHANNELS, async () => {
      const { registerPhase2Handlers } = await import("./phase2.js");
      return () => registerPhase2Handlers();
    }),
    registerLazyIpcGroup("local-voice", LOCAL_VOICE_CHANNELS, async () => {
      const { registerLocalVoiceHandlers } = await import("./local-voice.js");
      return () => registerLocalVoiceHandlers();
    }),
    registerLazyIpcGroup("terminal", TERMINAL_CHANNELS, async () => {
      const { registerTerminalHandlers } = await import("./terminal.js");
      return () => registerTerminalHandlers();
    }),
    registerLazyIpcGroup("title-providers", TITLE_PROVIDER_CHANNELS, async () => {
      const { registerTitleProviderHandlers } = await import("./title-providers.js");
      return () => registerTitleProviderHandlers();
    }),
    registerLazyIpcGroup("usage", USAGE_CHANNELS, async () => {
      const { registerUsageHandlers } = await import("./usage.js");
      return () => registerUsageHandlers();
    }),
    registerLazyIpcGroup("profile", PROFILE_CHANNELS, async () => {
      const { registerProfileHandlers } = await import("./profile.js");
      return () => registerProfileHandlers();
    }),
    registerLazyIpcGroup("computer-use", COMPUTER_USE_CHANNELS, async () => {
      const { registerComputerUseHandlers } = await import("./computer-use.js");
      return () => registerComputerUseHandlers();
    }),
    registerLazyIpcGroup("form-fill", FORM_FILL_CHANNELS, async () => {
      const { registerFormFillHandlers } = await import("./form-fill.js");
      return () => registerFormFillHandlers();
    }),
    registerLazyIpcGroup("image-generation", IMAGE_GENERATION_CHANNELS, async () => {
      const { registerImageGenerationHandlers } = await import("./image-generation.js");
      return () => registerImageGenerationHandlers();
    }),
    registerLazyIpcGroup("usage-limits", USAGE_LIMIT_CHANNELS, async () => {
      const [{ registerUsageLimitHandlers }, { usageLimits }] = await Promise.all([
        import("./usage-limits.js"),
        import("../services/usage-limit-main.js"),
      ]);
      return () =>
        registerUsageLimitHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          limits: usageLimits,
        });
    }),
    registerLazyIpcGroup("spending", SPENDING_CHANNELS, async () => {
      const [{ registerSpendingHandlers }, { spending }] = await Promise.all([
        import("./spending.js"),
        import("../services/spending-main.js"),
      ]);
      return () =>
        registerSpendingHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          spending,
        });
    }),
    registerLazyIpcGroup("hooks", HOOK_CHANNELS, async () => {
      const [
        { registerHookHandlers },
        { getHookService },
        { workspaceApplicationService },
        { HOOKS_CHANGED_CHANNEL },
      ] = await Promise.all([
        import("./hooks.js"),
        import("../services/hooks/hook-service-main.js"),
        import("../services/workspace-application-service-main.js"),
        import("../../renderer/shared/hooks-settings.js"),
      ]);
      return () =>
        registerHookHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          service: getHookService,
          workspaces: async () =>
            (await workspaceApplicationService.list()).flatMap((workspace) =>
              workspace.folderPath && !workspace.noWorkspace
                ? [{ workspaceRoot: workspace.folderPath, name: workspace.name }]
                : [],
            ),
          broadcast: (change) => ipcMain.broadcast(HOOKS_CHANGED_CHANNEL, change),
          requireSender: (event) => {
            const inactive = () => new Error("Hooks settings need the active window.");
            if (!isMainWindow(event as IpcMainInvokeEvent)) throw inactive();
            rendererDocumentOwner(event as IpcMainInvokeEvent, inactive);
          },
        });
    }),
    registerLazyIpcGroup("approval-rules", APPROVAL_RULE_CHANNELS, async () => {
      const [
        { registerApprovalRuleHandlers },
        { approvalRulesPage },
        { approvalRules },
        { toolApprovalRules },
      ] = await Promise.all([
        import("./approval-rules.js"),
        import("../services/approval-rules/rules-page-main.js"),
        import("../services/approval-rules/store-main.js"),
        import("../services/tool-approval-rules-main.js"),
      ]);
      return () => {
        registerApprovalRuleHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          page: approvalRulesPage(),
          onChange: (listener) => {
            const stops = [
              approvalRules.onChange(listener),
              toolApprovalRules.onChange(listener),
              toolApprovalRules.onBotChange(() => listener()),
            ];
            return () => {
              for (const stop of stops) stop();
            };
          },
          broadcast: (channel, payload) => ipcMain.broadcast(channel, payload),
        });
      };
    }),
    registerLazyIpcGroup("dictation", DICTATION_CHANNELS, async () => {
      const { registerDictationHandlers } = await import("./dictation.js");
      return () => registerDictationHandlers();
    }),
    registerLazyIpcGroup("quick-chat", QUICK_CHAT_CHANNELS, async () => {
      const { registerQuickChatHandlers } = await import("./quick-chat.js");
      return () =>
        registerQuickChatHandlers({
          isMainWindow,
          navigateMainWindow: options?.navigateMainWindow,
        });
    }),
    registerLazyIpcGroup("scheduled-tasks", SCHEDULED_TASK_CHANNELS, async () => {
      const { registerScheduledTaskHandlers } = await import("./scheduled-tasks.js");
      return () => registerScheduledTaskHandlers();
    }),
    registerLazyIpcGroup("shortcuts", SHORTCUT_CHANNELS, async () => {
      const { registerShortcutHandlers } = await import("./shortcuts.js");
      return () => registerShortcutHandlers();
    }),
    registerLazyIpcGroup("telegram", TELEGRAM_CHANNELS, async () => {
      const { registerTelegramHandlers } = await import("./telegram.js");
      return () => registerTelegramHandlers();
    }),
    registerLazyIpcGroup("subagents", SUBAGENT_CHANNELS, async () => {
      const { registerSubagentHandlers } = await import("./subagents.js");
      return () => registerSubagentHandlers();
    }),
    registerLazyIpcGroup("assistant-live", ASSISTANT_LIVE_CHANNELS, async () => {
      const { registerAssistantLiveHandlers } = await import("./assistant-live.js");
      return () => registerAssistantLiveHandlers();
    }),
    registerLazyIpcGroup("aiden-remote", AIDEN_REMOTE_CHANNELS, async () => {
      const { registerAidenRemoteHandlers } = await import("./aiden-remote.js");
      return () => registerAidenRemoteHandlers();
    }),
    registerLazyIpcGroup("aiden-mcp", AIDEN_MCP_CHANNELS, async () => {
      const [
        { registerAidenMcpHandlers },
        {
          aidenMcpChatProvenance,
          aidenMcpServerStatus,
          issueAidenMcpApp,
          listAidenMcpApps,
          revokeAidenMcpApp,
          setAidenMcpServerEnabled,
        },
      ] = await Promise.all([
        import("./aiden-mcp.js"),
        import("../services/aiden-remote-service-main.js"),
      ]);
      return () =>
        registerAidenMcpHandlers<IpcMainInvokeEvent>({
          owner: (event) => {
            const inactive = () =>
              new Error("Apps using Aiden can be changed only from the active Aiden window.");
            if (!isMainWindow(event)) throw inactive();
            return rendererDocumentOwner(event, inactive);
          },
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          service: {
            status: aidenMcpServerStatus,
            setEnabled: setAidenMcpServerEnabled,
            issueApp: issueAidenMcpApp,
            listApps: listAidenMcpApps,
            revokeApp: revokeAidenMcpApp,
            chatProvenance: aidenMcpChatProvenance,
          },
        });
    }),
    registerLazyIpcGroup("peer-hosts", PEER_HOST_CHANNELS, async () => {
      const { registerPeerHostHandlers } = await import("./peer-hosts.js");
      return () => registerPeerHostHandlers();
    }),
    registerLazyIpcGroup("local-runs", LOCAL_RUN_CHANNELS, async () => {
      const { registerLocalRunIpc } = await import("./local-runs-main.js");
      return () => registerLocalRunIpc();
    }),
  );

  groups.push(
    ...registerBotSurfaceLazyGroups<IpcMainInvokeEvent>({
      capabilities,
      registerGroup: registerLazyIpcGroup,
      botRoutines: async () => {
        const { registerBotRoutineHandlers } = await import("./bot-routines.js");
        return () => registerBotRoutineHandlers();
      },
      bots: async () => {
        const { registerBotHandlers } = await import("./bots.js");
        return () => registerBotHandlers();
      },
      botBubbles: async () => {
        const [
          { registerBotBubbleHandlers },
          { parseBotId },
          { botBubbleService },
          { botBubbleOverlayAccess, botBubbleWindowPort, isBotBubbleOverlayEvent },
          { guardBotBubbleOverlayHandlers },
        ] = await Promise.all([
          import("./bot-bubbles.js"),
          import("./bot-params.js"),
          import("../services/bot-bubbles/bot-bubbles-main.js"),
          import("../windows/bot-bubbles-window.js"),
          import("../windows/bot-bubbles-overlay-access.js"),
        ]);
        return () =>
          registerBotBubbleHandlers<IpcMainInvokeEvent>({
            // An overlay may close, open, move or bring back only its own heads.
            handle: guardBotBubbleOverlayHandlers<IpcMainInvokeEvent>(
              (channel, handler) => ipcMain.handle(channel, handler),
              botBubbleOverlayAccess(),
            ),
            isMainWindow,
            isBubbleOverlayEvent: isBotBubbleOverlayEvent,
            // Resolved per call: the service reads userData, which is final only once the app starts.
            service: {
              state: () => botBubbleService().state(),
              bubble: (botId, bubbleOptions) => botBubbleService().bubble(botId, bubbleOptions),
              close: (botId) => botBubbleService().close(botId),
              open: (botId, bubbleOptions) => botBubbleService().open(botId, bubbleOptions),
              move: (botId, placement) => botBubbleService().move(botId, placement),
              forgetRecent: (botId) => botBubbleService().forgetRecent(botId),
            },
            windows: botBubbleWindowPort,
            parseBotId,
          });
      },
      botComputers: async () => {
        const [{ registerBotComputerHandlers }, { botComputerHandlerDependencies }] =
          await Promise.all([
            import("./bot-computers.js"),
            import("../services/bot-computers/bot-computers-main.js"),
          ]);
        return () => registerBotComputerHandlers(botComputerHandlerDependencies());
      },
    }),
  );

  groups.push(
    registerLazyIpcGroup("btw", BTW_CHANNELS, async () => {
      const { registerBtwHandlers } = await import("./btw.js");
      return () => registerBtwHandlers();
    }),
    registerLazyIpcGroup("follow-through", FOLLOW_THROUGH_CHANNELS, async () => {
      const { registerFollowThroughHandlers } = await import("./follow-through.js");
      return () => registerFollowThroughHandlers();
    }),
    registerLazyIpcGroup("goals", GOAL_CHANNELS, async () => {
      const [
        { registerGoalHandlers },
        { declineGoalWindowRound, goalLoop, goalProposals, reportGoalWindowView, startGoalLoop, startGoalWindowRound },
        { chatGenerationOwner },
      ] = await Promise.all([
        import("./goals.js"),
        import("../services/goal/goal-main.js"),
        import("../services/chat-generation-owner.js"),
      ]);
      startGoalLoop();
      return () =>
        registerGoalHandlers({
          handle: (channel, handler) => ipcMain.handle(channel, handler),
          loop: goalLoop,
          proposals: goalProposals,
          activeDocument: (event) => {
            rendererDocumentOwner(
              event as IpcMainInvokeEvent,
              () => new Error("Goal changes require the active application document."),
            );
          },
          windowRounds: {
            report: (event, view) => {
              const owner = rendererDocumentOwner(
                event as IpcMainInvokeEvent,
                () => new Error("Only the active application document can show a chat."),
              );
              reportGoalWindowView(
                {
                  documentId: owner.documentId,
                  send: (request) => owner.send("chats:goal-window-round", request),
                  onGone: (listener) => owner.onInvalidated(listener),
                },
                view,
              );
            },
            start: (event, token, streamId) =>
              startGoalWindowRound(chatGenerationOwner(event as IpcMainInvokeEvent), token, streamId),
            decline: (event, token) => {
              const owner = rendererDocumentOwner(
                event as IpcMainInvokeEvent,
                () => new Error("Only the active application document can decline a round."),
              );
              declineGoalWindowRound(owner.documentId, token);
            },
          },
        });
    }),
    registerLazyIpcGroup("child-chats", CHILD_CHAT_CHANNELS, async () => {
      const { registerChildChatsHandlers } = await import("./child-chats.js");
      return () => registerChildChatsHandlers();
    }),
    registerLazyIpcGroup("tts", TTS_CHANNELS, async () => {
      const { registerTtsHandlers } = await import("./tts.js");
      return () => registerTtsHandlers();
    }),
    registerLazyIpcGroup("storage", STORAGE_CHANNELS, async () => {
      const { registerStorageHandlers } = await import("./storage.js");
      return () => registerStorageHandlers();
    }),
    registerLazyIpcGroup("devices", DEVICE_CHANNELS, async () => {
      const { registerDeviceHandlers } = await import("./devices.js");
      return () => registerDeviceHandlers();
    }),
    registerLazyIpcGroup("design-canvas", DESIGN_CANVAS_CHANNELS, async () => {
      const { registerDesignCanvasIpc } = await import("./design-canvas-main.js");
      return () => registerDesignCanvasIpc();
    }),
  );

  if (createImages) {
    groups.push(
      registerLazyIpcGroup("create-images", CREATE_IMAGES_CHANNELS, async () => {
        const { registerCreateImagesIpc } = await import("./create-images/index.js");
        return () => registerCreateImagesIpc();
      }),
    );
  }

  logger.info("handlers", "✓ IPC handlers registered");
  return groups;
}
