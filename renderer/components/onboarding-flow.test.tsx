import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingOpenAiLogin } from "./onboarding-openai-login.js";
import {
  discoveredDefaultModel,
  fieldsAfterProviderChoiceChange,
  makeOnboardingProvider,
  visibleOnboardingFeatures,
  type OnboardingProviderChoice,
} from "../lib/onboarding-provider.js";
import type { Provider } from "../lib/types.js";

const source = readFileSync(new URL("./onboarding-flow.tsx", import.meta.url), "utf8");

test("OpenAI onboarding discloses login identity and waits for an available auth method", () => {
  let calls = 0;
  const enabled = renderToStaticMarkup(<OnboardingOpenAiLogin available disabled={false} onConnect={() => { calls++; }} />);
  assert.match(enabled, /Sign in with OpenAI/u);
  assert.match(enabled, /random installation/u);
  assert.doesNotMatch(enabled, /disabled=""/u);
  for (const props of [{ available: false, disabled: false }, { available: true, disabled: true }]) {
    const markup = renderToStaticMarkup(<OnboardingOpenAiLogin {...props} onConnect={() => { calls++; }} />);
    assert.match(markup, /disabled=""/u);
  }
  assert.equal(calls, 0, "rendering onboarding must never start login");
});
const agentsInstructions = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
const featureAssetPaths = [
  "aiden-workspace.png",
  "features/gemini-live.png",
  "features/bots.png",
  "features/attachments-vision.png",
  "features/command-palette.png",
  "features/computer-use.png",
  "features/browser.png",
  "features/files-editor.png",
  "features/git-workflows.png",
  "features/mcp-connectors.png",
  "features/tool-scripts.png",
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
  "features/telegram-remote-control.png",
  "features/aiden-on-the-go.png",
  "features/usage-profile.png",
  "features/voice-dictation.png",
  "features/web-search.png",
  "features/workspaces-worktrees.png",
] as const;

function sourceSection(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `Missing source section start: ${startMarker}`);
  assert.ok(end > start, `Missing source section end: ${endMarker}`);
  return source.slice(start, end);
}

const providerPresentation = sourceSection("const providerChoices", "type FeatureGroupId");
const featurePresentation = sourceSection("const featureBentos", "const FEATURE_LAYOUTS");

test("onboarding uses the Aiden mark and the existing provider icon system", () => {
  assert.match(source, /resources\/app-icon\.png/u);
  assert.match(source, /<ProviderIcon/u);
  for (const providerId of ["openai", "openai-codex", "anthropic", "lmstudio", "ollama", "tailscale"]) {
    assert.match(providerPresentation, new RegExp(`iconProviderId: "${providerId}"`, "u"));
  }
  assert.match(source, /aria-pressed=\{choice === item\.id\}/u);
});

test("local onboarding reuses canonical intent and never applies another choice's hidden URL", () => {
  const existing: Provider = {
    id: "custom:lmstudio",
    kind: "anthropic",
    label: "Studio over Tailnet",
    baseUrl: "https://studio.example.ts.net/custom-api",
    models: ["kept-model"],
    modelMetadata: { "kept-model": { source: "provider", reasoning: true } },
    defaultModel: "kept-model",
    needsKey: true,
    deployment: "hosted",
    isPreset: false,
    isBuiltin: false,
    hasKey: true,
    legacyIds: ["old-studio"],
  };

  assert.deepEqual(makeOnboardingProvider("lmstudio", "https://hidden.example/v1", [existing]), {
    id: existing.id,
    kind: existing.kind,
    label: existing.label,
    baseUrl: existing.baseUrl,
    models: existing.models,
    modelMetadata: existing.modelMetadata,
    defaultModel: existing.defaultModel,
    needsKey: existing.needsKey,
    deployment: existing.deployment,
    isPreset: existing.isPreset,
    isBuiltin: existing.isBuiltin,
  });
  assert.equal(
    makeOnboardingProvider("ollama", "https://hidden.example/v1")?.baseUrl,
    "http://127.0.0.1:11434/v1",
  );
  assert.equal(makeOnboardingProvider("lmstudio", "")?.id, "custom:lmstudio");
  assert.equal(makeOnboardingProvider("ollama", "")?.id, "custom:ollama");
});

