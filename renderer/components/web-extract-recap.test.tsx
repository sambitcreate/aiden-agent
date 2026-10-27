import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import { WebExtractRecap, webExtractFieldLabel } from "./web-extract-recap";
import type { WebExtractRecapV1 } from "../shared/web-extract";

afterEach(() => cleanup());

const RECAP: WebExtractRecapV1 = {
  version: 1,
  host: "acme.example",
  cut: true,
  fields: [
    { name: "pro_monthly", status: "extracted", value: "20", confidence: 0.97, sourceLine: "Pro is $20 per month, billed monthly." },
    { name: "team_yearly", status: "uncertain", value: "1399", confidence: 0.92, notFound: true },
    { name: "seats", status: "uncertain", value: "50", confidence: 0.4, sourceLine: "Up to 50 seats on Team." },
    { name: "enterprise", status: "null" },
  ],
};

function rowFor(name: string): HTMLElement {
  return screen.getByText(webExtractFieldLabel(name)).parentElement as HTMLElement;
}

test("each value shows next to its name with the page line it came from", () => {
  render(<WebExtractRecap recap={RECAP} />);
  const card = screen.getByRole("region", { name: "Values read from acme.example" });
  assert.ok(within(card).getByText("acme.example"));
  const price = rowFor("pro_monthly");
  assert.ok(within(price).getByText("20"));
  assert.equal(within(price).getByText("Pro is $20 per month, billed monthly.").tagName, "Q");
  assert.equal(within(price).queryByText("Guess"), null);
  assert.ok(within(card).getByText("Only the first part of the page was read."));
});

test("guesses are labelled, and values missing from the page say so", () => {
  render(<WebExtractRecap recap={RECAP} />);
  const notFound = rowFor("team_yearly");
  assert.ok(within(notFound).getByText("Guess"));
  assert.ok(within(notFound).getByText("Not found on the page"));
  // A low-confidence value that is on the page still cites its line.
  const lowConfidence = rowFor("seats");
  assert.ok(within(lowConfidence).getByText("Guess"));
  assert.ok(within(lowConfidence).getByText("Up to 50 seats on Team."));
  const absent = rowFor("enterprise");
  assert.ok(within(absent).getByText("Not on the page"));
  assert.equal(within(absent).queryByText("Guess"), null);
});

test("a failed extraction explains why and that the page was read instead", () => {
  render(<WebExtractRecap recap={{ version: 1, host: "acme.example", cut: false, error: "quota", fields: [] }} />);
  assert.ok(screen.getByText(/rate-limited or out of quota\. The page was read instead\./u));
  assert.equal(screen.queryByRole("term"), null);
});

test("field names read as words", () => {
  assert.equal(webExtractFieldLabel("pro_monthly_price"), "pro monthly price");
  assert.equal(webExtractFieldLabel("___"), "___");
});
