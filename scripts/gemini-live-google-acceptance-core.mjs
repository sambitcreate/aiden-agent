export const GOOGLE_LIVE_ACCEPTANCE_ENV = "AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE";
export const GOOGLE_LIVE_ACCEPTANCE_CONFIRMATION =
  "--i-understand-real-google-call";
export const GOOGLE_LIVE_ACCEPTANCE_SCHEMA_VERSION = 1;
export const GOOGLE_LIVE_ACCEPTANCE_TOTAL_DEADLINE_MS = 12 * 60 * 1_000;

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/iu;
const RESULT_VALUES = new Set(["pass", "fail"]);
const FAILURE_CODES = new Set([
  "app_exited",
  "deadline_exceeded",
  "launch_failed",
  "operator_aborted",
  "receipt_failed",
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "result",
  "failureCode",
  "startedAt",
  "completedAt",
  "durationMs",
  "environment",
  "timing",
  "runnerEvidence",
  "appEvidence",
  "operatorEvidence",
]);
const ENVIRONMENT_KEYS = new Set([
  "appVersion",
  "sdkVersion",
  "electronVersion",
  "nodeVersion",
  "macosVersion",
  "arch",
  "gitCommit",
  "gitDirty",
  "buildSha256",
  "model",
]);
const TIMING_KEYS = new Set([
  "credentialReadyMs",
  "liveReadyMs",
  "stopVisibleMs",
  "stoppedMs",
  "appReadyMs",
  "appProviderResponseMs",
  "appStopRequestedMs",
  "appStoppedMs",
]);
const RUNNER_EVIDENCE_KEYS = new Set(["isolatedProfile"]);
const APP_EVIDENCE_KEYS = new Set([
  "ready",
  "providerResponse",
  "stopRequested",
  "stopped",
]);
const OPERATOR_EVIDENCE_KEYS = new Set([
  "credentialEnteredInApp",
  "liveReadyObserved",
  "providerResponseObserved",
  "visibleStopObserved",
  "stopActivated",
  "idleAfterStopObserved",
]);

