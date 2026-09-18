const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const CI_WORKFLOW_NAME = "CI";
export const CI_WORKFLOW_FILE = "ci.yml";
export const CI_REQUIRED_JOB_NAME = "CI required";
export const MAIN_BRANCH = "main";
export const MODEL_CATALOG_PATH = "resources/model-capabilities.json";
export const MODEL_CATALOG_COMMIT_MESSAGE = "chore: refresh models.dev catalog";
export const MODEL_CATALOG_BOT_NAME = "github-actions[bot]";
export const MODEL_CATALOG_BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export class ReleaseAdmissionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ReleaseAdmissionError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ReleaseAdmissionError(code, message);
}

export function normalizeSha(value, label = "SHA") {
  if (typeof value !== "string" || !SHA_PATTERN.test(value.trim())) {
    reject("invalid_sha", `${label} must be a 40-character hexadecimal commit SHA`);
  }
  return value.trim().toLowerCase();
}

function normalizeRepository(value, label = "repository") {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.trim())) {
    reject("invalid_repository", `${label} must be an owner/name repository`);
  }
  return value.trim().toLowerCase();
}

function requiredRepository(value, label = "repository") {
  if (typeof value !== "string" || value.trim() === "") {
    reject("missing_repository", `${label} is required`);
  }
  return normalizeRepository(value, label);
}

function requireWorkflowRunValue(workflowRun, field, code, message) {
  if (workflowRun?.[field] !== undefined && workflowRun[field] !== null) {
    return workflowRun[field];
  }
  reject(code, message);
}

export function validateWorkflowRunProvenance({
  repository,
  sourceSha,
  workflowRun,
}) {
  const expectedRepository = requiredRepository(repository);
  const expectedSha = normalizeSha(sourceSha, "source SHA");

  if (!workflowRun || typeof workflowRun !== "object") {
    reject("missing_workflow_run", "workflow_run event payload is required");
  }
  if (workflowRun.name !== CI_WORKFLOW_NAME) {
    reject("workflow_name_mismatch", `workflow_run must be produced by ${CI_WORKFLOW_NAME}`);
  }
  if (workflowRun.event !== "push") {
    reject("workflow_event_mismatch", "release admission accepts push CI runs only");
  }
  if (workflowRun.head_branch !== MAIN_BRANCH) {
    reject("workflow_branch_mismatch", `workflow_run must target ${MAIN_BRANCH}`);
  }
  if (workflowRun.repository?.full_name?.toLowerCase() !== expectedRepository) {
    reject("workflow_repository_mismatch", "workflow_run repository does not match the base repository");
  }
  if (workflowRun.head_repository?.full_name?.toLowerCase() !== expectedRepository) {
    reject("workflow_head_repository_mismatch", "workflow_run head repository does not match the base repository");
  }
  if (workflowRun.status !== "completed" || workflowRun.conclusion !== "success") {
    reject("workflow_run_not_successful", "workflow_run must be completed successfully");
  }

  const runSha = normalizeSha(
    requireWorkflowRunValue(
      workflowRun,
      "head_sha",
      "workflow_sha_missing",
      "workflow_run head SHA is required",
    ),
    "workflow_run head SHA",
  );
  if (runSha !== expectedSha) {
    reject("workflow_sha_mismatch", "workflow_run head SHA does not match the admitted source SHA");
  }

  return {
    repository: expectedRepository,
    sourceSha: expectedSha,
  };
}

function runRecencyValue(run) {
  const updatedAt = Date.parse(run?.updated_at ?? "");
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(run?.created_at ?? "");
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }
  return 0;
}

function compareRuns(left, right) {
  const runNumberDifference = Number(right?.run_number ?? 0) - Number(left?.run_number ?? 0);
  if (runNumberDifference !== 0) {
    return runNumberDifference;
  }
  const attemptDifference = Number(right?.run_attempt ?? 0) - Number(left?.run_attempt ?? 0);
  if (attemptDifference !== 0) {
    return attemptDifference;
  }
  const dateDifference = runRecencyValue(right) - runRecencyValue(left);
  if (dateDifference !== 0) {
    return dateDifference;
  }
  return Number(right?.id ?? 0) - Number(left?.id ?? 0);
}

