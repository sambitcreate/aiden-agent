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
// - `anchors` {requestId, results}: what each comment's element looks like now.
// Messages from the canvas:
// - `hover-at` {x, y} | {clear}: outline the element under a point;
// - `pick-at` {requestId, x, y, wide}: describe the element under a point,
//   or its parent when `wide`;
// - `locate` {requestId, items: [{commentId, selector, text, tag}]};
// - `highlight` {commentId} | {clear}.
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
    }
  });
})();
`;
