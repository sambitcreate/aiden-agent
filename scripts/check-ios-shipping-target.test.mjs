import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const iosRoot = fileURLToPath(new URL("../ios/", import.meta.url));
const projectPath = fileURLToPath(
  new URL("../ios/AidenOnTheGo.xcodeproj/project.pbxproj", import.meta.url),
);
const infoPlistPath = fileURLToPath(
  new URL("../ios/AidenOnTheGo/Resources/Info.plist", import.meta.url),
);
const packageResolvedPath = fileURLToPath(
  new URL(
    "../ios/AidenOnTheGo.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    import.meta.url,
  ),
);
const noticeDirectory = fileURLToPath(
  new URL("../ios/AidenOnTheGo/Resources/ThirdPartyNotices/", import.meta.url),
);
const iosLicensePath = fileURLToPath(new URL("../ios/LICENSE", import.meta.url));
const iconComposerPath = fileURLToPath(
  new URL("../ios/AidenOnTheGo/Resources/AppIcon.icon/", import.meta.url),
);
const assetCatalogIconPath = fileURLToPath(
  new URL("../ios/AidenOnTheGo/Resources/Assets.xcassets/AppIcon.appiconset/", import.meta.url),
);
const sidebarLogoPath = fileURLToPath(
  new URL(
    "../ios/AidenOnTheGo/Resources/Assets.xcassets/AidenSidebarLogo.imageset/",
    import.meta.url,
  ),
);
const desktopProviderLogoDirectory = fileURLToPath(
  new URL("../renderer/assets/provider-logos/", import.meta.url),
);
const iosAssetCatalogDirectory = fileURLToPath(
  new URL("../ios/AidenOnTheGo/Resources/Assets.xcassets/", import.meta.url),
);

const appSourcePaths = [
  "AidenOnTheGo/AidenOnTheGoApp.swift",
  "AidenOnTheGo/AppIntents/AidenAppIntents.swift",
  "AidenOnTheGo/Auth/KeychainStore.swift",
  "AidenOnTheGo/Config/AidenAppearance.swift",
  "AidenOnTheGo/Config/AidenChromeGlass.swift",
  "AidenOnTheGo/Config/AidenDesignTokens.swift",
  "AidenOnTheGo/Config/AidenVoiceInput.swift",
  "AidenOnTheGo/Config/AppConfig.swift",
  "AidenOnTheGo/ContentView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotAllowedView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotCharacter.swift",
  "AidenOnTheGo/Features/Bots/AidenBotCreateView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotGeneratedAvatarLifecycle.swift",
  "AidenOnTheGo/Features/Bots/AidenBotHandoffCard.swift",
  "AidenOnTheGo/Features/Bots/AidenBotImagePlaygroundView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotMemoryView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotPresetsView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotProfileView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotRoutinesView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotSemanticAvatarView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift",
  "AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift",
  "AidenOnTheGo/Features/Bots/AidenBotSettingsDraft.swift",
  "AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift",
  "AidenOnTheGo/Features/Chat/AidenAttachmentCamera.swift",
  "AidenOnTheGo/Features/Chat/AidenAttachmentPicker.swift",
  "AidenOnTheGo/Features/Chat/AidenChatFork.swift",
  "AidenOnTheGo/Features/Chat/AidenChatScrollObserver.swift",
  "AidenOnTheGo/Features/Chat/AidenStreamingRevealGate.swift",
  "AidenOnTheGo/Features/Chat/AidenChatScrollPolicy.swift",
  "AidenOnTheGo/Features/Chat/AidenImageGenerationPlaceholder.swift",
  "AidenOnTheGo/Features/Chat/AidenTranscriptPolish.swift",
  "AidenOnTheGo/Features/Chat/AidenChatPolicies.swift",
  "AidenOnTheGo/Features/Chat/AidenReadAloud.swift",
  "AidenOnTheGo/Features/Chat/AidenChatImages.swift",
  "AidenOnTheGo/Features/Chat/AidenChatMarkdown.swift",
  "AidenOnTheGo/Features/Chat/AidenLiveResponseView.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Fork.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Visuals.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Recordings.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+ComposerPower.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+ForeignRuns.swift",
  "AidenOnTheGo/Features/Chat/AidenChatCards.swift",
  "AidenOnTheGo/Features/Chat/AidenChronologicalTranscript.swift",
  "AidenOnTheGo/Features/Chat/AidenChatComposer.swift",
  "AidenOnTheGo/Features/Chat/AidenChatRows.swift",
  "AidenOnTheGo/Features/Chat/AidenActivityFeed.swift",
  "AidenOnTheGo/Features/Chat/AidenWorkspaceChatsModel.swift",
  "AidenOnTheGo/Features/Chat/AidenChatsView.swift",
  "AidenOnTheGo/Features/Chat/AidenChatDetailView.swift",
  "AidenOnTheGo/Features/Chat/ComposerVoiceInputController.swift",
  "AidenOnTheGo/Features/Conversation/AidenChatDock.swift",
  "AidenOnTheGo/Features/Conversation/AidenComposerSession.swift",
  "AidenOnTheGo/Features/Conversation/AidenComposerSurface.swift",
  "AidenOnTheGo/Features/Conversation/AidenDecisionDock.swift",
  "AidenOnTheGo/Features/Conversation/AidenTranscriptScaffold.swift",
  "AidenOnTheGo/Features/Shell/AidenMachinesView.swift",
  "AidenOnTheGo/Features/Shell/AidenMachineChrome.swift",
  "AidenOnTheGo/Features/Shell/AidenMachineDetailView.swift",
  "AidenOnTheGo/Features/Shell/AidenNewWorkMachinePicker.swift",
  "AidenOnTheGo/Features/Shell/AidenNewWorkChatFlow.swift",
  "AidenOnTheGo/Features/Bots/AidenBotCreateOperations+Machine.swift",
  "AidenOnTheGo/Features/Workspace/AidenRelativeTimestamp.swift",
  "AidenOnTheGo/Features/Workspace/AidenNewAgentPopover.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceArchiveStore.swift",
  "AidenOnTheGo/Features/Workspace/AidenHomeModel.swift",
  "AidenOnTheGo/Features/Workspace/AidenUsageView.swift",
  "AidenOnTheGo/Features/Workspace/AidenAppSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenMacTranscriptionSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenFolderBrowserView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceDetailView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceDirectoryView.swift",
  "AidenOnTheGo/Features/Remote/AidenBotChatToolsView.swift",
  "AidenOnTheGo/Features/Remote/Demo/AidenDemoHosts.swift",
  "AidenOnTheGo/Features/Remote/Hosts/AidenHostConnectScheduler.swift",
  "AidenOnTheGo/Features/Shell/AidenAppNavigation.swift",
  "AidenOnTheGo/Features/Shell/AidenAppShellView.swift",
  "AidenOnTheGo/Features/Shell/AidenBotsTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenSearchTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenWorkspacesTabView.swift",
  "AidenOnTheGo/Features/Remote/Hosts/AidenHostConnection.swift",
  "AidenOnTheGo/Features/Remote/Hosts/AidenHostRegistry.swift",
  "AidenOnTheGo/Features/Remote/AidenInboxViews.swift",
  "AidenOnTheGo/Features/Remote/AidenMarkdownContentCache.swift",
  "AidenOnTheGo/Features/Remote/AidenOnboardingArtwork.swift",
  "AidenOnTheGo/Features/Remote/AidenOnboardingVignettes.swift",
  "AidenOnTheGo/Features/Remote/AidenPairingView.swift",
  "AidenOnTheGo/Features/Remote/AidenProvidersView.swift",
  "AidenOnTheGo/Features/Shell/AidenUnifiedInboxStore.swift",
  "AidenOnTheGo/Features/Shell/AidenInboxTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenRunningAccessory.swift",
  "AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift",
  "AidenOnTheGo/Features/Remote/AidenSceneRefreshGate.swift",
  "AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift",
  "AidenOnTheGo/Features/Remote/AidenScheduledTasksView.swift",
  "AidenOnTheGo/Features/Remote/AidenSpendingNotice.swift",
  "AidenOnTheGo/Features/Remote/AidenBackgroundJobs.swift",
  "AidenOnTheGo/Features/Remote/AidenNewWorktree.swift",
  "AidenOnTheGo/Features/Remote/AidenVisualDocument.swift",
  "AidenOnTheGo/Features/Remote/AidenVisualViewer.swift",
  "AidenOnTheGo/Features/Remote/AidenWorkspaceEnvironmentView.swift",
  "AidenOnTheGo/Features/Shared/ActivityMarks/AidenActivityMarkEvaluator.swift",
  "AidenOnTheGo/Features/Shared/ActivityMarks/AidenActivityMarkMapping.swift",
  "AidenOnTheGo/Features/Shared/ActivityMarks/AidenActivityMarkSpec.swift",
  "AidenOnTheGo/Features/Shared/ActivityMarks/AidenActivityMarkView.swift",
  "AidenOnTheGo/Features/Shared/AidenProviderIcon.swift",
  "AidenOnTheGo/Features/Simulators/AidenSimulatorViewer.swift",
  "AidenOnTheGo/Features/Simulators/AidenSimulatorViewerModel.swift",
  "AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift",
  "AidenOnTheGo/LiveActivities/AidenDeepLink.swift",
  "AidenOnTheGo/LiveActivities/AidenLatestValueThrottle.swift",
  "AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift",
  "AidenOnTheGo/Models/AidenBot.swift",
  "AidenOnTheGo/Models/AidenBotAllowed.swift",
  "AidenOnTheGo/Models/AidenBotMemory.swift",
  "AidenOnTheGo/Models/AidenBotRoutine.swift",
  "AidenOnTheGo/Models/AidenBotSession.swift",
  "AidenOnTheGo/Models/AidenChat.swift",
  "AidenOnTheGo/Models/AidenChatProgress.swift",
  "AidenOnTheGo/Models/AidenHostObjectID.swift",
  "AidenOnTheGo/Models/AidenInbox.swift",
  "AidenOnTheGo/Models/AidenInstallation.swift",
  "AidenOnTheGo/Models/AidenMachinePreferences.swift",
  "AidenOnTheGo/Models/AidenInboxPollPolicy.swift",
  "AidenOnTheGo/Models/AidenUnifiedInbox.swift",
  "AidenOnTheGo/Models/AidenCatchUpQueue.swift",
  "AidenOnTheGo/Models/AidenSearchModel.swift",
  "AidenOnTheGo/Models/AidenScheduledTask.swift",
  "AidenOnTheGo/Models/AidenWorkspaceEnvironment.swift",
  "AidenOnTheGo/Networking/AidenMJPEGMultipartParser.swift",
  "AidenOnTheGo/Networking/AidenNetworkPath.swift",
  "AidenOnTheGo/Networking/AidenRemoteClient.swift",
  "AidenOnTheGo/Networking/AidenRemoteContract.swift",
  "AidenOnTheGo/Networking/AidenSSEParser.swift",
  "AidenOnTheGo/Networking/AidenServerTrust.swift",
  "AidenOnTheGo/Networking/AidenSimulatorContract.swift",
  "AidenOnTheGo/Networking/AidenSimulatorStream.swift",
  "AidenOnTheGo/Persistence/AidenBotCache.swift",
  "AidenOnTheGo/Persistence/AidenChatCache.swift",
  "AidenOnTheGo/Persistence/AidenChatDraftStore.swift",
  "AidenOnTheGo/Persistence/AidenModelPreferenceStore.swift",
];

