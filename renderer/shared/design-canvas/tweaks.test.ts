// A page's declared tweaks, the values a frame keeps, and the address an
// export draws from.

import assert from "node:assert/strict";
import test from "node:test";
import {
  bakeDesignTweakDefaults,
  cleanDesignTweakText,
  isDesignTweakValue,
  designTweakState,
  designTweakSummary,
  nextDesignTweakVersionName,
  parseDesignTweakVersions,
  shuffleDesignTweaks,
  showsDesignTweakVersion,
  tweaksAfterBake,
  tweaksAfterBakeUndo,
  tweaksAfterTakenBackBake,
  tweaksTakenBackDuringBake,
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

test("a hand-off too long for one note keeps the changed values and says how many are left out", () => {
  const many: DesignTweakControl[] = Array.from({ length: 20 }, (_, index) => ({
    id: `n${index}`,
    label: `A rather long control label number ${index}`,
    type: "number",
    min: 0,
    max: 99,
    step: 1,
    unit: "px",
    default: 1,
    target: { var: `--n${index}` },
  }));
  const values = withDesignTweak(undefined, many[17]!, 40);
  const note = designTweakSummary(many, values, { maxChars: 400 });
  assert.ok(note.length <= 400);
  const lines = note.split("\n");
  assert.equal(lines[1], "- A rather long control label number 17: 40px (changed)");
  assert.match(lines[lines.length - 1]!, /^- …and \d+ more$/u);
  assert.equal(lines.length - 2 + Number(/(\d+) more/u.exec(lines[lines.length - 1]!)![1]), 20, "every control is shown or counted");
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
  assert.equal(readDesignTweak(byId(after, "headline"), undefined), "Plan less");
  assert.match(baked.source, /<style data-aiden-tweaks>\n:root:root:root \{ --radius: 16px; \}\n<\/style>\n<\/head>/u);
  assert.match(baked.source, /<html lang="en" data-density="compact" data-headline="Plan less">/u);
  assert.ok(baked.source.includes('<h1 data-aiden-text="headline">Plan less</h1>'));
  assert.deepEqual(baked.kept, []);
  // Every declared value the file now starts with, so the frame can let go of them.
  assert.equal(baked.written["--radius"], "16px");
  assert.equal(baked.written["--accent"], "#2f6fed");

  const again = bakeDesignTweakDefaults(baked.source, withDesignTweak(undefined, byId(after, "accent"), "#ff0055"));
  assert.ok(again.ok);
  assert.equal((again.source.match(/data-aiden-tweaks>/gu) ?? []).length, 1, "one managed block, merged");
  assert.match(again.source, /:root:root:root \{ --radius: 16px; --accent: #ff0055; \}/u);
  assert.deepEqual(bakeDesignTweakDefaults(RICH, undefined), { ok: false, reason: "unchanged" });
  assert.deepEqual(bakeDesignTweakDefaults("<html><body></body></html>", values), { ok: false, reason: "not-found" });
});

test("make default writes typed words as they are, even next to look-alike attributes", () => {
  const page = RICH.replace('<html lang="en">', '<html lang="en" data-headline="Old" data-density-mode="wide" class="data-density">');
  const controls = extractDesignTweakControls(page);
  for (const words of ["Save $& now", "Only $1 today", "$`$$"]) {
    let values = withDesignTweak(undefined, byId(controls, "headline"), words);
    values = withDesignTweak(values, byId(controls, "density"), "compact");
    const baked = bakeDesignTweakDefaults(page, values);
    assert.ok(baked.ok);
    const html = /<html[^>]*>/u.exec(baked.source)![0];
    assert.equal(
      html,
      `<html lang="en" data-headline="${words}" data-density-mode="wide" class="data-density" data-density="compact">`,
      words,
    );
    assert.equal(readDesignTweak(byId(extractDesignTweakControls(baked.source), "headline"), undefined), words);
  }
});

test("make default keeps the declaration a script, whatever its labels say", () => {
  const page = RICH.replace('"label": "Accent"', '"label": "A <\\/script><img src=x onerror=alert(1)>  "');
  assert.equal(byId(extractDesignTweakControls(page), "accent").label.startsWith("A </script>"), true);
  const baked = bakeDesignTweakDefaults(page, withDesignTweak(undefined, byId(extractDesignTweakControls(page), "radius"), 12));
  assert.ok(baked.ok);
  assert.ok(!baked.source.includes("<img"), "the label stays data");
  const after = extractDesignTweakControls(baked.source);
  assert.equal(after.length, 6);
  assert.equal(byId(after, "accent").label.startsWith("A </script><img"), true);
});

test("words that can't be placed leave that control as it was in the file", () => {
  // Two places say "Make room" and neither is marked: which one is meant isn't clear.
  const page = RICH.replace('<h1 data-aiden-text="headline">Make room</h1>', "<h1>Make room</h1><p>Make room</p>");
  const controls = extractDesignTweakControls(page);
  let values = withDesignTweak(undefined, byId(controls, "headline"), "Plan less");
  values = withDesignTweak(values, byId(controls, "radius"), 12);
  const baked = bakeDesignTweakDefaults(page, values);
  assert.ok(baked.ok);
  assert.deepEqual(baked.kept, ["data-headline"]);
  assert.equal(baked.written["data-headline"], undefined, "the frame keeps the words");
  assert.equal(readDesignTweak(byId(extractDesignTweakControls(baked.source), "headline"), undefined), "Make room");
  assert.ok(!baked.source.includes('data-headline="Plan less"'));
  // Only words, and none could be placed: nothing is written.
  assert.deepEqual(bakeDesignTweakDefaults(page, withDesignTweak(undefined, byId(controls, "headline"), "Plan less")), {
    ok: false,
    reason: "words",
  });
});

test("marked words are replaced wherever they stand, and a default with quotes is still found", () => {
  const marked = RICH.replace(
    '<h1 data-aiden-text="headline">Make room</h1>',
    '<h1 data-aiden-text="headline">\n    Make room\n  </h1><p data-aiden-text="headline">Make room</p>',
  );
  const controls = extractDesignTweakControls(marked);
  const baked = bakeDesignTweakDefaults(marked, withDesignTweak(undefined, byId(controls, "headline"), "Tom & Jerry"));
  assert.ok(baked.ok);
  assert.ok(baked.source.includes('<h1 data-aiden-text="headline">\n    Tom &amp; Jerry\n  </h1><p data-aiden-text="headline">Tom &amp; Jerry</p>'));
  // The panel shows "Don’t wait"; the file says "Don't wait", and that is what is looked for.
  const quoted = RICH.replace('"default": "Make room"', '"default": "Don\'t wait"').replace(
    '<h1 data-aiden-text="headline">Make room</h1>',
    "<h1>Don't wait</h1>",
  );
  const quotedControls = extractDesignTweakControls(quoted);
  const words = bakeDesignTweakDefaults(quoted, withDesignTweak(undefined, byId(quotedControls, "headline"), "Go now"));
  assert.ok(words.ok);
  assert.deepEqual(words.kept, []);
  assert.ok(words.source.includes("<h1>Go now</h1>"));
});

test("make default keeps a page without html or head tags in standards mode", () => {
  const bare = `<!doctype html>
<script type="application/aiden-tweaks">[{ "id": "d", "label": "D", "type": "choice", "options": ["x", "y"], "default": "x", "attr": "data-d" },
 { "id": "n", "label": "N", "type": "number", "min": 0, "max": 9, "default": 1, "var": "--n" }]</script>
<p>Hi</p>`;
  const controls = extractDesignTweakControls(bare);
  let values = withDesignTweak(undefined, byId(controls, "d"), "y");
  values = withDesignTweak(values, byId(controls, "n"), 4);
  const baked = bakeDesignTweakDefaults(bare, values);
  assert.ok(baked.ok);
  assert.ok(baked.source.startsWith("<!doctype html>\n"), baked.source.slice(0, 40));
  assert.ok(baked.source.indexOf('<html data-d="y">') > 0);
  assert.ok(baked.source.indexOf("<style data-aiden-tweaks>") > 0);
});

test("make default edits the control that was read, and only its own managed block", () => {
  // The first "n" isn't a usable control, so the second is the one the panel shows.
  const page = `<html><head><style data-aiden-tweaks-theme>body { color: red }</style>
<script type="application/aiden-tweaks">[{ "id": "n", "type": "pad", "label": "Broken" },
 { "id": "n", "label": "N", "type": "number", "min": 0, "max": 9, "default": 2, "var": "--n" }]</script></head></html>`;
  const controls = extractDesignTweakControls(page);
  const baked = bakeDesignTweakDefaults(page, withDesignTweak(undefined, byId(controls, "n"), 7));
  assert.ok(baked.ok);
  assert.equal(readDesignTweak(byId(extractDesignTweakControls(baked.source), "n"), undefined), 7);
  assert.ok(baked.source.includes("<style data-aiden-tweaks-theme>body { color: red }</style>"), "a look-alike block is left alone");
  assert.equal((baked.source.match(/<style data-aiden-tweaks>/gu) ?? []).length, 1);
});

test("make default leaves examples in comments and scripts alone, and reads quoted > in a tag", () => {
  const page = RICH.replace('<html lang="en">', '<html lang="en" data-x="old > value">').replace(
    '<h1 data-aiden-text="headline">Make room</h1>',
    '<!-- <p data-aiden-text="headline">Make room</p> --><script>const s = "<i data-aiden-text=\'headline\'>Make room</i>";</script><h1>Make room</h1>',
  );
  const controls = extractDesignTweakControls(page);
  let values = withDesignTweak(undefined, byId(controls, "headline"), "Plan less");
  values = withDesignTweak(values, byId(controls, "density"), "compact");
  const baked = bakeDesignTweakDefaults(page, values);
  assert.ok(baked.ok);
  assert.ok(baked.source.includes('<!-- <p data-aiden-text="headline">Make room</p> -->'), "the comment is left as it was");
  assert.ok(baked.source.includes("<i data-aiden-text='headline'>Make room</i>"), "the script is left as it was");
  assert.ok(baked.source.includes("<h1>Plan less</h1>"), "the page's real words change");
  assert.match(baked.source, /<html lang="en" data-x="old > value" data-density="compact" data-headline="Plan less">/u);
});

test("a page full of unclosed tags is read quickly", () => {
  const flood = `${RICH}${"<script ".repeat(16_000)}${"<style ".repeat(16_000)}${"<html ".repeat(16_000)}`;
  const started = performance.now();
  assert.equal(extractDesignTweakControls(flood).length, 6);
  const baked = bakeDesignTweakDefaults(flood, withDesignTweak(undefined, byId(extractDesignTweakControls(RICH), "radius"), 12));
  assert.ok(baked.ok);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

test("a value can't open a CSS comment", () => {
  assert.equal(isDesignTweakValue("a /* b"), false);
  assert.equal(isDesignTweakValue("b */ c"), false);
  assert.equal(cleanDesignTweakText("Save /* now */"), "Save / * now * /");
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

test("after Make default a frame lets go of only what the file now says", () => {
  const written = { "--radius": "14px", "data-headline": "Pick a slot", "--accent": "#2f6fed" };
  // Nothing changed meanwhile, and Aiden's own variable no control declares stays.
  assert.deepEqual(tweaksAfterBake({ "--radius": "14px", "data-headline": "Pick a slot", "--hero": "red" }, written), { "--hero": "red" });
  // Words the file couldn't place aren't in what it wrote, so they stay.
  assert.deepEqual(tweaksAfterBake({ "--radius": "14px", "data-cta": "Book" }, written), { "data-cta": "Book" });
  // Corners moved to 18px while the file was being written, and a value past a control's range: both stay.
  assert.deepEqual(tweaksAfterBake({ "--radius": "18px", "--accent": "#2f6fed" }, written), { "--radius": "18px" });
  assert.equal(tweaksAfterBake({ "--radius": "14px" }, written), undefined);
  // Undo brings the submitted values back to the frame, under anything changed since.
  const submitted = { "--radius": "14px", "data-headline": "Pick a slot" };
  assert.deepEqual(tweaksAfterBakeUndo(undefined, submitted), submitted);
  assert.deepEqual(tweaksAfterBakeUndo({ "--radius": "18px" }, submitted), { ...submitted, "--radius": "18px" });
});

test("when a taken-back value can't be undone in the file, the frame pins what the file said before", () => {
  const submitted = { "--radius": "14px", "data-density": "compact" };
  const written = { "--radius": "14px", "data-density": "compact", "--accent": "#2f6fed" };
  const previous = { "--radius": "8px", "data-density": "cozy", "--accent": "#2f6fed" };
  // Reset while it was written: the page should still show the old corners and density.
  assert.deepEqual(tweaksAfterTakenBackBake(undefined, submitted, written, previous), { "--radius": "8px", "data-density": "cozy" });
  // Density moved on to another value, corners taken back: each keeps what the person set.
  assert.deepEqual(tweaksAfterTakenBackBake({ "data-density": "airy" }, submitted, written, previous), {
    "data-density": "airy",
    "--radius": "8px",
  });
});

test("a value taken back while Make default writes it calls that Make default off", () => {
  const submitted = { "--radius": "14px", "data-cta": "Book" };
  const written = { "--radius": "14px", "--accent": "#2f6fed" };
  // Left alone, or changed to another value: the bake stands.
  assert.equal(tweaksTakenBackDuringBake(submitted, submitted, written), false);
  assert.equal(tweaksTakenBackDuringBake({ ...submitted, "--radius": "18px" }, submitted, written), false);
  // Reset, or Corners moved back to its default: the file would bring 14px straight back.
  assert.equal(tweaksTakenBackDuringBake(undefined, submitted, written), true);
  assert.equal(tweaksTakenBackDuringBake({ "data-cta": "Book" }, submitted, written), true);
  // Words the file didn't write, and a default the person never set: letting them go changes nothing there.
  assert.equal(tweaksTakenBackDuringBake({ "--radius": "14px" }, submitted, written), false);
});
