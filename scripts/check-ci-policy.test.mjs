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
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
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

test("both Linux package gates exercise the desktop Pi extensions", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.equal(workflow.match(/npm run test:pi-extensions/gu)?.length, 2);
});

test("Linux managed-payload contracts install the native SELinux build dependencies", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const releaseWorkflow = await readFile(releaseWorkflowUrl, "utf8");
  const linuxJob = workflow.match(/^ {2}linux:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  const rpmJob = workflow.match(/^ {2}linux-rpm:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  const releaseJob = releaseWorkflow.match(
    /^ {2}linux-release:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu,
  )?.[0];

  assert.ok(linuxJob && rpmJob && releaseJob);
  assert.match(linuxJob, /apt-get install --yes[^\n]*\blibselinux1-dev\b/u);
  assert.match(releaseJob, /apt-get install --yes[^\n]*\blibselinux1-dev\b/u);
  assert.match(rpmJob, /dnf install --assumeyes[^\n]*\blibselinux-devel\b/u);
  assert.match(rpmJob, /dnf install --assumeyes[^\n]*\bcargo\b/u);
  assert.match(rpmJob, /dnf install --assumeyes[^\n]*\brust\b/u);
});

test("Fedora installs the baseline-verified RPM instead of rebuilding native modules", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const linuxJob = workflow.match(/^ {2}linux:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  const rpmJob = workflow.match(/^ {2}linux-rpm:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];

  assert.ok(linuxJob, "Linux package job is missing");
  assert.ok(rpmJob, "Linux RPM job is missing");
  assert.match(rpmJob, /dnf install --assumeyes[^\n]*\bdbus-daemon\b/u,
    "Fedora native portal tests require dbus-run-session from dbus-daemon");
  assert.match(linuxJob, /sha256sum "\$rpm_name" > rpm\.sha256/u);
  const verifier = linuxJob.indexOf("node scripts/verify-linux-package.mjs");
  const upload = linuxJob.indexOf("Upload baseline-verified RPM for Fedora acceptance");
  assert.ok(
    verifier >= 0 && upload > verifier,
    "The baseline verifier must finish before the RPM is uploaded",
  );
  assert.match(
    linuxJob,
    /name: linux-rpm-x64-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  const uploadStep = linuxJob.match(
    /- name: Upload baseline-verified RPM for Fedora acceptance\n[\s\S]*?(?=\n {6}- name:|$)/u,
  )?.[0];
  assert.ok(uploadStep, "Baseline RPM upload step is missing");
  assert.match(uploadStep, /if: matrix\.arch == 'x64'/u);
  assert.match(uploadStep, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.match(rpmJob, /^ {4}needs: linux$/mu);
  assert.match(rpmJob, /actions\/download-artifact@95815c38cf2ff2164869cbab79da8d1f422bc89e/u);
  assert.match(
    rpmJob,
    /name: linux-rpm-x64-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(rpmJob, /sha256sum --check rpm\.sha256/u);
  assert.match(rpmJob, /test "\$\{#rpm_files\[@\]\}" -eq 1/u);
  assert.match(rpmJob, /aiden-agent \$expected_version x86_64/u);
  assert.match(rpmJob, /node scripts\/verify-linux-package\.mjs "\/opt\/Aiden Agent"/u);
  assert.doesNotMatch(rpmJob, /npx electron-builder|npm run dist:linux/u);
  assert.doesNotMatch(rpmJob, /^\s+npm run build\s*$/mu);
  assert.doesNotMatch(rpmJob, /\blibxcrypt-compat\b/u);
  assert.doesNotMatch(rpmJob, /\brpm-build\b/u);
});

test("Linux GUI smokes force teardown without masking startup failures", async () => {
  const workflows = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(releaseWorkflowUrl, "utf8"),
  ]);

  for (const workflow of workflows) {
    assert.equal(workflow.match(/timeout --signal=KILL 15s/gu)?.length, 1);
    assert.equal(workflow.match(/if \[\[ "\$status" -ne 137 \]\]/gu)?.length, 1);
    assert.match(
      workflow,
      /\(FATAL\|symbol lookup error\|error while loading shared libraries\|Failed to start Aiden Agent\)/u,
    );
    assert.doesNotMatch(workflow, /timeout --kill-after/u);
    assert.doesNotMatch(workflow, /if \[\[ "\$status" -ne 124 \]\]/u);
  }
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

function assertLinuxReleaseProvenance(workflow) {
  const linuxJob = workflow.match(/^ {2}linux-release:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  assert.ok(linuxJob, "Linux release job is missing");
  assert.match(linuxJob,
    /^ {4}if: \$\{\{ vars\.RELEASES_ENABLED == 'true' && github\.ref == 'refs\/heads\/main' \}\}$/mu,
    "Non-main dispatches must not bypass provenance by skipping attestation");
  const permissions = linuxJob.match(/^ {4}permissions:\n((?: {6}[^\n]+\n)+)/mu)?.[1];
  assert.ok(permissions, "Linux release must override inherited write permissions");
  assert.deepEqual(permissions.trim().split("\n").map(line => line.trim()).sort(),
    ["attestations: write", "contents: read", "id-token: write"]);

  const name = "Attest verified Linux packages and update feeds";
  const attestation = workflowStep(linuxJob, name);
  assert.match(attestation,
    /^ {8}uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6(?: # v4\.2\.2)?$/mu);
  assert.match(attestation,
    /^ {8}if: \$\{\{ github\.ref == 'refs\/heads\/main' && steps\.version\.outputs\.publish == 'true' \}\}$/mu);
  assert.match(attestation, /^ {10}create-storage-record: false$/mu);
  assert.match(attestation, /^ {10}push-to-registry: false$/mu);
  assert.doesNotMatch(attestation, /(?:predicate(?:-type|-path)?|sbom-path|subject-digest|subject-checksums):/u,
    "Automatic SLSA provenance must hash the verified files, not accept supplied predicates or digests");
  assert.doesNotMatch(attestation, /continue-on-error:/u);

  const expectedSubjects = [
    "release/linux-distribution/*.AppImage",
    "release/linux-distribution/*.deb",
    "release/linux-distribution/*.rpm",
    "release/linux-distribution/latest-linux*.yml",
  ];
  const subjects = attestation.match(/^ {10}subject-path: \|\n((?: {12}[^\n]+\n)+)/mu)?.[1];
  assert.ok(subjects, "Explicit attestation subjects are required");
  assert.deepEqual(subjects.trim().split("\n").map(line => line.trim()), expectedSubjects);
  const staging = workflowStep(linuxJob, "Stage verified Linux release assets");
  const staged = staging.match(/^ {10}path: \|\n((?: {12}[^\n]+\n)+)/mu)?.[1];
  assert.ok(staged);
  assert.deepEqual(staged.trim().split("\n").map(line => line.trim()), expectedSubjects,
    "Staged Linux assets must exactly match the attested subject classes");
  const attestationPosition = linuxJob.indexOf(`- name: ${name}`);
  for (const predecessor of [
    "Verify Linux contracts, diagnostics, and native helpers",
    "Build and verify Linux distributions",
    "Smoke the exact release GUI without a keyring session",
  ]) {
    const position = linuxJob.indexOf(`- name: ${predecessor}`);
    assert.ok(position >= 0 && position < attestationPosition, `${predecessor} must precede attestation`);
  }
  assert.ok(linuxJob.indexOf("- name: Stage verified Linux release assets") > attestationPosition);
  assert.match(staging, /^ {8}if: \$\{\{ steps\.version\.outputs\.publish == 'true' \}\}$/mu);
  assert.doesNotMatch(staging, /continue-on-error:|always\(\)/u);
}

test("Linux release attestations cover verified packages and feeds with scoped main-only permissions", async () => {
  assertLinuxReleaseProvenance(await readFile(releaseWorkflowUrl, "utf8"));
});

test("Linux provenance policy rejects bypasses, incomplete subjects, and custom claims", async () => {
  const workflow = await readFile(releaseWorkflowUrl, "utf8");
  for (const [name, mutate] of [
    ["moving action ref", source => source.replace("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6", "actions/attest@v4")],
    ["branch dispatch bypass", source => source.replace("vars.RELEASES_ENABLED == 'true' && github.ref == 'refs/heads/main'", "vars.RELEASES_ENABLED == 'true'")],
    ["missing publish gate", source => source.replace("github.ref == 'refs/heads/main' && steps.version.outputs.publish == 'true'", "github.ref == 'refs/heads/main'")],
    ["unnecessary content writes", source => source.replace("      contents: read", "      contents: write")],
    ["extra metadata permission", source => source.replace("      attestations: write", "      attestations: write\n      artifact-metadata: write")],
    ["missing RPM subject", source => source.replace("            release/linux-distribution/*.rpm\n", "")],
    ["broad subject wildcard", source => source.replace("            release/linux-distribution/*.AppImage", "            release/linux-distribution/*")],
    ["custom predicate", source => source.replace("          create-storage-record: false", "          predicate-type: https://example.invalid/custom\n          predicate: '{}'\n          create-storage-record: false")],
    ["registry publication", source => source.replace("          push-to-registry: false", "          push-to-registry: true")],
    ["ignored attestation failure", source => source.replace("        uses: actions/attest@", "        continue-on-error: true\n        uses: actions/attest@")],
    ["missing smoke gate", source => source.replace("      - name: Smoke the exact release GUI without a keyring session", "      - name: Removed smoke")],
    ["attestation before smoke", source => {
      const step = workflowStep(source, "Attest verified Linux packages and update feeds");
      return source.replace(step, "").replace(
        "      - name: Smoke the exact release GUI without a keyring session",
        `${step}      - name: Smoke the exact release GUI without a keyring session`,
      );
    }],
  ]) assert.throws(() => assertLinuxReleaseProvenance(mutate(workflow)), undefined, name);
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
