import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluate, MAX_CONCAT_CHARS, truthy } from "./evaluate.js";
import type { AidenUiExprV1 } from "./types.js";

interface Vector {
  name: string;
  expr: AidenUiExprV1;
  expect?: unknown;
  expectUndefined?: boolean;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/expressions.json", import.meta.url), "utf8"),
) as { locale: string; vars: Record<string, unknown>; cases: Vector[] };

test("the shared expression vectors evaluate identically", () => {
  assert.ok(fixture.cases.length >= 30);
  for (const vector of fixture.cases) {
    const value = evaluate(vector.expr, { vars: fixture.vars, locale: fixture.locale });
    if (vector.expectUndefined) assert.equal(value, undefined, vector.name);
    else assert.deepEqual(value, vector.expect, vector.name);
  }
});

test("evaluating never pollutes prototypes or mutates bound data", () => {
  const vars = JSON.parse(JSON.stringify(fixture.vars)) as Record<string, unknown>;
  const before = JSON.stringify(vars);
  evaluate(
    { op: "call", fn: "sort", a: [{ op: "var", name: "list" }, { op: "lit", v: "x" }, { op: "lit", v: "desc" }] },
    { vars },
  );
  assert.equal(JSON.stringify(vars), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a step budget stops runaway evaluation and returns nothing", () => {
  let expr: AidenUiExprV1 = { op: "lit", v: 1 };
  for (let index = 0; index < 400; index += 1) expr = { op: "bin", o: "+", l: expr, r: { op: "lit", v: 1 } };
  assert.equal(evaluate(expr, { vars: {}, budget: { steps: 100 } }), undefined);
  assert.equal(evaluate(expr, { vars: {} }), 401);
});

test("filter and sort cap their input at 10,000 items", () => {
  const rows = Array.from({ length: 12_000 }, (_, index) => ({ tag: "a", index }));
  const filtered = evaluate(
    { op: "call", fn: "filter", a: [{ op: "var", name: "rows" }, { op: "lit", v: "tag" }, { op: "lit", v: "a" }] },
    { vars: { rows }, budget: { steps: 1_000_000 } },
  );
  assert.equal(Array.isArray(filtered) && filtered.length, 10_000);
});

test("string concatenation is capped so repeated joins cannot balloon memory", () => {
  let expr: AidenUiExprV1 = { op: "var", name: "s" };
  for (let index = 0; index < 40; index += 1) expr = { op: "bin", o: "+", l: expr, r: { op: "var", name: "s" } };
  const value = evaluate(expr, { vars: { s: "x".repeat(60_000) } });
  assert.equal(typeof value === "string" && value.length, MAX_CONCAT_CHARS);
});

test("truthiness follows the documented rules", () => {
  for (const value of [undefined, null, false, 0, Number.NaN, ""]) assert.equal(truthy(value), false);
  for (const value of [true, 1, "a", [], {}]) assert.equal(truthy(value), true);
});
