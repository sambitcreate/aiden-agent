import { configStore } from "./config-store.js";
import { discoverSkillCandidates, invalidateSkillDiscoveryCache } from "./skills-discovery.js";
import { SkillRegistry } from "./skill-registry.js";
import { AIDEN_APP_SKILL } from "./aiden-app-knowledge.js";
import { AIDEN_ARTIFACTS_SKILL, AIDEN_ARTIFACTS_SKILL_ID } from "./workspace-artifacts/skill.js";
import { AIDEN_HOOKS_SKILL, AIDEN_HOOKS_SKILL_ID } from "./hooks-skill.js";
import { AIDEN_DESIGN_SKILL, AIDEN_DESIGN_SKILL_ID } from "./design-canvas/skill.js";
import { designModeEnabled } from "./studio/feature-flags.js";

/** Process-owned registry. Its invocation key is generated once and never leaves main. */
export const skillRegistry = new SkillRegistry({
  listBuiltin: async () => [
    { ...AIDEN_APP_SKILL, stableId: "builtin:aiden-app", source: "builtin", enabled: true },
    { ...AIDEN_ARTIFACTS_SKILL, stableId: AIDEN_ARTIFACTS_SKILL_ID, source: "builtin", enabled: true },
    { ...AIDEN_HOOKS_SKILL, stableId: AIDEN_HOOKS_SKILL_ID, source: "builtin", enabled: true },
    // Behind the design mode flag until it launches.
    ...(designModeEnabled()
      ? [{ ...AIDEN_DESIGN_SKILL, stableId: AIDEN_DESIGN_SKILL_ID, source: "builtin" as const, enabled: true }]
      : []),
  ],
  isEnabled: async () => (await configStore.getSettings()).skillsEnabled !== false,
  getWorkspace: (id) => configStore.getWorkspace(id),
  listConfigured: () => configStore.listSkills(),
  discover: (workspaceRoot) => discoverSkillCandidates(workspaceRoot),
  onInvalidate: invalidateSkillDiscoveryCache,
});
