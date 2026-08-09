import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./onboarding-flow.tsx", import.meta.url), "utf8");
const agentsInstructions = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
const featureAssetPaths = [
  "aiden-workspace.png",
  "features/aiden-assistant.png",
  "features/attachments-vision.png",
  "features/command-palette.png",
  "features/computer-use.png",
  "features/files-editor.png",
  "features/git-workflows.png",
  "features/mcp-connectors.png",
  "features/model-freedom.png",
  "features/model-pad.png",
  "features/native-subagents.png",
  "features/permissions.png",
  "features/review-diffs.png",
  "features/scheduled-automations.png",
  "features/skills.png",
  "features/terminal.png",
  "features/themes-accessibility.png",
  "features/thinking-controls.png",
  "features/usage-profile.png",
  "features/voice-dictation.png",
  "features/web-search.png",
  "features/workspaces-worktrees.png",
] as const;
const providerPresentation = source.slice(
  source.indexOf("const providerChoices"),
  source.indexOf("function makeProvider"),
);
const featurePresentation = source.slice(
  source.indexOf("const featureBentos"),
  source.indexOf("function makeProvider"),
);

test("onboarding uses the Aiden mark and the existing provider icon system", () => {
  assert.match(source, /resources\/app-icon\.png/u);
  assert.match(source, /<ProviderIcon/u);
  for (const providerId of ["openai", "openai-codex", "anthropic", "lmstudio", "ollama"]) {
    assert.match(providerPresentation, new RegExp(`iconProviderId: "${providerId}"`, "u"));
  }
  assert.match(source, /aria-pressed=\{choice === item\.id\}/u);
});

test("onboarding keeps navigation fixed while its content scrolls", () => {
  assert.match(
    source,
    /data-onboarding-scroll[\s\S]*?className="[^"]*min-h-0[^"]*overflow-y-auto[^"]*"/u,
  );
  assert.match(
    source,
    /data-onboarding-footer[\s\S]*?className="[^"]*shrink-0[^"]*border-t[^"]*"/u,
  );
  assert.match(source, /h-\[min\(600px,calc\(100vh-32px\)\)\]/u);
  assert.match(source, /ref=\{scrollContainerRef\}[\s\S]*?data-onboarding-scroll/u);
  assert.match(
    source,
    /scrollContainerRef\.current\?\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]*?\}, \[index\]\);/u,
  );
});

test("provider setup progressively reveals the complete live Pi catalog", () => {
  assert.match(source, />\s*Choose from more\s*</u);
  assert.match(source, /aria-controls="onboarding-more-providers"/u);
  assert.match(source, /aria-expanded=\{showMoreProviders\}/u);
  assert.match(source, /data-onboarding-more-providers/u);
  assert.match(source, /getOnboardingMoreProviders\(providers\.data \?\? \[\]\)/u);
  assert.match(source, /providers\.isLoading/u);
  assert.match(source, /providers\.isError/u);
  assert.match(source, /providers\.refetch\(\)/u);
  assert.match(source, /disabled=\{!canChoose \|\| saving\}/u);
  assert.match(source, /<BuiltinProviderEditor[\s\S]*?layer="onboarding"/u);
  assert.match(source, /provider\.id === "openai-codex"[\s\S]*?provider\.isBuiltin === true/u);
  assert.match(source, /setSettingUpProvider\(chatGptProvider\)/u);
  assert.doesNotMatch(source, /providersApi\.authStart/u);
});

test("onboarding traps focus and locks navigation during durable writes", () => {
  assert.match(source, /<DialogPrimitive\.Root open>/u);
  assert.match(source, /<DialogPrimitive\.Content/u);
  assert.match(source, /onEscapeKeyDown=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(source, /<DialogPrimitive\.Title className="sr-only">Set up Aiden/u);
  assert.match(source, /if \(!canContinue \|\| savingRef\.current\) return/u);
  assert.match(source, /aria-busy=\{saving \|\| undefined\}/u);
  assert.match(source, /variant="transparent"[\s\S]*?disabled=\{saving\}[\s\S]*?>\s*Skip/u);
  assert.ok((source.match(/disabled=\{saving\}/gu) ?? []).length >= 6);
});

test("onboarding presentation stays compact and free of decorative gradients", () => {
  assert.doesNotMatch(source, /blur-3xl|backdrop-blur|bg-gradient/u);
  assert.doesNotMatch(providerPresentation, /footnote|Default URL|127\.0\.0\.1/u);
  assert.doesNotMatch(
    providerPresentation,
    /The key stays on this Mac and can be rotated later in Settings\./u,
  );
});

test("the final step is a complete grouped bento gallery with hover and keyboard descriptions", () => {
  assert.match(source, /data-onboarding-bento/u);
  assert.match(source, /data-onboarding-feature-count=\{featureBentos\.length\}/u);
  assert.match(source, /auto-rows-\[118px\][\s\S]*?grid-cols-6/u);
  assert.match(source, /FEATURE_LAYOUTS[\s\S]*?col-span-4 row-span-2/u);
  assert.match(source, /group-hover:opacity-100/u);
  assert.match(source, /group-focus:opacity-100/u);
  assert.match(source, /tabIndex=\{0\}/u);
  for (const group of [
    "Build in your workspace",
    "Choose and extend",
    "Automate and stay in control",
  ]) {
    assert.match(source, new RegExp(group, "u"));
  }
  for (const title of [
    "Workspace Agent",
    "Computer Use",
    "Native Subagents",
    "Files & Text Editor",
    "Review & Diffs",
    "Integrated Terminal",
    "Git Workflows",
    "Workspaces & Worktrees",
    "Model Freedom",
    "Personal Model Pad",
    "Thinking Controls",
    "Attachments & Vision",
    "Web Search",
    "Reusable Skills",
    "MCP Connectors",
    "Aiden Assistant",
    "Scheduled Automations",
    "Voice & Dictation",
    "Command Palette",
    "Private Usage Profile",
    "Permissioned by Default",
    "Themes & Accessibility",
  ]) {
    assert.match(featurePresentation, new RegExp(title, "u"));
  }
  assert.equal(featurePresentation.match(/imageUrl: FEATURE_ILLUSTRATIONS\./gu)?.length, 22);
  assert.doesNotMatch(featurePresentation, /Designer Mode|Image Generation|Proactive nudges/u);
});

test("every advertised feature has its own one-megapixel PNG with alpha", () => {
  assert.equal(featureAssetPaths.length, 22);
  assert.equal(new Set(featureAssetPaths).size, featureAssetPaths.length);
  for (const assetPath of featureAssetPaths) {
    const illustration = readFileSync(
      new URL(`../assets/onboarding/${assetPath}`, import.meta.url),
    );
    assert.deepEqual(
      [...illustration.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      assetPath,
    );
    assert.equal(illustration.readUInt32BE(16), 1024, assetPath);
    assert.equal(illustration.readUInt32BE(20), 1024, assetPath);
    assert.equal(illustration[25], 6, assetPath);
  }
});

test("project guidance keeps the feature bento current as Aiden evolves", () => {
  assert.match(agentsInstructions, /feature-tour bento gallery/u);
  assert.match(agentsInstructions, /1024 × 1024 transparent PNG/u);
});
