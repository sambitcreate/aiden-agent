import type { Attachment } from "../types.js";
import type { FormFillBatchApprovalDetails } from "../../../renderer/shared/assistant.js";
import {
  extractFormFillEntities,
  FormFillExtractionError,
  type FormFillExtraction,
} from "./extract-core.js";
import {
  filterActionable,
  planFormFill,
  renderContext,
  renderOptions,
  type FormFillElement,
  type FormFillElementScore,
} from "./planner-core.js";
import {
  FormFillBatchError,
  FormFillBatchLedger,
  FORM_FILL_BATCH_TTL_MS,
  FORM_FILL_BATCH_VERSION,
  newFormFillPlanId,
  type FormFillBatchAction,
  type FormFillBatchPlan,
  type FormFillBatchResult,
} from "./batch-core.js";

/**
 * Form Fill Specialist orchestration. Builds an immutable, provenanced plan at
 * approval time (extract → capture → score → plan → mint), binds the user's
 * single approval to that plan's digest, and executes it through the
 * controller exactly once.
 *
 * The model-facing tool references only a current attachment id and an exact
 * pid/window_id — it can never supply entities or values.
 */

export const FORM_FILL_TOOL_NAME = "form_fill";

export interface FormFillToolArgs {
  attachment_id: string;
  pid: number;
  window_id: number;
}

export function normalizeFormFillArgs(raw: unknown): FormFillToolArgs {
  const args = (raw ?? {}) as Record<string, unknown>;
  const attachment_id = args.attachment_id;
  const pid = args.pid;
  const window_id = args.window_id;
  if (
    typeof attachment_id !== "string" ||
    attachment_id.length === 0 ||
    attachment_id.length > 256
  ) {
    throw new FormFillServiceError(
      "invalid_args",
      "form_fill requires the current attachment's attachment_id.",
    );
  }
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
    throw new FormFillServiceError("invalid_args", "form_fill requires an exact pid.");
  }
  if (!Number.isSafeInteger(window_id) || (window_id as number) < 1) {
    throw new FormFillServiceError("invalid_args", "form_fill requires an exact window_id.");
  }
  return { attachment_id, pid: pid as number, window_id: window_id as number };
}

export type FormFillServiceErrorCode =
  | "invalid_args"
  | "attachment_not_found"
  | "attachment_unsupported"
  | "no_fillable_fields"
  | "not_authorized";

export class FormFillServiceError extends Error {
  constructor(
    readonly code: FormFillServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FormFillServiceError";
  }
}

export interface FormFillControllerLike {
  readonly generationId: string;
  formFillCapture(
    input: { pid: number; windowId: number },
    signal?: AbortSignal,
  ): Promise<{
    window: { pid: number; windowId: number; appName: string; title: string };
    elements: readonly FormFillElement[];
    revision: number;
  }>;
  executeFormFillBatch(
    plan: FormFillBatchPlan,
    options?: {
      signal?: AbortSignal;
      onRow?: (row: { order: number }, completed: number, total: number) => void;
    },
  ): Promise<FormFillBatchResult>;
}

export interface FormFillScorerLike {
  score(
    context: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<{
    selectedIndex: number;
    probabilities: number[];
    contextWasTruncated: boolean;
    truncatedOptionIndices: number[];
  }>;
}

export interface FormFillApprovalDescriptor {
  planId: string;
  digest: string;
  summary: string;
  details: FormFillBatchApprovalDetails;
}

export interface FormFillServiceDeps {
  controller: FormFillControllerLike;
  scorer: FormFillScorerLike;
  /** Attachments on the exact triggering user message — the only source pool. */
  attachmentResolver: () => readonly Attachment[];
  owner: { chatId: string; generationId: string; documentId: string };
  ledger?: FormFillBatchLedger;
  now?: () => number;
  onProgress?: (toolCallId: string, completed: number, total: number) => void;
}

interface AuthorizedBatch {
  token: string;
  plan: FormFillBatchPlan;
}

export class FormFillService {
  /** Optional live row progress sink set once the generation timeline exists. */
  progressSink?: (toolCallId: string, completed: number, total: number) => void;

  private readonly ledger: FormFillBatchLedger;
  private readonly now: () => number;
  /** toolCallId → one-use authority (set only after explicit approval). */
  private readonly authorized = new Map<string, AuthorizedBatch>();

  constructor(private readonly deps: FormFillServiceDeps) {
    this.ledger = deps.ledger ?? new FormFillBatchLedger();
    this.now = deps.now ?? Date.now;
  }

  /**
   * Build the plan and the review card in one step: extract → capture → score
   * → plan → mint. The card IS the approval surface, so the model call happens
   * here, before the user is asked.
   */
  async approvalFor(rawArgs: unknown, signal?: AbortSignal): Promise<FormFillApprovalDescriptor> {
    const args = normalizeFormFillArgs(rawArgs);
    const attachment = this.deps
      .attachmentResolver()
      .find((candidate) => candidate.id === args.attachment_id);
    if (!attachment) {
      throw new FormFillServiceError(
        "attachment_not_found",
        "The form-fill source must be an attachment on the message you sent.",
      );
    }
    const extraction = this.extract(attachment);

    const capture = await this.deps.controller.formFillCapture(
      { pid: args.pid, windowId: args.window_id },
      signal,
    );
    const elements = capture.elements;
    const actionable = filterActionable(elements);

    const options = renderOptions(extraction.entities);
    const scores: FormFillElementScore[] = [];
    for (const element of actionable) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const context = renderContext(capture.window.title, element);
      const score = await this.deps.scorer.score(context, options, signal);
      scores.push({
        elementIndex: element.index,
        selectedIndex: score.selectedIndex,
        probabilities: score.probabilities,
        contextWasTruncated: score.contextWasTruncated,
        truncatedOptionIndices: score.truncatedOptionIndices,
      });
    }