function isExactCiRun(run, repository, sourceSha) {
  if (!run || typeof run !== "object") {
    return false;
  }
  if (run.name !== CI_WORKFLOW_NAME || run.event !== "push" || run.head_branch !== MAIN_BRANCH) {
    return false;
  }
  if (run.repository?.full_name?.toLowerCase() !== repository) {
    return false;
  }
  if (run.head_repository?.full_name?.toLowerCase() !== repository) {
    return false;
  }
  if (typeof run.head_sha !== "string") {
    return false;
  }
  return run.head_sha.toLowerCase() === sourceSha;
}

export function selectLatestCiRun({ ciRuns, repository, sourceSha }) {
  const normalizedRepository = requiredRepository(repository);
  const normalizedSha = normalizeSha(sourceSha, "source SHA");
  if (!Array.isArray(ciRuns)) {
    reject("ci_runs_missing", "CI workflow runs are required");
  }

  const matchingRuns = ciRuns.filter((run) => isExactCiRun(run, normalizedRepository, normalizedSha));
  if (matchingRuns.length === 0) {
    reject("ci_run_missing", "no base-repository push CI run exists for the admitted SHA");
  }

  const latestRun = [...matchingRuns].sort(compareRuns)[0];
  if (latestRun.status !== "completed" || latestRun.conclusion !== "success") {
    reject("ci_run_not_successful", "the latest CI run for the admitted SHA did not succeed");
  }
  if (latestRun.id === undefined || latestRun.id === null) {
    reject("ci_run_id_missing", "the successful CI run has no run ID");
  }

  return latestRun;
}

export function validateRequiredCiJob({ jobs }) {
  if (!Array.isArray(jobs)) {
    reject("ci_jobs_missing", "CI jobs are required");
  }
  const requiredJobs = jobs.filter((job) => job?.name === CI_REQUIRED_JOB_NAME);
  if (requiredJobs.length !== 1) {
    reject("ci_required_job_missing", `CI must expose exactly one ${CI_REQUIRED_JOB_NAME} job`);
  }

  const requiredJob = requiredJobs[0];
  if (requiredJob.status !== "completed" || requiredJob.conclusion !== "success") {
    reject("ci_required_job_not_successful", `${CI_REQUIRED_JOB_NAME} did not succeed`);
  }
  if (requiredJob.id === undefined || requiredJob.id === null) {
    reject("ci_required_job_id_missing", `${CI_REQUIRED_JOB_NAME} has no job ID`);
  }
  return requiredJob;
}

function isCatalogOnlyMainDescendant(comparison, sourceSha, currentMainSha) {
  if (comparison?.status !== "ahead" || comparison.ahead_by !== 1 || comparison.behind_by !== 0) {
    return false;
  }
  if (!Array.isArray(comparison.files) || comparison.files.length !== 1) {
    return false;
  }
  if (
    comparison.files[0]?.filename !== MODEL_CATALOG_PATH ||
    comparison.files[0]?.status !== "modified"
  ) {
    return false;
  }
  if (!Array.isArray(comparison.commits) || comparison.commits.length !== 1) {
    return false;
  }

  const catalogCommit = comparison.commits[0];
  if (typeof catalogCommit?.sha !== "string" || catalogCommit.sha.toLowerCase() !== currentMainSha) {
    return false;
  }
  if (!Array.isArray(catalogCommit.parents) || catalogCommit.parents.length !== 1) {
    return false;
  }
  if (catalogCommit.parents[0]?.sha?.toLowerCase() !== sourceSha) {
    return false;
  }

  const author = catalogCommit.commit?.author;
  const committer = catalogCommit.commit?.committer;
  if (
    author?.name !== MODEL_CATALOG_BOT_NAME ||
    author?.email !== MODEL_CATALOG_BOT_EMAIL ||
    committer?.name !== MODEL_CATALOG_BOT_NAME ||
    committer?.email !== MODEL_CATALOG_BOT_EMAIL
  ) {
    return false;
  }
  if (
    catalogCommit.author?.login !== MODEL_CATALOG_BOT_NAME ||
    catalogCommit.committer?.login !== MODEL_CATALOG_BOT_NAME
  ) {
    return false;
  }
  return catalogCommit.commit?.message?.trim() === MODEL_CATALOG_COMMIT_MESSAGE;
}

