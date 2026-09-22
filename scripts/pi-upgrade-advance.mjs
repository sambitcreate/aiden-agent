/* global process */
import path from "node:path";
import {
  installedApplicationIdentity,
  PI_UPGRADE_ROLLOUT_STAGES,
  PiUpgradeRolloutStore,
} from "../main/services/pi-upgrade-rollout.ts";

const root = process.env.AIDEN_PI_UPGRADE_RECEIPT_DIR;
const executable = process.env.AIDEN_PI_UPGRADE_EXECUTABLE;
const target = process.argv[2];
if (!root || !path.isAbsolute(root) || !executable || !path.isAbsolute(executable)) {
  throw new Error("Absolute AIDEN_PI_UPGRADE_RECEIPT_DIR and AIDEN_PI_UPGRADE_EXECUTABLE are required.");
}
if (!PI_UPGRADE_ROLLOUT_STAGES.includes(target)) throw new Error("A valid next rollout stage is required.");

const store = new PiUpgradeRolloutStore({
  root: () => root,
  initialStage: "internal_fixtures",
  installedIdentity: () => installedApplicationIdentity(executable, process.env.AIDEN_BUILD_ID),
});
const policy = await store.advance(target);
process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