// `AidenChatFeature.swift` was split into the files below. The source checks that
// used to read that one file read all of them, in the order the code used to appear.
const chatFeatureSourcePaths = [
  "AidenOnTheGo/Features/Chat/AidenChatPolicies.swift",
  "AidenOnTheGo/Features/Chat/AidenWorkspaceChatsModel.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Fork.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Visuals.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+Recordings.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+ComposerPower.swift",
  "AidenOnTheGo/Features/Chat/AidenChatsView.swift",
  "AidenOnTheGo/Features/Chat/AidenChatDetailView.swift",
  "AidenOnTheGo/Features/Chat/AidenChatRows.swift",
  "AidenOnTheGo/Features/Chat/AidenActivityFeed.swift",
  "AidenOnTheGo/Features/Chat/AidenChatImages.swift",
  "AidenOnTheGo/Features/Chat/AidenChatMarkdown.swift",
  "AidenOnTheGo/Features/Chat/AidenLiveResponseView.swift",
  "AidenOnTheGo/Features/Chat/AidenChatCards.swift",
  "AidenOnTheGo/Features/Chat/AidenChronologicalTranscript.swift",
  "AidenOnTheGo/Features/Chat/AidenChatComposer.swift",
  "AidenOnTheGo/Features/Conversation/AidenChatDock.swift",
  "AidenOnTheGo/Features/Conversation/AidenComposerSession.swift",
  "AidenOnTheGo/Features/Conversation/AidenComposerSurface.swift",
  "AidenOnTheGo/Features/Conversation/AidenDecisionDock.swift",
  "AidenOnTheGo/Features/Conversation/AidenTranscriptScaffold.swift",
  "AidenOnTheGo/Features/Chat/AidenReadAloud.swift",
  "AidenOnTheGo/Features/Chat/AidenChatViewModel+ForeignRuns.swift",
];

async function readChatFeatureSources() {
  const sources = await Promise.all(
    chatFeatureSourcePaths.map((path) => readFile(`${iosRoot}${path}`, "utf8")),
  );
  return sources.join("\n");
}

// The app shell: the tab shell and the workspace screens it pushes. The source
// checks below read them as one.
const workspaceShellSourcePaths = [
  "AidenOnTheGo/Features/Shell/AidenAppShellView.swift",
  "AidenOnTheGo/Features/Shell/AidenAppNavigation.swift",
  "AidenOnTheGo/Features/Shell/AidenInboxTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenWorkspacesTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenBotsTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenSearchTabView.swift",
  "AidenOnTheGo/Features/Shell/AidenNewWorkChatFlow.swift",
  "AidenOnTheGo/Features/Shell/AidenUnifiedInboxStore.swift",
  "AidenOnTheGo/Features/Workspace/AidenRelativeTimestamp.swift",
  "AidenOnTheGo/Features/Workspace/AidenHomeModel.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceArchiveStore.swift",
  "AidenOnTheGo/Features/Workspace/AidenNewAgentPopover.swift",
  "AidenOnTheGo/Features/Workspace/AidenUsageView.swift",
  "AidenOnTheGo/Features/Workspace/AidenAppSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenMacTranscriptionSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenFolderBrowserView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceSettingsView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceDetailView.swift",
  "AidenOnTheGo/Features/Workspace/AidenWorkspaceDirectoryView.swift",
];

async function readWorkspaceShellSources() {
  const sources = await Promise.all(
    workspaceShellSourcePaths.map((path) => readFile(`${iosRoot}${path}`, "utf8")),
  );
  return sources.join("\n");
}

const testSources = [
  "AidenBotCacheTests.swift",
  "AidenBotAllowedTests.swift",
  "AidenDemoHostsTests.swift",
  "AidenHostConnectionTests.swift",
  "AidenAppShellTests.swift",
  "AidenSearchModelTests.swift",
  "AidenHostConnectSchedulerTests.swift",
  "AidenHostRegistryTests.swift",
  "AidenOwnerScopeTests.swift",
  "AidenDesignTokenTests.swift",
  "AidenMachinePreferencesTests.swift",
  "AidenUnifiedInboxTests.swift",
  "AidenUnifiedInboxStoreTests.swift",
  "AidenCatchUpQueueTests.swift",
  "AidenMachineDetailTests.swift",
  "AidenMachineChromeTests.swift",
  "AidenNewWorkTargetTests.swift",
  "AidenOwnerRoutingTests.swift",
  "AidenBotContractTests.swift",
  "AidenBotGeneratedAvatarTests.swift",
  "AidenBotHomeProfileTests.swift",
  "AidenBotImagePlaygroundTests.swift",
  "AidenBotMemoryTests.swift",
  "AidenBotPlanTests.swift",
  "AidenBotSessionTests.swift",
  "AidenActivityMarkTests.swift",
  "AidenChatDockTests.swift",
  "AidenChatTests.swift",
  "AidenComposerSurfaceTests.swift",
  "AidenInboxTests.swift",
  "AidenNativeIntegrationTests.swift",
  "AidenNetworkPathTests.swift",
  "AidenOnboardingArtTests.swift",
  "AidenAppShellTests+Bots.swift",
  "AidenRemoteClientTests.swift",
  "AidenRemoteContractFixture.swift",
  "AidenRemotePhase0Tests.swift",
  "AidenScheduledTaskTests.swift",
  "AidenSimulatorViewerTests.swift",
  "AidenSpendingTests.swift",
  "AidenBackgroundJobsTests.swift",
  "AidenNewWorktreeTests.swift",
  "AidenStreamingPerformanceTests.swift",
  "AidenToolStepGroupingTests.swift",
  "AidenChatMarkdownTests.swift",
  "AidenTranscriptPlaceTests.swift",
  "AidenVisualViewerTests.swift",
  "AidenWorkspaceEnvironmentTests.swift",
];

