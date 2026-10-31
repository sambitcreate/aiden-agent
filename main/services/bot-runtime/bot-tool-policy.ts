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

import { BOT_ROUTINES_TOOL_NAME } from "../../../renderer/shared/bot-routine-proposals.js";
import { BOT_FILE_TOOL_NAMES } from "../bot-file-tool-router.js";
import type { BotRuntimeEffectiveAuthority, BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import { isComputerUseCapabilityTool } from "../bot-tool-authority.js";
import type { BotOrdinaryCapabilityKind } from "../bot-capability-catalog-core.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { summarizeToolCall } from "../coding-tools.js";
import { SHARE_IMAGE_TOOL_NAME } from "../share-image-tool.js";
import { SKILL_TOOL_NAME } from "../skill-registry-core.js";
import { INSPECT_IMAGE_TOOL_NAME } from "../vision-analysis-tool-core.js";
import { SUGGEST_CONNECTION_TOOL_NAME } from "../bot-runtime-tools/suggest-connection.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../../renderer/shared/ask-user-question.js";
import { BOT_HANDOFF_TOOL_NAME, BOT_SIGN_IN_TOOL_NAME } from "../../../renderer/shared/bot-handoffs.js";
import { BOT_INTRO_REQUEST_PREFIX } from "./bot-intro.js";
import { BOT_WAKE_UP_TOOL_NAME } from "../../../renderer/shared/bot-wake-ups.js";
import { BROWSER_BOT_OMITTED_TOOLS, BROWSER_TOOL_NAMES, isBrowserToolName } from "../browser-tools.js";
import { BOT_BROWSER_GATEWAY_TOOL } from "./bot-tool-disclosure.js";
import { BOT_COMPUTER_SHELL_TOOL_NAME, BOT_COMPUTER_TOOL_NAME } from "../bot-computers/types.js";

export const WEB_SEARCH_TOOL = "web_search";
export const SUBAGENT_TOOL = "subagent";
export const ROUTINE_TOOL = BOT_ROUTINES_TOOL_NAME;
/** Per-routine notepad (`bot-routine-notes.ts`); offered only to routine runs. */
export const ROUTINE_NOTES_TOOL = "routine_notes";
/** A Bot's own bounded wake-ups (`bot-wake-ups/`); offered only on turns a person started. */
export const WAKE_UP_TOOL = BOT_WAKE_UP_TOOL_NAME;

/** Everything the policy needs about one Bot, read fresh for each decision. */
export interface BotToolFacts {
  readonly authority: Readonly<BotRuntimeEffectiveAuthority>;
  /** Whether the Bot's own model takes images (companion vision is offered only when it does not). */
  readonly supportsImages: boolean;
  /** Bot folder, Full Mac and approved locations the file tools can reach. */
  readonly fileLocations: number;
  /** The Bot has its own computer on a host with Bot computers (never on Linux). */
  readonly hasComputer: boolean;
  /** Model-facing MCP tool name → its exact grant, joined against the current catalog. Throws on drift. */
  mcpTools(): Promise<ReadonlyMap<string, BotRuntimeMcpToolAuthority>>;
  /** Model-facing skill tool names, joined against the current catalog and registry. Throws on drift. */
  skillToolNames(): Promise<ReadonlySet<string>>;
  /**
   * The internal skill identity (one of `skillToolNames`) that the `skill`
   * tool's `name` argument loads, or `undefined` when no granted skill matches.
   */
  skillToolKeyFor?(name: string): Promise<string | undefined>;
  /**
   * The live tools/list entry of a granted MCP tool (its title, description
   * and annotations), for the rules classifier. `undefined` when `name` is not
   * a granted tool.
   */
  mcpToolDescriptor?(name: string): Promise<SubagentMcpRemoteTool | undefined>;
}

/** The turn being prepared, for offer-time rules. */
export interface BotToolTurn {
  /** Telegram turns get no routine tool, as on the legacy path. */
  telegram?: boolean;
  /** Routine runs get no question or hand-off card: nobody is waiting on the other end. */
  routine?: boolean;
}

export type BotToolVerdict = { allowed: true } | { allowed: false; reason: string };

/** The ingress rules of one input, from its request id. */
export function botTurnOf(requestId: string | undefined): Required<BotToolTurn> & { intro: boolean } {
  return {
    telegram: requestId?.startsWith("tg:") ?? false,
    routine: requestId?.startsWith("routine:") ?? false,
    intro: requestId?.startsWith(BOT_INTRO_REQUEST_PREFIX) ?? false,
  };
}

const UNATTENDED_WITHHELD = new Set<string>([
  ASK_USER_QUESTION_TOOL_NAME,
  ROUTINE_TOOL,
  SUBAGENT_TOOL,
  BOT_HANDOFF_TOOL_NAME,
  // Nobody can sign in, approve a click or use a held tab on these turns (G12).
  BOT_SIGN_IN_TOOL_NAME,
  BOT_BROWSER_GATEWAY_TOOL,
  ...BROWSER_TOOL_NAMES,
  // A skill needs the person's OK on a card (spec 2026-10-27 §7 L2).
  "propose_skill",
]);

/**
 * Whether an input from this ingress may use `name`, whatever the Bot's
 * access: the self-intro uses no tools, and routine and Telegram turns get no
 * question, hand-off or sign-in card, browser, routine tool or subagents. A
 * run that serves several inputs (a steer joined it) may use a tool only when
 * every input allows it.
 */
export function botIngressAllowsTool(name: string, requestIds: readonly (string | undefined)[]): boolean {
  // A routine's notepad belongs to routine runs alone: a person's turn, or a
  // run a person's message joined, never sees it.
  if (name === ROUTINE_NOTES_TOOL) {
    return requestIds.length > 0 && requestIds.every((requestId) => botTurnOf(requestId).routine);
  }
  // A wake-up is the Bot's answer to a person: no routine, event, catch-up or
  // wake-up run sets another one, so a Bot cannot keep itself awake.
  if (name === WAKE_UP_TOOL) {
    return requestIds.every((requestId) => {
      const turn = botTurnOf(requestId);
      return !turn.routine && !turn.intro;
    });
  }
  return requestIds.every((requestId) => {
    const turn = botTurnOf(requestId);
    if (turn.intro) return false;
    if (turn.telegram || turn.routine) return !UNATTENDED_WITHHELD.has(name);
    return true;
  });
}

const FILE_TOOLS = new Set<string>(BOT_FILE_TOOL_NAMES);

function hasCapability(facts: BotToolFacts, kind: BotOrdinaryCapabilityKind): boolean {
  return facts.authority.otherCapabilities.some((grant) => grant.kind === kind);
}

function verdict(allowed: boolean, reason: string): BotToolVerdict {
  return allowed ? { allowed: true } : { allowed: false, reason };
}

/** Whether the Bot may use `name` now. */
export async function botToolVerdict(
  name: string,
  facts: BotToolFacts,
  turn: BotToolTurn = {},
  args?: unknown,
): Promise<BotToolVerdict> {
  const { authority } = facts;
  if (name === INSPECT_IMAGE_TOOL_NAME) {
    return verdict(!facts.supportsImages && authority.visionProvider !== undefined, "Image understanding is off for this Bot.");
  }
  if (name === WEB_SEARCH_TOOL) return verdict(hasCapability(facts, "web"), "Web search is off for this Bot.");
  if (isComputerUseCapabilityTool(name)) {
    return verdict(hasCapability(facts, "computer_use"), "Computer Use is off for this Bot.");
  }
  if (name === BOT_COMPUTER_TOOL_NAME || name === BOT_COMPUTER_SHELL_TOOL_NAME) {
    // Inside the Bot's own computer: allowed on routine and Telegram turns too (§8.7).
    if (!hasCapability(facts, "computer")) return { allowed: false, reason: "The computer is off for this Bot." };
    if (!facts.hasComputer) return { allowed: false, reason: "This Bot doesn't have a computer yet." };
    // The screen is vision only; a model without image input gets the shell alone.
    if (name === BOT_COMPUTER_TOOL_NAME && !facts.supportsImages) {
      return { allowed: false, reason: "This Bot's model can't see images, so it can't use its computer's screen." };
    }
    return { allowed: true };
  }
  if (name === SUBAGENT_TOOL) return verdict(hasCapability(facts, "subagents"), "Subagents are off for this Bot.");
  if (FILE_TOOLS.has(name)) return verdict(facts.fileLocations > 0, "File access is off for this Bot.");
  if (name === "run_command") return verdict(authority.shell.enabled, "The shell is off for this Bot.");
  if (name === SHARE_IMAGE_TOOL_NAME) return verdict(authority.files.botHome, "Sharing images is off for this Bot.");
  if (name === ROUTINE_TOOL) {
    return verdict(
      hasCapability(facts, "schedules") && turn.telegram !== true && turn.routine !== true,
      "Routines are off for this Bot turn.",
    );
  }
  if (name === ASK_USER_QUESTION_TOOL_NAME) {
    return verdict(turn.telegram !== true && turn.routine !== true, "Questions are off for this Bot.");
  }
  if (name === BOT_HANDOFF_TOOL_NAME) {
    return verdict(turn.telegram !== true && turn.routine !== true, "Hand-offs are off for this Bot.");
  }
  if (name === BOT_SIGN_IN_TOOL_NAME) {
    // The person signs in in the Bot's own browser or on its own computer, so
    // the Bot needs one of them, and someone there to sign in.
    const where = hasCapability(facts, "browser") || (hasCapability(facts, "computer") && facts.hasComputer);
    return verdict(
      where && turn.telegram !== true && turn.routine !== true,
      "Sign-in needs the Browser or a computer in this Bot's access.",
    );
  }
  if (name === BOT_BROWSER_GATEWAY_TOOL || isBrowserToolName(name)) {
    // A page script can read a field's value and a recording shows what the
    // person types: a Bot never gets either (plan §5.1.6).
    if (BROWSER_BOT_OMITTED_TOOLS.has(name)) return { allowed: false, reason: "A Bot's browser can't run page scripts or record." };
    return verdict(
      hasCapability(facts, "browser") && turn.telegram !== true && turn.routine !== true,
      "The browser is off for this Bot.",
    );
  }
  if (name === SUGGEST_CONNECTION_TOOL_NAME) return { allowed: true };
  // The per-Bot switch decides whether it is offered at all; ingress keeps it to a person's turns.
  if (name === WAKE_UP_TOOL) return verdict(turn.routine !== true, "Wake-ups are off for this Bot turn.");
  // Writes only the routine's own notes; ingress (`botIngressAllowsTool`) keeps it to routine runs.
  if (name === ROUTINE_NOTES_TOOL) return { allowed: true };
  // The one `skill` tool loads only the granted skills it was built from.
  if (name === SKILL_TOOL_NAME) {
    const granted = await facts.skillToolNames();
    if (granted.size === 0) return { allowed: false, reason: "No skills are enabled for this Bot." };
    // At call time the named skill itself must still be granted.
    const requested = (args as { name?: unknown } | undefined)?.name;
    if (args === undefined || typeof requested !== "string") return { allowed: true };
    const key = await facts.skillToolKeyFor?.(requested);
    return verdict(key !== undefined && granted.has(key), "This skill is not enabled for this Bot.");
  }
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
  // The browser asks through its live tab and page (`bot-browser-approval.ts`).
  if (name === BOT_BROWSER_GATEWAY_TOOL || isBrowserToolName(name)) return undefined;
  // Inside the Bot's own computer the baseline is allowed; rules read the intent (§8.7).
  if (name === BOT_COMPUTER_TOOL_NAME || name === BOT_COMPUTER_SHELL_TOOL_NAME) return undefined;
  const grant = (await facts.mcpTools()).get(name);
  return grant?.effect === "mutating" ? summarizeToolCall(name, args) : undefined;
}
