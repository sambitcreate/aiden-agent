// Shared fixtures for Bot runtime tests: Aiden-shaped tools and extension
// dependencies whose calls the tests can observe.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotDefinition } from "../../../../renderer/shared/bots.js";
import type {
  BotApprovalRequest,
  BotExtensionDeps,
  BotPolicyDecision,
  BotReadmission,
  BotToolEntry,
} from "../bot-extension.js";

export function fakeBot(id: string, overrides: Partial<BotDefinition> = {}): BotDefinition {
  return { id, name: `Bot ${id}`, ...overrides } as BotDefinition;
}

export interface RecordedDeps extends BotExtensionDeps {
  approvals: BotApprovalRequest[];
  readmissions: number;
  policyChecks: string[];
}

export function recordingDeps(options: {
  sections?: string[];
  tools?: BotToolEntry[];
  policy?: (toolName: string) => BotPolicyDecision;
  approve?: (request: BotApprovalRequest) => Promise<"allow" | "deny">;
  readmit?: () => BotReadmission;
} = {}): RecordedDeps {
  const deps: RecordedDeps = {
    approvals: [],
    readmissions: 0,
    policyChecks: [],
    loadBot: async (botId) => fakeBot(botId),
    systemSections: async () => options.sections ?? ["BASE", "PERSONA", "AUTHORITY"],
    currentTools: async () => options.tools ?? [],
    checkPolicy: async (_botId, toolName) => {
      deps.policyChecks.push(toolName);
      return options.policy?.(toolName) ?? { allowed: true };
    },
    requestApproval: async (request) => {
      deps.approvals.push(request);
      return options.approve ? options.approve(request) : "allow";
    },
    readmit: async () => {
      deps.readmissions += 1;
      return options.readmit?.() ?? { ok: true };
    },
  };
  return deps;
}

/** An Aiden-shaped tool that records each execution. */
export function countingTool(
  name: string,
  behaviour: (params: { text: string }, signal: AbortSignal | undefined, onUpdate?: Parameters<AgentTool["execute"]>[3]) => Promise<string> = async (params) =>
    `ran ${params.text}`,
): AgentTool & { executions: Array<{ text: string }> } {
  const executions: Array<{ text: string }> = [];
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: Type.Object({ text: Type.String() }),
    executions,
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = params as { text: string };
      executions.push(args);
      const text = await behaviour(args, signal, onUpdate);
      return { content: [{ type: "text", text }], details: { text } };
    },
  };
}

/** Never settles until its signal aborts. */
export function blockingUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
