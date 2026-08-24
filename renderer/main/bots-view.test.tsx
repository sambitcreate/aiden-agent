import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BOT_CANONICAL_PHOTO_CACHE_MAX_BYTES,
  BOT_CANONICAL_PHOTO_MAX_CONCURRENT,
  BotCanonicalPhotoCache,
} from "../lib/bot-canonical-photo-cache";
import {
  rebaseBotEditorAccessDraft,
  rebaseBotEditorIdentityDraft,
  type BotEditorAccessDraft,
  type BotEditorIdentityDraft,
} from "../shared/bot-editor-save";
import { DEFAULT_BOT_AVATAR } from "../shared/bots";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("bots have dedicated roster, detail, and Pi chat routes", () => {
  const router = source("./router.tsx");
  const guard = source("./bot-chat-route.tsx");
  assert.match(router, /path: "\/bots"[\s\S]*component: BotsView/u);
  assert.match(router, /path: "\/bots\/\$botId"[\s\S]*component: BotsView/u);
  assert.match(
    router,
    /path: "\/bots\/\$botId\/chat\/\$chatId"[\s\S]*<BotChatRouteView botId=\{botId\} chatId=\{chatId\}/u,
  );
  assert.match(guard, /<ChatPane chatId=\{chatId\}/u);
  assert.match(guard, /actualBotId === botId/u);
  assert.match(guard, /Opening the correct conversation/u);
});

test("bots UI reports query failures and offers an in-place retry", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /bots\.isError[\s\S]*Aiden could not load your bots/u);
  assert.match(view, /chats\.isError[\s\S]*Aiden could not load this bot’s conversations/u);
  assert.match(view, /bots\.refetch\(\)/u);
  assert.match(view, /chats\.refetch\(\)/u);
});

test("bot detail owns one-to-one Telegram bind and unbind controls", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /botsApi\.bindTelegram/u);
  assert.match(view, /botsApi\.unbindTelegram/u);
  assert.match(view, /Tokens, owner pairing, model, and workspace stay managed/u);
  assert.match(view, /A target can belong to only one bot/u);
});

