import assert from "node:assert/strict";
import test from "node:test";
import { isWireSafeKey, parseChatUiVisualV1, parseChatUiVisuals } from "./visual.js";
import { AIDEN_UI_LIMITS, type ChatUiVisualV1 } from "./types.js";

function visual(overrides: Partial<ChatUiVisualV1> = {}): ChatUiVisualV1 {
  return {
    version: 1,
    kind: "ui",
    id: "ui-1",
    toolCallId: "call-1",
    title: "Revenue",
    catalogVersion: 1,
    tree: {
      t: "Visual",
      k: "0",
      c: [
        { t: "Stat", k: "0.0", p: { label: { op: "lit", v: "Total" }, value: { op: "var", name: "total" } } },
        { t: "Button", k: "0.1", p: { action: { act: "send", text: { op: "lit", v: "More" } } }, c: [{ t: "#text", k: "0.1.0", s: "More" }] },
      ],
    },
    dataJson: "{\"total\":3}",
    fallbackText: "Total: 3",
    ...overrides,
  };
}

test("a valid visual round-trips and unknown top-level keys are ignored", () => {
  const parsed = parseChatUiVisualV1({ ...visual(), futureField: true });
  assert.deepEqual(parsed, visual());
  assert.equal(parsed && "futureField" in parsed, false);
});

test("one malformed visual is dropped while its neighbours survive", () => {
  const broken = { ...visual({ id: "ui-2" }), tree: undefined };
  const parsed = parseChatUiVisuals([visual(), broken, visual({ id: "ui-3", layout: "wide" })]);
  assert.deepEqual(parsed?.map((entry) => entry.id), ["ui-1", "ui-3"]);
  assert.equal(parsed?.[1]?.layout, "wide");
  assert.equal(parseChatUiVisuals("nope"), undefined);
  assert.equal(parseChatUiVisuals([broken]), undefined);
});

test("wire-unsafe key names are recognised after normalisation", () => {
  for (const name of ["Path", "tool_args", "children", "subAgents", "refresh-token", "Results", "prompt", "api.key"]) {
    assert.equal(isWireSafeKey(name), false, name);
  }
  for (const name of ["label", "text", "c", "k", "op", "value", "url", "columns"]) {
    assert.equal(isWireSafeKey(name), true, name);
  }
});

test("a tree carrying a wire-unsafe key anywhere is rejected", () => {
  const unsafe = visual({
    tree: { t: "Visual", k: "0", c: [{ t: "Text", k: "0.0", p: { path: { op: "lit", v: 1 } } }] },
  });
  assert.equal(parseChatUiVisualV1(unsafe), undefined);
  const unsafeExpr = visual({
    tree: { t: "Visual", k: "0", p: { title: { op: "json", v: { token: "x" } } as never } },
  });
  assert.equal(parseChatUiVisualV1(unsafeExpr), undefined);
});

test("data, tree, depth, node, and state caps reject oversized visuals", () => {
  const bigData = `{"x":"${"a".repeat(AIDEN_UI_LIMITS.dataBytes)}"}`;
  assert.equal(parseChatUiVisualV1(visual({ dataJson: bigData })), undefined);
  const wideTree = {
    t: "Visual",
    k: "0",
    c: Array.from({ length: AIDEN_UI_LIMITS.nodes + 1 }, (_, index) => ({ t: "Text", k: `0.${index}` })),
  };
  assert.equal(parseChatUiVisualV1(visual({ tree: wideTree })), undefined);
  let deep: ChatUiVisualV1["tree"] = { t: "Text", k: "x" };
  for (let level = 0; level < AIDEN_UI_LIMITS.depth + 1; level += 1) deep = { t: "Stack", k: `d${level}`, c: [deep] };
  assert.equal(parseChatUiVisualV1(visual({ tree: { t: "Visual", k: "0", c: [deep] } })), undefined);
  const hugeText = { t: "Visual", k: "0", c: [{ t: "#text", k: "0.0", s: "a".repeat(AIDEN_UI_LIMITS.treeBytes) }] };
  assert.equal(parseChatUiVisualV1(visual({ tree: hugeText })), undefined);
  assert.equal(parseChatUiVisualV1(visual({ state: { note: "a".repeat(AIDEN_UI_LIMITS.stateBytes) } })), undefined);
  assert.ok(parseChatUiVisualV1(visual({ state: { tab: "a" } })));
});

test("identity, title, catalog version, and layout are validated", () => {
  assert.equal(parseChatUiVisualV1(visual({ id: "bad id" })), undefined);
  assert.equal(parseChatUiVisualV1(visual({ title: " padded" })), undefined);
  assert.equal(parseChatUiVisualV1(visual({ catalogVersion: 2 })), undefined);
  assert.equal(parseChatUiVisualV1({ ...visual(), layout: "huge" })?.layout, undefined);
  assert.equal(parseChatUiVisualV1(visual({ toolCallId: undefined }))?.toolCallId, undefined);
});
