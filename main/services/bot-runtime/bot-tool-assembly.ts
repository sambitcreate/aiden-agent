import { withBotConnectorModelEffect } from "../bot-connector-inventory-scope.js";
import { botExecutionScope } from "./bot-execution.js";
import { calendarWatchCallAllowed } from "../bot-routine-events/connector-calendar-policy.js";
// Turns a Bot's current authority into the `aiden-bot` extension's tool,
// policy and guidance dependencies.
//
// - Offer: every candidate tool (built by the legacy factories in
//   `bot-tool-sources-main.ts`) passes `botToolVerdict` against a fresh
//   admission, or it is not offered.
// - Call: `checkPolicy` admits again, re-runs the same verdict (including the
//   exact MCP/skill joins, so a changed fingerprint is refused) and decides
//   whether the person must approve.
// - Rules (plan §6.3): after today's approval decision (the baseline), the
//   Bot's rules, read fresh, classify the call and can only tighten it:
//   ruled = max(baseline, strictest matching rule). A rule-made ask creates or
//   prefixes the approval ("Rule · Make a purchase or booking — …"); a hand-off
//   rule hands the call to the person instead of running it. On a turn nobody
//   is watching (routine, Telegram) neither waits: the call is blocked with
//   what the person needs to do.
// - Routines go ahead (Settings → Bots & Approvals, off by default): on a run made only of
//   routine inputs, an approval (today's or a rule's Ask first) is granted
//   without a card. Hand-offs, the locked rules, Computer Use on the person's
//   Mac and every turn a person or Telegram joined are unchanged.
// - Remembered Bot entries follow plan coverage and skip only baseline, no-rule approvals.
// - Effect: each offered tool re-admits and revalidates immediately before it
//   runs, and its signal follows the admission, as `protectAdmittedBotTool`
//   does on the legacy path.
// - Replay: a tool's own declaration (`declarePiRuntimeReplay`) unless the
//   candidate overrides it; MCP tools and subagents are always `unsafe`.

