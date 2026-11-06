// The function main runs on one element of Aiden's window with
// `Runtime.callFunctionOn` (the element is `this`). It checks the Live guards
// on the live DOM right before acting, so a stale look can never press a
// control that is only the user's, and acts with DOM events rather than
// synthetic OS input. Every event it sends is untrusted (`isTrusted` false),
// which is how the renderer tells Live's actions from the user taking over.
//
// It is plain ES5-style source on purpose: it runs in the page, not in main,
// and must not depend on anything the TypeScript build adds.

export type AidenPageActionName = "press" | "type" | "toggle" | "select" | "scroll" | "key";

export const AIDEN_PAGE_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
] as const;
export type AidenPageKey = (typeof AIDEN_PAGE_KEYS)[number];

export interface AidenPageActionRequest {
  action: AidenPageActionName;
  text?: string;
  key?: AidenPageKey;
  /** The user confirmed this action (only then may a "confirm" control act). */
  confirmed?: boolean;
}

export type AidenPageActionResult =
  | { status: "done"; checked?: boolean | "mixed"; expanded?: boolean; opened?: boolean; moved?: boolean }
  | { status: "you" }
  | { status: "confirm"; inDialog: boolean }
  | { status: "gone" | "disabled" | "readonly" | "unsupported" | "no_option" };

