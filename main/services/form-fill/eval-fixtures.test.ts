import assert from "node:assert/strict";
import test from "node:test";
import {
  FORM_FILL_FIXED_ACTIONS,
  planFormFill,
  type FormFillElement,
  type FormFillElementScore,
} from "./planner-core.js";
import {
  extractFormFillEntities,
  FormFillExtractionError,
  type FormFillEntity,
} from "./extract-core.js";

/**
 * Slice E evaluation fixtures. Each case pairs a bounded `Label: value`
 * document with a synthetic exact-window element snapshot and a scripted
 * argmax score so the full extract → render → score → plan pipeline can be
 * measured without the native scorer (which runs only on macOS).
 */

function score(
  elementIndex: number,
  selectedIndex: number,
  entityCount: number,
  topProbability = 0.92,
  secondProbability = 0.02,
): FormFillElementScore {
  const optionCount = entityCount + FORM_FILL_FIXED_ACTIONS.length;
  const rest = (1 - topProbability - secondProbability) / (optionCount - 2);
  const probabilities = Array.from({ length: optionCount }, (_, index) =>
    index === selectedIndex
      ? topProbability
      : index === (selectedIndex + 1) % optionCount
        ? secondProbability
        : rest,
  );
  return {
    elementIndex,
    selectedIndex,
    probabilities,
    contextWasTruncated: false,
    truncatedOptionIndices: [],
  };
}

/** Scripted argmax on the fixed `skip` action (last option index). */
function skipScore(
  elementIndex: number,
  entityCount: number,
): FormFillElementScore {
  return score(
    elementIndex,
    entityCount + FORM_FILL_FIXED_ACTIONS.indexOf("skip"),
    entityCount,
  );
}

const REGISTRATION_DOC = [
  "First name: Ada",
  "Last name: Lovelace",
  "Email: ada@example.com",
  "Street address: 12 Analytical Way",
].join("\n");

test("fixture 1 — registration form: fields fill, synonyms match, submit is excluded", () => {
  const extraction = extractFormFillEntities({
    attachmentId: "att-1",
    text: REGISTRATION_DOC,
    size: REGISTRATION_DOC.length,
    name: "registration.txt",
  });
  assert.equal(extraction.entities.length, 4);
  const elements: FormFillElement[] = [
    { index: 0, role: "textfield", label: "First name", value: "" },
    { index: 1, role: "textfield", label: "Last name", value: "" },
    { index: 2, role: "textfield", label: "Email", value: "" },
    // Synonym: the document says "Street address", the field says "Address line 1".
    { index: 3, role: "textfield", label: "Address line 1", value: "" },
    { index: 4, role: "button", label: "Submit", actions: ["press"] },
    { index: 5, role: "static", label: "Patient registration" },
  ];
  const n = extraction.entities.length;
  const plan = planFormFill({
    entities: extraction.entities,
    elements,
    formTitle: "Patient registration",
    scores: [
      score(0, 0, n), // First name entity
      score(1, 1, n),
      score(2, 2, n),
      score(3, 3, n), // model maps the synonym field to the street entity
      skipScore(4, n),
    ],
  });
  assert.equal(plan.fills.length, 4);
  assert.deepEqual(
    plan.fills.map((row) => [row.elementIndex, row.value]),
    [
      [0, "Ada"],
      [1, "Lovelace"],
      [2, "ada@example.com"],
      [3, "12 Analytical Way"],
    ],
  );
  // Every fill carries document provenance.
  for (const row of plan.fills) {
    assert.ok(row.source && row.source.line >= 1);
    assert.equal(row.value, extraction.entities[row.entityIndex!]!.value);
  }
  const submit = plan.rows.find((row) => row.elementIndex === 4)!;
  assert.equal(submit.outcome, "skip");
  assert.equal(submit.action, "skip");
  assert.match(submit.reason ?? "", /never part of the fill batch/u);
  // Non-control elements produce no row at all.
  assert.equal(
    plan.rows.find((row) => row.elementIndex === 5),
    undefined,
  );
  assert.equal(plan.hasReview, false);
});

