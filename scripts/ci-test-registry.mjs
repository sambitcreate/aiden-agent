/* global URL */

import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");
const REGISTRY_JSON_PATH = path.join(PROJECT_ROOT, "scripts/ci-test-registry.json");
const WORKFLOWS_PATH = path.join(PROJECT_ROOT, ".github/workflows");
const TEST_FILE_PATTERN = /\.test\.(?:cjs|mjs|js|ts|tsx)$/u;
// Every test file under these roots must run in CI or be allowlisted as manual.
// packages/cli/tests, native/*/Package.swift, and ios/AidenOnTheGoUITests are
// audited by their dedicated manifest parsers below; tests/ holds Playwright specs.
const DISCOVERY_ROOTS = ["main", "renderer", "scripts"];
// `npm test` runs the registry through scripts/run-ci-tests.mjs. The serial
// npm graph stays the place new test files are registered, and the registry
// must assign every file it reaches.
const SOURCE_SCRIPTS = ["pretest:serial", "test:serial"];
// npm would run these hooks around the registry runner without the registry
// seeing their tests.
const RUNNER_LIFECYCLE_HOOKS = ["pretest", "posttest"];
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
const SWIFT_TARGET_KINDS = new Set(["target", "executableTarget", "testTarget"]);
const COVERED_ALIAS_HELPER_SCRIPTS = new Set([
  "build",
  "build:electron",
  "build:electron:production",
  "build:global-shortcuts-portal",
  "build:lease-flock",
  "build:native:c",
  "build:secret-service-authority",
  "build:subagent-file-mutator",
  "build:subagent-run-store",
  "build:subagent-shell-runner",
  "build:vcc",
  "build:visual-viewer",
  "build:worktree-file-io",
  "build:worktree-remover",
  "type-check:e2e",
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readPackageManifest() {
  return readJson(PACKAGE_JSON_PATH);
}

export function readCliPackageManifest(root = PROJECT_ROOT) {
  return readJson(path.join(root, "packages/cli/package.json"));
}

export function readRegistry() {
  return readJson(REGISTRY_JSON_PATH);
}

export function readWorkflows() {
  return readdirSync(WORKFLOWS_PATH)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => readFileSync(path.join(WORKFLOWS_PATH, name), "utf8"))
    .join("\n---\n");
}

/** Lists repository-relative test files on disk under the discovery roots. */
export function discoverTestFiles(root = PROJECT_ROOT) {
  const files = [];
  for (const directory of DISCOVERY_ROOTS) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) continue;
      const file = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/");
      if (file.split("/").includes("node_modules")) continue;
      files.push(file);
    }
  }
  return files.sort();
}

/** Lists repository-relative CLI test files under packages/cli/tests. */
export function discoverCliTestFiles(root = PROJECT_ROOT) {
  const testsDirectory = path.join(root, "packages/cli/tests");
  if (!existsSync(testsDirectory)) return [];
  const files = [];
  for (const entry of readdirSync(testsDirectory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) continue;
    const file = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/");
    const segments = file.split("/");
    if (segments.includes("node_modules") || segments.includes("fixtures")) continue;
    files.push(file);
  }
  return files.sort();
}

/**
 * Lexical scanner for Swift manifest and XCTest files. Strips line and nested
 * block comments and decodes string literals without needing Xcode on Ubuntu.
 */
function tokenizeSwift(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    let hashes = 0;
    if (character === "#") {
      while (source[index + hashes] === "#") hashes += 1;
    }
    if (source[index + hashes] === '"') {
      index += hashes;
      const multiline = source.slice(index, index + 3) === '"""';
      const quote = multiline ? '"""' : '"';
      const closing = `${quote}${"#".repeat(hashes)}`;
      const escapePrefix = `\\${"#".repeat(hashes)}`;
      index += quote.length;
      let value = "";
      while (index < source.length) {
        if (source.startsWith(closing, index)) {
          index += closing.length;
          break;
        }
        if (source.startsWith(escapePrefix, index)) {
          const afterEscape = index + escapePrefix.length;
          value += source[afterEscape] ?? "";
          index = afterEscape + 1;
          continue;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }

    if (character === "`") {
      index += 1;
      let ident = "";
      while (index < source.length && source[index] !== "`") {
        ident += source[index];
        index += 1;
      }
      if (source[index] === "`") index += 1;
      if (ident.length > 0) tokens.push({ type: "ident", value: ident });
      continue;
    }

    if (/[A-Za-z_]/u.test(character)) {
      let ident = character;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_]/u.test(source[index])) {
        ident += source[index];
        index += 1;
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    if (".:,()[]{}".includes(character)) {
      tokens.push({ type: "punct", value: character });
      index += 1;
      continue;
    }

    index += 1;
  }

  return tokens;
}

function findMatchingDelimiter(tokens, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct" && token.value === openChar) depth += 1;
    else if (token.type === "punct" && token.value === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractLabeledName(tokens, start, end) {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === "punct") {
      if (token.value === "(") parenDepth += 1;
      else if (token.value === ")") parenDepth -= 1;
      else if (token.value === "[") bracketDepth += 1;
      else if (token.value === "]") bracketDepth -= 1;
      continue;
    }
    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      token.type === "ident" &&
      token.value === "name" &&
      tokens[index + 1]?.type === "punct" &&
      tokens[index + 1]?.value === ":" &&
      tokens[index + 2]?.type === "string"
    ) {
      return tokens[index + 2].value;
    }
  }
  return null;
}

