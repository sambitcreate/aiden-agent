import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import type { AttemptSnapshot, ImageRunConsentPlan, RunSnapshot } from "../shared/images/run-types";
import { ReactFlowProvider } from "@xyflow/react";
import type { WorkflowDocV1 } from "../shared/images/schema";
import { ConsentSummary } from "./consent-sheet";
import { toFlowNodes } from "./flow-adapter-core";
import { IMAGE_NODE_WIDTH, fitNodeToMediaAspect } from "./node-dimensions-core";
import { ImageNodeFrame } from "./nodes/node-frame";
import { NodePorts } from "./nodes/node-ports";
import { ModelPicker } from "./model-picker";
import { GenerateImageNodeBody } from "./nodes/generate-image-node";
import { OutputNodeBody } from "./nodes/output-node";
import { RunPanel } from "./run-panel";

function render(element: ReactElement) {
  const document = new DOMParser().parseFromString(`<root>${renderToStaticMarkup(element)}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  return {
    text: document.documentElement.textContent ?? "",
    buttons: all.filter((node) => node.tagName === "button"),
    images: all.filter((node) => node.tagName === "img"),
    all,
    byRole: (role: string) => all.filter((node) => node.getAttribute("role") === role),
    listItems: all.filter((node) => node.getAttribute("role") === "listitem"),
  };
}
const noop = () => undefined;
const ref = (seed: string) => ({ assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png" as const });
const attempt = (patch: Partial<AttemptSnapshot>): AttemptSnapshot => ({
  nodeId: "g", variant: 0, state: "queued", provider: "openrouter", model: "m", cancelRequested: false, truncated: false,
  output: [], mayHaveBeenBilled: false, ...patch,
});
const run = (state: RunSnapshot["run"]["state"], attempts: AttemptSnapshot[]): RunSnapshot => ({
  version: 1,
  run: { runId: "r", workflowId: "wf", workflowRevision: 2, scope: { kind: "all" }, state, requestLimit: 1, requestsSent: 1, createdAt: 1 },
  attempts,
});

test("the consent summary names provider, model, references and the unavailable estimate", () => {
  const plan: ImageRunConsentPlan = {
    consentId: "c".repeat(32), workflowId: "wf", workflowRevision: 2, scope: { kind: "all" }, totalRequests: 1,
    estimate: { kind: "unknown" }, createdAt: 0, expiresAt: 300_000,
    requests: [{ nodeId: "g", variant: 0, provider: "openrouter", providerLabel: "OpenRouter", model: "google/gemini-3.1-flash-image",
      modelLabel: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", referenceCount: 2, referenceBytes: 1_572_864, pendingReferenceCount: 0 }],
  };
  const { text } = render(<ConsentSummary plan={plan} />);
  assert.match(text, /OpenRouter · Google: Nano Banana 2 \(Gemini 3\.1 Flash Image\)/u);
  assert.match(text, /2 reference images \(1\.5 MB\)/u);
  assert.match(text, /Estimate unavailable/u);
  assert.match(text, /never retries a paid request/u);
});

test("a consent for references from earlier steps states the per-request upper bound", () => {
  const plan: ImageRunConsentPlan = {
    consentId: "c".repeat(32), workflowId: "wf", workflowRevision: 2, scope: { kind: "all" }, totalRequests: 1,
    estimate: { kind: "unknown" }, createdAt: 0, expiresAt: 300_000,
    requests: [{ nodeId: "g", variant: 0, provider: "openrouter", providerLabel: "OpenRouter", model: "m", modelLabel: "M",
      referenceCount: 1, referenceBytes: 0, pendingReferenceCount: 1 }],
  };
  assert.match(render(<ConsentSummary plan={plan} />).text, /Up to 4 reference images per request, including images from earlier steps\./u);
});

test("the run panel offers Stop only while running and flags stopped requests as possibly billed", () => {
  const live = render(<RunPanel snapshot={run("running", [attempt({ state: "running", submittedAt: 1 })])} nodeTitles={new Map()} onStop={noop} onRetry={noop} />);
  assert.deepEqual(live.buttons.map((button) => button.textContent), ["Stop"]);
  const stopped = render(
    <RunPanel snapshot={run("cancelled", [attempt({ state: "cancelled", submittedAt: 1, mayHaveBeenBilled: true })])} nodeTitles={new Map([["g", "Hero image"]])} onStop={noop} onRetry={noop} />,
  );
  assert.match(stopped.text, /Hero image/u);
  assert.match(stopped.text, /may have been billed/u);
  // Owner decision 1: both retry choices are offered, in this order.
  assert.deepEqual(stopped.buttons.map((button) => button.textContent), ["Retry from here", "Retry this node only"]);
});

test("a retry consent says which nodes run, and nodes left behind are labelled Out of date", () => {
  const request = {
    nodeId: "g0", variant: 0, provider: "openrouter", providerLabel: "OpenRouter", model: "m", modelLabel: "M",
    referenceCount: 0, referenceBytes: 0, pendingReferenceCount: 0,
  };
  const plan = (scope: ImageRunConsentPlan["scope"], totalRequests: number): ImageRunConsentPlan => ({
    consentId: "c".repeat(32), workflowId: "wf", workflowRevision: 2, scope, totalRequests, estimate: { kind: "unknown" },
    createdAt: 0, expiresAt: 300_000, requests: Array.from({ length: totalRequests }, (_, index) => ({ ...request, nodeId: `g${index}` })),
  });
  assert.match(render(<ConsentSummary plan={plan({ kind: "node-only", nodeId: "g0" }, 1)} />).text, /Only this node will run.*Out of date/u);
  const here = render(<ConsentSummary plan={plan({ kind: "from-node", nodeId: "g0" }, 2)} />).text;
  assert.match(here, /everything after it will run/u);
  assert.doesNotMatch(here, /Out of date/u);
  assert.doesNotMatch(render(<ConsentSummary plan={plan({ kind: "all" }, 1)} />).text, /will run/u);

  assert.match(render(<OutputNodeBody images={[ref("a")]} urls={{}} stale />).text, /Out of date/u);
  assert.doesNotMatch(render(<OutputNodeBody images={[ref("a")]} urls={{}} />).text, /Out of date/u);
  const generate = render(
    <GenerateImageNodeBody model={undefined} models={[]} attempt={undefined} running={false} stale onModel={noop} onRunFromHere={noop} />,
  );
  assert.match(generate.text, /Out of date/u);
});

test("the Output mini-gallery shows at most four granted images and a hint when empty", () => {
  const refs = ["a", "b", "c", "d", "e"].map(ref);
  const urls = Object.fromEntries(refs.slice(0, 3).map((item) => [item.assetId, `aiden-asset://grant/${item.assetId.slice(0, 43)}`]));
  const gallery = render(<OutputNodeBody images={refs} urls={urls} />);
  assert.equal(gallery.listItems.length, 4);
  assert.deepEqual(gallery.images.map((image) => image.getAttribute("alt")), ["Generated image 1", "Generated image 2", "Generated image 3"]);
  assert.match(render(<OutputNodeBody images={[]} urls={{}} />).text, /Run the workflow to see images here/u);
});

