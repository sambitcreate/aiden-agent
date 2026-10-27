import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TelegramConfig } from "./telegram-config.js";
import { TelegramProfileMutationFence } from "./telegram-profile-mutation-fence.js";

export const TELEGRAM_PAIRING_WINDOW_MS = 5 * 60_000;
const PROFILE_ATTEMPTS = 10;
const TOTAL_ATTEMPTS = 100;

/** Shared across profiles. Creating or reissuing a proof cannot reset the global budget. */
export function createTelegramPairingBudget(now: () => number) {
  let startedAt = now();
  let attempts = 0;
  return () => {
    if (now() - startedAt >= TELEGRAM_PAIRING_WINDOW_MS) {
      startedAt = now();
      attempts = 0;
    }
    return ++attempts <= TOTAL_ATTEMPTS;
  };
}
const globalBudget = createTelegramPairingBudget(Date.now);
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Ephemeral host-issued proof. Owner persistence remains in the existing profile store. */
export function createTelegramPairing(deps: {
  profile: string;
  config: TelegramConfig;
  getToken(): Promise<string | null>;
  now(): number;
  fence?: TelegramProfileMutationFence;
  attemptBudget?: () => boolean;
}) {
  const fence = deps.fence ?? new TelegramProfileMutationFence();
  const attemptBudget = deps.attemptBudget ?? globalBudget;
  let epoch = 0;
  let pending: { verifier: Buffer; token: Buffer; expiresAt: number; attempts: number } | undefined;
  function invalidate(): void {
    epoch += 1;
    pending = undefined;
  }
  function status(): { expiresAt?: number } {
    if (pending && deps.now() >= pending.expiresAt) invalidate();
    return { expiresAt: pending?.expiresAt };
  }
  return {
    status,
    invalidate,
    async begin(): Promise<{ code: string; expiresAt: number }> {
      invalidate();
      const expectedEpoch = epoch;
      return fence.runBinding(deps.profile, async (admission) => {
        const [snapshot, token] = await Promise.all([deps.config.snapshot(), deps.getToken()]);
        admission.assertCurrent();
        if (epoch !== expectedEpoch || !snapshot.enabled || !token || !snapshot.hasToken)
          throw new Error("Connect this Telegram profile before starting pairing.");
        if (snapshot.allowedUserId !== undefined) throw new Error("Reset the existing Telegram owner before pairing another account.");
        const code = randomBytes(32).toString("base64url");
        const expiresAt = deps.now() + TELEGRAM_PAIRING_WINDOW_MS;
        pending = { verifier: digest(code), token: digest(token), expiresAt, attempts: 0 };
        return { code, expiresAt };
      });
    },
    async claim(code: string, ownerUserId: number): Promise<boolean> {
      const challenge = pending;
      if (!challenge || deps.now() >= challenge.expiresAt) { status(); return false; }
      if (!attemptBudget() || ++challenge.attempts > PROFILE_ATTEMPTS) { invalidate(); return false; }
      if (!/^[A-Za-z0-9_-]{43}$/u.test(code) || !timingSafeEqual(digest(code), challenge.verifier)) {
        if (challenge.attempts === PROFILE_ATTEMPTS) invalidate();
        return false;
      }
      if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return false;
      // Consume synchronously before any await. Two claimants cannot both enter persistence.
      pending = undefined;
      const expectedEpoch = epoch;
      return fence.runBinding(deps.profile, async (admission) => {
        const isCurrent = () => {
          admission.assertCurrent();
          return epoch === expectedEpoch && deps.now() < challenge.expiresAt;
        };
        const [snapshot, token] = await Promise.all([deps.config.snapshot(), deps.getToken()]);
        if (!isCurrent() || !snapshot.enabled || !snapshot.hasToken || snapshot.allowedUserId !== undefined || !token || !timingSafeEqual(digest(token), challenge.token)) return false;
        await deps.config.setSettings({ telegramAllowedUserId: ownerUserId }, isCurrent);
        return isCurrent();
      });
    },
  };
}
