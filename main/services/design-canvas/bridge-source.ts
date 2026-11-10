// The one script main injects into every aiden-design HTML response, served
// from `__aiden/bridge.js`. Its contents are fixed; designs never supply it.
//
// The frame is sandboxed without same-origin, so the parent cannot be named
// as a target origin; the canvas checks `event.source === iframe.contentWindow`
// and the bridge answers only messages whose source is its parent.
//
// Messages to the canvas (`aiden-design:` + type):
// - `ready`, `resize` {docHeight}: the page's height;
// - `scroll` {x, y}: the page scrolled;
// - `picked` {requestId, element | null, point}: what is under a point;
// - `anchors` {requestId, results}: what each comment's element looks like now;
// - `edit-start` {element}: the person started editing an element's words;
// - `edit-end` {cancelled, plain, changes, beforeHtml, afterHtml, element}:
//   they finished. `plain` when only words changed, with each changed text
//   node's old and new text in `changes`.
// Messages from the canvas:
// - `hover-at` {x, y} | {clear}: outline the element under a point;
// - `pick-at` {requestId, x, y, wide}: describe the element under a point,
//   or its parent when `wide`;
// - `locate` {requestId, items: [{commentId, selector, text, tag}]};
// - `highlight` {commentId} | {clear};
// - `set-tweaks` {dark, vars, attrs}: the Dark switch and the page's tweak
//   values, set on the root element. Names and values left out go back to
//   what the page had. The page's address can carry the same state
//   (`aiden-dark=1`, `aiden-tweaks={vars, attrs}`), applied before the page
//   draws, so an export or a first load never shows it untweaked;
// - `edit-enable` {on}: whether a double-click edits words (the canvas turns
//   it on while the person is inside this page);
// - `edit-command` {command, value}: bold, italic, underline, link, unlink,
//   insertUnorderedList, insertOrderedList, align (left|center|right) or
//   block (p|h1|h2|h3|h4) on the element being edited;
// - `edit-finish` {cancel}: keep or throw away the edit.
// Points are in the frame's viewport CSS pixels; rects and points sent back
// are in document CSS pixels (scroll included).

