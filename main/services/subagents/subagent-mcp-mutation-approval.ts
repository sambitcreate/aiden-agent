import { createHash } from "node:crypto";
import type { SubagentMcpMutationApprovalDetails } from "../../../renderer/shared/assistant.js";
import {
  SUBAGENT_MCP_MUTATION_DIGEST_PREFIX_LENGTH,
  escapeSubagentMcpMutationApprovalJson,
  isSubagentMcpMutationApprovalDetails,
} from "../../../renderer/shared/assistant.js";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import {
  MAX_CANONICAL_ARGUMENT_BYTES,
  SubagentApprovalLedgerV2,
  canonicalSubagentApprovalArgumentsV2,
  type PrepareSubagentApprovalV2Input,
} from "./approval-v2.js";
import {
  parseSubagentMcpMutationEffectProfileV2,
  type SubagentMcpMutationEffectProfileV2,
} from "./authority-v2.js";

export const MAX_SUBAGENT_MCP_MUTATION_DISPLAY_ARGUMENT_BYTES = 8 * 1024;
export const MAX_SUBAGENT_MCP_MUTATION_TIMEOUT_MS = 120_000;

export interface PrepareSubagentMcpMutationApprovalV2Input {
  treeRootId: string;
  runId: string;
  childId: string;
  childLabel: string;
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
  toolCallId: string;
  agentToolName: string;
  authorityRevision: number;
  serverId: string;
  connectionFingerprint: string;
  toolName: string;
  schemaHash: string;
  effectProfile: SubagentMcpMutationEffectProfileV2;
  arguments: unknown;
  timeoutMs: number;
  expiresAt: number;
  priorUnknownEffect: boolean;
}

interface MutationSnapshot {
  canonicalArguments: string;
  bindingDigest: string;
  ledgerInput: PrepareSubagentApprovalV2Input;
  details: SubagentMcpMutationApprovalDetails;
}

export function subagentMcpMutationArgumentDigestV2(canonicalArguments: string): string {
  return createHash("sha256")
    .update("aiden-subagent-mcp-mutation-arguments-v2\0", "utf8")
    .update(canonicalArguments, "utf8")
    .digest("hex");
}

function exactHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function subagentMcpMutationBindingDigestV2(input: {
  serverId: string;
  connectionFingerprint: string;
  toolName: string;
  schemaHash: string;
  effectProfileFingerprint: string;
  canonicalArguments: string;
  priorUnknownEffect: boolean;
}): string {
  return createHash("sha256")
    .update("aiden-subagent-mcp-mutation-binding-v2\0", "utf8")
    .update(
      JSON.stringify({
        serverId: input.serverId,
        connectionFingerprint: input.connectionFingerprint,
        toolName: input.toolName,
        schemaHash: input.schemaHash,
        effectProfileFingerprint: input.effectProfileFingerprint,
        canonicalArguments: input.canonicalArguments,
        priorUnknownEffect: input.priorUnknownEffect,
      }),
      "utf8",
    )
    .digest("hex");
}

