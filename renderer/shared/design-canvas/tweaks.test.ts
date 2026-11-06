// A page's declared tweaks, the values a frame keeps, and the address an
// export draws from.

import assert from "node:assert/strict";
import test from "node:test";
import {
  designTweakState,
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

const byId = (controls: DesignTweakControl[], id: string) => controls.find((control) => control.id === id)!;

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
