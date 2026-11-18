// A page's declared tweaks, the values a frame keeps, and the address an
// export draws from.

import assert from "node:assert/strict";
import test from "node:test";
import {
  bakeDesignTweakDefaults,
  cleanDesignTweakText,
  designTweakState,
  designTweakSummary,
  nextDesignTweakVersionName,
  parseDesignTweakVersions,
  shuffleDesignTweaks,
  showsDesignTweakVersion,
  extractDesignTweakControls,
  parseDesignTweakValues,
  readDesignTweak,
  withDesignTweak,
  withDesignTweakQuery,
  type DesignTweakControl,
} from "./tweaks";

const PAGE = `<!doctype html><html><head>
<script type="application/aiden-tweaks">
{ "controls": [
  { "id": "accent", "label": "Accent", "type": "color", "default": "#2F6FED", "var": "--accent" },
  { "id": "density", "label": "Density", "type": "choice", "options": ["compact", "cozy", "cozy"], "default": "cozy", "attr": "data-density" },
  { "id": "radius", "label": "Corners", "type": "number", "min": 0, "max": 24, "step": 2, "unit": "px", "default": 40, "var": "--radius" },
  { "id": "promo", "label": "Promo banner", "type": "switch", "default": true, "attr": "data-promo" }
] }
</script></head><body></body></html>`;

const byId = (controls: DesignTweakControl[], id: string) =>
  controls.find((control) => control.id === id)! as DesignTweakControl & { default?: unknown };

test("a page's declaration is read into controls, with defaults kept in range", () => {
  const controls = extractDesignTweakControls(PAGE);
  assert.deepEqual(
    controls.map((control) => [control.id, control.type]),
    [["accent", "color"], ["density", "choice"], ["radius", "number"], ["promo", "switch"]],
  );
  assert.equal(byId(controls, "accent").default, "#2f6fed");
  const density = byId(controls, "density");
  assert.ok(density.type === "choice");
  assert.deepEqual(density.options, ["compact", "cozy"], "repeated options are listed once");
  assert.equal(byId(controls, "radius").default, 24, "a default past the maximum is held at it");
});

test("a page with no declaration, broken JSON or unusable controls has none", () => {
  assert.deepEqual(extractDesignTweakControls("<html><body>Plain</body></html>"), []);
  assert.deepEqual(extractDesignTweakControls('<script type="application/aiden-tweaks">{ nope</script>'), []);
  const controls = extractDesignTweakControls(`<script type='application/aiden-tweaks'>[
    { "id": "a", "type": "switch", "var": "accent" },
    { "id": "b c", "type": "switch", "var": "--b" },
    { "id": "d", "type": "choice", "options": ["only"], "attr": "data-d" },
    { "id": "e", "type": "choice", "options": ["x", "y; color: red"], "attr": "data-e" },
    { "id": "f", "type": "number", "min": 5, "max": 5, "var": "--f" },
    { "id": "g", "type": "slider", "var": "--g" },
    { "id": "h", "type": "switch", "attr": "onclick" },
    { "id": "i", "type": "switch", "var": "--i" },
    { "id": "i", "type": "switch", "var": "--j" },
    { "id": "k", "type": "switch", "var": "--i" }
  ]</script>`);
  assert.deepEqual(controls.map((control) => control.id), ["i"], "only one control per id and per target survives");
});

