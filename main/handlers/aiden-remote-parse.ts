import type { AidenRemoteConnectionMode } from "../services/aiden-remote-state.js";

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