function snapshotMutation(
  input: PrepareSubagentMcpMutationApprovalV2Input,
  redactCredentialText: (text: string) => string,
): MutationSnapshot {
  if (
    ![
      input.treeRootId,
      input.runId,
      input.childId,
      input.chatId,
      input.workspaceId,
      input.toolCallId,
      input.agentToolName,
      input.serverId,
      input.toolName,
    ].every(isSafeSubagentIdentifier) ||
    typeof input.ownerDocumentId !== "string" ||
    input.ownerDocumentId.length < 1 ||
    input.ownerDocumentId.length > 256 ||
    input.ownerDocumentId.includes("\0") ||
    !exactHash(input.connectionFingerprint) ||
    !exactHash(input.schemaHash) ||
    !Number.isSafeInteger(input.authorityRevision) ||
    input.authorityRevision < 1 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > MAX_SUBAGENT_MCP_MUTATION_TIMEOUT_MS ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= 0 ||
    typeof input.priorUnknownEffect !== "boolean"
  ) {
    throw new Error("Invalid subagent MCP mutation approval binding.");
  }
  const effectProfile = parseSubagentMcpMutationEffectProfileV2(input.effectProfile);
  const canonicalArguments = canonicalSubagentApprovalArgumentsV2(
    input.arguments,
    MAX_CANONICAL_ARGUMENT_BYTES,
  );
  if (
    Buffer.byteLength(canonicalArguments, "utf8") > MAX_SUBAGENT_MCP_MUTATION_DISPLAY_ARGUMENT_BYTES
  ) {
    throw new Error("Subagent MCP mutation arguments are too large to review safely.");
  }
  let redacted: string;
  try {
    redacted = redactCredentialText(canonicalArguments);
  } catch {
    throw new Error("Subagent MCP mutation arguments could not be redacted.");
  }
  if (redacted !== canonicalArguments) {
    throw new Error("Subagent MCP mutation arguments contained credential material.");
  }
  const displayArguments = escapeSubagentMcpMutationApprovalJson(canonicalArguments);
  const argumentDigest = subagentMcpMutationArgumentDigestV2(canonicalArguments);
  const bindingDigest = subagentMcpMutationBindingDigestV2({
    serverId: input.serverId,
    connectionFingerprint: input.connectionFingerprint,
    toolName: input.toolName,
    schemaHash: input.schemaHash,
    effectProfileFingerprint: effectProfile.fingerprint,
    canonicalArguments,
    priorUnknownEffect: input.priorUnknownEffect,
  });
  const prefix = (value: string) => value.slice(0, SUBAGENT_MCP_MUTATION_DIGEST_PREFIX_LENGTH);
  const details: SubagentMcpMutationApprovalDetails = {
    kind: "subagent-mcp-mutation",
    childLabel: input.childLabel,
    serverId: input.serverId,
    toolName: input.toolName,
    connectionDigestPrefix: prefix(input.connectionFingerprint),
    schemaDigestPrefix: prefix(input.schemaHash),
    profileDigestPrefix: prefix(effectProfile.fingerprint),
    argumentDigestPrefix: prefix(argumentDigest),
    classification: effectProfile.classification,
    destructive: effectProfile.destructive,
    idempotency: effectProfile.idempotency,
    openWorld: effectProfile.openWorld,
    taskSupport: effectProfile.taskSupport,
    timeoutMs: input.timeoutMs,
    canonicalArguments: displayArguments,
    priorUnknownEffect: input.priorUnknownEffect,
    automaticRetry: false,
    rollbackAvailable: false,
  };
  if (!isSubagentMcpMutationApprovalDetails(details)) {
    throw new Error("Subagent MCP mutation approval details were unsafe.");
  }
  return {
    canonicalArguments,
    bindingDigest,
    details: Object.freeze(details),
    ledgerInput: {
      treeRootId: input.treeRootId,
      runId: input.runId,
      childId: input.childId,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      ownerDocumentId: input.ownerDocumentId,
      toolCallId: input.toolCallId,
      toolName: input.agentToolName,
      authorityRevision: input.authorityRevision,
      arguments: { bindingDigest },
      expiresAt: input.expiresAt,
    },
  };
}

/** Production-inert owner-bound one-shot approval state; it has no dispatch method. */
export class SubagentMcpMutationApprovalCoreV2 {
  private readonly prepared = new Map<string, MutationSnapshot>();

  constructor(
    private readonly redactCredentialText: (text: string) => string,
    private readonly ledger = new SubagentApprovalLedgerV2(),
  ) {}

  prepare(input: PrepareSubagentMcpMutationApprovalV2Input): {
    approvalId: string;
    bindingDigest: string;
    details: Readonly<SubagentMcpMutationApprovalDetails>;
  } {
    const snapshot = snapshotMutation(input, this.redactCredentialText);
    const prepared = this.ledger.prepare(snapshot.ledgerInput);
    this.prepared.set(prepared.approvalId, snapshot);
    return {
      approvalId: prepared.approvalId,
      bindingDigest: snapshot.bindingDigest,
      details: snapshot.details,
    };
  }

  authorize(
    approvalId: string,
    ownerDocumentId: string,
    current: PrepareSubagentMcpMutationApprovalV2Input,
  ): boolean {
    const expected = this.prepared.get(approvalId);
    if (!expected) return false;
    let live: MutationSnapshot;
    try {
      live = snapshotMutation(current, this.redactCredentialText);
    } catch {
      return false;
    }
    if (live.bindingDigest !== expected.bindingDigest) return false;
    return this.ledger.authorize(approvalId, ownerDocumentId, live.ledgerInput);
  }

  consume(approvalId: string, current: PrepareSubagentMcpMutationApprovalV2Input): boolean {
    const expected = this.prepared.get(approvalId);
    if (!expected) return false;
    let live: MutationSnapshot;
    try {
      live = snapshotMutation(current, this.redactCredentialText);
    } catch {
      return false;
    }
    if (live.bindingDigest !== expected.bindingDigest) return false;
    const consumed = this.ledger.consume(approvalId, live.ledgerInput);
    if (consumed) this.prepared.delete(approvalId);
    return consumed;
  }

  deny(approvalId: string, ownerDocumentId: string): boolean {
    const denied = this.ledger.deny(approvalId, ownerDocumentId);
    if (denied) this.prepared.delete(approvalId);
    return denied;
  }
}