function exactKeys(value, allowlist, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowlist.has(key))
      throw new Error(`${label} contains a forbidden field.`);
  }
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be non-negative.`);
}

export function parseGoogleLiveAcceptanceArgs(argv) {
  let confirmed = false;
  let model = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === GOOGLE_LIVE_ACCEPTANCE_CONFIRMATION) {
      confirmed = true;
      continue;
    }
    if (arg === "--model") {
      const value = argv[index + 1]?.trim();
      if (!value || !MODEL_PATTERN.test(value))
        throw new Error("A valid --model is required.");
      model = value;
      index += 1;
      continue;
    }
    throw new Error("Unknown Google Live acceptance argument.");
  }
  if (!model) throw new Error("A valid --model is required.");
  return { confirmed, model };
}

export function googleLiveAcceptanceEnabled(environment, confirmed) {
  return (
    environment[GOOGLE_LIVE_ACCEPTANCE_ENV]?.trim() === "1" &&
    confirmed === true
  );
}

export function parseGoogleLiveAppEvidence(contents) {
  const allowed = ["ready", "provider_response", "stop_requested", "stopped"];
  const lines = contents.trim() ? contents.trim().split("\n") : [];
  if (lines.length > allowed.length)
    throw new Error("App evidence contains too many records.");
  let previous = -1;
  const result = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      throw new Error("App evidence is not valid JSON.");
    }
    exactKeys(
      record,
      new Set(["event", "elapsedMs", "sessionId"]),
      "app evidence record",
    );
    if (record.event !== allowed[index])
      throw new Error("App evidence sequence is invalid.");
    finiteNonNegative(record.elapsedMs, "app evidence elapsedMs");
    if (
      typeof record.sessionId !== "string" ||
      !/^[0-9a-f-]{16,64}$/iu.test(record.sessionId)
    ) {
      throw new Error("App evidence session identity is invalid.");
    }
    if (index > 0 && record.sessionId !== result.get("sessionId")) {
      throw new Error("App evidence spans multiple sessions.");
    }
    if (record.elapsedMs < previous)
      throw new Error("App evidence timing is not monotonic.");
    previous = record.elapsedMs;
    result.set(record.event, record.elapsedMs);
    result.set("sessionId", record.sessionId);
  }
  return result;
}

export function assertGoogleLiveAcceptanceReceipt(receipt) {
  exactKeys(receipt, TOP_LEVEL_KEYS, "receipt");
  if (receipt.schemaVersion !== GOOGLE_LIVE_ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error("Receipt schema version is invalid.");
  }
  if (!RESULT_VALUES.has(receipt.result))
    throw new Error("Receipt result is invalid.");
  if (receipt.result === "pass" && receipt.failureCode !== undefined) {
    throw new Error("Passing receipts cannot contain a failure code.");
  }
  if (receipt.result === "fail" && !FAILURE_CODES.has(receipt.failureCode)) {
    throw new Error("Failing receipts require a fixed failure code.");
  }
  if (!Number.isFinite(Date.parse(receipt.startedAt)))
    throw new Error("Start time is invalid.");
  if (!Number.isFinite(Date.parse(receipt.completedAt)))
    throw new Error("End time is invalid.");
  finiteNonNegative(receipt.durationMs, "durationMs");

  exactKeys(receipt.environment, ENVIRONMENT_KEYS, "environment");
  for (const key of [
    "appVersion",
    "sdkVersion",
    "electronVersion",
    "nodeVersion",
    "macosVersion",
    "arch",
    "gitCommit",
    "buildSha256",
    "model",
  ]) {
    if (
      typeof receipt.environment[key] !== "string" ||
      !receipt.environment[key]
    ) {
      throw new Error("Receipt environment metadata is invalid.");
    }
  }
  if (typeof receipt.environment.gitDirty !== "boolean") {
    throw new Error("Receipt git state is invalid.");
  }
  if (receipt.result === "pass" && receipt.environment.gitDirty) {
    throw new Error("Passing receipts require a clean git tree.");
  }
  if (
    receipt.result === "pass" &&
    !/^[0-9a-f]{40,64}$/u.test(receipt.environment.gitCommit)
  ) {
    throw new Error("Passing receipts require an exact git commit.");
  }
  if (
    receipt.result === "pass" &&
    !/^[0-9a-f]{64}$/u.test(receipt.environment.buildSha256)
  ) {
    throw new Error("Passing receipts require an exact build hash.");
  }

  exactKeys(receipt.timing, TIMING_KEYS, "timing");
  for (const value of Object.values(receipt.timing))
    finiteNonNegative(value, "phase timing");

  exactKeys(receipt.runnerEvidence, RUNNER_EVIDENCE_KEYS, "runnerEvidence");
  exactKeys(receipt.appEvidence, APP_EVIDENCE_KEYS, "appEvidence");
  exactKeys(
    receipt.operatorEvidence,
    OPERATOR_EVIDENCE_KEYS,
    "operatorEvidence",
  );
  for (const [evidence, keys] of [
    [receipt.runnerEvidence, RUNNER_EVIDENCE_KEYS],
    [receipt.appEvidence, APP_EVIDENCE_KEYS],
    [receipt.operatorEvidence, OPERATOR_EVIDENCE_KEYS],
  ]) {
    for (const key of keys) {
      if (typeof evidence[key] !== "boolean") {
        throw new Error("Receipt evidence is invalid.");
      }
    }
  }
  const allEvidence = [
    ...Object.values(receipt.runnerEvidence),
    ...Object.values(receipt.appEvidence),
    ...Object.values(receipt.operatorEvidence),
  ];
  if (receipt.result === "pass" && allEvidence.some((value) => !value)) {
    throw new Error("Passing receipts require every evidence gate.");
  }
  return receipt;
}

export function buildGoogleLiveAcceptanceReceipt({
  result,
  failureCode,
  startedAt,
  completedAt,
  environment,
  timing,
  runnerEvidence,
  appEvidence,
  operatorEvidence,
}) {
  const receipt = {
    schemaVersion: GOOGLE_LIVE_ACCEPTANCE_SCHEMA_VERSION,
    result,
    ...(failureCode ? { failureCode } : {}),
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    environment: { ...environment },
    timing: { ...timing },
    runnerEvidence: { ...runnerEvidence },
    appEvidence: { ...appEvidence },
    operatorEvidence: { ...operatorEvidence },
  };
  return assertGoogleLiveAcceptanceReceipt(receipt);
}
