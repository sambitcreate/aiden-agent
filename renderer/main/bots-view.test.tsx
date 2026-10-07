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
  assert.match(router, /path: "\/bots"[\s\S]*component: BotsRoute/u);
  assert.match(router, /path: "\/bots\/\$botId"[\s\S]*component: BotsRoute/u);
  assert.match(router, /capabilities\.bots \? children : <Navigate to="\/" replace \/>/u);
  assert.match(
    router,
    /path: "\/bots\/\$botId\/chat\/\$chatId"[\s\S]*<BotChatRouteView botId=\{botId\} chatId=\{chatId\}/u,
  );
  assert.match(guard, /<ChatPane chatId=\{chatId\}/u);
  assert.match(guard, /actualBotId === botId/u);
  assert.match(guard, /Opening the correct conversation/u);
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
  assert.deepEqual(rebaseBotEditorAccessDraft(userAccess, baselineAccess, authoritativeAccess), {
    ...authoritativeAccess,
    modelId: "model:user",
  });

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

function canonicalPhoto(id: number, bytes = 12) {
  return {
    assetRevision: `avatar_revision_${id.toString(16).padStart(32, "0")}`,
    dataUrl: `data:image/png;base64,${Buffer.alloc(bytes, id % 255).toString("base64")}` as const,
  };
}

test("a maximum Bot roster has bounded parallel reads and retained canonical-photo bytes", async () => {
  let running = 0;
  let maxRunning = 0;
  const cache = new BotCanonicalPhotoCache(
    async (botId) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running -= 1;
      return canonicalPhoto(Number(botId.slice(4)), 12);
    },
    { maxConcurrent: 4, maxBytes: 48, maxEntries: 4 },
  );
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
  const active = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const cache = new BotCanonicalPhotoCache(
    async (botId) => {
      calls.push(botId);
      await active;
      return canonicalPhoto(calls.length);
    },
    { maxConcurrent: 4, maxBytes: 1_024, maxEntries: 8 },
  );

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
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const cache = new BotCanonicalPhotoCache(
    async (botId) => {
      calls.push(botId);
      if (botId === "roster-first") await first;
      return canonicalPhoto(calls.length);
    },
    { maxConcurrent: 1, maxBytes: 1_024, maxEntries: 8 },
  );
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
  const cache = new BotCanonicalPhotoCache(
    async (botId) => {
      calls.push(botId);
      return canonicalPhoto(calls.length);
    },
    { maxConcurrent: 1, maxBytes: 1_024, maxEntries: 1 },
  );

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
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new BotCanonicalPhotoCache(
    async () => {
      calls += 1;
      await loading;
      return canonicalPhoto(calls);
    },
    { maxConcurrent: 2, maxBytes: 1_024, maxEntries: 2 },
  );

  cache.request("shared", "visible");
  cache.request("shared", "selected");
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(), { active: 1, queued: 0, entries: 0, bytes: 0 });
  release!();
  await cache.settle();
  assert.equal(calls, 1);
});

test("Bots is a stable sidebar destination and bot rosters do not open the terminal", () => {
  const layout = source("./chat-layout.tsx");
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


