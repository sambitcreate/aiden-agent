import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotOrdinaryCapabilityKind } from "./bot-capability-catalog-core.js";
import type {
  BotRuntimeAuthorityAdmission,
  BotRuntimeEffectiveAuthority,
  BotRuntimeFileScopeAuthority,
  BotRuntimeMcpToolAuthority,
  BotRuntimeSkillAuthority,
} from "./bot-runtime-authority.js";
import type { BotMcpConnectionIdentity } from "./bot-mcp-inventory.js";
import type { SkillRegistrySnapshot } from "./skill-registry.js";
import type {
  BotCatalogConnectionResource,
  BotCatalogSkillResource,
} from "./bot-capability-catalog-core.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import type { BotRuntimeResolvedSkill } from "./bot-skill-inventory.js";
import type { SubagentMcpScopeV2 } from "./subagents/authority-v2.js";
import { createHash } from "node:crypto";

export type BotFileOperation = "read" | "write";

export type BotToolAdmissionPort = Pick<
  BotRuntimeAuthorityAdmission,
  "authority" | "signal" | "revalidateBeforeEffect" | "release"
>;

export type BotToolCapability =
  | {
      kind: "file";
      operation: BotFileOperation;
      scope:
        | { kind: "bot_home"; workspaceId: string }
        | ({ kind: "full_mac" | "approved_location" } & BotRuntimeFileScopeAuthority);
    }
  | {
      kind: "shell";
      workingDirectory: string;
      shellFingerprint: string;
      shellExactFingerprint: string;
    }
  | ({ kind: "mcp"; connectionSourceId: string } & BotRuntimeMcpToolAuthority & {
        connectionFingerprint: string;
        connectionExactFingerprint: string;
      })
  | ({ kind: "skill" } & BotRuntimeSkillAuthority)
  | {
      kind: "other";
      ordinaryKind: BotOrdinaryCapabilityKind;
      capabilityFingerprint: string;
      exactFingerprint: string;
    };

export interface BotToolCandidate {
  tool: AgentTool;
  /** False means ordinary Aiden would not expose this tool right now. */
  available: boolean;
  capability: BotToolCapability;
  /** Optional transport/config incarnation check local to this tool. */
  revalidateResource?: () => void | Promise<void>;
}

function exactFileGrant(
  authority: Readonly<BotRuntimeEffectiveAuthority>,
  capability: Extract<BotToolCapability, { kind: "file" }>,
): boolean {
  const { scope } = capability;
  if (scope.kind === "bot_home") {
    return authority.files.botHome && scope.workspaceId === authority.managedHome.workspaceId;
  }
  const candidates =
    scope.kind === "full_mac"
      ? authority.files.fullMac
        ? [authority.files.fullMac]
        : []
      : authority.files.approvedLocations;
  return candidates.some(
    (grant) =>
      grant.sourceId === scope.sourceId &&
      grant.scopeFingerprint === scope.scopeFingerprint &&
      grant.exactFingerprint === scope.exactFingerprint,
  );
}

/** Exact positive match. Unknown, newly discovered, or changed resources fail closed. */
export function botToolCapabilityAllowed(
  authority: Readonly<BotRuntimeEffectiveAuthority>,
  capability: BotToolCapability,
): boolean {
  if (authority.accessMode === "full") return true;
  switch (capability.kind) {
    case "file":
      return exactFileGrant(authority, capability);
    case "shell":
      return Boolean(
        authority.shell.enabled &&
          authority.workingDirectory === capability.workingDirectory &&
          authority.shell.shellFingerprint === capability.shellFingerprint &&
          authority.shell.exactFingerprint === capability.shellExactFingerprint,
      );
    case "mcp": {
      const connection = authority.connections.find(
        (grant) =>
          grant.sourceId === capability.connectionSourceId &&
          grant.connectionFingerprint === capability.connectionFingerprint &&
          grant.exactFingerprint === capability.connectionExactFingerprint,
      );
      return Boolean(
        connection?.tools.some(
          (tool) =>
            tool.toolId === capability.toolId &&
            tool.name === capability.name &&
            tool.inputSchemaFingerprint === capability.inputSchemaFingerprint &&
            tool.outputSchemaFingerprint === capability.outputSchemaFingerprint &&
            tool.effect === capability.effect &&
            tool.effectFingerprint === capability.effectFingerprint &&
            tool.exactFingerprint === capability.exactFingerprint,
        ),
      );
    }
    case "skill":
      return authority.skills.some(
        (skill) =>
          skill.sourceId === capability.sourceId &&
          skill.identityFingerprint === capability.identityFingerprint &&
          skill.contentFingerprint === capability.contentFingerprint &&
          skill.exactFingerprint === capability.exactFingerprint,
      );
    case "other":
      return authority.otherCapabilities.some(
        (grant) =>
          grant.kind === capability.ordinaryKind &&
          grant.capabilityFingerprint === capability.capabilityFingerprint &&
          grant.exactFingerprint === capability.exactFingerprint,
      );
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Bot access changed while this tool was active.");
}

function wrapBotTool(candidate: BotToolCandidate, admission: BotToolAdmissionPort): AgentTool {
  const execute = candidate.tool.execute.bind(candidate.tool);
  return {
    ...candidate.tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (admission.signal.aborted) throw abortReason(admission.signal);
      await candidate.revalidateResource?.();
      // This must remain the final await-free check before entering the tool's
      // effect implementation. The resolver checks live policy, catalog, and
      // managed-home identity here, not just a generation-time snapshot.
      await admission.revalidateBeforeEffect();
      if (admission.signal.aborted) throw abortReason(admission.signal);
      const effectSignal = signal
        ? AbortSignal.any([signal, admission.signal])
        : admission.signal;
      return execute(toolCallId, params, effectSignal, onUpdate);
    },
  };
}

