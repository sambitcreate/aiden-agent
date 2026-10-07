// Paid-run consents live only in main memory. They are single-use, bound to the
// renderer document that asked, and expire after five minutes. Nothing here
// sends a provider request; an unused or expired consent simply disappears.
import { randomBytes } from "node:crypto";
import type { ImageRunConsentPlan } from "../../../renderer/shared/images/run-types.js";

export const CONSENT_TTL_MS = 5 * 60 * 1_000;

export type ConsentDraft = Omit<ImageRunConsentPlan, "consentId" | "createdAt" | "expiresAt">;

interface Entry<T> {
  ownerKey: string;
  plan: ImageRunConsentPlan;
  internal: T;
}

export class RunConsentStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly ttlMs: number;
  private readonly maxPending: number;

  constructor(options: { now?: () => number; newId?: () => string; ttlMs?: number; maxPending?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(24).toString("base64url"));
    this.ttlMs = options.ttlMs ?? CONSENT_TTL_MS;
    this.maxPending = options.maxPending ?? 64;
  }

  issue(ownerKey: string, draft: ConsentDraft, internal: T): ImageRunConsentPlan {
    this.sweep();
    const createdAt = this.now();
    const plan: ImageRunConsentPlan = { ...draft, consentId: this.newId(), createdAt, expiresAt: createdAt + this.ttlMs };
    this.entries.set(plan.consentId, { ownerKey, plan, internal });
    while (this.entries.size > this.maxPending) this.entries.delete(this.entries.keys().next().value as string);
    return plan;
  }

  consume(consentId: string, ownerKey: string): { ok: true; plan: ImageRunConsentPlan; internal: T } | { ok: false } {
    const entry = this.entries.get(consentId);
    if (!entry || entry.ownerKey !== ownerKey) return { ok: false };
    this.entries.delete(consentId);
    if (this.now() >= entry.plan.expiresAt) return { ok: false };
    return { ok: true, plan: entry.plan, internal: entry.internal };
  }

  pending(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [consentId, entry] of this.entries) {
      if (now >= entry.plan.expiresAt) this.entries.delete(consentId);
    }
  }
}
