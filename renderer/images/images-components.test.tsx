import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import type { AttemptSnapshot, ImageRunConsentPlan, RunSnapshot } from "../shared/images/run-types";
import { ConsentSummary } from "./consent-sheet";
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

test("the model picker explains how to add a provider when no image model is configured", () => {
  assert.match(render(<ModelPicker models={[]} onChange={noop} />).text, /Add an OpenRouter key in Settings → Providers/u);
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
