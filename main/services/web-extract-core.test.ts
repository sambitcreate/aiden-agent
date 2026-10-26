import assert from "node:assert/strict";
import test from "node:test";

import {
  WebExtractError,
  citeLine,
  extractWebPageFields,
  formatWebPageExtraction,
  parseWebExtractFields,
  type WebExtractModel,
  type WebExtractModelRequest,
  type WebPageExtraction,
} from "./web-extract-core.js";

const PRICING_PAGE = [
  "# Pricing",
  "",
  "### Free",
  "$0 / month",
  "",
  "### Pro",
  "Pro is $20 per month, billed monthly.",
  "Team | $1,299 / year | up to 1.2k seats",
  "- 14-day free trial",
  "Version 5.3.1 shipped on November 3, 2026.",
  "Support hours: 9:30 am to 5 pm, Monday to Friday.",
  "Launch event: 2026-11-12 at 18:00.",
  "Available in Germany, Japan and Brazil.",
  "Refunds within 30 days.",
].join("\n");

/** A model that answers from a script and records what it was sent. */
function scriptedModel(
  answers: Record<string, unknown>,
  options: { maxPageChars?: number; truncated?: boolean } = {},
): WebExtractModel & { readonly requests: WebExtractModelRequest[] } {
  const requests: WebExtractModelRequest[] = [];
  return {
    id: "scripted",
    maxPageChars: options.maxPageChars ?? 200_000,
    requests,
    async run(request) {
      requests.push(request);
      return { answers, truncated: options.truncated === true };
    },
  };
}

async function extract(fields: Record<string, string>, answers: Record<string, unknown>, page = PRICING_PAGE) {
  const extraction = await extractWebPageFields({
    page,
    fields: parseWebExtractFields(fields),
    model: scriptedModel(answers),
    now: () => new Date(2026, 9, 26),
  });
  assert.ok(!("error" in extraction), "the scripted model never fails");
  return extraction.fields;
}

test("a confident, well-typed value found on the page is extracted with its source line", async () => {
  const fields = await extract(
    { pro_monthly: "number: Pro plan monthly price", trial: "text: free trial length" },
    { pro_monthly: { value: 20, confidence: 0.97 }, trial: { value: "14-day free trial", confidence: 0.91 } },
  );
  assert.deepEqual(fields.pro_monthly, {
    status: "extracted",
    value: 20,
    confidence: 0.97,
    sourceLine: "Pro is $20 per month, billed monthly.",
  });
  assert.deepEqual(fields.trial, {
    status: "extracted",
    value: "14-day free trial",
    confidence: 0.91,
    sourceLine: "- 14-day free trial",
  });
});

test("a value below the 0.80 threshold is uncertain, still citing the line where it appears", async () => {
  const fields = await extract({ pro_monthly: "number" }, { pro_monthly: { value: 20, confidence: 0.55 } });
  assert.deepEqual(fields.pro_monthly, {
    status: "uncertain",
    guess: 20,
    confidence: 0.55,
    sourceLine: "Pro is $20 per month, billed monthly.",
  });
});

test("a confident value that is not on the page is never extracted", async () => {
  const fields = await extract(
    { pro_monthly: "number", plan: "text", ships: "date", seats: "list.number" },
    {
      pro_monthly: { value: 24, confidence: 0.99 },
      plan: { value: "Enterprise", confidence: 0.95 },
      ships: { value: "2026-11-04", confidence: 0.93 },
      seats: { value: [1200, 5000], confidence: 0.9 },
    },
  );
  assert.deepEqual(fields.pro_monthly, { status: "uncertain", guess: 24, confidence: 0.99, notFound: true });
  assert.deepEqual(fields.plan, { status: "uncertain", guess: "Enterprise", confidence: 0.95, notFound: true });
  assert.deepEqual(fields.ships, { status: "uncertain", guess: "2026-11-04", confidence: 0.93, notFound: true });
  // 1,200 is on the page as "1.2k"; 5,000 is not, so the list is not.
  assert.deepEqual(fields.seats, { status: "uncertain", guess: [1200, 5000], confidence: 0.9, notFound: true });
});

test("a field the model found no value for is null, whatever guess it sends", async () => {
  const fields = await extract(
    { enterprise: "number: Enterprise price", sla: "text" },
    // An explicit null and a value-less answer (only a null probability) both mean absent.
    { enterprise: { value: null, confidence: 0.9 }, sla: { confidence: 0.2, p_null: 0.8 } },
  );
  assert.deepEqual(fields.enterprise, { status: "null", value: null });
  assert.deepEqual(fields.sla, { status: "null", value: null });
});