    const planned = planFormFill({
      entities: extraction.entities,
      elements,
      formTitle: capture.window.title,
      scores,
    });

    const actions: FormFillBatchAction[] = planned.fills.map((row, order) => ({
      order,
      elementIndex: row.elementIndex,
      elementToken: row.elementToken,
      role: row.role,
      label: row.label,
      action: "fill",
      entityIndex: row.entityIndex!,
      value: row.value!,
      source: {
        attachmentId: extraction.attachmentId,
        label: row.source?.label ?? row.label,
        line: row.source?.line ?? 0,
      },
    }));

    const plan: FormFillBatchPlan = {
      version: FORM_FILL_BATCH_VERSION,
      planId: newFormFillPlanId(),
      chatId: this.deps.owner.chatId,
      generationId: this.deps.owner.generationId,
      documentId: this.deps.owner.documentId,
      attachmentId: attachment.id,
      attachmentHash: extraction.contentHash,
      attachmentName: attachment.name,
      window: capture.window,
      controllerEpoch: capture.revision,
      actions,
      maxActions: actions.length,
      submit: false,
      expiresAt: this.now() + FORM_FILL_BATCH_TTL_MS,
    };
    const digest = this.ledger.mint(plan);

    const skippedRows = planned.rows
      .filter((row) => row.outcome !== "fill")
      .map((row) => ({
        label: row.label.trim() || `Element ${row.elementIndex}`,
        reason:
          row.reason ?? (row.outcome === "needs_review" ? "Needs review." : "Left unchanged."),
      }));

    const details: FormFillBatchApprovalDetails = {
      kind: "form-fill-batch",
      planId: plan.planId,
      sourceDocument: attachment.name,
      sourceHashPrefix: extraction.contentHash.slice(0, 12),
      targetApp: capture.window.appName.trim() || "Application",
      targetTitle: capture.window.title.trim() || "Untitled window",
      rows: actions.map((action) => ({
        order: action.order,
        elementIndex: action.elementIndex,
        label: action.label.trim(),
        value: action.value,
        sourceLabel: action.source.label.trim(),
        sourceLine: action.source.line,
      })),
      skippedRows,
      fillCount: actions.length,
      reviewCount: skippedRows.length,
      submitExcluded: true,
    };

    const summary =
      actions.length === 0
        ? `Form fill found no fields to write in ${capture.window.appName} — ${skippedRows.length} field(s) need review.`
        : `Fill ${actions.length} field(s) in ${capture.window.appName} from ${attachment.name} — submit is not included.`;
    return { planId: plan.planId, digest, summary, details };
  }

  /**
   * Convert an approved card into one-use authority. Re-validates the digest
   * and applies the user's row deselections (a strict subset of reviewed rows).
   */
  authorize(
    toolCallId: string,
    planId: string,
    expectedDigest: string,
    excludedOrders: readonly number[] = [],
  ): void {
    const { token, plan } = this.ledger.authorize(planId, expectedDigest, excludedOrders);
    this.authorized.set(toolCallId, { token, plan });
  }

  /** Consume the one-use authority and run the batch via the controller. */
  async execute(
    toolCallId: string,
    rawArgs: unknown,
    signal?: AbortSignal,
  ): Promise<FormFillBatchResult & { sourceDocument: string }> {
    const args = normalizeFormFillArgs(rawArgs);
    const authorized = this.authorized.get(toolCallId);
    this.authorized.delete(toolCallId);
    if (!authorized) {
      throw new FormFillBatchError("not_authorized", "The form-fill batch was not approved.");
    }
    const { token, plan } = authorized;
    // Args identity is bound to the approved plan, not trusted from the tool call.
    if (
      plan.attachmentId !== args.attachment_id ||
      plan.window.pid !== args.pid ||
      plan.window.windowId !== args.window_id
    ) {
      throw new FormFillBatchError(
        "plan_mismatch",
        "The form-fill request does not match the approved plan.",
      );
    }
    const authoritativePlan = this.ledger.consume(token, plan);
    try {
      const result = await this.deps.controller.executeFormFillBatch(authoritativePlan, {
        signal,
        onRow: (_row, completed, total) =>
          (this.progressSink ?? this.deps.onProgress)?.(toolCallId, completed, total),
      });
      return { ...result, sourceDocument: plan.attachmentName };
    } catch (error) {
      if (error instanceof FormFillBatchError) throw error;
      throw error;
    }
  }

  /** Revoke all pending plans for this generation (stop/gate/target change). */
  revoke(): void {
    this.ledger.revokeGeneration(this.deps.owner.generationId);
    this.authorized.clear();
  }

  private extract(attachment: Attachment): FormFillExtraction {
    if (attachment.kind !== "text" || typeof attachment.text !== "string") {
      throw new FormFillServiceError(
        "attachment_unsupported",
        "Form fill reads explicit Label: value pairs from a UTF-8 .txt or .md attachment.",
      );
    }
    try {
      return extractFormFillEntities({
        attachmentId: attachment.id,
        name: attachment.name,
        size: attachment.size,
        text: attachment.text,
      });
    } catch (error) {
      if (error instanceof FormFillExtractionError) throw error;
      throw error;
    }
  }
}