test("the model picker points to Image Generation settings when no image model is configured", () => {
  const bare = render(<ModelPicker models={[]} onChange={noop} />);
  assert.match(bare.text, /Add an image key in Settings → Image Generation\./u);
  assert.equal(bare.buttons.length, 0);
  const linked = render(<ModelPicker models={[]} onChange={noop} onOpenSettings={noop} />);
  assert.deepEqual(linked.buttons.map((button) => button.textContent), ["Open Image Generation"]);
});

test("the model picker shows the selected model's maker mark", () => {
  const option = {
    provider: "openrouter", providerLabel: "OpenRouter", model: "google/gemini-3.1-flash-image",
    label: "Nano Banana 2", acceptsReferences: true, textOutput: false,
  };
  const picker = render(
    <ModelPicker value={{ provider: "openrouter", id: "google/gemini-3.1-flash-image" }} models={[option]} onChange={noop} />,
  );
  const [trigger] = picker.buttons;
  assert.match(trigger?.textContent ?? "", /Nano Banana 2/u);
  const marks = Array.from(trigger?.getElementsByTagName("span") ?? []).map((node) => node.getAttribute("data-image-logo"));
  assert.ok(marks.includes("google"));
});

test("the model picker uses the model's explicit maker for its mark", () => {
  // A Replicate-hosted id whose owner prefix would not infer this maker.
  const option = {
    provider: "replicate", providerLabel: "Replicate", model: "someone/custom-finetune",
    label: "Custom finetune", acceptsReferences: false, textOutput: false, maker: "black-forest-labs",
  };
  const picker = render(
    <ModelPicker value={{ provider: "replicate", id: "someone/custom-finetune" }} models={[option]} onChange={noop} />,
  );
  const [trigger] = picker.buttons;
  const marks = Array.from(trigger?.getElementsByTagName("span") ?? []).map((node) => node.getAttribute("data-image-logo"));
  assert.ok(marks.includes("black-forest-labs"));
});

