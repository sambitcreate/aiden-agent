import { createHash, randomBytes } from "node:crypto";
import type { FormFillElement } from "./planner-core.js";

/**
 * Immutable batch authorization for the Form Fill Specialist.
 *
 * A plan is built once — at approval time — from the exact chat, generation,
 * renderer document, attachment hash, bound window, and ordered actions. Its
 * SHA-256 digest is what the approval binds. `FormFillBatchLedger` mints a
 * one-use authority token only when main re-validates the plan digest, owner,
 * target, and expiry; execution consumes it exactly once.
 */

export const FORM_FILL_BATCH_VERSION = 1;
export const FORM_FILL_BATCH_TTL_MS = 120_000;

export interface FormFillBatchWindow {
  pid: number;
  windowId: number;
  appName: string;
  title: string;
}

export interface FormFillBatchAction {
  /** Position in the ordered plan. */
  order: number;
  /** Element index in the plan-time snapshot — never reused as a live target. */
  elementIndex: number;
  /** Element token from the plan-time snapshot when the driver exposes one. */
  elementToken?: string;
  role: string;
  label: string;
  action: "fill";
  /** Entity index into the plan's source set. */
  entityIndex: number;
  /** Exact source value — copied verbatim, never derived. */
  value: string;
  source: { attachmentId: string; label: string; line: number };
}

export interface FormFillBatchPlan {
  version: typeof FORM_FILL_BATCH_VERSION;
  planId: string;
  chatId: string;
  /** Generation (stream) id — execution is bound to the same generation. */
  generationId: string;
  /** Active renderer document id the approval was shown in. */
  documentId: string;
  attachmentId: string;
  /** sha256 of the exact source document text at plan time. */
  attachmentHash: string;
  attachmentName: string;
  window: FormFillBatchWindow;
  /** Controller revision at plan time — external mutations invalidate. */
  controllerEpoch: number;
  /** Snapshot structure, excluding mutable values and capture-scoped tokens. */
  structureHash?: string;
  actions: FormFillBatchAction[];
  /** Orders the user deselected on the review card; set only at approval. */
  excludedOrders?: number[];
  maxActions: number;
  submit: false;
  expiresAt: number;
}

export type FormFillBatchDigest = string; // sha256 hex of the canonical plan

/** Canonical serialization for hashing: sorted keys, no optional elision. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formFillPlanDigest(
  plan: FormFillBatchPlan,
): FormFillBatchDigest {
  return createHash("sha256").update(canonicalize(plan), "utf8").digest("hex");
}

export function newFormFillPlanId(): string {
  return `ffp-${randomBytes(12).toString("hex")}`;
}

export type FormFillBatchStatus =
  | "pending" // plan minted, awaiting user approval
  | "authorized" // approval granted — authority token issued
  | "consumed" // token used; batch may be running or done
  | "revoked"
  | "expired";

interface LedgerEntry {
  plan: FormFillBatchPlan;
  digest: FormFillBatchDigest;
  status: FormFillBatchStatus;
  token?: string;
  consumedAt?: number;
}

export class FormFillBatchError extends Error {
  constructor(
    readonly code:
      | "plan_unknown"
      | "plan_mismatch"
      | "plan_expired"
      | "plan_revoked"
      | "plan_consumed"
      | "not_authorized",
    message: string,
  ) {
    super(message);
    this.name = "FormFillBatchError";
  }
}

/**
 * Main-owned one-use authority ledger. Tokens are opaque; a token authorizes
 * exactly the digest it was minted for, once.
 */
export class FormFillBatchLedger {
  private entries = new Map<string, LedgerEntry>();
  private tokenIndex = new Map<string, string>(); // token → planId
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** Record an approved-or-pending plan; returns its digest. */
  mint(plan: FormFillBatchPlan): FormFillBatchDigest {
    const digest = formFillPlanDigest(plan);
    this.entries.set(plan.planId, { plan, digest, status: "pending" });
    return digest;
  }

  statusOf(planId: string): FormFillBatchStatus | undefined {
    const entry = this.entries.get(planId);
    if (!entry) return undefined;
    if (entry.status === "authorized" || entry.status === "pending") {
      if (entry.plan.expiresAt <= this.now()) {
        entry.status = "expired";
        return entry.status;
      }
    }
    return entry.status;
  }

  digestOf(planId: string): FormFillBatchDigest | undefined {
    return this.entries.get(planId)?.digest;
  }

