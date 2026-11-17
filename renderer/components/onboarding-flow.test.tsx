import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  discoveredDefaultModel,
  localProviderDraft,
  visibleOnboardingFeatures,
} from "../lib/onboarding-provider.js";
import type { Provider } from "../lib/types.js";
import { BOT_AVATAR_COLORS } from "../shared/bots.js";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
import { FEATURE_ART } from "./onboarding-art/feature-art.js";
import { hostPlatformCapabilities } from "../../main/services/host-platform-capabilities.js";

const source = readFileSync(new URL("./onboarding-flow.tsx", import.meta.url), "utf8");

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

  assert.deepEqual(localProviderDraft("lmstudio", [existing]), {
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
    localProviderDraft("ollama")?.baseUrl,
    "http://127.0.0.1:11434/v1",
  );
  assert.equal(localProviderDraft("lmstudio")?.id, "custom:lmstudio");
  assert.equal(localProviderDraft("ollama")?.id, "custom:ollama");
});

test("local discovery preserves a still-usable default before transient recommendations", () => {
  const provider = localProviderDraft("lmstudio");
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
    /Use your local skill folders and enabled installed Claude Code plugin skills\. Skills can allow automatic use, explicit attachment with \$, or both\. Turn all skills off anytime in Settings → Skills\./u,
  );
  assert.match(
    featurePresentation,
    /Start a chat in any folder, clone a repository, use a scratch space, or just chat with no workspace while Aiden keeps a private folder for files and Git\. Chats stay grouped with isolated worktrees in one workspace outline\./u,
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
    "Connectors",
    "Aiden Live",
    "Meet your Bots",
    "Bot computers",
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
  assert.match(featurePresentation, /Approve a whole plan in Aiden Agent or on your phone, follow its checklist, or stop it\./u);
  assert.match(featurePresentation, /listed actions within the Bot's access and limits, for this run and up to 60 minutes/u);
  assert.match(featurePresentation, /ask each other for help/u);
  // Bot computers are opt-in: the tile points to Settings and promises no download before Set up.
  assert.match(featurePresentation, /Set it up in Settings → Computers & VMs → Bot computers; nothing downloads until you choose Set up\./u);
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
  assert.match(featurePresentation, /On-device models keep audio on this Mac/u);
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
  for (const feature of onboardingFeatures) {
    const tile = tileMarkup(feature.id);
    assert.match(tile, new RegExp(`<div aria-hidden="true" class="oa-art" data-onboarding-art="${feature.id}"`, "u"));
    assert.doesNotMatch(
      tile,
      /<img\b|<picture\b|url\([^)]*\.(?:png|jpe?g|webp|gif|avif)\b|data:image\/(?!svg)/iu,
      `${feature.id} must not load raster art`,
    );
  }
  // Neighbouring tiles never share a tint, in the tour each platform really shows.
  for (const [name, host] of [
    ["Apple silicon Mac", hostPlatformCapabilities("darwin", "arm64")],
    ["Intel Mac", hostPlatformCapabilities("darwin", "x64")],
    ["Linux", hostPlatformCapabilities("linux", "x64")],
  ] as const) {
    const shown = visibleOnboardingFeatures(onboardingFeatures, host);
    const markup = renderToStaticMarkup(<OnboardingFeatureGallery features={shown} platform="darwin" />);
    const tiles = markup.match(/<article\b[\s\S]*?<\/article>/gu) ?? [];
    assert.equal(tiles.length, shown.length, name);
    for (const group of ["create", "extend", "control"] as const) {
      let previousTint: string | undefined;
      for (const feature of shown.filter((item) => item.group === group)) {
        const tile = tiles.find((item) => item.includes(`data-onboarding-feature="${feature.id}"`));
        const tint = tile ? /--oa-tint:var\(--bot-avatar-([a-z]+)\)/u.exec(tile)?.[1] : undefined;
        assert.ok(tint && (BOT_AVATAR_COLORS as readonly string[]).includes(tint), `${name}: ${feature.id} tint ${tint}`);
        assert.notEqual(tint, previousTint, `${name}: ${feature.id} repeats its neighbour's tint`);
        previousTint = tint;
      }
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

test("Connectors onboarding discloses service-supplied tool guidance", () => {
  assert.match(featurePresentation, /Connected services may also provide guidance for using those tools\./u);
});

test("Connectors tour explains connected-service resource reads", () => {
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
  assert.match(disclosure, /Settings → Voice & Speech → Text to Speech/u);
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
    { id: "botComputers", description: "Give a Bot a computer." },
    { id: "botWatches", description: "Watch a supported connector." },
    { id: "botOpenWork", description: "Track accepted Bot tasks." },
    { id: "botRoutineModels", description: "Choose a routine model." },
    { id: "botPeers", description: "Approve named Bot pairs." },
  ];
  const linux = visibleOnboardingFeatures(features, { platform: "linux", computerUse: false, bots: false, botComputers: false });
  assert.deepEqual(linux.map(({ id }) => id), ["models", "commands"]);
  assert.match(linux[0]!.description, /classifiers.*approve sending it; provider charges/u);
  assert.match(linux[0]!.description, /Enable local llama.cpp classification.*Advanced panel under Model options/u);
  assert.doesNotMatch(linux[0]!.description, /Apple/u);
  assert.match(linux[1]!.description, /Ctrl-K/u);
  assert.equal(features[1]!.description, "Use Command-K to open commands.");
  const mac = visibleOnboardingFeatures(features, { platform: "darwin", computerUse: true, bots: true, botComputers: true });
  assert.equal(mac.length, 9);
  assert.match(mac[0]!.description, /Apple models/u);
  assert.match(mac[0]!.description, /classifiers.*approve sending it; provider charges/u);
  assert.match(mac[0]!.description, /Enable local llama.cpp classification.*Advanced panel under Model options/u);
});

test("the Bot computers tile shows only where a Bot can have its own macOS computer", () => {
  const tiles = (host: Parameters<typeof visibleOnboardingFeatures>[1]) =>
    visibleOnboardingFeatures(onboardingFeatures, host).map(({ id }) => id);
  const appleSilicon = tiles(hostPlatformCapabilities("darwin", "arm64"));
  assert.ok(appleSilicon.includes("botComputers"));
  assert.equal(appleSilicon.indexOf("botComputers"), appleSilicon.indexOf("bots") + 1, "it follows Meet your Bots");
  for (const [name, host] of [
    ["Intel Mac", hostPlatformCapabilities("darwin", "x64")],
    ["Linux", hostPlatformCapabilities("linux", "arm64")],
    ["a Mac with Bots turned off", { ...hostPlatformCapabilities("darwin", "arm64"), bots: false }],
  ] as const) {
    assert.equal(tiles(host).includes("botComputers"), false, name);
  }
  assert.ok(tiles(hostPlatformCapabilities("linux", "x64")).includes("bots"), "Linux still meets its Bots");
});
