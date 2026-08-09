import { createHash, randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  adaptSubagentRunSnapshotV2ToV1,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
  type SubagentRunSnapshot,
} from "../../../renderer/shared/subagent-runs.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { scheduledProviderFingerprint } from "../schedule-provider-binding.js";
import type { Workspace, WorkspacePermission } from "../types.js";
import {
  createSubagentAuthorityV2,
  resolveSubagentCapabilitiesV2,
  subagentCapabilitiesAreSubsetV2,
  type SubagentAuthorityV2,
  type SubagentCapabilitySetV2,
  type SubagentMcpScopeV2,
} from "./authority-v2.js";
import {
  MAX_SUBAGENT_CHILD_OUTPUT_CHARS,
  MAX_SUBAGENT_CHILD_TOOL_CALLS,
  MAX_SUBAGENT_CHILD_TURNS,
} from "./subagent-child-runner.js";
import {
  MAX_SUBAGENT_LAUNCHES_PER_GENERATION,
  MAX_SUBAGENT_SUMMARY_CHARS,
  type SubagentTaskRequest,
  type SubagentRequestedCapabilities,
} from "./contracts.js";
import type { SubagentRunIdentity } from "./subagent-event-projector.js";
import type { ProductionSubagentRunStore } from "./subagent-run-store-production.js";
import type { NativeSubagentPrivateRunManifestV2 } from "./subagent-run-store-v2-core.js";
import { SubagentApprovalLedgerV2 } from "./approval-v2.js";
import { MAX_QUEUED_SUBAGENT_CHILDREN } from "./concurrency-gate.js";
import type { SubagentControlMainV2 } from "./subagent-control-main.js";
import type { ToolApprovalPrompt } from "../tool-approval.js";
import type { WorkspaceOperationRegistry } from "../workspace-operation-registry.js";
import {
  createSubagentOutboundApprovalBrokerV2,
  type SubagentOutboundToolBindingV2,
} from "./outbound-approval-v2.js";
import { resolveRequestedSubagentCapabilitiesV2 } from "./request-capabilities-v2.js";
import { SubagentNetworkBudgetV2 } from "./network-budget-v2.js";
import {
  createSubagentWorkspaceWriteApprovalBrokerV2,
  subagentWorkspaceRevisionV2,
  type SubagentWorkspaceWriteToolBindingV2,
} from "./subagent-workspace-write.js";
import {
  createSubagentMcpMutationBrokerV2,
  type SubagentMcpMutationBindingV2,
  type SubagentMcpMutationHostV2,
} from "./subagent-mcp-mutation.js";
import {
  createSubagentShellBrokerV2,
  type SubagentShellToolBindingV2,
} from "./subagent-shell.js";

const READ_ONLY_CAPABILITIES: SubagentCapabilitySetV2 = {
  workspaceRead: true,
  workspaceWrite: false,
  shell: false,
  web: false,
  delegation: false,
  mcp: [],
};

