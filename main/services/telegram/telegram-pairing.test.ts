import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramPairing, createTelegramPairingBudget, TELEGRAM_PAIRING_WINDOW_MS } from "./telegram-pairing.js";
import { TelegramProfileMutationFence } from "./telegram-profile-mutation-fence.js";
import type { TelegramConfig } from "./telegram-config.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(profile = "default", fence = new TelegramProfileMutationFence()) {
  let now = 100;
  let token: string | null = "synthetic-bot-token";
  let enabled = true;
  let owner: number | undefined;
  const writes: number[] = [];
  let beforeWrite: (() => Promise<void>) | undefined;
  let failWrite = false;
  const config = {
    snapshot: async () => ({ enabled, hasToken: token !== null, allowedUserId: owner }),
    setSettings: async (patch, isCurrent) => {
      await beforeWrite?.();
      if (failWrite) throw new Error("Synthetic storage failure");
      if (!isCurrent?.()) throw new Error("Stale write refused");
      owner = patch.telegramAllowedUserId;
      writes.push(owner!);
      return { telegramAllowedUserId: owner };
    },
  } as TelegramConfig;
  const pairing = createTelegramPairing({ profile, fence, config, getToken: async () => token, now: () => now, attemptBudget: createTelegramPairingBudget(() => now) });
  return { pairing, writes, fence, owner: () => owner, clock: (value: number) => { now = value; }, token: (value: string | null) => { token = value; }, enabled: (value: boolean) => { enabled = value; }, ownerIs: (value: number) => { owner = value; }, beforeWrite: (value: () => Promise<void>) => { beforeWrite = value; }, failWrite: () => { failWrite = true; } };
}

test("an explicit proof is required; one valid claim persists one owner and never exposes the verifier in status", async () => {
  const h = harness();
  assert.equal(await h.pairing.claim("anything", 1), false);
  const challenge = await h.pairing.begin();
  assert.equal(challenge.expiresAt, 100 + TELEGRAM_PAIRING_WINDOW_MS);
  assert.deepEqual(h.pairing.status(), { expiresAt: challenge.expiresAt });
  assert.equal(await h.pairing.claim("wrong", 1), false);
  assert.deepEqual(await Promise.all([h.pairing.claim(challenge.code, 42), h.pairing.claim(challenge.code, 99)]), [true, false]);
  assert.equal(h.owner(), 42);
  assert.deepEqual(h.writes, [42]);
  assert.equal(await h.pairing.claim(challenge.code, 99), false);
  assert.deepEqual(h.pairing.status(), { expiresAt: undefined });
  await assert.rejects(h.pairing.begin(), /existing Telegram owner/u);
});

test("expiry, cross-profile proof, reissue, token identity change and disabled configuration cannot claim", async () => {
  const a = harness("work"), b = harness("personal");
  let challenge = await a.pairing.begin();
  await b.pairing.begin();
  assert.equal(await b.pairing.claim(challenge.code, 42), false);
  const replacement = await a.pairing.begin();
  assert.equal(await a.pairing.claim(challenge.code, 42), false);
  a.clock(replacement.expiresAt);
  assert.equal(await a.pairing.claim(replacement.code, 42), false);
  challenge = await a.pairing.begin();
  a.token("changed-token");
  assert.equal(await a.pairing.claim(challenge.code, 42), false);
  challenge = await a.pairing.begin();
  a.enabled(false);
  assert.equal(await a.pairing.claim(challenge.code, 42), false);
  assert.deepEqual(a.writes, []);
  assert.deepEqual(b.writes, []);
});

test("ten wrong attempts exhaust a profile proof; a shared total budget survives reissue and recovers after its window", async () => {
  const h = harness();
  const challenge = await h.pairing.begin();
  for (let i = 0; i < 10; i++) assert.equal(await h.pairing.claim("wrong", 42), false);
  assert.equal(await h.pairing.claim(challenge.code, 42), false);
  let now = 0;
  const budget = createTelegramPairingBudget(() => now);
  for (let i = 0; i < 100; i++) assert.equal(budget(), true);
  assert.equal(budget(), false);
  now = TELEGRAM_PAIRING_WINDOW_MS;
  assert.equal(budget(), true);
});

test("cancel or destructive reset during persistence cannot publish stale ownership", async (t) => {
  for (const mutation of ["cancel", "reset", "reissue"]) await t.test(mutation, async () => {
    const h = harness();
    const entered = deferred(), resume = deferred();
    h.beforeWrite(async () => { entered.resolve(); await resume.promise; });
    const challenge = await h.pairing.begin();
    const claim = h.pairing.claim(challenge.code, 42);
    await entered.promise;
    let settled: Promise<unknown> = Promise.resolve();
    if (mutation === "cancel") h.pairing.invalidate();
    if (mutation === "reset") settled = h.fence.runDestructive("default", async () => {});
    if (mutation === "reissue") settled = h.pairing.begin();
    resume.resolve();
    await assert.rejects(claim, /Stale write|profile changed/u);
    await settled;
    assert.equal(h.owner(), undefined);
    assert.deepEqual(h.writes, []);
  });
});

test("failed persistence consumes the proof and existing saved owners cannot be replaced", async () => {
  const h = harness();
  const challenge = await h.pairing.begin();
  h.failWrite();
  await assert.rejects(h.pairing.claim(challenge.code, 42), /storage/u);
  assert.equal(await h.pairing.claim(challenge.code, 42), false);
  assert.equal(h.owner(), undefined);
  const configured = harness();
  configured.ownerIs(123);
  await assert.rejects(configured.pairing.begin(), /existing/u);
  assert.equal(await configured.pairing.claim(challenge.code, 42), false);
  assert.equal(configured.owner(), 123);
});

test("pairing cannot begin while disabled, without a token or with a preconfigured owner", async () => {
  const disabled = harness(); disabled.enabled(false);
  await assert.rejects(disabled.pairing.begin(), /Connect/u);
  const unconfigured = harness(); unconfigured.token(null);
  await assert.rejects(unconfigured.pairing.begin(), /Connect/u);
  assert.equal(await unconfigured.pairing.claim("wrong", 42), false);
});
