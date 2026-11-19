// What canvas_inspect tells Aiden about a page, from what the hidden window
// saw. The window itself is Electron; here a stand-in returns what it would
// have seen, and the in-page probe runs against a happy-dom page.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Window } from "happy-dom";
import {
  designInspectFindings,
  designInspectPictureWindow,
  designInspectProbeScript,
  inspectDesignPage,
  readDesignConsoleMessage,
  type DesignInspectProbe,
  type DesignInspectRequest,
} from "./inspect.js";

const PAGE = "aiden-design://grant-1/design/home.html";

const quiet = (overrides: Partial<DesignInspectProbe> = {}): DesignInspectProbe => ({
  height: 1800,
  scrollWidth: 1280,
  overflowing: [],
  console: [],
  brokenImages: [],
  failedFonts: [],
  tweaksRead: [],
  readsTheme: true,
  ...overrides,
});

const context = { path: "design/home.html", width: 1280, controls: [], dark: false };

test("console errors become script errors with their file and line, and blocked or missing loads", () => {
  assert.deepEqual(
    readDesignConsoleMessage({ level: "error", message: "Uncaught ReferenceError: chart is not defined", lineNumber: 41, sourceId: "aiden-design://grant-1/design/app.js" }),
    { kind: "script", message: "ReferenceError: chart is not defined", line: 41, source: "aiden-design://grant-1/design/app.js" },
  );
  assert.deepEqual(
    readDesignConsoleMessage({
      level: "error",
      message: "Refused to load the font 'https://fonts.gstatic.com/s/inter.woff2' because it violates the following Content Security Policy directive: \"font-src aiden-design: data:\".",
    }),
    { kind: "load", url: "https://fonts.gstatic.com/s/inter.woff2" },
  );
  assert.deepEqual(
    readDesignConsoleMessage({ level: "error", message: "Failed to load resource: net::ERR_FILE_NOT_FOUND", sourceId: "aiden-design://grant-1/design/img/hero.png" }),
    { kind: "load", url: "aiden-design://grant-1/design/img/hero.png" },
  );
  assert.equal(readDesignConsoleMessage({ level: "warning", message: "Something deprecated" }), null);
  assert.equal(readDesignConsoleMessage({ level: "info", message: "hello from the page" }), null);
});

test("a page with a script error, a network font, a missing image and sideways overflow gets one finding for each", () => {
  const findings = designInspectFindings(
    quiet({
      scrollWidth: 1460,
      overflowing: ["div.pricing-table"],
      console: [
        { level: "error", message: "Uncaught TypeError: Cannot read properties of null (reading 'append')", lineNumber: 12, sourceId: `${PAGE}?aiden-dark=1` },
        { level: "error", message: "Uncaught TypeError: Cannot read properties of null (reading 'append')", lineNumber: 12, sourceId: `${PAGE}?aiden-dark=1` },
        { level: "error", message: "Refused to load the stylesheet 'https://fonts.googleapis.com/css2?family=Inter' because it violates…" },
        { level: "error", message: "Failed to load resource: the server responded with a status of 404 ()", sourceId: "aiden-design://grant-1/design/img/hero%20shot.png" },
      ],
      brokenImages: ["aiden-design://grant-1/design/img/hero%20shot.png"],
      failedFonts: ['"Inter"'],
    }),
    context,
  );
  assert.equal(findings.length, 5, findings.join("\n"));
  assert.match(findings[0]!, /line 12 of design\/home\.html: TypeError: Cannot read properties of null/u);
  assert.match(findings[1]!, /^https:\/\/fonts\.googleapis\.com\/css2 did not load: design pages load nothing from the network/u);
  assert.match(findings[2]!, /^design\/img\/hero shot\.png did not load: there is no such file in the workspace/u);
  assert.match(findings[3]!, /font "Inter" did not load/u);
  assert.match(findings[4]!, /1460px wide at its 1280px design width.*div\.pricing-table reaches past the right edge/u);
});

test("tweak controls the page never reads, and tweak names the frame sets that nothing reads, are reported", () => {
  const findings = designInspectFindings(quiet({ tweaksRead: ["--accent", "data-density", "--hidden-extra"] }), {
    ...context,
    controls: [
      { id: "accent", label: "Accent", type: "color", default: "#2f6fed", target: { var: "--accent" } },
      { id: "radius", label: "Corners", type: "number", min: 0, max: 24, step: 2, unit: "px", default: 8, target: { var: "--radius" } },
      { id: "density", label: "Density", type: "choice", options: ["compact", "cozy"], default: "cozy", target: { attr: "data-density" } },
    ],
    // --accnet is a typo; --hidden-extra is read by the page though no control declares it.
    frameTweaks: { "--accent": "#00aa00", "--accnet": "#ff0000", "--hidden-extra": "4px" },
  });
  assert.equal(findings.length, 2, findings.join("\n"));
  assert.match(findings[0]!, /"Corners" sets --radius, but nothing on the page reads it/u);
  assert.match(findings[1]!, /sets the tweak --accnet, which no control declares and nothing on the page reads/u);
});

test("a dark frame whose page never reads data-theme is told it only changes the browser's colours", () => {
  assert.equal(designInspectFindings(quiet({ readsTheme: true }), { ...context, dark: true }).length, 0);
  const findings = designInspectFindings(quiet({ readsTheme: false }), { ...context, dark: true });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /dark look, but nothing on the page reads data-theme/u);
  assert.equal(designInspectFindings(quiet({ readsTheme: false }), context).length, 0, "a light frame needs no dark styles");
});