function extractSwiftDependencies(tokens, start, end) {
  const dependencies = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === "punct") {
      if (token.value === "(") parenDepth += 1;
      else if (token.value === ")") parenDepth -= 1;
      else if (token.value === "[") bracketDepth += 1;
      else if (token.value === "]") bracketDepth -= 1;
      continue;
    }
    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      token.type === "ident" &&
      token.value === "dependencies" &&
      tokens[index + 1]?.type === "punct" &&
      tokens[index + 1]?.value === ":" &&
      tokens[index + 2]?.type === "punct" &&
      tokens[index + 2]?.value === "["
    ) {
      const closeBracket = findMatchingDelimiter(tokens, index + 2, "[", "]");
      if (closeBracket === -1) break;
      let depDepth = 0;
      for (let depIndex = index + 3; depIndex < closeBracket; depIndex += 1) {
        const depToken = tokens[depIndex];
        if (depToken.type === "punct") {
          if (depToken.value === "(" || depToken.value === "[") depDepth += 1;
          else if (depToken.value === ")" || depToken.value === "]") depDepth -= 1;
        }
        if (depDepth === 0 && depToken.type === "string") {
          dependencies.push(depToken.value);
          continue;
        }
        if (
          depDepth === 0 &&
          depToken.type === "punct" &&
          depToken.value === "." &&
          tokens[depIndex + 1]?.type === "ident" &&
          (tokens[depIndex + 1].value === "target" || tokens[depIndex + 1].value === "byName") &&
          tokens[depIndex + 2]?.type === "punct" &&
          tokens[depIndex + 2].value === "("
        ) {
          const closeCall = findMatchingDelimiter(tokens, depIndex + 2, "(", ")");
          if (closeCall !== -1) {
            const depName = extractLabeledName(tokens, depIndex + 3, closeCall);
            if (depName) dependencies.push(depName);
            depIndex = closeCall;
          }
        }
      }
      break;
    }
  }
  return dependencies;
}

/** Statically parses products and targets from a Swift Package.swift manifest. */
export function parseSwiftPackageManifest(source, packagePath) {
  const tokens = tokenizeSwift(source);
  const productTargets = new Map();
  const targets = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type === "ident" &&
      token.value === "products" &&
      tokens[index + 1]?.type === "punct" &&
      tokens[index + 1]?.value === ":" &&
      tokens[index + 2]?.type === "punct" &&
      tokens[index + 2]?.value === "["
    ) {
      const closeProducts = findMatchingDelimiter(tokens, index + 2, "[", "]");
      if (closeProducts === -1) throw new Error(`Unterminated products array in ${packagePath}/Package.swift`);
      let depth = 0;
      for (let cursor = index + 3; cursor < closeProducts; cursor += 1) {
        const current = tokens[cursor];
        if (current.type === "punct") {
          if (current.value === "(" || current.value === "[") depth += 1;
          else if (current.value === ")" || current.value === "]") depth -= 1;
        }
        if (
          depth === 0 &&
          current.type === "punct" &&
          current.value === "." &&
          tokens[cursor + 1]?.type === "ident" &&
          tokens[cursor + 2]?.type === "punct" &&
          tokens[cursor + 2]?.value === "("
        ) {
          const closeCall = findMatchingDelimiter(tokens, cursor + 2, "(", ")");
          if (closeCall === -1) throw new Error(`Unterminated product declaration in ${packagePath}/Package.swift`);
          const productName = extractLabeledName(tokens, cursor + 3, closeCall);
          const mappedTargets = [];
          let argDepth = 0;
          for (let arg = cursor + 3; arg < closeCall; arg += 1) {
            const argToken = tokens[arg];
            if (argToken.type === "punct") {
              if (argToken.value === "(" || argToken.value === "[") argDepth += 1;
              else if (argToken.value === ")" || argToken.value === "]") argDepth -= 1;
              continue;
            }
            if (
              argDepth === 0 &&
              argToken.type === "ident" &&
              argToken.value === "targets" &&
              tokens[arg + 1]?.type === "punct" &&
              tokens[arg + 1]?.value === ":" &&
              tokens[arg + 2]?.type === "punct" &&
              tokens[arg + 2]?.value === "["
            ) {
              const closeProductTargets = findMatchingDelimiter(tokens, arg + 2, "[", "]");
              if (closeProductTargets !== -1) {
                for (let item = arg + 3; item < closeProductTargets; item += 1) {
                  if (tokens[item].type === "string") mappedTargets.push(tokens[item].value);
                }
              }
              break;
            }
          }
          if (productName) productTargets.set(productName, mappedTargets);
          cursor = closeCall;
        }
      }
      index = closeProducts;
      continue;
    }

    if (
      token.type === "ident" &&
      token.value === "targets" &&
      tokens[index + 1]?.type === "punct" &&
      tokens[index + 1]?.value === ":" &&
      tokens[index + 2]?.type === "punct" &&
      tokens[index + 2]?.value === "["
    ) {
      const closeTargets = findMatchingDelimiter(tokens, index + 2, "[", "]");
      if (closeTargets === -1) throw new Error(`Unterminated targets array in ${packagePath}/Package.swift`);
      let depth = 0;
      for (let cursor = index + 3; cursor < closeTargets; cursor += 1) {
        const current = tokens[cursor];
        if (current.type === "punct") {
          if (current.value === "(" || current.value === "[") depth += 1;
          else if (current.value === ")" || current.value === "]") depth -= 1;
        }
        if (
          depth === 0 &&
          current.type === "punct" &&
          current.value === "." &&
          tokens[cursor + 1]?.type === "ident" &&
          tokens[cursor + 2]?.type === "punct" &&
          tokens[cursor + 2]?.value === "("
        ) {
          const kind = tokens[cursor + 1].value;
          const closeCall = findMatchingDelimiter(tokens, cursor + 2, "(", ")");
          if (closeCall === -1) throw new Error(`Unterminated target declaration in ${packagePath}/Package.swift`);
          if (!SWIFT_TARGET_KINDS.has(kind)) {
            throw new Error(`Unsupported Swift target kind '.${kind}' in ${packagePath}/Package.swift; update CI registry parser`);
          }
          const name = extractLabeledName(tokens, cursor + 3, closeCall);
          if (!name) {
            throw new Error(`Swift .${kind} in ${packagePath}/Package.swift is missing a string literal name`);
          }
          const dependencies = extractSwiftDependencies(tokens, cursor + 3, closeCall);
          targets.push({ kind, name, dependencies });
          cursor = closeCall;
        }
      }
      index = closeTargets;
    }
  }

  return {
    packagePath,
    targets,
    productTargets: Object.fromEntries(productTargets),
  };
}