test("switching provider choices clears API-key and URL drafts before they become hidden", () => {
  const populated = { apiKey: "secret", baseUrl: "https://gateway.example/v1" };
  const choices: OnboardingProviderChoice[] = [
    "openai-key",
    "openai-signin",
    "anthropic",
    "lmstudio",
    "ollama",
    "tailscale",
  ];
  for (const current of choices) {
    for (const next of choices) {
      assert.deepEqual(
        fieldsAfterProviderChoiceChange(current, next, populated),
        current === next ? populated : { apiKey: "", baseUrl: "" },
        `${current} -> ${next}`,
      );
    }
  }
  assert.deepEqual(fieldsAfterProviderChoiceChange("anthropic", null, populated), {
    apiKey: "",
    baseUrl: "",
  });
});

test("local discovery preserves a still-usable default before transient recommendations", () => {
  const provider = makeOnboardingProvider("lmstudio", "");
  assert.ok(provider);
  provider.defaultModel = "already-selected";
  assert.equal(
    discoveredDefaultModel(provider, {
      models: ["recommended", "already-selected"],
      recommendedModel: "recommended",
    }),
    "already-selected",
  );
  provider.defaultModel = "gone";
  assert.equal(
    discoveredDefaultModel(provider, {
      models: ["recommended", "fallback"],
      recommendedModel: "recommended",
    }),
    "recommended",
  );
});

test("local onboarding discovers and selects a usable default model before continuing", () => {
  const providerStep = source.slice(
    source.indexOf('if (step === "provider")'),
    source.indexOf("markOnboardingComplete()"),
  );
  const freshList = providerStep.indexOf("await providersApi.list()");
  const providerBuild = providerStep.indexOf("makeOnboardingProvider(choice");
  const discovery = providerStep.indexOf("await providersApi.test(providerToSave)");
  const save = providerStep.indexOf("await providersApi.save(");
  const cache = providerStep.indexOf("queryClient.setQueryData<Provider[]>");
  const selection = providerStep.indexOf("persistModelSelection(saved.id");

  assert.ok(freshList >= 0 && freshList < providerBuild, "resolve live intent before building");
  assert.ok(providerBuild >= 0 && providerBuild < discovery, "reuse intent before discovery");
  assert.ok(discovery >= 0 && discovery < save, "discover before saving a local provider");
  assert.match(providerStep, /models: discovery\.models/u);
  assert.match(providerStep, /modelMetadata: discovery\.modelMetadata/u);
  assert.match(providerStep, /discoveredDefaultModel\(providerToSave, discovery\)/u);
  assert.match(providerStep, /defaultModel,/u);
  assert.match(providerStep, /if \(!defaultModel\)[\s\S]*?no chat models were found/u);
  assert.ok(cache >= 0 && cache < selection, "publish the provider before selecting its model");
  assert.match(
    providerStep,
    /persistModelSelection\(saved\.id, saved\.defaultModel \?\? providerToSave\.defaultModel!\)/u,
  );
  assert.match(source, /\{discovering[\s\S]*?Discovering models…/u);
  assert.match(source, /providerError[\s\S]*?role="alert"/u);
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
  assert.match(source, /h-\[min\(600px,calc\(100vh-60px\)\)\]/u);
  assert.match(source, /ref=\{scrollContainerRef\}[\s\S]*?data-onboarding-scroll/u);
  assert.match(
    source,
    /scrollContainerRef\.current\?\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]*?\}, \[index, open\]\);/u,
  );
});

test("provider setup progressively reveals configurable Pi providers and uses the dedicated Codex surface", () => {
  assert.match(source, />\s*Other ways\s*</u);
  assert.match(source, /aria-controls="onboarding-more-providers"/u);
  assert.match(source, /aria-expanded=\{showMoreProviders\}/u);
  assert.match(source, /data-onboarding-more-providers/u);
  assert.match(source, /getOnboardingMoreProviders\(providers\.data \?\? \[\]\)/u);
  assert.match(source, /providers\.isLoading/u);
  assert.match(source, /providers\.isError/u);
  assert.match(source, /providers\.refetch\(\)/u);
  assert.match(source, /disabled=\{!canChoose \|\| saving\}/u);
  assert.match(source, /canConfigureOnboardingBuiltinProvider\(provider\)/u);
  assert.match(source, /onboardingBuiltinProviderSetupLabel\(provider\)/u);
  assert.match(
    source,
    /if \(!isOnboardingBuiltinProviderReady\(provider\)\)[\s\S]*?setSettingUpProvider\(provider\)/u,
  );
  assert.match(source, /<BuiltinProviderEditor[\s\S]*?layer="onboarding"/u);
  assert.match(source, /<CodexProviderSettings/u);
  assert.match(source, /<CodexProviderSettings layer="onboarding"/u);
  assert.match(source, /useCodexProviderStatus\(\)/u);
  assert.doesNotMatch(source, /chatGptProvider/u);
  assert.doesNotMatch(source, /providersApi\.authStart/u);
});

