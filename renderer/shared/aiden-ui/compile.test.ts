import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { AIDEN_UI_CATALOG, AIDEN_UI_ICONS } from "./catalog.js";
import { compileAum } from "./compile.js";
import { fallbackTextFor } from "./fallback-text.js";
import { parseAum } from "./parse.js";
import { AIDEN_UI_LIMITS, type AidenUiNodeV1 } from "./types.js";
import { isWireSafeKey, parseChatUiVisualV1 } from "./visual.js";

const FIXTURES = new URL("./fixtures/markup/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`${name}.aum`, FIXTURES), "utf8");
const fixtureNames = readdirSync(FIXTURES).filter((file) => file.endsWith(".aum")).map((file) => file.slice(0, -4));

function names(node: AidenUiNodeV1 | undefined): string[] {
  if (!node) return [];
  return [node.t, ...(node.c ?? []).flatMap(names)];
}

function asVisual(compiled: ReturnType<typeof compileAum>) {
  assert.ok(compiled.tree);
  return parseChatUiVisualV1({
    version: 1,
    kind: "ui",
    id: "ui-1",
    title: compiled.title ?? "Visual",
    catalogVersion: 1,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
    fallbackText: compiled.fallbackText,
  });
}

test("every well-formed fixture compiles cleanly into a storable visual", () => {
  assert.ok(fixtureNames.length >= 8);
  for (const name of fixtureNames.filter((entry) => entry !== "broken")) {
    const compiled = compileAum(fixture(name));
    assert.deepEqual(compiled.diagnostics, [], name);
    assert.ok(asVisual(compiled), name);
    assert.ok(compiled.fallbackText.length > 0, name);
  }
});

test("the dashboard keeps its structure, data, state, and a readable fallback", () => {
  const compiled = compileAum(fixture("dashboard"));
  assert.equal(compiled.title, "Q3 revenue by region");
  assert.deepEqual(compiled.state, { metric: "revenue" });
  assert.deepEqual(names(compiled.tree), [
    "Visual", "Row", "Stat", "Stat", "Segmented", "Chart", "Table", "Button", "#text",
  ]);
  assert.equal(JSON.parse(compiled.dataJson!).data.totals.revenue, 6930);
  assert.match(compiled.fallbackText, /Total: \$6,930\.00/u);
  assert.match(compiled.fallbackText, /\| Region \| Revenue \| Margin \|/u);
  assert.match(compiled.fallbackText, /\| AMER \| \$3,100\.00 \| 35% \|/u);
  assert.match(compiled.fallbackText, /\[Drill into EMEA\]/u);
  // Keys are stable index paths.
  assert.equal(compiled.tree!.c![0]!.k, "0.0");
  assert.equal(compiled.tree!.c![0]!.c![1]!.k, "0.0.1");
});

test("HTML-ish and React-ish markup is reported and its content kept", () => {
  const compiled = compileAum(fixture("broken"));
  const codes = (code: string) => compiled.diagnostics.filter((diagnostic) => diagnostic.code === code);
  assert.ok(codes("unknown_element").some((diagnostic) => diagnostic.at === "div"));
  assert.ok(codes("unknown_element").some((diagnostic) => diagnostic.at === "p"));
  assert.ok(codes("unknown_prop").some((diagnostic) => diagnostic.message.includes("onClick")));
  assert.ok(codes("invalid_literal").some((diagnostic) => diagnostic.message.includes("action")));
  assert.ok(codes("invalid_literal").some((diagnostic) => diagnostic.message.includes("radar")));
  assert.ok(codes("invalid_expression").length >= 1);
  assert.ok(codes("data_invalid").length === 1);
  // The heading inside the dropped <div> and the <p> text survive.
  assert.ok(names(compiled.tree).includes("Heading"));
  assert.match(compiled.fallbackText, /Velocity/u);
  assert.match(compiled.fallbackText, /Points per sprint/u);
  assert.ok(asVisual(compiled));
});

test("markup without a Visual root is wrapped; empty markup has no tree", () => {
  const wrapped = compileAum(`<Stat label="A" value={1} /><Text>Hi</Text>`);
  assert.equal(wrapped.tree?.t, "Visual");
  assert.deepEqual(names(wrapped.tree), ["Visual", "Stat", "Text", "#text"]);
  assert.ok(wrapped.diagnostics.some((diagnostic) => diagnostic.code === "recovered"));
  const loose = compileAum(`Just a sentence.`);
  assert.deepEqual(names(loose.tree), ["Visual", "Text", "#text"]);
  assert.equal(compileAum("").tree, undefined);
  assert.equal(compileAum("   \n ").tree, undefined);
});

test("binding to an undeclared state key is reported and the binding dropped", () => {
  const compiled = compileAum(`<Visual state={{tab: "a"}}><Switch bind="ghost" label="Ghost" /><Switch bind="tab" label="Tab" /></Visual>`);
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.message.includes("ghost")));
  const [ghost, tab] = compiled.tree!.c!;
  assert.equal(ghost!.p?.bind, undefined);
  assert.deepEqual(tab!.p?.bind, { op: "lit", v: "tab" });
});