/** Discovers Swift packages and their targets under native/*\/Package.swift. */
export function discoverSwiftPackages(root = PROJECT_ROOT) {
  const nativeRoot = path.join(root, "native");
  if (!existsSync(nativeRoot)) return [];
  const packages = [];
  for (const entry of readdirSync(nativeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(nativeRoot, entry.name, "Package.swift");
    if (!existsSync(manifestPath)) continue;
    const packagePath = `native/${entry.name}`;
    packages.push(parseSwiftPackageManifest(readFileSync(manifestPath, "utf8"), packagePath));
  }
  return packages.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

/** Statically parses XCTestCase classes and 0-arg test*() methods from Swift UI test sources. */
export function parseIosUiTestSource(source) {
  const tokens = tokenizeSwift(source);
  const classes = new Set();
  const methodsByClass = new Map();

  const scanMethodsInBody = (className, openBraceIndex, closeBraceIndex) => {
    const methods = methodsByClass.get(className) ?? new Set();
    let braceDepth = 0;
    for (let cursor = openBraceIndex + 1; cursor < closeBraceIndex; cursor += 1) {
      const token = tokens[cursor];
      if (token.type === "punct" && token.value === "{") {
        braceDepth += 1;
        continue;
      }
      if (token.type === "punct" && token.value === "}") {
        braceDepth -= 1;
        continue;
      }
      if (
        braceDepth === 0 &&
        token.type === "ident" &&
        token.value === "func" &&
        tokens[cursor + 1]?.type === "ident" &&
        tokens[cursor + 1].value.startsWith("test") &&
        tokens[cursor + 2]?.type === "punct" &&
        tokens[cursor + 2].value === "(" &&
        tokens[cursor + 3]?.type === "punct" &&
        tokens[cursor + 3].value === ")"
      ) {
        methods.add(tokens[cursor + 1].value);
      }
    }
    methodsByClass.set(className, methods);
  };

  // First pass: find XCTestCase classes.
  const pendingExtensions = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "ident" && (token.value === "class" || token.value === "extension") && tokens[index + 1]?.type === "ident") {
      const kind = token.value;
      const typeName = tokens[index + 1].value;
      let openBrace = -1;
      for (let lookahead = index + 2; lookahead < tokens.length; lookahead += 1) {
        if (tokens[lookahead].type === "punct" && tokens[lookahead].value === "{") {
          openBrace = lookahead;
          break;
        }
      }
      if (openBrace === -1) continue;
      const closeBrace = findMatchingDelimiter(tokens, openBrace, "{", "}");
      if (closeBrace === -1) continue;

      if (kind === "class") {
        const header = tokens.slice(index + 2, openBrace);
        const inheritsXCTestCase = header.some((item) => item.type === "ident" && item.value === "XCTestCase");
        if (inheritsXCTestCase) {
          classes.add(typeName);
          scanMethodsInBody(typeName, openBrace, closeBrace);
        }
      } else {
        pendingExtensions.push({ typeName, openBrace, closeBrace });
      }
      index = closeBrace;
    }
  }

  for (const ext of pendingExtensions) {
    if (classes.has(ext.typeName)) {
      scanMethodsInBody(ext.typeName, ext.openBrace, ext.closeBrace);
    }
  }

  const tests = [];
  for (const className of [...classes].sort()) {
    for (const methodName of [...(methodsByClass.get(className) ?? [])].sort()) {
      tests.push(`${className}/${methodName}`);
    }
  }
  return {
    classes: [...classes].sort(),
    tests,
  };
}

