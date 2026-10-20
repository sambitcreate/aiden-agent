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
// - Effect: each offered tool re-admits and revalidates immediately before it
//   runs, and its signal follows the admission, as `protectAdmittedBotTool`
//   does on the legacy path.
// - Replay: a tool's own declaration (`declarePiRuntimeReplay`) unless the
//   candidate overrides it; MCP tools and subagents are always `unsafe`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  BOT_HANDOFF_ACTION_MAX_CHARS,
  BOT_HANDOFF_WHY_MAX_CHARS,
  normalizeBotHandoffAction,
} from "../../../renderer/shared/bot-handoffs.js";
import { botRuleLabel, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { classifyBotAction, type BotClassifiableAction } from "../bot-rules/classify.js";
import { botBaselineOf, decideBotRule } from "../bot-rules/decide.js";
import { describeMcpAction } from "../bot-rules/mcp-action.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { summarizeToolCall } from "../coding-tools.js";
import { renderMcpServersSection } from "../mcp-server-instructions.js";
import { piRuntimeReplayPolicy } from "../pi-runtime-tool.js";
import type { SkillRegistrySnapshot } from "../skill-registry.js";
import type {
  BotApprovalRequirement,
  BotPolicyDecision,
  BotToolCallCheck,
  BotToolEntry,
  BotTurnContext,
} from "./bot-extension.js";
import { ruleAskUnattendedBlock, ruleUnattendedBlock } from "./bot-handoff-text.js";
import { botToolApprovalSummary, botToolVerdict, botTurnOf, SUBAGENT_TOOL, type BotToolFacts } from "./bot-tool-policy.js";
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
}

export interface BotToolSources {
  facts(botId: string, admission: BotAdmission): Promise<BotToolFacts>;
  candidates(botId: string, admission: BotAdmission, facts: BotToolFacts, turn: BotTurnContext): Promise<BotCandidateSet>;
  /** The live approval for `toolName`, or `undefined` to defer to the policy. */
  approvalFor?(botId: string, toolName: string, call: BotToolCallCheck): Promise<BotLiveApproval | undefined>;
}

export interface BotToolAssemblyPorts {
  admit(botId: string): Promise<BotAdmission>;
  sources: BotToolSources;
  /** The Bot's effective rules, read fresh on every call. Absent: no rules apply. */
  rules?(botId: string): Promise<readonly BotRule[]>;
  /** The Bot's name, for the hand-off card's "why". */
  botName?(botId: string): Promise<string | undefined>;
}

