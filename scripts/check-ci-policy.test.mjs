import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { parse } from "yaml";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REQUIRED_JOB_RULES } from "./ci-required.mjs";
import { readRegistry } from "./ci-test-registry.mjs";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const catalogWorkflowUrl = new URL(
  "../.github/workflows/model-catalog-refresh.yml",
  import.meta.url,
);
const pullfrogWorkflowUrl = new URL(
  "../.github/workflows/pullfrog.yml",
  import.meta.url,
);

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

test("CI assigns platform work conservatively and exposes one complete required result", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const { jobs } = parse(workflow);
  assert.deepEqual(jobs.required.needs.toSorted(), Object.keys(REQUIRED_JOB_RULES).toSorted());
  assert.equal(jobs.required.name, "CI required");
  assert.equal(jobs.required.if, "${{ always() }}");
  const gate = jobs.required.steps.find((step) => step.run === "node scripts/ci-required.mjs");
  assert.equal(gate.env.CI_NEEDS_JSON, "${{ toJSON(needs) }}");
  assert.equal(gate.env.CI_CHANGES_JSON, "${{ toJSON(needs.changes.outputs) }}");
  for (const [name, rule] of Object.entries(REQUIRED_JOB_RULES)) {
    assert.ok(jobs[name], name);
    if (rule.area) {
      assert.equal(jobs[name].needs, "changes", name);
      assert.equal(jobs[name].if, `\${{ needs.changes.outputs.${rule.area} == 'true' }}`, name);
    } else {
      assert.equal(jobs[name].if, undefined, name);
    }
  }
  const filter = jobs.changes.steps.find((step) => step.id === "filter");
  assert.equal(filter.run, "node scripts/ci-changes.mjs");
  assert.equal(filter.env.FORCE_FULL, "${{ github.event_name == 'push' && 'true' || 'false' }}");
  assert.equal(jobs.changes.steps[0].with["fetch-depth"], 0);
});

test("Android keeps validation and publishes installable artifacts only on main", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  const sdkSetup = workflowStep(workflow, "Set up Android SDK tools");
  assert.match(sdkSetup, /^ {10}packages: platform-tools$/mu);

  const mainPushOnly =
    /if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/u;
  assert.doesNotMatch(workflowStep(workflow, "Verify Android"), /:app:assembleDebug/u);

  const assembly = workflowStep(workflow, "Assemble installable debug APK");
  assert.match(assembly, mainPushOnly);
  assert.match(assembly, /:app:assembleDebug/u);
  assert.match(workflowStep(workflow, "Record APK checksum"), mainPushOnly);
  assert.match(workflowStep(workflow, "Upload installable debug APK"), mainPushOnly);
});

