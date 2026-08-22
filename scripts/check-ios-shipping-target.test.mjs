import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const iosRoot = fileURLToPath(new URL("../ios/", import.meta.url));
const projectPath = fileURLToPath(
  new URL("../ios/AidenOnTheGo.xcodeproj/project.pbxproj", import.meta.url),
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
  new URL(
    "../ios/AidenOnTheGo/Resources/Assets.xcassets/AppIcon.appiconset/",
    import.meta.url,
  ),
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
const desktopOnboardingDirectory = fileURLToPath(
  new URL("../renderer/assets/onboarding/", import.meta.url),
);

const appSourcePaths = [
  "AidenOnTheGo/AidenOnTheGoApp.swift",
  "AidenOnTheGo/AppIntents/AidenAppIntents.swift",
  "AidenOnTheGo/Auth/KeychainStore.swift",
  "AidenOnTheGo/Config/AidenAppearance.swift",
  "AidenOnTheGo/Config/AppConfig.swift",
  "AidenOnTheGo/ContentView.swift",
  "AidenOnTheGo/Features/Chat/ComposerVoiceInputController.swift",
  "AidenOnTheGo/Features/Remote/AidenChatFeature.swift",
  "AidenOnTheGo/Features/Remote/AidenPairingView.swift",
  "AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift",
  "AidenOnTheGo/Features/Remote/AidenScheduledTasksView.swift",
  "AidenOnTheGo/Features/Remote/AidenWorkspaceEnvironmentView.swift",
  "AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift",
  "AidenOnTheGo/Features/Shared/AidenProviderIcon.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Core.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Lattice.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Morph.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/OrbSpec.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Orbits.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Presets.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Snapshot.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Strands.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/ThinkingOrb.swift",
  "AidenOnTheGo/Features/Shared/ThinkingOrbsKit/Web.swift",
  "AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift",
  "AidenOnTheGo/LiveActivities/AidenDeepLink.swift",
  "AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift",
  "AidenOnTheGo/Models/AidenChat.swift",
  "AidenOnTheGo/Models/AidenInstallation.swift",
  "AidenOnTheGo/Models/AidenScheduledTask.swift",
  "AidenOnTheGo/Models/AidenWorkspaceEnvironment.swift",
  "AidenOnTheGo/Networking/AidenRemoteClient.swift",
  "AidenOnTheGo/Networking/AidenRemoteContract.swift",
  "AidenOnTheGo/Networking/AidenSSEParser.swift",
  "AidenOnTheGo/Networking/AidenServerTrust.swift",
  "AidenOnTheGo/Persistence/AidenChatCache.swift",
];

const testSources = [
  "AidenChatTests.swift",
  "AidenNativeIntegrationTests.swift",
  "AidenRemoteClientTests.swift",
  "AidenRemotePhase0Tests.swift",
  "AidenScheduledTaskTests.swift",
  "AidenWorkspaceEnvironmentTests.swift",
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
  return [...match[1].matchAll(/\/\* ([^*]+?) in Sources \*\//gu)]
    .map((entry) => entry[1])
    .sort();
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
    phaseSourceNames(project, "A04500000000000000000050"),
    widgetSources.slice().sort(),
  );
});

test("the iOS tree contains no orphan imported Swift sources", async () => {
  const [appEntries, testEntries] = await Promise.all([
    readdir(`${iosRoot}AidenOnTheGo`, { recursive: true }),
    readdir(`${iosRoot}AidenOnTheGoTests`, { recursive: true }),
  ]);

  assert.deepEqual(
    appEntries.filter((path) => path.endsWith(".swift")).sort(),
    appSourcePaths.map((path) => path.replace("AidenOnTheGo/", "")).sort(),
  );
  assert.deepEqual(
    testEntries.filter((path) => path.endsWith(".swift")).sort(),
    testSources.slice().sort(),
  );
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
  assert.equal(iosLogos.length, 41);
  await Promise.all(iosLogos.map(async (slug) => {
    const [desktopArtwork, iosArtwork] = await Promise.all([
      readFile(`${desktopProviderLogoDirectory}${slug}.svg`),
      readFile(`${iosAssetCatalogDirectory}ProviderLogo-${slug}.imageset/${slug}.svg`),
    ]);
    assert.deepEqual(iosArtwork, desktopArtwork, `${slug} artwork diverged from Aiden Agent`);
  }));
});

test("iOS onboarding reuses the reviewed Mac feature artwork byte for byte", async () => {
  const artworkPairs = [
    ["aiden-workspace.png", "OnboardingBuild.imageset/onboarding-build.png"],
    ["features/model-freedom.png", "OnboardingExtend.imageset/onboarding-extend.png"],
    ["features/scheduled-automations.png", "OnboardingControl.imageset/onboarding-control.png"],
  ];

  await Promise.all(artworkPairs.map(async ([desktopPath, iosPath]) => {
    const [desktopArtwork, iosArtwork] = await Promise.all([
      readFile(`${desktopOnboardingDirectory}${desktopPath}`),
      readFile(`${iosAssetCatalogDirectory}${iosPath}`),
    ]);
    assert.deepEqual(iosArtwork, desktopArtwork, `${iosPath} diverged from Aiden Agent`);
  }));
});

test("the Aiden home, onboarding, composer, schedules, and activity retain the reviewed product shell", async () => {
  const [shell, pairing, content, chat, scheduledTasks, widget, project, logoDefinition, logoArtwork] = await Promise.all([
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenPairingView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/ContentView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenChatFeature.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenScheduledTasksView.swift`, "utf8"),
    readFile(`${iosRoot}AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`, "utf8"),
    readFile(projectPath, "utf8"),
    readFile(`${sidebarLogoPath}Contents.json`, "utf8"),
    readFile(`${sidebarLogoPath}aiden-sidebar-logo.png`),
  ]);

  const scheduledIndex = shell.indexOf('title: "Scheduled Tasks"');
  const usageIndex = shell.indexOf('title: "Usage"', scheduledIndex);
  const workspacesIndex = shell.indexOf('title: "Workspaces"', usageIndex);
  const homeNavigationIndex = shell.indexOf("homeNavigationRows");
  const chatsIndex = shell.indexOf('Text("Chats")', homeNavigationIndex);
  assert.ok(scheduledIndex >= 0 && scheduledIndex < usageIndex);
  assert.ok(usageIndex < workspacesIndex);
  assert.ok(homeNavigationIndex >= 0 && homeNavigationIndex < chatsIndex);
  assert.match(shell, /Image\("AidenAppIcon"\)[\s\S]*?searchChrome/u);
  assert.match(shell, /Image\(systemName: "magnifyingglass"\)[\s\S]*?person\.crop\.circle\.fill/u);
  assert.match(shell, /AidenWorkspacesDirectoryView[\s\S]*?Label\("New Workspace"[\s\S]*?Label\("Add Mac Folder"/u);
  assert.match(shell, /Image\(systemName: "square\.and\.pencil"\)[\s\S]*?aidenProminentGlassButton\(\)[\s\S]*?accessibilityLabel\("New Agent"\)/u);
  assert.match(shell, /content\.buttonStyle\(\.glass\)/u);
  assert.match(shell, /glassEffect\(\.regular\.tint\(tint\)\.interactive\(\), in: Capsule\(\)\)/u);
  assert.match(
    shell,
    /case \.existingWorkspace: "Existing Workspace"[\s\S]*?case \.newWorkspace: "New Workspace"[\s\S]*?case \.scratchWorkspace: "Managed Scratch Workspace"/u,
  );
  assert.match(shell, /aidenChromeGlass\(isInteractive: true, in: Capsule\(\)\)/u);
  assert.match(shell, /glassEffect\(\.regular\.interactive\(\), in: shape\)/u);
  assert.match(shell, /contentMargins\(\.bottom, 104, for: \.scrollContent\)/u);
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
  assert.match(
    shell,
    /popover\(isPresented: \$isShowingNewAgentChoices, arrowEdge: \.bottom\)[\s\S]*?AidenNewAgentPopover[\s\S]*?presentationCompactAdaptation\(\.popover\)/u,
  );
  assert.doesNotMatch(shell, /confirmationDialog\([\s\S]{0,120}"Where should this agent work\?"/u);
  assert.doesNotMatch(shell, /messageLabel|chat\.messages\.count/u);
  assert.doesNotMatch(shell, /count: homeModel\.scheduledTasks\.count|count: coordinator\.workspaces\.count/u);
  assert.match(shell, /task\(id: coordinator\.connectionState\)[\s\S]*?homeModel\.load/u);
  assert.match(
    shell,
    /AidenNavigationResolutionID\([\s\S]*?connectionState: coordinator\.connectionState[\s\S]*?resolveNavigationRequest/u,
  );
  assert.match(
    shell,
    /func resolveNavigationRequest\(\)[\s\S]*?coordinator\.connectionState == \.connected[\s\S]*?defer \{ navigationRequest = nil \}[\s\S]*?intentChat = chat/u,
  );
  assert.match(
    shell,
    /func createNewAgentInScratchWorkspace\(\)[\s\S]*?workspaceCreate: \.scratch[\s\S]*?func createNewAgent\([\s\S]*?createChat\(workspaceId: workspace\.id\)/u,
  );
  assert.match(shell, /Button\("Close"\) \{ intentChat = nil \}/u);
  assert.match(shell, /final class AidenWorkspaceArchiveStore[\s\S]*?workspaceIDsByInstance/u);
  assert.match(shell, /Archived Workspaces[\s\S]*?hidden only on this device/u);
  assert.match(shell, /swipeActions\(edge: \.leading, allowsFullSwipe: false\)/u);
  assert.match(shell, /swipeActions\(edge: \.trailing, allowsFullSwipe: false\)/u);
  assert.match(shell, /Archive on This Device\?[\s\S]*?stays available in Aiden Agent on your Mac and on other devices/u);
  assert.match(shell, /onRemove: workspace\.isManagedWorktree \|\| coordinator\.workspaces\.count <= 1/u);
  assert.match(shell, /if isArchived \{[\s\S]*?Button\(action: onToggleArchive\)/u);
  assert.match(shell, /activeWorkspaceIDSet[\s\S]*?visibleChats = homeModel\.chats\.filter/u);
  assert.match(shell, /archivedWorkspaceIDs\.contains\(chat\.workspaceId\)[\s\S]*?Unarchive it from Workspaces/u);
  assert.match(pairing, /Aiden, wherever you are\./u);
  assert.match(pairing, /task\(id: step\)[\s\S]*?if step == 2[\s\S]*?discovery\.start\(\)/u);
  assert.match(
    pairing,
    /static let primary: \[AidenPairingMethod\] = \[[\s\S]*?\.scanQRCode[\s\S]*?\.nearbyMac[\s\S]*?\.privateAddress/u,
  );
  assert.match(pairing, /static let advanced: \[AidenPairingMethod\] = \[\.pastePayload\]/u);
  assert.match(pairing, /case \.scanQRCode: return String\(localized: "Scan QR Code"\)/u);
  assert.match(pairing, /case \.nearbyMac: return String\(localized: "Nearby Mac \+ Setup Code"\)/u);
  assert.match(pairing, /case \.privateAddress: return String\(localized: "Private Address \+ Setup Code"\)/u);
  assert.match(pairing, /case \.nearbyMac: return String\(localized: "Local Network"\)/u);
  assert.match(pairing, /case \.privateAddress: return String\(localized: "Tailscale"\)/u);
  assert.match(pairing, /Picker\("Connection method", selection: \$selectedPairingMethod\)/u);
  assert.match(
    pairing,
    /TabView\(selection: \$selectedPairingMethod\)[\s\S]*?qrPairingPage\.tag\(AidenPairingMethod\.scanQRCode\)[\s\S]*?nearbyMacPairingPage\.tag\(AidenPairingMethod\.nearbyMac\)[\s\S]*?privateAddressPairingPage\.tag\(AidenPairingMethod\.privateAddress\)/u,
  );
  assert.match(pairing, /\.tabViewStyle\(\.page\(indexDisplayMode: \.never\)\)/u);
  assert.match(pairing, /Paste Pairing Payload[\s\S]*?More pairing options/u);
  assert.match(pairing, /AidenMobileOnboardingPhase\.allCases[\s\S]*?Image\(phase\.imageName\)/u);
  assert.match(pairing, /Image\("AidenAppIcon"\)[\s\S]*?Text\("Aiden On The Go"\)/u);
  assert.doesNotMatch(pairing, /AidenSidebarLogo/u);
  assert.match(pairing, /GeometryReader \{ proxy in[\s\S]*?AidenMobileOnboardingLayout\.contentWidth\(for: proxy\.size\.width\)[\s\S]*?AidenMobileOnboardingLayout\.contentHeight\(for: proxy\.size\.height\)/u);
  assert.match(pairing, /ViewThatFits\(in: \.vertical\)[\s\S]*?onboardingPhaseContent/u);
  assert.doesNotMatch(pairing, /UIDevice\.current\.userInterfaceIdiom/u);
  assert.match(
    pairing,
    /onboardingActionButton\(action:[\s\S]*?Text\("Choose How to Connect"\)[\s\S]*?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
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
    /Text\(isOnboardingLastPage \? "Set Up Connection" : "Continue"\)[\s\S]*?Text\("Choose How to Connect"\)[\s\S]*?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.doesNotMatch(pairing, /Text\("Choose How to Connect"\)[\s\S]{0,180}?\.background\(\.bar\)/u);
  assert.doesNotMatch(
    pairing,
    /Section \{[\s\S]{0,240}?Label\("Open Camera", systemImage: "qrcode\.viewfinder"\)/u,
  );
  assert.match(pairing, /button\.buttonStyle\(\.glassProminent\)/u);
  assert.match(content, /@AppStorage\("aiden\.mobileOnboarding\.v1\.complete"\)/u);
  assert.match(content, /showsIntroduction: !hasCompletedMobileOnboarding/u);
  assert.match(content, /onIntroductionComplete:[\s\S]*?hasCompletedMobileOnboarding = true/u);
  assert.match(pairing, /The QR already contains the selected Local Network or Tailscale address/u);
  assert.match(pairing, /https:\/\/mac-name\.local:49220\/api\/aiden\/v1/u);
  assert.match(pairing, /https:\/\/mac-name\.tailnet\.ts\.net\/api\/aiden\/v1/u);
  assert.doesNotMatch(pairing, /ForEach\(AidenPairingMethod\.primary\)[\s\S]*?NavigationLink/u);
  assert.match(chat, /AidenUIKitMenuButton[\s\S]*?\.photosPicker\(\s*isPresented: \$isPhotoPickerPresented/u);
  assert.doesNotMatch(chat, /PhotosPicker\(selection:/u);
  assert.match(chat, /\.fileImporter\(/u);
  assert.match(
    chat,
    /AidenTurnRequestBuilder\.make\([\s\S]*?attachments: submittedAttachments[\s\S]*?pendingAttachments = \[\]/u,
  );
  assert.match(
    chat,
    /if let provider = model\.selectedProvider[\s\S]*?AidenProviderIcon\([\s\S]*?modelID: model\.selectedModel\?\.id/u,
  );
  assert.match(chat, /Section \{[\s\S]*?header: \{[\s\S]*?AidenProviderIcon/u);
  assert.match(chat, /contextMenu[\s\S]*?Label\("Copy", systemImage: "doc\.on\.doc"\)/u);
  assert.match(
    chat,
    /Image\(uiImage: image\)[\s\S]{0,240}?\.aspectRatio\(contentMode: contentMode\)[\s\S]{0,240}?\.clipShape\(RoundedRectangle\([\s\S]{0,240}?\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: imageAlignment\)/u,
  );
  assert.match(chat, /if !model\.liveText\.isEmpty[\s\S]*?contextMenu[\s\S]*?UIPasteboard\.general\.string = model\.liveText/u);
  assert.match(
    scheduledTasks,
    /Picker\("Provider"[\s\S]*?AidenProviderIcon\([\s\S]*?providerID: provider\.id/u,
  );
  assert.match(
    scheduledTasks,
    /Picker\("Model"[\s\S]*?ForEach\(models\)[\s\S]*?Text\(candidate\.label\)\.tag/u,
  );
  assert.match(chat, /ThinkingOrb\(state: activity\.orb, size: \.px20\)/u);
  assert.match(
    chat,
    /AidenApprovalCard[\s\S]*?Image\(systemName: "shield"\)[\s\S]*?Text\("Approval needed"\)[\s\S]*?font\(\.subheadline\.weight\(\.semibold\)\)/u,
  );
  assert.match(chat, /Text\("Review this one action before Aiden continues\."\)[\s\S]*?font\(\.caption\)/u);
  assert.match(chat, /Text\(summary\)[\s\S]*?font\(\.caption\.monospaced\(\)\)/u);
  assert.match(chat, /Text\("Deny"\)[\s\S]*?Text\("Allow once"\)/u);
  assert.match(chat, /glassEffect\(\.regular\.interactive\(\), in: Capsule\(\)\)/u);
  assert.match(chat, /glassEffect\(\.regular\.tint\(tint\)\.interactive\(\), in: Capsule\(\)\)/u);
  assert.doesNotMatch(chat, /Label\("Approval needed", systemImage: "hand\.raised"\)/u);
  assert.doesNotMatch(chat, /Button\("Deny", role: \.destructive\)/u);
  assert.match(chat, /ZStack\(alignment: \.bottom\)[\s\S]*?frame\(height: max\(96, composerHeight \+ 12\)\)[\s\S]*?AidenComposerView/u);
  assert.match(chat, /glassEffect\(\.regular\.interactive\(\), in: shape\)/u);
  assert.match(chat, /sendButtonBackground[\s\S]*?palette\.accent[\s\S]*?sendButtonForeground[\s\S]*?palette\.canvas/u);
  assert.match(chat, /@FocusState private var composerIsFocused: Bool[\s\S]*?scrollDismissesKeyboard\(\.interactively\)[\s\S]*?TapGesture\(\)\.onEnded[\s\S]*?composerIsFocused = false/u);
  assert.match(chat, /composerFocus: \$composerIsFocused[\s\S]*?\.focused\(composerFocus\)/u);
  assert.match(chat, /candidate\.thinkingLevels[\s\S]*?Menu \{[\s\S]*?ForEach\(levels[\s\S]*?thinkingLevel: level/u);
  assert.match(chat, /ForEach\(model\.visibleProviders\)[\s\S]*?ForEach\(provider\.models\)/u);
  assert.match(chat, /AidenReasoningCard[\s\S]*?AidenSidebarLogo/u);
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
  assert.match(widget, /status == \.starting \|\| status == \.thinking[\s\S]*?Image\("aiden-sidebar-logo"\)/u);
  assert.match(project, /aiden-sidebar-logo\.png in Resources/u);
  assert.doesNotMatch(`${shell}\n${pairing}\n${chat}\n${widget}`, /brain|sparkle/iu);

  assert.equal(JSON.parse(logoDefinition).properties["template-rendering-intent"], "template");
  assert.equal(
    createHash("sha256").update(logoArtwork).digest("hex"),
    "5119ab28448527d6855b8e4555492686220032d841ecd95fe7037c5a20fb58b6",
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

  assert.deepEqual(packages.pins.map((pin) => pin.identity), [
    "keychainaccess",
    "networkimage",
    "swift-cmark",
    "swift-markdown-ui",
  ]);
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
  assert.match(project, /repositoryURL = "https:\/\/github\.com\/gonzalezreal\/swift-markdown-ui\.git";/u);
  assert.doesNotMatch(project, /swift-eventsource|Splash|Highlightr|SwiftMath/u);
  assert.deepEqual(noticeFiles.sort(), [
    "Hermex-LICENSE.txt",
    "KeychainAccess-LICENSE.txt",
    "MarkdownUI-LICENSE.txt",
    "NOTICE.txt",
    "NetworkImage-LICENSE.txt",
    "ProviderLogos-NOTICE.md",
    "ThinkingOrbs-LICENSE.txt",
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
  assert.match(notice, /Thinking Orbs 0\.3\.1/u);
  assert.match(notice, /Provider logos/u);
  assert.doesNotMatch(notice, /swift-eventsource|Splash|Highlightr|SwiftMath|Lucide/u);
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
  assert.equal(JSON.parse(iconDefinition).groups[0].layers[0]["image-name"], "aiden-icon-june15.png");
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
