import QRCode from "qrcode";
import type { AidenRemoteDesktopPairing } from "../../../main/services/aiden-remote-pairing.js";

/** Terminal rendering of the same QR payload the desktop hands to `QRCode.toDataURL`. */
export async function renderPairingTerminal(pairing: AidenRemoteDesktopPairing): Promise<string | undefined> {
  if (!pairing.qrPayload) return undefined;
  const qr = await QRCode.toString(pairing.qrPayload, { type: "terminal", small: true });
  const lines = ["", qr];
  if (pairing.bootstrap.endpoint) lines.push(`Endpoint: ${pairing.bootstrap.endpoint}`);
  if (pairing.manualCode) lines.push(`Manual code: ${pairing.manualCode}`);
  if (pairing.bootstrap.serverSpkiSha256) {
    lines.push(`Verification: ${pairing.bootstrap.serverSpkiSha256.slice(-9, -1).toUpperCase()}`);
  }
  const expiresAt = Date.parse(pairing.bootstrap.expiresAt);
  if (Number.isFinite(expiresAt)) {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    lines.push(`Scan with Aiden on your phone — expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`);
  } else {
    lines.push("Scan with Aiden on your phone.");
  }
  return lines.join("\n");
}
