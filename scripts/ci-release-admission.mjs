/* global AbortSignal, console, fetch, process */

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  admitReleaseSource,
  CI_WORKFLOW_FILE,
  normalizeSha,
  selectLatestCiRun,
} from "./ci-release-admission-core.mjs";

const API_ACCEPT = "application/vnd.github+json";
const API_TIMEOUT_MS = 15_000;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value.trim();
}

function repositoryPath(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2) {
    throw new Error("GITHUB_REPOSITORY must be an owner/name repository");
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function githubUrl(apiUrl, path) {
  return `${apiUrl.replace(/\/$/, "")}${path}`;
}

async function githubGet({ apiUrl, path, token }) {
  const response = await fetch(githubUrl(apiUrl, path), {
    headers: {
      Accept: API_ACCEPT,
      Authorization: `Bearer ${token}`,
      "User-Agent": "aiden-release-admission",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
  }
  return response.json();
}

function completePage(payload, key, label) {
  const items = payload?.[key];
  if (!Array.isArray(items) || !Number.isInteger(payload?.total_count) || payload.total_count > items.length) {
    throw new Error(`${label} API response was incomplete; refusing release admission`);
  }
  return items;
}

async function readEventPayload() {
  const eventPath = requiredEnv("GITHUB_EVENT_PATH");
  return JSON.parse(await readFile(eventPath, "utf8"));
}

function sourceShaForEvent({ eventName, eventPayload }) {
  if (eventName === "workflow_run") {
    return eventPayload?.workflow_run?.head_sha;
  }
  if (eventName === "workflow_dispatch") {
    return process.env.SOURCE_SHA;
  }
  return undefined;
}

async function writeAdmissionOutputs(admission) {
  const outputPath = requiredEnv("GITHUB_OUTPUT");
  const lines = [
    `source-sha=${admission.sourceSha}`,
    `main-sha=${admission.currentMainSha}`,
    `ci-run-id=${admission.ciRunId}`,
    `ci-required-job-id=${admission.ciRequiredJobId}`,
    `admission-mode=${admission.admissionMode}`,
  ];
  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function admitFromGithub(options = {}) {
  const apiUrl = options.apiUrl ?? requiredEnv("GITHUB_API_URL");
  const eventName = options.eventName ?? requiredEnv("GITHUB_EVENT_NAME");
  const eventPayload = options.eventPayload ?? await readEventPayload();
  const repository = options.repository ?? requiredEnv("GITHUB_REPOSITORY");
  const token = options.token ?? requiredEnv("GITHUB_TOKEN");
  const rawSourceSha = sourceShaForEvent({ eventName, eventPayload });
  if (eventName === "workflow_dispatch" && (typeof rawSourceSha !== "string" || rawSourceSha.trim() === "")) {
    throw new Error("workflow_dispatch requires the source_sha input; it will not substitute latest main");
  }
  const sourceSha = normalizeSha(rawSourceSha, "source SHA");
  const encodedRepository = repositoryPath(repository);

  const [mainRef, runList] = await Promise.all([
    githubGet({
      apiUrl,
      path: `/repos/${encodedRepository}/git/ref/heads/main`,
      token,
    }),
    githubGet({
      apiUrl,
      path: `/repos/${encodedRepository}/actions/workflows/${encodeURIComponent(CI_WORKFLOW_FILE)}/runs?event=push&branch=main&head_sha=${encodeURIComponent(sourceSha)}&per_page=100`,
      token,
    }),
  ]);

  const currentMainSha = normalizeSha(mainRef?.object?.sha, "main SHA");
  const ciRuns = completePage(runList, "workflow_runs", "CI workflow runs");
  const ciRun = selectLatestCiRun({ ciRuns, repository, sourceSha });
  const runAttempt = Number(ciRun.run_attempt);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error("CI run did not expose a valid latest attempt number; refusing release admission");
  }

  const [comparison, jobList] = await Promise.all([
    githubGet({
      apiUrl,
      path: `/repos/${encodedRepository}/compare/${sourceSha}...${currentMainSha}`,
      token,
    }),
    githubGet({
      apiUrl,
      path: `/repos/${encodedRepository}/actions/runs/${encodeURIComponent(String(ciRun.id))}/attempts/${runAttempt}/jobs?per_page=100`,
      token,
    }),
  ]);

  const admission = admitReleaseSource({
    ciRuns,
    comparison,
    currentMainSha,
    eventName,
    jobs: completePage(jobList, "jobs", "CI job").map((job) => ({ ...job })),
    repository,
    sourceSha,
    workflowRun: eventPayload?.workflow_run,
  });
  await writeAdmissionOutputs(admission);
  return admission;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const admission = await admitFromGithub();
    console.log(`Release source admitted: ${admission.sourceSha} (${admission.admissionMode})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