/**
 * Protect a tool that a main-owned assembler has already positively classified.
 * Unclassified tools must never call this helper merely to bypass capability
 * matching; the caller owns that positive classification.
 */
export function protectAdmittedBotTool(
  tool: AgentTool,
  admission: BotToolAdmissionPort,
  revalidateResource?: () => void | Promise<void>,
): AgentTool {
  return wrapBotTool(
    {
      tool,
      available: true,
      capability: {
        kind: "file",
        operation: "read",
        scope: {
          kind: "bot_home",
          workspaceId: admission.authority.managedHome.workspaceId,
        },
      },
      ...(revalidateResource ? { revalidateResource } : {}),
    },
    admission,
  );
}

/**
 * Filter before the returned objects are passed to the model. Therefore a
 * denied tool disappears from schema and prompt discovery as well as dispatch.
 * Ordinary (non-Bot) generations pass no admission and retain existing behavior.
 */
export function filterBotAgentTools(
  candidates: readonly BotToolCandidate[],
  admission?: BotToolAdmissionPort,
): AgentTool[] {
  if (!admission) return candidates.map(({ tool }) => tool);
  return candidates
    .filter(
      (candidate) =>
        candidate.available &&
        botToolCapabilityAllowed(admission.authority, candidate.capability),
    )
    .map((candidate) => wrapBotTool(candidate, admission));
}

/**
 * Keep prompt disclosure, Pi resources, and explicit slash-command resolution
 * on the exact same selected skill set as the published skill tool schemas.
 */
export function filterBotSkillSnapshot(
  snapshot: SkillRegistrySnapshot,
  allowedSkillToolNames: ReadonlySet<string>,
  admission?: BotToolAdmissionPort,
): SkillRegistrySnapshot {
  if (!admission) return snapshot;
  const skills = snapshot.skills.filter((skill) => allowedSkillToolNames.has(skill.toolKey));
  const invocationIds = new Set(skills.map(({ invocationId }) => invocationId));
  const available = snapshot.available.filter(
    (skill) =>
      invocationIds.has(skill.invocationId) && allowedSkillToolNames.has(skill.toolKey),
  );
  const catalog = snapshot.catalog.filter(({ invocationId }) => invocationIds.has(invocationId));
  return Object.freeze({
    ...snapshot,
    catalog: Object.freeze(catalog),
    skills: Object.freeze(skills),
    available: Object.freeze(available),
  });
}

export function assertBotSkillInvocationAllowed(
  skillToolName: string,
  allowedSkillToolNames: ReadonlySet<string>,
  admission?: BotToolAdmissionPort,
): void {
  if (admission && !allowedSkillToolNames.has(skillToolName)) {
    throw new Error("This skill is not enabled for this Bot chat.");
  }
}

function plainDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sameExactMcpTool(
  grant: BotRuntimeMcpToolAuthority,
  current: BotCatalogConnectionResource["tools"][number],
): boolean {
  return (
    grant.toolId === current.exactFingerprint &&
    grant.name === current.name &&
    grant.inputSchemaFingerprint === current.inputSchemaFingerprint &&
    grant.outputSchemaFingerprint === current.outputSchemaFingerprint &&
    grant.effect === current.effect &&
    grant.effectFingerprint === current.effectFingerprint &&
    grant.exactFingerprint === current.exactFingerprint
  );
}

