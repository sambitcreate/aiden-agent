import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { admitFromGithub } from "./ci-release-admission.mjs";

import {
  CI_REQUIRED_JOB_NAME,
  MODEL_CATALOG_BOT_EMAIL,
  MODEL_CATALOG_BOT_NAME,
  MODEL_CATALOG_COMMIT_MESSAGE,
  MODEL_CATALOG_PATH,
  admitReleaseSource,
} from "./ci-release-admission-core.mjs";

const REPOSITORY = "sambitcreate/aiden-agent";
const SOURCE_SHA = "a".repeat(40);
const CATALOG_TIP_SHA = "b".repeat(40);

function ciRun(overrides = {}) {
  return {
    id: 1234,
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SOURCE_SHA,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    status: "completed",
    conclusion: "success",
    run_number: 20,
    run_attempt: 1,
    updated_at: "2026-09-18T12:00:00Z",
    ...overrides,
  };
}

function workflowRun(overrides = {}) {
  return {
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SOURCE_SHA,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function requiredJobs(overrides = {}) {
  return [
    {
      id: 5678,
      name: CI_REQUIRED_JOB_NAME,
      status: "completed",
      conclusion: "success",
      ...overrides,
    },
  ];
}

function identicalComparison() {
  return {
    status: "identical",
    ahead_by: 0,
    behind_by: 0,
    files: [],
  };
}

function catalogComparison() {
  return {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: [{ filename: MODEL_CATALOG_PATH, status: "modified" }],
    commits: [
      {
        sha: CATALOG_TIP_SHA,
        parents: [{ sha: SOURCE_SHA }],
        commit: {
          author: { name: MODEL_CATALOG_BOT_NAME, email: MODEL_CATALOG_BOT_EMAIL },
          committer: { name: MODEL_CATALOG_BOT_NAME, email: MODEL_CATALOG_BOT_EMAIL },
          message: MODEL_CATALOG_COMMIT_MESSAGE,
        },
        author: { login: MODEL_CATALOG_BOT_NAME },
        committer: { login: MODEL_CATALOG_BOT_NAME },
      },
    ],
  };
}

function admit(overrides = {}) {
  return admitReleaseSource({
    ciRuns: [ciRun()],
    comparison: identicalComparison(),
    currentMainSha: SOURCE_SHA,
    eventName: "workflow_run",
    jobs: requiredJobs(),
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    workflowRun: workflowRun(),
    ...overrides,
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test("GitHub admission queries the exact workflow attempt and rejects incomplete job responses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-ci-admission-"));
  const previousOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = join(directory, "outputs");
  t.after(async () => {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    await rm(directory, { recursive: true, force: true });
  });
  const calls = [];
  let incomplete = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    let payload;
    if (url.endsWith("/git/ref/heads/main")) payload = { object: { sha: SOURCE_SHA } };
    else if (url.includes("/actions/workflows/ci.yml/runs?")) payload = { total_count: 1, workflow_runs: [ciRun({ run_attempt: 2 })] };
    else if (url.endsWith(`/compare/${SOURCE_SHA}...${SOURCE_SHA}`)) payload = identicalComparison();
    else if (url.endsWith("/actions/runs/1234/attempts/2/jobs?per_page=100")) payload = { total_count: incomplete ? 2 : 1, jobs: requiredJobs() };
    else assert.fail(`Unexpected admission request: ${url}`);
    return { ok: true, json: async () => payload };
  });
  const options = {
    apiUrl: "https://github.example.test", repository: REPOSITORY, token: "test-only",
    eventName: "workflow_run", eventPayload: { workflow_run: workflowRun() },
  };
  const admission = await admitFromGithub(options);
  assert.equal(admission.sourceSha, SOURCE_SHA);
  assert.ok(calls.some((url) => url.includes(`event=push&branch=main&head_sha=${SOURCE_SHA}`)));
  const output = await readFile(process.env.GITHUB_OUTPUT, "utf8");
  assert.ok(output.includes(`source-sha=${SOURCE_SHA}\n`));
  assert.ok(output.includes("ci-required-job-id=5678\n"));
  incomplete = true;
  await assert.rejects(admitFromGithub(options), /CI job API response was incomplete/u);
  assert.equal(await readFile(process.env.GITHUB_OUTPUT, "utf8"), output, "rejected admission must not append outputs");
});