test("props are coerced by kind, and enums and icons are checked", () => {
  const compiled = compileAum(
    `<Visual><Chart kind="bar" data={[]} height="200" stacked /><Badge color="purple" icon="brain">x</Badge><Icon name="rocket" /></Visual>`,
  );
  const [chart, badge, icon] = compiled.tree!.c!;
  assert.deepEqual(chart!.p?.height, { op: "lit", v: 200 });
  assert.deepEqual(chart!.p?.stacked, { op: "lit", v: true });
  assert.equal(badge!.p?.color, undefined);
  assert.equal(badge!.p?.icon, undefined);
  assert.deepEqual(icon!.p?.name, { op: "lit", v: "rocket" });
  assert.equal(compiled.diagnostics.filter((diagnostic) => diagnostic.code === "invalid_literal").length, 2);
});

test("literal props carrying wire-unsafe keys are dropped", () => {
  const compiled = compileAum(`<Visual><KeyValue items={[{label: "a", prompt: "x"}]} /></Visual>`);
  assert.equal(compiled.tree!.c![0]!.p?.items, undefined);
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.code === "invalid_literal"));
});

test("inherited Object.prototype names are never catalog components or props", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const compiled = compileAum(`<Visual><Text>Kept</Text><${name} /></Visual>`);
    assert.ok(
      compiled.diagnostics.some((diagnostic) => diagnostic.code === "unknown_element" && diagnostic.at === name),
      `${name} is reported as an unknown element`,
    );
    assert.equal(names(compiled.tree).includes(name), false, `${name} is not a node`);
    assert.ok(names(compiled.tree).includes("Text"), `${name} keeps the sibling content`);
  }
  // A tag the parser reads as text never becomes a node, whatever its name.
  const underscored = compileAum("<Visual><__proto__ /><Text>Kept</Text></Visual>");
  assert.equal(names(underscored.tree).includes("__proto__"), false);
  const prop = compileAum(`<Visual><Text toString="x">Kept</Text></Visual>`);
  assert.ok(prop.diagnostics.some((diagnostic) => diagnostic.code === "unknown_prop" && diagnostic.message.includes("toString")));
  assert.equal(Object.keys(prop.tree!.c![0]!.p ?? {}).includes("toString"), false);
});

test("node and depth caps truncate with a limit diagnostic", () => {
  const many = `<Visual>${"<Separator />".repeat(AIDEN_UI_LIMITS.nodes + 500)}</Visual>`;
  const wide = compileAum(many);
  assert.ok(names(wide.tree).length <= AIDEN_UI_LIMITS.nodes);
  assert.ok(wide.diagnostics.some((diagnostic) => diagnostic.code === "limit"));
  const deep = compileAum(`<Visual>${"<Stack>".repeat(40)}<Text>deep</Text>${"</Stack>".repeat(40)}</Visual>`);
  assert.ok(deep.diagnostics.some((diagnostic) => diagnostic.code === "limit"));
  assert.ok(asVisual(deep));
});

