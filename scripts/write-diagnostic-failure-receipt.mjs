import { sanitizeTestDetails } from "./safe-test-reporter.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ALLOWED_STAGES = new Set(["desktop-tests", "electron-e2e", "ios-compile", "android-tests", "release"]);
const ALLOWED_CODES = new Set(["test-failed", "build-failed", "timed-out", "cancelled", "unknown"]);

const args = process.argv.slice(2);
const [output, stage, code, detailsArg] = args;
if (
  args.length !== 4 ||
  !output ||
  !ALLOWED_STAGES.has(stage) ||
  !ALLOWED_CODES.has(code) ||
  !detailsArg ||
  (detailsArg.startsWith("-") && detailsArg !== "--no-details")
) {
  throw new Error(
    "Usage: write-diagnostic-failure-receipt.mjs <output> <allowed-stage> <allowed-code> (<details-file>|--no-details)",
  );
}

let details = [];
if (detailsArg !== "--no-details") {
  try { if (fs.statSync(detailsArg).size <= 65536) details = sanitizeTestDetails(JSON.parse(fs.readFileSync(detailsArg, "utf8"))); } catch { /* Setup may fail before reporter starts. */ }
}
const identity = {};
if (/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")) identity.commit = process.env.GITHUB_SHA;
if (/^\d{1,20}$/.test(process.env.GITHUB_RUN_ID ?? "")) identity.runId = process.env.GITHUB_RUN_ID;
if (/^\d{1,6}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) identity.runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const receipt = {
  version: 2,
  identity,
  tests: details,
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
