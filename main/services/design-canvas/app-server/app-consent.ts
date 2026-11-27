/**
 * The run-app consent cards (plan 2b D5). It follows `DesignModeConsent`'s
 * rules: a card goes only to a live desktop window, waits at most 2 minutes,
 * at most 16 wait at once, and only the window that shows a card may answer
 * it. One card per app key: a second request while one waits joins it.
 */
import { randomUUID } from "node:crypto";
import {
  DESIGN_APP_CHANNELS,
  type DesignAppConsentClosed,
  type DesignAppConsentRequest,
} from "../../../../renderer/shared/design-app.js";
import type { ChatGenerationOwner } from "../../chat-generation-owner.js";

export const DESIGN_APP_CONSENT_TIMEOUT_MS = 2 * 60_000;
const MAX_PENDING = 16;
/** App keys whose "Not now" is remembered; the oldest is forgotten past this. */
const DECLINED_KEPT = 500;

export type DesignAppConsentOwner = Pick<ChatGenerationOwner, "kind" | "id" | "documentId" | "isDestroyed" | "send" | "onInvalidated">;
export type DesignAppConsentResult = "allow" | "decline" | "unanswered" | "unavailable";
export type LaunchConsentCard = Omit<Extract<DesignAppConsentRequest, { kind: "launch" }>, "requestId">;

type Pending = {
  key: string;
  owner: DesignAppConsentOwner;
  result: Promise<DesignAppConsentResult>;
  finish(result: DesignAppConsentResult): void;
};

export function isDesktopOwner(owner: DesignAppConsentOwner | undefined): owner is DesignAppConsentOwner {
  return !!owner && owner.kind !== "remote" && owner.id !== 0 && !owner.isDestroyed();
}

export class DesignAppConsent {
  private pending = new Map<string, Pending>();
  /**
   * Keys where the person chose Not now: Aiden's later requests answer
   * declined without a card until the person starts the app themselves. In
   * memory only.
   */
  private declined = new Set<string>();

  constructor(private readonly timeoutMs = DESIGN_APP_CONSENT_TIMEOUT_MS) {}

  request(input: {
    key: string;
    by: "person" | "aiden";
    request: LaunchConsentCard;
    owner?: DesignAppConsentOwner;
    signal?: AbortSignal;
  }): Promise<DesignAppConsentResult> {
    const { owner, signal } = input;
    for (const entry of this.pending.values()) if (entry.key === input.key) return entry.result;
    if (!isDesktopOwner(owner) || signal?.aborted) return Promise.resolve("unavailable");
    if (input.by === "aiden" && this.declined.has(input.key)) return Promise.resolve("decline");
    if (this.pending.size >= MAX_PENDING) return Promise.resolve("unavailable");
    const requestId = randomUUID();
    let finish!: (result: DesignAppConsentResult) => void;
    const result = new Promise<DesignAppConsentResult>((resolve) => {
      let unsubscribe = () => {};
      finish = (value) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (!owner.isDestroyed()) {
          try {
            owner.send(DESIGN_APP_CHANNELS.consentClosed, { requestId } satisfies DesignAppConsentClosed);
          } catch {
            // The window went away; nothing shows the card.
          }
        }
        resolve(value);
      };
      const abort = () => finish("unavailable");
      const timeout = setTimeout(() => finish("unanswered"), this.timeoutMs);
      // A waiting card never keeps the process alive on its own.
      (timeout as { unref?: () => void }).unref?.();
      this.pending.set(requestId, { key: input.key, owner, result: undefined as never, finish: (value) => finish(value) });
      unsubscribe = owner.onInvalidated(abort);
      signal?.addEventListener("abort", abort, { once: true });
    });
    const entry = this.pending.get(requestId);
    if (!entry) return result;
    entry.result = result;
    try {
      owner.send(DESIGN_APP_CHANNELS.consent, { ...input.request, requestId } satisfies DesignAppConsentRequest);
    } catch {
      finish("unavailable");
    }
    return result;
  }

  /** The person's answer from the card; false when the card isn't this window's or no longer waiting. */
  answer(requestId: unknown, answer: unknown, owner: Pick<DesignAppConsentOwner, "id" | "documentId" | "isDestroyed">): boolean {
    if (typeof requestId !== "string" || (answer !== "allow" && answer !== "decline")) return false;
    const request = this.pending.get(requestId);
    if (
      !request ||
      request.owner.id !== owner.id ||
      request.owner.documentId !== owner.documentId ||
      request.owner.isDestroyed() ||
      owner.isDestroyed()
    ) {
      return false;
    }
    this.declined.delete(request.key);
    if (answer === "decline") {
      this.declined.add(request.key);
      if (this.declined.size > DECLINED_KEPT) this.declined.delete(this.declined.values().next().value!);
    }
    request.finish(answer);
    return true;
  }

  /** The person started or toggled the app themselves, so Aiden may ask again. */
  forgetDecline(key: string): void {
    this.declined.delete(key);
  }

  isDeclined(key: string): boolean {
    return this.declined.has(key);
  }

  /** Closes every card for keys that start with `prefix` (a workspace being forgotten). */
  closeAll(prefix: string): void {
    for (const entry of [...this.pending.values()]) if (entry.key.startsWith(prefix)) entry.finish("unavailable");
    for (const key of [...this.declined]) if (key.startsWith(prefix)) this.declined.delete(key);
  }
}
