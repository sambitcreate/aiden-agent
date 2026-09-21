import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseController } from "./controller.js";
import { ComputerUseSafetyError } from "./safety.js";
import { FORM_FILL_BATCH_VERSION, type FormFillBatchPlan } from "../form-fill/batch-core.js";

/**
 * Scripted cua-driver session. Every callTool records its args and pulls the
 * next scripted payload for that tool name (last payload repeats).
 */
class FakeSession {
  ready = true;
  toolCatalog = new Map();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;

  constructor(private readonly script: Record<string, Record<string, unknown>[]>) {}

  supports(): boolean {
    return false;
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    this.calls.push({ name, args });
    const list = this.script[name];
    const payload = list && list.length > 1 ? list.shift()! : list?.[0];
    return {
      content: [{ type: "text", text: "{}" }],
      structuredContent: payload ?? {},
    };
  }

  async close() {
    this.closed = true;
  }
}

const WINDOWS = {
  windows: [
    {
      pid: 42,
      window_id: 7,
      app_name: "Safari",
      title: "Registration",
      z_index: 0,
      is_on_screen: true,
    },
  ],
};

function element(index: number, label: string, value = "", token?: string) {
  return {
    element_index: index,
    element_token: token,
    role: "AXTextField",
    label,
    value,
  };
}

function windowState(elements: unknown[]) {
  return { elements, element_count: elements.length };
}

function makeController(script: Record<string, Record<string, unknown>[]>) {
  const session = new FakeSession(script);
  const controller = new ComputerUseController("gen-1", false, async () => ({
    createSession: async () => session,
    shutdown: async () => {},
  }));
  return { controller, session };
}

async function planFor(controller: ComputerUseController): Promise<FormFillBatchPlan> {
  const capture = await controller.formFillCapture({ pid: 42, windowId: 7 });
  return {
    version: FORM_FILL_BATCH_VERSION,
    planId: "ffp-1",
    chatId: "chat-1",
    generationId: "gen-1",
    documentId: "doc-1",
    attachmentId: "att-1",
    attachmentHash: "a".repeat(64),
    attachmentName: "patient.txt",
    window: capture.window,
    controllerEpoch: capture.revision,
    actions: [
      {
        order: 0,
        elementIndex: 0,
        elementToken: "tok-0",
        role: "AXTextField",
        label: "First name",
        action: "fill",
        entityIndex: 0,
        value: "Ada",
        source: { attachmentId: "att-1", label: "First name", line: 1 },
      },
      {
        order: 1,
        elementIndex: 1,
        elementToken: "tok-1",
        role: "AXTextField",
        label: "Last name",
        action: "fill",
        entityIndex: 1,
        value: "Lovelace",
        source: { attachmentId: "att-1", label: "Last name", line: 2 },
      },
    ],
    maxActions: 2,
    submit: false,
    expiresAt: Date.now() + 60_000,
  };
}

const FILL_ELEMENTS_PRE = () => [
  element(0, "First name", "", "tok-0"),
  element(1, "Last name", "", "tok-1"),
];

test("batch fills each field via fresh observation, token+semantic reacquire, verify", async () => {
  const { controller, session } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()), // plan capture
      windowState(FILL_ELEMENTS_PRE()), // pre-mutation observe (action 0)
      // post-verify: value present
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
      windowState([
        element(0, "First name", "Ada", "tok-0"),
        element(1, "Last name", "Lovelace", "tok-1"),
      ]),
    ],
    set_value: [{ effect: "confirmed" }],
  });
  const plan = await planFor(controller);
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.filled, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.stoppedEarly, false);
  const writes = session.calls.filter((call) => call.name === "set_value");
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((call) => [call.args.element_index, call.args.value]),
    [
      [0, "Ada"],
      [1, "Lovelace"],
    ],
  );
  // Fresh observation ran before and after every mutation.
  const observations = session.calls.filter((call) => call.name === "get_window_state");
  assert.equal(observations.length, 5);
});

test("batch stops on the first element drift — later actions never run", async () => {
  const { controller, session } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()),
      // Re-observation finds the control renamed — drift.
      windowState([element(0, "Surname", "", "tok-0"), element(1, "Last name", "", "tok-1")]),
    ],
    set_value: [{ effect: "confirmed" }],
  });
  const plan = await planFor(controller);
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.rows[0].status, "failed");
  assert.equal(result.rows[1].status, "not_attempted");
  assert.equal(session.calls.filter((call) => call.name === "set_value").length, 0);
});