  /**
   * Convert an approved plan into a one-use authority token. Re-validates the
   * digest, expiry, and that a plan for this generation is still pending.
   * `excludedOrders` applies the user's row deselections: the authority binds
   * the derived plan (subset of reviewed rows) with its own digest.
   */
  authorize(
    planId: string,
    expectedDigest: FormFillBatchDigest,
    excludedOrders: readonly number[] = [],
  ): { token: string; plan: FormFillBatchPlan } {
    const entry = this.entries.get(planId);
    if (!entry)
      throw new FormFillBatchError(
        "plan_unknown",
        "The form-fill plan is unknown.",
      );
    if (entry.digest !== expectedDigest) {
      throw new FormFillBatchError(
        "plan_mismatch",
        "The form-fill plan changed after review. It was not approved.",
      );
    }
    if (entry.status === "expired" || entry.plan.expiresAt <= this.now()) {
      entry.status = "expired";
      throw new FormFillBatchError(
        "plan_expired",
        "The form-fill plan expired.",
      );
    }
    if (entry.status === "revoked") {
      throw new FormFillBatchError(
        "plan_revoked",
        "The form-fill plan was revoked.",
      );
    }
    if (entry.status !== "pending") {
      throw new FormFillBatchError(
        "plan_consumed",
        "The form-fill plan was already used.",
      );
    }
    let plan = entry.plan;
    const excluded = [...new Set(excludedOrders)].sort((a, b) => a - b);
    if (excluded.length > 0) {
      const valid = new Set(plan.actions.map((action) => action.order));
      if (excluded.some((order) => !valid.has(order))) {
        throw new FormFillBatchError(
          "plan_mismatch",
          "A deselected row is not part of the reviewed plan.",
        );
      }
      plan = { ...plan, excludedOrders: excluded };
      entry.plan = plan;
      entry.digest = formFillPlanDigest(plan);
    }
    const token = `ffb-${randomBytes(16).toString("hex")}`;
    entry.status = "authorized";
    entry.token = token;
    this.tokenIndex.set(token, planId);
    return { token, plan };
  }

  /**
   * Consume the authority token exactly once. Validates the plan still matches
   * the minted digest — plan contents must be byte-identical to what was
   * approved.
   */
  consume(token: string, plan: FormFillBatchPlan): FormFillBatchPlan {
    const planId = this.tokenIndex.get(token);
    if (!planId) {
      throw new FormFillBatchError(
        "not_authorized",
        "The form-fill batch was not authorized.",
      );
    }
    const entry = this.entries.get(planId);
    if (!entry || entry.plan.planId !== plan.planId) {
      throw new FormFillBatchError(
        "plan_unknown",
        "The form-fill plan is unknown.",
      );
    }
    if (formFillPlanDigest(plan) !== entry.digest) {
      throw new FormFillBatchError(
        "plan_mismatch",
        "The form-fill plan changed after approval.",
      );
    }
    if (entry.status !== "authorized") {
      const code =
        entry.status === "consumed"
          ? "plan_consumed"
          : entry.status === "revoked"
            ? "plan_revoked"
            : entry.status === "expired"
              ? "plan_expired"
              : "not_authorized";
      throw new FormFillBatchError(
        code,
        `The form-fill plan is ${entry.status}.`,
      );
    }
    entry.status = "consumed";
    entry.consumedAt = this.now();
    return entry.plan;
  }

  /** Revoke a plan by id (stop, gate change, target change, quit). */
  revoke(planId: string): void {
    const entry = this.entries.get(planId);
    if (entry && entry.status !== "consumed") entry.status = "revoked";
  }

  /** Revoke every pending/authorized plan for a generation. */
  revokeGeneration(generationId: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.plan.generationId === generationId &&
        entry.status !== "consumed"
      ) {
        entry.status = "revoked";
      }
    }
  }

  /** Revoke every pending/authorized plan (stop/quit/gate changes). */
  revokeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== "consumed") entry.status = "revoked";
    }
  }
}

/** Descriptive plan structure only; never proof of document continuity. */
export function formFillStructureHash(elements: readonly FormFillElement[]): string {
  return createHash("sha256").update(canonicalize(elements.map((element) => ({
    index: element.index, role: element.role, label: element.label,
    frame: element.frame, depth: element.depth, parentIndex: element.parentIndex,
  })))).digest("hex");
}

export type FormFillRowResultStatus =
  | "filled"
  | "already_satisfied"
  | "untouched"
  | "needs_review"
  | "failed"
  | "not_attempted";

export interface FormFillRowResult {
  order: number;
  elementIndex: number;
  label: string;
  status: FormFillRowResultStatus;
  /** Failure/reason detail safe for display — never contains values. */
  detail?: string;
}

export interface FormFillBatchResult {
  planId: string;
  rows: FormFillRowResult[];
  filled: number;
  alreadySatisfied: number;
  untouched: number;
  needsReview: number;
  failed: number;
  notAttempted: number;
  stoppedEarly: boolean;
  /** Set when execution stopped on a failure/drift/stop — no value content. */
  stopReason?: string;
}
