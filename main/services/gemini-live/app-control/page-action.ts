// The functions main runs inside Aiden's window with the DevTools protocol.
//
// - AIDEN_ELEMENT_FACTS_SOURCE decides, on the live DOM, whether Live may use
//   an element: its guard, whether it holds a secret, whether it sits in chat
//   or other untrusted content, and a fingerprint of what it is.
// - AIDEN_LOOK_FACTS_SOURCE runs it for every element of a look in one call.
// - AIDEN_CONTENT_REGIONS_SOURCE finds the chat, workspace page and web panel
//   regions whose text Live must not read, so the look can skip them.
// - AIDEN_PAGE_ACTION_SOURCE acts on one element (`this`) with DOM events,
//   after checking the same facts again right before it acts. Every event it
//   sends is untrusted (`isTrusted` false), which is how the renderer tells
//   Live's actions from the user taking over.
//
// The guard rules, all of which make a control the user's alone ("you"):
//
// - it is inside `data-live-guard="you"` or an active onboarding step;
// - it is a password, one-time code or card field;
// - it is a switch or checkbox, unless it sits inside `data-live-safe` (only
//   display preferences such as Appearance are marked safe);
// - its own name, or the name of the dialog it is in, asks for a permission
//   (allow, enable, grant, trust, approve, pair, permit, full access).
//
// Otherwise a control inside `data-live-guard="confirm"` waits for the user's
// OK. The sources are plain ES5-style functions on purpose: they run in the
// page, not in main, and must not depend on anything the TypeScript build adds.

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

/** Kinds of untrusted content Live sees only as a summary. */
export type AidenContentKind = "chat" | "artifact" | "web";

/** What the page says about one element, by AIDEN_ELEMENT_FACTS_SOURCE. */
export interface AidenElementFacts {
  guard: "you" | "confirm" | null;
  secret: boolean;
  visible: boolean;
  /** The untrusted content region the element is in, if any. */
  content: AidenContentKind | null;
  /** Tag, role and type: an element that changes what it is is a different element. */
  key: string;
}

/** One content region root, as AIDEN_CONTENT_REGIONS_SOURCE describes it. */
export interface AidenContentRegionFacts {
  kind: AidenContentKind;
  /** Messages in a chat region; 0 elsewhere. */
  count: number;
  /** Regions drawn with `display: contents` list each child box; they share a group. */
  group: number;
}

/** Names that ask for a permission: a control so named, or in a dialog so named, is the user's. */
const PERMISSION_NAME_PATTERN = String.raw`\b(allow|enable|grant|trust|approve|pair|permit)|full access`;

export const AIDEN_ELEMENT_FACTS_SOURCE = String.raw`function (el, role, name) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return null;
  var doc = el.ownerDocument;
  var w = doc && doc.defaultView;
  if (!w) return null;
  var lower = function (value) { return String(value || "").trim().toLowerCase(); };
  var attr = function (node, attribute) { return lower(node.getAttribute(attribute)); };
  var tag = lower(el.localName);
  var type = attr(el, "type");
  var tokens = attr(el, "autocomplete").split(/\s+/);
  var secret = (tag === "input" && type === "password") || tokens.some(function (t) {
    return t === "current-password" || t === "new-password" || t === "one-time-code" || t.indexOf("cc-") === 0;
  });
  var region = el.closest("[data-live-content]");
  var kind = region ? attr(region, "data-live-content") : "";
  var content = kind === "chat" || kind === "artifact" || kind === "web" ? kind : region ? "web" : null;
  var permission = /${PERMISSION_NAME_PATTERN}/i;
  var dialog = el.closest('[role="dialog"],[role="alertdialog"],dialog');
  var dialogName = "";
  if (dialog) {
    dialogName = dialog.getAttribute("aria-label") || "";
    var labelledBy = String(dialog.getAttribute("aria-labelledby") || "").split(/\s+/);
    for (var i = 0; i < labelledBy.length && !dialogName; i += 1) {
      var label = labelledBy[i] && doc.getElementById(labelledBy[i]);
      if (label) dialogName = String(label.textContent || "");
    }
  }
  var ownRole = attr(el, "role");
  var axRole = lower(role);
  var toggle = ["switch", "checkbox", "menuitemcheckbox"].indexOf(axRole) >= 0 ||
    ["switch", "checkbox", "menuitemcheckbox"].indexOf(ownRole) >= 0 || (tag === "input" && type === "checkbox");
  var guard = null;
  if (secret || el.closest('[data-live-guard="you"],[data-onboarding-active="true"]') ||
      (toggle && !el.closest("[data-live-safe]")) || permission.test(String(name || "")) || permission.test(dialogName)) {
    guard = "you";
  } else if (el.closest('[data-live-guard="confirm"]')) {
    guard = "confirm";
  }
  var rect = el.getBoundingClientRect();
  var visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
    rect.top < w.innerHeight && rect.left < w.innerWidth;
  return { guard: guard, secret: secret, visible: visible, content: content, key: tag + "|" + ownRole + "|" + type };
}`;