test("oversized data is dropped instead of stored", () => {
  const big = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, index) => ({ name: `row ${index}`, value: index })) });
  const compiled = compileAum(`<Visual><Table rows={$data.rows} /><Data name="data">${big}</Data></Visual>`);
  assert.equal(compiled.dataJson, undefined);
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.code === "limit"));
});

test("a streaming prefix compiles to a partial tree without throwing", () => {
  const source = fixture("filter");
  for (let end = 0; end <= source.length; end += 11) {
    const compiled = compileAum(source.slice(0, end), { draft: true });
    if (compiled.tree) assert.ok(asVisual(compiled), `prefix ${end}`);
  }
});

test("the catalog speaks only wire-safe prop names and offers no brain icons", () => {
  for (const [component, entry] of Object.entries(AIDEN_UI_CATALOG)) {
    for (const prop of Object.keys(entry.props)) assert.ok(isWireSafeKey(prop), `${component}.${prop}`);
  }
  assert.equal(AIDEN_UI_ICONS.some((icon) => icon.startsWith("brain")), false);
});

test("hostile nesting never throws: deep unknown tags, deep catalog tags in text, deep data", () => {
  const cases = [
    `<Visual>${"<div>".repeat(5000)}hi</Visual>`,
    `<Visual><Text>${"<Stack>".repeat(5000)}x</Text></Visual>`,
    `<Visual><Data name="d">${"[".repeat(100_000)}${"]".repeat(100_000)}</Data><Text>{$d}</Text></Visual>`,
    `<Visual>${"<Stack>".repeat(20_000)}</Visual>`,
  ];
  for (const markup of cases) {
    for (const draft of [false, true]) {
      const compiled = compileAum(markup, { draft });
      if (compiled.tree) assert.ok(asVisual(compiled), markup.slice(0, 40));
    }
  }
  const deep = compileAum(cases[0]!);
  assert.ok(deep.diagnostics.some((diagnostic) => diagnostic.code === "limit"));
});

test("reserved data names are refused with a diagnostic", () => {
  const compiled = compileAum(`<Visual><Data name="__proto__">{"a":1}</Data><Text>x</Text></Visual>`);
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.code === "data_invalid"));
  assert.equal(compiled.dataJson, undefined);
});

test("parser recovery diagnostics are bounded", () => {
  const { diagnostics } = parseAum(`<Visual ${"!".repeat(50_000)}></Visual>`);
  assert.ok(diagnostics.length <= 200);
});

/** Legal fan-out: 100 iterations × 20 checklists of 1,000 items each (still inside every limit). */
const FAN_OUT_MARKUP = `<Visual><Data name="items">${JSON.stringify(
  Array.from({ length: 1000 }, () => ({ label: "task", done: false })),
)}</Data><Data name="repeat">${JSON.stringify(Array.from({ length: 100 }, () => 0))}</Data><Each in={$repeat}>${"<Checklist items={$items} />".repeat(20)}</Each></Visual>`;

test("a fan-out visual compiles to a capped fallback", () => {
  const compiled = compileAum(FAN_OUT_MARKUP);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.fallbackText.length <= AIDEN_UI_LIMITS.fallbackChars);
  assert.ok(compiled.fallbackText.endsWith("…"));
  assert.ok(compiled.fallbackText.startsWith("- [ ] task\n- [ ] task"));
});

test("the fallback stops expanding once it is full, so the work tracks the cap, not the expansion", () => {
  const compiled = compileAum(FAN_OUT_MARKUP);
  assert.ok(compiled.tree);
  // Count every field read on an item: each read is one step of expansion.
  let reads = 0;
  const countedItem = () => {
    const item = {};
    Object.defineProperty(item, "label", { enumerable: true, get: () => ((reads += 1), "task") });
    Object.defineProperty(item, "done", { enumerable: true, get: () => ((reads += 1), false) });
    return item;
  };
  const items = Array.from({ length: 1000 }, countedItem);
  const text = fallbackTextFor(compiled.tree, { vars: { items, repeat: Array.from({ length: 100 }, () => 0) } });
  assert.equal(text, compiled.fallbackText);
  // Each item adds at least a few characters, so reads stay within a small multiple of the cap.
  assert.ok(reads <= 2 * AIDEN_UI_LIMITS.fallbackChars, `read ${reads} item fields`);
});

