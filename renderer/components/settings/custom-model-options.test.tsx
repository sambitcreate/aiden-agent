import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import type { CustomModelOptions } from "../../shared/custom-model-options";
import { CustomModelOptionsEditor } from "./custom-model-options";

function render(overrides?: CustomModelOptions, supportsEffortControl = true) {
  const markup = renderToStaticMarkup(<CustomModelOptionsEditor models={["private"]} metadata={{private: {source: "provider", overrides}}} info={{private: {id: "private", name: "Private model", vision: false, reasoning: false, toolCall: true, metadataSource: "provider", matched: true}}} disabled={false} modelsStale={false} supportsEffortControl={supportsEffortControl} onChange={() => {}} onAdd={() => {}} />);
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


test("effort format is a labeled setting with explicit server presets", () => {
  const doc = render({ reasoning: true, effortControl: "glm" });
  const control = Array.from(doc.getElementsByTagName("button")).find((button) => button.getAttribute("aria-label") === "private: Effort request format");
  assert.equal(control?.getAttribute("role"), "combobox");
  assert.ok(control?.textContent?.includes("GLM / vLLM"));
  assert.ok(render().documentElement.textContent?.includes("Not configured"));
  const incompatible = render({ effortControl: "glm" }, false);
  const disabled = Array.from(incompatible.getElementsByTagName("button")).find((button) => button.getAttribute("aria-label") === "private: Effort request format");
  assert.equal(disabled?.hasAttribute("disabled"), true);
});


test("supported effort multi-select summarizes a per-model subset and disables without a format", () => {
  const doc = render({ reasoning: true, effortControl: "openai", effortLevels: ["off", "medium", "xhigh", "max"] });
  const controls = Array.from(doc.getElementsByTagName("button"));
  const levels = controls.find((button) => button.getAttribute("aria-label") === "private: Supported effort levels");
  assert.equal(levels?.textContent, "None, Medium, Extra high, Max");
  assert.equal(levels?.getAttribute("aria-haspopup"), "menu");
  assert.equal(levels?.hasAttribute("disabled"), false);
  const empty = Array.from(render().getElementsByTagName("button")).find((button) => button.getAttribute("aria-label") === "private: Supported effort levels");
  assert.equal(empty?.hasAttribute("disabled"), true);
});
