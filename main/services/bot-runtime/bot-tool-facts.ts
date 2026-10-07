// The facts the Bot tool policy reads, joined exactly as the legacy Bot
// generation joined them: MCP tools through `exactBotMcpToolNames`, skills
// through `exactBotSkillToolNames` plus a revalidation before the skill
// instructions are used. Each join runs at most once per facts object and is
// skipped when the authority grants nothing of that kind.

import type { BotCatalogConnectionResource, BotCatalogSkillResource } from "../bot-capability-catalog-core.js";
import type { BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import type { BotRuntimeResolvedSkill } from "../bot-skill-inventory.js";
import { exactBotMcpToolNames, exactBotSkillToolNames, filterBotSkillSnapshot } from "../bot-tool-authority.js";
import { mcpAgentToolName } from "../mcp-tool-identity.js";
import type { SkillRegistrySnapshot } from "../skill-registry.js";
import type { BotAdmission } from "./bot-tool-assembly.js";
import type { BotToolFacts } from "./bot-tool-policy.js";

export interface BotToolFactsWithSkills extends BotToolFacts {
  /** The Bot-filtered skill snapshot, or `undefined` when no skill is granted. */
  skillSnapshot(): Promise<SkillRegistrySnapshot | undefined>;
}

export interface BotToolFactsInput {
  admission: BotAdmission;
  supportsImages: boolean;
  fileLocations: number;
  /** A fresh catalog snapshot (connections and skills) for this Bot. */
  catalog(): Promise<{
    connections: readonly BotCatalogConnectionResource[];
    skills: readonly BotCatalogSkillResource[];
  }>;
  /** Configured MCP servers, for model-facing tool names. */
  mcpServers(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  /** The skill registry snapshot for the Bot folder and the Bot's resolved skill bindings. */
  skills(): Promise<{ snapshot: SkillRegistrySnapshot; resolved: readonly BotRuntimeResolvedSkill[] }>;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

export function createBotToolFacts(input: BotToolFactsInput): BotToolFactsWithSkills {
  const { admission } = input;
  const authority = admission.authority;
  const catalog = once(input.catalog);
  const mcpTools = once(async (): Promise<ReadonlyMap<string, BotRuntimeMcpToolAuthority>> => {
    if (authority.connections.length === 0) return new Map();
    const [current, servers] = await Promise.all([catalog(), input.mcpServers()]);
    return exactBotMcpToolNames(authority, current.connections, (sourceId, toolName) => {
      const server = servers.find(({ id }) => id === sourceId);
      if (!server) throw new Error("A selected Bot connection is no longer configured.");
      return mcpAgentToolName(server, toolName);
    });
  });
  const skills = once(async () => {
    if (authority.skills.length === 0) return { names: new Set<string>() as ReadonlySet<string>, snapshot: undefined };
    const [current, runtime] = await Promise.all([catalog(), input.skills()]);
    const names = exactBotSkillToolNames(authority, current.skills, runtime.resolved, runtime.snapshot);
    // Prove the captured instructions still match the admitted catalog before
    // either the prompt or a tool schema can expose them.
    await admission.revalidateBeforeEffect();
    return { names, snapshot: filterBotSkillSnapshot(runtime.snapshot, names, admission) };
  });
  return {
    authority,
    supportsImages: input.supportsImages,
    fileLocations: input.fileLocations,
    mcpTools,
    skillToolNames: async () => (await skills()).names,
    skillSnapshot: async () => (await skills()).snapshot,
  };
}
