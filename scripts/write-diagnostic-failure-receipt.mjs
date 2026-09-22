import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ALLOWED_STAGES = new Set(["desktop-tests", "electron-e2e", "ios-compile", "android-tests", "release"]);
const ALLOWED_CODES = new Set(["test-failed", "build-failed", "timed-out", "cancelled", "unknown"]);

const [output, stage, code = "unknown"] = process.argv.slice(2);
if (!output || !ALLOWED_STAGES.has(stage) || !ALLOWED_CODES.has(code)) {
  throw new Error("Usage: write-diagnostic-failure-receipt.mjs <output> <allowed-stage> <allowed-code>");
}

const receipt = {
  version: 1,
  at: new Date().toISOString(),
  stage,
  outcome: "failed",
  code,
  omitted: [
    "test stdout and stderr",
    "screenshots and videos",
    "filesystem paths",
    "environment values and credentials",
    "application and user content",
  ],
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
