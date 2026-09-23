import { appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const AREA_NAMES = Object.freeze(["desktop", "apple", "ios", "android"]);

const FULL_AREAS = Object.freeze({
  android: true,
  apple: true,
  desktop: true,
  ios: true,
});

const NO_AREAS = Object.freeze({
  android: false,
  apple: false,
  desktop: false,
  ios: false,
});

const SAFE_ROOT_DOCUMENT = /^(?:README|CHANGELOG)\.(?:md|markdown)$/u;
const SAFE_PAPERCUT_DOCUMENT = /^\.papercuts\/.+\.md$/u;
const LOCK_FILE = /(?:^|\/)(?:[^/]+\.(?:lock|lockfile)|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?)$/u;
const CONFIG_FILE = /(?:^|\/)(?:[^/]*\.config\.[^/]+|(?:config|tsconfig)(?:\.[^/]+)?|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/u;

function copyAreas(areas) {
  return {
    android: Boolean(areas.android),
    apple: Boolean(areas.apple),
    desktop: Boolean(areas.desktop),
    ios: Boolean(areas.ios),
  };
}

function fullAreas() {
  return copyAreas(FULL_AREAS);
}

function noAreas() {
  return copyAreas(NO_AREAS);
}

function mergeAreas(target, source) {
  for (const area of AREA_NAMES) {
    target[area] ||= Boolean(source[area]);
  }
  return target;
}

function isSafePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.startsWith("./") &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

export function isSafeDocumentationPath(path) {
  return (
    isSafePath(path) &&
    ((path.startsWith("docs/") && /\.(?:md|markdown)$/u.test(path)) || SAFE_ROOT_DOCUMENT.test(path) || SAFE_PAPERCUT_DOCUMENT.test(path))
  );
}

function only(area) {
  const areas = noAreas();
  areas[area] = true;
  return areas;
}

function isInfrastructurePath(path) {
  const baseName = path.slice(path.lastIndexOf("/") + 1);
  return (
    path.startsWith("scripts/") ||
    path.startsWith(".github/workflows/") ||
    path.startsWith("workflows/") ||
    path.startsWith("config/") ||
    path.startsWith(".config/") ||
    path.startsWith("package/") ||
    baseName === "package.json" ||
    baseName === "package-lock.json" ||
    baseName === "npm-shrinkwrap.json" ||
    LOCK_FILE.test(path) ||
    CONFIG_FILE.test(path)
  );
}

function classifyPath(path) {
  if (!isSafePath(path)) {
    return { areas: fullAreas(), kind: "unknown" };
  }
  if (isSafeDocumentationPath(path)) {
    return { areas: noAreas(), kind: "documentation" };
  }

  // Shared renderer code must exercise every consumer. Check this before the
  // rest of renderer/, which is desktop-only.
  if (path.startsWith("renderer/shared/")) {
    return { areas: fullAreas(), kind: "shared" };
  }
  if (path.startsWith("renderer/")) {
    return { areas: only("desktop"), kind: "desktop" };
  }
  if (path.startsWith("tests/e2e/")) {
    return { areas: only("desktop"), kind: "desktop" };
  }
  if (path.startsWith("android/")) {
    return { areas: only("android"), kind: "android" };
  }
  if (path.startsWith("ios/")) {
    return { areas: only("ios"), kind: "ios" };
  }
  if (path.startsWith("main/") || path.startsWith("native/")) {
    return { areas: fullAreas(), kind: "shared" };
  }
  if (isInfrastructurePath(path)) {
    return { areas: fullAreas(), kind: "infrastructure" };
  }
  return { areas: fullAreas(), kind: "unknown" };
}

export function classifyChangedPath(path) {
  return copyAreas(classifyPath(path).areas);
}

function forceFullEnabled(value) {
  return value === true || value === "true";
}

function forceFullRequested(options) {
  return (
    forceFullEnabled(options.forceFull) &&
    (options.eventName === undefined || options.eventName === "push")
  );
}

export function decideChangedAreas(paths, options = {}) {
  if (forceFullRequested(options)) {
    return fullAreas();
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length === 0)) {
    return fullAreas();
  }

  const areas = noAreas();
  for (const path of paths) {
    mergeAreas(areas, classifyPath(path).areas);
    if (AREA_NAMES.every((area) => areas[area])) {
      return areas;
    }
  }
  return areas;
}

export function analyzeChangedPaths(paths, options = {}) {
  if (forceFullRequested(options)) {
    return {
      ...fullAreas(),
      areas: fullAreas(),
      changedCount: Array.isArray(paths) ? paths.length : 0,
      safeDocsOnly: false,
      reason: "forced-full",
    };
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length === 0)) {
    return {
      ...fullAreas(),
      areas: fullAreas(),
      changedCount: Array.isArray(paths) ? paths.length : 0,
      safeDocsOnly: false,
      reason: "invalid-path-list",
    };
  }

  const areas = decideChangedAreas(paths, options);
  const classifications = paths.map((path) => classifyPath(path));
  const safeDocsOnly = paths.length > 0 && classifications.every(({ kind }) => kind === "documentation");
  const hasUnknown = classifications.some(({ kind }) => kind === "unknown");
  const reason =
    paths.length === 0
      ? "no-changes"
      : safeDocsOnly
        ? "documentation-only"
        : hasUnknown
          ? "unknown-path"
          : "changed-paths";
  return {
    ...areas,
    areas,
    changedCount: paths.length,
    safeDocsOnly,
    reason,
  };
}

