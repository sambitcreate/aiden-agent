import assert from "node:assert/strict";
import test from "node:test";
import type { FormFillEntity } from "./extract-core.js";
import {
  decodeOption,
  filterActionable,
  isSubmitControl,
  planFormFill,
  renderContext,
  renderOptions,
  truncateUtf8,
  type FormFillElement,
  type FormFillElementScore,
  FORM_FILL_DEFAULT_THRESHOLDS,
} from "./planner-core.js";

function entity(label: string, value: string, line = 1): FormFillEntity {
  return { index: 0, label, value, line, sourceKind: "extracted" };
}

function element(overrides: Partial<FormFillElement>): FormFillElement {
  return { index: 0, ...overrides };
}

/** A score that argmaxes `selected` with a confident top and margin. */
function score(
  elementIndex: number,
  optionCount: number,
  selected: number,
  overrides: Partial<FormFillElementScore> = {},
): FormFillElementScore {
  const probabilities = new Array(optionCount).fill(0.01);
  probabilities[selected] = 0.9;
  return {
    elementIndex,
    selectedIndex: selected,
    probabilities,
    contextWasTruncated: false,
    truncatedOptionIndices: [],
    ...overrides,
  };
}

// ---- Upstream rendering fidelity --------------------------------------------

test("renderContext matches the upstream byte format", () => {
  const ctx = renderContext(
    "Northwind Clinic - New Patient Registration",
    element({ role: "Edit", label: "First name", value: "" }),
  );
  assert.equal(
    ctx,
    "TASK fill the form from the document, then submit\n" +
      "FORM Northwind Clinic - New Patient Registration\n" +
      'ELEMENT Edit "First name" value=""',
  );
});

test("renderContext renders checkbox state and truncates like upstream", () => {
  const ctx = renderContext(
    "F",
    element({ role: "CheckBox", label: "Consent", checked: false }),
  );
  assert.equal(
    ctx,
    'TASK fill the form from the document, then submit\nFORM F\nELEMENT CheckBox "Consent" unchecked',
  );
  const long = renderContext(
    "F",
    element({ role: "Edit", label: "x".repeat(100), value: "y".repeat(60) }),
  );
  assert.ok(long.includes(`"${"x".repeat(72)}"`));
  assert.ok(long.includes(`value="${"y".repeat(48)}"`));
});

test("renderOptions appends fixed actions after entity fills", () => {
  const entities = [entity("Name", "Ada"), entity("DOB", "1815")];
  assert.deepEqual(renderOptions(entities), [
    "fill Name: Ada",
    "fill DOB: 1815",
    "check",
    "click",
    "skip",
  ]);
});

test("decodeOption only decodes valid indices", () => {
  assert.deepEqual(decodeOption(0, 2), { action: "fill", entityIndex: 0 });
  assert.deepEqual(decodeOption(1, 2), { action: "fill", entityIndex: 1 });
  assert.deepEqual(decodeOption(2, 2), { action: "check" });
  assert.deepEqual(decodeOption(3, 2), { action: "click" });
  assert.deepEqual(decodeOption(4, 2), { action: "skip" });
  for (const bad of [-1, 5, 1.5, Number.NaN]) {
    assert.throws(() => decodeOption(bad, 2));
  }
});

test("truncateUtf8 stops at the last complete code point and flags truncation", () => {
  const out = truncateUtf8("a".repeat(223) + "🙂", 224);
  assert.equal(out.truncated, true);
  assert.ok(new TextEncoder().encode(out.text).length <= 224);
  assert.equal(out.text, "a".repeat(223));
  assert.equal(truncateUtf8("short", 224).truncated, false);
});

// ---- Planning outcomes --------------------------------------------------------

test("a matching empty text field produces a verbatim fill", () => {
  const entities = [entity("First name", "Ada")];
  const elements = [
    element({ index: 3, role: "AXTextField", label: "First name", value: "" }),
  ];
  const plan = planFormFill({
    entities,
    elements,
    formTitle: "F",
    scores: [score(3, entities.length + 3, 0)],
  });
  assert.equal(plan.fills.length, 1);
  const row = plan.fills[0];
  assert.equal(row.elementIndex, 3);
  assert.equal(row.value, "Ada");
  assert.equal(row.source?.label, "First name");
  assert.equal(row.source?.line, 1);
});

test("skip-wins, low probability, and small margin all become needs_review", () => {
  const entities = [entity("Name", "Ada")];
  const optionCount = entities.length + 3;
  const el = element({ index: 1, role: "Edit", label: "Name", value: "" });
  const base = { entities, elements: [el], formTitle: "F" };

  // skip wins
  let plan = planFormFill({
    ...base,
    scores: [score(1, optionCount, entities.length + 2)],
  });
  assert.equal(plan.rows[0].outcome, "needs_review");

  // low top probability
  const low = score(1, optionCount, 0, {
    probabilities: [0.3, 0.25, 0.25, 0.2],
  });
  plan = planFormFill({ ...base, scores: [low] });
  assert.equal(plan.rows[0].outcome, "needs_review");
  assert.match(plan.rows[0].reason ?? "", /confident/u);

  // small margin
  const tight = score(1, optionCount, 0, {
    probabilities: [0.5, 0.4, 0.05, 0.05],
  });
  plan = planFormFill({ ...base, scores: [tight] });
  assert.equal(plan.rows[0].outcome, "needs_review");
});

