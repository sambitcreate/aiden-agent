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
import { BOT_AVATAR_COLORS } from "../shared/bots.js";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
import { FEATURE_ART } from "./onboarding-art/feature-art.js";

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

function sourceSection(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `Missing source section start: ${startMarker}`);
  assert.ok(end > start, `Missing source section end: ${endMarker}`);
  return source.slice(start, end);
}

const providerPresentation = sourceSection("const providerChoices", "function OnboardingDialogShell");
/** Rendered markup as the reader sees its text. */
function markupText(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/\s+/gu, " ");
}
const galleryMarkup = renderToStaticMarkup(
  <OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />,
);
const featurePresentation = markupText(galleryMarkup);
const galleryTiles = galleryMarkup.match(/<article\b[\s\S]*?<\/article>/gu) ?? [];
function tileMarkup(id: string): string {
  const tile = galleryTiles.find((markup) => markup.includes(`data-onboarding-feature="${id}"`));
  assert.ok(tile, `missing tour tile ${id}`);
  return tile;
}

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
  assert.match(
    source,
    /<OnboardingFeatureGallery features=\{visibleFeatureBentos\} platform=\{capabilities\.platform\} \/>/u,
  );
  assert.match(featurePresentation, /Queue follow-ups, edit them, or steer the next response/u);
  assert.match(galleryMarkup, new RegExp(`data-onboarding-feature-count="${onboardingFeatures.length}"`, "u"));
  for (const hero of onboardingFeatures.filter((feature) => feature.size === "hero")) {
    assert.match(tileMarkup(hero.id), /^<article [^>]*class="[^"]*col-span-4 row-span-2/u, hero.id);
  }
  assert.match(galleryMarkup, /group-hover:opacity-100/u);
  assert.match(galleryMarkup, /group-focus:opacity-100/u);
  assert.match(
    featurePresentation,
    /Use Command-K or \/ for app commands, and \$ to attach a reusable skill\./u,
  );
  assert.match(
    featurePresentation,
    /Skills can allow automatic use, explicit attachment with \$, or both\. Turn all skills off anytime in Settings → Skills\./u,
  );
  assert.match(
    featurePresentation,
    /Keep chats grouped with folders, scratch spaces, and isolated worktrees in one workspace outline\./u,
  );
  assert.match(
    featurePresentation,
    /Search the live web when needed—on by default with anonymous Exa, with a reviewed provider zoo in Settings\./u,
  );
  assert.doesNotMatch(featurePresentation, /choose to connect it/u);
  assert.match(source, /Phone and tablet access starts off[\s\S]*?Settings →\s*Connections/u);
  for (const group of [
    "Build in your workspace",
    "Choose and extend",
    "Automate and stay in control",
  ]) {
    assert.match(featurePresentation, new RegExp(group, "u"));
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
    "Meet your Bots",
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
  assert.match(featurePresentation, /Each Bot keeps one chat, remembers its instructions, and can run on a schedule/u);
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
  assert.match(featurePresentation, /On-device models keep audio on this computer/u);
  assert.match(featurePresentation, /explicitly connect cloud transcription/u);
  assert.match(featurePresentation, /Browser & Annotations/u);
  assert.match(featurePresentation, /Browser profiles keep their own local sign-ins/u);
  assert.match(featurePresentation, /Incognito is temporary/u);
  assert.doesNotMatch(featurePresentation, /Designer Mode|Image Generation|Proactive nudges/u);
});

test("every tour tile draws its own themed illustration without raster assets", () => {
  const ids = onboardingFeatures.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(Object.keys(FEATURE_ART)), new Set(ids), "every tile has art and no art is orphaned");
  assert.equal(galleryTiles.length, onboardingFeatures.length);
  for (const group of ["create", "extend", "control"] as const) {
    let previousTint: string | undefined;
    for (const feature of onboardingFeatures.filter((item) => item.group === group)) {
      const tile = tileMarkup(feature.id);
      assert.match(tile, new RegExp(`<div aria-hidden="true" class="oa-art" data-onboarding-art="${feature.id}"`, "u"));
      assert.doesNotMatch(
        tile,
        /<img\b|<picture\b|url\([^)]*\.(?:png|jpe?g|webp|gif|avif)\b|data:image\/(?!svg)/iu,
        `${feature.id} must not load raster art`,
      );
      const tint = /--oa-tint:var\(--bot-avatar-([a-z]+)\)/u.exec(tile)?.[1];
      assert.ok(tint && (BOT_AVATAR_COLORS as readonly string[]).includes(tint), `${feature.id} tint ${tint}`);
      assert.notEqual(tint, previousTint, `${feature.id} repeats its neighbour's tint`);
      previousTint = tint;
    }
  }
});

test("the command palette tile draws the shortcuts of the platform it runs on", () => {
  const paletteText = (platform: "darwin" | "linux") =>
    markupText(
      renderToStaticMarkup(
        <OnboardingFeatureGallery
          features={onboardingFeatures.filter(({ id }) => id === "commands")}
          platform={platform}
        />,
      ),
    );
  const mac = paletteText("darwin");
  for (const label of ["⌘K", "⌘N", "⌘⇧F", "⌘J", "⌘,"]) assert.ok(mac.includes(label), `macOS ${label}`);
  const linux = paletteText("linux");
  for (const label of ["Ctrl+K", "Ctrl+N", "Ctrl+Shift+F", "Ctrl+J", "Ctrl+,"]) {
    assert.ok(linux.includes(label), `Linux ${label}`);
  }
  assert.doesNotMatch(linux, /[⌘⇧⌥]/u);
});

test("project guidance keeps the feature bento current as Aiden evolves", () => {
  assert.match(agentsInstructions, /feature-tour bento gallery/u);
  assert.match(agentsInstructions, /code-drawn illustration/u);
  assert.doesNotMatch(agentsInstructions, /transparent PNG/u);
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
  assert.match(featurePresentation, /Connected services may also provide guidance for using those tools\./u);
});

test("MCP tour explains connected-service resource reads", () => {
  assert.match(featurePresentation, /read the resources they share/u);
});

test("blocked form filling is not advertised as a shipped tour feature", () => {
  assert.doesNotMatch(galleryMarkup, /data-onboarding-feature="formFill"/u);
  assert.doesNotMatch(featurePresentation, /form fill/iu);
});

test("workspace tour discloses AGENTS instruction loading and refresh", () => {
  assert.match(featurePresentation, /global and workspace AGENTS\.md guidance, refreshing it between model turns/u);
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
  assert.match(featurePresentation, /On your phone, expand folders on demand and preview source before editing\./u);
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