/** `this` is the first element; arguments are `[[role, name], …]` then every element. */
export const AIDEN_LOOK_FACTS_SOURCE = `function (meta) {
  var facts = (${AIDEN_ELEMENT_FACTS_SOURCE});
  var out = [];
  for (var i = 1; i < arguments.length; i += 1) {
    var entry = meta[i - 1] || [];
    out.push(facts(arguments[i], entry[0], entry[1]));
  }
  return out;
}`;

/**
 * An expression for `Runtime.evaluate`: the outermost content regions, as an
 * array of elements. A region drawn with `display: contents` has no box and
 * no accessibility node of its own, so its children stand in for it.
 */
export const AIDEN_CONTENT_REGIONS_SOURCE = String.raw`(function () {
  var roots = Array.prototype.slice.call(document.querySelectorAll("[data-live-content]")).filter(function (el) {
    return !(el.parentElement && el.parentElement.closest("[data-live-content]"));
  });
  var out = [];
  var facts = [];
  roots.slice(0, 32).forEach(function (el, group) {
    var kind = String(el.getAttribute("data-live-content") || "").trim().toLowerCase();
    if (kind !== "chat" && kind !== "artifact" && kind !== "web") kind = "web";
    var items = el.querySelectorAll("[data-live-item]").length;
    var count = kind === "chat" ? (items || el.children.length) : 0;
    var boxes = [el];
    for (var depth = 0; depth < 4; depth += 1) {
      var next = [];
      boxes.forEach(function (box) {
        if (window.getComputedStyle(box).display === "contents") next = next.concat(Array.prototype.slice.call(box.children));
        else next.push(box);
      });
      boxes = next;
    }
    boxes.slice(0, 64).forEach(function (box) {
      out.push(box);
      facts.push({ kind: kind, count: count, group: group });
    });
  });
  out.facts = facts;
  return out;
})()`;

/** Runs on the regions array: the facts for each entry, by value. */
export const AIDEN_CONTENT_REGION_FACTS_SOURCE = "function () { return this.facts || []; }";

export interface AidenPageActionRequest {
  action: AidenPageActionName;
  text?: string;
  key?: AidenPageKey;
  /** The user confirmed this action (only then may a "confirm" control act). */
  confirmed?: boolean;
}

/** What main adds to a request: what the element must still be, checked in the page. */
export interface AidenPageActionCall extends AidenPageActionRequest {
  /** The element's accessibility role and name now, for the guard rules. */
  role: string;
  name: string;
  /** The element's fingerprint from the look; a different one means it is gone. */
  expectKey: string;
}

export type AidenPageActionResult =
  | { status: "done"; checked?: boolean | "mixed"; expanded?: boolean; opened?: boolean; moved?: boolean }
  | { status: "you" }
  | { status: "confirm"; inDialog: boolean }
  | { status: "gone" | "disabled" | "readonly" | "unsupported" | "no_option" | "content" | "external" };

export const AIDEN_PAGE_ACTION_SOURCE = String.raw`function (request) {
  var el = this;
  var facts = (${AIDEN_ELEMENT_FACTS_SOURCE})(el, request.role, request.name);
  if (!facts || facts.key !== request.expectKey) return { status: "gone" };
  var doc = el.ownerDocument;
  var w = doc.defaultView;
  var tag = String(el.localName || "").toLowerCase();
  var attr = function (node, name) { return String(node.getAttribute(name) || "").trim().toLowerCase(); };
  if (facts.content) return { status: "content" };
  if (facts.guard === "you") return { status: "you" };
  var inDialog = !!el.closest('[role="dialog"],[role="alertdialog"],dialog');
  if (facts.guard === "confirm" && request.confirmed !== true) return { status: "confirm", inDialog: inDialog };
  if ((typeof el.matches === "function" && el.matches(":disabled")) || attr(el, "aria-disabled") === "true") return { status: "disabled" };
  var role = attr(el, "role");
  var type = attr(el, "type");
  var link = el.closest("a[href]");
  if (link && request.action !== "scroll") {
    // Live never leaves Aiden: links to the web, mail or anything outside the app are refused.
    var url;
    try { url = new w.URL(link.getAttribute("href"), doc.baseURI); } catch (e) { return { status: "external" }; }
    var here = String(w.location.href).split("#")[0];
    var sameDocument = String(url.href).split("#")[0] === here;
    var sameOrigin = url.origin !== "null" && url.origin === w.location.origin;
    if (String(url.protocol).toLowerCase() === "javascript:") return { status: "unsupported" };
    if (!sameDocument && !sameOrigin) return { status: "external" };
  }
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
