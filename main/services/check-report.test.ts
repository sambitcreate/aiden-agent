import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_REPORT_MAX_CHARS, CHECK_REPORT_MAX_FINDINGS, formatCheckReport } from "./check-report.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

test("a report whose findings are too long still says how many more there are and what was not checked", () => {
  const findings = Array.from({ length: 14 }, (_, index) => `Finding ${index} is wrong: ${"detail ".repeat(100)}`);
  const text = formatCheckReport({ label: "Script check", findings, fix: "Fix them.", unchecked: ["1 module script"] });
  assert.ok(text.length <= CHECK_REPORT_MAX_CHARS, `${text.length} characters`);
  assert.match(text, /^\nScript check: 14 problems found\. Fix them\./u);
  const listed = text.split("\n").filter((line) => line.startsWith("- Finding"));
  assert.deepEqual(
    listed.map((line) => /^- Finding (\d+) is wrong: detail/u.exec(line)?.[1]),
    Array.from({ length: CHECK_REPORT_MAX_FINDINGS }, (_, index) => String(index)),
    "each of the first ten is still there, cut",
  );
  assert.ok(listed.every((line) => line.endsWith("…")));
  assert.match(text, /\n- …and 4 more\nNot checked: 1 module script\.$/u);
});

test("short findings stay whole while the long ones beside them are cut", () => {
  const short = "The chart reads $pr.title, which the source does not have.";
  const findings = [short, "x".repeat(5_000), short, "y".repeat(5_000)];
  const text = formatCheckReport({ label: "Page check", findings, fix: "Fix them, then update the page." });
  assert.ok(text.length <= CHECK_REPORT_MAX_CHARS);
  assert.equal(text.split("\n").filter((line) => line === `- ${short}`).length, 2);
  assert.match(text, /\n- x+…\n/u);
  assert.match(text, /\n- y+…$/u);
});

test("a cut never splits a character made of two code units", () => {
  // Each finding is long enough to be cut; the faces start one unit in, so a cut at an even length splits one.
  const findings = Array.from({ length: 10 }, () => `a${"😀".repeat(400)}`);
  const text = formatCheckReport({ label: "Visual check", findings, fix: "Fix them.", unchecked: [`b${"😀".repeat(400)}`] });
  assert.ok(text.length <= CHECK_REPORT_MAX_CHARS);
  assert.doesNotMatch(text, LONE_SURROGATE);
  assert.match(text, /\nNot checked: b😀+…$/u, "the not-checked line is cut too, and kept");
});

test("a report that fits is left as written", () => {
  assert.equal(formatCheckReport({ label: "Script check", findings: ["One script will not run."], fix: "Fix it." }), "\nScript check: 1 problem found. Fix it.\n- One script will not run.");
  assert.equal(formatCheckReport({ label: "Script check", findings: [], fix: "Fix it.", clean: "all 2 inline scripts compile" }), "\nScript check: no problems found; all 2 inline scripts compile.");
});
