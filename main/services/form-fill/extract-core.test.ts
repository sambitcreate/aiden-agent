import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFormFillEntities,
  FormFillExtractionError,
  FORM_FILL_MAX_ENTITIES,
  FORM_FILL_MAX_LABEL_CHARS,
  FORM_FILL_MAX_VALUE_CHARS,
  FORM_FILL_TRUNCATION_SUFFIX,
  normalizeLabel,
} from "./extract-core.js";

const base = {
  attachmentId: "att-1",
  name: "patient.txt",
  size: 100,
};

function extract(text: string, overrides: Partial<typeof base> = {}) {
  return extractFormFillEntities({ ...base, ...overrides, text });
}

test("extracts explicit Label: value pairs with provenance", () => {
  const result = extract("First name: Ada\nE-mail: ada@example.com\nPhone: 555-0100\n");
  assert.equal(result.entities.length, 3);
  assert.deepEqual(
    result.entities.map((e) => [e.label, e.value, e.line]),
    [
      ["First name", "Ada", 1],
      ["E-mail", "ada@example.com", 2],
      ["Phone", "555-0100", 3],
    ],
  );
  assert.equal(result.entities[0].sourceKind, "extracted");
  assert.equal(result.entities[0].index, 0);
  assert.match(result.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.attachmentId, "att-1");
});

test("preserves values verbatim — no normalization or transformation", () => {
  const result = extract("Notes:   Ada  Lovelace,  Esq.  \nDOB: 12/10/1815\n");
  assert.equal(result.entities[0].value, "Ada  Lovelace,  Esq.");
  assert.equal(result.entities[1].value, "12/10/1815");
});

test("values may contain colons; label is split at the first colon", () => {
  const result = extract("Website: https://example.com:8080/path\n");
  assert.equal(result.entities[0].label, "Website");
  assert.equal(result.entities[0].value, "https://example.com:8080/path");
});

test("skips comments, blanks, and non-pair lines", () => {
  const result = extract("# heading\n\nNot a pair\nName: Ada\n// comment\n\n");
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].label, "Name");
});

test("empty and whitespace-only documents fail closed", () => {
  for (const text of ["", "   \n\n", "\n"]) {
    assert.throws(() => extract(text), (error: unknown) => {
      assert.ok(error instanceof FormFillExtractionError);
      assert.equal(error.failure, "empty");
      return true;
    });
  }
});

test("documents with no Label: value pairs fail closed", () => {
  assert.throws(() => extract("just prose\nmore prose"), (error: unknown) => {
    assert.ok(error instanceof FormFillExtractionError);
    assert.equal(error.failure, "no_entities");
    return true;
  });
});

test("binary content fails closed", () => {
  assert.throws(() => extract("a\0b\nName: Ada"), (error: unknown) => {
    assert.ok(error instanceof FormFillExtractionError);
    assert.equal(error.failure, "binary");
    return true;
  });
});

test("truncated attachment content fails closed", () => {
  assert.throws(
    () => extract(`Name: Ada${FORM_FILL_TRUNCATION_SUFFIX}`),
    (error: unknown) => {
      assert.ok(error instanceof FormFillExtractionError);
      assert.equal(error.failure, "truncated");
      return true;
    },
  );
});

test("oversized attachments fail closed", () => {
  assert.throws(
    () =>
      extractFormFillEntities({
        ...base,
        text: "Name: Ada",
        size: 300 * 1024,
      }),
    (error: unknown) => {
      assert.ok(error instanceof FormFillExtractionError);
      assert.equal(error.failure, "too_large");
      return true;
    },
  );
});

test("conflicting duplicate labels fail closed; identical duplicates are noted", () => {
  assert.throws(
    () => extract("Name: Ada\nname: Grace"),
    (error: unknown) => {
      assert.ok(error instanceof FormFillExtractionError);
      assert.equal(error.failure, "conflicting_duplicates");
      return true;
    },
  );
  const ok = extract("Name: Ada\nNAME: Ada");
  assert.equal(ok.entities.length, 1);
  assert.equal(ok.issues.length, 1);
  assert.match(ok.issues[0], /Duplicate/u);
});

test(`exactly ${FORM_FILL_MAX_ENTITIES} entities pass; one more fails closed`, () => {
  const ok = Array.from({ length: FORM_FILL_MAX_ENTITIES }, (_, i) => `Field ${i}: v${i}`).join(
    "\n",
  );
  assert.equal(extract(ok).entities.length, FORM_FILL_MAX_ENTITIES);
  const over = `${ok}\nField ${FORM_FILL_MAX_ENTITIES}: v`;
  assert.throws(() => extract(over), (error: unknown) => {
    assert.ok(error instanceof FormFillExtractionError);
    assert.equal(error.failure, "too_many_entities");
    return true;
  });
});

test("oversized labels and values are skipped with an issue, not silently kept", () => {
  const text = [
    `Name: Ada`,
    `${"L".repeat(FORM_FILL_MAX_LABEL_CHARS + 1)}: v`,
    `Notes: ${"v".repeat(FORM_FILL_MAX_VALUE_CHARS + 1)}`,
  ].join("\n");
  const result = extract(text);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].label, "Name");
  assert.equal(result.issues.length, 2);
});

test("unsupported types: undefined text fails closed as empty", () => {
  assert.throws(
    () =>
      extractFormFillEntities({
        attachmentId: "a",
        name: "photo.png",
        size: 10,
        text: undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof FormFillExtractionError);
      assert.equal(error.failure, "empty");
      return true;
    },
  );
});

test("normalizeLabel is only for de-duplication", () => {
  assert.equal(normalizeLabel("  First   Name "), "first name");
  assert.equal(normalizeLabel("E-MAIL"), "e-mail");
});
