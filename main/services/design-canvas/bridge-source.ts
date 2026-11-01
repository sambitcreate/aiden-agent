// The one script main injects into every aiden-design HTML response, served
// from `__aiden/bridge.js`. Its contents are fixed; designs never supply it.
//
// P2 reports only the document height. The frame is sandboxed without
// same-origin, so the parent cannot be named as a target origin; the canvas
// checks `event.source === iframe.contentWindow` instead.

export const DESIGN_BRIDGE_SOURCE = `(() => {
  "use strict";
  if (window.parent === window) return;
  const post = (type) => {
    const root = document.documentElement;
    if (!root) return;
    try {
      window.parent.postMessage({ type, docHeight: Math.ceil(root.scrollHeight) }, "*");
    } catch {}
  };
  if (document.readyState === "complete") post("aiden-design:ready");
  else window.addEventListener("load", () => post("aiden-design:ready"), { once: true });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      post("aiden-design:resize");
    });
  };
  if (typeof ResizeObserver === "function" && document.documentElement) {
    new ResizeObserver(schedule).observe(document.documentElement);
  }
})();
`;
