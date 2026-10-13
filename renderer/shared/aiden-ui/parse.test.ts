import assert from "node:assert/strict";
import test from "node:test";
import { parseAum, type AumElement, type AumNode } from "./parse.js";
import { parseExpression } from "./expression.js";

const SPEC_EXAMPLE = `<Visual title="Q3 revenue by region" state={{metric: "revenue"}}>
  <Row gap={3}>
    <Stat label="Total" value={$data.totals[$metric]} format="currency" trend={+0.12} />
    <Stat label="Regions" value={4} />
  </Row>
  <Segmented bind="metric" options={[{value:"revenue",label:"Revenue"},{value:"margin",label:"Margin"}]} />
  <Chart kind="bar" data={$data.byRegion} x="region" y={$metric} />
  <Button variant="accent" action={sendPrompt("Break down EMEA " + $metric + " by month")}>Drill into EMEA</Button>
  <Data name="data">{ "totals": {"revenue": 6930, "margin": 0.31}, "byRegion": [] }</Data>
</Visual>`;

function elements(nodes: readonly AumNode[]): AumElement[] {
  return nodes.filter((node): node is AumElement => node.kind === "element");
}

function names(nodes: readonly AumNode[]): string[] {
  return elements(nodes).flatMap((node) => [node.name, ...names(node.children)]);
}

test("the spec example parses into one Visual with its components in order", () => {
  const { nodes, diagnostics } = parseAum(SPEC_EXAMPLE);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(names(nodes), ["Visual", "Row", "Stat", "Stat", "Segmented", "Chart", "Button", "Data"]);
  const visual = elements(nodes)[0]!;
  assert.deepEqual(visual.attrs.map((attr) => attr.name), ["title", "state"]);
  const data = elements(visual.children).find((node) => node.name === "Data")!;
  assert.deepEqual(data.children, [{ kind: "text", text: `{ "totals": {"revenue": 6930, "margin": 0.31}, "byRegion": [] }` }]);
  const button = elements(visual.children).find((node) => node.name === "Button")!;
  assert.deepEqual(button.children, [{ kind: "text", text: "Drill into EMEA" }]);
});

test("every streaming prefix parses without throwing and only ever grows", () => {
  let previous: string[] = [];
  for (let end = 0; end <= SPEC_EXAMPLE.length; end += 7) {
    const prefix = SPEC_EXAMPLE.slice(0, end);
    const { nodes } = parseAum(prefix);
    const current = names(nodes);
    assert.deepEqual(current.slice(0, previous.length), previous, `prefix ${end}`);
    previous = current;
  }
});

test("a cut inside an attribute expression drops only that attribute", () => {
  const { nodes, diagnostics } = parseAum(`<Visual title="T"><Stat label="Total" value={$data.totals[`);
  const stat = elements(elements(nodes)[0]!.children)[0]!;
  assert.equal(stat.name, "Stat");
  assert.deepEqual(stat.attrs.map((attr) => attr.name), ["label"]);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "recovered"));
});

test("open elements are auto-closed at the end and stray closers are reported", () => {
  const cut = parseAum(`<Visual><Row><Text>Hello`);
  assert.deepEqual(names(cut.nodes), ["Visual", "Row", "Text"]);
  assert.equal(elements(cut.nodes)[0]!.closed, false);
  const stray = parseAum(`<Visual><Text>Hi</Text></Row></Visual>`);
  assert.deepEqual(names(stray.nodes), ["Visual", "Text"]);
  assert.ok(stray.diagnostics.some((diagnostic) => diagnostic.code === "recovered" && diagnostic.at === "Row"));
});

test("a mismatched closer closes back to its matching element", () => {
  const { nodes } = parseAum(`<Visual><Row><Text>a</Row><Text>b</Text></Visual>`);
  const visual = elements(nodes)[0]!;
  assert.deepEqual(elements(visual.children).map((node) => node.name), ["Row", "Text"]);
});