test("a frame keeps only what differs from the page, in the form the page reads", () => {
  const controls = extractDesignTweakControls(PAGE);
  const accent = byId(controls, "accent");
  const radius = byId(controls, "radius");
  const promo = byId(controls, "promo");
  let values = withDesignTweak(undefined, accent, "#FF0055");
  assert.equal(withDesignTweak(undefined, radius, 30), undefined, "past the maximum is the default here, so nothing is kept");
  values = withDesignTweak(values, radius, 12);
  values = withDesignTweak(values, promo, false);
  assert.deepEqual(values, { "--accent": "#ff0055", "--radius": "12px", "data-promo": "false" });
  assert.equal(readDesignTweak(accent, values), "#ff0055");
  assert.equal(readDesignTweak(radius, values), 12);
  assert.equal(readDesignTweak(promo, values), false);
  assert.equal(readDesignTweak(byId(controls, "density"), values), "cozy", "an untouched control shows the page's default");

  values = withDesignTweak(values, accent, "#2f6fed");
  values = withDesignTweak(values, radius, 24);
  assert.deepEqual(values, { "data-promo": "false" }, "going back to the default drops the value");
  assert.equal(withDesignTweak(values, promo, true), undefined);

  const flag: DesignTweakControl = { id: "flag", label: "Flag", type: "switch", default: false, target: { var: "--flag" } };
  assert.deepEqual(withDesignTweak(undefined, flag, true), { "--flag": "1" }, "a variable switch is 1 or 0, for calc()");
});

test("stored values are read back safely and split for the bridge", () => {
  assert.equal(parseDesignTweakValues(["--a"]), undefined);
  assert.deepEqual(
    parseDesignTweakValues({ "--a": "1", color: "red", "--b": "x;y", "data-c": "url(evil)", "data-d": "on", "--e": 4 }),
    { "--a": "1", "data-d": "on" },
  );
  assert.deepEqual(designTweakState({ dark: true, tweaks: { "--a": "1", "data-d": "on" } }), {
    dark: true,
    vars: { "--a": "1" },
    attrs: { "data-d": "on" },
  });
  assert.deepEqual(designTweakState({}), { dark: false, vars: {}, attrs: {} });
});

test("the export address keeps the page's own query and fragment and adds nothing for an untweaked page", () => {
  const plain = designTweakState({});
  assert.equal(withDesignTweakQuery("aiden-design://g/a.html?v=3", plain), "aiden-design://g/a.html?v=3");
  const tweaked = withDesignTweakQuery("aiden-design://g/a.html?v=3#top", designTweakState({ dark: true, tweaks: { "--a": "#ff0055" } }));
  const url = new URL(tweaked.replace(/^aiden-design:/u, "https:"));
  assert.equal(url.searchParams.get("v"), "3");
  assert.equal(url.searchParams.get("aiden-dark"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("aiden-tweaks")!), { vars: { "--a": "#ff0055" }, attrs: {} });
  assert.equal(url.hash, "#top");
});

const RICH = `<!doctype html><html lang="en"><head><style>:root { --accent: #2f6fed; }</style>
<script type="application/aiden-tweaks">
{ "controls": [
  { "id": "accent", "label": "Accent", "type": "color", "default": "#2f6fed", "var": "--accent", "group": "Colour" },
  { "id": "radius", "label": "Corners", "type": "number", "min": 0, "max": 24, "step": 4, "unit": "px", "default": 8, "var": "--radius", "group": "Shape" },
  { "id": "density", "label": "Density", "type": "choice", "options": ["compact", "cozy"], "default": "cozy", "attr": "data-density", "group": "Shape" },
  { "id": "headline", "label": "Headline", "type": "text", "default": "Make room", "attr": "data-headline" },
  { "id": "shadow", "label": "Shadow", "type": "pad",
    "x": { "label": "Distance", "var": "--shadow-y", "min": 0, "max": 32, "step": 2, "unit": "px", "default": 8 },
    "y": { "label": "Blur", "var": "--shadow-blur", "min": 0, "max": 64, "step": 4, "unit": "px", "default": 24 } },
  { "id": "replay", "label": "Replay", "type": "action" }
] }
</script></head><body><h1 data-aiden-text="headline">Make room</h1></body></html>`;

