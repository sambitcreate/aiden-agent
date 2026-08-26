import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("Android CI only runs for Android or CI workflow changes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /^ {2}changes:\n/mu);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(
    workflow,
    /grep -E '\^\(android\(\/\|\$\)\|\\\.github\/workflows\/ci\\\.yml\$\)'/u,
  );
  assert.match(workflow, /diff_args=\("\$BASE_SHA\.\.\.\$HEAD_SHA"\)/u);
  assert.match(workflow, /if ! changed_files="\$\(git diff --name-only/u);
  assert.match(workflow, /^ {4}needs: changes$/mu);
  assert.match(workflow, /^ {4}if: \$\{\{ needs\.changes\.outputs\.android == 'true' \}\}$/mu);
});
