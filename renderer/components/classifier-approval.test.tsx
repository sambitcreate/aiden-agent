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

test("the shared chat approval card inspects classifier state and fails closed on a missing payload", async () => {
  const { ChatApprovalCard } = await import("./chat-approval-card.js");
  const pending = { approvalId: "classifier", toolCallId: "call", toolName: "classify", summary: "Classify", scopes: ["once", "chat", "always"] as const };
  const html = renderToStaticMarkup(<ChatApprovalCard pending={{ ...pending, scopes: [...pending.scopes], details: classifierApprovalFor(request) }} deciding={false} onDecide={() => undefined} />);
  assert.match(html, /PRIVATE-LATE-FIELD/);
  assert.match(html, /Allow once/);
  assert.doesNotMatch(html, /Remember this exact action/);
  const invalid = renderToStaticMarkup(<ChatApprovalCard pending={{ ...pending, scopes: [...pending.scopes] }} deciding={false} onDecide={() => undefined} />);
  assert.doesNotMatch(invalid, /Allow once/);
  assert.match(invalid, /Deny/);
});


test("image approval renders the entire prompt with the recipient and reference disclosure", async () => {
  const { ChatApprovalCard } = await import("./chat-approval-card.js");
  const { summarizeToolCall } = await import("../../main/services/coding-tools.js");
  const summary = summarizeToolCall("generate_image", { provider: "studio", model: "canvas", prompt: "x".repeat(3000) + "PRIVATE-LATE-PROMPT <script>unsafe()</script>\nFinal line" }) + " Reference image: attached drawing.";
  const pending = { approvalId: "image", toolCallId: "call", toolName: "generate_image", summary };
  const html = renderToStaticMarkup(<ChatApprovalCard pending={pending} deciding={false} onDecide={() => undefined} />);
  assert.match(html, /studio\/canvas/);
  assert.match(html, /PRIVATE-LATE-PROMPT &lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(html, /Final line/);
  assert.match(html, /Reference image: attached drawing/);
  assert.match(html, /Allow once/);
  assert.doesNotMatch(html, /<script>/);
  const remote = renderToStaticMarkup(<ChatApprovalCard pending={{ ...pending, canAllow: false }} deciding={false} onDecide={() => undefined} />);
  assert.doesNotMatch(remote, /Allow once/);
  assert.match(remote, /Deny/);
});
