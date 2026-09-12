import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { prototypeCheckScript, prototypeHostDocument } from "./design-prototype-host.js";
import type { DesignPrototypeEdgeV1 } from "../../renderer/shared/design-prototype.js";
const edge: DesignPrototypeEdgeV1 = { id: "edge:next", fromMediaId: "design:a", toMediaId: "design:b", trigger: "click", selector: "#next", transition: "fade" };
test("prototype host contains exactly one unique-origin network-denied iframe", () => {
  const html = prototypeHostDocument();
  assert.equal((html.match(/<iframe /gu) ?? []).length, 1);
  assert.match(html, /sandbox="allow-scripts"/u);
  assert.doesNotMatch(html, /allow-same-origin|allow-popups|allow-forms/u);
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /prefers-reduced-motion/u);
});
test("isolated DOM checks reject ambiguous, unfocusable, and inaccessible interaction sources", () => {
  let listener = () => {};
  const document = { activeElement: null as unknown, querySelectorAll: () => [element], elementFromPoint: () => element };
  const element = { contains: (target: unknown) => target === element, tagName: "BUTTON", disabled: false, textContent: "Next", getBoundingClientRect: () => ({ width: 80, height: 30 }), getAttribute: () => null, focus: () => { document.activeElement = element; }, addEventListener: (_type: string, next: () => void) => { listener = next; }, removeEventListener: () => {}, dispatchEvent: () => listener() };
  const context = { document, getComputedStyle: () => ({ visibility: "visible", display: "block" }), Event: class {} };
  assert.equal(vm.runInNewContext(prototypeCheckScript(edge), context), edge.id);
  document.querySelectorAll = () => [element, element];
  assert.throws(() => vm.runInNewContext(prototypeCheckScript(edge), context), /exactly one/u);
  document.querySelectorAll = () => [element];
  element.focus = () => {}; document.activeElement = null;
  assert.throws(() => vm.runInNewContext(prototypeCheckScript(edge), context), /focusable/u);
  element.focus = () => { document.activeElement = element; }; element.textContent = "";
  assert.throws(() => vm.runInNewContext(prototypeCheckScript(edge), context), /accessible label/u);
});
