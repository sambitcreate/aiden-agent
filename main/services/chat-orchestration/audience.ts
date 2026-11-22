// The internal stream audience a lead chat's started chats run under
// (docs/plans/proactive-aiden-plan.md, Phase 5, D2).
//
// A started chat's turns go through the same Remote chat and stream services a
// paired phone uses, under the audience `chat:<leadChatId>`. That audience has
// no device record: it is never authenticated over HTTP, never reports device
// analytics, and its approvals and questions stay open 30 minutes (answer 22a)
// on the desktop card, Inbox Needs you and phones before they are denied.

const CHAT_AUDIENCE_PREFIX = "chat:";
const LEAD_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/** How long a started chat's approval card or question stays open. */
export const CHAT_AUDIENCE_PROMPT_LIFETIME_MS = 30 * 60 * 1_000;

/** The audience a lead chat's started chats run under. */
export function chatAudience(leadChatId: string): string {
  if (!LEAD_ID.test(leadChatId)) throw new Error("Invalid lead chat id.");
  return `${CHAT_AUDIENCE_PREFIX}${leadChatId}`;
}

/** Whether a stream audience or device id is a lead chat's internal audience. */
export function isChatAudience(audienceId: string): boolean {
  return audienceId.startsWith(CHAT_AUDIENCE_PREFIX);
}

/** The lead chat of an internal audience, or `undefined` for any other audience. */
export function chatAudienceLead(audienceId: string): string | undefined {
  if (!isChatAudience(audienceId)) return undefined;
  const lead = audienceId.slice(CHAT_AUDIENCE_PREFIX.length);
  return LEAD_ID.test(lead) ? lead : undefined;
}

/** The parts of a paired device record these rules read. */
export interface AudienceDeviceRecord {
  id: string;
  type?: string;
  revokedAt?: unknown;
}

/**
 * Whether a turn or chat made for this audience counts in product analytics.
 * An outside MCP app's (type "agent") and a lead chat's started chats never
 * do; a phone or paired computer does.
 */
export function audienceReportsAnalytics(audienceId: string, devices: readonly AudienceDeviceRecord[]): boolean {
  if (isChatAudience(audienceId)) return false;
  return devices.find((device) => device.id === audienceId)?.type !== "agent";
}
