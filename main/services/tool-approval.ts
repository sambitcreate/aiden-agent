import { createHash, randomUUID } from "node:crypto";
import type { ApprovalAnalytics } from "./approval-gate/approval-analytics.js";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";
import type { ToolApprovalPreview } from "../../renderer/shared/tool-approval-preview.js";
import {
  parseToolApprovalScope,
  type ToolApprovalScope,
} from "../../renderer/shared/tool-approval-scope.js";

export interface ToolApprovalPrompt {
  streamId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  details?: ToolApprovalDetails;
  /**
   * The exact command or file change, for the owning desktop window only.
   * Remote and run-journal projections copy named fields and leave it out.
   */
  preview?: ToolApprovalPreview;
  /**
   * Scopes the approval surface may offer. Absent means "once" only. A scope
   * broader than once is honored only when it was offered here.
   */
  scopes?: readonly ToolApprovalScope[];
}

interface PendingApproval {
  approvalId: string;
  streamId: string;
  toolCallId: string;
  ownerDocumentId?: string;
  scopes: readonly ToolApprovalScope[];
  /** Identical calls waiting on this card, by tool call id. */
  followers: string[];
  settle(outcome: ToolApprovalOutcome): void;
}

/** A card that identical parallel calls in the same run share. */
interface SharedApproval {
  entry: PendingApproval;
  result: Promise<ToolApprovalOutcome>;
}

/**
 * What a call would do, for a caller that can name it exactly: the tool and
 * its canonical arguments (object keys sorted, undefined fields dropped), plus
 * anything else that picks the target, such as a browser tab. Two calls with
 * the same key do the same thing. A value that is not plain JSON has no key.
 */