import { createHash } from "node:crypto";
import type { BotPlans } from "../bot-plans/plans.js";
import { botPlanRuleFingerprint } from "../bot-plans/validate.js";
import type { BrowserApprovalTarget } from "../browser/approval.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  BOT_HANDOFF_ACTION_MAX_CHARS,
  BOT_HANDOFF_WHY_MAX_CHARS,
  isBotHandoffOpenUrl,
  normalizeBotHandoffAction,
  withoutBotHandoffControls,
} from "../../../renderer/shared/bot-handoffs.js";
import { botRuleLabel, BOT_LOCKED_RULES, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { classifyBotAction, type BotClassifiableAction } from "../bot-rules/classify.js";
import { botBaselineOf, decideBotRule } from "../bot-rules/decide.js";
import { describeMcpAction } from "../bot-rules/mcp-action.js";
import type { BotApprovalRuleTarget } from "../../../renderer/shared/tool-approval-scope.js";
import { botApprovalTargetOf } from "./bot-allow-target.js";
import { BOT_EXECUTION_ID_MEMO } from "./bot-extension.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { summarizeToolCall } from "../coding-tools.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { renderMcpServersSection } from "../mcp-server-instructions.js";
import { piRuntimeReplayPolicy } from "../pi-runtime-tool.js";
import type { SkillRegistrySnapshot } from "../skill-registry.js";
import type {
  BotApprovalRequirement,
  BotApprovalRequirements,
  BotPolicyDecision,
  BotToolCallCheck,
  BotToolEntry,
  BotTurnContext,
} from "./bot-extension.js";
import { ruleAskUnattendedBlock, ruleUnattendedBlock } from "./bot-handoff-text.js";
import { planActionGate, type GateAction, type GateAttendance, type GateContext, type GateDecision } from "../approval-gate/gate.js";
import { approvalJudgeAction } from "../approval-judge/judge.js";
import { toolCallApprovalEffect } from "../tool-approval.js";
import {
  approvalRuleHostOf,
  approvalTextRulesFor,
  describeApprovalRuleTarget,
  resolveApprovalRule,
  type ApprovalRule,
  type ApprovalRuleDecision,
  type ApprovalRuleSubject,
} from "../../../renderer/shared/approval-rules.js";
import { BOT_EXEMPT_TOOL_NAMES, bringsOutsideContent, DISCLOSURE_TOOL_NAMES } from "../approval-gate/tool-classes.js";

/** A Bot's built-in rules that only mark an action consequential: Auto judges them (plan §3.2 tool classes). */
const BOT_JUDGED_RULE_CLASSES: ReadonlySet<string> = new Set(["communicate", "delete", "publish", "install"]);
/**
 * A Bot's own tools whose results bring outside content, besides the shared
 * list and every connection: its computer's screen and shell output, its
 * browser, and an image it inspects.
 */
const BOT_TAINT_SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set(["computer", "computer_shell", "browser", "inspect_image"]);
function botBringsOutsideContent(toolName: string): boolean {
  return bringsOutsideContent(toolName) || BOT_TAINT_SOURCE_TOOL_NAMES.has(toolName);
}
import type { ApprovalMode } from "../../../renderer/shared/approval-mode.js";
import { botIngressAllowsTool, botToolApprovalSummary, botToolVerdict, botTurnOf, SUBAGENT_TOOL, type BotToolFacts } from "./bot-tool-policy.js";
import type { BotToolCall, ToolReplay } from "./tool-adapter.js";

/** One admission of the Bot's current authority. Release it when done. */
export interface BotAdmission {
  readonly authority: Readonly<BotRuntimeEffectiveAuthority>;
  readonly signal: AbortSignal;
  revalidateBeforeEffect(): Promise<void>;
  release(): void;
}

export interface BotToolCandidate {
  tool: AgentTool;
  /** Overrides the tool's own replay declaration. */
  replay?: ToolReplay;
  /** A connection (MCP) tool: never replay-safe. */
  mcp?: boolean;
  bind?: (call: BotToolCall) => AgentTool;
  /**
   * The call waits on the person (a question card). It holds no authority
   * admission while it waits, so it runs unfenced.
   */
  interactive?: true;
}

export interface BotCandidateSet {
  tools: BotToolCandidate[];
  /** The skills offered, filtered to the Bot's exact grants, for the base prompt. */
  skillSnapshot?: SkillRegistrySnapshot;
}

/**
 * An approval that depends on live state (Computer Use's target), and what
 * the call does for the rules classifier. `approval: null` means the call
 * needs no approval; `action` is absent when there is nothing to classify.
 */
export interface BotLiveApproval {
  approval: BotApprovalRequirement | null;
  action?: BotClassifiableAction;
  /**
   * Where the person can do the step themselves when a rule hands it to them
   * (the Bot browser's page): the card's Open. An https page only.
   */
  open?: { url: string };
  browserTarget?: Readonly<BrowserApprovalTarget>;
  /**
   * What a rule-made card says the call does when there is no baseline
   * approval to quote (the Bot computer's stated intent).
   */
  summary?: string;
}

export interface BotToolSources {
  facts(botId: string, admission: BotAdmission): Promise<BotToolFacts>;
  candidates(botId: string, admission: BotAdmission, facts: BotToolFacts, turn: BotTurnContext): Promise<BotCandidateSet>;
  /** The live approval for `toolName`, or `undefined` to defer to the policy. */
  approvalFor?(botId: string, toolName: string, call: BotToolCallCheck): Promise<BotLiveApproval | undefined>;
}

export interface BotAllowListPort {
  consentRevision(botId: string, target: BotApprovalRuleTarget): Promise<string>;
  match(botId: string, target: BotApprovalRuleTarget): Promise<{ id: string } | undefined>;
  offer(botId: string, target: BotApprovalRuleTarget): Promise<{ count: number } | undefined>;
  used(botId: string, ruleId: string): Promise<void>;
}

export interface BotToolAssemblyPorts {
  allowList?: BotAllowListPort;
  admit(botId: string): Promise<BotAdmission>;
  sources: BotToolSources;
  /** The Bot's effective rules, read fresh on every call. Absent: no rules apply. */
  rules?(botId: string): Promise<readonly BotRule[]>;
  /** The Bot's name, for the hand-off card's "why". */
  botName?(botId: string): Promise<string | undefined>;
  /** The legacy routines switch "Go ahead without asking", read fresh on every call. Absent: off. */
  routinesGoAhead?(): Promise<boolean>;
  /** The global approval mode, read fresh on every call. Absent: Ask. */
  approvalMode?(): Promise<ApprovalMode>;
  plans?: Pick<BotPlans, "cover" | "admit">;
  /**
   * Settings → Approvals' rules that answer for this Bot (the whole Mac's and
   * its own), read fresh on every call. Absent: the page has no say.
   */
  pageRules?(botId: string): Promise<readonly ApprovalRule[]>;
  /**
   * The Auto judge (plan §3.2) for one Bot call: the owner's request for this
   * run and the action, with secrets withheld. The host adds the Bot's job,
   * picks the model, caches verdicts per effect within the run and counts the
   * call's cost as "approval-judge" spending. Anything but a clear pass is
   * "defer", which shows the card. Absent: Auto shows the card, as Ask does.
   */
  judge?(botId: string, input: BotApprovalJudgeInput, signal?: AbortSignal): Promise<"pass" | "defer">;
}

export interface BotApprovalJudgeInput {
  /** The run the call belongs to: verdicts are cached for it alone. */
  run: string;
  /** The routine run's request id, when the run is a routine's, for its spending. */
  requestIds: readonly (string | undefined)[];
  /** Identifies the effect (tool and exact arguments). */
  effect: string;
  /** The action as the card shows it, arguments redacted (`approvalJudgeAction`). */
  action: string;
  /** What the owner asked for in this run. */
  request: string;
}

export interface BotToolAssembly {
  /** Fresh evidence only: no C reservation, D use, offer or execution binding. */
  approvalRequirements(botId: string, toolName: string, call: BotToolCallCheck): Promise<BotApprovalRequirements | undefined>;
  approvalEvidence(botId: string, toolName: string, call: BotToolCallCheck): Promise<BotApprovalRequirement | undefined>;
  currentTools(botId: string, turn: BotTurnContext): Promise<BotToolEntry[]>;
  checkPolicy(botId: string, toolName: string, call?: BotToolCallCheck): Promise<BotPolicyDecision>;
  /** The bounded `mcp_servers` section for the connection tools last offered to the Bot, or "". */
  guidance(botId: string, toolNames: readonly string[]): string;
  /** The skill snapshot last offered to the Bot. */
  skillSnapshot(botId: string): SkillRegistrySnapshot | undefined;
}

function replayOf(candidate: BotToolCandidate): ToolReplay {
  if (candidate.mcp || candidate.tool.name === SUBAGENT_TOOL) return "unsafe";
  if (candidate.replay !== undefined) return candidate.replay;
  return piRuntimeReplayPolicy(candidate.tool) === "safe" ? "safe" : "unsafe";
}

function accessChangedReason(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "This Bot's access changed.";
}

const RULES_UNREADABLE = "This Bot's rules couldn't be read, so this action didn't run. Tell the person.";
/** A routine has nobody to ask, so a step that needs the person's OK is skipped and reported. */
const ROUTINE_NEEDS_PERSON = "This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.";

function bounded(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

/** The hand-off card's title: the built-in rule's label, or the person's own words. */
function ruleActionText(rule: BotRule): string {
  return bounded(normalizeBotHandoffAction(botRuleLabel(rule)), BOT_HANDOFF_ACTION_MAX_CHARS);
}

/** Computer Use and Bot computer actions whose summary can carry what is typed. */
const TYPING_ACTIONS: Readonly<Record<"computer_use" | "computer", ReadonlySet<string>>> = {
  computer_use: new Set(["type", "set_value"]),
  // A Bot computer `key` that edits text (a character, or Backspace in a field) is typing; any other chord reads "press".
  computer: new Set(["type", "key"]),
};

/**
 * What a locked (password-or-code, money) rule's card and Done say the Bot was
 * about to do: never the text it was typing, the keys it was pressing, or its
 * own words for typing them (the browser already leaves typed text out of its
 * summary). Other actions keep their summary.
 */
function lockedRuleSummary(action: BotClassifiableAction, summary: string): string {
  if (action.surface !== "computer_use" && action.surface !== "computer") return summary;
  const where = action.app?.trim() ? ` in ${action.app.trim()}` : "";
  if (action.surface === "computer_use" && action.action === "key") return `press keys${where}`;
  if (!TYPING_ACTIONS[action.surface].has(action.action)) return summary;
  const element = action.element ?? (action.surface === "computer_use" ? action.focusedElement : undefined);
  const label = element?.label?.replace(/\s+/gu, " ").trim();
  return `type into ${label ? `the “${label}” field` : "the focused field"}${where}`;
}

/** The card's reason. The step's summary quotes the screen or page, so it loses control and direction marks too. */
function ruleWhyText(label: string, botName: string, summary: string): string {
  const why = `Your rule “${label}” hands this to you. ${botName} was about to: ${summary}`;
  return bounded(withoutBotHandoffControls(why), BOT_HANDOFF_WHY_MAX_CHARS);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Hash exact call data, preserving array order and ignoring object key insertion order. */
function operationIdentity(toolName: string, args: unknown, action: BotClassifiableAction | undefined, target?: Readonly<BrowserApprovalTarget>): string | undefined {
  try { return createHash("sha256").update(canonical({ toolName, args, action, target })).digest("hex"); } catch { return undefined; }
}

const PAGE_RULE_BLOCK = "A Block rule in Settings → Approvals stops this. Don't try it another way; tell the person if it matters.";

/** A natural-language page rule, as the Bot rules classifier reads one. */
function pageTextBotRule(rule: ApprovalRule): BotRule {
  return {
    id: `custom.${rule.id}`,
    text: rule.target.kind === "text" ? rule.target.text : "",
    behavior: rule.decision === "ask" && rule.handOff ? "hand_off" : "ask",
    locked: false,
  };
}

/** What the call is to the rules page: its tool or connected app, and the site it names. */
async function pageSubjectOf(botId: string, toolName: string, args: unknown, action: BotClassifiableAction | undefined,
  facts: BotToolFacts): Promise<ApprovalRuleSubject> {
  // A connection tool is named as it was granted, whether it reads or
  // changes something, so one name answers for both. (A server that renamed
  // the tool has already made it unavailable, so the two never differ here.)
  let connector: ApprovalRuleSubject["connector"];
  const grant = (await facts.mcpTools()).get(toolName);
  const connection = grant && facts.authority.connections.find((candidate) =>
    candidate.tools.some((tool) => tool === grant || tool.toolId === grant.toolId));
  if (grant && connection?.sourceId) connector = { serverId: connection.sourceId, tool: grant.name };
  else if (action?.surface === "mcp" && action.serverId) connector = { serverId: action.serverId, tool: action.remoteName };
  const host = action?.surface === "browser" && action.url ? approvalRuleHostOf({ url: action.url }) : approvalRuleHostOf(args);
  return { botId, ...(connector ? { connector } : { tool: toolName }), ...(host ? { host } : {}) };
}

export function createBotToolAssembly(ports: BotToolAssemblyPorts): BotToolAssembly {
  const offered = new Map<string, { connectionTools: readonly AgentTool[]; skillSnapshot?: SkillRegistrySnapshot }>();

  // Only immutable hashes live beyond beforeTool. No completed HookApi or callback is retained.
  const entryExecutions = new Map<string, { requirements: BotApprovalRequirements; owner?: BotToolCallCheck["owner"] }>();
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  const effectiveRules = (rules: readonly BotRule[]) => [...BOT_LOCKED_RULES, ...rules.filter(rule => !rule.locked)];
  const ruleIdentity = (rules: readonly BotRule[]) => canonical(effectiveRules(rules).map(rule => [rule.id, botPlanRuleFingerprint(rule)]).sort());
  const callData = (call: BotToolCallCheck) => ({ executionId: call.executionId, callId: call.callId, args: call.args,
    authorizationIds: call.authorizationIds ?? call.requestIds, requestIds: call.requestIds, owner: call.owner });
  function snapshot(call: BotToolCallCheck): BotToolCallCheck {
    return { ...call, args: structuredClone(call.args), requestIds: call.requestIds?.slice(),
      authorizationIds: call.authorizationIds?.slice(), owner: structuredClone(call.owner) };
  }
  function active(call: BotToolCallCheck, original: BotToolCallCheck) {
    call.signal?.throwIfAborted();
    if (canonical(callData(call)) !== canonical(callData(original))) throw new Error("This action's authorization changed.");
  }

  async function describePolicy(botId: string, toolName: string, call: BotToolCallCheck, facts: BotToolFacts) {
    const live = await ports.sources.approvalFor?.(botId, toolName, call);
    const summary = live === undefined ? await botToolApprovalSummary(toolName, call.args, facts) : undefined;
    const baseline = live === undefined ? (summary === undefined ? undefined : { summary }) : live.approval ?? undefined;
    const scopedWatch = botExecutionScope(botId)?.claim.connectorRestriction;
    const calendarRead = scopedWatch?.binding.adapter === "composio-calendar-v1" && calendarWatchCallAllowed(scopedWatch, call.args);
    const action = structuredClone(live !== undefined ? live.action : calendarRead ? undefined : await describeMcpAction(toolName, call.args, facts));
    const pageOf = async () => {
      if (!ports.pageRules) return undefined;
      let page: ApprovalRule[];
      try { page = structuredClone([...await ports.pageRules(botId)]); } catch { throw new Error(RULES_UNREADABLE); }
      const text = approvalTextRulesFor(page, botId);
      // Ask and "Do it myself" words join the Bot's own rules; Block words refuse.
      const asks = text.filter((rule) => rule.decision === "ask").map(pageTextBotRule);
      const blocks = text.filter((rule) => rule.decision === "block").map(pageTextBotRule);
      const blocked = action !== undefined && blocks.length > 0
        ? blocks.find((rule) => classifyBotAction(action, blocks).customRuleIds.has(rule.id)) : undefined;
      const resolved = resolveApprovalRule(page, await pageSubjectOf(botId, toolName, call.args, action, facts));
      const decision: ApprovalRuleDecision | undefined = blocked ? "block" : resolved?.decision;
      const label = blocked ? blocked.text ?? "" : resolved ? describeApprovalRuleTarget(resolved.rule.target) : "";
      return { asks, decision, label, key: decision ? canonical([blocked?.id ?? null, resolved?.rule.id ?? null, decision]) : undefined };
    };
    const readRules = async () => {
      // The Bot's own rules classify actions only; a call with none never reads them.
      const own = action !== undefined && ports.rules ? await ports.rules(botId) : [];
      const page = await pageOf();
      return { rules: [...own, ...(page?.asks ?? [])], page };
    };
    let rules: readonly BotRule[] = [];
    let page: Awaited<ReturnType<typeof pageOf>>;
    if (ports.pageRules || (action !== undefined && (ports.rules || ports.plans || ports.allowList))) {
      try { ({ rules, page } = structuredClone(await readRules())); } catch { throw new Error(RULES_UNREADABLE); }
    }
    // Unchanged from before the page while no page rule decides this call.
    const identityOf = (read: { rules: readonly BotRule[]; page: Awaited<ReturnType<typeof pageOf>> }) =>
      read.page?.key === undefined ? ruleIdentity(read.rules) : canonical([ruleIdentity(read.rules), read.page.key]);
    const identity = identityOf({ rules, page });
    const ruledByRules = action !== undefined && (ports.rules || ports.plans || ports.allowList || ports.pageRules);
    const decision = !ruledByRules ? { ruled: botBaselineOf(baseline), rule: undefined, allMatchingAsk: [] }
      : decideBotRule(botBaselineOf(baseline), rules, classifyBotAction(action, rules));
    return { live, baseline, action, rule: decision.rule, ruled: decision.ruled, matchingAsk: decision.allMatchingAsk,
      page: page?.decision ? { decision: page.decision, label: page.label } : undefined,
      rulesIdentity: identity,
      rulesCurrent: async () => {
        try { return identityOf(await readRules()) === identity; } catch { return false; }
      } };
  }

  function requirementFingerprint(botId: string, toolName: string, call: BotToolCallCheck,
    authority: Readonly<BotRuntimeEffectiveAuthority>, policy: Awaited<ReturnType<typeof describePolicy>>) {
    return hash({ version: 1, botId, toolName, call: callData(call), authority,
      operation: operationIdentity(toolName, call.args, policy.action, policy.live?.browserTarget),
      rules: policy.rulesIdentity, baseline: policy.baseline !== undefined });
  }

  async function ordinaryApproval(botId: string, toolName: string, call: BotToolCallCheck, original: BotToolCallCheck,
    admission: BotAdmission, facts: BotToolFacts, policy: Awaited<ReturnType<typeof describePolicy>>, approval: BotApprovalRequirement) {
    let requirements = approval.requirements;
    if (!requirements) {
      try { requirements = await requirementsFrom(botId, toolName, call, original, admission, facts, policy); } catch { /* Once-only evidence. */ }
    }
    await call.assertCurrent?.();
    await admission.revalidateBeforeEffect();
    if (!(await policy.rulesCurrent())) throw new Error("This Bot's approval requirements changed. Ask again.");
    active(call, original);
    const requirementsFingerprint = requirements?.requirementsFingerprint ?? requirementFingerprint(botId, toolName, call, admission.authority, policy);
    const described = botApprovalTargetOf(toolName, policy.action);
    const evidence = { requirementsFingerprint, authorizationFingerprint: requirements?.authorizationFingerprint ??
      hash(["bot-ordinary-approval-v1", requirementsFingerprint, described && ports.allowList && !policy.rule ? "consent-unavailable" : null]) };
    const expected = requirements;
    return { ...approval, ...(expected ? { requirements: expected } : {}), evidence,
      ...(expected?.matchedRuleId && policy.baseline ? { allowFromList: async (grant: import("./bot-extension.js").BotAllowListRelease) => {
        if (grant.ruleId !== expected.matchedRuleId || grant.consentRevision !== expected.consentRevision ||
            canonical(grant.target) !== canonical(expected.target)) throw new Error("This remembered approval changed.");
        await allowEntry(botId, toolName, call, expected, policy.baseline!);
      } } : {}),
      revalidate: () => assembly.approvalEvidence(botId, toolName, call) };
  }

  async function requirementsFrom(botId: string, toolName: string, call: BotToolCallCheck, original: BotToolCallCheck,
    admission: BotAdmission, facts: BotToolFacts, policy: Awaited<ReturnType<typeof describePolicy>>): Promise<BotApprovalRequirements | undefined> {
    const list = ports.allowList;
    if (!ports.rules || !list || typeof list.consentRevision !== "function" || !call.executionId || !call.requestIds?.length ||
        (!call.authorizationIds?.length && call.requestIds.some(id => !id)) || !policy.baseline || policy.baseline.rule || policy.rule ||
        policy.ruled !== "ask" || toolName === COMPUTER_USE_TOOL_NAME) return undefined;
    const described = botApprovalTargetOf(toolName, policy.action);
    if (!described || (described.target.kind === "site" && !policy.live?.browserTarget)) return undefined;
    const authority = structuredClone(admission.authority);
    if (canonical(facts.authority) !== canonical(authority)) return undefined;
    const binding = (value: typeof policy) => requirementFingerprint(botId, toolName, call, authority, value);
    const requirementsFingerprint = binding(policy);
    const consentRevision = await list.consentRevision(botId, described.target);
    if (!consentRevision) return undefined;
    const match = await list.match(botId, described.target);
    if (await list.consentRevision(botId, described.target) !== consentRevision) return undefined;
    await call.assertCurrent?.();
    await admission.revalidateBeforeEffect();
    const freshFacts = await ports.sources.facts(botId, admission);
    const turns = (call.requestIds ?? []).map(botTurnOf);
    if (!(await botToolVerdict(toolName, freshFacts, { botMessage: turns.some(t => t.botMessage), telegram: turns.some(t => t.telegram), routine: turns.some(t => t.routine), peer: turns.some(t => t.peer) }, call.args)).allowed) return undefined;
    if (await list.consentRevision(botId, described.target) !== consentRevision) return undefined;
    const fresh = await describePolicy(botId, toolName, call, freshFacts);
    if (await list.consentRevision(botId, described.target) !== consentRevision || !(await fresh.rulesCurrent())) return undefined;
    await call.assertCurrent?.();
    active(call, original);
    if (admission.signal.aborted || canonical(admission.authority) !== canonical(authority) || canonical(freshFacts.authority) !== canonical(authority) ||
        !botIngressAllowsTool(toolName, call.requestIds ?? []) || fresh.rule || !fresh.baseline || binding(fresh) !== requirementsFingerprint) return undefined;
    return Object.freeze({ target: Object.freeze(described.target), requirementsFingerprint, consentRevision,
      authorizationFingerprint: hash(["bot-approval-authorization-v1", requirementsFingerprint, consentRevision]),
      ...(match ? { matchedRuleId: match.id } : {}) });
  }

  async function approvalRequirements(botId: string, toolName: string, original: BotToolCallCheck): Promise<BotApprovalRequirements | undefined> {
    let admission: BotAdmission | undefined;
    try {
      const call = snapshot(original);
      active(call, original);
      if (!call.requestIds?.length || !botIngressAllowsTool(toolName, call.requestIds)) return undefined;
      admission = await ports.admit(botId);
      await admission.revalidateBeforeEffect();
      const facts = await ports.sources.facts(botId, admission);
      const turns = call.requestIds.map(botTurnOf);
      const verdict = await botToolVerdict(toolName, facts, { botMessage: turns.some(t => t.botMessage),
        telegram: turns.some(t => t.telegram), routine: turns.some(t => t.routine), peer: turns.some(t => t.peer) }, call.args);
      if (!verdict.allowed) return undefined;
      const policy = await describePolicy(botId, toolName, call, facts);
      return await requirementsFrom(botId, toolName, call, original, admission, facts, policy);
    } catch { return undefined; }
    finally { admission?.release(); }
  }

  async function assertEntryCurrent(botId: string, toolName: string, call: BotToolCallCheck, expected: BotApprovalRequirements) {
    const current = await approvalRequirements(botId, toolName, call);
    if (!current || current.authorizationFingerprint !== expected.authorizationFingerprint || current.matchedRuleId !== expected.matchedRuleId)
      throw new Error("This Bot's remembered approval changed. Ask again.");
  }

  async function allowEntry(botId: string, toolName: string, call: BotToolCallCheck, expected: BotApprovalRequirements, baseline: BotApprovalRequirement) {
    await assertEntryCurrent(botId, toolName, call, expected);
    await baseline.onAllow?.();
    await assertEntryCurrent(botId, toolName, call, expected);
    await ports.allowList!.used(botId, expected.matchedRuleId!);
    await assertEntryCurrent(botId, toolName, call, expected);
    const executionId = call.executionId!;
    entryExecutions.set(executionId, { requirements: expected, owner: structuredClone(call.owner) });
    call.signal?.addEventListener("abort", () => entryExecutions.delete(executionId), { once: true });
  }

  /**
   * Run `tool` behind a fresh admission, revalidated immediately before the
   * effect. A connection tool must also still be the exact granted tool in
   * its server's live inventory: the policy check (and any approval it asked
   * for) used that grant's effect, so a tool that changed since, such as one
   * that turned from read-only to mutating, never runs under the old answer.
   */
  function fenced(botId: string, tool: AgentTool, mcp: boolean, call?: BotToolCall): AgentTool {
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        // A rejected plan permit gets one ordinary authorization attempt. Release
        // the admission before that card waits, then acquire fresh authority again.
        const executionId = ports.allowList && call?.readMemo ? await call.readMemo<string>(BOT_EXECUTION_ID_MEMO) : undefined;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const admission = await ports.admit(botId);
            try {
              await admission.revalidateBeforeEffect();
              if (mcp) {
                const facts = await ports.sources.facts(botId, admission);
                if (!(await facts.mcpTools()).has(tool.name)) {
                  throw new Error("This connection tool changed since it was offered. Try again.");
                }
              }
              if (admission.signal.aborted) throw admission.signal.reason;
              const effectSignal = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
              await call?.assertRunActive?.();
              const invoke = () => {
                // Plan admission can await disk and revalidation. No await may
                // separate this last cancellation check from actual invocation.
                effectSignal.throwIfAborted();
                const execution = botExecutionScope(botId);
                if (mcp && execution?.claim.connectorRestriction?.binding.adapter === "composio-calendar-v1") {
                  return withBotConnectorModelEffect(() => execution.runtime.revalidate(), async () => {
                    effectSignal.throwIfAborted();
                    const result = await tool.execute(toolCallId, params, effectSignal, onUpdate);
                    effectSignal.throwIfAborted();
                    return result;
                  });
                }
                return tool.execute(toolCallId, params, effectSignal, onUpdate);
              };
              const authorization = executionId ? entryExecutions.get(executionId) : undefined;
              const start = authorization && call ? async () => {
                const requestIds = await call.runRequestIds?.(), authorizationIds = await call.runInputIds?.();
                await assertEntryCurrent(botId, tool.name, {
                  executionId, callId: call.callId, args: params, signal: effectSignal,
                  requestIds, authorizationIds, owner: authorization.owner,
                  assertCurrent: async () => {
                    await call.assertRunActive?.();
                    if (canonical(await call.runRequestIds?.()) !== canonical(requestIds) ||
                        canonical(await call.runInputIds?.()) !== canonical(authorizationIds))
                      throw new Error("This tool's owning inputs changed.");
                  },
                }, authorization.requirements);
                return invoke();
              } : invoke;
              if (!call?.admitEffect) return await start();
              const result = await call.admitEffect(start);
              if (result.admitted) return await result.started;
            } finally {
              admission.release();
            }
            if (attempt !== 0 || !call?.reauthorize) throw new Error("This plan no longer permits the action.");
            await call.reauthorize();
          }
          throw new Error("This plan no longer permits the action.");
        } finally { if (executionId) entryExecutions.delete(executionId); }
      },
    };
  }

  // Runs that already read outside content: their calls are never judged.
  const taintedRuns = new Set<string>();
  const TAINTED_RUNS_KEPT = 500;
  /**
   * A run is the inputs it serves: every step answering them shares its
   * verdicts and its taint. A call that names none is a run of its own.
   */
  function botJudgeRun(botId: string, call: Pick<BotToolCallCheck, "owner" | "requestIds" | "callId">): string {
    const inputs = call.owner?.inputs.map((input) => input.submissionId) ?? [];
    if (inputs.length > 0) return canonical([botId, "inputs", inputs]);
    const requests = [...(call.requestIds ?? [])].filter((id): id is string => typeof id === "string" && id.length > 0);
    if (requests.length > 0) return canonical([botId, "requests", requests]);
    if (call.owner?.runId) return canonical([botId, "task", call.owner.runId]);
    return canonical([botId, "call", call.callId]);
  }
  /** Calls whose result brings outside content: a page, a search, a connection's data. */
  const bringsOutside = new WeakMap<BotToolCallCheck, boolean>();
  function noteOutsideContent(botId: string, call: BotToolCallCheck): void {
    if (bringsOutside.get(call) !== true) return;
    const run = botJudgeRun(botId, call);
    taintedRuns.delete(run);
    taintedRuns.add(run);
    while (taintedRuns.size > TAINTED_RUNS_KEPT) taintedRuns.delete(taintedRuns.values().next().value!);
  }

  /**
   * Whether the run's committed tool results already brought outside content,
   * which survives a restart. A run that can't be read, or a host that can't
   * say, counts as having read it.
   */
  async function runReadOutside(call: BotToolCallCheck, facts: BotToolFacts): Promise<boolean> {
    if (!call.runToolNames) return true;
    try {
      const names = await call.runToolNames();
      if (names.length === 0) return false;
      const mcp = await facts.mcpTools();
      return names.some((name) => botBringsOutsideContent(name) || mcp.has(name));
    } catch {
      return true;
    }
  }

  async function decidePolicy(botId: string, toolName: string, original?: BotToolCallCheck): Promise<BotPolicyDecision> {
    if (original?.executionId && !original.approvalProbe) entryExecutions.delete(original.executionId);
    let call: BotToolCallCheck | undefined;
    try { call = original === undefined ? undefined : snapshot(original); } catch { return { allowed: false, reason: "This action's authorization could not be read." }; }
    let admission: BotAdmission;
    try {
      admission = await ports.admit(botId);
    } catch (error) {
      return { allowed: false, reason: accessChangedReason(error) };
    }
    try {
      await admission.revalidateBeforeEffect();
      const facts = await ports.sources.facts(botId, admission);
      if (original) bringsOutside.set(original, botBringsOutsideContent(toolName) || (await facts.mcpTools()).has(toolName));
      // The calling run's own ingress, not whoever refreshed the tools last.
      if (call?.requestIds && !botIngressAllowsTool(toolName, call.requestIds)) return {allowed: false, reason: "This tool is not available on this turn."};
      const turns = (call?.requestIds ?? []).map(botTurnOf);
      const taskIngress = botTurnOf(undefined);
      if (taskIngress.peer) turns.push(taskIngress);
      const verdict = await botToolVerdict(toolName, facts, {
        botMessage: turns.some((turn) => turn.botMessage),
        telegram: turns.some((turn) => turn.telegram),
        routine: turns.some((turn) => turn.routine),
        peer: turns.some((turn) => turn.peer),
      }, call?.args);
      if (!verdict.allowed) return verdict;
      if (call === undefined) return { allowed: true };
      const policy = await describePolicy(botId, toolName, call, facts);
      const { live, baseline, action, rule, matchingAsk, ruled, rulesCurrent, page } = policy;
      const label = rule ? botRuleLabel(rule) : "";
      const ruleRef = rule ? { id: rule.id, label } : undefined;
      const ownSummary = baseline?.summary ?? live?.summary ?? summarizeToolCall(toolName, call.args);
      const callSummary = rule?.locked && action ? lockedRuleSummary(action, ownSummary) : ownSummary;
      if (ruled === "hand_off" && (!rule || !ruleRef)) return { allowed: false, reason: RULES_UNREADABLE };
      // Build the approval only once, after rules have decided whether it may run.
      // A page Ask rule on a call that needed no card makes one.
      const pageAsk = page?.decision === "ask" && baseline === undefined ? { summary: `Rule · ${page.label} — ${callSummary}` } : undefined;
      const approval: BotApprovalRequirement | undefined = ruled === "hand_off" ? undefined : rule === undefined ? baseline ?? pageAsk : {
        ...baseline, summary: `Rule · ${label} — ${callSummary}`, rule: ruleRef,
      };
      const routineOnly = turns.length > 0 && turns.every(turn => turn.routine && !turn.telegram && !turn.peer);
      const attendance: GateAttendance = turns.some(turn => turn.peer) ? "peer"
        : routineOnly ? "routine"
          : turns.some(turn => turn.routine || turn.telegram) ? "unattended"
            : turns.some(turn => turn.botMessage) ? "bot-message" : "person";
      const computerUse = toolName === COMPUTER_USE_TOOL_NAME;
      const routineGoAhead = approval !== undefined && routineOnly && !computerUse &&
        (await ports.routinesGoAhead?.().catch(() => false)) === true && (await call.hasRoutineInputs?.()) === true;
      // Every Bot follows the global mode. In Auto the judge may pass a
      // consequential call (plan §3.2 step 8); a run that already read
      // outside content, or a host without a judge, shows the card.
      const mode = (await ports.approvalMode?.().catch(() => "ask" as const)) ?? "ask";
      const run = botJudgeRun(botId, call);
      // Only a run the person (or a routine they accepted) started is judged:
      // a Bot message, Telegram, a peer or a self-intro carries words nobody
      // here wrote. A run that already read outside content, in this process
      // or before a restart, is never judged either.
      const ownerStarted = turns.length > 0 && turns.every((turn) => !turn.botMessage && !turn.telegram && !turn.peer && !turn.intro);
      const judging = mode === "auto" && ports.judge !== undefined && ownerStarted &&
        !taintedRuns.has(run) && !(await runReadOutside(call, facts));
      const gateContext: GateContext = { surface: "bot", access: "ask", mode, attendance,
        ...(routineGoAhead ? { routineGoAhead } : {}), ...(judging ? { judge: true } : {}) };
      // A built-in rule that only asks (send a message, delete, publish,
      // install) marks a consequential action: Auto judges it like any
      // other. Purchases, locked rules, hand-offs and rules the person
      // wrote (here or on the rules page) always ask.
      // Only when the judge will really be asked: with no judge the rule's
      // own card stands. A Bot's exempt tools (its computer, shell,
      // subagents) keep their rule, since exempt calls never reach the judge.
      const judgedRule = judging && ruled === "ask" && rule !== undefined && matchingAsk.length > 0 &&
        !BOT_EXEMPT_TOOL_NAMES.has(toolName) &&
        matchingAsk.every((candidate) => candidate.actionClass !== undefined && !candidate.locked && BOT_JUDGED_RULE_CLASSES.has(candidate.actionClass));
      const remembered = baseline && !rule && !computerUse ? botApprovalTargetOf(toolName, action) : undefined;
      const gateAction: GateAction = {
        toolName,
        ...(computerUse ? { mac: true } : {}),
        // The shell runs on the person's Mac: its first use asks in every mode.
        ...(toolName === "run_command" ? { mac: true, macClass: "shell" as const } : {}),
        ...(BOT_EXEMPT_TOOL_NAMES.has(toolName) ? { exempt: true } : {}),
        // Sharing the person's data asks once in every mode, Never ask
        // included, and no Always-allow rule skips it.
        ...(DISCLOSURE_TOOL_NAMES.has(toolName) ? { explicitOnly: true } : {}),
        ...(baseline !== undefined || judgedRule ? { consequential: true } : {}),
        ...(ruled === "hand_off" ? { rule: { behavior: "hand_off" as const, locked: rule?.locked === true } }
          : rule !== undefined && !judgedRule ? { rule: { behavior: "ask" as const, locked: rule.locked === true } } : {}),
        ...(ports.plans && !call.skipPlanCoverage && call.executionId ? { planAvailable: true } : {}),
        ...(ports.allowList && !call.skipAllowList && remembered ? { allowListAvailable: true } : {}),
        ...(page ? { pageRule: page.decision } : {}),
      };
      /** Asks the judge when the gate says to, and plans again with its verdict. */
      const judged = async (planned: GateDecision, action: GateAction): Promise<GateDecision> => {
        if (planned.outcome !== "lookup" || planned.lookup !== "judge" || !ports.judge) return planned;
        let verdict: "pass" | "defer" = "defer";
        try {
          const effect = toolCallApprovalEffect(toolName, call.args, live?.browserTarget) ?? `${toolName}\u0000${call.callId}`;
          // Only words the owner wrote: a run whose inputs carry anything
          // else (an event's payload, routine notes, another Bot's message)
          // is never judged.
          const request = await call.ownerRequest?.().catch(() => undefined);
          if (request === undefined) throw new Error("The run's inputs are not only the owner's words.");
          verdict = await ports.judge(botId, {
            run, requestIds: call.requestIds ?? [], effect, request,
            action: approvalJudgeAction(toolName, call.args, callSummary),
          }, call.signal);
        } catch { /* Fails closed: the card. */ }
        return planActionGate(gateContext, { ...action, judge: verdict === "pass" ? "pass" : "defer" });
      };
      let decision = await judged(planActionGate(gateContext, gateAction), gateAction);
      let permit: Awaited<ReturnType<NonNullable<BotToolAssemblyPorts["plans"]>["cover"]>> | undefined;
      if (decision.outcome === "lookup" && decision.lookup === "plan" && ports.plans && call.executionId) {
        const operationFingerprint = operationIdentity(toolName, call.args, action, live?.browserTarget);
        permit = operationFingerprint === undefined ? undefined : await ports.plans.cover(botId, {
          executionId: call.executionId, operationFingerprint, toolName,
          requestIds: call.authorizationIds ?? call.requestIds ?? [], action, baseline: baseline !== undefined,
          rules: matchingAsk.map(rule => ({ id: rule.id, fingerprint: botPlanRuleFingerprint(rule) })),
        }).catch(() => undefined);
        const planned = { ...gateAction, plan: permit ? "covered" as const : "not-covered" as const };
        decision = await judged(planActionGate(gateContext, planned), planned);
      }
      if (decision.outcome === "lookup" && decision.lookup === "allow-list" && ports.allowList && remembered && baseline && approval) {
        let requirements: BotApprovalRequirements | undefined;
        try { requirements = await requirementsFrom(botId, toolName, call, original!, admission, facts, policy); } catch { /* Ask normally. */ }
        if (requirements?.matchedRuleId) {
          const expected = requirements;
          return { allowed: true, approval: { ...approval, requirements: expected, preapproved: true,
            onAllow: () => allowEntry(botId, toolName, call, expected, baseline) } };
        }
        if (!requirements) return decidePolicy(botId, toolName, { ...call, skipPlanCoverage: true, skipAllowList: true });
        // Not on the allow list: in Auto the judge may still pass it.
        const unlisted = { ...gateAction, allowList: "no-match" as const };
        const afterList = await judged(planActionGate(gateContext, unlisted), unlisted);
        if (afterList.outcome === "allow" && afterList.via === "judge") {
          return { allowed: true, approval: { ...approval, preapproved: true } };
        }
        let offer: { count: number } | undefined;
        try { offer = await ports.allowList.offer(botId, remembered.target); } catch { /* No offer. */ }
        // Offering can await disk; stale evidence must never attach to a new card.
        const fresh = await approvalRequirements(botId, toolName, call);
        if (!fresh || fresh.authorizationFingerprint !== requirements.authorizationFingerprint)
          return decidePolicy(botId, toolName, { ...call, skipPlanCoverage: true, skipAllowList: true });
        return { allowed: true, approval: await ordinaryApproval(botId, toolName, call, original!, admission, facts, policy,
          { ...approval, remember: { ...remembered, ...(offer ? { offer } : {}) }, requirements }) };
      }
      switch (decision.outcome) {
        case "block":
          return { allowed: false, reason: decision.reason === "rule" ? PAGE_RULE_BLOCK
            : decision.reason === "needs-person" ? ruleUnattendedBlock(label)
            : decision.reason === "unattended-rule" ? ruleAskUnattendedBlock(label)
              : decision.reason === "peer" ? "Peer work cannot obtain fresh person approval for this action."
                : decision.reason === "unattended" ? ROUTINE_NEEDS_PERSON
                  : RULES_UNREADABLE };
        case "hand-off": {
          if (!rule || !ruleRef) return { allowed: false, reason: RULES_UNREADABLE };
          const botName = (await ports.botName?.(botId).catch(() => undefined)) ?? "Your Bot";
          const open = live?.open !== undefined && isBotHandoffOpenUrl(live.open.url) ? { url: live.open.url } : undefined;
          return {
            allowed: true,
            handoff: {
              rule: ruleRef,
              summary: callSummary,
              action: ruleActionText(rule),
              why: ruleWhyText(label, botName, callSummary),
              ...(live?.browserTarget && { browserTarget: live.browserTarget }),
              ...(open === undefined ? {} : { open }),
            },
          };
        }
        case "allow":
          if (!approval) return { allowed: true };
          if (decision.via === "routine-go-ahead" || decision.via === "never-ask" || decision.via === "exempt" || decision.via === "rule" ||
            decision.via === "judge") {
            return { allowed: true, approval: { ...approval, preapproved: true } };
          }
          if (decision.via === "plan" && permit) {
            return { allowed: true, approval: { ...approval, preapproved: true, planPermit: permit,
              planOperation: args => operationIdentity(toolName, args, action, live?.browserTarget), planRulesCurrent: rulesCurrent } };
          }
          break;
        case "ask": {
          if (!approval) break;
          const described = call.skipAllowList && baseline && !rule ? botApprovalTargetOf(toolName, action) : undefined;
          return { allowed: true, approval: await ordinaryApproval(botId, toolName, call, original!, admission, facts, policy,
            described ? { ...approval, remember: described } : approval) };
        }
        default:
          break;
      }
      // The gate asked for a fact this call cannot supply, or allowed a
      // call that needs a card: never run it unasked.
      return { allowed: false, reason: RULES_UNREADABLE };
    } catch (error) {
      return { allowed: false, reason: accessChangedReason(error) };
    } finally {
      admission.release();
    }
  }

  const assembly: BotToolAssembly = {
    async approvalEvidence(botId, toolName, call) {
      const decision = await assembly.checkPolicy(botId, toolName, { ...call, skipPlanCoverage: true, skipAllowList: true, approvalProbe: true });
      return decision.allowed && decision.approval && !decision.approval.preapproved ? decision.approval : undefined;
    },
    async currentTools(botId, turn) {
      const admission = await ports.admit(botId);
      try {
        const facts = await ports.sources.facts(botId, admission);
        const set = await ports.sources.candidates(botId, admission, facts, turn);
        const { telegram, routine, botMessage, peer } = botTurnOf(turn.requestId);
        const entries: BotToolEntry[] = [];
        for (const candidate of set.tools) {
          if (!botIngressAllowsTool(candidate.tool.name, [turn.requestId])) continue;
          if (!(await botToolVerdict(candidate.tool.name, facts, { telegram, routine, botMessage, peer })).allowed) continue;
          const bind = candidate.bind;
          const guard = (tool: AgentTool, call?: BotToolCall) => (candidate.interactive ? tool : fenced(botId, tool, candidate.mcp === true, call));
          entries.push({
            tool: guard(candidate.tool),
            replay: replayOf(candidate),
            ...(ports.plans ? { admitPlan: ports.plans.admit } : {}),
            ...(candidate.mcp ? { mcp: true } : {}),
            bind: (call: BotToolCall) => guard(bind ? bind(call) : candidate.tool, call),
          });
        }
        offered.set(botId, {
          connectionTools: entries.flatMap((entry) => (entry.mcp ? [entry.tool] : [])),
          ...(set.skillSnapshot === undefined ? {} : { skillSnapshot: set.skillSnapshot }),
        });
        return entries;
      } finally {
        admission.release();
      }
    },

    approvalRequirements,

    checkPolicy: async function checkPolicy(botId, toolName, original): Promise<BotPolicyDecision> {
      const decision = await decidePolicy(botId, toolName, original);
      // A call that may run and brings outside content (a page, a connection's
      // data) ends this run's judging: later calls show their cards.
      if (decision.allowed && original !== undefined && !original.approvalProbe) noteOutsideContent(botId, original);
      return decision;
    },

    guidance(botId, toolNames) {
      // Bot connection tools are declared directly; only those still offered appear.
      const names = new Set(toolNames);
      const tools = (offered.get(botId)?.connectionTools ?? []).filter((tool) => names.has(tool.name));
      return renderMcpServersSection(tools, { declared: names });
    },

    skillSnapshot(botId) {
      return offered.get(botId)?.skillSnapshot;
    },
  };
  return assembly;
}
