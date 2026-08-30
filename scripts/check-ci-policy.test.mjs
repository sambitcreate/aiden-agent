import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const catalogWorkflowUrl = new URL(
  "../.github/workflows/model-catalog-refresh.yml",
  import.meta.url,
);

test("Android CI only runs for Android or CI workflow changes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /^ {2}changes:\n/mu);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /grep -E '\^\(android\(\/\|\$\)\|\\\.github\/workflows\/ci\\\.yml\$\)'/u);
  assert.match(workflow, /diff_args=\("\$BASE_SHA\.\.\.\$HEAD_SHA"\)/u);
  assert.match(workflow, /if ! changed_files="\$\(git diff --name-only/u);
  assert.match(workflow, /^ {4}needs: changes$/mu);
  assert.match(workflow, /^ {4}if: \$\{\{ needs\.changes\.outputs\.android == 'true' \}\}$/mu);
  assert.match(workflow, /npm run test:model-catalog/u);
});

test("both Linux package gates exercise the desktop Pi extensions", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.equal(workflow.match(/npm run test:pi-extensions/gu)?.length, 2);
});

test("Fedora installs the baseline-verified RPM instead of rebuilding native modules", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const linuxJob = workflow.match(/^ {2}linux:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];
  const rpmJob = workflow.match(/^ {2}linux-rpm:\n[\s\S]*?(?=^ {2}\S|(?![\s\S]))/mu)?.[0];

  assert.ok(linuxJob, "Linux package job is missing");
  assert.ok(rpmJob, "Linux RPM job is missing");
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