test("a value of the wrong type is uncertain even when confident and present", async () => {
  const fields = await extract(
    { seats: "integer", ships: "date" },
    { seats: { value: "1.2k", confidence: 0.95 }, ships: { value: "November 3, 2026", confidence: 0.95 } },
  );
  assert.equal(fields.seats!.status, "uncertain");
  assert.equal(fields.ships!.status, "uncertain");
  // Written as on the page, so the guess still points at its line.
  assert.equal(fields.ships!.status === "uncertain" && fields.ships!.sourceLine, "Version 5.3.1 shipped on November 3, 2026.");
});

test("numbers match the page as written: separators, multipliers and signs", async () => {
  const fields = await extract(
    { team: "number", seats: "integer", patch: "integer", not_negative: "number", part: "number" },
    {
      team: { value: 1299, confidence: 0.9 },
      seats: { value: 1200, confidence: 0.9 },
      // "5.3.1" has no numeric reading, so each group counts on its own.
      patch: { value: 3, confidence: 0.9 },
      // No "-20" anywhere: a minus sign is part of the value.
      not_negative: { value: -20, confidence: 0.9 },
      // 299 is not inside "1,299".
      part: { value: 299, confidence: 0.9 },
    },
  );
  assert.equal(fields.team!.status, "extracted");
  assert.equal(fields.team!.status === "extracted" && fields.team!.sourceLine, "Team | $1,299 / year | up to 1.2k seats");
  assert.equal(fields.seats!.status, "extracted");
  assert.equal(fields.patch!.status, "extracted");
  assert.equal(fields.not_negative!.status, "uncertain");
  assert.equal(fields.part!.status, "uncertain");
});

test("dates, times and datetimes match the forms pages write them in", async () => {
  const fields = await extract(
    { ships: "date", opens: "time", closes: "time", launch: "datetime", wrong_day: "date" },
    {
      ships: { value: "2026-11-03", confidence: 0.9 },
      opens: { value: "09:30", confidence: 0.9 },
      closes: { value: "17:00", confidence: 0.9 },
      launch: { value: "2026-11-12T18:00", confidence: 0.9 },
      wrong_day: { value: "2026-11-13", confidence: 0.9 },
    },
  );
  assert.equal(fields.ships!.status === "extracted" && fields.ships!.sourceLine, "Version 5.3.1 shipped on November 3, 2026.");
  assert.equal(fields.opens!.status === "extracted" && fields.opens!.sourceLine, "Support hours: 9:30 am to 5 pm, Monday to Friday.");
  assert.equal(fields.closes!.status, "extracted");
  assert.equal(fields.launch!.status === "extracted" && fields.launch!.sourceLine, "Launch event: 2026-11-12 at 18:00.");
  assert.equal(fields.wrong_day!.status, "uncertain");
});

test("a datetime is extracted only when its date, time and offset share one line", async () => {
  const page = [
    "Launch: November 3, 2026 at 09:00.",
    "Support closes at 17:00.",
    "Keynote: 2026-11-04 09:00 UTC",
    "Tokyo meetup: 5 Nov 2026, 18:30 (UTC+9)",
  ].join("\n");
  const fields = await extract(
    {
      launch: "datetime",
      mixed_lines: "datetime",
      unstated_offset: "datetime",
      keynote: "datetime",
      wrong_offset: "datetime",
      tokyo: "datetime",
      fraction: "datetime",
    },
    {
      launch: { value: "2026-11-03T09:00", confidence: 0.95 },
      // The launch date with the support desk's closing time.
      mixed_lines: { value: "2026-11-03T17:00", confidence: 0.95 },
      unstated_offset: { value: "2026-11-03T09:00+09:00", confidence: 0.95 },
      keynote: { value: "2026-11-04T09:00Z", confidence: 0.95 },
      wrong_offset: { value: "2026-11-04T09:00+09:00", confidence: 0.95 },
      tokyo: { value: "2026-11-05T18:30+09:00", confidence: 0.95 },
      fraction: { value: "2026-11-04T09:00:00.250Z", confidence: 0.95 },
    },
    page,
  );
  assert.equal(fields.launch!.status === "extracted" && fields.launch!.sourceLine, "Launch: November 3, 2026 at 09:00.");
  assert.equal(fields.keynote!.status === "extracted" && fields.keynote!.sourceLine, "Keynote: 2026-11-04 09:00 UTC");
  assert.equal(fields.tokyo!.status === "extracted" && fields.tokyo!.sourceLine, "Tokyo meetup: 5 Nov 2026, 18:30 (UTC+9)");
  for (const name of ["mixed_lines", "unstated_offset", "wrong_offset", "fraction"]) {
    assert.equal(fields[name]!.status, "uncertain", name);
  }
});