test("run() and compose() compile only for workspace artifacts", () => {
  const markup = `<Visual title="PRs"><Each in={$pulls} as="pr"><Button action={run("merge", $pr.number, "squash")}>Merge</Button></Each><Button action={compose("Summarize these")}>Ask</Button></Visual>`;
  const inline = compileAum(markup);
  const buttons = (tree: AidenUiNodeV1 | undefined): AidenUiNodeV1[] =>
    tree ? [...(tree.t === "Button" ? [tree] : []), ...(tree.c ?? []).flatMap(buttons)] : [];
  assert.ok(buttons(inline.tree).every((button) => button.p?.action === undefined));
  assert.ok(inline.diagnostics.some((diagnostic) => /works only in workspace artifacts/u.test(diagnostic.message)));

  const artifact = compileAum(markup, { artifactActions: true });
  assert.deepEqual(artifact.diagnostics, []);
  const [merge, ask] = buttons(artifact.tree);
  assert.deepEqual(merge!.p?.action, {
    act: "run",
    name: "merge",
    a: [
      { op: "get", of: { op: "var", name: "pr" }, key: { op: "lit", v: "number" } },
      { op: "lit", v: "squash" },
    ],
  });
  assert.deepEqual(ask!.p?.action, { act: "compose", text: { op: "lit", v: "Summarize these" } });
  assert.ok(asVisual(artifact), "run and compose trees stay storable and wire-safe");

  const unnamed = compileAum(`<Visual title="X"><Button action={run($name)}>Go</Button></Visual>`, { artifactActions: true });
  assert.ok(unnamed.diagnostics.some((diagnostic) => /action name first/u.test(diagnostic.message)));
});

test("a text-only reader gets each chart's data as a table, in the chart's own columns and format", () => {
  const markup = `<Visual title="Revenue"><Data name="months">[{"month":"Jan","revenue":1200,"cost":800},{"month":"Feb","revenue":1500,"cost":900}]</Data><Chart kind="line" data={$months} x="month" series={[{"key":"revenue","label":"Revenue"},"cost"]} format="currency" label="By month" /><Checklist items={[{"label":"Ship","done":true},{"label":"Review"}]} /></Visual>`;
  const text = compileAum(markup, { fallback: { chartTables: true } }).fallbackText;
  assert.match(text, /By month \(line chart, 2 points\)/u);
  assert.match(text, /\| month \| Revenue \| cost \|/u);
  assert.match(text, /\| Jan \| \$1,200\.00 \| \$800\.00 \|/u);
  assert.match(text, /\| Feb \| \$1,500\.00 \| \$900\.00 \|/u);
  assert.match(text, /- \[x\] Ship\n- \[ \] Review/u);
  // Without the option, the chart stays one summary line (memory and desktop text).
  assert.doesNotMatch(compileAum(markup).fallbackText, /\| Jan \|/u);

  const implicit = compileAum(`<Visual><Chart kind="bar" data={[{"region":"EMEA","sales":3,"note":7}]} /></Visual>`);
  assert.ok(implicit.tree);
  assert.match(fallbackTextFor(implicit.tree, { vars: {} }, { chartTables: true }), /\| region \| sales \|\n\| --- \| --- \|\n\| EMEA \| 3 \|/u);
});