test("a Generate node shows its run status and disables Run from Here during a run", () => {
  const body = render(
    <GenerateImageNodeBody model={undefined} models={[]} attempt={attempt({ state: "interrupted", submittedAt: 1, mayHaveBeenBilled: true })} running onModel={noop} onRunFromHere={noop} />,
  );
  assert.match(body.text, /Interrupted/u);
  assert.match(body.text, /may have been billed/u);
  const runFromHere = body.buttons.find((button) => button.textContent === "Run from Here");
  assert.equal(runFromHere?.hasAttribute("disabled"), true);
});

test("retry choices are disabled while a run is being prepared, so a second click cannot open a second consent", () => {
  const failed = run("failed", [attempt({ state: "failed", submittedAt: 1 })]);
  const idle = render(<RunPanel snapshot={failed} nodeTitles={new Map()} onStop={noop} onRetry={noop} />);
  assert.ok(idle.buttons.length > 0);
  assert.ok(idle.buttons.every((button) => !button.hasAttribute("disabled")));
  const busy = render(<RunPanel snapshot={failed} nodeTitles={new Map()} busy onStop={noop} onRetry={noop} />);
  assert.deepEqual(busy.buttons.map((button) => button.textContent), ["Retry from here", "Retry this node only"]);
  assert.ok(busy.buttons.every((button) => button.hasAttribute("disabled")));
});

test("a sized image node renders exactly the box React Flow lays out and attaches edges to", () => {
  const dimensions = fitNodeToMediaAspect(undefined, 1920, 1080)!;
  const doc: WorkflowDocV1 = {
    schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, settings: { concurrency: 2 }, edges: [],
    nodes: [
      { id: "i", type: "image-input", position: { x: 0, y: 0 }, dimensions, data: { assetId: "a".repeat(64) } },
      { id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { text: "" } },
    ],
  };
  const [image, prompt] = toFlowNodes(doc, new Map(), new Set());
  const boxOf = (element: ReactElement) => {
    const frame = render(element).all.find((node) => node.getAttribute("class") === "image-node")!;
    const style = frame.getAttribute("style") ?? "";
    const px = (name: string) => Number(new RegExp(`(?:^|;)${name}:(\\d+)px`, "u").exec(style)?.[1]);
    return { width: px("width"), height: px("height") };
  };
  assert.deepEqual(boxOf(<ImageNodeFrame dimensions={image?.data.node.dimensions} />), { width: image?.width, height: image?.height });
  // An unsized node takes the shared width; React Flow measures its height.
  assert.equal(prompt?.width, undefined);
  assert.equal(boxOf(<ImageNodeFrame />).width, IMAGE_NODE_WIDTH);
});

test("ports are keyboard controls that announce which port they are", () => {
  const ports = render(
    <ReactFlowProvider>
      <NodePorts type="generate-image" />
    </ReactFlowProvider>,
  ).all.filter((node) => (node.getAttribute("class") ?? "").includes("image-port"));
  assert.ok(ports.length >= 2);
  for (const port of ports) {
    assert.equal(port.getAttribute("tabindex"), "0");
    assert.equal(port.getAttribute("role"), "button");
    assert.match(port.getAttribute("aria-label") ?? "", / (input|output)$/u);
  }
});
