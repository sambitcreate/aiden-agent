import {
  containsHighConfidenceSecretIncludingEncodings,
  redactSensitiveNextLineBlocks,
  sanitizeCredentialText,
} from "../../../renderer/shared/subagent-safe-text.js";

export const REDACTED_CREDENTIAL = "[REDACTED CREDENTIAL]";
const MAX_PARTIAL_BOUNDARY_COMPARISONS = 50_000;
const PARTIAL_SCAN_LIMIT_NOTICE = "[Additional partial findings omitted after safety scan limit.]";

/**
 * The display filter for a helper's own words. It hides credentials,
 * including secret-named blocks and keys split across lines, while leaving
 * ordinary text such as file paths readable. Phase 1 uses it for the partial
 * work a stopped helper hands back; the saved helper conversation uses it for
 * every message the helper writes.
 */
export function sanitizePartialFindingsForParent(reports: readonly string[]): string {
  // The line scan below cannot see that `PASSWORD:` owns the indented lines
  // under it, so hide secret-named blocks across lines first.
  const rawReports = reports.map((entry) => redactSensitiveNextLineBlocks(entry).split(/\r\n|[\n\r\u2028\u2029]/u));
  const safeReports = rawReports.map((lines) => [...lines]);
  const earlierReportTails: Array<{ text: string; reportIndex: number; lineIndex: number }> = [];
  let comparisons = 0;
  let scanLimitReached = false;
  reportScan: for (const [reportIndex, lines] of rawReports.entries()) {
    for (const [lineIndex, line] of lines.entries()) {
      for (const tail of earlierReportTails) {
        // Non-adjacent reports can still carry a key prefix and its value.
        // Only already-checked lines may reach the parent when this scan cap
        // is exhausted. The current and later lines remain unclassified.
        if (++comparisons > MAX_PARTIAL_BOUNDARY_COMPARISONS) {
          safeReports.length = reportIndex + 1;
          safeReports[reportIndex]!.length = lineIndex;
          scanLimitReached = true;
          break reportScan;
        }
        if (containsHighConfidenceSecretIncludingEncodings(tail.text + line)) {
          safeReports[reportIndex]![lineIndex] = REDACTED_CREDENTIAL;
          safeReports[tail.reportIndex]![tail.lineIndex] = REDACTED_CREDENTIAL;
          break;
        }
      }
    }
    let lineIndex = lines.length - 1;
    while (lineIndex >= 0 && !lines[lineIndex]!.trim()) lineIndex -= 1;
    if (lineIndex >= 0) earlierReportTails.push({
      text: lines[lineIndex]!.slice(-128),
      reportIndex,
      lineIndex,
    });
  }
  const report = safeReports.map((lines) => lines.join("\n")).join("\n\n");
  const lines = report.split(/\r\n|[\n\r\u2028\u2029]/u);
  const safeLines = lines.map((line) => {
    const directSafe = sanitizeCredentialText(line);
    return containsHighConfidenceSecretIncludingEncodings(directSafe)
      ? REDACTED_CREDENTIAL
      : directSafe;
  });
  // A sensitive assignment key can be split across lines or settled messages.
  // Find the shortest unsafe adjacent span so unrelated source-path lines stay.
  if (containsHighConfidenceSecretIncludingEncodings(safeLines.join(""))) {
    // A hostile report can consist of thousands of one-character lines. Keep
    // the local span search bounded; the whole-report fallback remains closed.
    if (safeLines.length > 256) return REDACTED_CREDENTIAL;
    const redacted = new Set<number>();
    for (let width = 2; width <= Math.min(8, lines.length); width += 1) {
      for (let start = 0; start + width <= lines.length; start += 1) {
        const indices = Array.from({ length: width }, (_value, offset) => start + offset);
        if (indices.some((index) => redacted.has(index))) continue;
        if (containsHighConfidenceSecretIncludingEncodings(
          safeLines.slice(start, start + width).join(""),
        )) {
          for (const index of indices) redacted.add(index);
        }
      }
    }
    for (const index of redacted) safeLines[index] = REDACTED_CREDENTIAL;
  }
  const partial = safeLines.join("\n").trim();
  // Arbitrarily fragmented or encoded material beyond the local span limit
  // cannot be reconstructed safely; fail closed before the parent sees it.
  if (containsHighConfidenceSecretIncludingEncodings(partial) ||
    containsHighConfidenceSecretIncludingEncodings(safeLines.join(""))
  ) return REDACTED_CREDENTIAL;
  return scanLimitReached ? `${partial}\n${PARTIAL_SCAN_LIMIT_NOTICE}`.trim() : partial;
}

/** Filter one helper message for display in the chat. */
export function sanitizeSubagentWorkText(text: string): string {
  if (!text) return "";
  return sanitizePartialFindingsForParent([text]);
}
