import {
  containsHighConfidenceSecretIncludingEncodings,
  isWrappedSecretTail,
  lineIsPathOrVersion,
  redactMultilineCredentialBlocks,
  redactSecretNamedSameLineValues,
  redactSensitiveNextLineBlocks,
  sanitizeCredentialText,
} from "../../../renderer/shared/subagent-safe-text.js";

export const REDACTED_CREDENTIAL = "[REDACTED CREDENTIAL]";
const MAX_PARTIAL_BOUNDARY_COMPARISONS = 50_000;
const PARTIAL_SCAN_LIMIT_NOTICE = "[Additional partial findings omitted after safety scan limit.]";
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u;

const ENDS_IN_REDACTION = /\[REDACTED(?: [A-Z -]+)?\]["'`]?[,;]?$/u;

/**
 * Whether a line reads as text of its own rather than as the rest of a value
 * wrapped from the line above: it is empty or only punctuation, has a space
 * inside it, is one capitalised word ending in punctuation, like `Done.`, or
 * is a file path, file name or version, like `src/config/env.ts` or `v2.3.1`.
 */
function readsAsProse(line: string): boolean {
  const trimmed = line.trim();
  return (
    !/[A-Za-z0-9]/u.test(trimmed) ||
    /\s/u.test(trimmed) ||
    /^[A-Z][a-z]+[.!?]$/u.test(trimmed) ||
    lineIsPathOrVersion(trimmed)
  );
}

/**
 * Join lines for the split-key checks. A line that ends in a redaction marker
 * is a closed value only when the next line reads as prose
 * (`SECRET=[REDACTED]` then `Done.`). Anything else is joined straight on, so
 * the wrapped rest of the value still reads as part of it.
 */
function joinForSplitCheck(lines: readonly string[]): string {
  let joined = "";
  for (const line of lines) {
    joined += ENDS_IN_REDACTION.test(joined) && readsAsProse(line) ? `\n${line}` : line;
  }
  return joined;
}

/** Whether `text` opens a private key block that it does not close. */
function opensPrivateKey(text: string): boolean {
  let lastBegin = -1;
  for (const match of text.matchAll(PRIVATE_KEY_BEGIN)) lastBegin = match.index ?? lastBegin;
  return lastBegin >= 0 && !PRIVATE_KEY_END.test(text.slice(lastBegin));
}

/**
 * Hide whole private key blocks before the text is split into lines, so the
 * body never reaches the line scan without its header. A block left open by
 * one report hides the next report up to its END line, or all of it.
 */
function redactPrivateKeyBlocks(reports: readonly string[]): string[] {
  let open = false;
  return reports.map((entry) => {
    let text = entry;
    if (open) {
      const end = PRIVATE_KEY_END.exec(text);
      text = end
        ? `[REDACTED PRIVATE KEY]${text.slice(end.index + end[0].length)}`
        : "[REDACTED PRIVATE KEY]";
      if (!end) return text;
    }
    open = opensPrivateKey(text);
    return redactMultilineCredentialBlocks(text);
  });
}

/**
 * The display filter for a helper's own words. It hides credentials,
 * including private key blocks, secret-named values on one line or as a
 * block, and keys split across lines, while leaving ordinary text such as
 * file paths readable. Phase 1 uses it for the partial
 * work a stopped helper hands back; the saved helper conversation uses it for
 * every message the helper writes.
 */
export function sanitizePartialFindingsForParent(reports: readonly string[]): string {
  // The line scan below cannot see that `PASSWORD:` owns the indented lines
  // under it, so hide secret-named blocks across lines first.
  const rawReports = redactPrivateKeyBlocks(reports).map((entry) =>
    redactSensitiveNextLineBlocks(entry).split(/\r\n|[\n\r\u2028\u2029]/u),
  );
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
    if (lineIndex >= 0)
      earlierReportTails.push({
        text: lines[lineIndex]!.slice(-128),
        reportIndex,
        lineIndex,
      });
  }
  const report = safeReports.map((lines) => lines.join("\n")).join("\n\n");
  const lines = report.split(/\r\n|[\n\r\u2028\u2029]/u);
  const safeLines: string[] = [];
  for (const line of lines) {
    const directSafe = redactSecretNamedSameLineValues(sanitizeCredentialText(line));
    const previous = safeLines[safeLines.length - 1];
    // The opaque rest of a value wrapped from a line that was just hidden,
    // such as the second half of a key or token, is hidden with it, and so is
    // the line after it while it still continues the value.
    const wrappedTail = isWrappedSecretTail(previous, line);
    safeLines.push(
      wrappedTail || containsHighConfidenceSecretIncludingEncodings(directSafe)
        ? REDACTED_CREDENTIAL
        : directSafe,
    );
  }
  // A sensitive assignment key can be split across lines or settled messages.
  // Find the shortest unsafe adjacent span so unrelated source-path lines stay.
  if (containsHighConfidenceSecretIncludingEncodings(joinForSplitCheck(safeLines))) {
    // A hostile report can consist of thousands of one-character lines. Keep
    // the local span search bounded; the whole-report fallback remains closed.
    if (safeLines.length > 256) return REDACTED_CREDENTIAL;
    const redacted = new Set<number>();
    for (let width = 2; width <= Math.min(8, lines.length); width += 1) {
      for (let start = 0; start + width <= lines.length; start += 1) {
        const indices = Array.from({ length: width }, (_value, offset) => start + offset);
        if (indices.some((index) => redacted.has(index))) continue;
        if (
          containsHighConfidenceSecretIncludingEncodings(
            joinForSplitCheck(safeLines.slice(start, start + width)),
          )
        ) {
          for (const index of indices) redacted.add(index);
        }
      }
    }
    for (const index of redacted) safeLines[index] = REDACTED_CREDENTIAL;
  }
  const partial = safeLines.join("\n").trim();
  // Arbitrarily fragmented or encoded material beyond the local span limit
  // cannot be reconstructed safely; fail closed before the parent sees it.
  if (
    containsHighConfidenceSecretIncludingEncodings(partial) ||
    containsHighConfidenceSecretIncludingEncodings(joinForSplitCheck(safeLines))
  )
    return REDACTED_CREDENTIAL;
  return scanLimitReached ? `${partial}\n${PARTIAL_SCAN_LIMIT_NOTICE}`.trim() : partial;
}

/** Filter one helper message for display in the chat. */
export function sanitizeSubagentWorkText(text: string): string {
  if (!text) return "";
  return sanitizePartialFindingsForParent([text]);
}