// UI tests never ship. They launch the Debug app against demo machines.
const uiTestSources = [
  "AidenShellUITests.swift",
  "AidenStateMatrix.swift",
];

const widgetSources = [
  "AgentRunActivityAttributes.swift",
  "AidenDeepLink.swift",
  "AgentRunLiveActivityWidget.swift",
];

function phaseSourceNames(project, phaseId) {
  const escaped = phaseId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = project.match(
    new RegExp(`${escaped} /\\* Sources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`, "u"),
  );
  assert.ok(match, `missing source build phase ${phaseId}`);
  return [...match[1].matchAll(/\/\* ([^*]+?) in Sources \*\//gu)].map((entry) => entry[1]).sort();
}

test("shipping, test, and widget source phases stay on the reviewed Aiden allowlists", async () => {
  const project = await readFile(projectPath, "utf8");

  assert.deepEqual(
    phaseSourceNames(project, "1A2B3C4D5E6F700000000050"),
    appSourcePaths.map((path) => path.split("/").at(-1)).sort(),
  );
  assert.deepEqual(
    phaseSourceNames(project, "1A2B3C4D5E6F700000000052"),
    testSources.slice().sort(),
  );
  assert.deepEqual(
    phaseSourceNames(project, "DE30000000000000000000C7"),
    uiTestSources.slice().sort(),
  );
  assert.deepEqual(
    phaseSourceNames(project, "A04500000000000000000050"),
    widgetSources.slice().sort(),
  );
});

test("the iOS tree contains no orphan imported Swift sources", async () => {
  const [appEntries, testEntries, uiTestEntries] = await Promise.all([
    readdir(`${iosRoot}AidenOnTheGo`, { recursive: true }),
    readdir(`${iosRoot}AidenOnTheGoTests`, { recursive: true }),
    readdir(`${iosRoot}AidenOnTheGoUITests`, { recursive: true }),
  ]);

  assert.deepEqual(
    appEntries.filter((path) => path.endsWith(".swift")).sort(),
    appSourcePaths.map((path) => path.replace("AidenOnTheGo/", "")).sort(),
  );
  assert.deepEqual(
    testEntries.filter((path) => path.endsWith(".swift")).sort(),
    testSources.slice().sort(),
  );
  assert.deepEqual(
    uiTestEntries.filter((path) => path.endsWith(".swift")).sort(),
    uiTestSources.slice().sort(),
  );
});

test("the demo machines stay out of Release builds", async () => {
  // The demo can run, pause and grant on its own pretend machines. A Release
  // build must never compile it, or a launch argument could reach it.
  const demoPath = "AidenOnTheGo/Features/Remote/Demo/AidenDemoHosts.swift";
  const demo = await readFile(`${iosRoot}${demoPath}`, "utf8");
  assert.match(demo, /^#if DEBUG\n/u);
  assert.match(demo, /\n#endif\n?$/u);

  const references = /\bAidenDemo(?:Hosts|Scenario)\./u;
  const sources = appSourcePaths.filter((path) => !path.includes("/Demo/"));
  const texts = await Promise.all(sources.map((path) => readFile(`${iosRoot}${path}`, "utf8")));
  let checked = 0;
  sources.forEach((path, index) => {
    // A stack of open #if blocks: true while the block's live branch is DEBUG.
    const branches = [];
    texts[index].split("\n").forEach((line, lineIndex) => {
      const directive = line.trim();
      if (directive.startsWith("#if ")) {
        branches.push(directive === "#if DEBUG");
      } else if (directive.startsWith("#elseif")) {
        branches[branches.length - 1] = false;
      } else if (directive === "#else") {
        branches[branches.length - 1] = false;
      } else if (directive === "#endif") {
        branches.pop();
      } else if (references.test(line) && !directive.startsWith("//")) {
        checked += 1;
        assert.ok(branches.includes(true), `${path}:${lineIndex + 1} reaches the demo outside #if DEBUG`);
      }
    });
  });
  assert.ok(checked > 0, "The demo's entry points have moved; this check reads nothing");
});

test("the Bot-first mobile rollout flag fails closed across pairing and product routing", async () => {
  const [project, info, appConfig, remoteClient, appShell, botsTab, botsHome] = await Promise.all([
    readFile(projectPath, "utf8"),
    readFile(infoPlistPath, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Config/AppConfig.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Networking/AidenRemoteClient.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Shell/AidenAppShellView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Shell/AidenBotsTabView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift`, "utf8"),
  ]);

  assert.equal([...project.matchAll(/AIDEN_BOT_FIRST_ENABLED = YES;/gu)].length, 2);
  assert.match(
    info,
    /<key>AidenBotFirstEnabled<\/key>\s*<string>\$\(AIDEN_BOT_FIRST_ENABLED\)<\/string>/u,
  );
  assert.match(
    appConfig,
    /botFirstMobileEnabled:[\s\S]*?guard let value = Bundle\.main\.object[\s\S]*?return false/u,
  );
  // The tab shell is the app: no flag chooses it any more.
  assert.doesNotMatch(project, /AIDEN_TAB_SHELL_ENABLED/u);
  assert.doesNotMatch(info, /AidenTabShellEnabled/u);
  assert.doesNotMatch(appConfig, /tabShellEnabled/u);
  assert.match(
    remoteClient,
    /acceptsBotCapabilities: Bool = AppConfig\.botFirstMobileEnabled[\s\S]*?acceptsBotCapabilities: acceptsBotCapabilities/u,
  );
  assert.match(
    appShell,
    /mobileEnabled: Bool = AppConfig\.botFirstMobileEnabled[\s\S]*?guard mobileEnabled else \{ return \.mobileDisabled \}/u,
  );
  assert.match(appShell, /Bots aren’t available in this version of Aiden On The Go\./u);
  assert.match(
    botsHome,
    /isBotSurfaceActive: availability\.canOpen[\s\S]*?guard availability\.canOpen, expectedLoadID\.isBotSurfaceActive else/u,
  );
  // A Bot chat is made only while this phone may write Bots, and only then
  // does it ask the machine.
  const createStart = botsTab.indexOf("private func createConversation(");
  assert.ok(createStart >= 0);
  const createConversation = botsTab.slice(createStart, botsTab.indexOf("\n}\n", createStart));
  const createAdmission = createConversation.indexOf("guard availability.canWrite");
  const start = createConversation.indexOf("chatStarter.start(");
  assert.ok(createAdmission >= 0);
  assert.ok(start > createAdmission);
});

test("Bot Image Playground stays Apple-owned, non-personalized, and availability isolated", async () => {
  const shippingSources = await Promise.all(
    appSourcePaths.map(async (path) => [path, await readFile(`${iosRoot}${path}`, "utf8")]),
  );
  const source = await readFile(
    `${iosRoot}AidenOnTheGo/Features/Bots/AidenBotImagePlaygroundView.swift`,
    "utf8",
  );

  assert.match(source, /@Environment\(\\\.supportsImagePlayground\)/u);
  // iOS 26 is the floor, so only the personalization API newer than that is gated.
  assert.doesNotMatch(source, /#available\(iOS 18/u);
  assert.match(
    source,
    /if #available\(iOS 26\.4, \*\) \{\s*content\.imagePlaygroundOptions\(Self\.nonPersonalizedOptions\)\s*\} else \{\s*content\.imagePlaygroundPersonalizationPolicy\(\.disabled\)\s*\}/u,
  );
  assert.equal([...source.matchAll(/\.imagePlaygroundOptions\(/gu)].length, 1);
  assert.match(
    source,
    /@available\(iOS 26\.4, \*\)\s*private static var nonPersonalizedOptions: ImagePlaygroundOptions \{\s*var options = ImagePlaygroundOptions\(\)\s*options\.personalization = \.disabled\s*return options/u,
  );
  assert.doesNotMatch(source, /\.personalization = \.(?:automatic|enabled)/u);
  assert.match(source, /in: \[\.animation, \.illustration, \.sketch\]/u);
  assert.match(source, /identity\.conceptTexts\.map\(ImagePlaygroundConcept\.text\)/u);
  assert.match(source, /copyImmediately\(fromSystemCompletionURL: temporaryURL\)/u);
  assert.match(source, /aidenBotImagePlaygroundCleanupAfterProcessLaunch/u);
  assert.match(source, /\.isSymbolicLinkKey/u);
  assert.match(source, /\.protectionKey: FileProtectionType\.complete/u);
  assert.doesNotMatch(
    source,
    /ImageCreator|\.externalProvider|\.all\b|URLSession|\bprint\s*\(|\bLogger\s*\(|\bos_log\b|\bNSLog\b/u,
  );
  const app = shippingSources.find(([path]) => path.endsWith("/AidenOnTheGoApp.swift"))?.[1];
  assert.match(app, /init\(\) \{\s*aidenBotImagePlaygroundCleanupAfterProcessLaunch\(\)/u);
  assert.doesNotMatch(source, /imagePlaygroundPersonalizationPolicy\(\.(?:automatic|enabled)\)/u);
  assert.match(source, /may use Private Cloud Compute/u);
  const profile = shippingSources.find(([path]) => path.endsWith("/AidenBotProfileView.swift"))?.[1];
  assert.match(profile, /"Create with Apple Intelligence"/u);
  assert.match(profile, /Text\(AidenBotImagePlaygroundCopy\.privacyNote\)/u);
  for (const [path, shippingSource] of shippingSources) {
    assert.doesNotMatch(
      shippingSource,
      /ImageCreator|\.externalProvider|\bsourceImage\s*:|ImagePlaygroundConcept\.(?:sourceImage|image|extracted)/u,
      `${path} must not bypass the reviewed name/purpose-only Image Playground wrapper`,
    );
    if (shippingSource.includes("import ImagePlayground")) {
      assert.doesNotMatch(
        shippingSource,
        /\.all\b/u,
        `${path} must enumerate the approved Image Playground styles`,
      );
    }
  }
});

test("bot-first sources reuse the one reviewed chat implementation", async () => {
  const sources = await Promise.all(
    appSourcePaths.map(async (path) => [path, await readFile(`${iosRoot}${path}`, "utf8")]),
  );
  const sourceByPath = new Map(sources);
  const allSwift = sources.map(([, source]) => source).join("\n");
  const chat = await readChatFeatureSources();
  const botsTab = sourceByPath.get("AidenOnTheGo/Features/Shell/AidenBotsTabView.swift");
  const botSession = sourceByPath.get("AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift");
  const botHome = sourceByPath.get("AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift");
  const botProfile = sourceByPath.get("AidenOnTheGo/Features/Bots/AidenBotProfileView.swift");
  const botContract = sourceByPath.get("AidenOnTheGo/Models/AidenBot.swift");
  const botAvatar = sourceByPath.get(
    "AidenOnTheGo/Features/Bots/AidenBotGeneratedAvatarLifecycle.swift",
  );
  const count = (pattern) => [...allSwift.matchAll(pattern)].length;

  assert.equal(count(/\bstruct\s+AidenChatDetailView\b/gu), 1);
  assert.equal(count(/\bfinal\s+class\s+AidenChatViewModel\b/gu), 1);
  assert.equal(count(/\bstruct\s+AidenComposerView\b/gu), 1);

  const botSources = sources.filter(([path]) => path.includes("/Features/Bots/"));
  assert.ok(botSources.length > 0, "expected reviewed Bot sources");
  for (const [path, source] of botSources) {
    assert.doesNotMatch(
      source,
      /\bstartTurn\b|\bAidenSSEParser\b|text\/event-stream|\b(?:struct|class)\s+\w*Composer\b/gu,
      `${path} must not implement chat transport or input`,
    );
  }
  // Bot sessions talk only to the bot-session transport; legacy Bot chats in the
  // Bots tab open the same AidenChatDetailView as every other conversation.
  assert.match(botSession, /AidenBotSessionModel\(\s*botID: botID,\s*transport: client\b/u);
  assert.match(botsTab, /AidenChatDetailView\(\s*coordinator: coordinator,\s*chat: chat/u);
  assert.match(
    chat,
    /init\(readOnlyFixture chat: AidenChat\) \{[\s\S]*?runtime = \.readOnlyFixture[\s\S]*?onChatUpdated = \{ _ in \}/u,
  );
  assert.match(
    chat,
    /init\(readOnlyFixture chat: AidenChat\) \{[\s\S]*?_coordinator = State\(initialValue: nil\)[\s\S]*?AidenChatViewModel\(readOnlyFixture: chat\)/u,
  );
  assert.match(chat, /func load\(observeProgress: Bool = true\) async \{\s*guard !isReadOnlyFixture else \{ return \}/u);
  assert.match(
    chat,
    /var isReadOnlyPresentation: Bool \{ isReadOnlyFixture \|\| !allowsMutations \}/u,
  );
  assert.match(chat, /AidenComposerView\([\s\S]*?\.disabled\(model\.isReadOnlyPresentation\)/u);
  // Voice-launch admission is exercised by AidenChatTests with a read-only
  // fixture, rather than coupling this inventory check to the guard's location.
  assert.match(botHome, /AidenBotCanonicalAvatarView\(/u);
  assert.match(botProfile, /AidenBotCanonicalAvatarView\(/u);
  assert.match(botProfile, /\.aidenBotImagePlaygroundSheet\(/u);
  assert.match(botContract, /enum AidenBotContractError: Error, Equatable, LocalizedError/u);
  assert.match(botContract, /Settings → Providers/u);
  assert.match(botContract, /Update Aiden Agent and Aiden On The Go/u);
  assert.match(chat, /AidenBotCanonicalAvatarView\(/u);
  assert.match(chat, /enum AidenChatPresentationStyle[\s\S]*?case botMessages/u);
  assert.match(chat, /struct AidenBotMessageBubbleShape: Shape/u);
  assert.match(
    chat,
    /private func botHeaderPill\([\s\S]*?AidenBotCanonicalAvatarView\([\s\S]*?\.aidenBotHeaderNameGlass\(\)/u,
  );
  assert.match(chat, /Image\(systemName: AidenChromeSymbols\.overflowMenu\)/u);
  assert.match(chat, /buttonBorderShape\(\.circle\)/u);
  assert.ok(chat.includes('"Message Aiden"'));
  assert.match(chat, /padding\(\.horizontal, AidenSpacing\.l\)[\s\S]*?padding\(\.vertical, AidenSpacing\.s\)/u);
  assert.match(chat, /\.padding\(\.horizontal, 12\)[\s\S]*?\.aidenComposerGlass\(\)/u);
  assert.doesNotMatch(chat, /private var botMessageControls|aidenBotComposerCapsule/u);
  assert.match(chat, /Path\(roundedRect: rect, cornerRadius: 18, style: \.continuous\)/u);
  assert.doesNotMatch(chat, /showsTail|Read aloud|AidenSpeechPlaybackController|AVSpeech/u);
  assert.match(
    botAvatar,
    /AidenBotCanonicalAvatarMemoryCache[\s\S]*?assetRevision[\s\S]*?loadedCacheKey == cacheKey[\s\S]*?canonicalImage != nil[\s\S]*?return/u,
  );
  assert.doesNotMatch(botAvatar, /\.onDisappear \{ canonicalImage = nil \}/u);
  assert.match(chat, /AidenApprovalCard\([\s\S]*?\.disabled\(!model\.isConnected \|\| model\.isReadOnlyPresentation \|\| model\.isRespondingToApproval \|\| model\.isStopping\)/u);
});


test("both conversation screens draw their rows through the one transcript row stack", async () => {
  // On iOS 26.5 with the keyboard up, the end-of-transcript row as the last child of the
  // lazy stack blanks the transcript. No hosted test can show it, so the source is held.
  const [scaffold, chatScreen, botScreen] = await Promise.all([
    readFile(`${iosRoot}AidenOnTheGo/Features/Conversation/AidenTranscriptScaffold.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Chat/AidenChatDetailView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift`, "utf8"),
  ]);
  const count = (source, pattern) => [...source.matchAll(pattern)].length;

  // The lazy stack closes after the rows, and the bottom anchor row follows it inside a VStack.
  assert.match(
    scaffold,
    /VStack\(alignment: \.leading, spacing: spacing\) \{\s*LazyVStack\(alignment: \.leading, spacing: spacing\) \{ rows \}\s*Color\.clear\.frame\(height: 1\)\.id\(bottomAnchorID\)\s*\}/u,
  );
  assert.equal(count(scaffold, /LazyVStack\(/gu), 1);
  assert.equal(count(scaffold, /\.id\(bottomAnchorID\)/gu), 1);

  for (const [name, source] of [["chat", chatScreen], ["Bot", botScreen]]) {
    assert.equal(count(source, /AidenTranscriptRowStack\(/gu), 1, `${name} screen draws its rows through the stack`);
    assert.equal(count(source, /LazyVStack\(/gu), 0, `${name} screen has its own lazy stack`);
    assert.doesNotMatch(
      source,
      /\.id\(\s*(?:AidenChatScrollPolicy\.transcriptBottomAnchorID|"bottom"|"chat-bottom")\s*\)/u,
      `${name} screen puts its own id on the bottom anchor`,
    );
  }
});

test("iOS bundles every reviewed Aiden provider logo", async () => {
  const desktopLogos = (await readdir(desktopProviderLogoDirectory))
    .filter((path) => path.endsWith(".svg"))
    .map((path) => path.replace(/\.svg$/u, ""))
    .sort();
  const iosLogos = (await readdir(iosAssetCatalogDirectory))
    .filter((path) => path.startsWith("ProviderLogo-") && path.endsWith(".imageset"))
    .map((path) => path.replace(/^ProviderLogo-/u, "").replace(/\.imageset$/u, ""))
    .sort();

  assert.deepEqual(iosLogos, desktopLogos);
  assert.equal(iosLogos.length, 43);
  await Promise.all(
    iosLogos.map(async (slug) => {
      const [desktopArtwork, iosArtwork] = await Promise.all([
        readFile(`${desktopProviderLogoDirectory}${slug}.svg`),
        readFile(`${iosAssetCatalogDirectory}ProviderLogo-${slug}.imageset/${slug}.svg`),
      ]);
      assert.deepEqual(iosArtwork, desktopArtwork, `${slug} artwork diverged from Aiden Agent`);
    }),
  );
});

test("the Aiden home, onboarding, composer, schedules, and activity retain the reviewed product shell", async () => {
  const [
    shell,
    pairing,
    content,
    chat,
    attachmentPicker,
    attachmentCamera,
    scheduledTasks,
    widget,
    chromeGlass,
    project,
    logoDefinition,
    logoArtwork,
    shippingSources,
  ] = await Promise.all([
    readWorkspaceShellSources(),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenPairingView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/ContentView.swift`, "utf8"),
    readChatFeatureSources(),
    readFile(`${iosRoot}AidenOnTheGo/Features/Chat/AidenAttachmentPicker.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Chat/AidenAttachmentCamera.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenScheduledTasksView.swift`, "utf8"),
    readFile(`${iosRoot}AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Config/AidenChromeGlass.swift`, "utf8"),
    readFile(projectPath, "utf8"),
    readFile(`${sidebarLogoPath}Contents.json`, "utf8"),
    readFile(`${sidebarLogoPath}aiden-sidebar-logo.png`),
    Promise.all(appSourcePaths.map((path) => readFile(`${iosRoot}${path}`, "utf8"))),
  ]);

  assert.match(shell, /enum ChatListLoadState: Equatable/u);
  assert.match(shell, /var chatListLoadState: ChatListLoadState = \.unresolved/u);
  assert.match(shell, /var chatLoadErrorMessage: String\?/u);
  assert.match(
    shell,
    /case \.failure\(let error\):[\s\S]{0,180}chatListLoadState = \.failed\(error\.localizedDescription\)/u,
  );
  assert.match(shell, /private struct LoadAttempt:[\s\S]{0,120}let id = UUID\(\)/u);
  assert.match(shell, /loadingAttempt = attempt/u);
  assert.match(
    shell,
    /guard loadingAttempt == attempt, host\.holdsHomeContext\(context\) else \{ return \}/u,
  );
  assert.match(shell, /if loadingAttempt == attempt \{[\s\S]{0,100}isLoading = false/u);
  assert.match(
    shell,
    /catch let error where aidenIsCancellation\(error\) \{\s*throw CancellationError\(\)/u,
  );
  assert.match(
    shell,
    /aidenLoadHomeSegment[\s\S]*?try Task\.checkCancellation\(\)[\s\S]*?let value = try await operation\(\)[\s\S]*?try Task\.checkCancellation\(\)/u,
  );
  assert.match(
    shell,
    /catch let error where aidenIsCancellation\(error\) \{\s*return\s*\}\s*catch/u,
  );
  assert.doesNotMatch(shell, /loadingContext/u);
  assert.match(shell, /Text\("Show \\\(inbox\.earlierOverflow\) more"\)/u);
  assert.doesNotMatch(shell, /Text\("Show \(inbox\.earlierOverflow\) more"\)/u);
  for (const source of shippingSources) {
    assert.doesNotMatch(source, /ellipsis\.circle/u);
  }
  assert.match(
    shell,
    /AidenWorkspacesDirectoryView[\s\S]*?Label\("New Workspace"[\s\S]*?Label\("Add Desktop Folder"/u,
  );
  // Compose's "Opening chat…" status floats on glass that never reacts to touch.
  assert.match(shell, /if flow\.isCreating \{[\s\S]{0,800}?\.glassEffect\(\.regular, in: \.capsule\)/u);
  assert.match(
    shell,
    /case \.existingWorkspace: "Existing Workspace"[\s\S]*?case \.newWorkspace: "New Workspace"[\s\S]*?case \.scratchWorkspace: "Managed Scratch Workspace"/u,
  );
  assert.match(chromeGlass, /glassEffect\(\.regular\.interactive\(\), in: shape\)/u);
  assert.doesNotMatch(
    shell,
    /safeAreaInset\(edge: \.bottom, spacing: 0\)[\s\S]*?frame\(height: 92\)[\s\S]*?background\(palette\.canvas\)/u,
  );
  assert.doesNotMatch(shell, /Color\.clear\.frame\(height: 90\)\.listRowSeparator/u);
  assert.match(
    shell,
    /AidenUsageView[\s\S]*?overviewGrid[\s\S]*?Token activity[\s\S]*?Activity insights[\s\S]*?Most used models/u,
  );
  assert.match(shell, /AidenUsagePresentation\.heatmapDays[\s\S]*?usage\.days/u);
  assert.doesNotMatch(shell, /confirmationDialog\([\s\S]{0,120}"Where should this agent work\?"/u);
  assert.doesNotMatch(shell, /messageLabel|chat\.messages\.count/u);
  assert.doesNotMatch(
    shell,
    /count: homeModel\.scheduledTasks\.count|count: coordinator\.workspaces\.count/u,
  );
  assert.match(shell, /final class AidenWorkspaceArchiveStore[\s\S]*?workspaceIDsByInstance/u);
  assert.match(shell, /Archived Workspaces[\s\S]*?hidden only on this device/u);
  assert.match(shell, /swipeActions\(edge: \.leading, allowsFullSwipe: false\)/u);
  assert.match(shell, /swipeActions\(edge: \.trailing, allowsFullSwipe: false\)/u);
  assert.match(
    shell,
    /Archive on This Device\?[\s\S]*?stays available in Aiden Agent on your desktop and on other devices/u,
  );
  assert.match(
    shell,
    /onRemove: workspace\.isManagedWorktree \|\| coordinator\.workspaces\.count <= 1/u,
  );
  assert.match(shell, /if isArchived \{[\s\S]*?Button\(action: onToggleArchive\)/u);
  assert.match(
    shell,
    /isArchived\(workspaceID: chat\.workspaceId[\s\S]*?Unarchive it from Workspaces/u,
  );
  assert.match(pairing, /Aiden, wherever you are\./u);
  assert.match(pairing, /task\(id: step\)[\s\S]*?if step == 2[\s\S]*?discovery\.start\(\)/u);
  assert.match(
    pairing,
    /static let primary: \[AidenPairingMethod\] = \[[\s\S]*?\.scanQRCode[\s\S]*?\.nearbyMac[\s\S]*?\.privateAddress/u,
  );
  assert.match(pairing, /static let advanced: \[AidenPairingMethod\] = \[\.pastePayload\]/u);
  assert.match(pairing, /case \.scanQRCode: return String\(localized: "Scan QR Code"\)/u);
  assert.match(
    pairing,
    /case \.nearbyMac: return String\(localized: "Nearby Desktop \+ Setup Code"\)/u,
  );
  assert.match(
    pairing,
    /case \.privateAddress: return String\(localized: "Private Address \+ Setup Code"\)/u,
  );
  assert.match(pairing, /case \.nearbyMac: return String\(localized: "Local Network"\)/u);
  assert.match(pairing, /case \.privateAddress: return String\(localized: "Tailscale"\)/u);
  assert.match(pairing, /Picker\("Connection method", selection: \$selectedPairingMethod\)/u);
  assert.match(
    pairing,
    /TabView\(selection: \$selectedPairingMethod\)[\s\S]*?qrPairingPage\.tag\(AidenPairingMethod\.scanQRCode\)[\s\S]*?nearbyMacPairingPage\.tag\(AidenPairingMethod\.nearbyMac\)[\s\S]*?privateAddressPairingPage\.tag\(AidenPairingMethod\.privateAddress\)/u,
  );
  assert.match(pairing, /\.tabViewStyle\(\.page\(indexDisplayMode: \.never\)\)/u);
  assert.match(pairing, /Paste Pairing Payload[\s\S]*?More pairing options/u);
  assert.match(pairing, /BOTS AND WORKSPACES/u);
  assert.match(
    pairing,
    /When Bots are available on your paired desktop[\s\S]*?use them as reusable helpers from the Bots tab\./u,
  );
  assert.match(pairing, /Image\("AidenAppIcon"\)[\s\S]*?Text\("Aiden On The Go"\)/u);
  assert.doesNotMatch(pairing, /AidenSidebarLogo/u);
  assert.match(
    pairing,
    /GeometryReader \{ proxy in[\s\S]*?AidenMobileOnboardingLayout\.contentWidth\(for: proxy\.size\.width\)[\s\S]*?AidenMobileOnboardingLayout\.contentHeight\(for: proxy\.size\.height\)/u,
  );
  assert.match(pairing, /ViewThatFits\(in: \.vertical\)[\s\S]*?onboardingPhaseContent/u);
  assert.doesNotMatch(pairing, /UIDevice\.current\.userInterfaceIdiom/u);
  assert.match(
    pairing,
    /onboardingActionButton\(action:[\s\S]*?Text\("Scan the Code"\)[\s\S]*?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.match(
    pairing,
    /private var qrPairingPage:[\s\S]*?\.safeAreaInset\(edge: \.bottom, spacing: 0\) \{[\s\S]*?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.match(
    pairing,
    /private func onboardingActionButton<[\s\S]*?maximumActionWidth[\s\S]*?actionHorizontalPadding/u,
  );
  assert.match(
    pairing,
    /Text\(isOnboardingLastPage \? "Set Up Connection" : "Continue"\)[\s\S]*?Text\("Scan the Code"\)[\s\S]*?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.doesNotMatch(
    pairing,
    /Text\("Scan the Code"\)[\s\S]{0,180}?\.background\(\.bar\)/u,
  );
  assert.doesNotMatch(
    pairing,
    /Section \{[\s\S]{0,240}?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.match(pairing, /button\.buttonStyle\(\.glassProminent\)/u);
  assert.match(content, /@AppStorage\("aiden\.mobileOnboarding\.v1\.complete"\)/u);
  assert.match(content, /showsIntroduction: !hasCompletedMobileOnboarding/u);
  assert.match(content, /onIntroductionComplete:[\s\S]*?hasCompletedMobileOnboarding = true/u);
  assert.match(pairing, /The QR already contains the selected Local Network or Tailscale address/u);
  assert.match(pairing, /https:\/\/desktop-name\.local:49220\/api\/aiden\/v1/u);
  assert.match(pairing, /https:\/\/desktop-name\.tailnet\.ts\.net\/api\/aiden\/v1/u);
  assert.doesNotMatch(pairing, /ForEach\(AidenPairingMethod\.primary\)[\s\S]*?NavigationLink/u);
  assert.match(
    chat,
    /AidenAttachmentPickerOverlay\([\s\S]*?onCaptureCameraPhoto: commitCapturedPhoto[\s\S]*?onCommitPhotos: commitSelectedPhotos/u,
  );
  assert.doesNotMatch(chat, /PhotosPicker|AidenUIKitMenuButton|UIImagePickerController/u);
  assert.match(attachmentPicker, /PHPhotoLibrary\.requestAuthorization\(for: \.readWrite\)/u);
  assert.match(attachmentPicker, /PHAsset\.fetchAssets\(with: \.image/u);
  assert.match(attachmentPicker, /guard isCurrentLibraryLoad\(generation\), !Task\.isCancelled else \{ return \}/u);
  assert.match(attachmentPicker, /AidenWindowSizeReader \{ windowSize = \$0 \}/u);
  assert.match(attachmentPicker, /manager\.requestImage\(\s*for: asset,\s*targetSize:/u);
  assert.doesNotMatch(attachmentPicker, /requestImageDataAndOrientation/u);
  assert.match(attachmentPicker, /maximumVisiblePhotos = 180/u);
  assert.match(attachmentPicker, /case camera/u);
  assert.match(attachmentPicker, /photoColumnCount = 3/u);
  assert.match(attachmentPicker, /expandedMaximumWidth: CGFloat = 620/u);
  assert.match(attachmentPicker, /expandedMaximumHeight: CGFloat = 700/u);
  assert.match(
    attachmentPicker,
    /scaleEffect\(\s*picker\.isPresented \? 1 : AidenAttachmentPickerPresentationMotion\.hiddenScale,\s*anchor: layout\.scaleAnchor\s*\)/u,
  );
  assert.match(
    attachmentPicker,
    /\.offset\(y: picker\.isPresented \? 0 : AidenAttachmentPickerPresentationMotion\.hiddenVerticalOffset\)/u,
  );
  assert.match(
    chat,
    /AidenAttachmentPickerPresentationMotion\.transition\(\s*isPresented: attachmentPicker\.isPresented,\s*reduceMotion: reduceMotion\s*\)/u,
  );
  assert.match(attachmentPicker, /private func dismiss\(\) \{\s*picker\.dismiss\(\)\s*\}/u);
  assert.match(
    chat,
    /coordinateSpace: AidenChatAttachmentCoordinateSpace\.name[\s\S]*?frame\(in: \.named\(coordinateSpace\)\)[\s\S]*?AidenAttachmentButtonCenterPreferenceKey[\s\S]*?CGPoint\(x: frame\.midX, y: frame\.midY\)/u,
  );
  assert.match(chat, /AidenAttachmentPickerOverlay\([\s\S]*?\.allowsHitTesting\(attachmentPicker\.isPresented\)/u);
  assert.match(chat, /canToggleAttachments: canToggleAttachmentPicker/u);
  assert.match(chat, /private var canToggleAttachmentPicker: Bool \{\s*AidenAttachmentPickerPolicy\.canPresent/u);
  assert.match(attachmentPicker, /committingAssets/u);
  assert.match(
    attachmentPicker,
    /withTaskCancellationHandler[\s\S]*?cancelImageRequest\(id\)/u,
  );
  assert.match(chat, /finishCommit\(commit\.id\)/u);
  assert.match(attachmentCamera, /AVCaptureSession\(\)/u);
  assert.match(attachmentCamera, /AVCapturePhotoOutput\(\)/u);
  assert.match(attachmentCamera, /AVCaptureDevice\.requestAccess\(for: \.video\)/u);
  assert.match(attachmentCamera, /session\.startRunning\(\)/u);
  assert.match(attachmentCamera, /session\.stopRunning\(\)/u);
  assert.match(attachmentCamera, /AVCaptureDevice\.RotationCoordinator/u);
  assert.match(attachmentCamera, /photo\.fileDataRepresentation\(\)/u);
  assert.match(
    attachmentCamera,
    /captureFence\.invalidate\(\)[\s\S]*?captureGenerationsBySettingsID\.removeAll\(\)/u,
  );
  assert.match(attachmentCamera, /captureFence\.consume\(generation\)/u);
  assert.doesNotMatch(attachmentCamera, /UIImagePickerController/u);
  assert.match(chat, /\.fileImporter\(/u);
  assert.match(
    chat,
    /AidenComposerModelChipLabel\(\s*provider: model\.selectedProvider,\s*modelID: model\.selectedModel\?\.id/u,
  );
  assert.match(
    chat,
    /if let provider \{[\s\S]*?AidenProviderIcon\([\s\S]*?modelID: modelID/u,
  );
  assert.match(chat, /Section \{[\s\S]*?header: \{[\s\S]*?AidenProviderIcon/u);
  assert.match(chat, /contextMenu[\s\S]*?Label\("Copy", systemImage: "doc\.on\.doc"\)/u);
  assert.match(
    chat,
    /Image\(uiImage: image\)[\s\S]{0,240}?\.aspectRatio\(contentMode: contentMode\)[\s\S]{0,240}?\.clipShape\(RoundedRectangle\([\s\S]{0,240}?\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: imageAlignment\)/u,
  );
  assert.match(
    chat,
    /AidenBotReplyProjection\.resolve\([\s\S]*?isActive: model\.isStreaming[\s\S]*?if (?:chronologicalRows == nil && )?!visibleText\.isEmpty[\s\S]*?contextMenu[\s\S]*?UIPasteboard\.general\.string = visibleText/u,
  );
  assert.match(
    chat,
    /AidenActivityFeed\([\s\S]*?progressText: botReply\?\.progressText[\s\S]*?showsRunningRowsWhenCollapsed: presentationStyle != \.botMessages/u,
  );
  assert.match(
    scheduledTasks,
    /Picker\("Provider"[\s\S]*?AidenProviderIcon\([\s\S]*?providerID: provider\.id/u,
  );
  assert.match(
    scheduledTasks,
    /Picker\("Model"[\s\S]*?ForEach\(models\)[\s\S]*?Text\(candidate\.label\)\.tag/u,
  );
  assert.match(chat, /AidenActivityMark\(mark: activity\.mark, size: 20, color: palette\.foreground\)/u);
  assert.match(
    chat,
    /Text\(AidenApprovalPresentation\.detail\(for: kind\)\)[\s\S]*?font\(\.caption\)/u,
  );
  assert.match(
    chat,
    /Text\(AidenApprovalPresentation\.denyTitle\(for: kind\)\)[\s\S]*?Text\(AidenApprovalPresentation\.allowTitle\(for: kind\)\)/u,
  );
  assert.match(
    chat,
    /String\(localized: "This request can only be approved on your paired desktop\."\)/u,
  );
  assert.doesNotMatch(chat, /(?:request can only|task must) be approved on your Mac/iu);
  assert.match(chat, /glassEffect\(\.regular\.interactive\(\), in: Capsule\(\)\)/u);
  assert.match(chat, /glassEffect\(\.regular\.tint\(tint\)\.interactive\(\), in: Capsule\(\)\)/u);
  assert.doesNotMatch(chat, /Label\("Approval needed", systemImage: "hand\.raised"\)/u);
  assert.doesNotMatch(chat, /Button\("Deny", role: \.destructive\)/u);
  assert.match(chat, /safeAreaBar\(edge: \.bottom, spacing: 0\) \{ dock \}/u);
  assert.match(chat, /AidenTranscriptScaffold\(dock: dock\)/u);
  assert.match(chat, /private var dock: AidenChatDock \{[\s\S]*?composer: \{ config in[\s\S]*?AidenComposerView\(/u);
  assert.match(chat, /glassEffect\(\.regular, in: shape\)/u);
  assert.match(
    chat,
    /scrollDismissesKeyboard\(\.interactively\)[\s\S]*?\.gesture\(AidenTranscriptTap \{\s*composerSession\.putAwayKeyboard\(\)/u,
  );
  // A message's footer shows on tap, through a UIKit tap that lets the touch through.
  assert.match(chat, /\.gesture\(AidenMessageTap \{ onTapMessage\?\(\) \}\)/u);
  assert.match(chat, /if showsFooter, footerRevealed \|\| readAloudActive \{/u);
  // The composer's own field carries out a keyboard ask, never the whole app.
  assert.match(
    chat,
    /\.background\(AidenComposerFieldReach\(request: session\.keyboardRequest\)\)[\s\S]*?struct AidenComposerFieldReach: UIViewRepresentable/u,
  );
  assert.doesNotMatch(chat, /sendAction\(#selector\(UIResponder\.resignFirstResponder\)/u);
  assert.match(
    chat,
    /candidate\.thinkingLevels[\s\S]*?Menu \{[\s\S]*?ForEach\(levels[\s\S]*?thinkingLevel: level/u,
  );
  assert.match(chat, /ForEach\(model\.visibleProviders\)[\s\S]*?ForEach\(provider\.models\)/u);
  assert.match(
    chat,
    /AidenReasoningCard[\s\S]*?Text\(label\)[\s\S]*?aidenActivityShimmer\(active\)/u,
  );
  assert.match(
    chat,
    /AidenReasoningCard\([\s\S]*?reasoningLabel\([\s\S]*?active: reasoningActive[\s\S]*?steps: visibleActivitySteps/u,
  );
  assert.match(chat, /AidenActivityPhaseCard\(label: visualizingLabel\)/u);
  assert.doesNotMatch(chat, /Thinking…|Thinking\.\.\./u);
  const reasoningCard = chat.match(
    /(?:private\s+)?struct AidenReasoningCard[\s\S]*?(?:private\s+)?struct AidenToolActivityCard/u,
  )?.[0];
  assert.ok(reasoningCard, "Expected the bounded reasoning-card source section");
  assert.doesNotMatch(reasoningCard, /AidenSidebarLogo/u);
  assert.doesNotMatch(
    chat,
    /Menu \{[\s\S]{0,500}?ForEach\(levels[\s\S]{0,500}?label: \{[\s\S]{0,120}?AidenSidebarLogo/u,
  );
  assert.doesNotMatch(chat, /Listening on this device/u);
  assert.match(
    chat,
    /AidenListeningWaveform[\s\S]*?TimelineView\(\.animation[\s\S]*?paused: !isAnimated/u,
  );
  assert.match(scheduledTasks, /visibleProviders[\s\S]*?selectedProvider\?\.visibleModels/u);
  assert.doesNotMatch(chat, /if let levels = model\.selectedModel\?\.thinkingLevels/u);
  assert.doesNotMatch(chat, /\.background\(\.bar\)/u);
  assert.match(
    widget,
    /status == \.starting \|\| status == \.thinking[\s\S]*?Image\("aiden-sidebar-logo"\)/u,
  );
  assert.match(project, /aiden-sidebar-logo\.png in Resources/u);
  assert.doesNotMatch(`${shell}\n${pairing}\n${chat}\n${widget}`, /brain|sparkle/iu);

  assert.equal(JSON.parse(logoDefinition).properties["template-rendering-intent"], "template");
  assert.equal(
    createHash("sha256").update(logoArtwork).digest("hex"),
    "e266e0c5421c6544bcb053ac6ada5740ffcea856211f6ba686ca0492913a1568",
  );
});

test("shipping Swift literals contain only the Aiden API and no imported product identity", async () => {
  const sources = await Promise.all(
    appSourcePaths.map(async (path) => [path, await readFile(`${iosRoot}${path}`, "utf8")]),
  );
  const forbiddenIdentity = /"[^"\n]*(?:hermes|hermex|kanban|cloudflare|cloudflared)[^"\n]*"/giu;
  const nonAidenAPI = /"\/api\/(?!aiden\/v1)[^"\n]*"/gu;

  for (const [path, source] of sources) {
    const identityPattern = path.endsWith("AidenProviderIcon.swift")
      ? /"[^"\n]*(?:hermes|hermex|kanban|cloudflared)[^"\n]*"/giu
      : forbiddenIdentity;
    assert.doesNotMatch(source, identityPattern, `${path} contains imported product copy`);
    assert.doesNotMatch(source, nonAidenAPI, `${path} contains a non-Aiden API endpoint`);
  }
});

test("the Aiden MIT license, package graph, and bundled notices retain required attribution", async () => {
  const [project, packageResolved, noticeFiles, notice, license] = await Promise.all([
    readFile(projectPath, "utf8"),
    readFile(packageResolvedPath, "utf8"),
    readdir(noticeDirectory),
    readFile(`${noticeDirectory}NOTICE.txt`, "utf8"),
    readFile(iosLicensePath, "utf8"),
  ]);
  const packages = JSON.parse(packageResolved);

  assert.deepEqual(
    packages.pins.map((pin) => pin.identity),
    ["keychainaccess", "networkimage", "swift-cmark", "swift-markdown-ui"],
  );
  assert.deepEqual(
    packages.pins.map((pin) => [pin.identity, pin.state.version]),
    [
      ["keychainaccess", "4.2.2"],
      ["networkimage", "6.0.1"],
      ["swift-cmark", "0.8.0"],
      ["swift-markdown-ui", "2.4.1"],
    ],
  );
  assert.match(
    project,
    /packageProductDependencies = \(\s*1A2B3C4D5E6F700000000098 \/\* KeychainAccess \*\/,\s*BADA00000000000000000003 \/\* MarkdownUI \*\/,[\s\S]*?\);/u,
  );
  assert.match(
    project,
    /repositoryURL = "https:\/\/github\.com\/gonzalezreal\/swift-markdown-ui\.git";/u,
  );
  assert.doesNotMatch(project, /swift-eventsource|Splash|Highlightr|SwiftMath/u);
  assert.deepEqual(noticeFiles.sort(), [
    "Hermex-LICENSE.txt",
    "KeychainAccess-LICENSE.txt",
    "MarkdownUI-LICENSE.txt",
    "NOTICE.txt",
    "NetworkImage-LICENSE.txt",
    "ProviderLogos-NOTICE.md",
    "T3Code-LICENSE.txt",
    "swift-cmark-COPYING.txt",
  ]);
  assert.match(license, /MIT License/u);
  assert.match(license, /Copyright \(c\) 2026 Sambit Biswas/u);
  assert.doesNotMatch(license, /Uzair Ansar|Hermex/u);
  assert.match(notice, /Hermex \(adapted SwiftUI interaction and implementation foundation\)/u);
  assert.match(notice, /KeychainAccess 4\.2\.2/u);
  assert.match(notice, /MarkdownUI 2\.4\.1/u);
  assert.match(notice, /NetworkImage 6\.0\.1/u);
  assert.match(notice, /swift-cmark 0\.8\.0/u);
  assert.match(notice, /Provider logos/u);
  assert.match(notice, /T3 Code \(adapted simulator device viewer logic\)/u);
  assert.doesNotMatch(notice, /swift-eventsource|Splash|Highlightr|SwiftMath|Lucide|Thinking Orbs/u);
});

test("the shipping app icon is the reviewed opaque RayChat artwork", async () => {
  const [project, iconDefinition, composerArtwork, catalogDefinition, catalogArtwork] =
    await Promise.all([
      readFile(projectPath, "utf8"),
      readFile(`${iconComposerPath}icon.json`, "utf8"),
      readFile(`${iconComposerPath}Assets/aiden-icon-june15.png`),
      readFile(`${assetCatalogIconPath}Contents.json`, "utf8"),
      readFile(`${assetCatalogIconPath}aiden-icon-june15.png`),
    ]);

  assert.match(project, /lastKnownFileType = wrapper\.icon; path = AppIcon\.icon;/u);
  assert.match(project, /AppIcon\.icon in Resources/u);
  assert.equal(
    JSON.parse(iconDefinition).groups[0].layers[0]["image-name"],
    "aiden-icon-june15.png",
  );
  assert.equal(JSON.parse(catalogDefinition).images[0].filename, "aiden-icon-june15.png");
  assert.deepEqual(composerArtwork, catalogArtwork);
  assert.equal(composerArtwork.readUInt32BE(16), 1024, "app icon width must be 1024 pixels");
  assert.equal(composerArtwork.readUInt32BE(20), 1024, "app icon height must be 1024 pixels");
  assert.equal(composerArtwork[25], 2, "PNG must use opaque RGB color rather than RGBA");
  assert.equal(
    createHash("sha256").update(composerArtwork).digest("hex"),
    "bb4c7fdd6f5597e415348823902e606bba75098a12289c15a3e434df7619fb6c",
  );
});

test("Bot catalog requests stay scoped through create, advanced settings, chat, and offline cache", async () => {
  const read = (path) => readFile(new URL(`../ios/${path}`, import.meta.url), "utf8");
  const [client, create, advanced, chat, cache, clientTests, cacheTests] = await Promise.all([
    read("AidenOnTheGo/Networking/AidenRemoteClient.swift"),
    read("AidenOnTheGo/Features/Bots/AidenBotCreateView.swift"),
    read("AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift"),
    read("AidenOnTheGo/Features/Remote/AidenBotChatToolsView.swift"),
    read("AidenOnTheGo/Persistence/AidenBotCache.swift"),
    read("AidenOnTheGoTests/AidenRemoteClientTests.swift"),
    read("AidenOnTheGoTests/AidenBotCacheTests.swift"),
  ]);
  assert.match(client, /func botCapabilityCatalog\(botId: String\? = nil\)[\s\S]*?validateBotIdentifier\(botId\)[\s\S]*?URLQueryItem\(name: "botId", value: \$0\)/u);
  assert.equal((create.match(/botCapabilityCatalog\(\)/gu) ?? []).length, 1, "only new-Bot creation uses generic inventory");
  assert.doesNotMatch(advanced, /botCapabilityCatalog\(\)/u);
  assert.doesNotMatch(chat, /botCapabilityCatalog\(\)/u);
  assert.match(advanced, /botCapabilityCatalog\(botId: botID\)/u);
  // Both the load and the Save path read the catalog scoped to this Bot.
  assert.ok((advanced.match(/botCapabilityCatalog\(botId: botID\)/gu) ?? []).length >= 2, "Advanced load and Save both scope the catalog to the Bot");
  assert.match(advanced, /cached\.catalog\(forBotID: botID\)/u);
  assert.match(chat, /botCapabilityCatalog\(botId: botID\)/u);
  assert.equal((chat.match(/botCapabilityCatalog\(botId: grant\.botID\)/gu) ?? []).length, 2, "file load and pre-effect revalidation use the grant owner");
  assert.match(chat, /cached\.catalog\(forBotID: botID\)/u);
  assert.match(cache, /if let botID \{ return catalogsByBotID\?\[botID\] \}/u);
  assert.match(cache, /maximumEnvelopeBytes = 4 \* 1_024 \* 1_024/u);
  assert.match(clientTests, /testBotCatalogRequestsUseExactTargetAndKeepLegacyCreateGeneric/u);
  assert.match(clientTests, /testBotCatalogRejectsInvalidTargetsBeforeIssuingAnyRequest/u);
  assert.match(cacheTests, /testTargetedCatalogsNeverOverwriteOrFallbackToGlobalOrAnotherBot/u);
  assert.match(cacheTests, /testLegacyCacheDecodesWithoutScopedCatalogsAndListRefreshPrunesDeletedBotScopes/u);
});

test("workspace revision conflicts retain a visible reload action", async () => {
  const source = await readFile(new URL("../ios/AidenOnTheGo/Features/Remote/AidenWorkspaceEnvironmentView.swift", import.meta.url), "utf8");
  const conflictMessage = source.match(/body\.code\.rawValue == "revision_conflict"[\s\S]*?errorMessage = "([^"]+)"/u)?.[1];
  const reloadCondition = source.match(/if message\.contains\("([^"]+)"\) \{\s*Button\("Reload from desktop"/u)?.[1];
  assert.ok(conflictMessage, "revision conflicts must publish a recovery message");
  assert.ok(reloadCondition, "revision conflicts must offer a reload action");
  assert.ok(conflictMessage.includes(reloadCondition), "the reload condition must match the actual conflict message");
});