test("a duration is extracted only when the page's amount and unit give the value in the requested unit", async () => {
  const page = [
    "We have 14 offices.",
    "The trial lasts 2 weeks.",
    "Sessions time out after 1 hour 30 minutes.",
    "Plans renew every 2 years.",
  ].join("\n");
  const fields = await extract(
    {
      trial_days: "duration.days",
      trial_weeks: "duration.weeks",
      wrong_unit: "duration.days",
      session: "duration",
      renewal_months: "duration.months",
      renewal_days: "duration.days",
    },
    {
      trial_days: { value: 14, confidence: 0.95 },
      trial_weeks: { value: 2, confidence: 0.95 },
      // Two weeks read as two days.
      wrong_unit: { value: 2, confidence: 0.95 },
      session: { value: 5_400, confidence: 0.95 },
      renewal_months: { value: 24, confidence: 0.95 },
      // Two years is not an exact number of days.
      renewal_days: { value: 730, confidence: 0.95 },
    },
    page,
  );
  // Converted from "2 weeks", not the unrelated 14 above it.
  assert.equal(fields.trial_days!.status === "extracted" && fields.trial_days!.sourceLine, "The trial lasts 2 weeks.");
  assert.equal(fields.trial_weeks!.status, "extracted");
  assert.equal(fields.session!.status === "extracted" && fields.session!.sourceLine, "Sessions time out after 1 hour 30 minutes.");
  assert.equal(fields.renewal_months!.status, "extracted");
  assert.equal(fields.wrong_unit!.status, "uncertain");
  assert.equal(fields.renewal_days!.status, "uncertain");

  // A bare number is never a duration.
  const bare = await extract({ team_days: "duration.days" }, { team_days: { value: 14, confidence: 0.95 } }, "We have 14 offices.");
  assert.equal(bare.team_days!.status, "uncertain");
});

test("a list is extracted only when every item is on the page", async () => {
  const fields = await extract(
    { countries: "list", more_countries: "list" },
    {
      countries: { value: ["Germany", "Japan", "Brazil"], confidence: 0.9 },
      more_countries: { value: ["Germany", "France"], confidence: 0.9 },
    },
  );
  assert.equal(fields.countries!.status === "extracted" && fields.countries!.sourceLine, "Available in Germany, Japan and Brazil.");
  assert.equal(fields.more_countries!.status === "uncertain" && fields.more_countries!.notFound, true);
});

test("text matches whole words, ignoring case, curly quotes and emphasis", async () => {
  const page = "The plan is called **“Pro Plus”**.\nRefunds within 30 days.";
  const fields = await extract(
    { name: "text", fragment: "text" },
    { name: { value: '"pro plus"', confidence: 0.9 }, fragment: { value: "Ref", confidence: 0.9 } },
    page,
  );
  assert.equal(fields.name!.status, "extracted");
  assert.equal(fields.fragment!.status, "uncertain");
});

test("the model gets the parsed fields, a local reference date, and at most its page budget", async () => {
  const model = scriptedModel({ price: { value: 20, confidence: 0.9 } }, { maxPageChars: 40 });
  const extraction = await extractWebPageFields({
    page: PRICING_PAGE,
    fields: parseWebExtractFields({ price: "number: Pro monthly price" }),
    model,
    now: () => new Date(2026, 0, 5, 23, 30),
  });
  const [request] = model.requests;
  assert.equal(request!.page, PRICING_PAGE.slice(0, 40));
  assert.equal(request!.referenceDate, "2026-01-05");
  assert.deepEqual({ ...request!.fields }, { price: { type: "number", instructions: "Pro monthly price" } });
  // The value is past the budget, so it was not in what the model read.
  assert.ok(!("error" in extraction));
  assert.equal(extraction.cut, true);
  assert.equal(extraction.fields.price!.status, "uncertain");
});

