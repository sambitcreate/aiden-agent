import QRCode from "qrcode";
import type { AidenRemoteDesktopPairing } from "../../../main/services/aiden-remote-pairing.js";

/** Light modules around the code: the four the QR standard asks for. A Tailscale code still fits an 80-column window. */
const QUIET_ZONE = 4;
// Fixed palette entries 16 (black) and 231 (white): unlike the 16 theme colors, light and dark terminal themes leave them alone.
const BLACK = 16;
const WHITE = 231;
const RESET = "\x1b[0m";

export interface PairingTerminalOptions {
  /** Width of the terminal in characters; a QR code wider than this would wrap and could not be scanned. */
  columns?: number;
  now?: number;
}

/**
 * The QR code as rows of characters, two modules tall per row, black on
 * white whatever the terminal theme. Every cell is painted by its background
 * color, which fills the whole cell, line spacing included: a cell whose two
 * modules match is a colored space, and one whose modules differ is an upper
 * half block over the lower module's color. Glyphs drawn from the font alone
 * leave light stripes between rows in terminals with extra line spacing.
 * Low error correction keeps the code small: a screen is never smudged.
 */
export function renderQrRows(payload: string): string[] {
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: "L" });
  const size = modules.size;
  const span = size + QUIET_ZONE * 2;
  const color = (row: number, column: number) => {
    const r = row - QUIET_ZONE;
    const c = column - QUIET_ZONE;
    return r >= 0 && c >= 0 && r < size && c < size && !!modules.get(r, c) ? BLACK : WHITE;
  };
  const rows: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    let foreground: number | undefined;
    let background: number | undefined;
    for (let column = 0; column < span; column += 1) {
      const top = color(row, column);
      const bottom = row + 1 < span ? color(row + 1, column) : WHITE;
      if (bottom !== background) { line += `\x1b[48;5;${bottom}m`; background = bottom; }
      if (top === bottom) { line += " "; continue; }
      if (top !== foreground) { line += `\x1b[38;5;${top}m`; foreground = top; }
      line += "▀";
    }
    rows.push(`${line}${RESET}`);
  }
  return rows;
}

/** Characters one row of the QR code takes. */
export function qrWidth(payload: string): number {
  return QRCode.create(payload, { errorCorrectionLevel: "L" }).modules.size + QUIET_ZONE * 2;
}

/**
 * Terminal rendering of the same QR payload the desktop hands to
 * `QRCode.toDataURL`, followed by the address and setup code a phone can
 * take by hand. Each value sits alone on its line, so a triple-click copies
 * exactly that value.
 */
export async function renderPairingTerminal(pairing: AidenRemoteDesktopPairing, options: PairingTerminalOptions = {}): Promise<string | undefined> {
  if (!pairing.qrPayload) return undefined;
  const endpoint = pairing.bootstrap.endpoint;
  const tailscale = isTailscaleEndpoint(endpoint);
  const lines = ["", tailscale ? "Pair over Tailscale" : "Pair on this local network", ""];
  const width = qrWidth(pairing.qrPayload);
  const columns = options.columns ?? process.stdout.columns;
  if (columns && columns < width) {
    lines.push(`The QR code needs a window at least ${width} characters wide, and this one is ${columns}. Widen the window and run \`aiden remote pair ${tailscale ? "tailscale" : "lan"}\` for a new code, or enter the address and setup code below by hand.`);
  } else {
    lines.push(...renderQrRows(pairing.qrPayload));
  }
  lines.push("");
  if (endpoint) {
    lines.push(tailscale ? "Private address:" : "Nearby address:", endpoint, "");
  }
  if (pairing.manualCode) lines.push("Setup code:", pairing.manualCode, "");
  if (pairing.bootstrap.serverSpkiSha256) {
    lines.push(`Verification: ${pairing.bootstrap.serverSpkiSha256.slice(-9, -1).toUpperCase()}`);
  }
  const how = tailscale
    ? "Scan the code with Aiden on your phone, or open the Tailscale tab in Aiden and paste the address and setup code."
    : "Scan the code with Aiden on your phone, or enter the address and setup code on the Nearby tab in Aiden. Your phone must be on the same network as this computer.";
  const expiresAt = Date.parse(pairing.bootstrap.expiresAt);
  if (Number.isFinite(expiresAt)) {
    const seconds = Math.max(0, Math.ceil((expiresAt - (options.now ?? Date.now())) / 1000));
    lines.push(`${how} The code expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`);
  } else {
    lines.push(how);
  }
  return lines.join("\n");
}

function isTailscaleEndpoint(endpoint: string | undefined): boolean {
  try {
    return !!endpoint && new URL(endpoint).hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}