test("a text-only reader also gets sparkline values, heatmap cells and every numeric column of an unlabelled scatter", () => {
  const markup = `<Visual title="T"><Data name="hm">[{"r":"Mon","c":"9am","n":4},{"r":"Tue","c":"10am","n":7}]</Data><Sparkline values={[3, 5, 1200]} label="Signups" /><Heatmap rows={$hm} x="c" y="r" value="n" label="Load" /><Chart kind="scatter" data={[{"height":170,"weight":65,"age":30},{"height":182,"weight":80,"age":41}]} label="People" /></Visual>`;
  const text = compileAum(markup, { fallback: { chartTables: true } }).fallbackText;
  assert.match(text, /Signups \(sparkline\): 3, 5, 1,200/u);
  // Heatmap cells read as the drawn heatmap names them, by row and column, never by field name.
  assert.match(text, /Load \(heatmap, 2 cells\)\nMon · 9am: 4\nTue · 10am: 7/u);
  assert.doesNotMatch(text, /\br\b|\bn\b/u);
  assert.match(text, /\| height \| weight \| age \|\n\| --- \| --- \| --- \|\n\| 170 \| 65 \| 30 \|/u);
  // Without the option they stay one summary line each.
  const plain = compileAum(markup).fallbackText;
  assert.doesNotMatch(plain, /1,200|Mon|170/u);
});

test("a long sparkline keeps where it started and its latest values, with the count", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  const text = compileAum(`<Visual title="T"><Sparkline values={${JSON.stringify(values)}} label="Load" /></Visual>`, { fallback: { chartTables: true } }).fallbackText;
  const line = text.split("\n").find((entry) => entry.startsWith("Load"));
  assert.ok(line, text);
  const listed = line.slice(line.indexOf(": ") + 2).split(", ");
  assert.equal(listed[0], "1");
  assert.equal(listed[1], "…");
  assert.deepEqual(listed.slice(2).map(Number), values.slice(-30));
  assert.match(line, /100 values/u);
});

test("a sparkline's \"…\" always stands for two or more values left out", () => {
  const line = (count: number) => {
    const values = Array.from({ length: count }, (_, index) => index + 1);
    const text = compileAum(`<Visual title="T"><Sparkline values={${JSON.stringify(values)}} label="Load" /></Visual>`, { fallback: { chartTables: true } }).fallbackText;
    return text.split("\n").find((entry) => entry.startsWith("Load"))!;
  };
  // Leaving out one value would save nothing, so 31 and 32 values are all listed.
  for (const count of [31, 32]) {
    const listed = line(count).slice(line(count).indexOf(": ") + 2).split(", ").map(Number);
    assert.deepEqual(listed, Array.from({ length: count }, (_, index) => index + 1));
  }
  const listed = line(33).slice(line(33).indexOf(": ") + 2).split(", ");
  assert.equal(listed[1], "…");
  assert.equal(33 - (listed.length - 1), 2, "the … stands for the two values not listed");
  assert.match(line(33), /33 values/u);
});

test("chart, sparkline and heatmap labels reach a text reader on one line, without control or direction characters", () => {
  const compiled = compileAum(`<Visual title="T"><Chart kind="bar" data={$rows} label={$label} /><Sparkline values={[1, 2]} label={$label} /><Heatmap rows={[{"x":"a","y":"b","value":1}]} label={$label} /></Visual>`);
  assert.ok(compiled.tree);
  const label = "Sales\u202egnp.exe\nnext\u0007line\u2066";
  const text = fallbackTextFor(compiled.tree, { vars: { rows: [{ name: "A", n: 1 }], label } }, { chartTables: true, plainTables: true });
  /* eslint-disable no-control-regex -- matching control characters is the point */
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u, JSON.stringify(text));
  /* eslint-enable no-control-regex */
  const lines = text.split("\n");
  assert.ok(lines.includes("Salesgnp.exe next line (bar chart, 1 points)"), text);
  assert.ok(lines.includes("Salesgnp.exe next line (sparkline): 1, 2"), text);
  assert.ok(lines.includes("Salesgnp.exe next line (heatmap, 1 cells)"), text);
});

