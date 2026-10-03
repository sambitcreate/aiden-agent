import { appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Areas map to CI jobs:
// - desktop: static, verify, unit lanes, Electron E2E
// - apple: the Apple Foundation Models Swift package
// - ios / android: the native mobile clients
// - cli: the headless CLI container and the CLI appearance playground
// - linux: Linux packaging, Fedora RPM, and the Linux E2E gate (not required)
// - catalog: model catalog contracts. Implied by desktop, and the only area a
//   bundled models.dev catalog refresh selects.
export const AREA_NAMES = Object.freeze(["desktop", "apple", "ios", "android", "cli", "linux", "catalog"]);

export const MODEL_CATALOG_PATHS = Object.freeze(["resources/model-capabilities.json"]);

const SAFE_ROOT_DOCUMENT =
  /^(?:README|CHANGELOG|AGENTS|CLAUDE|PRODUCT|LICENSE|THIRD_PARTY_NOTICES)\.(?:md|markdown)$/u;
const SAFE_PAPERCUT_DOCUMENT = /^\.papercuts\/.+\.md$/u;
const SAFE_MEMORY_DOCUMENT = /^\.memory\/.+\.md$/u;
// Documents that tests or packaging read. Editing them must run their readers.
const DESKTOP_CONSUMED_DOCUMENTS = new Set(["AGENTS.md", "docs/design-guide.md"]);
const PACKAGED_DOCUMENTS = new Set(["THIRD_PARTY_NOTICES.md"]);
// Lint covers JavaScript and TypeScript anywhere under docs/.
const LINTED_SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const LINUX_SPECIFIC = /(?:^|[/._-])linux(?:$|[/._-])/iu;
// The Remote server is the only main/ code whose behavior native clients
// consume. Its wire contract is also pinned by protocol/ fixtures.
const REMOTE_SERVER_PATH = /^main\/(?:services|handlers)\/(?:[^/]+\/)*aiden-remote[^/]*(?:\/.*)?$/u;
const LOCK_FILE = /(?:^|\/)(?:[^/]+\.(?:lock|lockfile)|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?)$/u;
const CONFIG_FILE = /(?:^|\/)(?:[^/]*\.config\.[^/]+|(?:config|tsconfig)(?:\.[^/]+)?|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/u;

function selectAreas(selected = []) {
  const areas = {};
  for (const area of AREA_NAMES) {
    areas[area] = selected.includes(area);
  }
  return areas;
}

function copyAreas(areas) {
  const copy = {};
  for (const area of AREA_NAMES) {
    copy[area] = Boolean(areas[area]);
  }
  return copy;
}

function fullAreas() {
  return selectAreas(AREA_NAMES);
}

function noAreas() {
  return selectAreas();
}

function mergeAreas(target, source) {
  for (const area of AREA_NAMES) {
    target[area] ||= Boolean(source[area]);
  }
  return target;
}

function withImpliedAreas(areas) {
  // Catalog contracts moved out of the macOS verify job, so every desktop
  // selection still runs them.
  if (areas.desktop) {
    areas.catalog = true;
  }
  return areas;
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
    !DESKTOP_CONSUMED_DOCUMENTS.has(path) &&
    !PACKAGED_DOCUMENTS.has(path) &&
    ((path.startsWith("docs/") && /\.(?:md|markdown)$/u.test(path)) ||
      SAFE_ROOT_DOCUMENT.test(path) ||
      SAFE_PAPERCUT_DOCUMENT.test(path) ||
      SAFE_MEMORY_DOCUMENT.test(path))
  );
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

function scoped(kind, selected, path) {
  const areas = selectAreas(selected);
  if (LINUX_SPECIFIC.test(path)) {
    areas.linux = true;
  }
  return { areas: withImpliedAreas(areas), kind };
}

function classifyPath(path) {
  if (!isSafePath(path)) {
    return { areas: fullAreas(), kind: "unknown" };
  }
  if (isSafeDocumentationPath(path)) {
    return { areas: noAreas(), kind: "documentation" };
  }
  if (DESKTOP_CONSUMED_DOCUMENTS.has(path)) {
    return scoped("desktop", ["desktop"], path);
  }
  if (PACKAGED_DOCUMENTS.has(path)) {
    return scoped("packaging", ["desktop", "cli", "linux"], path);
  }
  if (MODEL_CATALOG_PATHS.includes(path)) {
    return { areas: selectAreas(["catalog"]), kind: "catalog" };
  }
  if (path.startsWith("docs/")) {
    // Non-markdown docs are linted (scripts) or read by desktop tests (HTML
    // specimens), so they keep the desktop checks.
    return scoped("desktop", ["desktop"], path);
  }

  // Shared renderer code must exercise every consumer, including the CLI
  // themes and the mobile appearance contract. Check this before the rest of
  // renderer/, which is desktop-only.
  if (path.startsWith("renderer/shared/")) {
    return { areas: fullAreas(), kind: "shared" };
  }
  if (path.startsWith("renderer/") || path.startsWith("tests/e2e/")) {
    return scoped("desktop", ["desktop"], path);
  }
  if (path.startsWith("android/")) {
    return scoped("android", ["android"], path);
  }
  if (path.startsWith("ios/")) {
    return scoped("ios", ["ios"], path);
  }
  // Protocol fixtures are pinned by the desktop server, the CLI Remote code,
  // and both native clients' contract tests.
  if (path.startsWith("protocol/")) {
    return scoped("protocol", ["desktop", "cli", "ios", "android"], path);
  }
  if (path.startsWith("packages/cli-playground/")) {
    return scoped("cli", ["cli"], path);
  }
  // The desktop unit lanes also run the CLI package tests on macOS.
  if (path.startsWith("packages/cli/")) {
    return scoped("cli", ["desktop", "cli"], path);
  }
  if (path.startsWith("main/")) {
    const selected = ["desktop", "cli", "linux"];
    if (REMOTE_SERVER_PATH.test(path)) {
      selected.push("ios", "android");
    }
    return scoped("main", selected, path);
  }
  if (path.startsWith("native/apple-foundation-models/")) {
    return scoped("native", ["desktop", "apple"], path);
  }
  if (path.startsWith("native/")) {
    return scoped("native", ["desktop", "cli", "linux"], path);
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

function validPathList(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && path.length > 0);
}

// The models.dev refresh bot pushes commits that change only the bundled
// catalog. Main pushes otherwise always run full validation.
function isCatalogOnly(paths) {
  return validPathList(paths) && paths.every((path) => classifyPath(path).kind === "catalog");
}

export function decideChangedAreas(paths, options = {}) {
  if (forceFullRequested(options)) {
    return isCatalogOnly(paths) ? selectAreas(["catalog"]) : fullAreas();
  }
  if (!validPathList(paths)) {
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

function decision(areas, changedCount, safeDocsOnly, reason) {
  return { ...areas, areas: copyAreas(areas), changedCount, safeDocsOnly, reason };
}

export function analyzeChangedPaths(paths, options = {}) {
  const changedCount = Array.isArray(paths) ? paths.length : 0;
  if (forceFullRequested(options)) {
    return isCatalogOnly(paths)
      ? decision(selectAreas(["catalog"]), changedCount, false, "catalog-only")
      : decision(fullAreas(), changedCount, false, "forced-full");
  }
  if (!validPathList(paths)) {
    return decision(fullAreas(), changedCount, false, "invalid-path-list");
  }

  const areas = decideChangedAreas(paths, options);
  const classifications = paths.map((path) => classifyPath(path));
  const safeDocsOnly = classifications.every(({ kind }) => kind === "documentation");
  const hasUnknown = classifications.some(({ kind }) => kind === "unknown");
  const reason = safeDocsOnly
    ? "documentation-only"
    : hasUnknown
      ? "unknown-path"
      : classifications.every(({ kind }) => kind === "catalog")
        ? "catalog-only"
        : "changed-paths";
  return decision(areas, changedCount, safeDocsOnly, reason);
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
  return decision(fullAreas(), changedCount, false, reason);
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

  // Main pushes still read the diff so a catalog-only refresh commit can skip
  // the full fan-out. Any failure to read it keeps full validation.
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
      : `CI changed-area decision: ${AREA_NAMES.every((area) => result[area]) ? "full checks" : result.reason === "catalog-only" ? "model catalog only" : "selected checks"} (${result.changedCount} changed paths).`;
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