export const DESIGN_BRIDGE_SOURCE = `(() => {
  "use strict";
  const host = window.parent;
  if (!host || host === window) return;
  const doc = window.document;
  const PREFIX = "aiden-design:";
  const TEXT_CHARS = 200;
  const MAX_SCAN = 5000;
  const MAX_CANDIDATES = 150;
  const MAX_DEPTH = 12;
  const send = (type, payload) => {
    try {
      host.postMessage(Object.assign({ type: PREFIX + type }, payload), "*");
    } catch {}
  };
  const height = () => {
    const root = doc.documentElement;
    return root ? Math.ceil(root.scrollHeight) : 0;
  };
  const post = (type) => send(type, { docHeight: height() });

  const root = doc.documentElement;
  const VAR_NAME = /^--[A-Za-z0-9_-]{1,60}$/;
  const ATTR_NAME = /^data-[a-z0-9-]{1,60}$/;
  const UNSAFE = /[;{}<>\\\\"']|url\\(|expression\\(/i;
  const MAX_TWEAKS = 24;
  const originals = new Map();
  let applied = new Set();
  const read = (key) => {
    if (key === "theme") return root.getAttribute("data-theme");
    if (key === "scheme") return root.style.colorScheme || "";
    if (key.indexOf("v:") === 0) return root.style.getPropertyValue(key.slice(2));
    return root.getAttribute(key.slice(2));
  };
  const write = (key, value) => {
    if (key === "theme") {
      if (value === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", value);
    } else if (key === "scheme") root.style.colorScheme = value || "";
    else if (key.indexOf("v:") === 0) {
      if (value) root.style.setProperty(key.slice(2), value);
      else root.style.removeProperty(key.slice(2));
    } else if (value === null) root.removeAttribute(key.slice(2));
    else root.setAttribute(key.slice(2), value);
  };
  const set = (next, key, value) => {
    if (!originals.has(key)) originals.set(key, read(key));
    write(key, value);
    next.add(key);
  };
  const safe = (value) => typeof value === "string" && value.length <= 100 && !UNSAFE.test(value);
  const applyTweaks = (state) => {
    if (!root || !state || typeof state !== "object") return;
    const next = new Set();
    if (state.dark === true) {
      set(next, "theme", "dark");
      set(next, "scheme", "dark");
    }
    const vars = state.vars && typeof state.vars === "object" ? state.vars : {};
    for (const name of Object.keys(vars).slice(0, MAX_TWEAKS)) {
      if (VAR_NAME.test(name) && safe(vars[name])) set(next, "v:" + name, vars[name]);
    }
    const attrs = state.attrs && typeof state.attrs === "object" ? state.attrs : {};
    for (const name of Object.keys(attrs).slice(0, MAX_TWEAKS)) {
      if (ATTR_NAME.test(name) && safe(attrs[name])) set(next, "a:" + name, attrs[name]);
    }
    for (const key of applied) {
      if (next.has(key)) continue;
      write(key, originals.get(key));
      originals.delete(key);
    }
    applied = next;
  };
  try {
    const params = new URLSearchParams(window.location.search);
    const boot = { dark: params.get("aiden-dark") === "1" };
    const raw = params.get("aiden-tweaks");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") Object.assign(boot, { vars: parsed.vars, attrs: parsed.attrs });
    }
    applyTweaks(boot);
  } catch {}
  if (doc.readyState === "complete") post("ready");
  else window.addEventListener("load", () => post("ready"), { once: true });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      post("resize");
    });
  };
  if (typeof window.ResizeObserver === "function" && doc.documentElement) {
    new window.ResizeObserver(schedule).observe(doc.documentElement);
  }
  let scrolling = false;
  window.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    window.requestAnimationFrame(() => {
      scrolling = false;
      send("scroll", { x: window.scrollX || 0, y: window.scrollY || 0 });
    });
  }, { passive: true });

  const outlines = new Map();
  const outline = (name, element, style) => {
    let box = outlines.get(name);
    if (!element) {
      if (box) box.remove();
      outlines.delete(name);
      return;
    }
    if (!box) {
      box = doc.createElement("div");
      box.setAttribute("data-aiden-bridge", "");
      box.setAttribute("aria-hidden", "true");
      outlines.set(name, box);
    }
    const r = element.getBoundingClientRect();
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-radius:3px;" + style +
      "left:" + (r.left - 2) + "px;top:" + (r.top - 2) + "px;width:" + (r.width + 4) + "px;height:" + (r.height + 4) + "px;";
    if (!box.isConnected) (doc.body || doc.documentElement).appendChild(box);
  };
  const ours = (element) => Boolean(element && element.closest && element.closest("[data-aiden-bridge]"));
  const squash = (text) => String(text || "").replace(/\\s+/g, " ").trim();
  const textOf = (element) => {
    const text = squash(element.innerText !== undefined ? element.innerText : element.textContent);
    const extra = text || squash(element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("placeholder") || element.getAttribute("title"));
    return extra.slice(0, TEXT_CHARS);
  };
  const tagOf = (element) => String(element.tagName || "").toLowerCase();
  const unique = (selector) => {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const idSelector = (id) => /^[A-Za-z][\\w-]*$/.test(id) ? "#" + id : null;
  const selectorOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < MAX_DEPTH) {
      const tag = tagOf(node);
      if (tag === "html") break;
      const id = node.getAttribute("id");
      const byId = id ? idSelector(id) : null;
      if (byId && unique(byId)) {
        parts.unshift(byId);
        return parts.join(" > ");
      }
      if (tag === "body") {
        parts.unshift("body");
        break;
      }
      let part = tag;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (child) => tagOf(child) === tag);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const rectOf = (element) => {
    const r = element.getBoundingClientRect();
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const describe = (element) => {
    const found = {
      selector: selectorOf(element),
      text: textOf(element),
      tag: tagOf(element),
      rect: rectOf(element),
    };
    const stamp = element.closest("[data-aiden-src]");
    if (stamp) found.sourcePath = String(stamp.getAttribute("data-aiden-src")).slice(0, 1024);
    const marked = element.closest("[data-aiden-comment]");
    if (marked) found.commentId = String(marked.getAttribute("data-aiden-comment")).split(/\\s+/)[0].slice(0, 128);
    return found;
  };
  const at = (x, y) => {
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) return null;
    const element = doc.elementFromPoint(x, y);
    if (!element || ours(element) || element === doc.documentElement) return null;
    return element;
  };
  const widen = (element) => {
    const parent = element.parentElement;
    return parent && parent !== doc.documentElement && parent !== doc.body ? parent : element;
  };
  const carries = (element, commentId) =>
    String(element.getAttribute("data-aiden-comment") || "").split(/\\s+/).indexOf(commentId) !== -1;
  const byComment = (commentId) => {
    const marked = doc.querySelectorAll("[data-aiden-comment]");
    for (let index = 0; index < marked.length; index += 1) {
      if (carries(marked[index], commentId)) return marked[index];
    }
    return null;
  };
  const locate = (item) => {
    if (!item || typeof item.commentId !== "string") return null;
    const marked = byComment(item.commentId);
    if (marked) return { byId: describe(marked), candidates: [] };
    let bySelector = null;
    if (typeof item.selector === "string" && item.selector) {
      try {
        bySelector = doc.querySelector(item.selector);
      } catch {}
    }
    if (bySelector && ours(bySelector)) bySelector = null;
    const tag = typeof item.tag === "string" ? item.tag.toLowerCase() : "";
    const text = typeof item.text === "string" ? squash(item.text).slice(0, TEXT_CHARS) : "";
    const candidates = [];
    if (bySelector) candidates.push(Object.assign(describe(bySelector), { selectorMatch: true }));
    const all = (doc.body || doc.documentElement).getElementsByTagName("*");
    for (let index = 0; index < all.length && index < MAX_SCAN && candidates.length < MAX_CANDIDATES; index += 1) {
      const element = all[index];
      if (element === bySelector || ours(element)) continue;
      if (tagOf(element) === tag || (text && textOf(element) === text)) {
        candidates.push(Object.assign(describe(element), { selectorMatch: false }));
      }
    }
    return { candidates };
  };
  const NEUTRAL = "border:2px solid rgba(120,120,128,.9);box-shadow:0 0 0 1px rgba(255,255,255,.8);";
  const STRONG = "border:2px solid rgba(60,60,67,.95);background:rgba(120,120,128,.12);box-shadow:0 0 0 1px rgba(255,255,255,.9);";

  // Editing words in place, only while the canvas allows it. A double-click
  // makes one element editable; Enter or a click elsewhere keeps the edit, Esc
  // throws it away. Nothing here writes a file: the canvas decides that.
  const EDIT_CHARS = 4000;
  const MAX_TEXT_NODES = 20;
  const EDITABLE = /^(h[1-6]|p|a|button|li|span|strong|em|b|i|u|small|label|td|th|dt|dd|figcaption|blockquote|caption|summary|legend|q|cite|mark|time|div)$/;
  const INLINE = /^(strong|em|b|i|u|span|small|mark|q|cite|time|a)$/;
  const BLOCK = /^(h[1-6]|p|li|a|button|label|td|th|dt|dd|figcaption|blockquote|caption|summary|legend)$/;
  const EDIT_STYLE = "border:2px solid rgba(60,60,67,.95);box-shadow:0 0 0 1px rgba(255,255,255,.9);";
  let editAllowed = false;
  let editing = null;
  const textsOf = (element) => {
    const texts = [];
    const walker = doc.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.data);
    return texts;
  };
  const shapeOf = (element) => {
    const copy = element.cloneNode(true);
    const walker = doc.createTreeWalker(copy, 4);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) node.data = "";
    copy.removeAttribute("contenteditable");
    return copy.outerHTML;
  };
  const outerOf = (element) => {
    const copy = element.cloneNode(true);
    copy.removeAttribute("contenteditable");
    return copy.outerHTML.slice(0, EDIT_CHARS);
  };
  const ownText = (node) =>
    Array.prototype.some.call(node.childNodes, (child) => child.nodeType === 3 && /\\S/.test(child.data));
  const editableFrom = (target) => {
    let node = target && target.nodeType === 1 ? target : target && target.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if (node === doc.body || node === doc.documentElement || ours(node)) return null;
      if (!ownText(node) || !EDITABLE.test(tagOf(node))) continue;
      // A bold word or a span is edited with the paragraph or heading it sits in.
      let block = node;
      while (INLINE.test(tagOf(block)) && block.parentElement && BLOCK.test(tagOf(block.parentElement))) block = block.parentElement;
      return block;
    }
    return null;
  };
  let editFocusStyle = null;
  const startEdit = (element) => {
    element.normalize();
    editing = {
      original: element,
      element,
      html: element.innerHTML,
      outer: outerOf(element),
      style: element.getAttribute("style"),
      texts: textsOf(element),
      shape: shapeOf(element),
      range: null,
    };
    element.setAttribute("contenteditable", "true");
    element.setAttribute("data-aiden-editing", "");
    if (!editFocusStyle) {
      // The bridge's own outline marks the element, not the browser's focus ring.
      editFocusStyle = doc.createElement("style");
      editFocusStyle.setAttribute("data-aiden-bridge", "");
      editFocusStyle.textContent = "[data-aiden-editing]:focus{outline:none}";
    }
    (doc.head || doc.documentElement).appendChild(editFocusStyle);
    element.focus({ preventScroll: true });
    outline("edit", element, EDIT_STYLE);
    send("edit-start", { element: describe(element) });
  };
  const restoreStyle = (element, style) => {
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
  };
  const finishEdit = (cancel) => {
    if (!editing) return;
    const current = editing;
    editing = null;
    outline("edit", null);
    let element = current.element;
    element.removeAttribute("contenteditable");
    element.removeAttribute("data-aiden-editing");
    if (editFocusStyle) editFocusStyle.remove();
    if (cancel) {
      if (element !== current.original) {
        element.replaceWith(current.original);
        element = current.original;
      }
      element.innerHTML = current.html;
      restoreStyle(element, current.style);
      send("edit-end", { cancelled: true, plain: true, changes: [], beforeHtml: "", afterHtml: "", element: describe(element) });
      return;
    }
    element.normalize();
    // Typing can leave an empty style attribute behind; it means no style.
    if (current.style === null && String(element.getAttribute("style") || "").trim() === "") element.removeAttribute("style");
    // Typing a space at a line's end gives a no-break space; the file means a space.
    const texts = textsOf(element).map((text, index) =>
      String(current.texts[index] || "").indexOf("\u00a0") === -1 ? text.replace(/\u00a0/g, " ") : text);
    const plain = element === current.original &&
      element.getAttribute("style") === current.style &&
      shapeOf(element) === current.shape &&
      texts.length === current.texts.length &&
      texts.length <= MAX_TEXT_NODES;
    const changes = [];
    if (plain) {
      for (let index = 0; index < texts.length; index += 1) {
        if (texts[index] !== current.texts[index]) {
          changes.push({ before: current.texts[index].slice(0, EDIT_CHARS), after: texts[index].slice(0, EDIT_CHARS) });
        }
      }
    }
    const afterHtml = outerOf(element);
    send("edit-end", {
      cancelled: false,
      plain,
      changes,
      beforeHtml: current.outer,
      afterHtml,
      element: describe(element),
    });
  };
  const retag = (tag) => {
    const old = editing.element;
    if (tagOf(old) === tag) return;
    const next = doc.createElement(tag);
    for (const attribute of Array.prototype.slice.call(old.attributes)) next.setAttribute(attribute.name, attribute.value);
    while (old.firstChild) next.appendChild(old.firstChild);
    old.replaceWith(next);
    editing.element = next;
    next.focus({ preventScroll: true });
    outline("edit", next, EDIT_STYLE);
  };
  const runEdit = (command, value) => {
    if (!editing) return;
    const element = editing.element;
    element.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (editing.range && selection) {
      selection.removeAllRanges();
      selection.addRange(editing.range);
    }
    if (/^(bold|italic|underline|unlink|insertUnorderedList|insertOrderedList)$/.test(command)) doc.execCommand(command);
    else if (command === "link" && typeof value === "string" && /^(https?:|mailto:|#|\\/)/i.test(value) && value.length <= 2000) {
      doc.execCommand("createLink", false, value);
    } else if (command === "align" && /^(left|center|right)$/.test(value)) element.style.textAlign = value;
    else if (command === "block" && /^(p|h1|h2|h3|h4)$/.test(value)) retag(value);
    if (editing) outline("edit", editing.element, EDIT_STYLE);
  };
  doc.addEventListener("dblclick", (event) => {
    if (!editAllowed || editing) return;
    const element = editableFrom(event.target);
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    startEdit(element);
  }, true);
  doc.addEventListener("mousedown", (event) => {
    if (editing && !editing.element.contains(event.target)) finishEdit(false);
  }, true);
  doc.addEventListener("click", (event) => {
    // A link being edited is words, not a way out of the page.
    if (editing && editing.element.contains(event.target)) event.preventDefault();
  }, true);
  doc.addEventListener("keydown", (event) => {
    if (!editing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finishEdit(true);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      finishEdit(false);
    }
  }, true);
  doc.addEventListener("input", () => {
    // The outline follows the element as its words grow or shrink.
    if (editing) outline("edit", editing.element, EDIT_STYLE);
  }, true);
  doc.addEventListener("selectionchange", () => {
    if (!editing) return;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editing.element.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      editing.range = selection.getRangeAt(0).cloneRange();
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    const type = data.type.indexOf(PREFIX) === 0 ? data.type.slice(PREFIX.length) : "";
    if (type === "hover-at") {
      const element = data.clear ? null : at(data.x, data.y);
      outline("hover", element && data.wide ? widen(element) : element, NEUTRAL);
    } else if (type === "pick-at") {
      let element = at(data.x, data.y);
      if (element && data.wide) element = widen(element);
      outline("hover", null);
      const sx = window.scrollX || 0;
      const sy = window.scrollY || 0;
      send("picked", {
        requestId: data.requestId,
        element: element ? describe(element) : null,
        point: [Math.round(data.x + sx), Math.round(data.y + sy)],
      });
    } else if (type === "locate") {
      const items = Array.isArray(data.items) ? data.items.slice(0, 200) : [];
      const results = {};
      for (const item of items) {
        const found = locate(item);
        if (found) results[item.commentId] = found;
      }
      send("anchors", { requestId: data.requestId, results });
    } else if (type === "highlight") {
      const element = !data.clear && typeof data.commentId === "string" ? byComment(data.commentId) : null;
      const fallback = !element && !data.clear && typeof data.selector === "string" ? (() => {
        try {
          return doc.querySelector(data.selector);
        } catch {
          return null;
        }
      })() : null;
      outline("highlight", element || fallback, STRONG);
    } else if (type === "set-tweaks") {
      applyTweaks(data);
    } else if (type === "edit-enable") {
      editAllowed = data.on === true;
      if (!editAllowed) finishEdit(false);
    } else if (type === "edit-command") {
      runEdit(String(data.command || ""), data.value);
    } else if (type === "edit-finish") {
      finishEdit(data.cancel === true);
    }
  });
})();
`;
