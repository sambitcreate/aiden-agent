import { isBoundedBotText } from "./bot-capabilities.js";
import { withoutBotHandoffControls } from "./bot-handoffs.js";

export const BOT_REQUEST_ACCESS_TOOL_NAME = "request_access";
export const BOT_ACCESS_WHY_MAX_CHARS = 400;
export const BOT_ACCESS_PATH_MAX_BYTES = 4_096;
export const BOT_ACCESS_LABEL_MAX_CHARS = 120;
export const BOT_ACCESS_PLACE_MAX_CHARS = 512;
export const BOT_RUN_ACCESS_LOCATION_ID = "run.access";
export const BOT_RUN_ACCESS_LOCATION_LABEL = "Allowed for this task";
export const BOT_WHOLE_MAC_REQUEST = "whole_mac";
export type BotAccessTarget = "folder" | "whole_mac";
export type BotAccessChoice = "once" | "always" | "not_now";
export interface BotPendingAccessRequest {
  botId: string;
  waitId: string;
  toolCallId: string;
  target: BotAccessTarget;
  label: string;
  place?: string;
  why: string;
  choices: BotAccessChoice[];
  approvalCount?: number;
}
export type BotAccessOutcome =
  | BotAccessChoice
  | "already_allowed"
  | "declined_earlier"
  | "access_changed"
  | "asked_later";
export interface BotAccessResultDetails {
  target: BotAccessTarget;
  label: string;
  outcome: BotAccessOutcome;
}

/** Main-only persisted authorization. Public card and issue projections omit it. */
export interface BotAccessAuthorization {
  policyRevision: string;
  requestIds: readonly string[];
  target: BotAccessTarget;
  root: string;
  identity?: { device: string; inode: string };
  rootId?: string;
  choices: readonly BotAccessChoice[];
  inventoryRevision?: string;
}

export function botAccessAuthorizationOf(value: unknown): BotAccessAuthorization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "policyRevision",
          "requestIds",
          "target",
          "root",
          "identity",
          "rootId",
          "choices",
          "inventoryRevision",
        ].includes(key),
    )
  )
    return null;
  if (
    !isBoundedBotText(v.policyRevision, 256) ||
    !v.policyRevision.trim() ||
    !Array.isArray(v.requestIds) ||
    v.requestIds.length === 0 ||
    v.requestIds.length > 256 ||
    v.requestIds.some((id) => !isBoundedBotText(id, 256) || !id.trim()) ||
    new Set(v.requestIds).size !== v.requestIds.length
  )
    return null;
  if (v.target !== "folder" && v.target !== "whole_mac") return null;
  if (
    typeof v.root !== "string" ||
    !v.root.startsWith("/") ||
    v.root.includes("\0") ||
    new TextEncoder().encode(v.root).length > BOT_ACCESS_PATH_MAX_BYTES
  )
    return null;
  const choices = botAccessChoicesFor({
    target: v.target,
    alwaysOffered: Array.isArray(v.choices) && v.choices.includes("always"),
  });
  if (!Array.isArray(v.choices) || JSON.stringify(v.choices) !== JSON.stringify(choices))
    return null;
  if (
    v.inventoryRevision !== undefined &&
    (typeof v.inventoryRevision !== "string" || !/^[a-f0-9]{64}$/u.test(v.inventoryRevision))
  )
    return null;
  if (
    v.rootId !== undefined &&
    (typeof v.rootId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(v.rootId))
  )
    return null;
  if (v.target === "whole_mac") {
    if (v.root !== "/" || v.rootId !== undefined || v.identity !== undefined) return null;
  } else {
    const id = v.identity as Record<string, unknown> | null;
    if (
      v.root === "/" ||
      !id ||
      typeof id !== "object" ||
      Array.isArray(id) ||
      Object.keys(id).sort().join(",") !== "device,inode" ||
      typeof id.device !== "string" ||
      typeof id.inode !== "string" ||
      !/^(?:0|[1-9][0-9]{0,63})$/u.test(id.device) ||
      !/^(?:0|[1-9][0-9]{0,63})$/u.test(id.inode)
    )
      return null;
  }
  return {
    policyRevision: v.policyRevision,
    requestIds: [...v.requestIds] as string[],
    target: v.target,
    root: v.root,
    ...(v.identity ? { identity: { ...(v.identity as { device: string; inode: string }) } } : {}),
    ...(v.rootId === undefined ? {} : { rootId: v.rootId as string }),
    choices,
    ...(v.inventoryRevision === undefined
      ? {}
      : { inventoryRevision: v.inventoryRevision as string }),
  };
}