test("bots UI edits definitions and creates conversations through dedicated IPC", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /botsApi\.create\(\{\s*bot: createInputFromDraft\(draft\),\s*access:/u);
  assert.match(
    view,
    /botsApi\.update\(\{\s*id: authoritativeBot\.id,\s*expectedRevision: authoritativeBot\.revision,/u,
  );
  assert.match(view, /openingGreeting: authoritative\.openingGreeting/u);
  assert.match(view, /botsApi\.createChat\(\{ botId: selected\.id, workspaceId: activeId \}\)/u);
  assert.match(
    view,
    /botsApi\.archive\(\{ id: selected\.id, expectedRevision: selected\.revision \}\)/u,
  );
  assert.match(
    view,
    /botsApi\.restore\(\{ id: selected\.id, expectedRevision: selected\.revision \}\)/u,
  );
  assert.match(view, /maxLength=\{32_000\}/u);
});

test("bot editor owns access mode, model selection, and capability toggles", () => {
  const view = source("./bots-view.tsx");
  const queries = source("../lib/queries.ts");
  const saveHelpers = source("../shared/bot-editor-save.ts");
  // Access draft mirrors the iOS editor: one model selection for both modes.
  assert.match(view, /type BotAccessDraft = BotEditorAccessDraft/u);
  assert.match(saveHelpers, /usesFullAccess: boolean;/u);
  assert.match(view, /function botFullAccessAccepted\(catalog/u);
  assert.match(view, /function buildBotAccessUpdate\(/u);
  assert.match(view, /function botAccessDiffers\(/u);
  // Notice gating before Full Access can be saved.
  assert.match(view, /acknowledgeAccessNotice\(\{/u);
  assert.match(view, /decision,\s*confirmedForeground: true/u);
  assert.match(view, /BOT_FULL_ACCESS_NOTICE_VERSION/u);
  assert.match(view, /Continue with Full Access/u);
  assert.match(view, /Customize first/u);
  // Catalog-driven provider and model pickers.
  assert.match(view, /aria-label="AI provider for this bot"/u);
  assert.match(view, /aria-label="AI model for this bot"/u);
  assert.match(view, /Credentials stay on your Mac/u);
  assert.match(view, /Image understanding/u);
  assert.match(view, /aria-label="Image understanding provider for this bot"/u);
  assert.match(view, /aria-label="Image understanding model for this bot"/u);
  assert.match(view, /The attached image and a focused question go to this provider/u);
  assert.match(view, /No image-capable model is connected/u);
  assert.match(view, /Settings → Providers/u);
  // Capability toggles with Full-mode disabling, matching the iOS sections.
  assert.match(view, /aria-label=\{`Allow \$\{option\.label\} for this bot`\}/u);
  assert.match(view, /aria-label="Allow run commands for this bot"/u);
  assert.match(view, /accessDraft\.usesFullAccess/u);
  // Save re-reads and three-way rebases the authoritative policy before updating access.
  assert.match(view, /botsApi\.getBotAccess\(saved\.id\)/u);
  assert.match(view, /rebaseBotEditorAccessDraft\(/u);
  assert.match(
    view,
    /botsApi\.updateBotAccess\(\{\s*botId: saved\.id,\s*expectedRevision: state\.access\.revision,\s*access: update,/u,
  );
  assert.match(view, /invalidateQueries\(\{ queryKey: queryKeys\.botAccess\(saved\.id\) \}\)/u);
  assert.match(view, /invalidateQueries\(\{ queryKey: queryKeys\.botCapabilityCatalog \}\)/u);
  assert.match(queries, /botCapabilityCatalog: \["bot-capability-catalog"\] as const/u);
  assert.match(queries, /useBotCapabilityCatalog\(enabled: boolean\)/u);
  assert.match(queries, /useBotAccess\(botId: string \| undefined\)/u);
});

test("Bot editor retries preserve only deliberate identity and access edits", () => {
  const baselineIdentity: BotEditorIdentityDraft = {
    name: "Planner",
    description: "Plans projects",
    instructions: "Plan carefully",
    avatar: { ...DEFAULT_BOT_AVATAR },
  };
  const userIdentity = { ...baselineIdentity, name: "Launch Planner" };
  const authoritativeIdentity = {
    ...baselineIdentity,
    description: "Changed from another surface",
    instructions: "New Mac instructions",
  };
  assert.deepEqual(
    rebaseBotEditorIdentityDraft(userIdentity, baselineIdentity, authoritativeIdentity),
    { ...authoritativeIdentity, name: "Launch Planner" },
  );

  const baselineAccess: BotEditorAccessDraft = {
    usesFullAccess: false,
    providerId: "provider:a",
    modelId: "model:a",
    visionProviderId: "provider:vision",
    visionModelId: "model:vision",
    fileScopeIds: ["scope:home"],
    shellEnabled: false,
    connectionIds: [],
    skillIds: ["skill:a"],
    otherCapabilityIds: [],
  };
  const userAccess = { ...baselineAccess, modelId: "model:user" };
  const authoritativeAccess = {
    ...baselineAccess,
    shellEnabled: true,
    skillIds: ["skill:mac"],
  };
  assert.deepEqual(
    rebaseBotEditorAccessDraft(userAccess, baselineAccess, authoritativeAccess),
    { ...authoritativeAccess, modelId: "model:user" },
  );

  const userVisionAccess = {
    ...baselineAccess,
    visionProviderId: "provider:vision-2",
    visionModelId: "model:vision-2",
  };
  assert.deepEqual(
    rebaseBotEditorAccessDraft(userVisionAccess, baselineAccess, authoritativeAccess),
    {
      ...authoritativeAccess,
      visionProviderId: "provider:vision-2",
      visionModelId: "model:vision-2",
    },
  );

  const concurrentProviderChange = {
    ...authoritativeAccess,
    providerId: "provider:mac",
    modelId: "model:mac",
  };
  assert.deepEqual(
    rebaseBotEditorAccessDraft(userAccess, baselineAccess, concurrentProviderChange),
    { ...concurrentProviderChange, providerId: "provider:a", modelId: "model:user" },
  );
});

test("bot detail surfaces the current access mode and bound model", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /function BotAccessSummary\(/u);
  assert.match(view, /Full Access/u);
  assert.match(view, /Custom Access/u);
  assert.match(view, /botModelLabel\(catalogQuery\.data, state\)/u);
  assert.match(view, /BOT_ACCESS_SUMMARIES\.full/u);
  assert.match(view, /BOT_ACCESS_SUMMARIES\.custom/u);
});

test("bot editor is a five-page wizard with gated Next, Back, and a review Confirm", () => {
  const view = source("./bots-view.tsx");
  const styles = source("../styles.css");
  // Page inventory: identity, access, model, capabilities, review.
  assert.match(view, /const BOT_EDITOR_STEPS = \[/u);
  assert.match(view, /title: "Identity"/u);
  assert.match(view, /title: "Access"/u);
  assert.match(view, /title: "Model"/u);
  assert.match(view, /title: "Capabilities"/u);
  assert.match(view, /title: "Review"/u);
  // The dialog's primary action advances pages and only confirms on the last.
  assert.match(view, /confirmLabel=\{isLastStep \? \(bot \? "Save changes" : "Create bot"\) : "Next"\}/u);
  assert.match(view, /onConfirm=\{isLastStep \? save : goNext\}/u);
  assert.match(view, /confirmDisabled=\{saving \|\| !stepValid\[step\]\}/u);
  // Per-page gating, including the review page re-checking every prior page.
  assert.match(view, /const stepValid = \[/u);
  assert.match(
    view,
    /identityReady && settingsReady,\s*\];/u,
  );
  assert.match(view, /if \(!stepValid\[step\]\) return;/u);
  // Back navigation and an announced step counter.
  assert.match(view, /<ArrowLeft \/> Back/u);
  assert.match(view, /setStep\(\(current\) => Math\.max\(0, current - 1\)\)/u);
  assert.match(view, /aria-live="polite"[\s\S]*Step \{step \+ 1\} of \{BOT_EDITOR_STEPS\.length\}/u);
  // Focus moves to the page heading after Next for keyboard users.
  assert.match(view, /pageTopRef\.current\?\.focus\(\)/u);
  // Review page summarizes every choice before Confirm.
  assert.match(view, /summaryRow\("Name", draft\.name\.trim\(\)\)/u);
  assert.match(view, /summaryRow\(\s*"Access",\s*accessDraft\.usesFullAccess \? "Full Access" : "Custom Access",/u);
  assert.match(view, /Everything Aiden and this Mac allow/u);
  assert.match(view, /Credentials stay on your Mac/u);
  // Page swap motion is quiet and disabled under reduced motion.
  assert.match(view, /aiden-bot-wizard-page/u);
  assert.match(styles, /\.aiden-bot-wizard-page \{/u);
  assert.match(styles, /aiden-bot-wizard-page-in 220ms/u);
  assert.match(
    styles,
    /\.aiden-bot-wizard-page \{\s*animation: none;\s*\}/u,
  );
});

test("bot wizard pages stay visually aligned and hide dead capability rows", () => {
  const view = source("./bots-view.tsx");
  // No per-page h3: the dialog description and step counter already identify
  // the page, and a second heading misaligned with card labels.
  assert.doesNotMatch(view, /<h3/u);
  assert.match(view, /ref=\{pageTopRef\}\s*\n?\s*tabIndex=\{-1\}/u);
  // One Access label, not two: the access card carries only a description.
  assert.doesNotMatch(view, /label="Access"/u);
  assert.match(view, /<Field description="Custom Access can reduce/u);
  // Model picks stack full-width so long model names never truncate.
  assert.match(view, /orientation="vertical"\s*\n?\s*label="AI provider and model"/u);
  assert.match(view, /<div className="grid gap-3">/u);
  // Capability lists are vertical and hide unavailable, unselected tombstones
  // (e.g. "Invalid skill" rows) the same way iOS does.
  assert.match(
    view,
    /option\.available \|\| accessDraft\[key\]\.includes\(option\.id\)/u,
  );
  assert.match(
    view,
    /option\.available \|\| accessDraft\.fileScopeIds\.includes\(option\.id\)/u,
  );
  assert.match(view, /orientation="vertical"\s*\n?\s*label="Files and commands"/u);
  assert.match(view, /orientation="vertical" label=\{title\} description=\{description\}/u);
  // Rows get contained hover-target styling instead of floating bare rows.
  assert.match(view, /rounded-control px-3 py-2\.5/u);
  // Bigger, higher-contrast step dots and a roomier nav row.
  assert.match(view, /size-2 rounded-full/u);
  assert.match(view, /index === step \? "bg-accent" : "bg-control-hover"/u);
  assert.match(view, /justify-between gap-4/u);
});

test("bot avatars migrate durable ids into layered mouthless face recipes", () => {
  const avatar = source("../components/bot-avatar.tsx");
  const contract = source("../shared/bots.ts");
  const styles = source("../styles.css");
  assert.match(contract, /\["spark", "orbit", "leaf", "prism", "wave", "ember"\]/u);
  assert.match(contract, /LEGACY_BOT_AVATAR_APPEARANCES/u);
  assert.match(contract, /shape: "squircle"|"squircle"/u);
  assert.match(contract, /isBotAvatarAppearance/u);
  assert.match(avatar, /const avatarBodies: Record<BotAvatarShape/u);
  assert.match(avatar, /function EyePair/u);
  assert.match(avatar, /resolveBotAvatar\(avatar\)/u);
  assert.match(avatar, /var\(--bot-avatar-face\)/u);
  assert.match(avatar, /BotSidebarIcon[\s\S]*className="size-5"/u);
  assert.doesNotMatch(avatar, /Mouth|mouth/u);
  assert.doesNotMatch(avatar, /lucide-react/u);
  assert.equal(styles.match(/--bot-avatar-face: #292735/gu)?.length, 2);
  for (const color of ["lilac", "sky", "mint", "sun", "periwinkle", "coral", "peach", "aqua"]) {
    assert.equal(styles.match(new RegExp(`--bot-avatar-${color}:`, "gu"))?.length, 2, color);
  }
});

test("existing Mac Bot surfaces overlay canonical photos and retain semantic fallbacks", () => {
  const avatar = source("../components/bot-avatar.tsx");
  const view = source("./bots-view.tsx");
  const pane = source("./chat-pane.tsx");
  const cache = source("../lib/bot-canonical-photo-cache.ts");
  const root = source("./root-view.tsx");
  assert.match(avatar, /<AvatarFace avatar=\{avatar\} \/>/u);
  assert.match(avatar, /new IntersectionObserver/u);
  assert.match(avatar, /rootMargin: "160px"/u);
  assert.match(avatar, /setNearViewport\(entries\.some\(\(\{ isIntersecting \}\) => isIntersecting\)\)/u);
  assert.match(avatar, /photoLoading === "immediate" \? "selected" : "visible"/u);
  assert.match(avatar, /src=\{photo\.dataUrl\}/u);
  assert.match(avatar, /onError=\{\(\) => setFailedRevision\(photo\.assetRevision\)\}/u);
  assert.equal(view.match(/<BotAvatar botId=/gu)?.length, 2);
  assert.match(view, /botId=\{bot\.id\}[\s\S]{0,140}photoLoading="visible"/u);
  assert.match(view, /botId=\{selected\.id\}[\s\S]{0,160}photoLoading="immediate"/u);
  assert.match(pane, /botId=\{bot\.data\.id\}[\s\S]{0,160}photoLoading="immediate"/u);
  assert.match(cache, /BOT_CANONICAL_PHOTO_MAX_CONCURRENT = 4/u);
  assert.match(cache, /BOT_CANONICAL_PHOTO_CACHE_MAX_BYTES = 32 \* 1_048_576/u);
  assert.match(root, /invalidateBotCanonicalPhotos\(\)/u);
});

function canonicalPhoto(id: number, bytes = 12) {
  return {
    assetRevision: `avatar_revision_${id.toString(16).padStart(32, "0")}`,
    dataUrl: `data:image/png;base64,${Buffer.alloc(bytes, id % 255).toString("base64")}` as const,
  };
}

test("a maximum Bot roster has bounded parallel reads and retained canonical-photo bytes", async () => {
  let running = 0;
  let maxRunning = 0;
  const cache = new BotCanonicalPhotoCache(async (botId) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await Promise.resolve();
    running -= 1;
    return canonicalPhoto(Number(botId.slice(4)), 12);
  }, { maxConcurrent: 4, maxBytes: 48, maxEntries: 4 });
  for (let index = 0; index < 256; index += 1) cache.request(`bot${index}`, "visible");
  assert.deepEqual(cache.stats(), { active: 4, queued: 252, entries: 0, bytes: 0 });
  await cache.settle();
  assert.equal(maxRunning, BOT_CANONICAL_PHOTO_MAX_CONCURRENT);
  assert.ok(cache.stats().entries <= 4);
  assert.ok(cache.stats().bytes <= 48);
  assert.ok(cache.stats().bytes < BOT_CANONICAL_PHOTO_CACHE_MAX_BYTES);
});

test("rapidly offscreen roster rows cancel queued canonical-photo reads", async () => {
  const calls: string[] = [];
  let releaseActive: (() => void) | undefined;
  const active = new Promise<void>((resolve) => { releaseActive = resolve; });
  const cache = new BotCanonicalPhotoCache(async (botId) => {
    calls.push(botId);
    await active;
    return canonicalPhoto(calls.length);
  }, { maxConcurrent: 4, maxBytes: 1_024, maxEntries: 8 });

  for (let index = 0; index < 256; index += 1) {
    const leaveViewport = cache.subscribe(`bot${index}`, "visible", () => undefined);
    cache.request(`bot${index}`, "visible");
    leaveViewport();
  }

  assert.equal(calls.length, BOT_CANONICAL_PHOTO_MAX_CONCURRENT);
  assert.deepEqual(cache.stats(), { active: 4, queued: 0, entries: 0, bytes: 0 });
  releaseActive!();
  await cache.settle();
  assert.equal(calls.length, BOT_CANONICAL_PHOTO_MAX_CONCURRENT);
  assert.equal(cache.stats().queued, 0);

  const leaveAfterReentry = cache.subscribe("bot4", "visible", () => undefined);
  cache.request("bot4", "visible");
  await cache.settle();
  leaveAfterReentry();
  assert.equal(calls.length, BOT_CANONICAL_PHOTO_MAX_CONCURRENT + 1);
  assert.ok(cache.snapshot("bot4"));
});

test("a selected Bot photo jumps ahead of queued roster work", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const cache = new BotCanonicalPhotoCache(async (botId) => {
    calls.push(botId);
    if (botId === "roster-first") await first;
    return canonicalPhoto(calls.length);
  }, { maxConcurrent: 1, maxBytes: 1_024, maxEntries: 8 });
  cache.request("roster-first", "visible");
  cache.request("roster-second", "visible");
  cache.request("selected", "selected");
  assert.deepEqual(calls, ["roster-first"]);
  releaseFirst!();
  await cache.settle();
  assert.deepEqual(calls, ["roster-first", "selected", "roster-second"]);
  assert.equal(cache.snapshot("selected")?.assetRevision, canonicalPhoto(2).assetRevision);
});

test("an evicted roster photo reloads after leaving and re-entering the viewport", async () => {
  const calls: string[] = [];
  const cache = new BotCanonicalPhotoCache(async (botId) => {
    calls.push(botId);
    return canonicalPhoto(calls.length);
  }, { maxConcurrent: 1, maxBytes: 1_024, maxEntries: 1 });

  const leaveViewport = cache.subscribe("first", "visible", () => undefined);
  cache.request("first", "visible");
  await cache.settle();
  leaveViewport();

  cache.request("second", "visible");
  await cache.settle();
  assert.equal(cache.snapshot("first"), undefined);

  const leaveAgain = cache.subscribe("first", "visible", () => undefined);
  cache.request("first", "visible");
  await cache.settle();
  leaveAgain();

  assert.deepEqual(calls, ["first", "second", "first"]);
  assert.equal(cache.snapshot("first")?.assetRevision, canonicalPhoto(3).assetRevision);
  assert.equal(cache.stats().entries, 1);
});

test("visible and selected subscribers share one active canonical-photo read", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const loading = new Promise<void>((resolve) => { release = resolve; });
  const cache = new BotCanonicalPhotoCache(async () => {
    calls += 1;
    await loading;
    return canonicalPhoto(calls);
  }, { maxConcurrent: 2, maxBytes: 1_024, maxEntries: 2 });

  cache.request("shared", "visible");
  cache.request("shared", "selected");
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(), { active: 1, queued: 0, entries: 0, bytes: 0 });
  release!();
  await cache.settle();
  assert.equal(calls, 1);
});

test("bot editor provides live manual controls and configured Pi model design", () => {
  const view = source("./bots-view.tsx");
  const studio = source("../components/bot-face-studio.tsx");
  assert.match(view, /<BotFaceStudio/u);
  assert.match(view, /editorOpen \? <BotEditor/u);
  assert.match(studio, /Bot face/u);
  assert.match(studio, /BOT_AVATAR_SHAPES\.map/u);
  assert.match(studio, /BOT_AVATAR_COLORS\.map/u);
  assert.match(studio, /BOT_AVATAR_EYES\.map/u);
  assert.match(studio, /BOT_AVATAR_DETAILS\.map/u);
  assert.match(studio, /botsApi\.suggestAvatar/u);
  assert.match(studio, /botsApi\.cancelAvatarSuggestion/u);
  assert.match(studio, /globalThis\.crypto\.randomUUID\(\)/u);
  assert.match(studio, /createChatModelProviders/u);
  assert.match(studio, /useProvidersModelInfo/u);
  assert.match(studio, /resolveExplicitModelSelection/u);
  assert.match(studio, /useProviders\(\)/u);
  assert.match(studio, /Bot face provider/u);
  assert.match(studio, /Bot face model/u);
  assert.match(studio, /No Gemini key or avatar\s+image\s+upload/u);
  assert.doesNotMatch(studio, /gemini_api_key|Google Gemini API Key/u);
});

test("bot editor fences in-flight saves and exposes keyboard-operable face tabs", () => {
  const view = source("./bots-view.tsx");
  const studio = source("../components/bot-face-studio.tsx");
  assert.match(view, /if \(savingRef\.current\) return;/u);
  assert.match(view, /<BotFaceStudio[\s\S]*disabled=\{saving\}/u);
  assert.match(view, /value=\{draft\.name\}[\s\S]{0,100}disabled=\{saving\}/u);
  assert.match(view, /value=\{draft\.instructions\}[\s\S]{0,100}disabled=\{saving\}/u);
  assert.match(studio, /role="tablist"/u);
  assert.match(studio, /role="tab"/u);
  assert.match(studio, /role="tabpanel"/u);
  assert.match(studio, /event\.key === "ArrowRight"/u);
  assert.match(studio, /event\.key === "ArrowLeft"/u);
  assert.match(studio, /aria-selected=\{state\.tab === value\}/u);
});

test("bot chats show authoritative bot identity and fence archived conversations", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /const bot = useBot\(chat\.data\?\.botId\)/u);
  assert.match(pane, /Restore this bot before continuing the conversation/u);
  assert.match(pane, /<BotAvatar botId=\{bot\.data\.id\} avatar=\{bot\.data\.avatar\}[\s\S]{0,160}photoLoading="immediate"/u);
  assert.match(pane, /!botReadinessMessage/u);
  assert.match(pane, /chat\.data\?\.title \?\? "New conversation"/u);
});

test("Bots is a stable sidebar destination and bot rosters do not open the terminal", () => {
  const sidebar = source("../components/chat-sidebar.tsx");
  const layout = source("./chat-layout.tsx");
  assert.match(sidebar, /title="Bots"[\s\S]*selected=\{pathname\.startsWith\("\/bots"\)\}/u);
  assert.match(sidebar, /icon=\{<BotSidebarIcon \/>\}/u);
  assert.match(sidebar, /navigate\(\{ to: "\/bots" \}\)/u);
  assert.match(layout, /pathname\.startsWith\("\/bots"\) && !params\.chatId/u);
});

test("Remote Bot and chat notifications invalidate every dependent Bot cache", () => {
  const root = source("./root-view.tsx");
  assert.match(
    root,
    /onNotification\("chats:changed"[\s\S]*queryKey: queryKeys\.chats[\s\S]*queryKey: \["bot-chats"\]/u,
  );
  assert.match(
    root,
    /onNotification\("bots:changed"[\s\S]*queryKey: queryKeys\.bots[\s\S]*\["bot"\][\s\S]*\["bot-chats"\][\s\S]*\["bot-telegram-binding"\][\s\S]*queryKeys\.botTelegramTargets/u,
  );
});
