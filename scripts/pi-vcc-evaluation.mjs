/* global process */
import { runVccReplayCases } from "../main/services/pi-upgrade-replay-runner.ts";
const report = await runVccReplayCases();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
