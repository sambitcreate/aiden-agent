// A real process that stops inside the consent lock, between its read and its write.
// Usage: analytics-hold-consent.mjs <agentDir> <installId> <file to create once inside> <file that lets it finish>
import { existsSync, writeFileSync } from "node:fs";

const [agentDir, installId, entered, resume] = process.argv.slice(2);
const api = await import("../../dist/parity-test-api.js");
const pause = new Int32Array(new SharedArrayBuffer(4));

api.updateServerAnalyticsState(agentDir, (state) => {
  writeFileSync(entered, "");
  while (!existsSync(resume)) Atomics.wait(pause, 0, 0, 10);
  return { ...state, installId };
});
