import assert from "node:assert/strict";
import { test } from "node:test";
import { SVG_PREVIEW_MAX_BYTES, svgPreviewSource } from "./svg-fence-preview.js";

const PREFIX = "data:image/svg+xml;charset=utf-8,";
const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

function decode(url: string): string {
  assert.ok(url.startsWith(PREFIX), `expected a data URL, got ${url.slice(0, 40)}`);
  return decodeURIComponent(url.slice(PREFIX.length));
}

test("a complete svg fence becomes a data URL that decodes to the trimmed source", () => {
  const url = svgPreviewSource(`\n  ${CIRCLE}\n\n`, "svg");
  assert.ok(url);
  assert.equal(decode(url), CIRCLE);
});

test("the language must be svg in any case", () => {
  assert.ok(svgPreviewSource(CIRCLE, "SVG"));
  assert.equal(svgPreviewSource(CIRCLE, "xml"), null);
  assert.equal(svgPreviewSource(CIRCLE, "html"), null);
  assert.equal(svgPreviewSource(CIRCLE, undefined), null);
});

test("an xml prolog and leading comments are allowed before the svg element", () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by the agent -->\n${CIRCLE}`;
  const url = svgPreviewSource(source, "svg");
  assert.ok(url);
  assert.equal(decode(url), source);
});

test("an Inkscape or Illustrator doctype is allowed before the svg element", () => {
  const inkscape = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    "<!-- Created with Inkscape (http://www.inkscape.org/) -->",
    "",
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"',
    '  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
    '   width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg8">',
    '  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">',
    '    <circle style="fill:#000000" cx="105" cy="148" r="40" id="path10" />',
    "  </g>",
    "</svg>",
  ].join("\n");
  assert.equal(decode(svgPreviewSource(inkscape, "svg")!), inkscape);

  // Illustrator adds an internal subset of entities, with "]" and ">" inside it.
  const illustrator = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->",
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [',
    '\t<!ENTITY ns_flows "http://ns.adobe.com/Flows/1.0/">',
    '\t<!ENTITY note "a]b>c">',
    "]>",
    '<svg version="1.1" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
  ].join("\n");
  const drawn = decode(svgPreviewSource(illustrator, "svg")!);
  assert.ok(
    drawn.endsWith('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'),
    "the namespace goes on the root, not inside the doctype",
  );

  // Only one doctype, and only before the root.
  assert.equal(svgPreviewSource(`<!DOCTYPE svg>\n<!DOCTYPE svg>\n${CIRCLE}`, "svg"), null);
  assert.equal(svgPreviewSource(`<!DOCTYPE svg [ <!ENTITY a "b">`, "svg"), null);
});

test("a fence that is not one whole svg element has no preview", () => {
  assert.equal(svgPreviewSource('<svg viewBox="0 0 10 10"><circle r="4"/>', "svg"), null);
  assert.equal(svgPreviewSource("<div><svg></svg></div>", "svg"), null);
  assert.equal(svgPreviewSource("<svgfoo></svg>", "svg"), null);
  assert.equal(svgPreviewSource("", "svg"), null);
});

test("a source over the UTF-8 cap has no preview, one at the cap does", () => {
  const open = '<svg xmlns="http://www.w3.org/2000/svg"><path d="';
  const close = '"/></svg>';
  const fill = (bytes: number, char: string, charBytes: number) =>
    char.repeat(Math.floor((bytes - open.length - close.length) / charBytes));
  const atCap = `${open}${fill(SVG_PREVIEW_MAX_BYTES, "M", 1)}${close}`;
  assert.equal(new TextEncoder().encode(atCap).length, SVG_PREVIEW_MAX_BYTES);
  assert.ok(svgPreviewSource(atCap, "svg"));
  assert.equal(svgPreviewSource(`${open}M${atCap.slice(open.length)}`, "svg"), null);
  // Fewer characters than the cap but more bytes once encoded.
  const multibyte = `${open}${fill(SVG_PREVIEW_MAX_BYTES + 3, "é", 2)}${close}`;
  assert.ok(multibyte.length < SVG_PREVIEW_MAX_BYTES);
  assert.equal(svgPreviewSource(multibyte, "svg"), null);
  // Whitespace around the fence counts toward the cap, as on the iPhone.
  assert.equal(svgPreviewSource(`${atCap}\n`, "svg"), null);
});

test("a root without a namespace gets the SVG namespace so the browser can draw it", () => {
  const bare = '<svg viewBox="0 0 10 10" data-note="xmlns=nope"><circle r="4"/></svg>';
  assert.equal(
    decode(svgPreviewSource(bare, "svg")!),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-note="xmlns=nope"><circle r="4"/></svg>',
  );
  const prolog = '<?xml version="1.0"?>\n<!-- <svg> -->\n<svg\n  width="4"><path d="M0 0"/></svg>';
  assert.equal(
    decode(svgPreviewSource(prolog, "svg")!),
    '<?xml version="1.0"?>\n<!-- <svg> -->\n<svg xmlns="http://www.w3.org/2000/svg"\n  width="4"><path d="M0 0"/></svg>',
  );
  const xlinkOnly = '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>';
  assert.ok(
    decode(svgPreviewSource(xlinkOnly, "svg")!).startsWith(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink=',
    ),
  );
});

test("a root that already names a default namespace is left as written", () => {
  for (const source of [
    CIRCLE,
    "<svg xmlns='http://www.w3.org/2000/svg'><g/></svg>",
    '<svg xmlns=""><g/></svg>',
  ]) {
    assert.equal(decode(svgPreviewSource(source, "svg")!), source);
  }
});
