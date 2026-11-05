import type { BotApprovalRuleTarget } from "../../../renderer/shared/tool-approval-scope.js";
import type { BotClassifiableAction } from "../bot-rules/classify.js";
import { isPaymentHost } from "../bot-rules/words.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";

const EXCLUDED = new Set([COMPUTER_USE_TOOL_NAME, "computer", "computer_shell", "run_command", "share_image"]);
const validIdentity = (value: string) => value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Exact classes for existing baseline approvals only. This grants no authority. */
export function botApprovalTargetOf(
  toolName: string,
  action: BotClassifiableAction | undefined,
): { target: BotApprovalRuleTarget; title: string } | undefined {
  if (EXCLUDED.has(toolName) || !action) return undefined;
  if (action.surface === "mcp") {
    if (!validIdentity(action.serverId) || !validIdentity(action.remoteName)) return undefined;
    const title = (action.annotations?.title ?? "").replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 200);
    return { target: { kind: "connection", serverId: action.serverId, tool: action.remoteName }, title: title || action.remoteName };
  }
  if (action.surface !== "browser" || toolName !== action.tool || !action.url) return undefined;
  try {
    const url = new URL(action.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (isPaymentHost(url.hostname)) return undefined;
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/u.test(host)) return undefined;
    const verb = { browser_click: "click", browser_type: "type", browser_press: "press" } as const;
    return { target: { kind: "site", host, action: verb[action.tool] }, title: host };
  } catch { return undefined; }
}
