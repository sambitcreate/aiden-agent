import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { parse } from "yaml";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AREA_NAMES } from "./ci-changes.mjs";
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
    if (rule.areas) {
      // Every area that can select a job must appear in its run condition, so
      // the aggregate never treats a selected job's skip as intentional.
      assert.ok([jobs[name].needs].flat().includes("changes"), name);
      const condition = rule.areas.map((area) => `needs.changes.outputs.${area} == 'true'`).join(" || ");
      assert.equal(jobs[name].if, `\${{ ${condition} }}`, name);
    } else {
      assert.equal(jobs[name].if, undefined, name);
    }
  }
  const filter = jobs.changes.steps.find((step) => step.id === "filter");
  assert.equal(filter.run, "node scripts/ci-changes.mjs");
  assert.equal(filter.env.FORCE_FULL, "${{ github.event_name == 'push' && 'true' || 'false' }}");
  assert.equal(jobs.changes.steps[0].with["fetch-depth"], 0);
  assert.deepEqual(Object.keys(jobs.changes.outputs).toSorted(), [...AREA_NAMES].toSorted());
  // Linux packaging still follows its own area, but the branch ruleset
  // requires its per-arch checks. A skipped matrix job reports under the
  // unexpanded name, so the job always starts and every step carries the gate.
  const linuxGate = "needs.changes.outputs.linux == 'true'";
  assert.equal(jobs.linux.if, undefined);
  assert.ok([jobs.linux.needs].flat().includes("changes"));
  for (const step of jobs.linux.steps) {
    if (String(step.if ?? "").includes("failure()")) continue;
    assert.ok(String(step.if ?? "").includes(linuxGate), step.name);
  }
  assert.deepEqual(jobs["linux-rpm"].needs, ["changes", "linux"]);
  assert.equal(jobs["linux-rpm"].if, `\${{ ${linuxGate} }}`);
  assert.ok(jobs.catalog.steps.some((step) => step.run === "npm run test:model-catalog"));
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
  assert.match(uploadStep, /if: \$\{\{ needs\.changes\.outputs\.linux == 'true' && matrix\.arch == 'x64' \}\}/u);
  assert.match(uploadStep, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.match(rpmJob, /^ {4}needs: \[changes, linux\]$/mu);
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

test("Linux pull-request E2E never grants privileges to checkout content", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const linuxJob = workflow.match(/^ {2}linux:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  assert.ok(linuxJob, "Linux package job is missing");

  assert.match(linuxJob, /^ {4}permissions:\n {6}contents: read\n {4}steps:/mu);
  const checkout = linuxJob.match(/- name: Check out source\n[\s\S]*?(?=\n {6}- name:)/u)?.[0];
  assert.match(checkout ?? "", /persist-credentials: false/u);
  assert.doesNotMatch(linuxJob, /\$\{\{\s*secrets\./u);

  // npm ci runs PR-controlled lifecycle scripts, so nothing below the checkout
  // may become setuid or root-owned.
  assert.doesNotMatch(linuxJob, /sudo (chown|chmod)[^\n]*node_modules/u);
  assert.doesNotMatch(linuxJob, /chmod [0-7]*[4-7][0-7]{3}\b[^\n]*node_modules/u);
  const e2e = linuxJob.match(/- name: Run deterministic Electron E2E gate\n[\s\S]*?(?=\n {6}- name:)/u)?.[0];
  assert.ok(e2e, "Linux E2E gate is missing");
  assert.match(e2e, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/u);
  // Dumpable namespace-sandboxed renderers must not stall on apport core dumps.
  const commands = e2e.replace(/^\s*#.*$/gmu, "");
  const e2eRun = commands.indexOf("npm run test:e2e");
  assert.ok(commands.indexOf("sudo sysctl -w kernel.core_pattern=core") >= 0);
  assert.ok(commands.indexOf("sudo sysctl -w kernel.core_pattern=core") < e2eRun);
  assert.ok(commands.indexOf("ulimit -c 0") >= 0 && commands.indexOf("ulimit -c 0") < e2eRun);
  assert.doesNotMatch(e2e.replace(/^\s*#.*$/gmu, ""), /chrome-sandbox|--no-sandbox/u);
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
  const iosBuilds = jobs.ios.steps.filter((step) => step.run?.includes("xcodebuild build-for-testing"));
  assert.ok(iosBuilds.some((step) => step.run.includes("generic/platform=iOS")), "device build must stay covered");
  const simulatorTest = jobs.ios.steps.find((step) => step.run?.includes("xcodebuild test-without-building"));
  const simulatorResults = jobs.ios.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(jobs.ios.steps.indexOf(simulatorTest) > jobs.ios.steps.indexOf(iosBuilds.at(-1)));
  assert.ok(simulatorTest.run.includes("-resultBundlePath '${{ runner.temp }}/AidenOnTheGoSimulator.xcresult'"));
  assert.equal(simulatorTest["continue-on-error"], undefined);
  assert.equal(simulatorResults.if, "failure()");
  assert.equal(simulatorResults.uses, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
  assert.equal(simulatorResults.with.path, "${{ runner.temp }}/AidenOnTheGoSimulator.xcresult");
  assert.equal(simulatorResults.with["retention-days"], 7);
  // One job builds the production bundles; E2E shards and verify reuse them.
  const builders = Object.entries(jobs)
    .filter(([, job]) => job.steps?.some((step) => step.run === "npm run build"))
    .map(([name]) => name);
  assert.deepEqual(builders, ["build"]);
  const bundle = jobs.build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  for (const consumer of ["e2e", "verify"]) {
    assert.ok(jobs[consumer].needs.includes("build"), consumer);
    const download = jobs[consumer].steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(download?.with.name, bundle.with.name, consumer);
  }
  assert.ok(jobs.verify.steps.some((step) => step.run === "npm run test:e2e:diagnostics:production:run"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts["test:e2e:diagnostics:production:run"], /^AIDEN_E2E_RUNTIME_PROFILE=production playwright test tests\/e2e\/diagnostics-production\.spec\.ts /u);
  assert.match(manifest.scripts["test:e2e:diagnostics:production:run"], /--fail-on-flaky-tests/u);
  assert.ok(!manifest.scripts["test:e2e:diagnostics:production:run"].includes("npm run build"));
  assert.ok(!jobs.verify.steps.some((step) => step.run === "npm test"));
});

test("model catalog workflow verifies read-only and publishes through a checked pull request", async () => {
  const workflow = await readFile(catalogWorkflowUrl, "utf8");
  const { permissions, jobs } = parse(workflow);

  assert.match(workflow, /branches:\s*\n\s*- main/u);
  assert.match(workflow, /workflow_dispatch:/u);
  // Only the publish job may write, and only to open and auto-merge its pull request.
  assert.deepEqual(permissions, { contents: "read" });
  assert.equal(jobs.refresh.permissions, undefined);
  assert.deepEqual(jobs.publish.permissions, { contents: "write", "pull-requests": "write" });
  assert.match(workflow, /group: model-catalog-refresh-main/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /author_email.*41898282\+github-actions\[bot\]@users\.noreply\.github\.com/u);
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
  assert.match(workflow, /CATALOG_DEPLOY_KEY: \$\{\{ secrets\.CATALOG_DEPLOY_KEY \}\}/u);
  assert.match(workflow, /StrictHostKeyChecking=yes/u);
  assert.match(workflow, /refresh:\s*\n(?:\s*#.*\n)*\s*if: github\.ref == 'refs\/heads\/main'\n/u);
  assert.match(workflow, /publish:\s*\n\s*needs: refresh\s*\n\s*if: github\.ref == 'refs\/heads\/main' && /u);
  assert.match(workflow, /git merge-base --is-ancestor "\$BASE_SHA" FETCH_HEAD/u);
  assert.match(workflow, /publish:[\s\S]*\n {4}environment: model-catalog\n[\s\S]*CATALOG_DEPLOY_KEY/u);
  // The snapshot goes to a fresh automation branch that CI runs on, never straight to main.
  assert.match(workflow, /branch="automation\/models-dev-catalog-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u);
  assert.match(workflow, /git push "git@github\.com:\$\{GITHUB_REPOSITORY\}\.git" "HEAD:refs\/heads\/\$\{branch\}"/u);
  assert.doesNotMatch(workflow, /HEAD:main|--force|push -f/u);
  assert.match(workflow, /gh pr merge --repo "\$GITHUB_REPOSITORY" --auto --merge/u);
  const ci = parse(await readFile(workflowUrl, "utf8"));
  assert.ok(ci.on.push.branches.includes("automation/models-dev-catalog-*"));

  // A job-token merge starts no push workflows, so a follow-up run gives main
  // its own CI after each catalog merge.
  assert.ok("workflow_dispatch" in ci.on);
  const baseline = parse(await readFile(new URL("../.github/workflows/model-catalog-main-baseline.yml", import.meta.url), "utf8"));
  // The schedule catches a catalog merge that lands after the fast path stops waiting.
  assert.deepEqual(baseline.on.workflow_run, { workflows: ["CI"], types: ["completed"] });
  assert.ok(Array.isArray(baseline.on.schedule) && baseline.on.schedule.length === 1);
  assert.deepEqual(baseline.permissions, { contents: "read" });
  // Job permissions replace the workflow's, so the compare API needs contents: read here.
  assert.deepEqual(baseline.jobs.dispatch.permissions, { actions: "write", contents: "read", "pull-requests": "read" });
  assert.match(baseline.jobs.dispatch.if, /github\.event_name == 'schedule'/u);
  assert.match(baseline.jobs.dispatch.if, /conclusion == 'success'/u);
  // Coverage means a main CI run tested a commit containing the catalog merge
  // (commit ancestry, not run timestamps), and catalog merges are found by title
  // and branch prefix rather than among the newest-created PRs.
  const dispatchScript = baseline.jobs.dispatch.steps[0].run;
  assert.match(dispatchScript, /compare\/\$merge_sha\.\.\.\$run_sha/u);
  assert.match(dispatchScript, /"identical" \|\| "\$status" == "ahead"/u);
  assert.match(dispatchScript, /in:title "chore: refresh models\.dev catalog" sort:updated-desc/u);
  assert.doesNotMatch(dispatchScript, /createdAt/u);
  // A failed comparison stops the job instead of dispatching CI on every run.
  assert.match(dispatchScript, /if ! status="\$\(gh api "repos\/\$GITHUB_REPOSITORY\/compare\/[^\n]*\n[^\n]*\n\s*exit 1/u);
  assert.match(baseline.jobs.dispatch.if, /startsWith\(github\.event\.workflow_run\.head_branch, 'automation\/models-dev-catalog-'\)/u);
  assert.match(baseline.jobs.dispatch.steps[0].run, /gh workflow run ci\.yml --repo "\$GITHUB_REPOSITORY" --ref main/u);
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

test("foreground Electron smoke is a required package command in desktop verification", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { jobs } = parse(await readFile(workflowUrl, "utf8"));
  const command = "test:foreground-file-tools:electron";
  assert.ok(scripts[command], "Electron smoke must be runnable from the package manifest");
  const smoke = jobs.verify.steps.find((step) => step.run === `npm run ${command}`);
  assert.ok(smoke, "Desktop CI must execute the foreground runtime assertions");
  assert.notEqual(smoke["continue-on-error"], true, "Smoke failures must fail CI");
  assert.equal(smoke.if, undefined, "Every desktop verification run must execute the smoke");
});