export interface BotToolAssembly {
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

function bounded(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

/** The hand-off card's title: the built-in rule's label, or the person's own words. */
function ruleActionText(rule: BotRule): string {
  return bounded(normalizeBotHandoffAction(botRuleLabel(rule)), BOT_HANDOFF_ACTION_MAX_CHARS);
}

function ruleWhyText(label: string, botName: string, summary: string): string {
  return bounded(`Your rule “${label}” hands this to you. ${botName} was about to: ${summary}`, BOT_HANDOFF_WHY_MAX_CHARS);
}

export function createBotToolAssembly(ports: BotToolAssemblyPorts): BotToolAssembly {
  const offered = new Map<string, { connectionTools: readonly AgentTool[]; skillSnapshot?: SkillRegistrySnapshot }>();

  /**
   * Run `tool` behind a fresh admission, revalidated immediately before the
   * effect. A connection tool must also still be the exact granted tool in
   * its server's live inventory: the policy check (and any approval it asked
   * for) used that grant's effect, so a tool that changed since, such as one
   * that turned from read-only to mutating, never runs under the old answer.
   */
  function fenced(botId: string, tool: AgentTool, mcp: boolean): AgentTool {
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
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
          return await tool.execute(toolCallId, params, effectSignal, onUpdate);
        } finally {
          admission.release();
        }
      },
    };
  }

  return {
    async currentTools(botId, turn) {
      const admission = await ports.admit(botId);
      try {
        const facts = await ports.sources.facts(botId, admission);
        const set = await ports.sources.candidates(botId, admission, facts, turn);
        const { telegram, routine } = botTurnOf(turn.requestId);
        const entries: BotToolEntry[] = [];
        for (const candidate of set.tools) {
          if (!(await botToolVerdict(candidate.tool.name, facts, { telegram, routine })).allowed) continue;
          const bind = candidate.bind;
          const guard = (tool: AgentTool) => (candidate.interactive ? tool : fenced(botId, tool, candidate.mcp === true));
          entries.push({
            tool: guard(candidate.tool),
            replay: replayOf(candidate),
            ...(candidate.mcp ? { mcp: true } : {}),
            ...(bind === undefined ? {} : { bind: (call: BotToolCall) => guard(bind(call)) }),
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

    async checkPolicy(botId, toolName, call) {
      let admission: BotAdmission;
      try {
        admission = await ports.admit(botId);
      } catch (error) {
        return { allowed: false, reason: accessChangedReason(error) };
      }
      try {
        await admission.revalidateBeforeEffect();
        const facts = await ports.sources.facts(botId, admission);
        // The calling run's own ingress, not whoever refreshed the tools last.
        const turns = (call?.requestIds ?? []).map(botTurnOf);
        const verdict = await botToolVerdict(toolName, facts, {
          telegram: turns.some((turn) => turn.telegram),
          routine: turns.some((turn) => turn.routine),
        });
        if (!verdict.allowed) return verdict;
        if (call === undefined) return { allowed: true };
        // The baseline: today's approval decision, untouched by any rule.
        const live = await ports.sources.approvalFor?.(botId, toolName, call);
        let baseline: BotApprovalRequirement | undefined;
        if (live !== undefined) {
          baseline = live.approval ?? undefined;
        } else {
          const summary = await botToolApprovalSummary(toolName, call.args, facts);
          baseline = summary === undefined ? undefined : { summary };
        }
        const asBaseline: BotPolicyDecision = baseline === undefined ? { allowed: true } : { allowed: true, approval: baseline };
        const action = live !== undefined ? live.action : await describeMcpAction(toolName, call.args, facts);
        if (action === undefined || ports.rules === undefined) return asBaseline;
        let rules: readonly BotRule[];
        try {
          rules = await ports.rules(botId);
        } catch {
          // Fail closed: a call the rules can't be checked for doesn't run.
          return { allowed: false, reason: RULES_UNREADABLE };
        }
        const { ruled, rule } = decideBotRule(botBaselineOf(baseline), rules, classifyBotAction(action, rules));
        if (ruled === "allowed" || rule === undefined) return asBaseline;
        const label = botRuleLabel(rule);
        const ruleRef = { id: rule.id, label };
        const unattended = turns.some((turn) => turn.routine || turn.telegram);
        const callSummary = baseline?.summary ?? summarizeToolCall(toolName, call.args);
        if (ruled === "ask") {
          // Never with remembered scopes: a rule-made ask is answered each time.
          if (baseline !== undefined) {
            return { allowed: true, approval: { ...baseline, summary: `Rule · ${label} — ${baseline.summary}`, rule: ruleRef } };
          }
          if (unattended) return { allowed: false, reason: ruleAskUnattendedBlock(label) };
          return { allowed: true, approval: { summary: `Rule · ${label} — ${callSummary}`, rule: ruleRef } };
        }
        if (unattended) return { allowed: false, reason: ruleUnattendedBlock(label) };
        const botName = (await ports.botName?.(botId).catch(() => undefined)) ?? "Your Bot";
        return {
          allowed: true,
          handoff: {
            rule: ruleRef,
            summary: callSummary,
            action: ruleActionText(rule),
            why: ruleWhyText(label, botName, callSummary),
          },
        };
      } catch (error) {
        return { allowed: false, reason: accessChangedReason(error) };
      } finally {
        admission.release();
      }
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
}