test("folders, words, pads and actions are read from a declaration", () => {
  const controls = extractDesignTweakControls(RICH);
  assert.deepEqual(
    controls.map((control) => [control.id, control.type, control.group]),
    [
      ["accent", "color", "Colour"],
      ["radius", "number", "Shape"],
      ["density", "choice", "Shape"],
      ["headline", "text", undefined],
      ["shadow", "pad", undefined],
      ["replay", "action", undefined],
    ],
  );
  const refused = extractDesignTweakControls(`<script type="application/aiden-tweaks">[
    { "id": "t", "type": "text", "var": "--t" },
    { "id": "p", "type": "pad", "x": { "var": "--a" }, "y": { "var": "--a" } },
    { "id": "q", "type": "pad", "x": { "var": "--b", "min": 4, "max": 1 }, "y": { "var": "--c" } }
  ]</script>`);
  assert.deepEqual(refused, [], "words never go in a style property, and a pad needs two different targets with real ranges");
});

test("a page keeps at most 24 targets with a pad counting twice, 8 actions and 8 folders", () => {
  const pads = Array.from({ length: 13 }, (_, index) => ({
    id: `p${index}`,
    type: "pad",
    x: { var: `--x${index}` },
    y: { var: `--y${index}` },
  }));
  const actions = Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, type: "action" }));
  const folders = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, type: "switch", attr: `data-s${index}`, group: `G${index}` }));
  const controls = extractDesignTweakControls(
    `<script type="application/aiden-tweaks">${JSON.stringify([...pads, ...actions])}</script>`,
  );
  assert.equal(controls.filter((control) => control.type === "pad").length, 12);
  assert.equal(controls.filter((control) => control.type === "action").length, 8);
  const grouped = extractDesignTweakControls(`<script type="application/aiden-tweaks">${JSON.stringify(folders)}</script>`);
  assert.equal(new Set(grouped.map((control) => control.group).filter(Boolean)).size, 8);
  assert.equal(grouped.length, 10, "a control past the eighth folder is kept, outside any folder");
});

test("a pad keeps both axes, each in its own range, and drops an axis back at its default", () => {
  const pad = byId(extractDesignTweakControls(RICH), "shadow");
  assert.ok(pad.type === "pad");
  let values = withDesignTweak(undefined, pad, { x: 40, y: 12 });
  assert.deepEqual(values, { "--shadow-y": "32px", "--shadow-blur": "12px" });
  assert.deepEqual(readDesignTweak(pad, values), { x: 32, y: 12 });
  values = withDesignTweak(values, pad, { x: 8, y: 12 });
  assert.deepEqual(values, { "--shadow-blur": "12px" });
  const action = byId(extractDesignTweakControls(RICH), "replay");
  assert.equal(withDesignTweak(values, action, true), values, "an action keeps nothing");
});

test("typed words are made safe for the page", () => {
  assert.equal(cleanDesignTweakText(`Don't "panic"; <b>now</b>\nplease`), "Don\u2019t \u201cpanic\u201d bnow/b please");
  assert.equal(cleanDesignTweakText("x".repeat(150)).length, 100);
  const headline = byId(extractDesignTweakControls(RICH), "headline");
  assert.deepEqual(withDesignTweak(undefined, headline, "It's {live}"), { "data-headline": "It\u2019s live" });
});

