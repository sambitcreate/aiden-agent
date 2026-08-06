import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { ToolApprovalPrompt } from "../tool-approval.js";
import {
  SubagentApprovalLedgerV2,
  type PrepareSubagentApprovalV2Input,
} from "./approval-v2.js";
import type {
  SubagentAuthorityV2,
  SubagentMcpToolScopeV2,
} from "./authority-v2.js";

export const SUBAGENT_EGRESS_APPROVAL_WINDOW_MS = 60_000;
export const MAX_SUBAGENT_MCP_APPROVAL_ARGUMENT_BYTES = 8 * 1024;
export const MAX_SUBAGENT_OUTBOUND_APPROVAL_SUMMARY_CHARS = 12_000;

export interface SubagentOutboundToolBindingV2 {
  /** Exact child-facing AgentTool name. */
  toolName: string;
  kind: "web" | "mcp";
  /** Required for MCP and absent for web. */
  mcp?: {
    serverId: string;
    connectionFingerprint: string;
    tool: SubagentMcpToolScopeV2;
  };
}

export interface SubagentOutboundApprovalBrokerV2Input {
  authority: SubagentAuthorityV2;
  childId: string;
  tools: readonly SubagentOutboundToolBindingV2[];
  ledger: SubagentApprovalLedgerV2;
  currentAuthority(runId: string): SubagentAuthorityV2 | undefined;
  requestApproval(
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal: AbortSignal | undefined,
    ownerDocumentId: string,
  ): Promise<boolean>;
  now?: () => number;
}

export interface SubagentOutboundApprovalGateV2 {
  beforeToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  consume(input: {
    toolCallId: string;
    toolName: string;
    arguments: unknown;
  }): void;
}

export function sameSubagentAuthorityBindingV2(
  expected: SubagentAuthorityV2,
  current: SubagentAuthorityV2 | undefined,
): current is SubagentAuthorityV2 {
  return (
    current !== undefined &&
    current.version === expected.version &&
    current.grantId === expected.grantId &&
    current.treeRootId === expected.treeRootId &&
    current.runId === expected.runId &&
    current.parentRunId === expected.parentRunId &&
    current.depth === expected.depth &&
    current.authorityRevision === expected.authorityRevision &&
    current.generationId === expected.generationId &&
    current.chatId === expected.chatId &&
    current.workspaceId === expected.workspaceId &&
    current.workspaceRevision === expected.workspaceRevision &&
    current.ownerDocumentId === expected.ownerDocumentId &&
    current.providerFingerprint === expected.providerFingerprint &&
    current.modelFingerprint === expected.modelFingerprint &&
    current.contextRevision === expected.contextRevision &&
    current.execution === expected.execution &&
    current.context === expected.context &&
    current.thinkingLevel === expected.thinkingLevel &&
    current.expiresAt === expected.expiresAt &&
    JSON.stringify(current.capabilities) ===
      JSON.stringify(expected.capabilities) &&
    JSON.stringify(current.budgets) === JSON.stringify(expected.budgets)
  );
}

function authorityAllows(
  authority: SubagentAuthorityV2,
  binding: SubagentOutboundToolBindingV2,
): boolean {
  if (authority.execution !== "foreground") return false;
  if (binding.kind === "web")
    return authority.capabilities.web && binding.mcp === undefined;
  if (!binding.mcp || binding.mcp.tool.effect !== "read") return false;
  return authority.capabilities.mcp.some(
    (scope) =>
      scope.serverId === binding.mcp?.serverId &&
      scope.connectionFingerprint === binding.mcp.connectionFingerprint &&
      scope.tools.some(
        (tool) =>
          tool.toolName === binding.mcp?.tool.toolName &&
          tool.schemaHash === binding.mcp.tool.schemaHash &&
          tool.effect === "read",
      ),
  );
}

function blocked(reason: string): BeforeToolCallResult {
  return { block: true, reason };
}

function canonicalApprovalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalApprovalValue);
  if (typeof value !== "object") {
    throw new Error("Subagent approval arguments are not displayable.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalApprovalValue(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
}

export function subagentOutboundApprovalSummaryV2(
  binding: SubagentOutboundToolBindingV2,
  argumentsValue: unknown,
): string {
  const args = canonicalApprovalValue(argumentsValue) as Record<
    string,
    unknown
  >;
  let summary: string;
  if (binding.kind === "web") {
    if (typeof args.query !== "string") {
      throw new Error("Subagent web approval query is invalid.");
    }
    const resultCount = args.numResults === undefined ? 5 : args.numResults;
    summary = [
      "Search the public web",
      `Query: ${JSON.stringify(args.query)}`,
      `Results: ${JSON.stringify(resultCount)}`,
    ].join("\n");
  } else {
    if (!binding.mcp)
      throw new Error("Subagent MCP approval binding is invalid.");
    const canonicalArguments = JSON.stringify(args);
    if (
      Buffer.byteLength(canonicalArguments, "utf8") >
      MAX_SUBAGENT_MCP_APPROVAL_ARGUMENT_BYTES
    ) {
      throw new Error(
        "Subagent MCP approval arguments are too large to review safely.",
      );
    }
    summary = [
      `Call server-declared read-only MCP tool ${binding.mcp.serverId}:${binding.mcp.tool.toolName}`,
      "The configured server controls the actual effect.",
      `Arguments: ${canonicalArguments}`,
    ].join("\n");
  }
  if (summary.length > MAX_SUBAGENT_OUTBOUND_APPROVAL_SUMMARY_CHARS) {
    throw new Error("Subagent approval summary is too large to review safely.");
  }
  return summary;
}

/**
 * Main-owned, foreground-only approval hook for exact child egress tools.
 * The model's capability request is only an authority ceiling. Every exact
 * web/MCP invocation still receives one owner-bound, one-shot user grant.
 */
export function createSubagentOutboundApprovalBrokerV2(
  input: SubagentOutboundApprovalBrokerV2Input,
): SubagentOutboundApprovalGateV2 {
  const now = input.now ?? Date.now;
  const tools = new Map<string, SubagentOutboundToolBindingV2>();
  for (const tool of input.tools) {
    if (tools.has(tool.toolName)) {
      throw new Error("Duplicate subagent outbound tool approval binding.");
    }
    if (!authorityAllows(input.authority, tool)) {
      throw new Error("Subagent outbound tool exceeds its authority ceiling.");
    }
    tools.set(tool.toolName, tool);
  }

  const authorized = new Map<
    string,
    { approvalId: string; expiresAt: number; toolName: string }
  >();

  const beforeToolCall = async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const tool = tools.get(context.toolCall.name);
    if (!tool) return undefined;
    const authority = input.currentAuthority(input.authority.runId);
    if (
      !sameSubagentAuthorityBindingV2(input.authority, authority) ||
      authority.expiresAt <= now()
    ) {
      return blocked("This subagent authority expired or was revoked.");
    }
    if (!authorityAllows(authority, tool)) {
      return blocked("This subagent tool is no longer authorized.");
    }
    const expiresAt = Math.min(
      authority.expiresAt,
      now() + SUBAGENT_EGRESS_APPROVAL_WINDOW_MS,
    );
    const exact = (): PrepareSubagentApprovalV2Input => ({
      treeRootId: authority.treeRootId,
      runId: authority.runId,
      childId: input.childId,
      chatId: authority.chatId,
      workspaceId: authority.workspaceId,
      ownerDocumentId: authority.ownerDocumentId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      authorityRevision: authority.authorityRevision,
      arguments: context.args,
      expiresAt,
    });
    let prepared: ReturnType<SubagentApprovalLedgerV2["prepare"]>;
    try {
      prepared = input.ledger.prepare(exact());
    } catch {
      return blocked(
        "This subagent action could not be prepared for approval.",
      );
    }

    let summary: string;
    try {
      summary = subagentOutboundApprovalSummaryV2(tool, context.args);
    } catch {
      input.ledger.deny(prepared.approvalId, authority.ownerDocumentId);
      return blocked("This subagent action is too large to review safely.");
    }
    let allowed = false;
    try {
      allowed = await input.requestApproval(
        {
          streamId: authority.generationId,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          summary,
        },
        signal,
        authority.ownerDocumentId,
      );
    } catch {
      allowed = false;
    }
    if (!allowed) {
      input.ledger.deny(prepared.approvalId, authority.ownerDocumentId);
      return blocked(
        signal?.aborted
          ? "This subagent action was cancelled."
          : "The user denied this subagent action.",
      );
    }

    const live = input.currentAuthority(authority.runId);
    if (
      !sameSubagentAuthorityBindingV2(authority, live) ||
      live.expiresAt <= now() ||
      !authorityAllows(live, tool)
    ) {
      input.ledger.deny(prepared.approvalId, authority.ownerDocumentId);
      return blocked("This subagent authority changed after approval.");
    }
    const current = exact();
    if (
      !input.ledger.authorize(
        prepared.approvalId,
        authority.ownerDocumentId,
        current,
      )
    ) {
      input.ledger.deny(prepared.approvalId, authority.ownerDocumentId);
      return blocked(
        "This subagent approval expired or no longer matches the action.",
      );
    }
    authorized.set(context.toolCall.id, {
      approvalId: prepared.approvalId,
      expiresAt,
      toolName: context.toolCall.name,
    });
    return undefined;
  };

  const consume: SubagentOutboundApprovalGateV2["consume"] = (effect) => {
    const pending = authorized.get(effect.toolCallId);
    authorized.delete(effect.toolCallId);
    if (!pending) {
      throw new Error(
        "This subagent action does not have a live one-shot approval.",
      );
    }
    if (pending.toolName !== effect.toolName) {
      input.ledger.deny(pending.approvalId, input.authority.ownerDocumentId);
      throw new Error(
        "This subagent action does not have a live one-shot approval.",
      );
    }
    const tool = tools.get(effect.toolName);
    const authority = input.currentAuthority(input.authority.runId);
    const current: PrepareSubagentApprovalV2Input = {
      treeRootId: input.authority.treeRootId,
      runId: input.authority.runId,
      childId: input.childId,
      chatId: input.authority.chatId,
      workspaceId: input.authority.workspaceId,
      ownerDocumentId: input.authority.ownerDocumentId,
      toolCallId: effect.toolCallId,
      toolName: effect.toolName,
      authorityRevision: input.authority.authorityRevision,
      arguments: effect.arguments,
      expiresAt: pending.expiresAt,
    };
    if (
      !tool ||
      !sameSubagentAuthorityBindingV2(input.authority, authority) ||
      authority.expiresAt <= now() ||
      !authorityAllows(authority, tool) ||
      !input.ledger.consume(pending.approvalId, current)
    ) {
      input.ledger.deny(pending.approvalId, input.authority.ownerDocumentId);
      throw new Error(
        "This subagent approval expired, changed, was revoked, or was already used.",
      );
    }
  };

  return { beforeToolCall, consume };
}
