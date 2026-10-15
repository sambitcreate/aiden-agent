import { configStore } from "./config-store.js";
import { discoverSkillCandidates, invalidateSkillDiscoveryCache } from "./skills-discovery.js";
import { SkillRegistry } from "./skill-registry.js";
import { AIDEN_APP_SKILL } from "./aiden-app-knowledge.js";

/** Process-owned registry. Its invocation key is generated once and never leaves main. */
export const skillRegistry = new SkillRegistry({
  listBuiltin: async () => [{ ...AIDEN_APP_SKILL, stableId: "builtin:aiden-app", source: "builtin", enabled: true }],
  isEnabled: async () => (await configStore.getSettings()).skillsEnabled !== false,
  getWorkspace: (id) => configStore.getWorkspace(id),
  listConfigured: () => configStore.listSkills(),
  discover: (workspaceRoot) => discoverSkillCandidates(workspaceRoot),
  onInvalidate: invalidateSkillDiscoveryCache,
});
