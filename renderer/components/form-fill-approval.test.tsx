import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { FormFillBatchApprovalDetails } from "../shared/assistant.js";
import { FormFillApproval } from "./form-fill-approval.js";

const details: FormFillBatchApprovalDetails = {
  kind: "form-fill-batch",
  planId: "plan_abc",
  sourceDocument: "patient.txt",
  sourceHashPrefix: "4f43b442e79b",
  targetApp: "Safari",
  targetTitle: "Registration",
  rows: [
    {
      order: 0,
      elementIndex: 3,
      label: "First name",
      value: "Ada",
      sourceLabel: "First name",
      sourceLine: 1,
    },
    {
      order: 1,
      elementIndex: 4,
      label: "Last name",
      value: "Lovelace",
      sourceLabel: "Last name",
      sourceLine: 2,
    },
  ],
  skippedRows: [{ label: "Submit", reason: "Submit is never part of a fill batch." }],
  fillCount: 2,
  reviewCount: 1,
  submitExcluded: true,
};

test("form-fill review card lists every mutation and the no-submit statement", () => {
  const html = renderToStaticMarkup(
    createElement(FormFillApproval, { details, descriptionId: "desc" }),
  );
  assert.match(html, /Safari — Registration/);
  assert.match(html, /patient\.txt/);
  assert.match(html, /4f43b442e79b/);
  assert.match(html, /First name/);
  assert.match(html, /Ada/);
  assert.match(html, /Last name/);
  assert.match(html, /Lovelace/);
  assert.match(html, /line 1/);
  assert.match(html, /Submit is never part of a fill batch\./);
  assert.match(html, /This will not submit the form\./);
  assert.match(html, /aria-label="Fields to fill"/);
  assert.match(html, /aria-label="Fields left unchanged"/);
  // every fill row is a deselectable checkbox
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
});
