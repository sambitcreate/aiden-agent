import type { AidenRemoteConnectionMode } from "../services/aiden-remote-state.js";
import { AIDEN_PAIRING_REQUEST_ID_PATTERN } from "../services/aiden-remote-sealed-envelope.js";

export function parseAidenRemoteConnectionMode(value: unknown): AidenRemoteConnectionMode {
  if (value === "lan" || value === "tailscale" || value === "both") return value;
  throw new Error("Invalid Aiden Remote connection mode.");
}

export function parseAidenRemoteTransport(value: unknown): "lan" | "tailscale" {
  if (value === "lan" || value === "tailscale") return value;
  throw new Error("Invalid Aiden Remote pairing transport.");
}

export function parseAidenRemoteTakeoverToken(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{32}$/u.test(value)) return value;
  throw new Error("Invalid Tailscale takeover review token.");
}

export function parseAidenPairingRequestId(value: unknown): string {
  if (typeof value === "string" && AIDEN_PAIRING_REQUEST_ID_PATTERN.test(value)) return value;
  throw new Error("Invalid connection request identifier.");
}

export function parseAidenPairingRequestDecision(value: unknown): "allow" | "deny" {
  if (value === "allow" || value === "deny") return value;
  throw new Error("Invalid connection request decision.");
}

export function parseAidenRemoteScopedIdentifier(value: unknown): string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  ) return value;
  throw new Error("Invalid Aiden Remote approval identifier.");
}
