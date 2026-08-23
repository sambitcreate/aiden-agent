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
  "AidenOnTheGo/Features/Bots/Prototype/BotFirstPrototype.swift",
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
  "AidenOnTheGo/Models/AidenBot.swift",
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
  "AidenBotContractTests.swift",
  "AidenBotPrototypeSnapshotTests.swift",
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

test("the DEBUG Bot regular-width evidence harness is deterministic and fixture-only", async () => {
  const source = await readFile(
    `${iosRoot}AidenOnTheGoTests/AidenBotPrototypeSnapshotTests.swift`,
    "utf8",
  );

  assert.match(source, /^#if DEBUG/mu);
  assert.match(source, /AidenBotFirstPrototypeLaunchView\(configuration: configuration\)/u);
  assert.match(source, /noticeAcknowledged: true/u);
  assert.match(source, /CGSize\(width: 1_024, height: 768\)/u);
  assert.match(source, /UITraitCollection\(userInterfaceIdiom: \.pad\)/u);
  assert.match(source, /UITraitCollection\(horizontalSizeClass: \.regular\)/u);
  assert.match(source, /regularIPadTraits\.performAsCurrent/u);
  assert.match(source, /UIHostingController\(rootView: content\)/u);
  assert.match(source, /captureWindow\.makeKeyAndVisible\(\)/u);
  assert.match(source, /captureWindow\.layer\.render\(in: context\.cgContext\)/u);
  assert.doesNotMatch(source, /drawHierarchy|\bImageRenderer\(/u);
  assert.match(source, /AidenThemePresetID\.allCases/u);
  assert.match(source, /XCTAttachment\(data: pngData, uniformTypeIdentifier: "public\.png"\)/u);
  assert.match(source, /attachment\.lifetime = \.keepAlways/u);
  assert.doesNotMatch(
    source,
    /URLSession|AidenRemoteCoordinator|AidenRemoteClient|AidenChatCache/u,
  );
});

test("bot-first sources reuse the one reviewed chat implementation", async () => {
  const sources = await Promise.all(
    appSourcePaths.map(async (path) => [path, await readFile(`${iosRoot}${path}`, "utf8")]),
  );
  const sourceByPath = new Map(sources);
  const allSwift = sources.map(([, source]) => source).join("\n");
  const app = sourceByPath.get("AidenOnTheGo/AidenOnTheGoApp.swift");
  const content = sourceByPath.get("AidenOnTheGo/ContentView.swift");
  const chat = sourceByPath.get("AidenOnTheGo/Features/Remote/AidenChatFeature.swift");
  const count = (pattern) => [...allSwift.matchAll(pattern)].length;

  assert.equal(count(/\bstruct\s+AidenChatDetailView\b/gu), 1);
  assert.equal(count(/\bfinal\s+class\s+AidenChatViewModel\b/gu), 1);
  assert.equal(count(/\bstruct\s+AidenComposerView\b/gu), 1);

  const botSources = sources.filter(([path]) => path.includes("/Features/Bots/"));
  assert.ok(botSources.length > 0, "expected reviewed Bot sources");
  const botSwift = botSources.map(([, source]) => source).join("\n");
  for (const [path, source] of botSources) {
    assert.doesNotMatch(
      source,
      /\bstartTurn\b|\bAidenSSEParser\b|text\/event-stream|\b(?:struct|class)\s+\w*Composer\b/gu,
      `${path} must not implement chat transport or input`,
    );
    assert.doesNotMatch(source, /@AppStorage\b/u, `${path} fixtures must not persist state`);
    assert.doesNotMatch(
      source,
      /AidenRemoteCoordinator|AidenChatCache|AidenRemoteLiveActivityManager|clientFactory/u,
      `${path} fixtures must not receive live runtime dependencies`,
    );
  }
  assert.match(
    botSwift,
    /AidenChatDetailView\(readOnlyFixture:\s*chat\)/u,
  );
  assert.match(
    app,
    /let configuration = AidenBotFirstPrototypeConfiguration\.current[\s\S]*?initialValue: configuration == nil \? AidenRemoteCoordinator\(\) : nil/u,
  );
  assert.match(
    app,
    /initialValue: configuration == nil \? AidenAppearanceStore\(\) : nil/u,
  );
  assert.match(
    app,
    /if let prototypeConfiguration \{[\s\S]*?AidenBotFirstPrototypeLaunchView\(configuration: prototypeConfiguration\)[\s\S]*?\} else if let remoteCoordinator, let appearance/u,
  );
  const prototypeBranch = app.match(
    /if let prototypeConfiguration \{[\s\S]*?\} else if let remoteCoordinator, let appearance/u,
  )?.[0];
  assert.ok(prototypeBranch, "expected a bounded prototype launch branch");
  assert.doesNotMatch(
    prototypeBranch,
    /AidenAppearanceStore\(|AidenAppearanceRoot|\.environment\(appearance\)/u,
  );
  assert.doesNotMatch(content, /AidenBotFirstPrototype/u);
  assert.match(
    chat,
    /init\(readOnlyFixture chat: AidenChat\) \{[\s\S]*?runtime = \.readOnlyFixture[\s\S]*?onChatUpdated = \{ _ in \}/u,
  );
  assert.match(
    chat,
    /init\(readOnlyFixture chat: AidenChat\) \{[\s\S]*?_coordinator = State\(initialValue: nil\)[\s\S]*?AidenChatViewModel\(readOnlyFixture: chat\)/u,
  );
  assert.match(chat, /func load\(\) async \{\s*guard !isReadOnlyFixture else \{ return \}/u);
  assert.match(chat, /var isReadOnlyPresentation: Bool \{ isReadOnlyFixture \}/u);
  assert.match(
    chat,
    /AidenComposerView\([\s\S]*?\.disabled\(model\.isReadOnlyPresentation\)/u,
  );
  assert.match(
    chat,
    /guard !model\.isReadOnlyPresentation, autoStartVoice/u,
  );
  assert.match(
    chat,
    /AidenApprovalCard\([\s\S]*?\.disabled\(model\.isReadOnlyPresentation\)/u,
  );
  assert.match(botSwift, /--bot-first-prototype-theme/u);
  assert.match(botSwift, /--bot-first-prototype-state/u);
  assert.match(botSwift, /--bot-first-prototype-screen/u);
  assert.match(botSwift, /case inbox[\s\S]*?case profile[\s\S]*?case editor[\s\S]*?case access[\s\S]*?case chat/u);
  assert.match(botSwift, /Bots can use your Mac/u);
  assert.match(botSwift, /Continue with Full Access/u);
  assert.match(botSwift, /Customize first/u);
  assert.match(botSwift, /onDismiss: presentCustomEditorAfterNoticeIfNeeded/u);
  assert.match(
    botSwift,
    /onCustomize: \{[\s\S]*?newBotDefaultAccess = \.custom[\s\S]*?shouldOpenCustomEditorAfterNotice = true[\s\S]*?noticeAcknowledged = true/u,
  );
  assert.match(
    botSwift,
    /sheet\(isPresented: \$isPresentingPostNoticeEditor\)[\s\S]*?AidenBotPrototypeEditorView\(bot: nil, initialAccess: \.custom\)/u,
  );
  assert.match(botSwift, /case newChat\(botID: String, sequence: Int\)/u);
  assert.match(botSwift, /static func newChat\(bot:[\s\S]*?"prototype-new-\\\(bot\.id\)-\\\(sequence\)"/u);
  assert.match(
    botSwift,
    /newConversationSequence \+= 1[\s\S]*?\.newChat\(botID: botID, sequence: newConversationSequence\)/u,
  );
  const conversationChooser = botSwift.match(
    /confirmationDialog\("New Conversation"[\s\S]*?\} message: \{[\s\S]*?Choose a bot to start with\./u,
  )?.[0];
  assert.ok(conversationChooser, "expected a bounded new-conversation chooser");
  assert.match(conversationChooser, /onNewConversation\(bot\.id\)/u);
  assert.doesNotMatch(conversationChooser, /Fixtures\.recents|onOpen\(\.chat/u);
  const profileSection = botSwift.match(
    /private struct AidenBotPrototypeProfileView:[\s\S]*?private enum AidenBotPrototypeLookStyle:/u,
  )?.[0];
  assert.ok(profileSection, "expected a bounded Bot profile section");
  assert.match(profileSection, /Button\(action: onNewConversation\)/u);
  assert.match(profileSection, /profileMetric\("Access", value: accessSummary/u);
  assert.match(profileSection, /profileMetric\("Files", value: accessPolicy\.ceiling\.files\.rawValue/u);
  assert.match(profileSection, /accessPolicy\.ceiling\.allowedConnectionIDs\.count/u);
  assert.match(profileSection, /accessPolicy\.ceiling\.allowedSkillIDs\.count/u);
  assert.doesNotMatch(profileSection, /sampleRecent|Fixtures\.chat/u);
  assert.match(botSwift, /@State private var botAccessPolicies:/u);
  assert.match(botSwift, /@State private var chatAccessPolicies:/u);
  const chatPolicySection = botSwift.match(
    /private struct AidenBotPrototypeChatAccessPolicy:[\s\S]*?private struct AidenBotPrototypeChatAccessKey:/u,
  )?.[0];
  assert.ok(chatPolicySection, "expected a bounded chat access policy section");
  assert.match(
    chatPolicySection,
    /guard mode == \.customize else \{ return \.inheriting\(botPolicy\) \}/u,
  );
  assert.match(botSwift, /connectionIDs\.intersection\(ceiling\.allowedConnectionIDs\)/u);
  assert.match(botSwift, /skillIDs\.intersection\(ceiling\.allowedSkillIDs\)/u);
  assert.match(botSwift, /chosenLocationIDs\.intersection\(ceiling\.allowedChosenLocationIDs\)/u);
  assert.match(botSwift, /files\.limited\(to: ceiling\.files\)/u);
  assert.match(
    botSwift,
    /if updated\.mode == \.inheritBot \{[\s\S]*?chatAccessPolicies\.removeValue\(forKey: key\)[\s\S]*?\} else \{[\s\S]*?updated\.intersecting\(botPolicy\(for: botID\)\)/u,
  );
  assert.match(
    botSwift,
    /if chatPolicy\.mode == \.inheritBot \{[\s\S]*?chatAccessPolicies\.removeValue\(forKey: key\)[\s\S]*?\} else \{[\s\S]*?chatPolicy\.intersecting\(policy\)/u,
  );
  const editorSection = botSwift.match(
    /private struct AidenBotPrototypeEditorView:[\s\S]*?private enum AidenBotPrototypeAccessScope:/u,
  )?.[0];
  assert.ok(editorSection, "expected a bounded Bot editor section");
  assert.match(editorSection, /initialAccess: AidenBotPrototypeAccess = \.full/u);
  assert.match(editorSection, /Section\("Look"\)[\s\S]*?Shuffle Look/u);
  assert.match(editorSection, /Image Playground isn’t available on this iPhone/u);
  assert.match(editorSection, /No image request was sent/u);
  assert.match(editorSection, /Section\("Review"\)/u);
  assert.match(editorSection, /confirmationDialog\("Discard changes\?"/u);
  assert.match(editorSection, /interactiveDismissDisabled\(isDirty\)/u);
  assert.doesNotMatch(editorSection, /import ImagePlayground|imagePlaygroundSheet|URLSession/u);
  const accessSection = botSwift.match(
    /private struct AidenBotPrototypeAccessView:[\s\S]*?private struct AidenBotPrototypeChatDestination:/u,
  )?.[0];
  assert.ok(accessSection, "expected a bounded Bot access section");
  assert.match(accessSection, /case inheritBot = "Inherit Bot"|AidenBotPrototypeChatAccess/u);
  assert.match(accessSection, /scope == \.bot \? access == \.custom : chatAccess == \.customize/u);
  assert.match(accessSection, /case \.shell: return ceiling\.shell/u);
  assert.match(accessSection, /\.disabled\(!allowed\)/u);
  assert.match(botSwift, /case fullMac = "Full Mac"[\s\S]*?case botFolderOnly = "Bot folder only"[\s\S]*?case chosenLocations = "Chosen locations"[\s\S]*?case off = "Off"/u);
  assert.match(accessSection, /Section\("Mac files"\)[\s\S]*?Picker\("Files", selection: \$files\)[\s\S]*?locationCatalog/u);
  assert.match(accessSection, /Section \{[\s\S]*?Picker\("Connections", selection: \$connectionMode\)[\s\S]*?connectionCatalog[\s\S]*?Text\("Connections"\)/u);
  assert.match(accessSection, /All enabled/u);
  assert.match(accessSection, /Some connections are powered by MCP/u);
  assert.match(accessSection, /Picker\("Skills", selection: \$skillMode\)[\s\S]*?skillCatalog/u);
  assert.match(accessSection, /All available/u);
  assert.match(accessSection, /@State private var connectionIDs: Set<String>/u);
  assert.match(accessSection, /@State private var skillIDs: Set<String>/u);
  assert.match(accessSection, /chosenLocationIDs: chosenLocationIDs[\s\S]*?connectionIDs: connectionIDs[\s\S]*?skillIDs: skillIDs/u);
  assert.match(accessSection, /fileScopeAllowed[\s\S]*?option\.limited\(to: botPolicy\.ceiling\.files\) == option/u);
  assert.match(accessSection, /catalogItemAllowed[\s\S]*?botPolicy\.ceiling\.allowedConnectionIDs\.contains\(id\)[\s\S]*?botPolicy\.ceiling\.allowedSkillIDs\.contains\(id\)/u);
  assert.match(
    accessSection,
    /onBotPolicyChanged\?\(\.init\(mode: access, capabilities: selectedCapabilities\)\)/u,
  );
  assert.match(
    accessSection,
    /chatAccess == \.inheritBot[\s\S]*?AidenBotPrototypeChatAccessPolicy\.inheriting\(botPolicy\)[\s\S]*?mode: \.customize[\s\S]*?capabilities: selectedCapabilities[\s\S]*?\.intersecting\(botPolicy\)/u,
  );
  assert.doesNotMatch(
    accessSection,
    /fullNoticeAccepted|Bots can use your Mac|Continue with Full Access|Customize first/u,
  );
  assert.doesNotMatch(botSwift, /UserDefaults|Keychain|URLSession/u);
  assert.match(botSwift, /\.safeAreaInset\(edge: \.bottom/u);
  assert.match(botSwift, /TextField\("Search"/u);
  assert.match(botSwift, /Image\(systemName: "square\.and\.pencil"\)/u);
  assert.match(botSwift, /\[bot\.name, bot\.summary\]\.contains/u);
  assert.match(botSwift, /\[bot\.name, bot\.summary, recent\.title, recent\.preview\]\.contains/u);
  assert.match(botSwift, /ForEach\(bots\) \{ bot in/u);
  assert.match(botSwift, /hasTypedNoResults[\s\S]*?!normalizedQuery\.isEmpty && filteredBotResults\.isEmpty && filteredRecents\.isEmpty/u);
  assert.match(botSwift, /if hasTypedNoResults \|\| fixtureState == \.noResults/u);
  assert.match(botSwift, /ForEach\(availableBots\) \{ bot in[\s\S]*?onNewConversation\(bot\.id\)/u);
  assert.match(botSwift, /guard !isBotArchived\(botID\) else \{ return \}/u);
  assert.match(botSwift, /@State private var favoriteOrder[\s\S]*?moveFavorite\(bot\.id, by: -1\)[\s\S]*?moveFavorite\(bot\.id, by: 1\)/u);
  assert.match(botSwift, /confirmationDialog\("Archive this bot\?"[\s\S]*?archivedBotIDs\.insert/u);
  assert.match(botSwift, /confirmationDialog\("Delete selected conversations\?"[\s\S]*?deletedRecentIDs\.formUnion\(selectedRecentIDs\)/u);
  assert.match(botSwift, /isArchived \? "Archived bots are read-only until restored\."/u);
  assert.match(botSwift, /\.disabled\(!allowsBotChanges\)/u);
  assert.match(botSwift, /@Environment\(\\\.accessibilityReduceMotion\) private var accessibilityReduceMotion/u);
  assert.match(botSwift, /\.environment\(\\\.aidenReduceMotion, aidenReduceMotion \|\| accessibilityReduceMotion\)/u);
  assert.match(botSwift, /effectiveReduceMotion: Bool \{ reduceMotion \|\| accessibilityReduceMotion \}/u);
  assert.equal([...botSwift.matchAll(/\bwithAnimation\(/gu)].length, 2);
  assert.match(botSwift, /if effectiveReduceMotion \{[\s\S]*?isEditing = nextValue[\s\S]*?\} else \{[\s\S]*?withAnimation/u);
  assert.match(botSwift, /if effectiveReduceMotion \{[\s\S]*?update\(\)[\s\S]*?\} else \{[\s\S]*?withAnimation/u);
  const inboxToolbar = botSwift.match(
    /private var inboxToolbar:[\s\S]*?private var bottomDock:/u,
  )?.[0];
  assert.ok(inboxToolbar, "expected a bounded inbox toolbar section");
  assert.doesNotMatch(inboxToolbar, /magnifyingglass|Close search/u);
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
  assert.match(
    chat,
    /AidenReasoningCard[\s\S]*?Text\(active \? "Thinking…" : "Thinking"\)[\s\S]*?aidenActivityShimmer\(active\)/u,
  );
  const reasoningCard = chat.match(
    /private struct AidenReasoningCard[\s\S]*?private struct AidenToolActivityCard/u,
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