test("an unconfirmed driver effect stops the batch without later actions", async () => {
  const { controller } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [windowState(FILL_ELEMENTS_PRE())],
    set_value: [{ effect: "applied" }],
  });
  const plan = await planFor(controller);
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.rows[0].status, "failed");
  assert.equal(result.rows[1].status, "not_attempted");
  assert.equal(result.stopReason, "effect_unconfirmed");
});

test("a postcondition mismatch stops the batch", async () => {
  const { controller } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()),
      windowState(FILL_ELEMENTS_PRE()),
      // Post-verify shows the field did not retain the value.
      windowState([
        element(0, "First name", "Other", "tok-0"),
        element(1, "Last name", "", "tok-1"),
      ]),
    ],
    set_value: [{ effect: "confirmed" }],
  });
  const plan = await planFor(controller);
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.rows[0].status, "failed");
  assert.equal(result.stopReason, "postcondition_failed");
  assert.equal(result.stoppedEarly, true);
});

test("a target drift between approval and execution rejects the plan", async () => {
  const { controller } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [windowState(FILL_ELEMENTS_PRE())],
  });
  const plan = await planFor(controller);
  // Another capture bumps the controller epoch — the plan must not run.
  await controller.formFillCapture({ pid: 42, windowId: 7 });
  await assert.rejects(
    () => controller.executeFormFillBatch(plan),
    (error: unknown) => error instanceof ComputerUseSafetyError && error.code === "form_fill_drift",
  );
});

test("wrong generation, expired, or submit-bearing plans are refused", async () => {
  const { controller } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [windowState(FILL_ELEMENTS_PRE())],
  });
  const plan = await planFor(controller);
  await assert.rejects(
    () => controller.executeFormFillBatch({ ...plan, generationId: "gen-9" }),
    (error: unknown) =>
      error instanceof ComputerUseSafetyError && error.code === "form_fill_plan_invalid",
  );
  await assert.rejects(
    () => controller.executeFormFillBatch({ ...plan, expiresAt: Date.now() - 1 }),
    (error: unknown) =>
      error instanceof ComputerUseSafetyError && error.code === "form_fill_plan_expired",
  );
  await assert.rejects(
    () => controller.executeFormFillBatch({ ...plan, submit: true as never }),
    (error: unknown) =>
      error instanceof ComputerUseSafetyError && error.code === "form_fill_plan_invalid",
  );
});

test("deselected rows are untouched without being executed", async () => {
  const { controller, session } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()),
      windowState(FILL_ELEMENTS_PRE()),
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
    ],
    set_value: [{ effect: "confirmed" }],
  });
  const plan = { ...(await planFor(controller)), excludedOrders: [1] };
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.filled, 1);
  assert.equal(result.untouched, 1);
  assert.equal(session.calls.filter((call) => call.name === "set_value").length, 1);
});

test("an already-populated matching field counts as already_satisfied", async () => {
  const { controller, session } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()),
      // Re-observation: the field already holds the source value.
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
      windowState([
        element(0, "First name", "Ada", "tok-0"),
        element(1, "Last name", "Lovelace", "tok-1"),
      ]),
    ],
    set_value: [{ effect: "confirmed" }],
  });
  const plan = await planFor(controller);
  const result = await controller.executeFormFillBatch(plan);
  assert.equal(result.rows[0].status, "already_satisfied");
  assert.equal(result.rows[1].status, "filled");
  assert.equal(session.calls.filter((call) => call.name === "set_value").length, 1);
});

test("cancellation between actions marks the rest not_attempted", async () => {
  const abort = new AbortController();
  const { controller, session } = makeController({
    list_windows: [WINDOWS],
    get_window_state: [
      windowState(FILL_ELEMENTS_PRE()),
      windowState(FILL_ELEMENTS_PRE()),
      windowState([element(0, "First name", "Ada", "tok-0"), element(1, "Last name", "", "tok-1")]),
      // Second action's pre-observation sees the abort.
    ],
    set_value: [
      {
        effect: "confirmed",
      },
    ],
  });
  const plan = await planFor(controller);
  const resultPromise = controller.executeFormFillBatch(plan, {
    signal: abort.signal,
    onRow: () => abort.abort(),
  });
  const result = await resultPromise;
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.rows[1].status, "not_attempted");
  assert.equal(session.calls.filter((call) => call.name === "set_value").length, 1);
});