test("model failures become an error kind; a caller's abort is rethrown", async () => {
  const failing = (error: unknown): WebExtractModel => ({
    id: "failing",
    maxPageChars: 1_000,
    run: async () => {
      throw error;
    },
  });
  const fields = parseWebExtractFields({ price: "number" });
  assert.deepEqual(await extractWebPageFields({ page: "x", fields, model: failing(new WebExtractError("quota")) }), { error: "quota" });
  assert.deepEqual(await extractWebPageFields({ page: "x", fields, model: failing(new Error("boom")) }), { error: "unavailable" });
  assert.deepEqual(
    await extractWebPageFields({ page: "x", fields, model: scriptedModel({ price: "20" }) }),
    { error: "invalid-response" },
  );
  const slow: WebExtractModel = {
    id: "slow",
    maxPageChars: 1_000,
    run: (request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))),
  };
  // The timeout timer does not hold the event loop open on its own.
  const keepAlive = setInterval(() => undefined, 5);
  try {
    assert.deepEqual(await extractWebPageFields({ page: "x", fields, model: slow, timeoutMs: 10 }), { error: "timeout" });
  } finally {
    clearInterval(keepAlive);
  }
  const controller = new AbortController();
  const pending = extractWebPageFields({ page: "x", fields, model: slow, signal: controller.signal });
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/u);
});

test("field maps are checked before anything is sent", () => {
  assert.deepEqual(
    { ...parseWebExtractFields({ a: "integer", b: "duration.days: trial", c: "list.date", d: "datetime" }) },
    {
      a: { type: "number", integer: true },
      b: { type: "duration", unit: "days", instructions: "trial" },
      c: { type: "list", items: "date" },
      d: { type: "datetime" },
    },
  );
  // A field named like an Object.prototype member is an ordinary field.
  assert.deepEqual(Object.keys(parseWebExtractFields({ constructor: "text" })), ["constructor"]);
  for (const bad of [
    null,
    [],
    {},
    { "bad name": "text" },
    { price: 20 },
    { price: "money" },
    { price: "list.text.extra" },
    { price: `text: ${"x".repeat(501)}` },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}`, "text"])),
  ]) {
    assert.throws(() => parseWebExtractFields(bad), Error, JSON.stringify(bad));
  }
});

test("every field name accepted is one Clairic accepts", () => {
  // Cloudflare's published input schema for @cf/cloudflare/clairic, fields.propertyNames.
  const CLAIRIC_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
  const accepted = (name: string) => {
    try {
      parseWebExtractFields({ [name]: "text" });
      return true;
    } catch {
      return false;
    }
  };
  for (const name of ["price", "_private", "Pro_Monthly2", "a".repeat(64)]) assert.equal(accepted(name), true, name);
  for (const name of ["price", "_private", "1price", "9", "a".repeat(64), "a".repeat(65), "has-dash", "has.dot", "has space", "émoji", ""]) {
    if (accepted(name)) assert.match(name, CLAIRIC_FIELD_NAME, name);
  }
  assert.throws(() => parseWebExtractFields({ "1price": "number" }), /start with a letter or underscore/u);
});

test("a long source line is cited as a window around the value", () => {
  const line = `${"a".repeat(300)} PRICE 42 ${"b".repeat(300)}`;
  const start = line.indexOf("42");
  const cited = citeLine(line, start, start + 2);
  assert.ok(cited.includes("PRICE 42"));
  assert.ok(cited.startsWith("…") && cited.endsWith("…"));
  assert.ok(cited.length <= 200);
  assert.equal(citeLine("short   line\twith  spaces", 0, 5), "short line with spaces");
});

test("the model-facing text says which values are guesses", () => {
  const extraction: WebPageExtraction = {
    cut: true,
    fields: {
      price: { status: "extracted", value: 20, confidence: 0.97, sourceLine: "Pro is $20 per month." },
      seats: { status: "uncertain", guess: 50, confidence: 0.4, notFound: true },
      sla: { status: "null", value: null },
    },
  };
  const text = formatWebPageExtraction(extraction);
  assert.match(text, /^price: 20 \(0\.97\) from "Pro is \$20 per month\."$/mu);
  assert.match(text, /^seats: uncertain \(guess 50, 0\.40; not found on the page\)$/mu);
  assert.match(text, /^sla: not on the page$/mu);
  assert.match(text, /first part of the page/u);
  assert.match(text, /guesses/u);
  assert.equal(formatWebPageExtraction({ error: "auth" }), "Extraction failed: the extraction model rejected every saved key.");
});
