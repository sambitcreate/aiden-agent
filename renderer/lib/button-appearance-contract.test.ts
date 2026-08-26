import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const uiSource = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("shared action buttons use soft borderless capsules and circular icon geometry", () => {
  const buttonSource = uiSource.slice(
    uiSource.indexOf("export const Button"),
    uiSource.indexOf("export const Input"),
  );
  assert.match(buttonSource, /data-slot="button"/u);
  assert.match(buttonSource, /border-0/u);
  assert.doesNotMatch(buttonSource, /border border-transparent/u);
  assert.match(buttonSource, /radius === "full" \? "rounded-pill"/u);
  assert.match(buttonSource, /iconOnly && "aspect-square px-0"/u);
  assert.match(buttonSource, /active:scale-\[0\.985\]/u);
  assert.match(buttonSource, /motion-reduce:transform-none/u);
});

test("control elevation uses depth without a faux hairline outline", () => {
  const elevations = [...styles.matchAll(/--elevation-control(?:-hover|-pressed)?:\s*([^;]+);/gu)]
    .map((match) => match[1])
    .join("\n");
  assert.ok(elevations.length > 0);
  assert.doesNotMatch(elevations, /0 0 0 0\.5px/u);
});