export function parseChangedPaths(output) {
  if (output === undefined || output === null) {
    return [];
  }
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(String(output), "utf8");
  if (bytes.length === 0) {
    return [];
  }
  return bytes
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function validGitRef(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/^0+$/u.test(value) &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._/-]+$/u.test(value)
  );
}

export function buildDiffArgs({ eventName, baseSha, headSha }) {
  const separator = eventName === "pull_request" ? "..." : "..";
  // Disable rename detection so a rename contributes both its deletion and
  // addition paths. This keeps cross-area moves fail-safe without parsing
  // human-readable status output.
  return ["diff", "--name-only", "--no-renames", "-z", `${baseSha}${separator}${headSha}`];
}

export const buildDiffArguments = buildDiffArgs;

function envValue(environment, optionValue, ...names) {
  if (optionValue !== undefined) {
    return optionValue;
  }
  for (const name of names) {
    if (environment[name] !== undefined) {
      return environment[name];
    }
  }
  return undefined;
}

function invokeGit(spawn, args, cwd) {
  try {
    return spawn("git", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function commitExists(spawn, ref, cwd) {
  const result = invokeGit(spawn, ["cat-file", "-e", `${ref}^{commit}`], cwd);
  return Boolean(result && !result.error && result.status === 0);
}

function fullDetection(reason, changedCount = 0) {
  return {
    ...fullAreas(),
    areas: fullAreas(),
    changedCount,
    safeDocsOnly: false,
    reason,
  };
}

export function detectChangedAreas(options = {}) {
  const environment = options.env ?? process.env;
  const eventName = envValue(environment, options.eventName, "GITHUB_EVENT_NAME") ?? "push";
  const baseSha = envValue(
    environment,
    options.baseSha,
    "BASE_SHA",
  );
  const headSha = envValue(environment, options.headSha, "HEAD_SHA");
  const cwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? defaultSpawnSync;
  const forceFull = eventName === "push" && forceFullEnabled(envValue(environment, options.forceFull, "FORCE_FULL"));

  if (forceFull) {
    return fullDetection("forced-full");
  }

  if (
    (eventName !== "push" && eventName !== "pull_request") ||
    !validGitRef(baseSha) ||
    !validGitRef(headSha)
  ) {
    return fullDetection("invalid-git-input");
  }
  if (!commitExists(spawn, baseSha, cwd) || !commitExists(spawn, headSha, cwd)) {
    return fullDetection("git-ref-not-found");
  }

  const result = invokeGit(spawn, buildDiffArgs({ eventName, baseSha, headSha }), cwd);
  if (!result || result.error || result.status !== 0 || result.signal || result.stdout === undefined || result.stdout === null) {
    return fullDetection("git-diff-failed");
  }
  return analyzeChangedPaths(parseChangedPaths(result.stdout), { eventName, forceFull });
}

export const runChangedAreaDetection = detectChangedAreas;

function outputLines(result) {
  const summary =
    result.reason === "documentation-only"
      ? `CI changed-area decision: documentation-only (${result.changedCount} changed paths).`
      : `CI changed-area decision: ${result.desktop && result.apple && result.ios && result.android ? "full checks" : "selected checks"} (${result.changedCount} changed paths).`;
  return [
    ...AREA_NAMES.map((area) => `${area}=${result[area] ? "true" : "false"}`),
    `changed_count=${result.changedCount}`,
    `safe_docs_only=${result.safeDocsOnly ? "true" : "false"}`,
    `decision_reason=${result.reason}`,
    `summary=${summary}`,
  ];
}

export function writeChangedAreaOutputs(result, outputPath) {
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `${outputLines(result).join("\n")}\n`, "utf8");
}

export function writeChangedAreaSummary(result, summaryPath) {
  if (!summaryPath) {
    return;
  }
  const summary = outputLines(result).at(-1);
  appendFileSync(summaryPath, `${summary.slice("summary=".length)}\n`, "utf8");
}

function main() {
  const result = detectChangedAreas();
  writeChangedAreaOutputs(result, process.env.GITHUB_OUTPUT);
  writeChangedAreaSummary(result, process.env.GITHUB_STEP_SUMMARY);
  process.stdout.write(`CI changed-area decision recorded for ${result.changedCount} changed paths.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
