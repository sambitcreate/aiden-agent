// Turns a Bot's current authority into the `aiden-bot` extension's tool,
// policy and guidance dependencies.
//
// - Offer: every candidate tool (built by the legacy factories in
//   `bot-tool-sources-main.ts`) passes `botToolVerdict` against a fresh
//   admission, or it is not offered.
// - Call: `checkPolicy` admits again, re-runs the same verdict (including the
//   exact MCP/skill joins, so a changed fingerprint is refused) and decides
//   whether the person must approve.
// - Effect: each offered tool re-admits and revalidates immediately before it
//   runs, and its signal follows the admission, as `protectAdmittedBotTool`
//   does on the legacy path.
// - Replay: a tool's own declaration (`declarePiRuntimeReplay`) unless the
//   candidate overrides it; MCP tools and subagents are always `unsafe`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { withMcpServerInstructions, type McpServerInstructionSnapshot } from "../mcp-server-instructions.js";
import { piRuntimeReplayPolicy } from "../pi-runtime-tool.js";
import type { SkillRegistrySnapshot } from "../skill-registry.js";
import type {
  BotApprovalRequirement,
  BotPolicyDecision,
  BotToolCallCheck,
  BotToolEntry,
  BotTurnContext,
} from "./bot-extension.js";
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
  /** Server instructions captured while discovering connection tools. */
  guidance?: readonly McpServerInstructionSnapshot[];
  /** The skills offered, filtered to the Bot's exact grants, for the base prompt. */
  skillSnapshot?: SkillRegistrySnapshot;
}

export interface BotToolSources {
  facts(botId: string, admission: BotAdmission): Promise<BotToolFacts>;
  candidates(botId: string, admission: BotAdmission, facts: BotToolFacts, turn: BotTurnContext): Promise<BotCandidateSet>;
  /**
   * An approval that depends on live state (Computer Use's target). `null`
   * means the call needs none; `undefined` defers to the policy.
   */
  approvalFor?(botId: string, toolName: string, call: BotToolCallCheck): Promise<BotApprovalRequirement | null | undefined>;
}

export interface BotToolAssemblyPorts {
  admit(botId: string): Promise<BotAdmission>;
  sources: BotToolSources;
}

export interface BotToolAssembly {
  currentTools(botId: string, turn: BotTurnContext): Promise<BotToolEntry[]>;
  checkPolicy(botId: string, toolName: string, call?: BotToolCallCheck): Promise<BotPolicyDecision>;
  /** MCP guidance for the tools last offered to the Bot, or "" when there is none. */
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

export function createBotToolAssembly(ports: BotToolAssemblyPorts): BotToolAssembly {
  const offered = new Map<string, { guidance: readonly McpServerInstructionSnapshot[]; skillSnapshot?: SkillRegistrySnapshot }>();

  /** Run `tool` behind a fresh admission, revalidated immediately before the effect. */
  function fenced(botId: string, tool: AgentTool): AgentTool {
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        const admission = await ports.admit(botId);
        try {
          await admission.revalidateBeforeEffect();
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
          const guard = (tool: AgentTool) => (candidate.interactive ? tool : fenced(botId, tool));
          entries.push({
            tool: guard(candidate.tool),
            replay: replayOf(candidate),
            ...(candidate.mcp ? { mcp: true } : {}),
            ...(bind === undefined ? {} : { bind: (call: BotToolCall) => guard(bind(call)) }),
          });
        }
        offered.set(botId, {
          guidance: set.guidance ?? [],
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
        const live = await ports.sources.approvalFor?.(botId, toolName, call);
        if (live === null) return { allowed: true };
        if (live !== undefined) return { allowed: true, approval: live };
        const summary = await botToolApprovalSummary(toolName, call.args, facts);
        return summary === undefined ? { allowed: true } : { allowed: true, approval: { summary } };
      } catch (error) {
        return { allowed: false, reason: accessChangedReason(error) };
      } finally {
        admission.release();
      }
    },

    guidance(botId, toolNames) {
      const snapshots = offered.get(botId)?.guidance ?? [];
      return withMcpServerInstructions({ systemPrompt: "", tools: toolNames.map((name) => ({ name })) }, snapshots)
        .systemPrompt.trim();
    },

    skillSnapshot(botId) {
      return offered.get(botId)?.skillSnapshot;
    },
  };
}