test("Tailscale model setup advertises its supported HTTP transport", () => {
  assert.match(source, /http:\/\/model\.tailnet\.ts\.net:11434\/v1/u);
});

test("onboarding is an application modal with an explicit provider deferral", () => {
  assert.match(source, /<DialogPrimitive\.Root open>/u);
  assert.match(source, /const \[open, setOpen\] = React\.useState\(true\)/u);
  assert.match(source, /data-onboarding-active="true"/u);
  assert.match(source, /<DialogPrimitive\.Content[\s\S]*?data-slot="dialog-content"/u);
  assert.match(source, /onEscapeKeyDown=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(source, /<DialogPrimitive\.Title className="sr-only">Set up Aiden/u);
  assert.match(source, /if \(!canContinue \|\| savingRef\.current\) return/u);
  assert.match(source, /aria-busy=\{saving \|\| undefined\}/u);
  assert.match(source, /aria-current=\{itemIndex === index \? "step" : undefined\}/u);
  assert.match(source, />\s*Skip provider\s*</u);
  assert.match(source, /setProviderSkipped\(true\)/u);
  assert.match(source, /providerSkipped \|\| !selectedProviderId \? "deferred" : "completed"/u);
  assert.match(source, /Provider setup skipped/u);
  assert.doesNotMatch(source, />\s*Set up later\s*</u);
  assert.match(source, /setOpen\(shouldOpenOnboarding\(snapshot\.outcome\)\)/u);
  assert.ok((source.match(/disabled=\{saving\}/gu) ?? []).length >= 5);
});

test("Other ways OpenAI, Anthropic, and Tailscale choices reuse ProviderIcon wells", () => {
  const moreWays = sourceSection("data-onboarding-more-providers", "{moreProviders.map((provider) => {");
  assert.match(
    moreWays,
    /\["openai-key", "anthropic", "tailscale"\][\s\S]*providerId=\{item\.iconProviderId\}/u,
  );
  assert.match(moreWays, /rounded-control bg-popover text-primary shadow-control/u);
  assert.match(providerPresentation, /iconProviderId: "openai"/u);
  assert.match(providerPresentation, /iconProviderId: "anthropic"/u);
  assert.match(providerPresentation, /iconProviderId: "tailscale"/u);
});

test("profile onboarding keeps Web Search default-on without a first-run toggle", () => {
  const profileStep = source.slice(
    source.indexOf('step === "profile"'),
    source.indexOf('step === "provider"'),
  );
  assert.doesNotMatch(profileStep, /data-onboarding-web-search/u);
  assert.doesNotMatch(profileStep, /Allow Web Search in attended chats/u);
  assert.doesNotMatch(source, /useWebSearch\(/u);
  assert.doesNotMatch(source, /webSearchApi/u);
  assert.doesNotMatch(source, /setWebSearchEnabled/u);
  assert.match(
    featurePresentation,
    /Search the live web when needed—on by default with anonymous Exa, with a reviewed provider zoo in Settings\./u,
  );
});

test("hosted keys validate before selection and endpoint routes require discovered models", () => {
  const hostedKeyFlow = source.slice(
    source.indexOf("const validateHostedApiKey"),
    source.indexOf("const skipProvider"),
  );
  const validate = hostedKeyFlow.indexOf("providersApi.validateOnboardingApiKey");
  const publish = hostedKeyFlow.indexOf("queryClient.setQueryData<Provider[]>", validate);
  const select = hostedKeyFlow.indexOf("persistModelSelection(saved.id", validate);
  assert.ok(validate >= 0 && validate < publish && publish < select);
  const providerStep = source.slice(
    source.indexOf('if (step === "provider")'),
    source.indexOf("  return (", source.indexOf('if (step === "provider")')),
  );
  assert.match(
    providerStep,
    /needsEndpointDiscovery = isLocalRuntime \|\| choice === "tailscale"/u,
  );
  assert.match(providerStep, /if \(!defaultModel\)[\s\S]*?no chat models were found/u);
  assert.match(
    source,
    /title=\{`Connect \$\{apiKeyDialogChoice === "openai-key" \? "OpenAI" : "Anthropic"\}`\}/u,
  );
  assert.match(source, /confirmLabel=\{discovering \? "Validating…" : "Validate & continue"\}/u);
  assert.match(source, /type="password"[\s\S]*?Paste your API key/u);
  assert.doesNotMatch(source, /<Text variant="small-strong">API key<\/Text>/u);
});

test("onboarding presentation stays compact and free of decorative gradients", () => {
  assert.doesNotMatch(source, /blur-3xl|backdrop-blur|bg-gradient/u);
  assert.doesNotMatch(providerPresentation, /footnote|Default URL|127\.0\.0\.1/u);
  assert.doesNotMatch(
    providerPresentation,
    /The key stays on this Mac and can be rotated later in Settings\./u,
  );
  assert.match(source, /shadow-onboarding/u);
  assert.match(source, /px-4 pb-4 pt-11/u);
  assert.doesNotMatch(source, /max-\[760px\]:rounded-none|max-\[760px\]:shadow-none/u);
  assert.match(source, /border-transparent bg-input[\s\S]*?focus:border-transparent/u);
});

test("the final step is a complete grouped bento gallery with hover descriptions", () => {
  assert.match(source, /Queue follow-ups, edit them, or steer the next response/u);
  assert.match(source, /data-onboarding-bento/u);
  assert.match(source, /data-onboarding-feature-count=\{visibleFeatureBentos\.length\}/u);
  assert.match(source, /FEATURE_LAYOUTS[\s\S]*?col-span-4 row-span-2/u);
  assert.match(source, /group-hover:opacity-100/u);
  assert.match(source, /group-focus:opacity-100/u);
  assert.match(
    source,
    /Use Command-K or \/ for app commands, and \$ to attach a reusable skill\./u,
  );
  assert.match(
    source,
    /Skills can allow automatic use, explicit attachment with \$, or both\. Turn all skills off anytime in Settings → Skills\./u,
  );
  assert.match(
    source,
    /Keep chats grouped with folders, scratch spaces, and isolated worktrees in one workspace outline\./u,
  );
  assert.match(
    featurePresentation,
    /Search the live web when needed—on by default with anonymous Exa, with a reviewed provider zoo in Settings\./u,
  );
  assert.doesNotMatch(featurePresentation, /choose to connect it/u);
  assert.doesNotMatch(source, /<article[\s\S]*?tabIndex=\{0\}/u);
  assert.match(source, /Phone and tablet access starts off[\s\S]*?Settings →\s*Connections/u);
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
    "Aiden Live",
    "Reusable Bots",
    "Scheduled Automations",
    "Voice & Dictation",
    "Command Palette",
    "Private Usage Profile",
    "Permissioned by Default",
    "Themes & Accessibility",
    "Aiden in Telegram",
    "Aiden On The Go",
  ]) {
    assert.match(featurePresentation, new RegExp(title, "u"));
  }
  assert.match(featurePresentation, /reopen it with sanitized local history/u);
  assert.match(featurePresentation, /explicitly choose an image-understanding companion/u);
  assert.match(featurePresentation, /workspace agent show raster images inline/u);
  assert.match(featurePresentation, /one persistent chat, explicit image understanding/u);
  assert.match(
    featurePresentation,
    /Ask Aiden in any chat to schedule recurring work, review its unattended access/u,
  );
  assert.match(
    featurePresentation,
    /benchmark-only OpenRouter key never imports its model catalog/u,
  );
  assert.match(featurePresentation, /Live catalog checks happen only when you choose/u);
  assert.match(featurePresentation, /ordinary browsing stays offline/u);
  assert.match(featurePresentation, /Keep audio on-device with Parakeet/u);
  assert.match(featurePresentation, /explicitly connect cloud transcription/u);
  assert.match(featurePresentation, /Browser & Annotations/u);
  assert.match(featurePresentation, /Browser profiles keep their own local sign-ins/u);
  assert.match(featurePresentation, /Incognito is temporary/u);
  assert.doesNotMatch(featurePresentation, /Designer Mode|Image Generation|Proactive nudges/u);
});

