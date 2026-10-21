import assert from "node:assert/strict";
import test from "node:test";
import { VISUAL_VIEWER_CSP, VISUAL_VIEWER_PAYLOAD_ELEMENT_ID, type VisualViewerPayload } from "../../renderer/shared/visual-viewer.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import {
  MAX_VISUAL_VIEWER_DOCUMENT_BYTES,
  buildVisualViewerDocument,
  parseVisualViewerQuery,
  visualViewerDocumentEtag,
} from "./visual-viewer-document.js";

const BUNDLE = { script: "window.__viewer = true;", style: "main{color:red}" };
const LIBRARIES = {
  "chart.js": "/* CHART-SOURCE */ window.Chart = function () {};",
  "plotly.js": "/* PLOTLY-SOURCE */ window.Plotly = {};",
  "katex.js": "/* KATEX-SOURCE */",
  "katex.css": "/* KATEX-STYLE */",
};
const LIGHT = { scheme: "light" as const, preset: "aiden" as const };

function payloadOf(document: string): VisualViewerPayload {
  const match = new RegExp(`<script type="application/json" id="${VISUAL_VIEWER_PAYLOAD_ELEMENT_ID}">([^<]*)</script>`, "u").exec(document);
  assert.ok(match, "the document carries its payload element");
  return JSON.parse(match[1]!) as VisualViewerPayload;
}

const UI_VISUAL: ChatUiVisualV1 = {
  version: 1,
  kind: "ui",
  id: "ui-1",
  title: "Plan options",
  catalogVersion: 1,
  tree: { t: "Visual", k: "0", c: [{ t: "#text", k: "0.0", s: "Team" }] },
  fallbackText: "Plan options: Team",
};

test("viewer query defaults to the light Aiden theme and falls back for presets this host does not know", () => {
  assert.deepEqual(parseVisualViewerQuery(new URLSearchParams("")), LIGHT);
  assert.deepEqual(parseVisualViewerQuery(new URLSearchParams("scheme=dark&theme=midnight")), { scheme: "dark", preset: "midnight" });
  assert.deepEqual(parseVisualViewerQuery(new URLSearchParams("theme=aurora-2")), LIGHT);
  for (const bad of ["scheme=sepia", "theme=Mid night", "theme=%3Cx%3E", "scheme=dark&scheme=light", "theme=aiden&extra=1"]) {
    assert.throws(() => parseVisualViewerQuery(new URLSearchParams(bad)), Error, bad);
  }
});

test("an HTML visual travels as a sandboxed guest that cannot break out of the payload", () => {
  const html = `<div id="x"></div></script><script>alert(1)</script><!-- --> \u2028 <script>new Chart(document.getElementById("x"), {})</script>`;
  const document = buildVisualViewerDocument({ kind: "html", title: "Totals <b>", html, layout: "wide" }, { scheme: "dark", preset: "dusk" }, BUNDLE, LIBRARIES);

  // Exactly the payload and the viewer script close a script element: the
  // model's markup stays inside the JSON string.
  assert.equal(document.match(/<\/script>/gu)?.length, 2);
  assert.match(document, new RegExp(`<meta http-equiv="Content-Security-Policy" content="${VISUAL_VIEWER_CSP.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}">`, "u"));
  assert.match(document, /<title>Totals &lt;b&gt;<\/title>/u);

  const payload = payloadOf(document);
  assert.equal(payload.kind, "html");
  assert.deepEqual(
    { title: payload.title, scheme: payload.scheme, preset: payload.preset, layout: payload.layout },
    { title: "Totals <b>", scheme: "dark", preset: "dusk", layout: "wide" },
  );
  const guest = payload.kind === "html" ? payload.guest : "";
  assert.ok(guest.includes(html.slice(0, 20)), "the guest keeps the model's markup");
  // The guest runs offline: its libraries are inline, nothing points at the desktop's custom protocol.
  assert.doesNotMatch(guest, /aiden-genui:\/\//u);
  assert.ok(guest.includes("CHART-SOURCE"));
  assert.ok(!guest.includes("PLOTLY-SOURCE"), "Plotly is left out when the visual never calls it");
  assert.ok(!guest.includes("KATEX-SOURCE"));
  assert.ok(guest.includes(".aiden-card"), "the component kit always ships");
});

test("an HTML visual that draws with Plotly or KaTeX gets those libraries", () => {
  const document = buildVisualViewerDocument(
    { kind: "html", title: "Fit", html: `<div id="p"></div><script>Plotly.newPlot("p", []); katex.render("x", p);</script>` },
    LIGHT,
    BUNDLE,
    LIBRARIES,
  );
  const payload = payloadOf(document);
  const guest = payload.kind === "html" ? payload.guest : "";
  assert.ok(guest.includes("PLOTLY-SOURCE") && guest.includes("KATEX-SOURCE") && guest.includes("KATEX-STYLE"));
  assert.ok(!guest.includes("CHART-SOURCE"));
});

test("a native visual carries its tree and only the images handed to it", () => {
  const document = buildVisualViewerDocument(
    {
      kind: "ui",
      title: "Plan options",
      visual: UI_VISUAL,
      attachments: [{ id: "photo-1", mimeType: "image/png", data: "AAAA", name: "ignored" } as never],
    },
    LIGHT,
    BUNDLE,
    LIBRARIES,
  );
  const payload = payloadOf(document);
  assert.equal(payload.kind, "ui");
  assert.deepEqual(payload.kind === "ui" && payload.visual, UI_VISUAL);
  assert.deepEqual(payload.kind === "ui" && payload.attachments, [{ id: "photo-1", mimeType: "image/png", data: "AAAA" }]);
  assert.ok(!document.includes("CHART-SOURCE"), "native visuals draw with the viewer bundle, not the guest libraries");
  assert.ok(document.includes(BUNDLE.script) && document.includes(BUNDLE.style));
});

test("documents refuse a bundle that could end its own element and anything over the size bound", () => {
  const source = { kind: "ui" as const, title: "Plan", visual: UI_VISUAL, attachments: [] };
  assert.throws(() => buildVisualViewerDocument(source, LIGHT, { ...BUNDLE, script: "x='</script>'" }, LIBRARIES), /cannot be inlined/u);
  assert.throws(() => buildVisualViewerDocument(source, LIGHT, { ...BUNDLE, style: "</style>" }, LIBRARIES), /cannot be inlined/u);
  const huge = { ...source, attachments: [{ id: "big", mimeType: "image/png", data: "A".repeat(MAX_VISUAL_VIEWER_DOCUMENT_BYTES) }] };
  assert.throws(() => buildVisualViewerDocument(huge, LIGHT, BUNDLE, LIBRARIES), /too large/u);
});

test("the document ETag changes with the document and only with it", () => {
  const first = buildVisualViewerDocument({ kind: "ui", title: "Plan", visual: UI_VISUAL, attachments: [] }, LIGHT, BUNDLE, LIBRARIES);
  const again = buildVisualViewerDocument({ kind: "ui", title: "Plan", visual: UI_VISUAL, attachments: [] }, LIGHT, BUNDLE, LIBRARIES);
  const dark = buildVisualViewerDocument({ kind: "ui", title: "Plan", visual: UI_VISUAL, attachments: [] }, { ...LIGHT, scheme: "dark" }, BUNDLE, LIBRARIES);
  assert.equal(visualViewerDocumentEtag(first), visualViewerDocumentEtag(again));
  assert.notEqual(visualViewerDocumentEtag(first), visualViewerDocumentEtag(dark));
  assert.match(visualViewerDocumentEtag(first), /^"[A-Za-z0-9_-]{43}"$/u);
});