/** Positive main-agent MCP join against a fresh exact catalog snapshot. */
export function exactBotMcpToolNames(
  authority: Pick<BotRuntimeEffectiveAuthority, "connections">,
  currentConnections: readonly BotCatalogConnectionResource[],
  modelToolName: (connectionSourceId: string, toolName: string) => string,
): ReadonlyMap<string, BotRuntimeMcpToolAuthority> {
  const result = new Map<string, BotRuntimeMcpToolAuthority>();
  for (const connection of authority.connections) {
    const current = currentConnections.find(
      (candidate) =>
        candidate.option.available &&
        candidate.sourceId === connection.sourceId &&
        candidate.connectionFingerprint === connection.connectionFingerprint &&
        candidate.toolsetFingerprint === connection.toolsetFingerprint &&
        candidate.exactFingerprint === connection.exactFingerprint,
    );
    if (!current) throw new Error("A selected Bot connection changed while this response was starting.");
    for (const grant of connection.tools) {
      const liveTool = current.tools.find((candidate) => sameExactMcpTool(grant, candidate));
      if (!liveTool) throw new Error("A selected Bot connection tool changed while this response was starting.");
      const name = modelToolName(connection.sourceId, liveTool.name);
      if (result.has(name)) throw new Error("Selected Bot connection tool names overlap.");
      result.set(name, grant);
    }
  }
  return result;
}

/**
 * Narrow the child MCP lane through a fresh durable Bot identity and every
 * exact tool fact. The returned scope intentionally retains its process-owned
 * fingerprint for the child's execution-time credential fences; its schema
 * hash canonically covers both MCP input and output schemas.
 */
export function filterExactBotSubagentMcpInventory(
  authority: Pick<BotRuntimeEffectiveAuthority, "connections">,
  inventory: readonly SubagentMcpScopeV2[],
  identities: readonly BotMcpConnectionIdentity[],
): SubagentMcpScopeV2[] {
  const outputSchemaFingerprint = plainDigest({ outputSchema: "not_declared" });
  return inventory.flatMap((scope) => {
    const identity = identities.find((candidate) => candidate.serverId === scope.serverId);
    if (!identity) return [];
    const connection = authority.connections.find(
      (grant) =>
        grant.sourceId === scope.serverId &&
        grant.connectionFingerprint === identity.connectionFingerprint,
    );
    if (!connection) return [];
    const tools = scope.tools.filter((tool) => {
      const effectFingerprint = tool.effect === "read"
        ? plainDigest({ effect: "read" })
        : tool.effectProfile.fingerprint;
      const exactFingerprint = botCapabilityFactsFingerprint({
        name: tool.toolName,
        inputSchemaFingerprint: tool.schemaHash,
        outputSchemaFingerprint,
        effect: tool.effect,
        effectFingerprint,
      });
      return connection.tools.some(
        (grant) =>
          grant.toolId === exactFingerprint &&
          grant.name === tool.toolName &&
          grant.inputSchemaFingerprint === tool.schemaHash &&
          grant.outputSchemaFingerprint === outputSchemaFingerprint &&
          grant.effect === tool.effect &&
          grant.effectFingerprint === effectFingerprint &&
          grant.exactFingerprint === exactFingerprint,
      );
    });
    return tools.length > 0 ? [{ ...scope, tools }] : [];
  });
}

/** Exact fresh-catalog + runtime-registry join for model-facing skills. */
export function exactBotSkillToolNames(
  authority: Pick<BotRuntimeEffectiveAuthority, "skills">,
  currentSkills: readonly BotCatalogSkillResource[],
  runtimeSkills: readonly BotRuntimeResolvedSkill[],
  snapshot: SkillRegistrySnapshot,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const grant of authority.skills) {
    const current = currentSkills.find(
      (candidate) =>
        candidate.option.available &&
        candidate.sourceId === grant.sourceId &&
        candidate.identityFingerprint === grant.identityFingerprint &&
        candidate.contentFingerprint === grant.contentFingerprint &&
        candidate.exactFingerprint === grant.exactFingerprint,
    );
    const runtime = runtimeSkills.find(
      (candidate) => candidate.available && candidate.sourceId === grant.sourceId,
    );
    if (!current || !runtime) {
      throw new Error("A selected Bot skill changed or is unavailable.");
    }
    const registered = snapshot.available.find(
      (candidate) => candidate.stableId === runtime.runtimeStableId,
    );
    if (
      !registered ||
      runtime.label !== registered.name ||
      runtime.description !== registered.description ||
      runtime.instructions !== registered.instructions
    ) {
      throw new Error("A selected Bot skill changed while this response was starting.");
    }
    if (result.has(registered.toolKey)) {
      throw new Error("Selected Bot skill tool names overlap.");
    }
    result.add(registered.toolKey);
  }
  return result;
}