test("a plain table row of many columns is clipped so it stays readable", () => {
  const compiled = compileAum(`<Visual title="T"><Data name="rows">[]</Data><Table rows={$rows} /></Visual>`);
  assert.ok(compiled.tree);
  const row = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`column${index}`, "v".repeat(40)]));
  const text = fallbackTextFor(compiled.tree, { vars: { rows: [row, { column0: "short" }] } }, { plainTables: true });
  const [wide, narrow] = text.split("\n");
  assert.equal([...wide!].length, 400);
  assert.ok(wide!.startsWith(`column0: ${"v".repeat(40)} · column1:`), wide);
  assert.ok(wide!.endsWith("…"));
  assert.ok(narrow!.startsWith("column0: short · column1: —"));
});

test("a reader that shows text as-is in a proportional font gets each table row as labelled pairs, not pipes or padded columns", () => {
  const markup = `<Visual title="T"><Chart kind="pie" data={[{"name":"Alpha","share":0.4},{"name":"B","share":0.6}]} format="percent" label="Split" /><Table columns={[{"key":"plan","label":"Plan"},{"key":"seats","label":"Seats"},{"key":"note","label":"Note"}]} rows={[{"plan":"Team | annual","seats":12},{"plan":"Solo","seats":1,"note":"Ends\\nsoon"}]} /></Visual>`;
  const text = compileAum(markup, { fallback: { chartTables: true, plainTables: true } }).fallbackText;
  assert.doesNotMatch(text, /---/u);
  // Every row stands on its own, so nothing depends on the reader's font lining columns up.
  assert.ok(text.includes(["name: Alpha · share: 40%", "name: B · share: 60%"].join("\n")), text);
  // Column labels name the values, a cell's own pipe is kept as written, and an empty cell says so.
  assert.ok(text.includes(["Plan: Team | annual · Seats: 12 · Note: —", "Plan: Solo · Seats: 1 · Note: Ends soon"].join("\n")), text);
  assert.doesNotMatch(text, / {2}/u, "no padding runs");
});

test("table cells never carry control or direction characters that could reorder or break a line", () => {
  const cell = "safe\u202Egnp.exe\u2066x\u0007y\u0000z";
  const compiled = compileAum(`<Visual title="T"><Data name="rows">[]</Data><Table rows={$rows} /></Visual>`);
  assert.ok(compiled.tree);
  for (const plainTables of [true, false]) {
    const text = fallbackTextFor(compiled.tree, { vars: { rows: [{ name: cell, n: 1 }] } }, { plainTables });
    /* eslint-disable no-control-regex -- matching control characters is the point */
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u, JSON.stringify(text));
    /* eslint-enable no-control-regex */
    assert.match(text, /safegnp\.exex y z/u);
  }
});

test("table cells drop characters drawn as nothing before they are clipped, keep emoji joiners, and never end inside a character", () => {
  const compiled = compileAum(`<Visual title="T"><Data name="rows">[]</Data><Table rows={$rows} /></Visual>`);
  assert.ok(compiled.tree);
  const loneSurrogate = /\p{Cs}/u;
  const rows = [
    // A zero-width space, word joiner, invisible separator, BOM and interlinear annotation marks vanish; a line separator reads as a space.
    { name: "pay\u200broll\u2060\u2063\ufeff\ufff9note\ufffb\u2028end", n: 1 },
    // A run of invisible characters does not use up the cell's length.
    { name: `${"\u200b".repeat(4_000)}visible`, n: 2 },
    // A person at a laptop keeps the joiner that draws it as one emoji.
    { name: "\u{1f469}\u200d\u{1f4bb} team", n: 3 },
  ];
  for (const plainTables of [true, false]) {
    const text = fallbackTextFor(compiled.tree, { vars: { rows } }, { plainTables });
    assert.doesNotMatch(text, /[\u200b\u2060-\u2064\ufeff\ufff9-\ufffb\u2028\u2029]/u, JSON.stringify(text));
    assert.match(text, /payrollnote end/u);
    assert.match(text, /visible/u);
    assert.match(text, /\u{1f469}\u200d\u{1f4bb} team/u);
  }
  // However the text's cap falls among emoji, no half of one is left at the end.
  for (const lead of ["", "a"]) {
    const text = fallbackTextFor(compiled.tree, { vars: { rows: [{ name: `${lead}${"\u{1f600}".repeat(2_100)}`, n: 1 }] } });
    assert.ok(text.endsWith("…"));
    assert.doesNotMatch(text, loneSurrogate, `lead ${JSON.stringify(lead)}`);
  }
  // A lone half of a pair in the data is dropped from a cell.
  assert.doesNotMatch(fallbackTextFor(compiled.tree, { vars: { rows: [{ name: "a\ud800b", n: 1 }] } }), loneSurrogate);
  // Including one that falls where the text is read in slices, without taking the emoji after it along.
  for (const plainTables of [true, false]) {
    const text = fallbackTextFor(compiled.tree, { vars: { rows: [{ name: `${"\u200b".repeat(1_023)}\ud800\u{1f600} Revenue`, n: 1 }] } }, { plainTables });
    assert.match(text, /\u{1f600} Revenue/u);
    assert.doesNotMatch(text, loneSurrogate);
  }
});