/** Discovers XCTestCase classes and test methods across ios/AidenOnTheGoUITests/*.swift. */
export function discoverIosUiTests(root = PROJECT_ROOT) {
  const uiTestsDir = path.join(root, "ios/AidenOnTheGoUITests");
  if (!existsSync(uiTestsDir)) return { classes: [], tests: [] };
  const classes = new Set();
  const tests = new Set();
  for (const name of readdirSync(uiTestsDir).filter((entry) => entry.endsWith(".swift")).sort()) {
    const parsed = parseIosUiTestSource(readFileSync(path.join(uiTestsDir, name), "utf8"));
    for (const cls of parsed.classes) classes.add(cls);
    for (const testId of parsed.tests) tests.add(testId);
  }
  return {
    classes: [...classes].sort(),
    tests: [...tests].sort(),
  };
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

function splitEnvironmentAssignments(segment) {
  const assignments = [];
  let index = 0;
  while (isEnvironmentAssignment(segment[index] ?? "")) {
    assignments.push(segment[index]);
    index += 1;
  }
  return { assignments, index };
}

function consumeEnvironmentAssignments(segment, scriptName) {
  const { assignments, index } = splitEnvironmentAssignments(segment);
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

function expandTestPath(argument, scriptName, root = PROJECT_ROOT) {
  const hasGlob = /[*?{}[\]]/u.test(argument);
  const matches = hasGlob
    ? globSync(argument, { cwd: root, nodir: true })
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
    if (!existsSync(path.join(root, normalized))) {
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

  if (command === "npm") {
    // The standalone CLI is its own npm package. Its suite runs as one
    // preserved command because it installs, bundles, and tests packages/cli.
    const npmCommand = segment.slice(index).join(" ");
    const allowed = {
      "cli:build": ["npm --prefix packages/cli run build"],
      "test:cli": ["npm --prefix packages/cli ci", "npm --prefix packages/cli test"],
    };
    if (allowed[scriptName]?.includes(npmCommand)) return [];
    throw new Error(`${scriptName} uses an unregistered npm command: ${npmCommand}`);
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
  if (command === "vite") {
    const buildCommand = segment.slice(index).join(" ");
    if (scriptName === "build:visual-viewer" && buildCommand === "vite build --config vite.visual-viewer.config.ts") {
      return [];
    }
    throw new Error(`${scriptName} uses an unregistered Vite command: ${buildCommand}`);
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
      "node scripts/build-lease-flock.mjs",
      "node scripts/build-bot-inbox-writer.mjs --test",
      // Linux-only helpers built by test:linux-native, which a workflow runs.
      "node scripts/build-global-shortcuts-portal.mjs",
      "node scripts/build-secret-service-authority.mjs",
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
        if ((direct[0] === "node" && direct[1] !== "--test") || direct[0] === "esbuild" || direct[0] === "vite") builds.push(direct);
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

function assertUniqueIds(entries, label) {
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries ?? []) {
    if (seen.has(entry?.id)) duplicates.add(entry.id);
    seen.add(entry?.id);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate ${label} ids: ${[...duplicates].sort().join(", ")}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workflowInvokesScript(workflows, scriptName) {
  return new RegExp(`npm run ${escapeRegExp(scriptName)}(?![\\w:-])`, "u").test(workflows);
}

/**
 * Audits workflowScripts entries in scripts/ci-test-registry.json:
 * - Every entry must exist in root package.json and appear as `npm run <script>`
 *   in workflows.
 * - Any `tsx --test` / `node --test` segments reachable from workflowScripts
 *   contribute their files to `workflowFiles`.
 * - Reachable `swift test`, `swift build`, and `node scripts/build-*.mjs --required`
 *   segments are returned so Swift manifest targets can be verified against
 *   workflow-invoked scripts.
 */
function collectWorkflowScriptCoverage(registry, packageManifest, workflows, root = PROJECT_ROOT) {
  const entries = registry.workflowScripts ?? [];
  const declared = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.script !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error("Every workflow script entry needs a script and reason");
    }
    if (declared.has(entry.script)) {
      throw new Error(`Duplicate workflow script entry: ${entry.script}`);
    }
    declared.add(entry.script);
    if (typeof packageManifest.scripts?.[entry.script] !== "string") {
      throw new Error(`Workflow script is missing from package.json: ${entry.script}`);
    }
    if (!workflowInvokesScript(workflows, entry.script)) {
      throw new Error(`Workflow script is not invoked by any workflow: ${entry.script}`);
    }
  }

  const visited = new Set();
  const files = new Set();
  const segmentsByScript = new Map();

  const visit = (scriptName, required) => {
    if (visited.has(scriptName)) return;
    const command = packageManifest.scripts?.[scriptName];
    if (typeof command !== "string") {
      if (required) throw new Error(`Referenced package script is missing: ${scriptName}`);
      return;
    }
    visited.add(scriptName);
    const segments = tokenizeScript(command, scriptName);
    segmentsByScript.set(scriptName, segments);
    for (const segment of segments) {
      const { index } = splitEnvironmentAssignments(segment);
      const executable = segment[index];
      if (!executable) continue;
      if (executable === "npm" && segment[index + 1] === "run") {
        if (segment.length !== index + 3) {
          throw new Error(
            `${scriptName} has malformed npm invocation: ${segment.slice(index).join(" ")}; use 'npm run <script>' with no positional script arguments`,
          );
        }
        const child = segment[index + 2];
        const preHook = `pre${child}`;
        if (packageManifest.scripts?.[preHook] && !child.startsWith("pre")) visit(preHook, false);
        visit(child, true);
        if (!child.startsWith("pre") && !child.startsWith("post")) visit(`post${child}`, false);
        continue;
      }
      if ((executable === "tsx" || executable === "node") && segment[index + 1] === "--test") {
        const directFiles = [];
        for (const argument of segment.slice(index + 2)) {
          if (argument.startsWith("--")) {
            throw new Error(`${scriptName} uses an unregistered test flag: ${argument}`);
          }
          directFiles.push(...expandTestPath(argument, scriptName, root));
        }
        if (directFiles.length === 0) {
          throw new Error(`${scriptName} has a test runner command without test files`);
        }
        for (const file of directFiles) files.add(file);
      }
    }
  };

  for (const entry of entries) {
    const preHook = `pre${entry.script}`;
    if (packageManifest.scripts?.[preHook] && !entry.script.startsWith("pre")) visit(preHook, false);
    visit(entry.script, true);
    if (!entry.script.startsWith("pre") && !entry.script.startsWith("post")) visit(`post${entry.script}`, false);
  }

  return {
    declaredScripts: declared,
    visitedScripts: visited,
    files,
    segmentsByScript,
  };
}

function parseSwiftHelperBuildScript(scriptSource, scriptPath) {
  const packageJoin = scriptSource.match(/packagePath\s*=\s*path\.join\(\s*projectRoot\s*,\s*["']native["']\s*,\s*["']([^"']+)["']\s*\)/u);
  const directPackage = scriptSource.match(/--package-path["']?\s*,\s*["']([^"']+)["']/u);
  const packagePath = packageJoin ? `native/${packageJoin[1]}` : directPackage?.[1] ?? null;
  const productConst = scriptSource.match(/const\s+product\s*=\s*["']([^"']+)["']/u);
  const targetConst = scriptSource.match(/const\s+target\s*=\s*["']([^"']+)["']/u);
  if (!packagePath || (!productConst && !targetConst)) {
    throw new Error(`Unable to determine Swift packagePath and product/target in helper script: ${scriptPath}`);
  }
  return {
    packagePath: packagePath.replaceAll("\\", "/"),
    product: productConst?.[1] ?? null,
    target: targetConst?.[1] ?? null,
  };
}

function validateSwiftPackages({
  swiftPackages,
  workflowCoverage,
  registry,
  root = PROJECT_ROOT,
  helperScriptSources,
}) {
  const testedPackages = new Map();
  const builtProductsByPackage = new Map();
  const builtTargetsByPackage = new Map();

  const recordBuiltProduct = (pkgPath, product) => {
    const set = builtProductsByPackage.get(pkgPath) ?? new Set();
    set.add(product);
    builtProductsByPackage.set(pkgPath, set);
  };
  const recordBuiltTarget = (pkgPath, target) => {
    const set = builtTargetsByPackage.get(pkgPath) ?? new Set();
    set.add(target);
    builtTargetsByPackage.set(pkgPath, set);
  };

  for (const segments of workflowCoverage.segmentsByScript.values()) {
    for (const segment of segments) {
      const { index } = splitEnvironmentAssignments(segment);
      let tokens = segment.slice(index);
      if (
        tokens[0] === "node" &&
        tokens[1] === "scripts/run-with-apple-developer-tools.mjs"
      ) {
        tokens = tokens.slice(2);
      }
      if (tokens[0] === "xcrun") {
        tokens = tokens.slice(1);
      }
      if (tokens[0] === "swift" && (tokens[1] === "test" || tokens[1] === "build")) {
        const subcommand = tokens[1];
        let pkgPath = null;
        let product = null;
        let target = null;
        const filters = [];
        for (let cursor = 2; cursor < tokens.length; cursor += 1) {
          const arg = tokens[cursor];
          if (arg === "--package-path" && tokens[cursor + 1]) {
            pkgPath = tokens[cursor + 1].replaceAll("\\", "/").replace(/\/+$/u, "");
            cursor += 1;
          } else if (arg === "--product" && tokens[cursor + 1]) {
            product = tokens[cursor + 1];
            cursor += 1;
          } else if (arg === "--target" && tokens[cursor + 1]) {
            target = tokens[cursor + 1];
            cursor += 1;
          } else if (arg === "--filter" && tokens[cursor + 1]) {
            filters.push(tokens[cursor + 1]);
            cursor += 1;
          }
        }
        if (pkgPath && subcommand === "test") {
          const existing = testedPackages.get(pkgPath) ?? { unfiltered: false, filters: new Set() };
          if (filters.length === 0) existing.unfiltered = true;
          for (const filter of filters) existing.filters.add(filter);
          testedPackages.set(pkgPath, existing);
        }
        if (pkgPath && subcommand === "build") {
          if (product) recordBuiltProduct(pkgPath, product);
          if (target) recordBuiltTarget(pkgPath, target);
        }
        continue;
      }

      if (
        tokens[0] === "node" &&
        typeof tokens[1] === "string" &&
        tokens[1].startsWith("scripts/build-") &&
        tokens.includes("--required")
      ) {
        const helperRelPath = tokens[1];
        const helperSource =
          helperScriptSources?.[helperRelPath] ??
          (existsSync(path.join(root, helperRelPath)) ? readFileSync(path.join(root, helperRelPath), "utf8") : null);
        if (typeof helperSource === "string" && (helperSource.includes('"swift"') || helperSource.includes("'swift'"))) {
          const parsed = parseSwiftHelperBuildScript(helperSource, helperRelPath);
          if (parsed.product) recordBuiltProduct(parsed.packagePath, parsed.product);
          if (parsed.target) recordBuiltTarget(parsed.packagePath, parsed.target);
        }
      }
    }
  }

  const allTargets = new Set();
  const coveredTargets = new Set();

  for (const pkg of swiftPackages) {
    const pkgPath = pkg.packagePath;
    const testRecord = testedPackages.get(pkgPath);
    const builtProducts = builtProductsByPackage.get(pkgPath) ?? new Set();
    const builtTargets = new Set(builtTargetsByPackage.get(pkgPath) ?? []);

    for (const [productName, mapped] of Object.entries(pkg.productTargets ?? {})) {
      if (builtProducts.has(productName)) {
        for (const targetName of mapped) builtTargets.add(targetName);
      }
    }

    const directlyCovered = new Set();
    const targetMap = new Map(pkg.targets.map((target) => [target.name, target]));

    for (const target of pkg.targets) {
      const id = `${pkgPath}:${target.name}`;
      allTargets.add(id);
      if (target.kind === "testTarget") {
        const covered = Boolean(
          testRecord &&
          (testRecord.unfiltered || [...testRecord.filters].some((pattern) => pattern === target.name || target.name.includes(pattern))),
        );
        if (covered) directlyCovered.add(target.name);
      } else if (target.kind === "executableTarget") {
        if (builtTargets.has(target.name) || builtProducts.has(target.name)) {
          directlyCovered.add(target.name);
        }
      } else if (target.kind === "target" && builtTargets.has(target.name)) {
        directlyCovered.add(target.name);
      }
    }

    const pending = [...directlyCovered];
    const reachable = new Set();
    while (pending.length > 0) {
      const currentName = pending.pop();
      if (reachable.has(currentName)) continue;
      reachable.add(currentName);
      coveredTargets.add(`${pkgPath}:${currentName}`);
      const currentTarget = targetMap.get(currentName);
      for (const dep of currentTarget?.dependencies ?? []) {
        if (targetMap.has(dep) && !reachable.has(dep)) pending.push(dep);
      }
    }
  }

  const manualSwift = new Set();
  for (const entry of registry.manualSwiftTargets ?? []) {
    if (!entry || typeof entry.target !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error("Every manualSwiftTargets entry needs a target and reason");
    }
    if (manualSwift.has(entry.target)) {
      throw new Error(`Duplicate manual Swift target: ${entry.target}`);
    }
    if (!allTargets.has(entry.target)) {
      throw new Error(`Manual Swift target allowlist references an unknown target: ${entry.target}`);
    }
    manualSwift.add(entry.target);
  }

  const staleSwift = [...manualSwift].filter((target) => coveredTargets.has(target)).sort();
  if (staleSwift.length > 0) {
    throw new Error(`Manual Swift target allowlist names targets CI already runs: ${JSON.stringify(staleSwift)}`);
  }

  const unwiredSwift = [...allTargets].filter((target) => !coveredTargets.has(target) && !manualSwift.has(target)).sort();
  if (unwiredSwift.length > 0) {
    throw new Error(
      `Swift package targets never run in CI: ${JSON.stringify(unwiredSwift)}; wire a workflow-invoked build/test npm script or allowlist under "manualSwiftTargets" with a reason`,
    );
  }

  return [...allTargets].sort();
}

function collectWorkflowIosUiTests(workflows, discoveredIosUi) {
  const knownClasses = new Set(discoveredIosUi.classes);
  const knownTests = new Set(discoveredIosUi.tests);
  const covered = new Set();

  for (const doc of parseAllDocuments(workflows)) {
    if (doc.errors.length > 0) {
      throw new Error(`Invalid workflow YAML: ${doc.errors[0].message}`);
    }
    const parsed = doc.toJS();
    for (const job of Object.values(parsed?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const run = typeof step?.run === "string" ? step.run : "";
        if (!run.includes("xcodebuild") || run.includes("-skip-testing:AidenOnTheGoUITests")) continue;
        for (const match of run.matchAll(/-only-testing:AidenOnTheGoUITests\/([A-Za-z0-9_]+)(?:\/([A-Za-z0-9_]+))?/gu)) {
          const [, className, methodName] = match;
          if (!knownClasses.has(className)) {
            throw new Error(`Workflow -only-testing references unknown iOS UI test class: ${className}`);
          }
          if (methodName) {
            const testId = `${className}/${methodName}`;
            if (!knownTests.has(testId)) {
              throw new Error(`Workflow -only-testing references unknown iOS UI test method: ${testId}`);
            }
            covered.add(testId);
          } else {
            for (const testId of discoveredIosUi.tests) {
              if (testId.startsWith(`${className}/`)) covered.add(testId);
            }
          }
        }
      }
    }
  }
  return covered;
}

function validateIosUiTests({ discoveredIosUi, workflows, registry }) {
  const knownClasses = new Set(discoveredIosUi.classes);
  const knownTests = new Set(discoveredIosUi.tests);
  const workflowCovered = collectWorkflowIosUiTests(workflows, discoveredIosUi);

  const seenManualEntries = new Set();
  const manualMethodMap = new Map();
  for (const entry of registry.manualIosUiTests ?? []) {
    if (!entry || typeof entry.test !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error("Every manualIosUiTests entry needs a test and reason");
    }
    if (seenManualEntries.has(entry.test)) {
      throw new Error(`Duplicate manual iOS UI test entry: ${entry.test}`);
    }
    seenManualEntries.add(entry.test);

    if (entry.test.includes("/")) {
      if (!knownTests.has(entry.test)) {
        throw new Error(`Manual iOS UI test allowlist references a missing test method: ${entry.test}`);
      }
      if (manualMethodMap.has(entry.test)) {
        throw new Error(`Duplicate manual iOS UI test coverage: ${entry.test}`);
      }
      manualMethodMap.set(entry.test, entry.test);
    } else {
      if (!knownClasses.has(entry.test)) {
        throw new Error(`Manual iOS UI test allowlist references a missing test class: ${entry.test}`);
      }
      const classMethods = discoveredIosUi.tests.filter((testId) => testId.startsWith(`${entry.test}/`));
      if (classMethods.length === 0) {
        throw new Error(`Manual iOS UI test class has no test methods: ${entry.test}`);
      }
      for (const methodId of classMethods) {
        if (manualMethodMap.has(methodId)) {
          throw new Error(`Duplicate manual iOS UI test coverage: ${methodId}`);
        }
        manualMethodMap.set(methodId, entry.test);
      }
    }
  }

  const staleManual = [...new Set(
    [...manualMethodMap.entries()]
      .filter(([methodId]) => workflowCovered.has(methodId))
      .map(([, declaredEntry]) => declaredEntry),
  )].sort();
  if (staleManual.length > 0) {
    throw new Error(`Manual iOS UI test allowlist names tests CI already runs: ${JSON.stringify(staleManual)}`);
  }

  const unrun = discoveredIosUi.tests
    .filter((testId) => !workflowCovered.has(testId) && !manualMethodMap.has(testId))
    .sort();
  if (unrun.length > 0) {
    throw new Error(
      `iOS UI tests on disk never run in CI: ${JSON.stringify(unrun)}; add -only-testing flags in ci.yml or allowlist them under "manualIosUiTests" with a reason`,
    );
  }

  return {
    workflowIosUiTests: [...workflowCovered].sort(),
    manualIosUiTests: [...manualMethodMap.keys()].sort(),
  };
}

function validateCliInventory({ cliManifest, discoveredCliFiles, workflows }) {
  const testCommand = cliManifest?.scripts?.test;
  if (typeof testCommand !== "string" || testCommand.trim().length === 0) {
    throw new Error("packages/cli/package.json must define a test script");
  }

  const discoveredSet = new Set(discoveredCliFiles);
  const configuredFiles = new Set();
  for (const segment of tokenizeScript(testCommand, "packages/cli:test")) {
    const { assignments, index } = splitEnvironmentAssignments(segment);
    if (assignments.length > 0) {
      throw new Error(`packages/cli test script uses unregistered environment assignments: ${assignments.join(" ")}`);
    }
    if (segment[index] !== "node" || segment[index + 1] !== "--test") {
      throw new Error(`packages/cli test script uses an unregistered command: ${segment.slice(index).join(" ")}`);
    }
    for (const arg of segment.slice(index + 2)) {
      if (arg.startsWith("--")) {
        throw new Error(`packages/cli test script uses an unregistered flag: ${arg}`);
      }
      const normalized = path.posix.normalize(`packages/cli/${arg.replaceAll("\\", "/")}`);
      if (!TEST_FILE_PATTERN.test(normalized) || !discoveredSet.has(normalized)) {
        throw new Error(`packages/cli test script references a missing or unsupported test file: ${arg}`);
      }
      configuredFiles.add(normalized);
    }
  }

  const missingCliFiles = discoveredCliFiles.filter((file) => !configuredFiles.has(file)).sort();
  if (missingCliFiles.length > 0) {
    throw new Error(
      `CLI test files on disk never run in packages/cli test script: ${JSON.stringify(missingCliFiles)}`,
    );
  }

  for (const doc of parseAllDocuments(workflows)) {
    if (doc.errors.length > 0) {
      throw new Error(`Invalid workflow YAML: ${doc.errors[0].message}`);
    }
    const parsed = doc.toJS();
    const workflowName = parsed?.name ?? "workflow";
    for (const [jobId, job] of Object.entries(parsed?.jobs ?? {})) {
      const steps = job?.steps ?? [];
      const packStepIndex = steps.findIndex((step) =>
        /\bnpm\s+pack\s+(?:\.\/)?packages\/cli\b/u.test(String(step?.run ?? "")),
      );
      if (packStepIndex === -1) continue;

      const distStepIndex = steps.findIndex((step) =>
        /\bnpm\s+run\s+cli:dist\b/u.test(String(step?.run ?? "")),
      );
      const upperBound = distStepIndex !== -1 && distStepIndex < packStepIndex ? distStepIndex : packStepIndex;

      let keylessBuilt = false;
      let cliTestedBeforePack = false;
      const jobHasPosthogKey = Boolean(job?.env && Object.hasOwn(job.env, "AIDEN_POSTHOG_PROJECT_KEY"));

      for (let stepIndex = 0; stepIndex < upperBound; stepIndex += 1) {
        const step = steps[stepIndex];
        const run = String(step?.run ?? "");
        if (!run) continue;
        const stepHasPosthogKey =
          jobHasPosthogKey ||
          Boolean(step?.env && Object.hasOwn(step.env, "AIDEN_POSTHOG_PROJECT_KEY")) ||
          /\bAIDEN_POSTHOG_PROJECT_KEY\s*=/u.test(run);

        const runsTestCli = /\bnpm\s+run\s+test:cli\b/u.test(run);
        const buildMatch = /\b(?:npm\s+run\s+cli:build|npm\s+--prefix\s+packages\/cli\s+run\s+build)\b/u.exec(run);
        const testMatch = /\bnpm\s+--prefix\s+packages\/cli\s+test\b/u.exec(run);

        if (runsTestCli) {
          if (stepHasPosthogKey) {
            throw new Error(
              `Workflow "${workflowName}" job "${jobId}" must run CLI tests without AIDEN_POSTHOG_PROJECT_KEY before packing packages/cli`,
            );
          }
          keylessBuilt = true;
          cliTestedBeforePack = true;
          break;
        }

        if (buildMatch && !stepHasPosthogKey) {
          if (!testMatch || buildMatch.index < testMatch.index) {
            keylessBuilt = true;
          }
        }
        if (testMatch) {
          if (stepHasPosthogKey) {
            throw new Error(
              `Workflow "${workflowName}" job "${jobId}" must run CLI tests without AIDEN_POSTHOG_PROJECT_KEY before packing packages/cli`,
            );
          }
          if (keylessBuilt) {
            cliTestedBeforePack = true;
            break;
          }
        }
      }

      if (!cliTestedBeforePack) {
        throw new Error(
          `Workflow "${workflowName}" job "${jobId}" packs packages/cli without building a keyless bundle and running CLI tests before cli:dist and npm pack`,
        );
      }
    }
  }

  return [...configuredFiles].sort();
}

function isCoveredScriptAlias(scriptName, {
  packageManifest,
  laneNames,
  coveredTestFiles,
  coveredScripts,
  workflowScripts,
  root = PROJECT_ROOT,
}, visiting = new Set()) {
  if (visiting.has(scriptName)) return false;
  const command = packageManifest.scripts?.[scriptName];
  if (typeof command !== "string" || command.trim().length === 0) return false;
  visiting.add(scriptName);

  const checkSegment = (segment, ownerName) => {
    const { assignments, index } = splitEnvironmentAssignments(segment);
    if (assignments.length > 0) return { ok: false, executesTests: false };
    const tokens = segment.slice(index);
    const executable = tokens[0];
    if (!executable) return { ok: true, executesTests: false };

    if (executable === "node" && tokens[1] === "scripts/run-ci-tests.mjs") {
      const rest = tokens.slice(2);
      if (
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === "--parallel" || rest[0] === "--preserved")) ||
        (rest.length === 2 && rest[0] === "--lane" && laneNames.has(rest[1]))
      ) {
        return { ok: true, executesTests: true };
      }
      return { ok: false, executesTests: false };
    }

    if (
      executable === "node" &&
      tokens[1] === "scripts/run-registered-tests-with-coverage.mjs" &&
      tokens.length === 3 &&
      coveredScripts.has(tokens[2])
    ) {
      return { ok: true, executesTests: true };
    }

    if (executable === "npm" && tokens[1] === "run" && tokens.length === 3) {
      const child = tokens[2];
      if (coveredScripts.has(child)) {
        return { ok: true, executesTests: true };
      }
      if (COVERED_ALIAS_HELPER_SCRIPTS.has(child)) {
        return { ok: true, executesTests: false };
      }
      if (
        child.startsWith("test:") &&
        isCoveredScriptAlias(
          child,
          { packageManifest, laneNames, coveredTestFiles, coveredScripts, workflowScripts, root },
          visiting,
        )
      ) {
        return { ok: true, executesTests: true };
      }
      return { ok: false, executesTests: false };
    }

    if ((executable === "tsx" || executable === "node") && tokens[1] === "--test") {
      const files = [];
      for (const arg of tokens.slice(2)) {
        if (arg.startsWith("--")) {
          if (arg === "--experimental-test-coverage") continue;
          return { ok: false, executesTests: false };
        }
        let expanded;
        try {
          expanded = expandTestPath(arg, ownerName, root);
        } catch {
          return { ok: false, executesTests: false };
        }
        files.push(...expanded);
      }
      if (files.length === 0 || !files.every((file) => coveredTestFiles.has(file))) {
        return { ok: false, executesTests: false };
      }
      return { ok: true, executesTests: true };
    }

    if (
      executable === "playwright" &&
      tokens[1] === "test" &&
      tokens.length === 5 &&
      /^tests\/e2e\/[^/]+\.spec\.ts$/u.test(tokens[2]) &&
      tokens[3] === "--config=playwright.config.ts" &&
      tokens[4] === "--fail-on-flaky-tests" &&
      workflowScripts.has("test:e2e") &&
      existsSync(path.join(root, tokens[2]))
    ) {
      return { ok: true, executesTests: true };
    }

    return { ok: false, executesTests: false };
  };

  for (const hook of [`pre${scriptName}`, `post${scriptName}`]) {
    if (typeof packageManifest.scripts?.[hook] === "string") {
      let hookSegments;
      try {
        hookSegments = tokenizeScript(packageManifest.scripts[hook], hook);
      } catch {
        return false;
      }
      for (const hookSegment of hookSegments) {
        if (!checkSegment(hookSegment, hook).ok) return false;
      }
    }
  }

  let segments;
  try {
    segments = tokenizeScript(command, scriptName);
  } catch {
    return false;
  }
  if (segments.length === 0) return false;

  let executesCoveredTests = false;
  for (const segment of segments) {
    const outcome = checkSegment(segment, scriptName);
    if (!outcome.ok) return false;
    if (outcome.executesTests) executesCoveredTests = true;
  }

  return executesCoveredTests;
}

function validateRootManifestScripts({
  registry,
  packageManifest,
  workflows,
  visitedScripts,
  workflowCoverage,
  coveredTestFiles,
  root = PROJECT_ROOT,
}) {
  const auditedScripts = Object.keys(packageManifest.scripts ?? {})
    .filter((name) => name === "build:native" || name.startsWith("test:"))
    .sort();
  if (!auditedScripts.includes("build:native")) {
    throw new Error("package.json must define build:native");
  }

  const laneNames = new Set((registry.lanes ?? []).map((lane) => lane.name));
  const coveredScripts = new Set([...visitedScripts, ...workflowCoverage.visitedScripts]);

  const manualScripts = new Set();
  for (const entry of registry.manualScripts ?? []) {
    if (!entry || typeof entry.script !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error("Every manualScripts entry needs a script and reason");
    }
    if (manualScripts.has(entry.script)) {
      throw new Error(`Duplicate manual script entry: ${entry.script}`);
    }
    if (!(entry.script === "build:native" || entry.script.startsWith("test:")) || typeof packageManifest.scripts?.[entry.script] !== "string") {
      throw new Error(`Manual script allowlist references a missing or unsupported package script: ${entry.script}`);
    }
    manualScripts.add(entry.script);
  }

  const aliasOptions = {
    packageManifest,
    laneNames,
    coveredTestFiles,
    coveredScripts,
    workflowScripts: workflowCoverage.declaredScripts,
    root,
  };

  const staleManualScripts = [...manualScripts]
    .filter((scriptName) =>
      coveredScripts.has(scriptName) ||
      workflowInvokesScript(workflows, scriptName) ||
      isCoveredScriptAlias(scriptName, aliasOptions),
    )
    .sort();
  if (staleManualScripts.length > 0) {
    throw new Error(`Manual script allowlist names scripts CI already runs: ${JSON.stringify(staleManualScripts)}`);
  }

  const unwiredScripts = auditedScripts
    .filter((scriptName) => {
      if (coveredScripts.has(scriptName)) return false;
      if (manualScripts.has(scriptName)) return false;
      if (scriptName !== "build:native" && isCoveredScriptAlias(scriptName, aliasOptions)) return false;
      return true;
    })
    .sort();
  if (unwiredScripts.length > 0) {
    throw new Error(
      `Package scripts never run in CI: ${JSON.stringify(unwiredScripts)}; wire them into test:serial or workflowScripts, or allowlist them under "manualScripts" with a reason`,
    );
  }

  return {
    manualScripts: [...manualScripts].sort(),
  };
}

function manualTestFiles(registry, root = PROJECT_ROOT) {
  const files = new Set();
  for (const entry of registry.manual ?? []) {
    if (!entry || typeof entry.file !== "string" || typeof entry.reason !== "string") {
      throw new Error("Every manual test entry needs a file and reason");
    }
    if (files.has(entry.file)) throw new Error(`Duplicate manual test file: ${entry.file}`);
    if (!TEST_FILE_PATTERN.test(entry.file) || !existsSync(path.join(root, entry.file))) {
      throw new Error(`Manual test allowlist references a missing or unsupported test file: ${entry.file}`);
    }
    files.add(entry.file);
  }
  return files;
}

export function validateRegistry({
  registry = readRegistry(),
  packageManifest = readPackageManifest(),
  cliManifest = readCliPackageManifest(),
  workflows = readWorkflows(),
  discoveredFiles = discoverTestFiles(),
  discoveredCliFiles = discoverCliTestFiles(),
  swiftPackages = discoverSwiftPackages(),
  discoveredIosUi = discoverIosUiTests(),
  helperScriptSources,
  root = PROJECT_ROOT,
} = {}) {
  if (registry.version !== 1) throw new Error(`Unsupported CI registry version: ${registry.version}`);
  // Sets and Maps below would silently collapse a repeated id, while the
  // runner would still schedule every copy.
  assertUniqueIds(registry.prerequisites, "prerequisite");
  assertUniqueIds(registry.preserved, "preserved");
  for (const hook of RUNNER_LIFECYCLE_HOOKS) {
    if (typeof packageManifest.scripts?.[hook] === "string") {
      throw new Error(`${hook} would bypass the CI registry; register its tests in pretest:serial or test:serial`);
    }
  }
  const source = collectSourceTests({
    packageManifest,
    sourceScripts: registry.sourceScripts,
  });
  // File coverage alone cannot prove that native builds, browser execution,
  // coverage thresholds, Ruby checks or Rust checks are still executed.
  for (const script of ["test:browser", "test:generative-ui", "test:terminal:coverage", "test:ios-release", "test:computer-use:native", "test:cli"]) {
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
    if (!TEST_FILE_PATTERN.test(file) || !existsSync(path.join(root, file))) {
      throw new Error(`CI registry references a missing or unsupported test file: ${file}`);
    }
  }
  const telegram = packageManifest.scripts?.["test:telegram"];
  if (typeof telegram !== "string") throw new Error("test:telegram must remain registered");
  if (!source.files.has("main/services/telegram/telegram-profile-mutation-fence.test.ts")) {
    throw new Error("test:telegram files are not reachable from the serial test graph");
  }

  // The serial graph only proves the files it reaches; a test file that no
  // script names would otherwise never run. Compare the files on disk instead.
  const workflowCoverage = collectWorkflowScriptCoverage(registry, packageManifest, workflows, root);
  const workflowFiles = workflowCoverage.files;
  const manualFiles = manualTestFiles(registry, root);
  const staleManual = [...manualFiles].filter((file) => sourceFiles.has(file) || workflowFiles.has(file)).sort();
  if (staleManual.length > 0) {
    throw new Error(`Manual test allowlist names files CI already runs: ${JSON.stringify(staleManual)}`);
  }
  const unrun = discoveredFiles
    .filter((file) => !sourceFiles.has(file) && !workflowFiles.has(file) && !manualFiles.has(file))
    .sort();
  if (unrun.length > 0) {
    throw new Error(
      `Test files on disk never run in CI: ${JSON.stringify(unrun)}; register them in test:serial and a lane, or allowlist them under "manual" with a reason`,
    );
  }

  const coveredTestFiles = new Set([...sourceFiles, ...workflowFiles]);
  const rootScripts = validateRootManifestScripts({
    registry,
    packageManifest,
    workflows,
    visitedScripts: new Set(source.visited),
    workflowCoverage,
    coveredTestFiles,
    root,
  });
  const swiftTargets = validateSwiftPackages({
    swiftPackages,
    workflowCoverage,
    registry,
    root,
    helperScriptSources,
  });
  const iosUi = validateIosUiTests({
    discoveredIosUi,
    workflows,
    registry,
  });
  const cliFiles = validateCliInventory({
    cliManifest,
    discoveredCliFiles,
    workflows,
  });

  return {
    sourceFiles: [...sourceFiles].sort(),
    workflowFiles: [...workflowFiles].sort(),
    manualFiles: [...manualFiles].sort(),
    manualScripts: rootScripts.manualScripts,
    swiftTargets,
    workflowIosUiTests: iosUi.workflowIosUiTests,
    manualIosUiTests: iosUi.manualIosUiTests,
    cliFiles,
    unitFiles: [...unitFiles.keys()].sort(),
    preservedFiles: [...preservedFiles.keys()].sort(),
    visitedScripts: source.visited,
    laneCounts: Object.fromEntries(
      (registry.lanes ?? []).map((lane) => [lane.name, lane.files.length]),
    ),
  };
}
