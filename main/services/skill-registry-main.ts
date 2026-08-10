import { configStore } from "./config-store.js";
import { discoverSkillCandidates, invalidateSkillDiscoveryCache } from "./skills-discovery.js";
import { SkillRegistry } from "./skill-registry.js";

/** Process-owned registry. Its invocation key is generated once and never leaves main. */
export const skillRegistry = new SkillRegistry({
  getWorkspace: (id) => configStore.getWorkspace(id),
  listConfigured: () => configStore.listSkills(),
  discover: (workspaceRoot) => discoverSkillCandidates(workspaceRoot),
  onInvalidate: invalidateSkillDiscoveryCache,
});