test("every advertised feature has its own one-megapixel PNG with alpha", () => {
  assert.equal(featureAssetPaths.length, 27);
  assert.ok(featureAssetPaths.includes("features/telegram-remote-control.png"));
  assert.ok(featureAssetPaths.includes("features/aiden-on-the-go.png"));
  assert.ok(featureAssetPaths.includes("features/bots.png"));
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

test("primary AI choices include custom setup without opening advanced providers", () => {
  assert.match(source, /\["openai-signin", "lmstudio", "ollama", "custom"\]/u);
  for (const title of ["ChatGPT", "LM Studio", "Ollama", "Other Custom Provider"]) {
    assert.ok(source.includes(`title: "${title}"`));
  }
  assert.match(source, /<ProviderEditor[\s\S]*?layer="onboarding"[\s\S]*?requireReady/u);
  const editor = readFileSync(new URL("./settings/provider-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /requireReady &&/u);
  assert.match(editor, /models.length === 0/u);
  assert.match(editor, /defaultModelIsHidden/u);
  assert.match(editor, /await onSaved\(\)/u);
});


test("MCP onboarding discloses service-supplied tool guidance", () => {
  assert.match(source, /Connected services may also provide guidance for using those tools\./u);
});

test("MCP tour explains connected-service resource reads", () => {
  assert.match(readFileSync(new URL("./onboarding-flow.tsx", import.meta.url), "utf8"), /read the resources they share/);
});

test("blocked form filling is not advertised as a shipped tour feature", () => {
  assert.doesNotMatch(featurePresentation, /id: "formFill"/u);
});

test("workspace tour discloses AGENTS instruction loading and refresh", () => {
  assert.match(source, /global and workspace AGENTS\.md guidance, refreshing it between model turns/);
});


test("provider onboarding explains separate opt-in and cloud speech privacy without network setup", () => {
  const disclosure = source.slice(source.indexOf("data-onboarding-tts-privacy"), source.indexOf("</Text>", source.indexOf("data-onboarding-tts-privacy")));
  assert.match(disclosure, /off by default/u);
  assert.match(disclosure, /Settings → Text to Speech/u);
  assert.match(disclosure, /response text to Google/u);
  assert.match(disclosure, /local-model replies/u);
  assert.match(disclosure, /charges may apply/u);
  assert.doesNotMatch(source, /ttsApi\.(start|preview)/u);
});

test("feature tour introduces native folder browsing and source previews", () => {
  assert.match(source, /On your phone, expand folders on demand and preview source before editing\./u);
});


test("platform feature filtering preserves classifier consent and unavailable-feature boundaries", () => {
  const features = [
    { id: "models", description: "Platform model choices" },
    { id: "commands", description: "Use Command-K to open commands." },
    { id: "computerUse", description: "Control the desktop." },
    { id: "bots", description: "Configure a Bot." },
  ];
  const linux = visibleOnboardingFeatures(features, { platform: "linux", computerUse: false, bots: false });
  assert.deepEqual(linux.map(({ id }) => id), ["models", "commands"]);
  assert.match(linux[0]!.description, /classifiers.*approve sending it; provider charges/u);
  assert.match(linux[0]!.description, /Enable local llama.cpp classification.*More options/u);
  assert.doesNotMatch(linux[0]!.description, /Apple/u);
  assert.match(linux[1]!.description, /Ctrl-K/u);
  assert.equal(features[1]!.description, "Use Command-K to open commands.");
  const mac = visibleOnboardingFeatures(features, { platform: "darwin", computerUse: true, bots: true });
  assert.equal(mac.length, 4);
  assert.match(mac[0]!.description, /Apple models/u);
  assert.match(mac[0]!.description, /classifiers.*approve sending it; provider charges/u);
  assert.match(mac[0]!.description, /Enable local llama.cpp classification.*More options/u);
});