test("admits a successful exact-main CI run", () => {
  assert.deepEqual(admit(), {
    admissionMode: "workflow_run",
    ciRunId: "1234",
    ciRequiredJobId: "5678",
    currentMainSha: SOURCE_SHA,
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
  });
});

test("rejects a failed workflow_run event", () => {
  expectCode(
    () => admit({ workflowRun: workflowRun({ conclusion: "failure" }) }),
    "workflow_run_not_successful",
  );
});

test("rejects the latest cancelled CI run even when an older attempt succeeded", () => {
  expectCode(
    () => admit({
      ciRuns: [
        ciRun({ id: 100, run_number: 20, conclusion: "success" }),
        ciRun({ id: 101, run_number: 21, conclusion: "cancelled" }),
      ],
    }),
    "ci_run_not_successful",
  );
});

test("rejects a failed rerun with the same source SHA after an older success", () => {
  expectCode(
    () => admit({
      ciRuns: [
        ciRun({ id: 100, run_number: 20, run_attempt: 1, conclusion: "success" }),
        ciRun({ id: 101, run_number: 20, run_attempt: 2, conclusion: "failure" }),
      ],
    }),
    "ci_run_not_successful",
  );
});

test("rejects workflow provenance from another repository", () => {
  expectCode(
    () => admit({ workflowRun: workflowRun({ repository: { full_name: "someone/fork" } }) }),
    "workflow_repository_mismatch",
  );
});

test("rejects workflow provenance from a non-main branch", () => {
  expectCode(
    () => admit({ workflowRun: workflowRun({ head_branch: "feature/release" }) }),
    "workflow_branch_mismatch",
  );
});

test("rejects a workflow SHA that differs from the admitted source", () => {
  expectCode(
    () => admit({ workflowRun: workflowRun({ head_sha: CATALOG_TIP_SHA }) }),
    "workflow_sha_mismatch",
  );
});

test("rejects pull_request provenance even when the commit is on main", () => {
  expectCode(
    () => admit({ workflowRun: workflowRun({ event: "pull_request" }) }),
    "workflow_event_mismatch",
  );
});

test("admits an explicitly selected one-commit model catalog tip manually", () => {
  const result = admit({
    comparison: catalogComparison(),
    currentMainSha: CATALOG_TIP_SHA,
    eventName: "workflow_dispatch",
  });

  assert.equal(result.admissionMode, "manual");
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.currentMainSha, CATALOG_TIP_SHA);
});

test("admits the normal workflow_run when main gained the verified catalog tip", () => {
  const result = admit({
    comparison: catalogComparison(),
    currentMainSha: CATALOG_TIP_SHA,
  });

  assert.equal(result.admissionMode, "workflow_run");
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.currentMainSha, CATALOG_TIP_SHA);
});

test("rejects manual admission without an explicit source SHA", () => {
  expectCode(
    () => admit({ eventName: "workflow_dispatch", sourceSha: "" }),
    "manual_source_sha_required",
  );
});

test("rejects a malformed manual source SHA", () => {
  expectCode(
    () => admit({ eventName: "workflow_dispatch", sourceSha: "not-a-sha" }),
    "invalid_sha",
  );
});

test("rejects manual admission when main advanced with non-catalog changes", () => {
  expectCode(
    () => admit({
      comparison: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        files: [{ filename: "src/app.ts", status: "modified" }],
      },
      currentMainSha: CATALOG_TIP_SHA,
      eventName: "workflow_dispatch",
    }),
    "manual_source_stale",
  );
});

test("rejects a catalog-looking descendant with an untrusted commit identity", () => {
  const comparison = catalogComparison();
  comparison.commits[0].commit.author.email = "attacker@example.com";
  expectCode(
    () => admit({
      comparison,
      currentMainSha: CATALOG_TIP_SHA,
      eventName: "workflow_dispatch",
    }),
    "manual_source_stale",
  );
});

test("rejects catalog paths reported as added, removed, or renamed", () => {
  for (const status of ["added", "removed", "renamed"]) {
    const comparison = catalogComparison();
    comparison.files[0].status = status;
    expectCode(
      () => admit({
        comparison,
        currentMainSha: CATALOG_TIP_SHA,
        eventName: "workflow_dispatch",
      }),
      "manual_source_stale",
    );
  }
});
