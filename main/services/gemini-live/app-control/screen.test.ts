import assert from "node:assert/strict";
import test from "node:test";
import { AIDEN_SCREEN_MARKS, buildAidenScreen, type CdpAxNode, type CdpDomSnapshot } from "./screen.js";

// A page described once and turned into the two DevTools payloads the builder
// reads: `Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot`.
interface Spec {
  tag: string;
  attrs?: Record<string, string>;
  role?: string;
  name?: string;
  value?: string;
  props?: Record<string, unknown>;
  /** [x, y, width, height]; omitted means drawn on screen. */
  bounds?: [number, number, number, number] | null;
  ignored?: boolean;
  children?: Spec[];
}

const VIEWPORT = { x: 0, y: 0, width: 1200, height: 800 };

function cdp(root: Spec): { ax: { nodes: CdpAxNode[] }; dom: CdpDomSnapshot } {
  const strings: string[] = [];
  const string = (value: string) => {
    const at = strings.indexOf(value);
    if (at >= 0) return at;
    strings.push(value);
    return strings.length - 1;
  };
  const dom = { parentIndex: [] as number[], nodeName: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][] };
  const layout = { nodeIndex: [] as number[], bounds: [] as number[][] };
  const axNodes: CdpAxNode[] = [];
  const visit = (spec: Spec, parent: number, axParent: string | undefined): string => {
    const index = dom.backendNodeId.length;
    const backendNodeId = 100 + index;
    dom.parentIndex.push(parent);
    dom.nodeName.push(string(spec.tag.toUpperCase()));
    dom.backendNodeId.push(backendNodeId);
    dom.attributes.push(Object.entries(spec.attrs ?? {}).flatMap(([name, value]) => [string(name), string(value)]));
    if (spec.bounds !== null) {
      layout.nodeIndex.push(index);
      layout.bounds.push(spec.bounds ?? [10, 10 + index, 100, 20]);
    }
    const nodeId = `ax${index}`;
    const node: CdpAxNode = {
      nodeId,
      ...(axParent ? { parentId: axParent } : {}),
      backendDOMNodeId: backendNodeId,
      role: { type: "role", value: spec.role ?? "generic" },
      ...(spec.ignored ? { ignored: true } : {}),
      ...(spec.name !== undefined ? { name: { type: "computedString", value: spec.name } } : {}),
      ...(spec.value !== undefined ? { value: { type: "string", value: spec.value } } : {}),
      properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({ name, value: { type: "booleanOrUndefined", value } })),
      childIds: [],
    };
    axNodes.push(node);
    node.childIds = (spec.children ?? []).map((child) => visit(child, index, nodeId));
    return nodeId;
  };
  visit(root, -1, undefined);
  return { ax: { nodes: axNodes }, dom: { documents: [{ nodes: dom, layout }], strings } };
}

const button = (name: string, extra: Partial<Spec> = {}): Spec => ({ tag: "button", role: "button", name, ...extra });

test("lists controls in page order with their state, and hides every secret value", () => {
  const page = cdp({
    tag: "html",
    role: "RootWebArea",
    name: "Aiden",
    children: [
      { tag: "nav", role: "navigation", name: "Chats", children: [button("New chat", { props: { focused: true } })] },
      {
        tag: "main",
        role: "main",
        children: [
          { tag: "h1", role: "heading", name: "Providers" },
          { tag: "button", role: "switch", name: "Memory", props: { checked: "true" } },
          { tag: "input", role: "textbox", name: "Search", value: "openai", attrs: { type: "search" } },
          { tag: "input", role: "textbox", name: "Password", value: "hunter2", attrs: { type: "password" } },
          { tag: "input", role: "textbox", name: "Code", value: "123456", attrs: { autocomplete: "one-time-code" } },
          {
            tag: "section",
            attrs: { "data-live-guard": "you" },
            children: [
              { tag: "input", role: "textbox", name: "API key", value: "sk-live-secret", attrs: { type: "text" } },
              { tag: "button", role: "switch", name: "Usage data", props: { checked: "false" } },
            ],
          },
        ],
      },
    ],
  });
  const screen = buildAidenScreen({ ...page, viewport: VIEWPORT });
  const lines = screen.text.split("\n");
  assert.match(lines[0]!, /Aiden window “Aiden”\. Focused: “New chat”\./u);
  assert.deepEqual(
    screen.elements.map((element) => [element.ref, element.role, element.name]),
    [
      [1, "button", "New chat"],
      [2, "switch", "Memory"],
      [3, "textbox", "Search"],
      [4, "textbox", "Password"],
      [5, "textbox", "Code"],
      [6, "textbox", "API key"],
      [7, "switch", "Usage data"],
    ],
  );
  assert.ok(lines.includes("[navigation “Chats”]"));
  assert.ok(lines.includes("# Providers"));
  assert.ok(lines.includes("2 switch “Memory” (checked)"));
  assert.ok(lines.includes("3 textbox “Search” = “openai”"), "an ordinary field shows its value");
  for (const secret of ["hunter2", "123456", "sk-live-secret"]) {
    assert.doesNotMatch(screen.text, new RegExp(secret, "u"), `${secret} never leaves the window`);
  }
  assert.ok(lines.includes(`6 textbox “API key” ${AIDEN_SCREEN_MARKS.you}`));
  assert.ok(lines.includes(`7 switch “Usage data” (not checked) ${AIDEN_SCREEN_MARKS.you}`));
  assert.equal(screen.elements.find((element) => element.ref === 7)?.guard, "you");
});