test("fixture 2 — distractor entities are never written; already-filled fields are skipped", () => {
  const doc = [
    "Phone: +1 555 0100",
    "Blood type: O-",
    "Middle name: Grace",
  ].join("\n");
  const extraction = extractFormFillEntities({
    attachmentId: "att-2",
    text: doc,
    size: doc.length,
    name: "contact.txt",
  });
  assert.equal(extraction.entities.length, 3);
  const elements: FormFillElement[] = [
    { index: 0, role: "textfield", label: "Phone", value: "+1 555 0100" },
    { index: 1, role: "textfield", label: "Notes", value: "" },
  ];
  const n = extraction.entities.length;
  const plan = planFormFill({
    entities: extraction.entities,
    elements,
    formTitle: "Contact",
    scores: [score(0, 0, n), skipScore(1, n)],
  });
  assert.equal(plan.fills.length, 0);
  const phone = plan.rows.find((row) => row.elementIndex === 0)!;
  assert.equal(phone.outcome, "skip");
  assert.match(phone.reason ?? "", /already contains this value/u);
  const notes = plan.rows.find((row) => row.elementIndex === 1)!;
  assert.equal(notes.outcome, "needs_review");
  assert.match(notes.reason ?? "", /chose to skip/u);
  // Distractor values are absent from every executable row.
  for (const row of plan.fills) {
    assert.notEqual(row.value, "O-");
    assert.notEqual(row.value, "Grace");
  }
});

test("fixture 3 — ambiguous labels and weak scores become needs_review", () => {
  const doc = ["City: Paris", "State: TX"].join("\n");
  const extraction = extractFormFillEntities({
    attachmentId: "att-3",
    text: doc,
    size: doc.length,
    name: "address.txt",
  });
  const elements: FormFillElement[] = [
    // Two fields with the same visible label — ambiguous even when scored.
    { index: 0, role: "textfield", label: "Name", value: "" },
    { index: 1, role: "textfield", label: "Name", value: "" },
    { index: 2, role: "textfield", label: "City", value: "" },
  ];
  const n = extraction.entities.length;
  const weakAmbiguous = (index: number): FormFillElementScore => ({
    ...score(index, 0, n, 0.55, 0.45),
    probabilities: Array.from({ length: n + 3 }, (_, i) =>
      i === 0 ? 0.55 : i === 1 ? 0.45 : 0,
    ),
  });
  const plan = planFormFill({
    entities: extraction.entities,
    elements,
    formTitle: "Address",
    scores: [
      weakAmbiguous(0),
      weakAmbiguous(1),
      { ...score(2, 0, n, 0.4, 0.35) },
    ],
  });
  assert.equal(plan.fills.length, 0);
  assert.equal(
    plan.rows.filter((row) => row.outcome === "needs_review").length,
    3,
  );
  assert.equal(plan.hasReview, true);
});

