// Which tools a Bot may use, and which need the person's approval.
//
// This is the legacy Bot classification from `llm-client.ts`
// (`prepareGeneration`), unchanged, applied to the Bot's current effective
// authority. Full and Custom access differ only in that authority: Full
// mirrors the available inventory (Web still needs its explicit grant), Custom
// carries exactly the bound grants. The same decision runs when tools are
// offered and again at every call.
//
// Exact joins (MCP tools, skills) are computed on demand from a fresh catalog,
// so a connection or skill whose fingerprint changed is refused at call time.

import { ASSISTANT_AUTOMATION_TOOL_NAME } from "../../../renderer/shared/assistant.js";
import { BOT_FILE_TOOL_NAMES } from "../bot-file-tool-router.js";
import type { BotRuntimeEffectiveAuthority, BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import { isComputerUseCapabilityTool } from "../bot-tool-authority.js";
import type { BotOrdinaryCapabilityKind } from "../bot-capability-catalog-core.js";
import { summarizeToolCall } from "../coding-tools.js";
import { SHARE_IMAGE_TOOL_NAME } from "../share-image-tool.js";
import { INSPECT_IMAGE_TOOL_NAME } from "../vision-analysis-tool-core.js";
import { SUGGEST_CONNECTION_TOOL_NAME } from "../bot-runtime-tools/suggest-connection.js";

export const WEB_SEARCH_TOOL = "web_search";
export const SUBAGENT_TOOL = "subagent";
export const ROUTINE_TOOL = ASSISTANT_AUTOMATION_TOOL_NAME;

/** Everything the policy needs about one Bot, read fresh for each decision. */
export interface BotToolFacts {
  readonly authority: Readonly<BotRuntimeEffectiveAuthority>;
  /** Whether the Bot's own model takes images (companion vision is offered only when it does not). */
  readonly supportsImages: boolean;
  /** Bot folder, Full Mac and approved locations the file tools can reach. */
  readonly fileLocations: number;
  /** Model-facing MCP tool name → its exact grant, joined against the current catalog. Throws on drift. */
  mcpTools(): Promise<ReadonlyMap<string, BotRuntimeMcpToolAuthority>>;
  /** Model-facing skill tool names, joined against the current catalog and registry. Throws on drift. */
  skillToolNames(): Promise<ReadonlySet<string>>;
}

/** The turn being prepared, for offer-time rules. */
export interface BotToolTurn {
  /** Telegram turns get no routine tool, as on the legacy path. */
  telegram?: boolean;
}

export type BotToolVerdict = { allowed: true } | { allowed: false; reason: string };

const FILE_TOOLS = new Set<string>(BOT_FILE_TOOL_NAMES);

function hasCapability(facts: BotToolFacts, kind: BotOrdinaryCapabilityKind): boolean {
  return facts.authority.otherCapabilities.some((grant) => grant.kind === kind);
}

function verdict(allowed: boolean, reason: string): BotToolVerdict {
  return allowed ? { allowed: true } : { allowed: false, reason };
}

/** Whether the Bot may use `name` now. */
export async function botToolVerdict(name: string, facts: BotToolFacts, turn: BotToolTurn = {}): Promise<BotToolVerdict> {
  const { authority } = facts;
  if (name === INSPECT_IMAGE_TOOL_NAME) {
    return verdict(!facts.supportsImages && authority.visionProvider !== undefined, "Image understanding is off for this Bot.");
  }
  if (name === WEB_SEARCH_TOOL) return verdict(hasCapability(facts, "web"), "Web search is off for this Bot.");
  if (isComputerUseCapabilityTool(name)) {
    return verdict(hasCapability(facts, "computer_use"), "Computer Use is off for this Bot.");
  }
  if (name === SUBAGENT_TOOL) return verdict(hasCapability(facts, "subagents"), "Subagents are off for this Bot.");
  if (FILE_TOOLS.has(name)) return verdict(facts.fileLocations > 0, "File access is off for this Bot.");
  if (name === "run_command") return verdict(authority.shell.enabled, "The shell is off for this Bot.");
  if (name === SHARE_IMAGE_TOOL_NAME) return verdict(authority.files.botHome, "Sharing images is off for this Bot.");
  if (name === ROUTINE_TOOL) {
    return verdict(hasCapability(facts, "schedules") && turn.telegram !== true, "Routines are off for this Bot.");
  }
  if (name === SUGGEST_CONNECTION_TOOL_NAME) return { allowed: true };
  if ((await facts.skillToolNames()).has(name)) return { allowed: true };
  if ((await facts.mcpTools()).has(name)) return { allowed: true };
  return { allowed: false, reason: "This tool is not available to this Bot." };
}

/**
 * The approval summary when `name` needs the person's approval before it runs
 * (a mutating connection tool, or sharing a local image), else `undefined`.
 * Computer Use asks through its own controller.
 */
export async function botToolApprovalSummary(
  name: string,
  args: unknown,
  facts: BotToolFacts,
): Promise<string | undefined> {
  if (name === SHARE_IMAGE_TOOL_NAME) return summarizeToolCall(name, args);
  if (FILE_TOOLS.has(name) || name === "run_command" || name === WEB_SEARCH_TOOL) return undefined;
  const grant = (await facts.mcpTools()).get(name);
  return grant?.effect === "mutating" ? summarizeToolCall(name, args) : undefined;
}
