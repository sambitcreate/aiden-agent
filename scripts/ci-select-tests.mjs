import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectChangedAreas } from "./ci-changes.mjs";
import { discoverSpecs } from "./ci-e2e-shards.mjs";
import { writeJson } from "./ci-e2e-timings.mjs";
import { selectReachableTests } from "./ci-related-tests.mjs";
import { PROJECT_ROOT, readRegistry } from "./ci-test-registry.mjs";

export function buildTestSelection(options = {}) {
  const detection = options.detection ?? detectChangedAreas(options);
  const eventName = options.eventName ?? options.env?.GITHUB_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "push";
  const registry = options.registry ?? readRegistry();
  const testFiles = (registry.lanes ?? []).flatMap((lane) => lane.files ?? []);
  const selection = selectReachableTests({
    eventName,
    changedPaths: detection.changedPaths ?? options.changedPaths ?? [],
    testFiles,
    specs: options.specs ?? discoverSpecs(),
    sourceFiles: options.sourceFiles,
    readFile: options.readFile,
    map: options.map,
  });
  if (selection.unit.mode === "all" && selection.e2e.mode === "all" && selection.reason === "related") {
    selection.reason = selection.unit.reason === "infrastructure" || selection.e2e.reason === "infrastructure"
      ? "infrastructure"
      : selection.unit.reason;
  }
  return {
    ...selection,
    changedCount: detection.changedCount ?? (detection.changedPaths ?? []).length,
    decisionReason: detection.reason,
  };
}

function main() {
  const selection = buildTestSelection();
  const outputPath = process.env.AIDEN_CI_TEST_SELECTION_OUT ?? path.join(PROJECT_ROOT, "ci-test-selection.json");
  writeJson(outputPath, selection);
  const summary =
    selection.unit.mode === "related" || selection.e2e.mode === "related"
      ? `CI test selection: ${selection.unit.mode === "related" ? selection.unit.files.length : "all"} unit files, ${selection.e2e.mode === "related" ? selection.e2e.specs.length : "all"} E2E specs (${selection.reason}).`
      : `CI test selection: full suites (${selection.reason}).`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `selection_reason=${selection.reason}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  process.stdout.write(`${summary}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