export function validateMainAncestry({
  comparison,
  currentMainSha,
  mode,
  sourceSha,
}) {
  const normalizedSourceSha = normalizeSha(sourceSha, "source SHA");
  const normalizedMainSha = normalizeSha(currentMainSha, "main SHA");
  if (!comparison || typeof comparison !== "object") {
    reject("main_comparison_missing", "main ancestry comparison is required");
  }
  if (comparison.status === "diverged" || comparison.status === "behind") {
    reject("source_not_main_ancestor", "the admitted source is not an ancestor of current main");
  }
  if (!["identical", "ahead"].includes(comparison.status)) {
    reject("main_comparison_invalid", "main ancestry comparison has an unsupported status");
  }
  if (comparison.status === "identical" && normalizedSourceSha !== normalizedMainSha) {
    reject("main_comparison_sha_mismatch", "identical comparison does not match the supplied main SHA");
  }
  if (comparison.status === "ahead" && normalizedSourceSha === normalizedMainSha) {
    reject("main_comparison_sha_mismatch", "ahead comparison cannot have identical source and main SHAs");
  }

  const catalogOnlyMainDescendant = isCatalogOnlyMainDescendant(
    comparison,
    normalizedSourceSha,
    normalizedMainSha,
  );
  if (mode === "workflow_run" && normalizedSourceSha !== normalizedMainSha && !catalogOnlyMainDescendant) {
    reject("stale_workflow_run", "automatic release admission requires the CI SHA to be current main");
  }
  if (mode === "manual" && normalizedSourceSha !== normalizedMainSha && !catalogOnlyMainDescendant) {
    reject("manual_source_stale", "manual release admission permits only current main or its one-commit catalog tip");
  }

  return {
    currentMainSha: normalizedMainSha,
    sourceSha: normalizedSourceSha,
  };
}

export function admitReleaseSource({
  ciRuns,
  comparison,
  currentMainSha,
  eventName,
  jobs,
  repository,
  sourceSha,
  workflowRun,
}) {
  const normalizedRepository = requiredRepository(repository);
  let mode;
  if (eventName === "workflow_run") {
    mode = "workflow_run";
  } else if (eventName === "workflow_dispatch") {
    mode = "manual";
    if (typeof sourceSha !== "string" || sourceSha.trim() === "") {
      reject("manual_source_sha_required", "workflow_dispatch requires an explicit source_sha input");
    }
  } else {
    reject("unsupported_event", "release admission accepts workflow_run or workflow_dispatch only");
  }
  const normalizedSourceSha = normalizeSha(sourceSha, "source SHA");
  if (mode === "workflow_run") {
    validateWorkflowRunProvenance({
      repository: normalizedRepository,
      sourceSha: normalizedSourceSha,
      workflowRun,
    });
  }

  const ciRun = selectLatestCiRun({
    ciRuns,
    repository: normalizedRepository,
    sourceSha: normalizedSourceSha,
  });
  const requiredJob = validateRequiredCiJob({ jobs });
  const ancestry = validateMainAncestry({
    comparison,
    currentMainSha,
    mode,
    sourceSha: normalizedSourceSha,
  });

  return Object.freeze({
    admissionMode: mode,
    ciRunId: String(ciRun.id),
    ciRequiredJobId: String(requiredJob.id),
    currentMainSha: ancestry.currentMainSha,
    repository: normalizedRepository,
    sourceSha: ancestry.sourceSha,
  });
}
