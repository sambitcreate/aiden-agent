// Contract revision 37 (`bot:handoffs`): what each kind of device is sent
// about hand-offs and pause. Pure.
//
// Shipped phones decode closed enums and exact keys, so only a device that
// negotiated `bot:handoffs` receives the `handoff` field and frame, the
// `paused` session state and the Bot `paused` flag. Every other device keeps
// the revision-35 view: a paused Bot reads as unavailable, and a waiting
// hand-off reads as one assistant line asking the person to go to the Mac.

import {
  botHandoffTakesNote,
  isBotHandoffOpenUrl,
  normalizeBotHandoffAction,
  type BotPendingHandoff,
} from "../../renderer/shared/bot-handoffs.js";
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
 * A card's page in the one form every client reads. The Mac checks a page
 * with the WHATWG parser, which also accepts forms the phones refuse
 * (`https:bank.example.com`, `https://@bank.example.com/`, a tab inside), and
 * a phone that refuses a card's page can't decode the session at all. So a
 * page goes out as that parser prints it; one already in that form, or a bare
 * origin as a sign-in names it, goes as it is. Undefined when the page is not
 * one a card may open, before or after printing.
 */
function cardPage(url: string): string | undefined {
  if (!isBotHandoffOpenUrl(url)) return undefined;
  const printed = new URL(url).href;
  if (printed === url || printed === `${url}/`) return url;
  return isBotHandoffOpenUrl(printed) ? printed : undefined;
}

/**
 * A waiting hand-off card as a `bot:handoffs` device sees it. A link that is
 * not a safe https page is left out, and so is the page of a step on the
 * Bot's own browser or computer (a rule card's, or one the Bot said is
 * there): it is the Bot's own screen on the Mac, and in the device's browser
 * the step would act on the person's own session. Such a step says so
 * instead (`onMac`, revision 43), so the device offers Finish on your Mac. A
 * card that takes no note says so (revision 40), so the device hides its note
 * box.
 */
export function toRemoteBotHandoff(prompt: BotPendingHandoff): AidenRemoteBotHandoff {
  const onMac = prompt.kind === "action" && prompt.target !== undefined;
  const url =
    prompt.source === "rule" || onMac || prompt.open === undefined ? undefined : cardPage(prompt.open.url);
  const why = prompt.why?.trim();
  return parseAidenRemoteBotHandoff({
    waitId: prompt.waitId,
    kind: prompt.kind,
    action: prompt.action,
    ...(why ? { why: prompt.why } : {}),
    ...(url !== undefined ? { open: { url } } : {}),
    ...(botHandoffTakesNote(prompt) ? {} : { takesNote: false }),
    ...(onMac ? { onMac: true } : {}),
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
