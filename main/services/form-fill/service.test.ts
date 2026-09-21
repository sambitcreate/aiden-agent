import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment } from "../types.js";
import { FormFillBatchError } from "./batch-core.js";
import type { FormFillBatchPlan, FormFillBatchResult } from "./batch-core.js";
import {
  FormFillService,
  FormFillServiceError,
  normalizeFormFillArgs,
  type FormFillControllerLike,
} from "./service.js";
import type { FormFillElement } from "./planner-core.js";
import { formFillContentHash } from "./extract-core.js";

const DOCUMENT = "First name: Ada\nLast name: Lovelace\n";

const ELEMENTS: FormFillElement[] = [
  { index: 0, token: "t0", role: "AXTextField", label: "First name", value: "" },
  { index: 1, token: "t1", role: "AXTextField", label: "Last name", value: "" },
  { index: 2, token: "t2", role: "AXButton", label: "Submit" },
];

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    name: "patient.txt",
    mimeType: "text/plain",
    kind: "text",
    size: DOCUMENT.length,
    text: DOCUMENT,
    ...overrides,
  };
}

class FakeController implements FormFillControllerLike {
  generationId = "gen-1";
  executed: FormFillBatchPlan[] = [];
  result: FormFillBatchResult | null = null;
  async formFillCapture() {
    return {
      window: { pid: 42, windowId: 7, appName: "Safari", title: "Registration" },
      elements: ELEMENTS,
      revision: 3,
    };
  }
  async executeFormFillBatch(plan: FormFillBatchPlan): Promise<FormFillBatchResult> {
    this.executed.push(plan);
    if (this.result) return this.result;
    const rows = plan.actions.map((action) => ({
      order: action.order,
      elementIndex: action.elementIndex,
      label: action.label,
      status: (plan.excludedOrders?.includes(action.order) ? "untouched" : "filled") as
        | "untouched"
        | "filled",
    }));
    return {
      planId: plan.planId,
      rows,
      filled: rows.filter((row) => row.status === "filled").length,
      alreadySatisfied: 0,
      untouched: rows.filter((row) => row.status === "untouched").length,
      needsReview: 0,
      failed: 0,
      notAttempted: 0,
      stoppedEarly: false,
    };
  }
}

