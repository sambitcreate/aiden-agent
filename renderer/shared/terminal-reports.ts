/**
 * Answers a terminal sends on its own to a program's queries: device
 * attributes, status and cursor reports, mode reports, keyboard flags, window
 * reports, focus events, and OSC or DCS replies. A shell's startup files ask
 * these; none of them is someone typing. The Ghostty core tests hold this to
 * the replies the real terminal sends and to the keys it encodes.
 */
const TERMINAL_REPORTS =
  // eslint-disable-next-line no-control-regex -- escape sequences are the point
  /^(?:\x1b\[[?>=]?[\d;]*[cnRt]|\x1b\[\??[\d;]*\$y|\x1b\[\?\d*u|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/u;

/** True when a terminal write is only the terminal's own replies, not input. */
export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORTS.test(data);
}