test("the picture is cut to a size models read well: wide pages scale down, tall ones are shown a part at a time", () => {
  assert.deepEqual(designInspectPictureWindow(390, 3000, 0), { top: 0, height: 1280, scale: 1 });
  const wide = designInspectPictureWindow(1440, 5000, 0);
  assert.ok(Math.round(1440 * wide.scale) <= 1024 && Math.round(wide.height * wide.scale) <= 1280);
  assert.equal(wide.top, 0);
  const lower = designInspectPictureWindow(1280, 2000, 1600);
  assert.deepEqual({ top: lower.top, height: lower.height }, { top: 1600, height: 400 }, "the last part ends at the page's foot");
  assert.equal(designInspectPictureWindow(1280, 900, 5000).top, 899, "a top past the page shows its last line");
});

test("the in-page probe finds the tweak names a page's styles and scripts read, and whether it reads data-theme", () => {
  const window = new Window({ url: "aiden-design://grant-1/design/home.html" });
  window.document.write(`<!doctype html><html><head>
    <style>.card { color: var(--accent); padding: var( --pad ) } [data-density="compact"] .card { gap: 4px }
      :root[data-theme="dark"] { background: #000 } .x { color: var(--accent-strong) }</style>
    <script type="application/aiden-tweaks">{"controls":[{"id":"r","label":"R","type":"number","min":0,"max":9,"step":1,"unit":"px","default":2,"var":"--radius"}]}</script>
  </head><body><div style="margin: var(--gap)"></div>
    <script>if (document.body.dataset.promoOn === "true") {} document.body.style.setProperty('--radius', '2px');</script>
  </body></html>`);
  const seen = window.eval(
    designInspectProbeScript(["--accent", "--accen", "--pad", "--gap", "data-density", "data-promo-on", "--radius", "data-missing"], 1280),
  ) as { tweaksRead: string[]; readsTheme: boolean };
  assert.deepEqual([...seen.tweaksRead].sort(), ["--accent", "--gap", "--pad", "--radius", "data-density", "data-promo-on"].sort());
  assert.equal(seen.readsTheme, true);

  const plain = new Window({ url: "aiden-design://grant-1/design/plain.html" });
  plain.document.write("<!doctype html><html><head><style>body { color: #111 }</style></head><body></body></html>");
  assert.equal((plain.eval(designInspectProbeScript([], 1280)) as { readsTheme: boolean }).readsTheme, false);
});

test("inspectDesignPage draws the frame's own look at its design width and reports its controls, picture and findings", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-inspect-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "design"));
  await fs.writeFile(
    path.join(workspace, "design", "phone.html"),
    `<script type="application/aiden-tweaks">{"controls":[
      {"id":"accent","label":"Accent","type":"color","default":"#2f6fed","var":"--accent"},
      {"id":"promo","label":"Promo","type":"switch","default":true,"attr":"data-promo"}]}</script><p>Hi</p>`,
  );
  const requests: DesignInspectRequest[] = [];
  const render = async (request: DesignInspectRequest): Promise<DesignInspectProbe> => {
    requests.push(request);
    return quiet({
      height: 2600,
      scrollWidth: 390,
      tweaksRead: ["--accent"],
      ...(request.picture ? { picture: { data: "anBlZw==", mimeType: "image/jpeg", top: request.picture.top, height: 1280 } } : {}),
    });
  };
  const frame = { kind: "file" as const, path: "design/phone.html", designWidth: 390 as const, w: 390, dark: true as const, tweaks: { "--accent": "#00aa00" } };
  const seen = await inspectDesignPage({
    workspaceRoot: workspace,
    frame,
    pageUrl: (relativePath) => `aiden-design://grant-1/${relativePath}`,
    render,
    picture: { top: 0 },
    seesImages: true,
  });
  assert.equal(requests[0]!.width, 390);
  const url = new URL(requests[0]!.url);
  assert.equal(url.searchParams.get("aiden-dark"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("aiden-tweaks")!), { vars: { "--accent": "#00aa00" }, attrs: {} });
  assert.deepEqual(requests[0]!.tweakTargets.sort(), ["--accent", "data-promo"]);
  assert.deepEqual(seen.image, { data: "anBlZw==", mimeType: "image/jpeg" });
  assert.match(seen.text, /^Inspected design\/phone\.html at 390px wide \(dark, with the frame's tweaks\): the page is 2600px tall\./u);
  assert.match(seen.text, /Tweak controls: 1 of 2 read by the page\./u);
  assert.match(seen.text, /shows 0–1280px of it\. Pass top: 1280 to see further down\./u);
  assert.match(seen.text, /Inspect: 1 problem found\./u);
  assert.match(seen.text, /"Promo" sets data-promo, but nothing on the page reads it/u);

  const blind = await inspectDesignPage({
    workspaceRoot: workspace,
    frame: { ...frame, dark: undefined, tweaks: undefined },
    pageUrl: (relativePath) => `aiden-design://grant-1/${relativePath}`,
    render,
    picture: { top: 0 },
    seesImages: false,
  });
  assert.equal(requests[1]!.picture, undefined, "no picture is drawn for a model that can't see it");
  assert.equal(blind.image, undefined);
  assert.match(blind.text, /No picture: this model can't see images, so this is the text report only\./u);

  const missing = await inspectDesignPage({
    workspaceRoot: workspace,
    frame: { ...frame, path: "design/gone.html" },
    pageUrl: (relativePath) => `aiden-design://grant-1/${relativePath}`,
    render,
    picture: null,
    seesImages: true,
  });
  assert.equal(requests.length, 2, "a missing page is not drawn");
  assert.match(missing.text, /design\/gone\.html is not in the workspace/u);
});
