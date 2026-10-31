import { safeApprovalText } from "./assistant.js";

/**
 * The approval card for a hook the agent proposed through the `hooks` tool.
 *
 * It is host-only: the remote projections do not recognize this kind, so a
 * phone or a paired Mac sees the summary with `canAllow: false` and the owner
 * approves on the Mac that runs the chat. The card offers "Allow once" only.
 */
export const HOOK_PROPOSAL_APPROVAL_KIND = "hook-proposal";

export const HOOK_PROPOSAL_COMMAND_LIMIT = 4096;
export const HOOK_PROPOSAL_MATCHER_LIMIT = 500;
export const HOOK_PROPOSAL_LABEL_LIMIT = 200;
export const HOOK_PROPOSAL_WARNING_LIMIT = 400;
export const HOOK_PROPOSAL_MAX_WARNINGS = 8;
export const HOOK_PROPOSAL_MAX_ENV_ALLOW = 32;

/** One hook as the card shows it: what runs, when, and for how long. */
export interface HookProposalApprovalHook {
  event: string;
  /** Empty matches every tool or source. */
  matcher: string;
  command: string;
  timeoutSeconds: number;
  failClosed: boolean;
  envAllow: string[];
}

export interface HookProposalApprovalDetails extends HookProposalApprovalHook {
  kind: typeof HOOK_PROPOSAL_APPROVAL_KIND;
  action: "create" | "update" | "delete";
  /** The hook's name in Settings → Hooks. */
  name: string;
  /** "This chat", or "This workspace (folder)". */
  scopeLabel: string;
  warnings: string[];
  /** The hook as it is now, for an update. */
  previous: HookProposalApprovalHook | null;
  /** First characters of the digest the approval pins. */
  digestPrefix: string;
}

const HOOK_KEYS = ["event", "matcher", "command", "timeoutSeconds", "failClosed", "envAllow"] as const;
const DETAIL_KEYS = [
  "kind",
  "action",
  "name",
  "scopeLabel",
  "warnings",
  "previous",
  "digestPrefix",
  ...HOOK_KEYS,
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isApprovalHook(value: Record<string, unknown>): boolean {
  return (
    safeApprovalText(value.event, 40) &&
    (value.matcher === "" || safeApprovalText(value.matcher, HOOK_PROPOSAL_MATCHER_LIMIT)) &&
    safeApprovalText(value.command, HOOK_PROPOSAL_COMMAND_LIMIT, true) &&
    typeof value.timeoutSeconds === "number" &&
    Number.isFinite(value.timeoutSeconds) &&
    value.timeoutSeconds > 0 &&
    value.timeoutSeconds <= 120 &&
    typeof value.failClosed === "boolean" &&
    Array.isArray(value.envAllow) &&
    value.envAllow.length <= HOOK_PROPOSAL_MAX_ENV_ALLOW &&
    value.envAllow.every((name) => typeof name === "string" && ENV_NAME.test(name))
  );
}

/** Exact shape, bounded text with no control or bidi characters; anything else blocks the card. */
export function isHookProposalApprovalDetails(value: unknown): value is HookProposalApprovalDetails {
  const details = plainRecord(value);
  if (!details || !exactKeys(details, DETAIL_KEYS)) return false;
  if (details.kind !== HOOK_PROPOSAL_APPROVAL_KIND) return false;
  if (details.action !== "create" && details.action !== "update" && details.action !== "delete") return false;
  if (!safeApprovalText(details.name, HOOK_PROPOSAL_LABEL_LIMIT)) return false;
  if (!safeApprovalText(details.scopeLabel, HOOK_PROPOSAL_LABEL_LIMIT)) return false;
  if (!safeApprovalText(details.digestPrefix, 64) || !/^[a-f0-9]+$/u.test(details.digestPrefix)) return false;
  if (
    !Array.isArray(details.warnings) ||
    details.warnings.length > HOOK_PROPOSAL_MAX_WARNINGS ||
    !details.warnings.every((warning) => safeApprovalText(warning, HOOK_PROPOSAL_WARNING_LIMIT))
  ) {
    return false;
  }
  if (!isApprovalHook(details)) return false;
  if (details.previous === null) return details.action !== "update";
  const previous = plainRecord(details.previous);
  return details.action === "update" && previous !== undefined && exactKeys(previous, HOOK_KEYS) && isApprovalHook(previous);
}
