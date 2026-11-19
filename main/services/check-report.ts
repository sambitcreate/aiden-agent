/**
 * One way of telling Aiden what is wrong with something it made, shared by
 * every check that runs after a tool call: an inline visual's data check, a
 * raw HTML visual's script check, an artifact's page check and a design
 * page's inspect report. Each report starts with what was checked and how
 * many problems were found, says once what to do about them, then lists
 * them one sentence each, so Aiden reads every check the same way.
 */

import { clippedUnicode } from "../../renderer/shared/unicode-prefix.js";

/** Problems listed before the rest are only counted. */
export const CHECK_REPORT_MAX_FINDINGS = 10;
/** A report longer than this is cut, so a noisy check can't crowd the context. */
export const CHECK_REPORT_MAX_CHARS = 3_000;

export interface CheckReport {
  /** What was checked, such as "Visual check" or "Page check". */
  label: string;
  /** Problems to fix, one sentence each, each saying what is wrong and where. */
  findings: readonly string[];
  /** What to do once they are fixed, such as "Fix them, then update the page." */
  fix: string;
  /** What could not be checked, such as a source that did not load. */
  unchecked?: readonly string[];
  /** Said after "no problems found" when nothing is wrong, such as what was checked. */
  clean?: string;
}

/** The "Not checked" line is cut to this many characters, so it always fits beside the findings. */
const MAX_UNCHECKED_CHARS = 600;
/** A finding is never cut shorter than this, even when many long ones share the report. */
const MIN_FINDING_CHARS = 80;

/**
 * The longest a finding may be so that every finding shown fits in `budget`
 * characters: the short ones whole, and the long ones cut to one shared length.
 */
function findingCap(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = budget;
  for (let index = 0; index < sorted.length; index += 1) {
    const share = Math.floor(left / (sorted.length - index));
    if (sorted[index]! > share) return Math.max(MIN_FINDING_CHARS, share);
    left -= sorted[index]!;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The report as text, starting on a new line so it can follow a tool's own
 * result. A report with nothing wrong is a single line. When the findings
 * are too long to fit, the long ones are cut, so the count of the rest and
 * what was not checked are still said.
 */
export function formatCheckReport(report: CheckReport): string {
  const head: string[] = [];
  const tail: string[] = [];
  const count = report.findings.length;
  const shown = report.findings.slice(0, CHECK_REPORT_MAX_FINDINGS);
  if (count > 0) {
    head.push(`${report.label}: ${count} problem${count === 1 ? "" : "s"} found. ${report.fix}`);
    if (count > CHECK_REPORT_MAX_FINDINGS) tail.push(`- …and ${count - CHECK_REPORT_MAX_FINDINGS} more`);
  } else {
    head.push(`${report.label}: no problems found${report.clean ? `; ${report.clean}` : ""}.`);
  }
  if (report.unchecked?.length) {
    tail.push(clippedUnicode(`Not checked: ${report.unchecked.join("; ")}.`, MAX_UNCHECKED_CHARS));
  }
  // Each line costs its newline; each finding also its "- ".
  const fixed = [...head, ...tail].reduce((total, line) => total + line.length + 1, 0) + shown.length * 3;
  const cap = findingCap(
    shown.map((finding) => finding.length),
    CHECK_REPORT_MAX_CHARS - fixed,
  );
  const findings = shown.map((finding) => `- ${clippedUnicode(finding, cap)}`);
  const text = `\n${[...head, ...findings, ...tail].join("\n")}`;
  // Only a very long label or fix can still be too long.
  return clippedUnicode(text, CHECK_REPORT_MAX_CHARS);
}
