import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { classifierApprovalFor } from "../../main/services/pi-model-tools.js";
import { classifierApprovalState } from "../shared/classifier-approval.js";
import { ClassifierApproval } from "./classifier-approval.js";

const request = { provider: "research", model: "judge", state: { early: "x".repeat(20_000), late: "PRIVATE-LATE-FIELD <script>notExecutable()</script>" }, questions: { verdict: { type: "bool", instructions: "Inspect every field", criteria: { true: "Accept", false: "Reject" } } } };
test("desktop inspector renders complete late fields, questions, recipient and costs as selectable text", () => {
  const details = classifierApprovalFor(request, "Research team");
  const html = renderToStaticMarkup(<ClassifierApproval details={details} descriptionId="inspect" />);
  assert.match(html, /Research team \(research\).*judge/u);
  assert.match(html, /Provider charges may apply/u);
  assert.match(html, /PRIVATE-LATE-FIELD &lt;script&gt;notExecutable\(\)&lt;\/script&gt;/u);
  assert.match(html, /Inspect every field/u);
  assert.match(html, /Nothing is omitted/u);
  assert.match(html, /aria-label="Complete classification state"/u);
  assert.match(html, /aria-label="Complete classification questions"/u);
  assert.equal((html.match(/<details/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<script>/u);
});
test("missing, incomplete, oversized or altered classifier payloads cannot use summary-only approval", () => {
  const valid = classifierApprovalFor(request);
  assert.equal(classifierApprovalState("classify", valid).invalid, false);
  for (const details of [undefined, {}, { ...valid, payloadComplete: false }, { ...valid, stateBytes: 1 }, { ...valid, stateJson: JSON.stringify({ huge: "x".repeat(40_000) }) }]) {
    assert.equal(classifierApprovalState("classify", details).invalid, true);
  }
  assert.equal(classifierApprovalState("run_command", undefined).invalid, false);
});
