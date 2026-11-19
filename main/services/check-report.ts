/**
 * One way of telling Aiden what is wrong with something it made, shared by
 * every check that runs after a tool call: an inline visual's data check, a
 * raw HTML visual's script check, an artifact's page check and a design
 * page's inspect report. Each report starts with what was checked and how
 * many problems were found, says once what to do about them, then lists
 * them one sentence each, so Aiden reads every check the same way.
 */

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

/**
 * The report as text, starting on a new line so it can follow a tool's own
 * result. A report with nothing wrong is a single line.
 */
export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  const count = report.findings.length;
  if (count > 0) {
    lines.push(`${report.label}: ${count} problem${count === 1 ? "" : "s"} found. ${report.fix}`);
    for (const finding of report.findings.slice(0, CHECK_REPORT_MAX_FINDINGS)) lines.push(`- ${finding}`);
    if (count > CHECK_REPORT_MAX_FINDINGS) lines.push(`- …and ${count - CHECK_REPORT_MAX_FINDINGS} more`);
  } else {
    lines.push(`${report.label}: no problems found${report.clean ? `; ${report.clean}` : ""}.`);
  }
  if (report.unchecked?.length) lines.push(`Not checked: ${report.unchecked.join("; ")}.`);
  const text = `\n${lines.join("\n")}`;
  return text.length > CHECK_REPORT_MAX_CHARS ? `${text.slice(0, CHECK_REPORT_MAX_CHARS - 1)}…` : text;
}
