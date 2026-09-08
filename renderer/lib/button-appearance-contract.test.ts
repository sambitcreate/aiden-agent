import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const uiSource = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("shared action buttons use the same squircle for labeled and icon-only actions", () => {
  const buttonSource = uiSource.slice(
    uiSource.indexOf("export const Button"),
    uiSource.indexOf("export const Input"),
  );
  assert.match(buttonSource, /data-slot="button"/u);
  assert.match(buttonSource, /border-0/u);
  assert.doesNotMatch(buttonSource, /border border-transparent/u);
  assert.match(buttonSource, /"rounded-button"/u);
  assert.doesNotMatch(buttonSource, /rounded-pill|radius =/u);
  assert.match(buttonSource, /iconOnly && "aspect-square px-0"/u);
  assert.match(buttonSource, /pressFeedback && "button-press-feedback"/u);
  assert.match(buttonSource, /motion-reduce:transform-none/u);
});

test("legacy actions and button links share the shape without clipping or changing selection controls", () => {
  const rule = styles.match(/:root :is\(button, \[role="button"\], \[data-slot="button"\], \.squircle-control\)[^{]+\{([^}]+)\}/u);
  assert.ok(rule);
  for (const role of ["switch", "radio", "checkbox"]) {
    assert.ok(rule[0].includes(`:not([role="${role}"])`));
  }
  assert.match(rule[1], /border-radius: var\(--radius-button\)/u);
  assert.match(rule[1], /corner-shape: squircle/u);
  assert.doesNotMatch(rule[1], /overflow|clip-path|outline/u);
  assert.match(styles, /--radius-button: 16px/u);
});

test("design guidance and interactive specimen document reusable button and composer geometry", () => {
  const guide = readFileSync(new URL("../../docs/design-guide.md", import.meta.url), "utf8");
  const specimen = readFileSync(new URL("../../docs/chatgpt-ui-element-specimen.html", import.meta.url), "utf8");
  for (const token of ["--radius-button", "--radius-composer"]) {
    assert.ok(guide.includes(token));
    assert.ok(specimen.includes(token));
  }
  assert.match(guide, /focus-visible/u);
  assert.match(specimen, /corner-shape: squircle/u);
});

test("control elevation uses depth without a faux hairline outline", () => {
  const elevations = [...styles.matchAll(/--elevation-control(?:-hover|-pressed)?:\s*([^;]+);/gu)]
    .map((match) => match[1])
    .join("\n");
  assert.ok(elevations.length > 0);
  assert.doesNotMatch(elevations, /0 0 0 0\.5px/u);
});
