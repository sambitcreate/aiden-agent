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
