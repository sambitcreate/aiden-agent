// Contract revision 36 (`bot:handoffs`): what each kind of device is sent
// about hand-offs and pause. Pure.
//
// Shipped phones decode closed enums and exact keys, so only a device that
// negotiated `bot:handoffs` receives the `handoff` field and frame, the
// `paused` session state and the Bot `paused` flag. Every other device keeps
// the revision-35 view: a paused Bot reads as unavailable, and a waiting
// hand-off reads as one assistant line asking the person to go to the Mac.

import { isBotHandoffOpenUrl, normalizeBotHandoffAction, type BotPendingHandoff } from "../../renderer/shared/bot-handoffs.js";
import {
  parseAidenRemoteBotHandoff,
  type AidenRemoteBotDetail,
  type AidenRemoteBotHandoff,
  type AidenRemoteBotSessionEntry,
  type AidenRemoteBotSessionStateView,
  type AidenRemoteBotSummary,
} from "./aiden-remote-protocol.js";

/** Whether a device holds `bot:handoffs`. */
export interface AidenRemoteBotHandoffAudience {
  handoffs: boolean;
}

export const LEGACY_AUDIENCE: AidenRemoteBotHandoffAudience = { handoffs: false };

/** Wire id of a legacy device's notice for one waiting hand-off. */
export function legacyHandoffNoticeId(waitId: string): string {
  return `handoff-notice:${waitId}`;
}

/**
 * A waiting hand-off card as a `bot:handoffs` device sees it. A link that is
 * not a safe https page is left out, and so is a rule card's page: it is the
 * Bot's own tab on the Mac, and in the device's browser the step would act on
 * the person's own session.
 */
export function toRemoteBotHandoff(prompt: BotPendingHandoff): AidenRemoteBotHandoff {
  const url = prompt.source === "rule" ? undefined : prompt.open?.url;
  const why = prompt.why?.trim();
  return parseAidenRemoteBotHandoff({
    waitId: prompt.waitId,
    kind: prompt.kind,
    action: prompt.action,
    ...(why ? { why: prompt.why } : {}),
    ...(url !== undefined && isBotHandoffOpenUrl(url) ? { open: { url } } : {}),
  });
}

/**
 * What a device without `bot:handoffs` shows for a waiting hand-off: one
 * assistant line, "Ada needs you on your Mac: Enter the 2FA code". It has no
 * `createdAt`, so it never moves a chat's preview or unread state.
 */
export function legacyHandoffNotice(botName: string, prompt: BotPendingHandoff): AidenRemoteBotSessionEntry {
  const name = botName.replace(/\s+/gu, " ").trim() || "Your Bot";
  return {
    type: "message",
    id: legacyHandoffNoticeId(prompt.waitId),
    role: "assistant",
    text: `${name} needs you on your Mac: ${normalizeBotHandoffAction(prompt.action)}`,
  };
}

/** A session state as one device sees it: a person's pause is `unavailable` without `bot:handoffs`. */
export function stateViewForAudience(
  view: AidenRemoteBotSessionStateView,
  audience: AidenRemoteBotHandoffAudience,
): AidenRemoteBotSessionStateView {
  if (audience.handoffs || view.state !== "paused") return view;
  return { state: "unavailable", interrupted: false };
}

/**
 * A Bot summary as one device sees it. The host builds the holder view
 * (`sessionState: "paused"` with `paused: true`); other devices get
 * `unavailable` and no flag. A summary carries `paused` only as `true`.
 */
export function projectBotSummaryForAudience(
  summary: AidenRemoteBotSummary,
  audience: AidenRemoteBotHandoffAudience,
): AidenRemoteBotSummary {
  const { paused, ...rest } = summary;
  if (audience.handoffs) return paused === true ? { ...rest, paused: true } : rest;
  return rest.sessionState === "paused" ? { ...rest, sessionState: "unavailable" } : rest;
}

/** A Bot detail as one device sees it: holders always get `paused`, others never. */
export function projectBotDetailForAudience(
  detail: AidenRemoteBotDetail,
  audience: AidenRemoteBotHandoffAudience,
): AidenRemoteBotDetail {
  const { paused, ...rest } = detail;
  if (audience.handoffs) return { ...rest, paused: paused === true };
  return rest.sessionState === "paused" ? { ...rest, sessionState: "unavailable" } : rest;
}
