import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RENDERER_ERROR_MESSAGE_LENGTH,
  MAX_RENDERER_ERROR_STACK_LENGTH,
} from "../../renderer/shared/diagnostics.js";
import { parseRendererReport } from "./renderer-diagnostic-report.js";

const BASE = { kind: "global-error", errorType: "TypeError", context: "window", referenceId: "RD-0123456789abcdef" };

test("the report the journal sees never holds the raw error, whatever the renderer sends", () => {
  const parsed = parseRendererReport({
    ...BASE,
    error: { name: "TypeError", message: "reply: hello", stack: "at /Users/jane/x.js:1:1" },
    route: "/chats/123",
    windowTitle: "Jane's taxes",
    arguments: ["secret"],
  });

  assert.deepEqual(parsed.report, BASE);
  assert.deepEqual(parsed.errorDetails, { name: "TypeError", message: "reply: hello", stack: "at /Users/jane/x.js:1:1" });
});

test("a report with no raw error parses exactly as it always did", () => {
  assert.deepEqual(parseRendererReport(BASE), { report: BASE });
  assert.deepEqual(parseRendererReport({ ...BASE, suppressed: 4 }), { report: { ...BASE, suppressed: 4 } });
});

test("raw fields are bounded, keep only strings, and cannot reject the report", () => {
  const parsed = parseRendererReport({
    ...BASE,
    error: { name: 7, message: "m".repeat(100_000), stack: "s".repeat(100_000), cause: { apiKey: "secret" } },
  });

  assert.equal(parsed.errorDetails?.message?.length, MAX_RENDERER_ERROR_MESSAGE_LENGTH);
  assert.equal(parsed.errorDetails?.stack?.length, MAX_RENDERER_ERROR_STACK_LENGTH);
  assert.deepEqual(Object.keys(parsed.errorDetails!).sort(), ["message", "stack"]);

  for (const error of ["a string", 12, null, ["x"]]) {
    assert.deepEqual(parseRendererReport({ ...BASE, error }), { report: BASE });
  }
});

test("a suppression summary describes no single error, so it carries none", () => {
  assert.deepEqual(parseRendererReport({ ...BASE, suppressed: 2, error: { message: "x" } }), {
    report: { ...BASE, suppressed: 2 },
  });
});

test("an invalid report is still rejected", () => {
  for (const value of [null, [], { ...BASE, kind: "other" }, { ...BASE, errorType: "Secret" }, { ...BASE, context: "/route" }, { ...BASE, referenceId: "x" }, { ...BASE, suppressed: 0 }]) {
    assert.throws(() => parseRendererReport(value));
  }
});
