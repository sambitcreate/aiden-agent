import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DictationDictionaryView,
  type DictationDictionaryViewProps,
} from "./dictation-dictionary-settings.js";

const noop = () => undefined;

function props(extra: Partial<DictationDictionaryViewProps> = {}): DictationDictionaryViewProps {
  return {
    entries: [],
    heard: "",
    replacement: "",
    error: null,
    saving: false,
    onHeardChange: noop,
    onReplacementChange: noop,
    onAdd: noop,
    onRemove: noop,
    ...extra,
  };
}

type Element = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;

function findAll(node: React.ReactNode, match: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  const visit = (current: React.ReactNode) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!React.isValidElement(current)) return;
    const element = current as Element;
    if (match(element)) found.push(element);
    visit(element.props.children);
  };
  visit(node);
  return found;
}

test("an empty dictionary explains itself and cannot add a blank word", () => {
  const html = renderToStaticMarkup(<DictationDictionaryView {...props()} />);
  assert.match(html, /No custom words yet\./);
  assert.match(html, /aria-label="Heard as"/);
  assert.match(html, /aria-label="Replace with"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
});

test("saved rules list the spoken form, its replacement, and a named remove action", () => {
  const removed: number[] = [];
  const tree = DictationDictionaryView(
    props({
      entries: [
        { from: "aiden", to: "Aiden" },
        { from: "Kubernetes", to: "" },
      ],
      onRemove: (index) => removed.push(index),
    }),
  );
  const html = renderToStaticMarkup(tree);
  assert.match(html, /aria-label="Custom dictionary"/);
  assert.match(html, /aiden.*Aiden/s);
  assert.match(html, /Kubernetes.*exact spelling/s);
  const [removeSecond] = findAll(tree, (element) => element.props["aria-label"] === "Remove Kubernetes");
  assert.ok(removeSecond);
  (removeSecond.props.onClick as () => void)();
  assert.deepEqual(removed, [1]);
});

test("a rejected entry is announced and tied to the input", () => {
  const html = renderToStaticMarkup(
    <DictationDictionaryView {...props({ heard: "x", error: "Remove one first." })} />,
  );
  assert.match(html, /role="alert"[^>]*>Remove one first\./);
  assert.match(html, /aria-invalid="true"/);
});

test("submitting the form adds the rule without reloading the page", () => {
  let added = 0;
  const tree = DictationDictionaryView(props({ heard: "aiden", onAdd: () => (added += 1) }));
  const [form] = findAll(tree, (element) => element.type === "form");
  let prevented = false;
  (form!.props.onSubmit as (event: { preventDefault: () => void }) => void)({
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.equal(added, 1);
});


test("dictionary row keys remain distinct under Turkish locale casing", () => {
  const original = String.prototype.toLocaleLowerCase;
  let keys: Array<string | null>;
  try {
    String.prototype.toLocaleLowerCase = function () { return original.call(this, "tr"); };
    const tree = DictationDictionaryView(props({ entries: [{ from: "I", to: "" }, { from: "ı", to: "" }] }));
    keys = findAll(tree, (element) => element.type === "li").map((element) => element.key);
  } finally {
    String.prototype.toLocaleLowerCase = original;
  }
  assert.deepEqual(keys, ["i", "ı"]);
});
