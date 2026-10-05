import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { CustomModelOptionsEditor } from "./custom-model-options";

function render(overrides?: {vision?: boolean; reasoning?: boolean; maxImages?: number}) {
  const markup = renderToStaticMarkup(<CustomModelOptionsEditor models={["private"]} metadata={{private: {source: "provider", overrides}}} info={{private: {id: "private", name: "Private model", vision: false, reasoning: false, toolCall: true, metadataSource: "provider", matched: true}}} disabled={false} modelsStale={false} onChange={() => {}} onAdd={() => {}} />);
  return new DOMParser().parseFromString(markup, "text/html");
}

test("private model summary and switches distinguish text-only from explicitly enabled images", () => {
  const initial = render();
  const controls = Array.from(initial.getElementsByTagName("button"));
  const vision = controls.find((button) => button.getAttribute("aria-label") === "private: Vision");
  assert.equal(vision?.getAttribute("aria-checked"), "false");
  assert.ok(initial.getElementsByTagName("summary")[0]?.textContent?.includes("Text only"));
  assert.equal(initial.getElementsByTagName("details")[0]?.hasAttribute("open"), false);
  const enabled = render({vision: true, reasoning: true});
  assert.ok(enabled.getElementsByTagName("summary")[0]?.textContent?.includes("Images enabled"));
  const switched = Array.from(enabled.getElementsByTagName("button")).find((button) => button.getAttribute("aria-label") === "private: Vision");
  assert.equal(switched?.getAttribute("aria-checked"), "true");
  const disabled = render({vision: true, maxImages: 0});
  assert.equal(Array.from(disabled.getElementsByTagName("button")).find((button) => button.getAttribute("aria-label") === "private: Vision")?.getAttribute("aria-checked"), "false");
  assert.ok(render({vision: true, maxImages: 0}).getElementsByTagName("summary")[0]?.textContent?.includes("Text only"));
});