test("desktop E2E and unit work are sharded with independent Apple and iOS checks", async () => {
  const { jobs } = parse(await readFile(workflowUrl, "utf8"));
  assert.deepEqual(jobs.e2e.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(jobs.e2e.strategy["fail-fast"], false);
  assert.equal(jobs.unit.strategy["fail-fast"], false);
  assert.deepEqual(jobs.unit.strategy.matrix.lane, readRegistry().lanes.map((lane) => lane.name));
  const browserInstall = jobs.unit.steps.find((step) => step.run === "npx playwright install chromium");
  assert.equal(browserInstall.if, "${{ matrix.chromium == true }}");
  const registry = readRegistry();
  const browserModes = new Set(registry.preserved.filter((entry) => ["browser", "chromium"].includes(entry.kind)).map((entry) => entry.id));
  const browserLanes = registry.lanes.filter((lane) => lane.preserved.some((id) => browserModes.has(id))).map((lane) => lane.name);
  assert.deepEqual(jobs.unit.strategy.matrix.include.filter((entry) => entry.chromium).map((entry) => entry.lane).toSorted(), browserLanes.toSorted());
  const runner = jobs.unit.steps.find((step) => step.run?.includes("scripts/run-ci-tests.mjs"));
  assert.equal(runner.run, "node scripts/run-ci-tests.mjs --lane ${{ matrix.lane }} --summary");
  for (const lane of jobs.unit.strategy.matrix.lane) {
    const result = spawnSync(process.execPath, ["scripts/run-ci-tests.mjs", "--lane", lane, "--dry-run"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${lane}: ${result.stderr}`);
  }
  assert.ok(jobs.e2e.steps.some((step) => step.run === "node scripts/ci-e2e-shards.mjs ${{ matrix.shard }}/3"));
  const receipt = jobs.e2e.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(receipt.with.name.includes("${{ matrix.shard }}"));
  assert.ok(jobs.apple.steps.some((step) => step.run === "npm run test:native"));
  assert.ok(jobs.ios.steps.some((step) => step.run?.includes("xcodebuild build-for-testing")));
  assert.equal(jobs.verify.steps.filter((step) => step.run === "npm run build").length, 1);
  assert.ok(jobs.verify.steps.some((step) => step.run === "npm run test:e2e:diagnostics:production:run"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts["test:e2e:diagnostics:production:run"], /^AIDEN_E2E_RUNTIME_PROFILE=production playwright test tests\/e2e\/diagnostics-production\.spec\.ts /u);
  assert.match(manifest.scripts["test:e2e:diagnostics:production:run"], /--fail-on-flaky-tests/u);
  assert.ok(!manifest.scripts["test:e2e:diagnostics:production:run"].includes("npm run build"));
  assert.ok(!jobs.verify.steps.some((step) => step.run === "npm test"));
});


test("model catalog workflow verifies read-only and publishes with isolated credentials", async () => {
  const workflow = await readFile(catalogWorkflowUrl, "utf8");

  assert.match(workflow, /branches:\s*\n\s*- main/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/u);
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/u);
  assert.match(workflow, /group: model-catalog-refresh-main/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /GITHUB_ACTOR.*github-actions\[bot\]/u);
  assert.match(workflow, /chore: refresh models\.dev catalog/u);
  assert.match(workflow, /changed_paths.*git diff-tree/u);
  assert.match(workflow, /changed_paths.*resources\/model-capabilities\.json/u);
  assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
  assert.match(workflow, /node-version: 22\.22\.3/u);
  assert.match(workflow, /npm run models:refresh/u);
  assert.match(workflow, /npm run test:model-catalog/u);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.match(workflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  assert.match(workflow, /sha256sum --check model-capabilities\.json\.sha256/u);
  assert.match(workflow, /needs: refresh/u);
  assert.match(workflow, /PUBLISH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /git push.*HEAD:main/u);
});

test("Pullfrog allows aggregate release reviews to finish", async () => {
  const workflow = await readFile(pullfrogWorkflowUrl, "utf8");

  assert.match(workflow, /uses: pullfrog\/pullfrog@v0\.1\.57/u);
  assert.match(workflow, /^ {10}timeout: 2h$/mu);
});

test("coverage collection is enabled before positional test paths", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const command = manifest.scripts["test:coverage"].split(/\s+/u);
  const flag = command.indexOf("--experimental-test-coverage");
  const firstTest = command.findIndex((argument) => /\.test\.[cm]?[jt]sx?$/u.test(argument));
  assert.ok(flag > 0 && firstTest > flag, "Node coverage flags must precede test files");
});

test("CI keeps full main commits independent and portable static checks on Linux", async () => {
  const workflow = parse(await readFile(workflowUrl, "utf8"));
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.equal(workflow.concurrency.group, "ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}");
  assert.equal(workflow.jobs.static["runs-on"], "ubuntu-24.04");
  assert.ok(workflow.jobs.static.steps.some((step) => step.run?.includes("npm run type-check")));
  assert.ok(workflow.jobs.static.steps.some((step) => step.run === "npm run lint"));
  for (const [name, job] of Object.entries(workflow.jobs)) assert.ok(job["timeout-minutes"] > 0, name);
  assert.equal(workflow.jobs.timings["continue-on-error"], true);
  assert.equal(workflow.jobs.timings.permissions.actions, "read");
});

test("iOS-only PRs retain shipping and TestFlight policy checks when desktop lanes skip", async () => {
  const { jobs } = parse(await readFile(workflowUrl, "utf8"));
  const selection = "${{ needs.changes.outputs.desktop == 'false' }}";
  const steps = jobs.ios.steps;
  const install = steps.findIndex((step) => step.name === "Install iOS policy dependencies");
  const policies = steps.findIndex((step) => step.run === "npm run test:ios-release");
  const setup = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(setup >= 0 && setup < install && install < policies);
  for (const index of [setup, install, policies]) assert.equal(steps[index].if, selection);
  assert.equal(steps[install].run, "npm ci");
  const registry = readRegistry();
  assert.ok(registry.lanes.some((lane) => lane.preserved.includes("ios-release-policy")));
});