test("material truncation routes to needs_review", () => {
  const entities = [entity("Name", "Ada")];
  const el = element({ index: 1, role: "Edit", label: "Name", value: "" });
  const truncated = score(1, entities.length + 3, 0, {
    contextWasTruncated: true,
  });
  const plan = planFormFill({
    entities,
    elements: [el],
    formTitle: "F",
    scores: [truncated],
  });
  assert.equal(plan.rows[0].outcome, "needs_review");
  assert.match(plan.rows[0].reason ?? "", /truncated/u);
});

test("already-populated fields: identical skips, different needs review", () => {
  const entities = [entity("Name", "Ada")];
  const same = element({ index: 1, role: "Edit", label: "Name", value: "Ada" });
  const different = element({
    index: 2,
    role: "Edit",
    label: "Name",
    value: "Grace",
  });
  const scores = [score(1, 4, 0), score(2, 4, 0)];
  const plan = planFormFill({
    entities,
    elements: [same, different],
    formTitle: "F",
    scores,
  });
  assert.equal(plan.rows[0].outcome, "skip");
  assert.equal(plan.rows[1].outcome, "needs_review");
  assert.equal(plan.fills.length, 0);
});

test("submit buttons are recognized but never planned", () => {
  const entities = [entity("Name", "Ada")];
  const submit = element({ index: 9, role: "AXButton", label: "Submit" });
  assert.ok(isSubmitControl(submit));
  const plan = planFormFill({
    entities,
    elements: [submit],
    formTitle: "F",
    scores: [score(9, 4, 3)], // model wants "click" — still never planned
  });
  assert.equal(plan.rows[0].outcome, "skip");
  assert.equal(plan.fills.length, 0);
});

test("checkboxes: unknown state never toggles, consequential labels review", () => {
  const entities = [entity("Name", "Ada")];
  const optionCount = 4;
  const cases: [Partial<FormFillElement>, string][] = [
    [
      { role: "AXCheckBox", label: "Reminders", checked: undefined },
      "needs_review",
    ],
    [
      { role: "AXCheckBox", label: "I agree to the terms", checked: false },
      "needs_review",
    ],
    [{ role: "AXCheckBox", label: "Reminders", checked: true }, "skip"],
    [
      {
        role: "AXCheckBox",
        label: "Reminders",
        checked: false,
        actions: ["AXPress"],
      },
      "needs_review",
    ],
    [{ role: "Edit", label: "Name" }, "needs_review"], // check on non-checkbox
  ];
  cases.forEach(([overrides, expected], i) => {
    const el = element({ index: i + 1, ...overrides });
    const plan = planFormFill({
      entities,
      elements: [el],
      formTitle: "F",
      scores: [score(i + 1, optionCount, entities.length)], // model picked "check"
    });
    assert.equal(plan.rows[0].outcome, expected, `case ${i}`);
  });
});

test("fills never come from outside the source set", () => {
  const entities = [entity("Name", "Ada")];
  const el = element({ index: 1, role: "Edit", label: "Name", value: "" });
  // selectedIndex beyond valid range → needs_review, never an invented fill.
  const plan = planFormFill({
    entities,
    elements: [el],
    formTitle: "F",
    scores: [
      score(1, 4, 0, {
        selectedIndex: 4,
        probabilities: [0.2, 0.1, 0.1, 0.1, 0.5],
      }),
    ],
  });
  assert.equal(plan.rows[0].outcome, "needs_review");
  assert.equal(plan.fills.length, 0);
});

test("non-actionable elements are excluded; fills order deterministically", () => {
  const entities = [entity("A", "1"), entity("B", "2")];
  const elements = [
    element({ index: 5, role: "Edit", label: "B", value: "" }),
    element({ index: 2, role: "StaticText", label: "label" }),
    element({ index: 1, role: "Edit", label: "A", value: "" }),
  ];
  const scores = [score(5, 5, 1), score(1, 5, 0)];
  const plan = planFormFill({ entities, elements, formTitle: "F", scores });
  assert.deepEqual(
    plan.fills.map((f) => f.elementIndex),
    [1, 5],
  );
  assert.equal(filterActionable(elements).length, 2);
});

test("missing score for an element yields needs_review", () => {
  const plan = planFormFill({
    entities: [entity("Name", "Ada")],
    elements: [element({ index: 1, role: "Edit", label: "Name", value: "" })],
    formTitle: "F",
    scores: [],
  });
  assert.equal(plan.rows[0].outcome, "needs_review");
});

test("thresholds are injectable and validated bounds are respected", () => {
  const entities = [entity("Name", "Ada")];
  const el = element({ index: 1, role: "Edit", label: "Name", value: "" });
  const marginal = score(1, 4, 0, { probabilities: [0.55, 0.4, 0.02, 0.03] });
  const lenient = planFormFill(
    { entities, elements: [el], formTitle: "F", scores: [marginal] },
    { ...FORM_FILL_DEFAULT_THRESHOLDS, minMargin: 0.1 },
  );
  assert.equal(lenient.rows[0].outcome, "fill");
});