export function toolCallApprovalEffect(toolName: string, args: unknown, target?: unknown): string | undefined {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("not JSON");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
    if (typeof value !== "object") throw new Error("not JSON");
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`);
    return `{${entries.join(",")}}`;
  };
  try {
    return createHash("sha256")
      .update(canonical({ toolName, args: args ?? null, target: target ?? null }))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The card two calls may share, and a denied one is remembered by, in a run.
 * Only a caller-supplied effect (`toolCallApprovalEffect`) counts: a card's
 * text often leaves the arguments out, so equal text is not the same action.
 * The owning document and everything the card shows are part of it too.
 */
function approvalEffectKey(
  descriptor: Omit<ToolApprovalPrompt, "approvalId">,
  effect: string | undefined,
  ownerDocumentId: string | undefined,
): string | undefined {
  if (effect === undefined) return undefined;
  try {
    return JSON.stringify([
      ownerDocumentId ?? null,
      effect,
      descriptor.toolName,
      descriptor.summary,
      descriptor.details ?? null,
      descriptor.preview ?? null,
      descriptor.scopes ?? null,
    ]);
  } catch {
    // An unserializable card is never shared or remembered.
    return undefined;
  }
}

/** Optional structured payload an approval card may return with a decision. */
export interface ToolApprovalDecisionPayload {
  /** Form Fill Specialist: orders the user deselected on the review card. */
  formFillExcludedOrders?: number[];
  /** How far an allow decision reaches. Defaults to, and falls back to, "once". */
  scope?: ToolApprovalScope;
}

export type ToolApprovalOutcome = "allowed" | "denied" | "cancelled" | "detached" | "unavailable";

/**
 * One prompt's lifetime. `publishing` is separate from `published` because a
 * publish callback can settle its own prompt before it returns, or even before
 * it throws. That prompt may have been shown, so it is withdrawn once the
 * callback ends, unless a same-id replacement now owns the id: the replacement
 * supersedes it, and withdrawal by id would remove the replacement.
 */
type ApprovalPromptPhase = "admitted" | "publishing" | "published" | "settled";

/**
 * The block reason returned to the model for a tool call that was not
 * allowed. A declined attended automation proposal tells the model to stop
 * retrying and hand the conversation back to the user.
 */
export function toolApprovalBlockReason(
  outcome: Exclude<ToolApprovalOutcome, "allowed">,
  attendedScheduleApproval: boolean,
): string {
  if (attendedScheduleApproval && outcome === "denied") {
    return 'The user declined this automation. Do not retry it. Reply briefly, "Okay—what else should we do?" and wait for their direction.';
  }
  switch (outcome) {
    case "denied":
      return "The user denied this action.";
    case "detached":
      return "Approval is unavailable while this response continues in the background. Return to the chat and retry the action.";
    case "unavailable":
      return "Aiden could not present the approval request. Return to the chat and retry the action.";
    case "cancelled":
    default:
      return "The action was cancelled before approval.";
  }
}

/**
 * Owns approval promises and their abort listeners. A decision is one-shot;
 * every settlement path removes both the map entry and signal listener.
 */
export class ToolApprovalCoordinator {
  /** Prompts inside their publish callback, by id, so a shown re-ask can claim the id. */
  private readonly publications = new Map<string, { replaced: boolean }>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly closedStreams = new Map<string, "cancelled" | "detached">();
  /** Payloads from settled approvals, consumed once by the tool caller. */
  private readonly decisionPayloads = new Map<string, ToolApprovalDecisionPayload>();
  /** Pending cards by stream and effect, for identical parallel calls to share. */
  private readonly shared = new Map<string, Map<string, SharedApproval>>();
  /** Effects the person denied, by stream: the run never asks them again. */
  private readonly denied = new Map<string, Set<string>>();
  private stopped = false;

  private payloadKey(streamId: string, toolCallId: string): string {
    return `${streamId}\u0000${toolCallId}`;
  }

  constructor(
    private readonly publish: (prompt: ToolApprovalPrompt) => void,
    /** Called once when a published prompt settles, with how it settled. */
    private readonly withdraw?: (approvalId: string, outcome: ToolApprovalOutcome) => void,
    /**
     * Called when a prompt is refused unpublished because its stream was
     * detached first: nobody saw it, and the model is told it is unavailable.
     */
    private readonly onShortCircuited?: (prompt: ToolApprovalPrompt) => void,
    /** Counts the cards shown and the person's answers (enums only). */
    private readonly analytics?: ApprovalAnalytics,
  ) {}

  private shortCircuited(prompt: ToolApprovalPrompt): void {
    try {
      this.onShortCircuited?.(prompt);
    } catch {
      // Advisory bookkeeping; the request still settles.
    }
  }

  /**
   * `approvalId` may be supplied by a caller whose approvals outlive this
   * process (Bots persist it as their `waitId`). A still-pending prompt with
   * the same id is withdrawn first, so the id always names the newest ask.
   *
   * Without one, the card belongs to this run. When the caller also names the
   * call's `effect` (`toolCallApprovalEffect`), a card for the same action
   * already pending in the stream is shared (one card answers every waiting
   * call), and an action the person denied in the stream is not asked again.
   * A call without an effect always gets its own card.
   */
  request(
    request: Omit<ToolApprovalPrompt, "approvalId"> & { approvalId?: string; effect?: string },
    signal?: AbortSignal,
    ownerDocumentId?: string,
  ): Promise<ToolApprovalOutcome> {
    const { effect: callEffect, ...descriptor } = request;
    if (this.stopped || signal?.aborted) {
      return Promise.resolve("cancelled");
    }
    const approvalId = descriptor.approvalId ?? `a-${randomUUID()}`;
    const closedOutcome = this.closedStreams.get(descriptor.streamId);
    if (closedOutcome) {
      if (closedOutcome === "detached") this.shortCircuited({ ...descriptor, approvalId });
      return Promise.resolve(closedOutcome);
    }
    const effect = descriptor.approvalId === undefined ? approvalEffectKey(descriptor, callEffect, ownerDocumentId) : undefined;
    if (effect !== undefined) {
      if (this.denied.get(descriptor.streamId)?.has(effect)) return Promise.resolve("denied");
      const leader = this.shared.get(descriptor.streamId)?.get(effect);
      if (leader) return this.follow(leader, request, signal, ownerDocumentId);
    }
    this.pending.get(approvalId)?.settle("cancelled");
    const result = this.ask(descriptor, approvalId, signal, ownerDocumentId, effect);
    return result;
  }

  /** Wait on an identical card already pending in this run. */
  private async follow(
    leader: SharedApproval,
    descriptor: Omit<ToolApprovalPrompt, "approvalId"> & { effect?: string },
    signal: AbortSignal | undefined,
    ownerDocumentId: string | undefined,
  ): Promise<ToolApprovalOutcome> {
    leader.entry.followers.push(descriptor.toolCallId);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([leader.result, aborted]);
      if (outcome === "aborted") {
        leader.entry.followers = leader.entry.followers.filter((id) => id !== descriptor.toolCallId);
        this.decisionPayloads.delete(this.payloadKey(descriptor.streamId, descriptor.toolCallId));
        return "cancelled";
      }
      // The shared card went away for its own call only: this call still waits.
      if (outcome === "cancelled" && !signal?.aborted && !this.stopped && !this.closedStreams.has(descriptor.streamId)) {
        return this.request(descriptor, signal, ownerDocumentId);
      }
      return outcome;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private ask(
    descriptor: Omit<ToolApprovalPrompt, "approvalId"> & { approvalId?: string },
    approvalId: string,
    signal: AbortSignal | undefined,
    ownerDocumentId: string | undefined,
    effect: string | undefined,
  ): Promise<ToolApprovalOutcome> {
    let entry!: PendingApproval;
    const result = new Promise<ToolApprovalOutcome>((resolve) => {
      let phase: ApprovalPromptPhase = "admitted";
      let settledWhilePublishing: ToolApprovalOutcome | undefined;
      const aborted = () => finish("cancelled");
      const withdrawPrompt = (outcome: ToolApprovalOutcome) => {
        try {
          this.withdraw?.(approvalId, outcome);
        } catch {
          // Owner loss can make the withdrawal channel unavailable. The
          // approval capability is still removed and must always settle.
        }
      };
      const finish = (outcome: ToolApprovalOutcome) => {
        if (phase === "settled") return;
        const priorPhase = phase;
        phase = "settled";
        this.pending.delete(approvalId);
        this.analytics?.forget(approvalId);
        if (effect !== undefined) {
          const streamShared = this.shared.get(descriptor.streamId);
          if (streamShared?.get(effect)?.entry === entry) {
            streamShared.delete(effect);
            if (streamShared.size === 0) this.shared.delete(descriptor.streamId);
          }
          if (outcome === "denied" && !this.closedStreams.has(descriptor.streamId) && !this.stopped) {
            const streamDenied = this.denied.get(descriptor.streamId) ?? new Set<string>();
            streamDenied.add(effect);
            this.denied.set(descriptor.streamId, streamDenied);
          }
        }
        signal?.removeEventListener("abort", aborted);
        if (priorPhase === "published") withdrawPrompt(outcome);
        if (priorPhase === "publishing") settledWhilePublishing = outcome;
        resolve(outcome);
      };
      entry = {
        approvalId,
        streamId: descriptor.streamId,
        toolCallId: descriptor.toolCallId,
        ownerDocumentId,
        scopes: descriptor.scopes ?? ["once"],
        followers: [],
        settle: finish,
      };
      this.pending.set(approvalId, entry);
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.stopped || signal?.aborted) {
        finish("cancelled");
        return;
      }
      const closedOutcome = this.closedStreams.get(descriptor.streamId);
      if (closedOutcome) {
        if (closedOutcome === "detached") this.shortCircuited({ ...descriptor, approvalId });
        finish(closedOutcome);
        return;
      }
      phase = "publishing";
      const enclosing = this.publications.get(approvalId);
      const publication = { replaced: false };
      this.publications.set(approvalId, publication);
      try {
        this.publish({ ...descriptor, approvalId });
      } catch {
        if (settledWhilePublishing === undefined) {
          // Nothing settled it, so treat it as never shown: no withdrawal.
          phase = "admitted";
          finish("unavailable");
          return;
        }
      } finally {
        if (enclosing) this.publications.set(approvalId, enclosing);
        else this.publications.delete(approvalId);
      }
      // Reaching here means this prompt was shown, so it owns the id from now on.
      // A replacement that was never shown leaves the enclosing prompt to withdraw.
      if (enclosing) enclosing.replaced = true;
      if (settledWhilePublishing === undefined) {
        phase = "published";
        this.analytics?.shown({ ...descriptor, approvalId });
      }
      // Withdrawal goes by id, so a same-id replacement asked during publication
      // owns the id from then on, even if it has already settled and withdrawn.
      else if (!publication.replaced) withdrawPrompt(settledWhilePublishing);
    });
    if (effect !== undefined && this.pending.get(approvalId) === entry) {
      const streamShared = this.shared.get(descriptor.streamId) ?? new Map<string, SharedApproval>();
      streamShared.set(effect, { entry, result });
      this.shared.set(descriptor.streamId, streamShared);
    }
    return result;
  }

  decide(
    approvalId: string,
    allowed: boolean,
    ownerDocumentId?: string,
    payload?: ToolApprovalDecisionPayload,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.ownerDocumentId !== ownerDocumentId) return false;
    return this.settleDecision(entry, allowed, payload, true);
  }

  /**
   * Host-authority decision for a paired controller holding `runs:control`.
   * Skips the owner-document check but keeps the one-shot settlement, so the
   * first responder across the host UI, phones and controllers wins.
   */
  decideAsHost(
    approvalId: string,
    allowed: boolean,
    payload?: ToolApprovalDecisionPayload,
    /** False when the host answered on its own (an expiry, an allow list). */
    byPerson = true,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    return this.settleDecision(entry, allowed, payload, byPerson);
  }

  private settleDecision(
    entry: PendingApproval,
    allowed: boolean,
    payload: ToolApprovalDecisionPayload | undefined,
    byPerson: boolean,
  ): boolean {
    let answeredScope: ToolApprovalScope | undefined;
    if (payload) {
      const { scope: requestedScope, ...rest } = payload;
      const scope = parseToolApprovalScope(requestedScope);
      // Never widen past what the card offered; an unoffered scope is "once".
      const effective: ToolApprovalDecisionPayload =
        allowed && scope && scope !== "once" && entry.scopes.includes(scope)
          ? { ...rest, scope }
          : rest;
      answeredScope = effective.scope;
      if (Object.keys(effective).length > 0) {
        // Calls sharing this card get the same answer, scope included.
        for (const toolCallId of [entry.toolCallId, ...entry.followers]) {
          this.decisionPayloads.set(this.payloadKey(entry.streamId, toolCallId), effective);
        }
      }
    }
    if (byPerson) this.analytics?.answered(entry.approvalId, allowed, answeredScope);
    entry.settle(allowed ? "allowed" : "denied");
    return true;
  }

  /** Consume the decision payload recorded for a settled tool call, if any. */
  takeDecisionPayload(
    streamId: string,
    toolCallId: string,
  ): ToolApprovalDecisionPayload | undefined {
    const key = this.payloadKey(streamId, toolCallId);
    const payload = this.decisionPayloads.get(key);
    this.decisionPayloads.delete(key);
    return payload;
  }

  cancelStream(streamId: string, outcome: "cancelled" | "detached" = "cancelled"): void {
    // Close admission before settling: delayed child preparation and reentrant
    // withdrawal callbacks must not publish a fresh prompt for this generation.
    const closedOutcome = this.closedStreams.get(streamId) === "cancelled" ? "cancelled" : outcome;
    this.closedStreams.set(streamId, closedOutcome);
    for (const entry of [...this.pending.values()]) {
      if (entry.streamId === streamId) entry.settle(closedOutcome);
    }
    for (const key of [...this.decisionPayloads.keys()]) {
      if (key.startsWith(`${streamId}\u0000`)) this.decisionPayloads.delete(key);
    }
  }

  /** A detached renderer cannot attend pending or future approval prompts. */
  detachStream(streamId: string): void {
    this.cancelStream(streamId, "detached");
  }

  /** Release bounded per-stream state after the owning generation settles. */
  releaseStream(streamId: string): void {
    this.cancelStream(streamId);
    this.closedStreams.delete(streamId);
    this.denied.delete(streamId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const entry of [...this.pending.values()]) entry.settle("cancelled");
    this.closedStreams.clear();
    this.denied.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