test("fixture 4 — checkboxes are never toggled from unknown state; consent needs review", () => {
  const doc = [
    "Subscribe to newsletter: yes",
    "Agree to terms: yes",
    "Emergency contact: yes",
    "Already a member: yes",
  ].join("\n");
  const extraction = extractFormFillEntities({
    attachmentId: "att-4",
    text: doc,
    size: doc.length,
    name: "consent.txt",
  });
  const n = extraction.entities.length;
  const checkAction = n + FORM_FILL_FIXED_ACTIONS.indexOf("check");
  const elements: FormFillElement[] = [
    {
      index: 0,
      role: "checkbox",
      label: "Subscribe to newsletter",
      checked: false,
      actions: ["press"],
    },
    {
      index: 1,
      role: "checkbox",
      label: "I agree to the terms and conditions",
      checked: false,
      actions: ["press"],
    },
    // Known checkbox role but the normalized state is absent.
    {
      index: 2,
      role: "checkbox",
      label: "Emergency contact",
      actions: ["press"],
    },
    {
      index: 3,
      role: "checkbox",
      label: "Already a member",
      checked: true,
      actions: ["press"],
    },
  ];
  const plan = planFormFill({
    entities: extraction.entities,
    elements,
    formTitle: "Consent",
    scores: [
      score(0, checkAction, n),
      score(1, checkAction, n),
      score(2, checkAction, n),
      score(3, checkAction, n),
    ],
  });
  // v1 never auto-checks: every check decision is reviewable or skipped.
  assert.equal(plan.fills.length, 0);
  const [subscribe, terms, unknown, already] = [
    plan.rows.find((row) => row.elementIndex === 0)!,
    plan.rows.find((row) => row.elementIndex === 1)!,
    plan.rows.find((row) => row.elementIndex === 2)!,
    plan.rows.find((row) => row.elementIndex === 3)!,
  ];
  assert.equal(subscribe.outcome, "needs_review");
  assert.equal(terms.outcome, "needs_review");
  assert.match(terms.reason ?? "", /consent|terms/iu);
  assert.equal(unknown.outcome, "needs_review");
  assert.match(unknown.reason ?? "", /unknown/iu);
  assert.equal(already.outcome, "skip");
  assert.match(already.reason ?? "", /already checked/u);
});

test("fixture 5 — documents with more than 29 entities fail closed before any mutation", () => {
  const lines = Array.from(
    { length: 30 },
    (_, i) => `Field ${i + 1}: value ${i + 1}`,
  );
  const doc = lines.join("\n");
  assert.throws(
    () =>
      extractFormFillEntities({
        attachmentId: "att-5",
        text: doc,
        size: doc.length,
        name: "overflow.txt",
      }),
    (error) =>
      error instanceof FormFillExtractionError &&
      error.failure === "too_many_entities",
  );
});

test("eval metrics — extraction, match, abstention, and unsafe-mutation accounting", () => {
  const cases = [
    {
      name: "registration",
      doc: REGISTRATION_DOC,
      elements: [
        { index: 0, role: "textfield", label: "First name", value: "" },
        { index: 1, role: "textfield", label: "Email", value: "" },
        { index: 2, role: "button", label: "Submit", actions: ["press"] },
      ] satisfies FormFillElement[],
      scores: (entities: readonly FormFillEntity[]) => [
        score(0, 0, entities.length),
        score(1, 2, entities.length),
        skipScore(2, entities.length),
      ],
    },
    {
      name: "mixed",
      doc: "Phone: +1 555 0100\nPreferred contact: email",
      elements: [
        { index: 0, role: "textfield", label: "Phone", value: "" },
        { index: 1, role: "textfield", label: "Anything else", value: "" },
      ] satisfies FormFillElement[],
      scores: (entities: readonly FormFillEntity[]) => [
        score(0, 0, entities.length),
        skipScore(1, entities.length),
      ],
    },
  ];
  let extracted = 0;
  let filled = 0;
  let needsReview = 0;
  let skipped = 0;
  let unsafe = 0;
  let submitExcluded = 0;
  for (const fixture of cases) {
    const extraction = extractFormFillEntities({
      attachmentId: `att-${fixture.name}`,
      text: fixture.doc,
      size: fixture.doc.length,
      name: `${fixture.name}.txt`,
    });
    extracted += 1;
    const plan = planFormFill({
      entities: extraction.entities,
      elements: fixture.elements,
      formTitle: fixture.name,
      scores: fixture.scores(extraction.entities),
    });
    for (const row of plan.rows) {
      if (row.outcome === "fill") {
        filled += 1;
        if (!extraction.entities.some((entity) => entity.value === row.value))
          unsafe += 1;
      } else if (row.outcome === "needs_review") needsReview += 1;
      else skipped += 1;
      if (/never part of the fill batch/u.test(row.reason ?? ""))
        submitExcluded += 1;
    }
  }
  assert.equal(extracted, 2);
  assert.equal(filled, 3);
  assert.equal(needsReview, 1);
  assert.equal(skipped, 1);
  assert.equal(unsafe, 0);
  assert.equal(submitExcluded, 1);
});