test("comments are skipped, a lone '<' stays text, and braces in strings do not end an expression", () => {
  const { nodes } = parseAum(`<Visual><!-- note --><Text>a < b</Text><Text>{"}" + $x}</Text></Visual>`);
  const [first, second] = elements(elements(nodes)[0]!.children);
  assert.deepEqual(first!.children, [{ kind: "text", text: "a < b" }]);
  assert.deepEqual(second!.children, [{ kind: "expr", source: `"}" + $x` }]);
});

test("attribute forms: quoted, single-quoted, expression, and bare", () => {
  const { nodes } = parseAum(`<Chart kind='bar' height={200} stacked x="region" />`);
  const chart = elements(nodes)[0]!;
  assert.deepEqual(chart.attrs, [
    { name: "kind", value: { kind: "string", text: "bar" } },
    { name: "height", value: { kind: "expr", source: "200" } },
    { name: "stacked", value: { kind: "bare" } },
    { name: "x", value: { kind: "string", text: "region" } },
  ]);
  assert.equal(chart.closed, true);
});

test("expressions compile to a data AST", () => {
  assert.deepEqual(parseExpression("$data.totals[$metric]").expr, {
    op: "get",
    of: { op: "get", of: { op: "var", name: "data" }, key: { op: "lit", v: "totals" } },
    key: { op: "var", name: "metric" },
  });
  assert.deepEqual(parseExpression(`"A" + $x`).expr, {
    op: "bin", o: "+", l: { op: "lit", v: "A" }, r: { op: "var", name: "x" },
  });
  assert.deepEqual(parseExpression(`$m == "revenue" ? 1 : 2`).expr, {
    op: "if",
    test: { op: "bin", o: "==", l: { op: "var", name: "m" }, r: { op: "lit", v: "revenue" } },
    then: { op: "lit", v: 1 },
    else: { op: "lit", v: 2 },
  });
  assert.deepEqual(parseExpression(`fmt($v, "currency")`).expr, {
    op: "call", fn: "fmt", a: [{ op: "var", name: "v" }, { op: "lit", v: "currency" }],
  });
  assert.deepEqual(parseExpression(`{value:"a",label:"A"}`).expr, { op: "json", v: { value: "a", label: "A" } });
  assert.deepEqual(parseExpression(`[1, -2, +0.5]`).expr, { op: "json", v: [1, -2, 0.5] });
  assert.deepEqual(parseExpression(`!$a && ($b || $c)`).expr, {
    op: "bin",
    o: "&&",
    l: { op: "not", e: { op: "var", name: "a" } },
    r: { op: "bin", o: "||", l: { op: "var", name: "b" }, r: { op: "var", name: "c" } },
  });
  assert.deepEqual(parseExpression(`$rows[0].name`).expr, {
    op: "get",
    of: { op: "get", of: { op: "var", name: "rows" }, key: { op: "lit", v: 0 } },
    key: { op: "lit", v: "name" },
  });
});

test("actions are recognised at the top level only", () => {
  assert.deepEqual(parseExpression(`sendPrompt("Break down " + $m)`).action, {
    act: "send",
    text: { op: "bin", o: "+", l: { op: "lit", v: "Break down " }, r: { op: "var", name: "m" } },
  });
  assert.deepEqual(parseExpression(`setState("tab", "b")`).action, {
    act: "set", key: "tab", value: { op: "lit", v: "b" },
  });
  assert.deepEqual(parseExpression(`openUrl("https://example.com")`).action, {
    act: "open", url: { op: "lit", v: "https://example.com" },
  });
  assert.deepEqual(parseExpression(`copy($total)`).action, { act: "copy", text: { op: "var", name: "total" } });
  assert.ok(parseExpression(`setState($k, 1)`).error);
  assert.ok(parseExpression(`fmt(sendPrompt("x"))`).error);
});

test("unsupported syntax is an error, never a throw", () => {
  for (const source of ["eval(1)", "$a - 1", "$a = 1", "{value: $x}", "items.map(x => x)", "(", "$a ? 1", "`tpl`", ""]) {
    const parsed = parseExpression(source);
    assert.ok(parsed.error, source);
    assert.equal(parsed.expr, undefined, source);
  }
  // Prototype-ish names parse; the evaluator refuses to read them.
  assert.ok(parseExpression("$a.constructor").expr);
});