test("marks confirm-guarded controls, and a you region inside a confirm region stays the user's", () => {
  const page = cdp({
    tag: "html",
    role: "RootWebArea",
    name: "Aiden",
    children: [
      {
        tag: "div",
        attrs: { "data-live-guard": "confirm" },
        children: [button("Delete chat"), { tag: "div", attrs: { "data-live-guard": "you" }, children: [button("Allow")] }],
      },
      { tag: "div", attrs: { "data-onboarding-active": "true" }, children: [button("Continue")] },
    ],
  });
  const screen = buildAidenScreen({ ...page, viewport: VIEWPORT });
  assert.deepEqual(
    screen.elements.map((element) => [element.name, element.guard]),
    [
      ["Delete chat", "confirm"],
      ["Allow", "you"],
      ["Continue", "you"],
    ],
  );
  assert.ok(screen.text.split("\n").includes(`1 button “Delete chat” ${AIDEN_SCREEN_MARKS.confirm}`));
});

test("an open dialog and the focus words come first when the page is too big to list", () => {
  const many = Array.from({ length: 260 }, (_, index) =>
    button(`Chat ${index + 1}`, index >= 40 ? { bounds: [10, 2_000 + index * 30, 100, 20] } : {}),
  );
  const page = cdp({
    tag: "html",
    role: "RootWebArea",
    name: "Aiden",
    children: [
      { tag: "nav", role: "navigation", name: "Chats", children: many },
      { tag: "section", role: "region", name: "Usage", bounds: [0, 3_000, 10, 10], children: [button("Reset usage", { bounds: [0, 3_000, 10, 10] })] },
      {
        tag: "div",
        role: "alertdialog",
        name: "Delete chat?",
        children: [button("Cancel"), button("Delete", { attrs: { "data-live-guard": "confirm" } })],
      },
    ],
  });
  const screen = buildAidenScreen({ ...page, viewport: VIEWPORT, focus: "usage" });
  assert.ok(screen.elements.length <= 200, "at most 200 numbered elements");
  assert.ok(screen.text.length <= 12_000, "at most 12k characters");
  assert.equal(screen.omitted, 263 - screen.elements.length);
  const names = screen.elements.map((element) => element.name);
  for (const name of ["Cancel", "Delete", "Reset usage", "Chat 1", "Chat 40"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("Chat 260"), "off-screen rows are the first to go");
  assert.match(screen.text, /A dialog is open: “Delete chat\?”\./u);
  assert.match(screen.text, /more controls are not listed/u);

  const tight = buildAidenScreen({ ...page, viewport: VIEWPORT, limits: { elements: 5, characters: 600 } });
  assert.deepEqual(
    tight.elements.map((element) => element.name).slice(0, 2),
    ["Chat 1", "Chat 2"],
    "numbers follow page order among what fits",
  );
  assert.ok(tight.elements.length <= 5 && tight.text.length <= 600);
  assert.ok(tight.elements.some((element) => element.name === "Delete"), "the dialog survives a tight budget");
});

test("ignored nodes are skipped and new controls are marked against the previous look", () => {
  const first = buildAidenScreen({
    ...cdp({ tag: "html", role: "RootWebArea", name: "Aiden", children: [button("Settings"), button("Hidden", { ignored: true })] }),
    viewport: VIEWPORT,
  });
  assert.deepEqual(first.elements.map((element) => element.name), ["Settings"]);
  const second = buildAidenScreen({
    ...cdp({ tag: "html", role: "RootWebArea", name: "Aiden", children: [button("Settings"), button("Back to app")] }),
    viewport: VIEWPORT,
    previous: first.signatures,
  });
  assert.match(second.text, /1 button “Settings”$/mu);
  assert.match(second.text, /2 button “Back to app” \(new\)$/mu);
});