export const AIDEN_PAGE_ACTION_SOURCE = String.raw`function (request) {
  var el = this;
  var doc = el && el.ownerDocument;
  var w = doc && doc.defaultView;
  if (!el || el.nodeType !== 1 || !el.isConnected || !w) return { status: "gone" };
  var tag = String(el.localName || "").toLowerCase();
  var attr = function (node, name) { return String(node.getAttribute(name) || "").trim().toLowerCase(); };
  var tokens = attr(el, "autocomplete").split(/\s+/);
  var secret = (tag === "input" && attr(el, "type") === "password") || tokens.some(function (t) {
    return t === "current-password" || t === "new-password" || t === "one-time-code" || t.indexOf("cc-") === 0;
  });
  if (secret || el.closest('[data-live-guard="you"],[data-onboarding-active="true"]')) return { status: "you" };
  var inDialog = !!el.closest('[role="dialog"],[role="alertdialog"]');
  if (el.closest('[data-live-guard="confirm"]') && request.confirmed !== true) return { status: "confirm", inDialog: inDialog };
  if ((typeof el.matches === "function" && el.matches(":disabled")) || attr(el, "aria-disabled") === "true") return { status: "disabled" };
  var role = attr(el, "role");
  var type = attr(el, "type");
  var focus = function () {
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    if (typeof el.focus === "function") { try { el.focus({ preventScroll: true }); } catch (e) {} }
  };
  var state = function () {
    var out = { status: "done" };
    var aria = attr(el, "aria-checked");
    if (aria === "true") out.checked = true;
    else if (aria === "false") out.checked = false;
    else if (aria === "mixed") out.checked = "mixed";
    else if (tag === "input" && (type === "checkbox" || type === "radio")) out.checked = !!el.checked;
    var expanded = attr(el, "aria-expanded");
    if (expanded === "true") out.expanded = true;
    else if (expanded === "false") out.expanded = false;
    return out;
  };
  var press = function () {
    focus();
    var rect = el.getBoundingClientRect();
    var base = { bubbles: true, cancelable: true, composed: true, view: w, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    var pointer = function (name, buttons) {
      if (typeof w.PointerEvent !== "function") return;
      el.dispatchEvent(new w.PointerEvent(name, Object.assign({}, base, { buttons: buttons, pointerId: 1, pointerType: "mouse", isPrimary: true })));
    };
    var mouse = function (name, buttons) { el.dispatchEvent(new w.MouseEvent(name, Object.assign({}, base, { buttons: buttons }))); };
    pointer("pointerdown", 1); mouse("mousedown", 1); pointer("pointerup", 0); mouse("mouseup", 0);
    if (el.isConnected) el.click();
  };
  var textLike = tag === "textarea" || el.isContentEditable || (tag === "input" &&
    ["", "text", "search", "email", "url", "tel", "number"].indexOf(type) >= 0);
  var action = request.action;
  if (action === "press") { press(); return state(); }
  if (action === "toggle") {
    var toggles = ["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"].indexOf(role) >= 0 ||
      (tag === "input" && (type === "checkbox" || type === "radio"));
    if (!toggles) return { status: "unsupported" };
    press();
    return state();
  }
  if (action === "type") {
    if (!textLike) return { status: "unsupported" };
    if (el.readOnly || attr(el, "aria-readonly") === "true") return { status: "readonly" };
    var value = String(request.text || "");
    focus();
    if (el.isContentEditable) {
      doc.execCommand("selectAll", false);
      if (!doc.execCommand("insertText", false, value)) el.textContent = value;
    } else {
      var proto = tag === "textarea" ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new w.Event("change", { bubbles: true }));
    }
    return { status: "done" };
  }
  if (action === "select") {
    if (tag === "select") {
      var wanted = String(request.text || "").trim().toLowerCase();
      var options = Array.prototype.slice.call(el.options || []);
      var label = function (option) { return String(option.label || option.textContent || "").trim().toLowerCase(); };
      var match = options.filter(function (o) { return label(o) === wanted || String(o.value).toLowerCase() === wanted; })[0] ||
        options.filter(function (o) { return wanted && label(o).indexOf(wanted) === 0; })[0];
      if (!match || match.disabled) return { status: "no_option" };
      focus();
      Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set.call(el, match.value);
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      el.dispatchEvent(new w.Event("change", { bubbles: true }));
      return { status: "done" };
    }
    if (["option", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "radio", "treeitem"].indexOf(role) >= 0) {
      press();
      return state();
    }
    if (role === "combobox" || attr(el, "aria-haspopup")) {
      press();
      var opened = state();
      opened.opened = true;
      return opened;
    }
    return { status: "unsupported" };
  }
  if (action === "scroll") {
    var direction = String(request.text || "down").trim().toLowerCase();
    var box = el;
    while (box && box.nodeType === 1) {
      var overflow = w.getComputedStyle(box).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && box.scrollHeight > box.clientHeight) break;
      box = box.parentElement;
    }
    if (!box || box.nodeType !== 1) {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {}
      return { status: "done", moved: false };
    }
    var before = box.scrollTop;
    var page = Math.max(40, Math.round(box.clientHeight * 0.8));
    var next = direction === "top" ? 0 : direction === "bottom" ? box.scrollHeight :
      direction === "up" ? before - page : before + page;
    box.scrollTop = next;
    return { status: "done", moved: box.scrollTop !== before };
  }
  if (action === "key") {
    var keys = { Enter: ["Enter", "Enter"], Escape: ["Escape", "Escape"], Tab: ["Tab", "Tab"], Space: [" ", "Space"],
      ArrowUp: ["ArrowUp", "ArrowUp"], ArrowDown: ["ArrowDown", "ArrowDown"], ArrowLeft: ["ArrowLeft", "ArrowLeft"],
      ArrowRight: ["ArrowRight", "ArrowRight"], Home: ["Home", "Home"], End: ["End", "End"], PageUp: ["PageUp", "PageUp"],
      PageDown: ["PageDown", "PageDown"], Backspace: ["Backspace", "Backspace"], Delete: ["Delete", "Delete"] };
    var pair = Object.prototype.hasOwnProperty.call(keys, request.key) ? keys[request.key] : null;
    if (!pair) return { status: "unsupported" };
    focus();
    var init = { key: pair[0], code: pair[1], bubbles: true, cancelable: true, composed: true, view: w };
    var allowed = el.dispatchEvent(new w.KeyboardEvent("keydown", init));
    var clickable = tag === "button" || tag === "summary" || (tag === "a" && el.hasAttribute("href")) ||
      ["button", "link", "menuitem", "option", "tab", "checkbox", "switch", "radio"].indexOf(role) >= 0;
    if (allowed && el.isConnected) {
      if (request.key === "Enter" && clickable && role !== "checkbox" && role !== "switch") el.click();
      else if (request.key === "Space" && clickable && tag !== "a") el.click();
      else if (request.key === "Enter" && tag === "input" && el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
    }
    if (el.isConnected) el.dispatchEvent(new w.KeyboardEvent("keyup", init));
    return state();
  }
  return { status: "unsupported" };
}`;
