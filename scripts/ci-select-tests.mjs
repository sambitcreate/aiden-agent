import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectChangedAreas } from "./ci-changes.mjs";
import { E2E_SHARD_COUNT, discoverSpecs } from "./ci-e2e-shards.mjs";
import { writeJson } from "./ci-e2e-timings.mjs";
import { planMacE2E, readE2ESpecMap, selectReachableTests } from "./ci-related-tests.mjs";
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
  const macE2E = planMacE2E({
    eventName,
    desktop: detection.desktop === true,
    e2e: selection.e2e,
    map: options.map ?? readE2ESpecMap(),
    shardCount: E2E_SHARD_COUNT,
  });
  return {
    ...selection,
    macE2E,
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
    // A skipped job still parses its matrix, so an unused plan keeps one shard.
    const shards = selection.macE2E.shards.length > 0 ? selection.macE2E.shards : [1];
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `selection_reason=${selection.reason}\nmac_e2e=${selection.macE2E.run ? "true" : "false"}\nmac_e2e_shards=${JSON.stringify(shards)}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  const macSummary = selection.macE2E.scope === "macos"
    ? `macOS E2E: ${selection.macE2E.specs.length} macOS-only specs on one runner; Linux runs the rest.`
    : selection.macE2E.scope === "all"
      ? `macOS E2E: full suite on ${selection.macE2E.shards.length} runners.`
      : "macOS E2E: none selected; Linux runs the selected specs.";
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${macSummary}\n`);
  }
  process.stdout.write(`${summary}\n${macSummary}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
