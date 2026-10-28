// Webhook triggers (spec §6 P1, D3): `POST /hooks/bot-routines/{token}` on
// Aiden Remote's LAN or Tailscale listener. The token is the only credential;
// it is compared by hash. Every accepted call answers 202 with no body, so the
// response never says whether the routine ran.

import { createHash } from "node:crypto";
import { BOT_WEBHOOK_LIMITS, type BotEventRoutineStore } from "./store.js";
import type { BotRoutineEventDispatcher } from "./dispatcher.js";

export const BOT_WEBHOOK_PATH_PREFIX = "/hooks/bot-routines/";

export interface BotWebhookRequest {
  token: string;
  contentType?: string;
  body: Uint8Array;
}

/** The text the Bot sees: plain text as sent, JSON pretty-printed. */
export function webhookPayload(contentType: string, body: Uint8Array): string | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if (contentType === "application/json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return undefined;
    }
  }
  return text;
}

export function createBotWebhookHandler(deps: {
  store: Pick<BotEventRoutineStore, "findByToken">;
  dispatcher: Pick<BotRoutineEventDispatcher, "emit">;
  now(): number;
}) {
  return async (request: BotWebhookRequest): Promise<{ status: 202 | 400 | 404 | 413 | 415 }> => {
    const routine = await deps.store.findByToken(request.token);
    if (!routine || !routine.enabled) return { status: 404 };
    if (request.body.byteLength > BOT_WEBHOOK_LIMITS.bodyBytes) return { status: 413 };
    const type = (request.contentType ?? "text/plain").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json" && type !== "text/plain") return { status: 415 };
    const payload = webhookPayload(type, request.body);
    if (payload === undefined) return { status: 400 };
    // Identical bodies within a minute are one event.
    const minute = Math.floor(deps.now() / 60_000);
    const eventId = createHash("sha256").update(`${minute}\0`).update(request.body).digest("hex").slice(0, 32);
    await deps.dispatcher.emit(routine.botId, routine.id, { eventId, payload });
    return { status: 202 };
  };
}
