import type { ClientIdentity } from "@earendil-works/pi-ai";

/**
 * How Aiden's Pi requests identify the app to providers. Since Pi 1.4, the
 * Agent loop and the durable Harness attribute requests to pi by default
 * (OpenRouter `HTTP-Referer`/`X-OpenRouter-Title`, NVIDIA NIM
 * `X-BILLING-INVOKE-ORIGIN`, OpenCode `x-opencode-client`). Aiden ships
 * without pi's attribution, as the CLI does through `PI_TELEMETRY=0`, and
 * keeps pi-ai's default `User-Agent`.
 */
export const AIDEN_PI_CLIENT_IDENTITY: ClientIdentity = Object.freeze({ attribution: null });
