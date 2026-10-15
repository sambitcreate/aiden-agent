// The facts the Bot tool policy reads, joined exactly as the legacy Bot
// generation joined them: MCP tools through `exactBotMcpToolNames`, skills
// through `exactBotSkillToolNames` plus a revalidation before the skill
// instructions are used. Each join runs at most once per facts object and is
// skipped when the authority grants nothing of that kind.

import type { BotCatalogConnectionResource, BotCatalogSkillResource } from "../bot-capability-catalog-core.js";
import type { BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import type { BotRuntimeResolvedSkill } from "../bot-skill-inventory.js";
import {
  botMcpLiveToolMatchesGrant,
  exactBotMcpToolNames,
  exactBotSkillToolNames,
  filterBotSkillSnapshot,
} from "../bot-tool-authority.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
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
  /**
   * The MCP tools last built for this Bot's connections. Grants are joined to
   * them by MCP identity, so their real model-facing names are what is granted.
   */
  mcpTools(): Promise<readonly { readonly name: string }[]>;
  /**
   * The live, executable tools/list entries of the granted servers, keyed by
   * model-facing tool name. The catalog above may be a cached or grace-window
   * scope; only a tool whose live entry still carries its grant's exact
   * schema and effect facts is admitted.
   */
  liveMcpTools(): Promise<ReadonlyMap<string, SubagentMcpRemoteTool>>;
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
    const [current, built] = await Promise.all([catalog(), input.mcpTools()]);
    const granted = exactBotMcpToolNames(authority, current.connections, built);
    // A changed live tool (for example read-only turned mutating) is not the
    // granted tool, so it is neither offered nor dispatched under the old effect.
    const live = await input.liveMcpTools();
    return new Map([...granted].filter(([name, grant]) => botMcpLiveToolMatchesGrant(grant, live.get(name))));
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
