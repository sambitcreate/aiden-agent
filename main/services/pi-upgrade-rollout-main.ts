import { ensureUserDataDir } from "./data-store.js";
import { isDevelopmentRuntime } from "../runtime-mode-core.js";
import { installedApplicationIdentity, PiUpgradeRolloutStore } from "./pi-upgrade-rollout.js";

const development = isDevelopmentRuntime(process.env, Boolean(process.versions.electron));

const installedIdentity = () => installedApplicationIdentity(process.execPath, process.env.AIDEN_BUILD_ID);

export const piUpgradeRolloutStore = new PiUpgradeRolloutStore({
  root: () => ensureUserDataDir("pi-upgrade-rollout"),
  initialStage: development ? "developer_installs" : "new_chats",
  installedIdentity,
});