test("shuffle picks values inside every range and on every step, and leaves words alone", () => {
  const controls = extractDesignTweakControls(RICH);
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const start = withDesignTweak(undefined, byId(controls, "headline"), "Kept");
  for (let round = 0; round < 50; round += 1) {
    const values = shuffleDesignTweaks(controls, start, random);
    assert.equal(values?.["data-headline"], "Kept");
    const radius = readDesignTweak(byId(controls, "radius"), values) as number;
    assert.ok(radius >= 0 && radius <= 24 && radius % 4 === 0, `radius ${radius}`);
    const shadow = readDesignTweak(byId(controls, "shadow"), values) as { x: number; y: number };
    assert.ok(shadow.x % 2 === 0 && shadow.x <= 32 && shadow.y % 4 === 0 && shadow.y <= 64);
    assert.match(values?.["--accent"] ?? "#2f6fed", /^#[0-9a-f]{6}$/u);
  }
});

test("the hand-off lists every value and marks the changed ones", () => {
  const controls = extractDesignTweakControls(RICH);
  let values = withDesignTweak(undefined, byId(controls, "radius"), 16);
  values = withDesignTweak(values, byId(controls, "shadow"), { x: 8, y: 40 });
  assert.equal(
    designTweakSummary(controls, values, { dark: true, version: "V2" }),
    [
      "Tweaks values (V2):",
      "- Colour / Accent: #2f6fed",
      "- Shape / Corners: 16px (changed)",
      "- Shape / Density: cozy",
      "- Headline: Make room",
      "- Shadow: Distance 8px, Blur 40px (changed)",
      "- Dark: on",
    ].join("\n"),
  );
});

test("make default writes the values into the declaration, the page's look and its words", () => {
  const controls = extractDesignTweakControls(RICH);
  let values = withDesignTweak(undefined, byId(controls, "radius"), 16);
  values = withDesignTweak(values, byId(controls, "density"), "compact");
  values = withDesignTweak(values, byId(controls, "headline"), "Plan less");
  const baked = bakeDesignTweakDefaults(RICH, values);
  assert.ok(baked.ok);
  const after = extractDesignTweakControls(baked.source);
  assert.equal(byId(after, "radius").type === "number" && byId(after, "radius").default, 16);
  assert.equal(readDesignTweak(byId(after, "density"), undefined), "compact");
  assert.match(baked.source, /<style data-aiden-tweaks>\n:root \{ --radius: 16px; \}\n<\/style>\n<\/head>/u);
  assert.match(baked.source, /<html lang="en" data-density="compact" data-headline="Plan less">/u);
  assert.deepEqual(baked.textChanges, [{ target: "data-headline", before: "Make room", after: "Plan less" }]);
  assert.ok(baked.source.includes("<h1 data-aiden-text=\"headline\">Make room</h1>"), "words are placed by the text-edit rules, not here");

  const again = bakeDesignTweakDefaults(baked.source, withDesignTweak(undefined, byId(after, "accent"), "#ff0055"));
  assert.ok(again.ok);
  assert.equal((again.source.match(/data-aiden-tweaks>/gu) ?? []).length, 1, "one managed block, merged");
  assert.match(again.source, /:root \{ --radius: 16px; --accent: #ff0055; \}/u);
  assert.deepEqual(bakeDesignTweakDefaults(RICH, undefined), { ok: false, reason: "unchanged" });
  assert.deepEqual(bakeDesignTweakDefaults("<html><body></body></html>", values), { ok: false, reason: "not-found" });
});

test("versions are read back bounded and matched by their values and Dark switch", () => {
  assert.equal(parseDesignTweakVersions("nope"), undefined);
  const versions = parseDesignTweakVersions([
    { id: "v2", name: "V2", tweaks: { "--a": "1", "--b": "x;y" }, dark: true },
    { id: "v2", name: "Again" },
    { id: "bad id", name: "V3" },
    { id: "v4", name: "  " },
    ...Array.from({ length: 20 }, (_, index) => ({ id: `n${index}`, name: `N${index}` })),
  ]);
  assert.equal(versions?.length, 12);
  assert.deepEqual(versions?.[0], { id: "v2", name: "V2", tweaks: { "--a": "1" }, dark: true });
  assert.equal(showsDesignTweakVersion({ tweaks: { "--a": "1" }, dark: true }, versions![0]!), true);
  assert.equal(showsDesignTweakVersion({ tweaks: { "--a": "1" } }, versions![0]!), false);
  assert.equal(nextDesignTweakVersionName([{ id: "a", name: "V2" }, { id: "b", name: "V4" }]), "V3");
});