function makeScorer() {
  const calls: string[] = [];
  return {
    calls,
    async score(context: string, options: string[]) {
      calls.push(context);
      const label = /ELEMENT [^"]+ "([^"]+)"/u.exec(context)?.[1] ?? "";
      // Deterministic: pick the entity whose label matches the element label.
      const index = options.findIndex(
        (option) => option.startsWith("fill ") && option.includes(`${label}:`),
      );
      const probabilities = options.map((_, i) => (i === index ? 0.99 : 0.001));
      return {
        selectedIndex: index === -1 ? options.length - 1 : index,
        probabilities,
        contextWasTruncated: false,
        truncatedOptionIndices: [],
      };
    },
  };
}

function makeService(overrides: {
  attachments?: Attachment[];
  controller?: FakeController;
  scorer?: ReturnType<typeof makeScorer>;
}) {
  const controller = overrides.controller ?? new FakeController();
  const scorer = overrides.scorer ?? makeScorer();
  const service = new FormFillService({
    controller,
    scorer,
    attachmentResolver: () => overrides.attachments ?? [makeAttachment()],
    owner: { chatId: "chat-1", generationId: "gen-1", documentId: "doc-1" },
  });
  return { service, controller, scorer };
}

const ARGS = { attachment_id: "att-1", pid: 42, window_id: 7 };

test("args accept only an attachment id and exact window", () => {
  assert.deepEqual(normalizeFormFillArgs(ARGS), {
    attachment_id: "att-1",
    pid: 42,
    window_id: 7,
  });
  for (const bad of [
    {},
    { attachment_id: "att-1" },
    { attachment_id: "att-1", pid: 42 },
    { attachment_id: "att-1", pid: 42, window_id: 7, value: "injected" },
  ]) {
    if (bad.attachment_id) continue;
    assert.throws(() => normalizeFormFillArgs(bad), FormFillServiceError);
  }
  assert.throws(
    () => normalizeFormFillArgs({ attachment_id: "", pid: 42, window_id: 7 }),
    FormFillServiceError,
  );
});

test("approvalFor extracts, captures, scores, and builds a provenanced plan", async () => {
  const { service, scorer } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  assert.equal(descriptor.details.kind, "form-fill-batch");
  assert.equal(descriptor.details.fillCount, 2);
  assert.equal(descriptor.details.submitExcluded, true);
  assert.equal(descriptor.details.sourceDocument, "patient.txt");
  assert.equal(descriptor.details.sourceHashPrefix, formFillContentHash(DOCUMENT).slice(0, 12));
  assert.deepEqual(
    descriptor.details.rows.map((row) => [row.label, row.value, row.sourceLine]),
    [
      ["First name", "Ada", 1],
      ["Last name", "Lovelace", 2],
    ],
  );
  // Submit control was scored but excluded from executable rows.
  assert.equal(descriptor.details.skippedRows.length, 1);
  assert.equal(descriptor.details.skippedRows[0].label, "Submit");
  assert.equal(scorer.calls.length, 3);
});

test("the review card is the digest surface: value edits invalidate authorize", async () => {
  const { service } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  assert.throws(
    () => service.authorize("tc-1", descriptor.planId, "0".repeat(64)),
    (error: unknown) => error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
});

test("authorize + execute runs the approved plan once through the controller", async () => {
  const { service, controller } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  service.authorize("tc-1", descriptor.planId, descriptor.digest);
  const result = await service.execute("tc-1", ARGS);
  assert.equal(result.filled, 2);
  assert.equal(result.failed, 0);
  assert.equal(controller.executed.length, 1);
  const plan = controller.executed[0];
  assert.equal(plan.chatId, "chat-1");
  assert.equal(plan.generationId, "gen-1");
  assert.equal(plan.documentId, "doc-1");
  assert.equal(plan.attachmentHash, formFillContentHash(DOCUMENT));
  assert.equal(plan.submit, false);
  assert.equal(plan.controllerEpoch, 3);
  // Second execution is impossible — the authority was consumed.
  await assert.rejects(
    () => service.execute("tc-1", ARGS),
    (error: unknown) => error instanceof FormFillBatchError && error.code === "not_authorized",
  );
});

test("execution requires approval", async () => {
  const { service } = makeService({});
  await assert.rejects(
    () => service.execute("tc-never", ARGS),
    (error: unknown) => error instanceof FormFillBatchError && error.code === "not_authorized",
  );
});

test("tool args cannot repoint the approved plan", async () => {
  const { service } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  service.authorize("tc-1", descriptor.planId, descriptor.digest);
  await assert.rejects(
    () => service.execute("tc-1", { ...ARGS, window_id: 99 }),
    (error: unknown) => error instanceof FormFillBatchError && error.code === "plan_mismatch",
  );
});

test("row deselection marks rows untouched", async () => {
  const { service, controller } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  service.authorize("tc-1", descriptor.planId, descriptor.digest, [1]);
  const result = await service.execute("tc-1", ARGS);
  assert.equal(result.filled, 1);
  assert.equal(result.untouched, 1);
  assert.deepEqual(controller.executed[0].excludedOrders, [1]);
});

test("revoke drops pending plans and outstanding authority", async () => {
  const { service } = makeService({});
  const descriptor = await service.approvalFor(ARGS);
  service.authorize("tc-1", descriptor.planId, descriptor.digest);
  service.revoke();
  await assert.rejects(
    () => service.execute("tc-1", ARGS),
    (error: unknown) => error instanceof FormFillBatchError && error.code === "not_authorized",
  );
});

test("the source must be an attachment on the triggering message", async () => {
  const { service } = makeService({ attachments: [] });
  await assert.rejects(
    () => service.approvalFor(ARGS),
    (error: unknown) =>
      error instanceof FormFillServiceError && error.code === "attachment_not_found",
  );
  const { service: imageOnly } = makeService({
    attachments: [makeAttachment({ kind: "image", text: undefined, mimeType: "image/png" })],
  });
  await assert.rejects(
    () => imageOnly.approvalFor(ARGS),
    (error: unknown) =>
      error instanceof FormFillServiceError && error.code === "attachment_unsupported",
  );
});

test("extraction failures fail closed before any mutation", async () => {
  const { service } = makeService({
    attachments: [makeAttachment({ text: "# only comments\n// none\n", size: 30 })],
  });
  await assert.rejects(() => service.approvalFor(ARGS), /no.*label.*value|entities/i);
});
