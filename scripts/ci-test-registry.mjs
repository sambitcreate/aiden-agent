/* global URL */

import {
  existsSync,
  globSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");
const REGISTRY_JSON_PATH = path.join(PROJECT_ROOT, "scripts/ci-test-registry.json");
const TEST_FILE_PATTERN = /\.test\.(?:cjs|mjs|js|ts|tsx)$/u;
const SOURCE_SCRIPTS = ["pretest", "test"];
const TERMINAL_COVERAGE_FLAGS = new Set([
  "--experimental-test-coverage",
  "--test-coverage-include=main/services/terminal-spawn-helper.ts",
  "--test-coverage-include=main/services/terminal.ts",
  "--test-coverage-lines=100",
  "--test-coverage-lines=95",
  "--test-coverage-branches=100",
  "--test-coverage-branches=80",
  "--test-coverage-functions=100",
  "--test-coverage-functions=90",
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readPackageManifest() {
  return readJson(PACKAGE_JSON_PATH);
}

export function readRegistry() {
  return readJson(REGISTRY_JSON_PATH);
}

function tokenizeScript(command, scriptName) {
  const segments = [];
  let segment = [];
  let token = "";
  let quote = null;
  let escaped = false;

  const pushToken = () => {
    if (token.length > 0) segment.push(token);
    token = "";
  };
  const pushSegment = () => {
    pushToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      pushToken();
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      pushSegment();
      index += 1;
      continue;
    }
    if (/[;|<>]/u.test(character)) {
      throw new Error(
        `${scriptName} uses unsupported shell operator '${character}'; update the CI registry parser before changing this script`,
      );
    }
    token += character;
  }
  if (escaped || quote) {
    throw new Error(`${scriptName} has an unterminated shell escape or quote`);
  }
  pushSegment();
  return segments;
}

function isEnvironmentAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function consumeEnvironmentAssignments(segment, scriptName) {
  const assignments = [];
  let index = 0;
  while (isEnvironmentAssignment(segment[index] ?? "")) {
    assignments.push(segment[index]);
    index += 1;
  }
  if (assignments.length > 0) {
    const allowed =
      scriptName === "test:computer-use:native" &&
      assignments.length === 1 &&
      assignments[0] === "CARGO_TARGET_DIR=../../build/computer-use-broker-test";
    if (!allowed) {
      throw new Error(`${scriptName} uses unregistered environment assignments: ${assignments.join(" ")}`);
    }
  }
  return index;
}

function expandTestPath(argument, scriptName) {
  const hasGlob = /[*?{}[\]]/u.test(argument);
  const matches = hasGlob
    ? globSync(argument, { cwd: PROJECT_ROOT, nodir: true })
    : [argument];
  if (matches.length === 0) {
    throw new Error(`${scriptName} test path did not match any file: ${argument}`);
  }
  return matches.map((match) => {
    const normalized = match.replaceAll(path.sep, "/");
    if (path.isAbsolute(normalized) || normalized.startsWith("../")) {
      throw new Error(`${scriptName} test path escapes the repository: ${argument}`);
    }
    if (!TEST_FILE_PATTERN.test(normalized)) {
      throw new Error(`${scriptName} has an unsupported test file: ${normalized}`);
    }
    if (!existsSync(path.join(PROJECT_ROOT, normalized))) {
      throw new Error(`${scriptName} test file does not exist: ${normalized}`);
    }
    return normalized;
  });
}

function collectDirectTestFiles(segment, scriptName) {
  const index = consumeEnvironmentAssignments(segment, scriptName);
  const command = segment[index];
  if (!command) return [];

  if (command === "npm" && segment[index + 1] === "run") {
    if (segment.length !== index + 3) {
      throw new Error(
        `${scriptName} has malformed npm invocation: ${segment.slice(index).join(" ")}; use 'npm run <script>' with no positional script arguments`,
      );
    }
    return [];
  }

  if (command === "cd") {
    if (scriptName === "test:computer-use:native" && segment.slice(index).join(" ") === "cd native/computer-use-broker") {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered directory change: ${segment.slice(index).join(" ")}`);
  }
  if (command === "ruby") {
    if (scriptName === "test:ios-release" && segment.slice(index).join(" ") === "ruby ios/ci/select_testflight_build_number_test.rb") {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered Ruby test command: ${segment.slice(index).join(" ")}`);
  }
  if (command === "playwright") {
    if (
      scriptName === "test:generative-ui" &&
      segment.slice(index).join(" ") === "playwright test --config=playwright.generative-ui.config.ts --fail-on-flaky-tests"
    ) {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered Playwright command: ${segment.slice(index).join(" ")}`);
  }
  if (command === "cargo") {
    const cargoCommand = segment.slice(index).join(" ");
    const allowed = new Set([
      "fmt -- --check",
      "test --locked",
      "clippy --locked --all-targets -- -D warnings",
    ]);
    if (scriptName === "test:computer-use:native" && allowed.has(cargoCommand.replace(/^cargo /u, ""))) {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered Cargo command: ${cargoCommand}`);
  }
  if (command === "esbuild") {
    const buildCommand = segment.slice(index).join(" ");
    if (
      scriptName === "build:vcc" &&
      buildCommand === "esbuild main/services/pi-vcc/worker.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=build/main/pi-vcc-worker.js"
    ) {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered esbuild command: ${buildCommand}`);
  }
  if (command !== "tsx" && command !== "node") {
    throw new Error(`${scriptName} uses an unregistered test command: ${segment.slice(index).join(" ")}`);
  }
  if (segment[index + 1] !== "--test") {
    const buildCommand = segment.slice(index).join(" ");
    const allowedBuildCommands = new Set([
      "node scripts/build-worktree-remover.mjs",
      "node scripts/build-worktree-file-io.mjs",
      "node scripts/build-worktree-file-io.mjs --test",
      "node scripts/build-worktree-remover.mjs --test",
      "node scripts/build-subagent-run-store.mjs",
      "node scripts/build-subagent-run-store.mjs --test",
      "node scripts/build-subagent-file-mutator.mjs",
      "node scripts/build-subagent-file-mutator.mjs --test",
      "node scripts/build-subagent-shell-runner.mjs",
      "node scripts/build-subagent-shell-runner.mjs --test",
      "node scripts/build-bot-inbox-writer.mjs",
      "node scripts/build-bot-inbox-writer.mjs --test",
    ]);
    if (allowedBuildCommands.has(buildCommand)) return [];
    throw new Error(`${scriptName} uses an unregistered non-test Node command: ${buildCommand}`);
  }

  const files = [];
  for (const argument of segment.slice(index + 2)) {
    if (argument.startsWith("--")) {
      if (scriptName !== "test:terminal:coverage" || !TERMINAL_COVERAGE_FLAGS.has(argument)) {
        throw new Error(`${scriptName} uses an unregistered test flag: ${argument}`);
      }
      continue;
    }
    files.push(...expandTestPath(argument, scriptName));
  }
  if (files.length === 0) {
    throw new Error(`${scriptName} has a test runner command without test files`);
  }
  return files;
}

function sourceScriptNames(packageManifest, sourceScripts) {
  const names = sourceScripts ?? SOURCE_SCRIPTS;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("CI registry must declare at least one source package script");
  }
  for (const name of names) {
    if (typeof packageManifest.scripts?.[name] !== "string") {
      throw new Error(`CI registry source package script is missing: ${name}`);
    }
  }
  return names;
}

/**
 * Collects test files from the existing npm test graph for registry auditing.
 * The parser intentionally handles only the package's small, known command
 * vocabulary and fails closed for new shell syntax or npm arguments.
 */
export function collectSourceTests({
  packageManifest = readPackageManifest(),
  sourceScripts = SOURCE_SCRIPTS,
} = {}) {
  const sourceNames = sourceScriptNames(packageManifest, sourceScripts);
  const visited = new Set();
  const filesByScript = new Map();
  const builds = [];

  const visit = (scriptName, required) => {
    if (visited.has(scriptName)) return;
    const command = packageManifest.scripts?.[scriptName];
    if (typeof command !== "string") {
      if (required) throw new Error(`Referenced package script is missing: ${scriptName}`);
      return;
    }
    visited.add(scriptName);
    const files = filesByScript.get(scriptName) ?? new Set();
    for (const segment of tokenizeScript(command, scriptName)) {
      const index = consumeEnvironmentAssignments(segment, scriptName);
      if (segment[index] === "npm" && segment[index + 1] === "run") {
        if (segment.length !== index + 3) {
          throw new Error(
            `${scriptName} has malformed npm invocation: ${segment.slice(index).join(" ")}; use 'npm run <script>' with no positional script arguments`,
          );
        }
        const child = segment[index + 2];
        const lifecycle = `pre${child}`;
        if (packageManifest.scripts?.[lifecycle] && !child.startsWith("pre")) {
          visit(lifecycle, false);
        }
        visit(child, true);
        if (!child.startsWith("pre") && !child.startsWith("post")) visit(`post${child}`, false);
      } else {
        for (const file of collectDirectTestFiles(segment, scriptName)) files.add(file);
        const direct = segment.slice(index);
        if ((direct[0] === "node" && direct[1] !== "--test") || direct[0] === "esbuild") builds.push(direct);
      }
    }
    filesByScript.set(scriptName, files);
  };

  for (const sourceScript of sourceNames) {
    visit(sourceScript, true);
    if (!sourceScript.startsWith("pre") && !sourceScript.startsWith("post")) visit(`post${sourceScript}`, false);
  }
  const files = new Map();
  for (const [scriptName, scriptFiles] of filesByScript) {
    for (const file of scriptFiles) {
      const owners = files.get(file) ?? new Set();
      owners.add(scriptName);
      files.set(file, owners);
    }
  }
  return { files, visited: [...visited].sort(), filesByScript, builds };
}

function flattenLaneFiles(registry) {
  const lanes = registry.lanes ?? [];
  const files = new Map();
  for (const lane of lanes) {
    if (!lane || typeof lane.name !== "string" || !Array.isArray(lane.files)) {
      throw new Error("Every CI unit lane needs a name and files array");
    }
    for (const file of lane.files) {
      if (typeof file !== "string") throw new Error(`Invalid file in lane ${lane.name}`);
      const owners = files.get(file) ?? [];
      owners.push(lane.name);
      files.set(file, owners);
    }
  }
  return files;
}

export function registryPreservedFiles(registry, packageManifest = readPackageManifest()) {
  const files = new Map();
  for (const entry of registry.preserved ?? []) {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.command)) {
      throw new Error("Every preserved CI command needs an id and command array");
    }
    if (!Array.isArray(entry.sourceScripts)) continue;
    const source = collectSourceTests({ packageManifest, sourceScripts: entry.sourceScripts });
    for (const [file, owners] of source.files) {
      const existing = files.get(file) ?? [];
      files.set(file, [...existing, `${entry.id} (${[...owners].join(", ")})`]);
    }
  }
  return files;
}

export function validateRegistry({
  registry = readRegistry(),
  packageManifest = readPackageManifest(),
} = {}) {
  if (registry.version !== 1) throw new Error(`Unsupported CI registry version: ${registry.version}`);
  const source = collectSourceTests({
    packageManifest,
    sourceScripts: registry.sourceScripts,
  });
  // File coverage alone cannot prove that native builds, browser execution,
  // coverage thresholds, Ruby checks or Rust checks are still executed.
  for (const script of ["test:browser", "test:generative-ui", "test:terminal:coverage", "test:ios-release", "test:computer-use:native"]) {
    if (!source.visited.includes(script)) continue;
    if (!(registry.preserved ?? []).some((entry) => entry.sourceScripts?.includes(script) &&
      JSON.stringify(entry.command) === JSON.stringify(["npm", "run", script]))) {
      throw new Error(`Missing preserved execution mode: ${script}`);
    }
  }
  const prerequisites = new Set((registry.prerequisites ?? []).map((entry) => entry.id));
  const usedPrerequisites = new Set([
    ...(registry.lanes ?? []).flatMap((lane) => lane.prerequisites ?? []),
    ...(registry.preserved ?? []).flatMap((entry) => entry.requires ?? []),
  ]);
  for (const id of prerequisites) if (!usedPrerequisites.has(id)) throw new Error(`Unassigned build prerequisite: ${id}`);
  for (const id of usedPrerequisites) if (!prerequisites.has(id)) throw new Error(`Unknown build prerequisite: ${id}`);
  const registeredBuilds = new Set((registry.prerequisites ?? []).flatMap((entry) => {
    const command = entry.command;
    return command?.[0] === "npm" && command[1] === "run" && command.length === 3
      ? tokenizeScript(packageManifest.scripts[command[2]] ?? "", command[2]).map((tokens) => JSON.stringify(tokens))
      : [JSON.stringify(command)];
  }));
  for (const command of source.builds) {
    if (!registeredBuilds.has(JSON.stringify(command))) throw new Error(`Missing build prerequisite: ${command.join(" ")}`);
  }
  const unitFiles = flattenLaneFiles(registry);
  const preservedFiles = registryPreservedFiles(registry, packageManifest);
  const preservedIds = new Set((registry.preserved ?? []).map((entry) => entry.id));
  const lanePreserved = new Map();
  for (const lane of registry.lanes ?? []) {
    for (const id of lane.preserved ?? []) {
      if (!preservedIds.has(id)) throw new Error(`Lane ${lane.name} references missing preserved command: ${id}`);
      const owners = lanePreserved.get(id) ?? [];
      owners.push(lane.name);
      lanePreserved.set(id, owners);
    }
  }
  const unassignedPreserved = [...preservedIds].filter((id) => !lanePreserved.has(id));
  const duplicatePreserved = [...lanePreserved].filter(([, owners]) => owners.length > 1);
  if (unassignedPreserved.length > 0 || duplicatePreserved.length > 0) {
    throw new Error(
      `Preserved CI commands must belong to exactly one lane; unassigned=${JSON.stringify(unassignedPreserved)}, duplicated=${JSON.stringify(duplicatePreserved)}`,
    );
  }
  const allAssigned = new Set([...unitFiles.keys(), ...preservedFiles.keys()]);
  const sourceFiles = new Set(source.files.keys());

  const missing = [...sourceFiles].filter((file) => !allAssigned.has(file)).sort();
  const unregistered = [...allAssigned].filter((file) => !sourceFiles.has(file)).sort();
  if (missing.length > 0 || unregistered.length > 0) {
    throw new Error(
      `CI registry/source mismatch; unassigned=${JSON.stringify(missing)}, not-in-source=${JSON.stringify(unregistered)}`,
    );
  }

  const duplicateUnit = [...unitFiles].filter(([, owners]) => owners.length > 1);
  const overlap = [...unitFiles].filter(([file]) => preservedFiles.has(file));
  if (duplicateUnit.length > 0) {
    throw new Error(`A unit test file is assigned to multiple lanes: ${duplicateUnit.map(([file]) => file).join(", ")}`);
  }
  if (overlap.length > 0) {
    throw new Error(`A test file is both unit and preserved: ${overlap.map(([file]) => file).join(", ")}`);
  }

  for (const file of allAssigned) {
    if (!TEST_FILE_PATTERN.test(file) || !existsSync(path.join(PROJECT_ROOT, file))) {
      throw new Error(`CI registry references a missing or unsupported test file: ${file}`);
    }
  }
  const telegram = packageManifest.scripts?.["test:telegram"];
  if (typeof telegram !== "string") throw new Error("test:telegram must remain registered");
  if (!source.files.has("main/services/telegram/telegram-profile-mutation-fence.test.ts")) {
    throw new Error("test:telegram files are not reachable from pretest/test");
  }
  return {
    sourceFiles: [...sourceFiles].sort(),
    unitFiles: [...unitFiles.keys()].sort(),
    preservedFiles: [...preservedFiles.keys()].sort(),
    visitedScripts: source.visited,
    laneCounts: Object.fromEntries(
      (registry.lanes ?? []).map((lane) => [lane.name, lane.files.length]),
    ),
  };
}
