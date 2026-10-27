import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWebExtractRecap,
  displayWebExtractValue,
  parseWebExtractRecap,
  type WebExtractRecapV1,
} from "./web-extract.js";

const RECAP: WebExtractRecapV1 = {
  version: 1,
  host: "acme.example",
  cut: false,
  fields: [
    { name: "pro_monthly", status: "extracted", value: "20", confidence: 0.97, sourceLine: "Pro is $20 per month." },
    { name: "team_yearly", status: "uncertain", value: "1399", confidence: 0.92, notFound: true },
    { name: "enterprise", status: "null" },
  ],
};

test("the recap keeps names, display values, confidence and source lines, and nothing else", () => {
  const recap = buildWebExtractRecap({
    url: "https://acme.example/pricing?token=secret",
    cut: false,
    fields: {
      pro_monthly: { status: "extracted", value: 20, confidence: 0.97, sourceLine: "Pro is $20 per month." },
      team_yearly: { status: "uncertain", guess: 1399, confidence: 0.92, notFound: true },
      enterprise: { status: "null", value: null },
    },
  });
  assert.deepEqual(recap, RECAP);
  assert.doesNotMatch(JSON.stringify(recap), /secret|pricing/u);
});

test("long or multi-line values are shown on one bounded line", () => {
  assert.equal(displayWebExtractValue("line one\nline\ttwo"), "line one line two");
  assert.equal(displayWebExtractValue(["Germany", "Japan"]), '["Germany","Japan"]');
  const long = displayWebExtractValue("x".repeat(500));
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith("…"));
  const recap = buildWebExtractRecap({
    url: "https://acme.example",
    fields: { notes: { status: "extracted", value: "y".repeat(500), confidence: 0.9, sourceLine: `${"z".repeat(300)}\n` } },
  });
  assert.ok(recap);
  assert.ok(Array.from(recap.fields[0]!.value!).length <= 200);
  assert.ok(Array.from(recap.fields[0]!.sourceLine!).length <= 200);
});

test("a failed extraction is a recap with the reason and no fields", () => {
  assert.deepEqual(buildWebExtractRecap({ url: "https://acme.example", error: "quota" }), {
    version: 1,
    host: "acme.example",
    cut: false,
    error: "quota",
    fields: [],
  });
  assert.equal(buildWebExtractRecap({ url: "not a url", error: "quota" }), undefined);
});

test("stored and received recaps are rejected unless every field keeps its promise", () => {
  assert.deepEqual(parseWebExtractRecap(RECAP), RECAP);
  const field = (overrides: Record<string, unknown>) => ({ ...RECAP, fields: [{ ...RECAP.fields[0], ...overrides }] });
  const cases: Array<[string, unknown]> = [
    ["newer version", { ...RECAP, version: 2 }],
    ["no fields and no error", { ...RECAP, fields: [] }],
    ["fields alongside an error", { ...RECAP, error: "auth" }],
    ["unknown error", { ...RECAP, error: "boom", fields: [] }],
    ["extracted without a source line", field({ sourceLine: undefined })],
    ["extracted without confidence", field({ confidence: undefined })],
    ["confidence above 1", field({ confidence: 1.2 })],
    ["notFound on extracted", field({ notFound: true })],
    ["null with a value", { ...RECAP, fields: [{ name: "a", status: "null", value: "1" }] }],
    ["multi-line source", field({ sourceLine: "a\nb" })],
    ["unknown status", field({ status: "guessed" })],
    ["bad field name", field({ name: "has space" })],
    ["duplicate names", { ...RECAP, fields: [RECAP.fields[0], RECAP.fields[0]] }],
    ["host with a newline", { ...RECAP, host: "a\nb" }],
    ["seventeen fields", { ...RECAP, fields: Array.from({ length: 17 }, (_, index) => ({ name: `f${index}`, status: "null" })) }],
  ];
  for (const [name, candidate] of cases) assert.equal(parseWebExtractRecap(candidate), undefined, name);
});
