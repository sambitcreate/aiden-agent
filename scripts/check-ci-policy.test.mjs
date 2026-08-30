import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
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
