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

test("the Aiden home, onboarding, composer, and activity retain the reviewed product shell", async () => {
  const [shell, pairing, chat, widget, project, logoDefinition, logoArtwork] = await Promise.all([
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenPairingView.swift`, "utf8"),
    readFile(`${iosRoot}AidenOnTheGo/Features/Remote/AidenChatFeature.swift`, "utf8"),
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
  assert.match(shell, /Label\("New Agent", systemImage: "square\.and\.pencil"\)/u);
  assert.match(shell, /glassEffect\(\.regular\.tint\(tint\)\.interactive\(\), in: Capsule\(\)\)/u);
  assert.match(
    shell,
    /Button\("Existing Workspace"\)[\s\S]*?Button\("New Workspace"\)[\s\S]*?Button\("Managed Scratch Workspace"\)/u,
  );
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
  assert.match(pairing, /Aiden, wherever you are\./u);
  assert.match(pairing, /task\(id: step\)[\s\S]*?if step == 2[\s\S]*?discovery\.start\(\)/u);
  assert.match(chat, /PhotosPicker/u);
  assert.match(chat, /\.fileImporter\(/u);
  assert.match(chat, /AidenSidebarLogo\(size: 15/u);
  assert.match(chat, /ThinkingOrb\(state: activity\.orb, size: \.px20\)/u);
  assert.match(chat, /ZStack\(alignment: \.bottom\)[\s\S]*?frame\(height: max\(96, composerHeight \+ 12\)\)[\s\S]*?AidenComposerView/u);
  assert.match(chat, /glassEffect\(\.regular\.interactive\(\), in: shape\)/u);
  assert.match(chat, /sendButtonBackground[\s\S]*?palette\.accent[\s\S]*?sendButtonForeground[\s\S]*?palette\.canvas/u);
  assert.match(chat, /@FocusState private var composerIsFocused: Bool[\s\S]*?scrollDismissesKeyboard\(\.interactively\)[\s\S]*?TapGesture\(\)\.onEnded[\s\S]*?composerIsFocused = false/u);
  assert.match(chat, /composerFocus: \$composerIsFocused[\s\S]*?\.focused\(composerFocus\)/u);
  assert.match(chat, /candidate\.thinkingLevels[\s\S]*?Menu \{[\s\S]*?ForEach\(levels[\s\S]*?thinkingLevel: level/u);
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
    assert.doesNotMatch(source, forbiddenIdentity, `${path} contains imported product copy`);
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