export function botAccessChoicesFor(input: {
  target: BotAccessTarget;
  alwaysOffered: boolean;
}): BotAccessChoice[] {
  return input.target === "folder" && input.alwaysOffered
    ? ["not_now", "always", "once"]
    : ["not_now", "once"];
}
export function parseBotAccessChoice(value: unknown): BotAccessChoice | null {
  return value === "once" || value === "always" || value === "not_now" ? value : null;
}
function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = withoutBotHandoffControls(value).trim();
  return clean && isBoundedBotText(clean, max) ? clean : undefined;
}
export function botPendingAccessRequestOf(value: unknown): BotPendingAccessRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        !["botId", "waitId", "toolCallId", "target", "label", "place", "why", "choices", "approvalCount"].includes(
          key,
        ),
    )
  )
    return null;
  const botId = textOf(v.botId, 128),
    toolCallId = textOf(v.toolCallId, 256);
  if (
    !botId ||
    !toolCallId ||
    typeof v.waitId !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/u.test(v.waitId)
  )
    return null;
  if (v.target !== "folder" && v.target !== "whole_mac") return null;
  const label = textOf(v.label, BOT_ACCESS_LABEL_MAX_CHARS),
    why = textOf(v.why, BOT_ACCESS_WHY_MAX_CHARS);
  if (!label || !why) return null;
  const place = v.place === undefined ? undefined : textOf(v.place, BOT_ACCESS_PLACE_MAX_CHARS);
  if (v.target === "whole_mac" && (v.place !== undefined || label !== "your whole Mac"))
    return null;
  if (
    v.place !== undefined &&
    (!place || !(place === "~" || place.startsWith("~/") || place.startsWith("/")))
  )
    return null;
  if (!Array.isArray(v.choices)) return null;
  const suppliedChoices = v.choices;
  const choices = botAccessChoicesFor({
    target: v.target,
    alwaysOffered: suppliedChoices.includes("always"),
  });
  if (
    suppliedChoices.length !== choices.length ||
    choices.some((choice, index) => choice !== suppliedChoices[index])
  )
    return null;
  if (v.approvalCount !== undefined && (v.target !== "folder" || !choices.includes("always") ||
      !Number.isInteger(v.approvalCount) || (v.approvalCount as number) < 3 || (v.approvalCount as number) > 20)) return null;
  return {
    botId,
    waitId: v.waitId,
    toolCallId,
    target: v.target,
    label,
    ...(place === undefined ? {} : { place }),
    why,
    choices,
    ...(v.approvalCount === undefined ? {} : { approvalCount: v.approvalCount as number }),
  };
}
export function botAccessCardTitle(
  botName: string,
  request: Pick<BotPendingAccessRequest, "target" | "label">,
): string {
  return `${botName} wants to use ${request.target === "whole_mac" ? "your whole Mac" : request.label}`;
}
export function botAccessResultLine(details: BotAccessResultDetails): string {
  switch (details.outcome) {
    case "once":
      return `Allowed ${details.label} once`;
    case "always":
      return `Always allowed ${details.label}`;
    case "not_now":
      return `Not now: ${details.label}`;
    case "already_allowed":
      return `Already allowed ${details.label}`;
    case "declined_earlier":
      return `Already declined ${details.label}`;
    case "asked_later":
      return `Asked for ${details.label}`;
    case "access_changed":
      return `Access changed for ${details.label}`;
  }
}