export interface ForegroundSubagentPersistenceV2Input {
  store: ProductionSubagentRunStore;
  generationId: string;
  chatId: string;
  workspace: Workspace;
  runtime: ResolvedModelRuntime;
  thinkingLevel: ThinkingLevel;
  ownerDocumentId: string;
  permission: WorkspacePermission;
  control?: SubagentControlMainV2;
  applyControlSnapshot?: (
    snapshot: SubagentRunSnapshotV2,
  ) => SubagentRunSnapshotV1;
  currentControlSnapshot?: (runId: string) => SubagentRunSnapshotV1;
  settleControlSnapshots?: () => Promise<void>;
  onControlSnapshot?: (snapshot: SubagentRunSnapshotV1) => void;
  webEnabled?: boolean;
  writeEnabled?: boolean;
  mcpInventory?: readonly SubagentMcpScopeV2[];
  mcpMutationsEnabled?: boolean;
  mcpMutationHost?: SubagentMcpMutationHostV2;
  shellEnabled?: boolean;
  shellBinary?: string;
  delegationEnabled?: boolean;
  requestApproval?: (
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal: AbortSignal | undefined,
    ownerDocumentId: string,
  ) => Promise<boolean>;
  currentWorkspace?: (workspaceId: string) => Promise<Workspace | undefined>;
  validateWorkspace?: (workspace: Workspace) => Promise<void>;
  workspaceOperationRegistry?: WorkspaceOperationRegistry;
  now?: () => number;
  randomUUID?: () => string;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelFingerprint(runtime: ResolvedModelRuntime): string {
  return fingerprint({
    provider: scheduledProviderFingerprint(runtime.provider),
    id: runtime.model.id,
    api: runtime.model.api,
    providerId: runtime.model.provider,
    baseUrl: runtime.model.baseUrl ?? null,
    contextWindow: runtime.model.contextWindow ?? null,
    maxTokens: runtime.model.maxTokens ?? null,
  });
}

/**
 * Bridges the existing bounded renderer projector into canonical native V2
 * persistence. The private immutable authority is created once per run and is
 * never included in the returned renderer projection.
 */
export function createForegroundSubagentPersistenceV2(
  input: ForegroundSubagentPersistenceV2Input,
) {
  const now = input.now ?? Date.now;
  const allocateUuid = input.randomUUID ?? randomUUID;
  const authorities = new Map<string, SubagentAuthorityV2>();
  const approvals = new SubagentApprovalLedgerV2(now);
  const revokedRuns = new Set<string>();
  const networkBudgets = new SubagentNetworkBudgetV2();
  const preparedRuns = new Map<
    string,
    {
      stop(reason?: Error): void;
      controlRegistered: boolean;
    }
  >();
  let controlPersistenceTail: Promise<void> = Promise.resolve();
  let controlPersistenceError: unknown;
  const providerBinding = scheduledProviderFingerprint(input.runtime.provider);
  const modelBinding = modelFingerprint(input.runtime);
  const workspaceBinding = subagentWorkspaceRevisionV2(input.workspace);
  function revokeAuthority(runId: string): void {
    revokedRuns.add(runId);
    const authority = authorities.get(runId);
    if (authority) networkBudgets.release(authority);
  }
  function prepareAuthority(
    identity: SubagentRunIdentity,
    contextMode: "fresh" | "fork",
    contextRevision: string,
    deadlineMs: number,
    requestedCapabilities: SubagentRequestedCapabilities,
    parentAuthority?: SubagentAuthorityV2,
  ): SubagentAuthorityV2 {
    const existing = authorities.get(identity.runId);
    if (existing) return existing;
    const issuedAt = now();
    if (!Number.isFinite(issuedAt) || issuedAt < 0) {
      throw new Error("Invalid subagent authority clock.");
    }
    if (parentAuthority) {
      const currentParent = authorities.get(parentAuthority.runId);
      if (
        !currentParent ||
        revokedRuns.has(parentAuthority.runId) ||
        JSON.stringify(currentParent) !== JSON.stringify(parentAuthority) ||
        parentAuthority.depth !== 1 ||
        parentAuthority.execution !== "foreground" ||
        parentAuthority.capabilities.delegation !== true ||
        parentAuthority.expiresAt <= issuedAt
      ) {
        throw new Error(
          "Nested subagent parent authority is stale, revoked, or ineligible.",
        );
      }
    }
    const availableMcpInventory = (input.mcpInventory ?? []).flatMap(
      (scope) => {
        const tools = scope.tools.filter(
          (tool) =>
            tool.effect === "read" || input.mcpMutationsEnabled === true,
        );
        return tools.length > 0 ? [{ ...scope, tools }] : [];
      },
    );
    const exactRequested = resolveRequestedSubagentCapabilitiesV2(
      requestedCapabilities,
      availableMcpInventory,
    );
    if (
      parentAuthority &&
      !subagentCapabilitiesAreSubsetV2(
        exactRequested,
        parentAuthority.capabilities,
      )
    ) {
      throw new Error(
        "A nested subagent request cannot widen its parent capability ceiling.",
      );
    }
    const writeAvailable =
      input.writeEnabled === true &&
      (input.permission === "ask" || input.permission === "full") &&
      typeof input.requestApproval === "function" &&
      typeof input.currentWorkspace === "function" &&
      typeof input.validateWorkspace === "function";
    const shellAvailable =
      input.shellEnabled === true &&
      typeof input.shellBinary === "string" &&
      input.shellBinary.length > 0 &&
      input.permission !== "none" &&
      typeof input.requestApproval === "function" &&
      typeof input.currentWorkspace === "function" &&
      typeof input.validateWorkspace === "function";
    const availableCapabilities: SubagentCapabilitySetV2 = {
      ...READ_ONLY_CAPABILITIES,
      workspaceWrite: writeAvailable,
      shell: shellAvailable,
      web: input.webEnabled === true,
      delegation: input.delegationEnabled === true,
      mcp: availableMcpInventory,
    };
    const capabilities = resolveSubagentCapabilitiesV2({
      requested: exactRequested,
      root: parentAuthority?.capabilities ?? availableCapabilities,
      parent: parentAuthority?.capabilities ?? availableCapabilities,
      role: availableCapabilities,
      rollout: {
        background: false,
        fork: contextMode === "fork",
        workspaceWrite: writeAvailable,
        shell: shellAvailable,
        web: input.webEnabled === true,
        mcp: availableMcpInventory.length > 0,
        delegation: parentAuthority ? false : input.delegationEnabled === true,
      },
      userGrant: availableCapabilities,
      workspacePermission: input.permission,
      workspaceEgressApproval:
        typeof input.requestApproval === "function"
          ? "per_call"
          : "unavailable",
    });
    const authority = createSubagentAuthorityV2({
      grantId: `grant-${allocateUuid()}`,
      treeRootId:
        parentAuthority?.treeRootId ??
        `tree-${fingerprint(input.generationId).slice(0, 32)}`,
      runId: identity.runId,
      ...(parentAuthority ? { parentRunId: parentAuthority.runId } : {}),
      depth: parentAuthority ? 2 : 1,
      authorityRevision: 1,
      generationId: parentAuthority?.generationId ?? input.generationId,
      chatId: parentAuthority?.chatId ?? input.chatId,
      workspaceId: parentAuthority?.workspaceId ?? input.workspace.id,
      workspaceRevision: parentAuthority?.workspaceRevision ?? workspaceBinding,
      ownerDocumentId:
        parentAuthority?.ownerDocumentId ?? input.ownerDocumentId,
      providerFingerprint:
        parentAuthority?.providerFingerprint ?? providerBinding,
      modelFingerprint: parentAuthority?.modelFingerprint ?? modelBinding,
      contextRevision,
      execution: parentAuthority?.execution ?? "foreground",
      context: contextMode,
      thinkingLevel: parentAuthority?.thinkingLevel ?? input.thinkingLevel,
      capabilities,
      budgets: {
        deadlineMs,
        maxTurns: MAX_SUBAGENT_CHILD_TURNS,
        maxToolCalls: MAX_SUBAGENT_CHILD_TOOL_CALLS,
        maxOutputChars: Math.max(
          MAX_SUBAGENT_SUMMARY_CHARS,
          MAX_SUBAGENT_CHILD_OUTPUT_CHARS,
        ),
        maxTokens: Math.min(
          10_000_000,
          Math.max(1, input.runtime.model.contextWindow ?? 1_000_000),
        ),
        maxLaunches:
          parentAuthority?.budgets.maxLaunches ??
          MAX_SUBAGENT_LAUNCHES_PER_GENERATION,
        maxDepth: 2,
        maxActive: input.runtime.provider.deployment === "local" ? 1 : 2,
        maxQueued: MAX_QUEUED_SUBAGENT_CHILDREN,
        maxNetworkOperations: 1,
      },
      expiresAt: Math.min(
        parentAuthority?.expiresAt ?? Number.POSITIVE_INFINITY,
        issuedAt + deadlineMs,
      ),
    });
    authorities.set(identity.runId, authority);
    return authority;
  }

  function manifestFor(
    canonical: SubagentRunSnapshotV2,
  ): NativeSubagentPrivateRunManifestV2 {
    const authority = authorities.get(canonical.runId);
    if (
      !authority ||
      canonical.authorityRevision !== authority.authorityRevision
    ) {
      throw new Error(
        "Foreground subagent authority was not resolved before launch.",
      );
    }
    return {
      version: 2,
      provenance: "v2_native",
      runId: canonical.runId,
      generationId: canonical.generationId,
      childId: canonical.childId,
      chatId: canonical.chatId,
      workspaceId: canonical.workspaceId,
      task: canonical.taskPreview,
      reusableAuthority: false,
      authority,
    };
  }

  function canonicalSnapshot(
    snapshot: SubagentRunSnapshotV1,
  ): SubagentRunSnapshotV2 {
    const authority = authorities.get(snapshot.runId);
    if (!authority) {
      throw new Error(
        "Foreground subagent authority was not resolved before launch.",
      );
    }
    const canonical = parseSubagentRunSnapshotV2({
      ...snapshot,
      version: 2,
      ...(authority.parentRunId ? { parentRunId: authority.parentRunId } : {}),
      depth: authority.depth,
      execution: authority.execution,
      context: authority.context,
      authorityRevision: authority.authorityRevision,
    });
    if (!canonical) {
      throw new Error(
        "Foreground subagent snapshot could not enter canonical V2 storage.",
      );
    }
    return canonical;
  }

  function enqueueControlPersistence(
    canonical: SubagentRunSnapshotV2,
    manifest: NativeSubagentPrivateRunManifestV2,
  ): void {
    const operation = () =>
      input.store.upsert(canonical, manifest).then(() => undefined);
    const result = controlPersistenceTail.then(operation, operation);
    controlPersistenceTail = result.then(
      () => undefined,
      (error) => {
        controlPersistenceError ??= error;
      },
    );
  }

  return {
    /** Main-owned authority preflight called before projector or child construction. */
    async prepareRun(value: {
      identity: SubagentRunIdentity;
      task: SubagentTaskRequest;
      contextMode: "fresh" | "fork";
      contextRevision: string;
      deadlineMs: number;
      requestedCapabilities?: SubagentRequestedCapabilities;
      parentAuthority?: SubagentAuthorityV2;
      stop(reason?: Error): void;
    }) {
      void value.task;
      const requestedCapabilities = value.requestedCapabilities ?? {
        workspaceRead: true,
        workspaceWrite: false,
        shell: false,
        web: false,
        mcp: [],
        delegate: false,
      };
      if (value.parentAuthority && requestedCapabilities.delegate === true) {
        throw new Error("A depth-2 subagent cannot request delegation.");
      }
      if (
        requestedCapabilities.delegate === true &&
        (!input.delegationEnabled ||
          input.store.selection !== "v2" ||
          value.parentAuthority)
      ) {
        throw new Error(
          "Requested subagent delegation capability is unavailable.",
        );
      }
      if (
        input.store.selection === "v1" &&
        (!requestedCapabilities.workspaceRead ||
          requestedCapabilities.workspaceWrite ||
          requestedCapabilities.shell === true ||
          requestedCapabilities.delegate === true ||
          requestedCapabilities.web ||
          requestedCapabilities.mcp.length > 0 ||
          (requestedCapabilities.mcpMutations?.length ?? 0) > 0)
      ) {
        throw new Error(
          "Requested subagent capabilities are unavailable during V1 rollback.",
        );
      }
      if (
        requestedCapabilities.workspaceWrite &&
        (input.writeEnabled !== true ||
          (input.permission !== "ask" && input.permission !== "full") ||
          typeof input.requestApproval !== "function" ||
          typeof input.currentWorkspace !== "function" ||
          typeof input.validateWorkspace !== "function")
      ) {
        throw new Error(
          "Requested subagent workspace-write capability is unavailable.",
        );
      }
      if (
        requestedCapabilities.shell === true &&
        (input.shellEnabled !== true ||
          !input.shellBinary ||
          input.permission === "none" ||
          !input.requestApproval ||
          !input.currentWorkspace ||
          !input.validateWorkspace)
      ) {
        throw new Error("Requested subagent shell capability is unavailable.");
      }
      if (
        (requestedCapabilities.mcpMutations?.length ?? 0) > 0 &&
        (input.mcpMutationsEnabled !== true ||
          !input.mcpMutationHost ||
          !input.requestApproval)
      ) {
        throw new Error(
          "Requested subagent MCP mutation capability is unavailable.",
        );
      }
      if (input.store.selection === "v2") {
        if (value.parentAuthority) {
          if (!input.currentWorkspace || !input.validateWorkspace) {
            throw new Error(
              "Nested subagent workspace revalidation is unavailable.",
            );
          }
          const currentWorkspace = await input.currentWorkspace(
            value.parentAuthority.workspaceId,
          );
          if (
            !currentWorkspace ||
            subagentWorkspaceRevisionV2(currentWorkspace) !==
              value.parentAuthority.workspaceRevision
          ) {
            throw new Error(
              "Nested subagent workspace authority changed before preparation.",
            );
          }
          await input.validateWorkspace(currentWorkspace);
        }
        await input.store.reserveRun(value.identity.runId);
        try {
          prepareAuthority(
            value.identity,
            value.contextMode,
            value.contextRevision,
            value.deadlineMs,
            requestedCapabilities,
            value.parentAuthority,
          );
        } catch (error) {
          input.store.releaseRunReservation(value.identity.runId);
          throw error;
        }
      }
      preparedRuns.set(value.identity.runId, {
        stop: value.stop,
        controlRegistered: false,
      });
      return {
        authority: authorities.get(value.identity.runId),
        revalidateAuthority: async () => {
          const authority = authorities.get(value.identity.runId);
          if (
            !authority ||
            revokedRuns.has(value.identity.runId) ||
            authority.expiresAt <= now()
          ) {
            throw new Error(
              "Subagent authority was revoked before provider dispatch.",
            );
          }
          if (value.parentAuthority) {
            const parent = authorities.get(value.parentAuthority.runId);
            if (
              !parent ||
              revokedRuns.has(parent.runId) ||
              JSON.stringify(parent) !==
                JSON.stringify(value.parentAuthority) ||
              parent.expiresAt <= now() ||
              !input.currentWorkspace ||
              !input.validateWorkspace
            ) {
              throw new Error(
                "Nested subagent parent authority was revoked before dispatch.",
              );
            }
            const workspace = await input.currentWorkspace(parent.workspaceId);
            if (
              !workspace ||
              subagentWorkspaceRevisionV2(workspace) !==
                parent.workspaceRevision
            ) {
              throw new Error(
                "Nested subagent workspace authority changed before dispatch.",
              );
            }
            await input.validateWorkspace(workspace);
          }
          return authority;
        },
        currentAuthority: () =>
          revokedRuns.has(value.identity.runId)
            ? undefined
            : authorities.get(value.identity.runId),
        consumeNetworkOperation: (authority: SubagentAuthorityV2) =>
          networkBudgets.consume(authority),
        prepareOutboundApproval: (
          bindings: readonly SubagentOutboundToolBindingV2[],
        ) => {
          const authority = authorities.get(value.identity.runId);
          if (
            !authority ||
            revokedRuns.has(value.identity.runId) ||
            !input.requestApproval
          ) {
            throw new Error("Subagent outbound approval is unavailable.");
          }
          return createSubagentOutboundApprovalBrokerV2({
            authority,
            childId: value.identity.childId,
            tools: bindings,
            ledger: approvals,
            currentAuthority: (runId) =>
              revokedRuns.has(runId) ? undefined : authorities.get(runId),
            requestApproval: input.requestApproval,
            now,
          });
        },
        prepareWorkspaceWriteApproval: (
          bindings: readonly SubagentWorkspaceWriteToolBindingV2[],
          runSignal?: AbortSignal,
        ) => {
          const authority = authorities.get(value.identity.runId);
          if (
            !authority ||
            revokedRuns.has(value.identity.runId) ||
            !input.requestApproval ||
            !input.currentWorkspace ||
            !input.validateWorkspace
          ) {
            throw new Error(
              "Subagent workspace-write approval is unavailable.",
            );
          }
          if (!input.workspace.folderPath) {
            throw new Error("Subagent workspace root is unavailable.");
          }
          return createSubagentWorkspaceWriteApprovalBrokerV2({
            authority,
            childId: value.identity.childId,
            childLabel: value.task.label,
            workspace: input.workspace,
            workspaceRoot: input.workspace.folderPath,
            bindings,
            ledger: approvals,
            currentAuthority: (runId) =>
              revokedRuns.has(runId) ? undefined : authorities.get(runId),
            currentWorkspace: input.currentWorkspace,
            validateWorkspace: input.validateWorkspace,
            requestApproval: input.requestApproval,
            runSignal,
            registry: input.workspaceOperationRegistry,
            now,
          });
        },
        prepareMcpMutationApproval: (
          bindings: readonly SubagentMcpMutationBindingV2[],
          runSignal?: AbortSignal,
        ) => {
          const authority = authorities.get(value.identity.runId);
          if (
            !authority ||
            revokedRuns.has(value.identity.runId) ||
            input.mcpMutationsEnabled !== true ||
            !input.mcpMutationHost ||
            !input.requestApproval ||
            input.store.selection !== "v2"
          ) {
            throw new Error("Subagent MCP mutation approval is unavailable.");
          }
          return createSubagentMcpMutationBrokerV2({
            authority,
            childId: value.identity.childId,
            childLabel: value.task.label,
            bindings,
            ledger: approvals,
            journal: input.store,
            host: input.mcpMutationHost,
            currentAuthority: (runId) =>
              revokedRuns.has(runId) ? undefined : authorities.get(runId),
            consumeNetworkOperation: (current) =>
              networkBudgets.consume(current),
            requestApproval: input.requestApproval,
            findPriorUnknownEffect: async (query) => {
              const effects = await input.store.listEffectsByChat(query.chatId);
              return effects.some(
                (effect) =>
                  effect.state === "unknown" &&
                  effect.effectKind === "mcp_mutation" &&
                  effect.runId === query.runId &&
                  effect.chatId === query.chatId &&
                  effect.childId === query.childId &&
                  effect.toolName === query.agentToolName &&
                  effect.argumentDigest === query.argumentDigest &&
                  effect.effectDigest === query.effectDigest,
              );
            },
            runSignal,
            now,
            randomUUID: allocateUuid,
          });
        },
        prepareShellApproval: (
          bindings: readonly SubagentShellToolBindingV2[],
          runSignal?: AbortSignal,
        ) => {
          const authority = authorities.get(value.identity.runId);
          if (
            !authority ||
            revokedRuns.has(value.identity.runId) ||
            input.shellEnabled !== true ||
            !input.shellBinary ||
            !input.requestApproval ||
            !input.currentWorkspace ||
            !input.validateWorkspace ||
            input.store.selection !== "v2" ||
            bindings.length !== 1 ||
            bindings[0]?.toolName !== "run_command" ||
            !input.workspace.folderPath
          ) {
            throw new Error("Subagent shell approval is unavailable.");
          }
          return createSubagentShellBrokerV2({
            authority,
            childId: value.identity.childId,
            childLabel: value.task.label,
            workspace: input.workspace,
            workspaceRoot: input.workspace.folderPath,
            ledger: approvals,
            journal: input.store,
            currentAuthority: (runId) =>
              revokedRuns.has(runId) ? undefined : authorities.get(runId),
            currentWorkspace: input.currentWorkspace,
            validateWorkspace: input.validateWorkspace,
            requestApproval: input.requestApproval,
            binary: input.shellBinary,
            runSignal,
            registry: input.workspaceOperationRegistry,
            now,
            randomUUID: allocateUuid,
          });
        },
        abortPreparation: () => {
          revokeAuthority(value.identity.runId);
          approvals.cancelRun(value.identity.runId);
          const prepared = preparedRuns.get(value.identity.runId);
          if (prepared?.controlRegistered) {
            input.control?.unregisterPrepared(
              value.identity.runId,
              input.ownerDocumentId,
            );
          }
          preparedRuns.delete(value.identity.runId);
          authorities.delete(value.identity.runId);
          input.store.releaseRunReservation(value.identity.runId);
        },
        complete: () => {
          revokeAuthority(value.identity.runId);
          approvals.cancelRun(value.identity.runId);
          return input.control?.stateForRun(
            value.identity.runId,
            input.ownerDocumentId,
          ) === "stopped"
            ? ("stopped" as const)
            : ("accepted" as const);
        },
      };
    },

    /** Host-only broker seam for later privileged phases and stop revocation. */
    approvals,

    /** Projector assertion: preflight, rather than projection, owns grants. */
    prepare(snapshot: SubagentRunSnapshotV1): void {
      if (input.store.selection === "v2" && !authorities.has(snapshot.runId)) {
        throw new Error(
          "Foreground subagent authority was not resolved before projection.",
        );
      }
      if (input.store.selection !== "v2" || !input.control) return;
      const prepared = preparedRuns.get(snapshot.runId);
      if (!prepared || prepared.controlRegistered) {
        throw new Error(
          "Foreground subagent control preparation is unavailable.",
        );
      }
      const canonical = canonicalSnapshot(snapshot);
      input.control.register({
        snapshot: canonical,
        ownerDocumentId: input.ownerDocumentId,
        revokeApprovals: () => {
          revokeAuthority(snapshot.runId);
          approvals.cancelRun(snapshot.runId);
        },
        stop: (reason) => prepared.stop(reason),
        settle: async () => {
          if (!input.settleControlSnapshots) {
            throw new Error("Subagent control durability is unavailable.");
          }
          await input.settleControlSnapshots();
        },
        ...(input.currentControlSnapshot
          ? {
              currentSnapshot: () =>
                canonicalSnapshot(
                  input.currentControlSnapshot!(snapshot.runId),
                ),
            }
          : {}),
        onSnapshot: (controlSnapshot) => {
          if (controlSnapshot.state !== "stopped") return;
          if (!input.applyControlSnapshot || !input.settleControlSnapshots) {
            throw new Error("Subagent control projection is unavailable.");
          }
          const projected = input.applyControlSnapshot(controlSnapshot);
          void input.settleControlSnapshots().then(
            () => input.onControlSnapshot?.(projected),
            () => undefined,
          );
        },
      });
      prepared.controlRegistered = true;
    },

    async upsert(snapshot: SubagentRunSnapshotV1): Promise<void> {
      if (input.store.selection === "v1") {
        await input.store.upsert(snapshot);
        return;
      }
      const canonical = canonicalSnapshot(snapshot);
      await input.store.upsert(canonical, manifestFor(canonical));
      const prepared = preparedRuns.get(snapshot.runId);
      if (prepared?.controlRegistered && snapshot.revision > 1) {
        input.control?.update(snapshot.runId, canonical);
      }
    },

    rendererSnapshot(snapshot: SubagentRunSnapshotV1): SubagentRunSnapshot {
      return input.store.selection === "v2"
        ? canonicalSnapshot(snapshot)
        : structuredClone(snapshot);
    },

    /**
     * Synchronously sanitize a private control transition for renderer use and
     * enqueue its canonical write. Call `flushControlPersistence` before an IPC
     * action acknowledges that transition.
     */
    projectControlSnapshot(
      snapshot: SubagentRunSnapshotV2,
    ): SubagentRunSnapshotV1 {
      if (input.store.selection !== "v2") {
        throw new Error("V2 subagent control is unavailable during rollback.");
      }
      const canonical = parseSubagentRunSnapshotV2(snapshot);
      if (!canonical) throw new Error("Invalid subagent control snapshot.");
      const projected = adaptSubagentRunSnapshotV2ToV1(canonical);
      if (!projected) {
        throw new Error(
          "Subagent control snapshot could not be projected safely.",
        );
      }
      enqueueControlPersistence(canonical, manifestFor(canonical));
      return projected;
    },

    async flushControlPersistence(): Promise<void> {
      await controlPersistenceTail;
      if (controlPersistenceError) throw controlPersistenceError;
    },
  };
}

export type ForegroundSubagentPersistenceV2 = ReturnType<
  typeof createForegroundSubagentPersistenceV2
>;