test("a cell reads the same however long its invisible runs are and however many columns show it", () => {
  const compiled = compileAum(`<Visual title="T"><Data name="rows">[]</Data><Data name="cols">[]</Data><Table rows={$rows} columns={$cols} /></Visual>`);
  assert.ok(compiled.tree);
  const one = [{ key: "name", label: "name" }];
  const cell = (name: string, plainTables: boolean) => {
    const text = fallbackTextFor(compiled.tree!, { vars: { rows: [{ name }], cols: one } }, { plainTables });
    return plainTables ? text.replace(/^name: /u, "") : text.split("\n")[2]!.replace(/^\| | \|$/gu, "");
  };
  // Ten thousand invisible characters before the words leave just the words.
  assert.equal(cell(`${"​".repeat(10_000)}visible text`, true), "visible text");
  assert.equal(cell(`${"﻿".repeat(10_000)}visible text`, false), "visible text");
  // A space run broken by invisible characters, however long, is one space.
  assert.equal(cell(`a${" ​\t".repeat(3_000)}b`, true), "a b");
  assert.equal(cell(`a${" ​\t".repeat(3_000)}b`, false), "a b");
  // Fifty letters, each after a thousand invisible characters: the plain cell keeps 39 and an ellipsis, the Markdown cell all fifty.
  const sparse = `x${"​".repeat(999)}`.repeat(50);
  assert.equal(cell(sparse, true), `${"x".repeat(39)}…`);
  assert.equal(cell(sparse, false), "x".repeat(50));
  // However an invisible run lines up with the emoji after it, every emoji stays whole.
  for (let lead = 1_015; lead <= 1_030; lead += 1) {
    const emoji = `${"​".repeat(lead)}${"\u{1f600}".repeat(60)}`;
    assert.equal(cell(emoji, true), `${"\u{1f600}".repeat(39)}…`, `lead ${lead}`);
    assert.equal(cell(emoji, false), "\u{1f600}".repeat(60), `lead ${lead}`);
  }
  // Many columns showing one long cell each show it clipped the same way.
  const long = `${"​".repeat(20_000)}${"y".repeat(20_000)}`;
  const cols = Array.from({ length: 5 }, (_, index) => ({ key: "name", label: `c${index}` }));
  const plain = fallbackTextFor(compiled.tree, { vars: { rows: [{ name: long }], cols } }, { plainTables: true });
  assert.equal(plain, [0, 1, 2, 3, 4].map((index) => `c${index}: ${"y".repeat(39)}…`).join(" · "));
});

test("the same text is a chart's label as written and a Markdown cell with its pipes escaped", () => {
  const compiled = compileAum(`<Visual title="T"><Data name="rows">[]</Data><Chart kind="bar" data={$rows} x="q" y="n" label={$label} /></Visual>`);
  assert.ok(compiled.tree);
  const text = fallbackTextFor(compiled.tree, { vars: { rows: [{ q: "Q|A", n: 1 }], label: "Q|A" } }, { chartTables: true });
  assert.match(text, /^Q\|A \(bar chart, 1 points\)$/mu);
  assert.match(text, /^\| Q\\\|A \| 1 \|$/mu);
});
