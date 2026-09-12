/* global process */
import path from "node:path";
import { runPiUpgradeReplayCases } from "../main/services/pi-upgrade-replay-runner.ts";
import {
  installedApplicationIdentity,
  writePiUpgradeEvaluationReceipt,
} from "../main/services/pi-upgrade-rollout.ts";

const receiptRoot = process.env.AIDEN_PI_UPGRADE_RECEIPT_DIR;
const executable = process.env.AIDEN_PI_UPGRADE_EXECUTABLE;
if (!receiptRoot || !path.isAbsolute(receiptRoot)) {
  throw new Error("AIDEN_PI_UPGRADE_RECEIPT_DIR must be an absolute device-local directory.");
}
if (!executable || !path.isAbsolute(executable)) {
  throw new Error("AIDEN_PI_UPGRADE_EXECUTABLE must be the absolute installed candidate executable.");
}

const measurements = await runPiUpgradeReplayCases();
const identity = await installedApplicationIdentity(executable, process.env.AIDEN_BUILD_ID);
const receipt = await writePiUpgradeEvaluationReceipt(receiptRoot, measurements, identity);
process.stdout.write(`${JSON.stringify({
  receipt: path.join(receiptRoot, "pi-upgrade-evaluation-v1.json"),
  generatedAt: receipt.generatedAt,
  report: receipt.report,
}, null, 2)}\n`);
