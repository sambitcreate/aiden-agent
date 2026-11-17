import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { compileAum } from "./compile.js";
import type { AidenUiNodeV1 } from "./types.js";
import { validateCompiledAum, type CompiledAumParts } from "./validate.js";

const FIXTURES = new URL("./fixtures/markup/", import.meta.url);
const fixtureNames = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".aum") && file !== "broken.aum")
  .map((file) => file.slice(0, -4));

/** A compiled page, as an imported file carries it. */
function page(markup: string, options: { artifactActions?: boolean } = { artifactActions: true }): CompiledAumParts {
  const compiled = compileAum(markup, options);
  assert.deepEqual(compiled.diagnostics, [], markup);
  assert.ok(compiled.tree);
  return {
    tree: compiled.tree,
    ...(compiled.dataJson !== undefined ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
  };
}

function refused(parts: CompiledAumParts, pattern: RegExp, options = { artifactActions: true }): void {
  const result = validateCompiledAum(parts, options);
  assert.equal(result.ok, false, `expected ${JSON.stringify(parts.tree)} to be refused`);
  if (!result.ok) assert.match(result.error, pattern);
}

/** A <Visual> holding one hand-written child, the way a tampered file would. */
function withChild(child: unknown, state?: Record<string, unknown>): CompiledAumParts {
  return { tree: { t: "Visual", k: "0", c: [child] }, ...(state ? { state } : {}) };
}

const lit = (v: unknown) => ({ op: "lit", v });
const text = (s: string) => ({ t: "#text", k: "", s });

test("everything the compiler builds passes unchanged", () => {
  assert.ok(fixtureNames.length >= 7);
  for (const name of fixtureNames) {
    const parts = page(readFileSync(new URL(`${name}.aum`, FIXTURES), "utf8"));
    const result = validateCompiledAum(parts, { artifactActions: true });
    assert.ok(result.ok, `${name}: ${result.ok ? "" : result.error}`);
    assert.deepEqual(result.tree, parts.tree, name);
    assert.deepEqual(result.state, parts.state, name);
    if (parts.dataJson === undefined) assert.equal(result.dataJson, undefined, name);
    else assert.deepEqual(JSON.parse(result.dataJson!), JSON.parse(parts.dataJson as string), name);
  }
});

test("a page made with run() and compose() passes only where artifact actions are allowed", () => {
  const parts = page('<Visual><Button action={run("merge", 12)}>Merge</Button><Button action={compose("Hi")}>Draft</Button></Visual>');
  assert.ok(validateCompiledAum(parts, { artifactActions: true }).ok);
  refused(parts, /workspace artifacts/u, { artifactActions: false });
});

test("open links in a literal must be https", () => {
  for (const url of ["javascript:alert(1)", "http://example.com", "file:///etc/passwd", " https://example.com"]) {
    refused(withChild({ t: "Button", k: "", p: { action: { act: "open", url: lit(url) } }, c: [text("Go")] }), /https/u);
  }
  assert.ok(
    validateCompiledAum(withChild({ t: "Button", k: "", p: { action: { act: "open", url: lit("https://example.com") } }, c: [text("Go")] }))
      .ok,
  );
});

test("an action goes only where the catalog takes an action, and only a real one", () => {
  refused(withChild({ t: "Text", k: "", p: { tone: { act: "send", text: lit("x") } }, c: [text("Hi")] }), /action where a value belongs/u);
  refused(withChild({ t: "Button", k: "", p: { action: lit("send") }, c: [text("Go")] }), /action that isn’t one/u);
  refused(withChild({ t: "Button", k: "", p: { action: { act: "send", op: "lit", text: lit("x") } }, c: [text("Go")] }), /action that isn’t one/u);
  refused(withChild({ t: "Button", k: "", p: { action: { act: "exec", text: lit("x") } }, c: [text("Go")] }), /action Aiden doesn’t have/u);
});

test("setState and bound controls need a key the page declares", () => {
  const set = { t: "Button", k: "", p: { action: { act: "set", key: "tab", value: lit("b") } }, c: [text("B")] };
  refused(withChild(set), /doesn’t declare/u);
  assert.ok(validateCompiledAum(withChild(set, { tab: "a" })).ok);
  const bound = { t: "Switch", k: "", p: { bind: lit("on"), label: lit("On") } };
  refused(withChild(bound), /doesn’t declare/u);
  assert.ok(validateCompiledAum(withChild(bound, { on: false })).ok);
});

test("run() needs a valid action name and at most the compiler's number of values", () => {
  const run = (name: unknown, a: unknown) => withChild({ t: "Button", k: "", p: { action: { act: "run", name, a } }, c: [text("Go")] });
  refused(run("rm -rf", []), /name isn’t valid/u);
  refused(run("9lives", []), /name isn’t valid/u);
  refused(run("x".repeat(41), []), /name isn’t valid/u);
  refused(run("merge", Array.from({ length: 9 }, (_, index) => lit(index))), /more than 8 values/u);
  refused(run("merge", "12"), /more than 8 values, or none in a list/u);
  assert.ok(validateCompiledAum(run("merge", Array.from({ length: 8 }, (_, index) => lit(index))), { artifactActions: true }).ok);
});

test("text-only components hold text and inline elements, never blocks", () => {
  refused(withChild({ t: "Text", k: "", c: [{ t: "Card", k: "", c: [text("x")] }] }), /<Card> cannot go inside <Text>/u);
  refused(withChild({ t: "Button", k: "", p: { action: { act: "copy", text: lit("x") } }, c: [{ t: "Stack", k: "" }] }), /cannot go inside/u);
  refused(withChild({ t: "Separator", k: "", c: [text("x")] }), /cannot hold anything/u);
  const inline = withChild({ t: "Text", k: "", c: [text("Press "), { t: "Kbd", k: "", c: [text("⌘K")] }] });
  assert.ok(validateCompiledAum(inline).ok);
});

test("enum choices and icons must exist", () => {
  refused(withChild({ t: "Text", k: "", p: { tone: lit("neon") }, c: [text("x")] }), /isn’t one of its options/u);
  refused(withChild({ t: "Icon", k: "", p: { name: lit("not-an-icon") } }), /icon Aiden doesn’t have/u);
  refused(withChild({ t: "Spacer", k: "", p: { size: lit("big") } }), /expects a number/u);
  refused(withChild({ t: "Disclosure", k: "", p: { title: lit("T"), open: lit("yes") }, c: [text("x")] }), /true or false/u);
});

test("required props must be present", () => {
  refused(withChild({ t: "Stat", k: "", p: { label: lit("Revenue") } }), /missing a setting/u);
  refused(withChild({ t: "Button", k: "", c: [text("Go")] }), /missing a setting/u);
});

test("expressions use only the grammar the compiler emits", () => {
  const withExpr = (e: unknown) => withChild({ t: "Text", k: "", c: [{ t: "#expr", k: "", e }] });
  refused(withExpr({ op: "eval", src: "1" }), /doesn’t understand/u);
  refused(withExpr({ op: "call", fn: "len", a: "x" }), /no argument list/u);
  refused(withExpr({ op: "call", fn: "fetch", a: [] }), /function Aiden doesn’t have/u);
  refused(withExpr({ op: "bin", o: "**", l: lit(1), r: lit(2) }), /operator/u);
  refused(withExpr({ op: "var", name: "a-b" }), /name that isn’t valid/u);
  refused(withExpr({ op: "lit", v: { nested: true } }), /literal/u);
  refused(withExpr({ op: "json", v: { token: "x" } }), /reserved key/u);
});

test("data must be JSON naming valid bindings", () => {
  const base = withChild({ t: "Text", k: "", c: [text("x")] });
  refused({ ...base, dataJson: "{not json" }, /isn’t valid JSON/u);
  refused({ ...base, dataJson: "[1,2]" }, /object of named values/u);
  refused({ ...base, dataJson: 12 }, /isn’t JSON text/u);
  refused({ ...base, dataJson: '{"bad-name":1}' }, /name that isn’t valid/u);
  const ok = validateCompiledAum({ ...base, dataJson: '{"rows":[1,2]}' });
  assert.ok(ok.ok);
  assert.equal(ok.dataJson, '{"rows":[1,2]}');
});

test("unknown keys on nodes, props and actions are dropped, not kept", () => {
  const result = validateCompiledAum({
    tree: {
      t: "Visual",
      k: "anything",
      approval: "yes",
      c: [
        {
          t: "Button",
          k: "x",
          onClick: "steal()",
          p: { action: { act: "send", text: { op: "lit", v: "Hi", extra: 1 }, script: "x" } },
          c: [{ t: "#text", k: "y", s: "Go", html: "<b>" }],
        },
      ],
    },
  });
  assert.ok(result.ok);
  const expected: AidenUiNodeV1 = {
    t: "Visual",
    k: "0",
    c: [{ t: "Button", k: "0.0", p: { action: { act: "send", text: { op: "lit", v: "Hi" } } }, c: [{ t: "#text", k: "0.0.0", s: "Go" }] }],
  };
  assert.deepEqual(result.tree, expected);
});

test("components outside the catalog, <Data>, nested <Visual> and an empty page are refused", () => {
  refused(withChild({ t: "Script", k: "" }), /isn’t one of Aiden’s components/u);
  refused(withChild({ t: "Data", k: "", p: { name: lit("x") }, c: [text("{}")] }), /isn’t one of Aiden’s components/u);
  refused(withChild({ t: "Visual", k: "", c: [text("x")] }), /isn’t one of Aiden’s components/u);
  refused({ tree: { t: "Stack", k: "0", c: [text("x")] } }, /must start with <Visual>/u);
  refused({ tree: { t: "Visual", k: "0" } }, /empty/u);
  refused({ tree: { t: "Visual", k: "0", p: { state: { op: "json", v: {} } }, c: [text("x")] } }, /setting Aiden doesn’t know/u);
});
