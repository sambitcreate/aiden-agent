import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { E2E_SHARD_COUNT, FILE_SECONDS } from "./ci-e2e-shards.mjs";
import { DEFAULT_SPEC_SECONDS, specWeight } from "./ci-e2e-timings.mjs";
import { PROJECT_ROOT } from "./ci-test-registry.mjs";

export const MACOS_E2E_SHARD_BUDGET_SECONDS = 900;
const E2E_WIRING_HUBS = new Set(["main/handlers/index.ts", "renderer/lib/ipc.ts"]);
const E2E_AGGREGATOR_IMPORT_LIMIT = 40;
const E2E_HIGH_FANOUT_IMPORTERS = 8;
const E2E_HIGH_FANOUT_SPECS = 25;

const SOURCE_ROOTS = Object.freeze(["main", "renderer", "scripts", "packages/cli"]);
const SOURCE_FILE = /\.(?:cjs|mjs|js|ts|tsx|json|css)$/u;
const TEST_FILE = /\.test\.(?:cjs|mjs|js|ts|tsx)$/u;
const IMPORT_SPEC =
  /(?:import|export)(?:\s+type)?(?:\s+[\w*{}\s,$.]+?)?\s+from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/gu;
const LOCK_FILE =
  /(?:^|\/)(?:[^/]+\.(?:lock|lockfile)|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?)$/u;
const CONFIG_FILE =
  /(?:^|\/)(?:[^/]*\.config\.[^/]+|(?:config|tsconfig)(?:\.[^/]+)?|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/u;
const ALIASES = Object.freeze([
  ["@renderer/", "renderer/"],
  ["@main/", "main/"],
  ["@shared/", "renderer/shared/"],
]);

function posix(file) {
  return file.replaceAll("\\", "/");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pathMatchesPrefix(file, prefix) {
  const pathName = posix(file);
  const needle = posix(prefix);
  if (pathName === needle) return true;
  if (!pathName.startsWith(needle)) return false;
  if (needle.endsWith("/") || needle.endsWith("-")) return true;
  const next = pathName[needle.length];
  return next === "/" || next === "." || next === "-";
}

export function prefixExistsOnDisk(prefix, root = PROJECT_ROOT) {
  const relative = posix(prefix);
  const absolute = path.join(root, relative);
  if (existsSync(absolute)) return true;
  const parentRel = relative.endsWith("/")
    ? relative.slice(0, -1)
    : relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : ".";
  const parent = path.join(root, parentRel);
  if (!existsSync(parent)) return false;
  try {
    return readdirSync(parent).some((name) => {
      const candidate = parentRel === "." ? name : `${parentRel}/${name}`;
      return pathMatchesPrefix(candidate, relative);
    });
  } catch {
    return false;
  }
}

export function readE2ESpecMap(filePath = path.join(PROJECT_ROOT, "scripts/ci-e2e-spec-map.json")) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function deterministicSpecs(specs) {
  return specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts");
}

function hostedRunnableSpecs(specs, map) {
  const hostOnly = new Set(Array.isArray(map?.hostOnly) ? map.hostOnly : []);
  return deterministicSpecs(specs).filter((file) => !hostOnly.has(file));
}

export function validateE2ESpecMap(specs, map = readE2ESpecMap(), options = {}) {
  if (!isRecord(map) || map.version !== 1 || !isRecord(map.specs) || !Array.isArray(map.full)) {
    throw new Error("E2E spec-to-source map is missing or malformed");
  }
  const runnable = deterministicSpecs(specs);
  const missing = runnable.filter((file) => !Array.isArray(map.specs[file]));
  if (missing.length > 0) {
    throw new Error(`E2E spec-to-source map is missing ${missing.join(", ")}`);
  }
  const unknown = Object.keys(map.specs).filter((file) => !specs.includes(file));
  if (unknown.length > 0) {
    throw new Error(`E2E spec-to-source map lists unknown specs ${unknown.join(", ")}`);
  }
  const hostOnly = map.hostOnly === undefined ? [] : map.hostOnly;
  if (
    !Array.isArray(hostOnly) ||
    hostOnly.some((file) => typeof file !== "string") ||
    new Set(hostOnly).size !== hostOnly.length
  ) {
    throw new Error("E2E spec-to-source map hostOnly list is malformed");
  }
  const unknownHostOnly = hostOnly.filter((file) => !runnable.includes(file));
  if (unknownHostOnly.length > 0) {
    throw new Error(`E2E spec-to-source map hostOnly list names unknown specs ${unknownHostOnly.join(", ")}`);
  }
  const macos = map.macos === undefined ? [] : map.macos;
  if (!Array.isArray(macos) || macos.some((file) => typeof file !== "string") || new Set(macos).size !== macos.length) {
    throw new Error("E2E spec-to-source map macos list is malformed");
  }
  const unknownMacos = macos.filter((file) => !runnable.includes(file));
  if (unknownMacos.length > 0) {
    throw new Error(`E2E spec-to-source map macos list names unknown specs ${unknownMacos.join(", ")}`);
  }
  const hostOnlyOverlap = macos.filter((file) => hostOnly.includes(file));
  if (hostOnlyOverlap.length > 0) {
    throw new Error(`E2E spec-to-source map lists specs in both macos and hostOnly: ${hostOnlyOverlap.join(", ")}`);
  }
  if (options.requireMatchingFiles) {
    const unmatched = [];
    for (const prefix of map.full) {
      if (!prefixExistsOnDisk(prefix, options.root)) unmatched.push(`full: ${prefix}`);
    }
    for (const [spec, prefixes] of Object.entries(map.specs)) {
      for (const prefix of prefixes) {
        if (!prefixExistsOnDisk(prefix, options.root)) unmatched.push(`${spec}: ${prefix}`);
      }
    }
    if (unmatched.length > 0) {
      throw new Error(`E2E spec-to-source map prefixes match no files: ${unmatched.join("; ")}`);
    }
  }
  return map;
}

function stripComments(source) {
  const text = String(source ?? "");
  let out = "";
  for (let index = 0; index < text.length; ) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      out += character;
      index += 1;
      while (index < text.length) {
        out += text[index];
        if (text[index] === "\\" && index + 1 < text.length) {
          out += text[index + 1];
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      out += " ";
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

export function parseImportSpecifiers(source) {
  const specifiers = [];
  IMPORT_SPEC.lastIndex = 0;
  const text = stripComments(String(source ?? ""));
  for (const match of text.matchAll(IMPORT_SPEC)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

// Older contract tests read production source as text instead of importing it, for
// example `readFileSync(new URL("./panel.tsx", import.meta.url))` or
// `resolve("main/services/x.ts")`. Treat any quoted path to a source file as a
// dependency, so changing that file still selects the test. Extra edges only run
// more tests; a missing edge would skip one.
const SOURCE_PATH_LITERAL = /["'`]((?:\.{1,2}\/|(?:main|renderer|packages\/cli)\/)[^"'`\s$]+\.(?:cjs|mjs|js|ts|tsx|json))["'`]/gu;

export function sourcePathReferences(fromFile, source, present) {
  const references = new Set();
  SOURCE_PATH_LITERAL.lastIndex = 0;
  for (const match of stripComments(String(source ?? "")).matchAll(SOURCE_PATH_LITERAL)) {
    const literal = match[1];
    const resolved = literal.startsWith(".")
      ? posix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), literal)))
      : posix(path.posix.normalize(literal));
    if (present.has(resolved)) references.add(resolved);
  }
  return [...references];
}

function skipSpace(text, index) {
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function parseQuoted(text, index) {
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\\") {
      value += text[cursor + 1] ?? "";
      cursor += 2;
      continue;
    }
    if (quote === "`" && character === "$" && text[cursor + 1] === "{") return null;
    if (character === quote) return { value, next: cursor + 1 };
    value += character;
    cursor += 1;
  }
  return null;
}

function parseIdentifier(text, index) {
  if (!/[\p{ID_Start}_$]/u.test(text[index] ?? "")) return null;
  let cursor = index + 1;
  while (cursor < text.length && /[\p{ID_Continue}$]/u.test(text[cursor])) cursor += 1;
  return { value: text.slice(index, cursor), next: cursor };
}

function parseMember(text, index) {
  const first = parseIdentifier(text, index);
  if (!first) return null;
  const parts = [first.value];
  let cursor = first.next;
  while (text[cursor] === ".") {
    const next = parseIdentifier(text, cursor + 1);
    if (!next) break;
    parts.push(next.value);
    cursor = next.next;
  }
  return { value: parts.join("."), next: cursor };
}

function parseArgList(text, index) {
  if (text[index] !== "(") return null;
  const args = [];
  let cursor = skipSpace(text, index + 1);
  if (text[cursor] === ")") return { args, next: cursor + 1 };
  while (cursor < text.length) {
    const argument = parseExpr(text, cursor);
    if (!argument) return null;
    args.push(argument.value);
    cursor = skipSpace(text, argument.next);
    if (text[cursor] === ")") return { args, next: cursor + 1 };
    if (text[cursor] !== ",") return null;
    cursor = skipSpace(text, cursor + 1);
  }
  return null;
}

function parseExpr(text, index) {
  const start = skipSpace(text, index);
  const quoted = parseQuoted(text, start);
  if (quoted) return quoted;
  const member = parseMember(text, start);
  if (!member) return null;
  const afterName = skipSpace(text, member.next);
  if (text[afterName] !== "(") return { value: { kind: "id", name: member.value }, next: member.next };
  const args = parseArgList(text, afterName);
  if (!args) return null;
  const callee = member.value.slice(member.value.lastIndexOf(".") + 1);
  return { value: { kind: "call", callee, args: args.args }, next: args.next };
}

function repoRelative(fromFile, resolved) {
  const normalized = posix(path.posix.normalize(resolved));
  if (normalized === "." || normalized === "") return "";
  if (normalized.startsWith("../")) return null;
  return normalized.replace(/^\.\//u, "");
}

function evalExpr(node, fromFile, bindings) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return null;
  if (node.kind === "id") {
    if (Object.hasOwn(bindings, node.name)) return bindings[node.name];
    if (node.name === "import.meta.url") return fromFile;
    return null;
  }
  if (node.kind !== "call") return null;
  const args = node.args.map((argument) => evalExpr(argument, fromFile, bindings));
  if (args.some((argument) => argument == null)) return null;
  if (node.callee === "fileURLToPath") return args[0] ?? fromFile;
  if (node.callee === "dirname") return posix(path.posix.dirname(String(args[0] ?? fromFile)));
  if (node.callee === "join" || node.callee === "resolve") {
    return repoRelative(fromFile, path.posix.join(...args.map(String)));
  }
  return null;
}

function collectBindings(fromFile, text) {
  const bindings = Object.create(null);
  const declaration = /(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?=\s*/gu;
  for (const match of text.matchAll(declaration)) {
    const parsed = parseExpr(text, match.index + match[0].length);
    if (!parsed) continue;
    const value = evalExpr(parsed.value, fromFile, bindings);
    if (typeof value === "string") bindings[match[1]] = value;
  }
  return bindings;
}

function collectCallSites(text) {
  const sites = [];
  const call = /\b(?:path(?:\.posix)?|posix)\s*\.\s*(join|resolve)\s*\(/gu;
  for (const match of text.matchAll(call)) {
    const parsed = parseArgList(text, match.index + match[0].length - 1);
    if (!parsed) continue;
    sites.push({ callee: match[1], args: parsed.args });
  }
  return sites;
}

function filesUnderPrefix(prefix, present) {
  const needle = posix(prefix);
  if (!needle || needle === ".") return [];
  return [...present].filter((file) => file !== needle && pathMatchesPrefix(file, needle));
}

// Contract tests walk production trees with readdir and build paths from
// path.join("renderer", "preload.ts") segments. Quoted-file matching cannot
// see those edges; extra edges only run more tests.
export function sourceWalkReferences(fromFile, source, present) {
  const text = stripComments(String(source ?? ""));
  const bindings = collectBindings(fromFile, text);
  const references = new Set();
  const walksDirectories = /\breaddir(?:Sync)?\s*\(/u.test(text);
  const consider = (resolved) => {
    if (typeof resolved !== "string" || resolved.length === 0) return;
    if (present.has(resolved)) {
      references.add(resolved);
      return;
    }
    if (!walksDirectories) return;
    if (!SOURCE_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))) return;
    for (const file of filesUnderPrefix(resolved, present)) references.add(file);
  };
  for (const value of Object.values(bindings)) consider(value);
  for (const site of collectCallSites(text)) {
    consider(evalExpr({ kind: "call", callee: site.callee, args: site.args }, fromFile, bindings));
  }
  references.delete(fromFile);
  return [...references];
}

function resolveAlias(specifier) {
  for (const [prefix, target] of ALIASES) {
    if (specifier.startsWith(prefix)) return `${target}${specifier.slice(prefix.length)}`;
  }
  return null;
}

function candidateFiles(resolved) {
  const withoutJs = resolved.replace(/\.js$/u, "");
  const stems = resolved.endsWith(".js") && withoutJs !== resolved ? [resolved, withoutJs] : [resolved];
  const files = [];
  for (const stem of stems) {
    files.push(stem);
    if (!SOURCE_FILE.test(stem)) {
      files.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${stem}.json`, `${stem}.css`);
    }
    files.push(
      `${stem}/index.ts`,
      `${stem}/index.tsx`,
      `${stem}/index.js`,
      `${stem}/index.mjs`,
      `${stem}/index.cjs`,
    );
  }
  return files;
}

export function resolveImportedPath(fromFile, specifier, present) {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  const alias = resolveAlias(specifier);
  const resolved = alias
    ?? (specifier.startsWith(".") ? posix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))) : null);
  if (!resolved || resolved.startsWith("../") || resolved.includes("/node_modules/")) return null;
  for (const candidate of candidateFiles(resolved.replace(/^\.\//u, ""))) {
    if (present.has(candidate)) return candidate;
  }
  return null;
}

export function companionTestFiles(file, present) {
  if (/\.test\.(?:cjs|mjs|js|ts|tsx)$/u.test(file)) return present.has(file) ? [file] : [];
  const stem = file.replace(/\.[^.]+$/u, "");
  return [".test.ts", ".test.tsx", ".test.mjs", ".test.js", ".test.cjs"]
    .map((suffix) => `${stem}${suffix}`)
    .filter((candidate) => present.has(candidate));
}

export function requiresFullUnit(pathName) {
  const file = posix(pathName);
  const baseName = file.slice(file.lastIndexOf("/") + 1);
  return (
    file.startsWith(".github/") ||
    (file.startsWith("scripts/") && !TEST_FILE.test(file)) ||
    /\.(?:css|html|svg|png|jpe?g|webp)$/iu.test(file) ||
    LOCK_FILE.test(file) ||
    CONFIG_FILE.test(file) ||
    baseName === "package.json" ||
    baseName === "package-lock.json"
  );
}

export function requiresFullE2E(pathName, map = readE2ESpecMap()) {
  const file = posix(pathName);
  if (requiresFullUnit(file)) return true;
  if (file.startsWith("tests/e2e/") && !file.endsWith(".spec.ts")) return true;
  return (map.full ?? []).some((prefix) => pathMatchesPrefix(file, prefix));
}

function isScannedPath(file) {
  return SOURCE_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

export function listSourceFiles(root = PROJECT_ROOT) {
  const files = [];
  for (const directory of SOURCE_ROOTS) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
      const file = posix(path.relative(root, path.join(entry.parentPath, entry.name)));
      if (file.split("/").includes("node_modules")) continue;
      files.push(file);
    }
  }
  return files.sort();
}

export function buildReverseImportGraph(files, readFile) {
  const uniqueFiles = [...new Set(files)];
  const present = new Set(uniqueFiles);
  const importers = new Map();
  const dependencyCount = new Map();
  for (const file of uniqueFiles) {
    importers.set(file, []);
    dependencyCount.set(file, 0);
  }
  for (const file of uniqueFiles) {
    let source = "";
    try {
      source = readFile(file);
    } catch {
      continue;
    }
    const dependencies = new Set([
      ...sourcePathReferences(file, source, present),
      ...sourceWalkReferences(file, source, present),
    ]);
    for (const specifier of parseImportSpecifiers(source)) {
      const imported = resolveImportedPath(file, specifier, present);
      if (imported) dependencies.add(imported);
    }
    dependencies.delete(file);
    dependencyCount.set(file, dependencies.size);
    for (const imported of dependencies) {
      const list = importers.get(imported);
      if (list) list.push(file);
      else importers.set(imported, [file]);
    }
  }
  return { present, importers, dependencyCount };
}

const DEFAULT_READ_FILE = (file) => readFileSync(path.join(PROJECT_ROOT, file), "utf8");
let cachedDefaultSourceFiles = null;
let cachedDefaultE2EGraph = null;
const cachedDefaultSpecLinuxActive = new Map();

function getDefaultSourceFiles() {
  if (!cachedDefaultSourceFiles) {
    cachedDefaultSourceFiles = Object.freeze(listSourceFiles());
  }
  return cachedDefaultSourceFiles;
}

function isProductionE2ESourceFile(file) {
  return !TEST_FILE.test(file) && !file.startsWith("scripts/");
}

function getE2EReverseImportGraph(sourceFiles, readFile) {
  const usingDefaults =
    (sourceFiles === undefined || sourceFiles === cachedDefaultSourceFiles) &&
    (readFile === undefined || readFile === DEFAULT_READ_FILE);
  if (usingDefaults) {
    if (!cachedDefaultE2EGraph) {
      const prodFiles = getDefaultSourceFiles().filter(isProductionE2ESourceFile);
      cachedDefaultE2EGraph = buildReverseImportGraph(prodFiles, DEFAULT_READ_FILE);
    }
    return cachedDefaultE2EGraph;
  }
  const reader = readFile ?? DEFAULT_READ_FILE;
  const prodFiles = (sourceFiles ?? getDefaultSourceFiles()).map(posix).filter(isProductionE2ESourceFile);
  return buildReverseImportGraph(prodFiles, reader);
}

const UNKNOWN = Symbol("unknown");

function skipStringLiteral(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\" && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

function findMatchingDelimiter(text, openIndex) {
  const open = text[openIndex];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 1;
  for (let cursor = openIndex + 1; cursor < text.length; ) {
    const ch = text[cursor];
    if (ch === '"' || ch === "'" || ch === "`") {
      cursor = skipStringLiteral(text, cursor);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function splitTopLevelArgs(argText) {
  const args = [];
  let start = 0;
  for (let cursor = 0; cursor < argText.length; ) {
    const ch = argText[cursor];
    if (ch === '"' || ch === "'" || ch === "`") {
      cursor = skipStringLiteral(argText, cursor);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      const close = findMatchingDelimiter(argText, cursor);
      cursor = close === -1 ? argText.length : close + 1;
      continue;
    }
    if (ch === ",") {
      args.push(argText.slice(start, cursor).trim());
      start = cursor + 1;
    }
    cursor += 1;
  }
  const tail = argText.slice(start).trim();
  if (tail.length > 0) args.push(tail);
  return args;
}

function stripTrailingTypeAssertion(expr) {
  return expr.replace(/\s+as\s+const\s*$/u, "").trim();
}

function tokenizePlatformExpr(expr) {
  const text = stripTrailingTypeAssertion(expr);
  const tokens = [];
  for (let cursor = 0; cursor < text.length; ) {
    if (/\s/u.test(text[cursor])) {
      cursor += 1;
      continue;
    }
    const three = text.slice(cursor, cursor + 3);
    if (three === "===" || three === "!==") {
      tokens.push({ kind: "op", value: three });
      cursor += 3;
      continue;
    }
    const two = text.slice(cursor, cursor + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      tokens.push({ kind: "op", value: two });
      cursor += 2;
      continue;
    }
    const ch = text[cursor];
    if (ch === "!" || ch === "?" || ch === ":" || ch === "(" || ch === ")") {
      tokens.push({ kind: ch, value: ch });
      cursor += 1;
      continue;
    }
    if (ch === "[" || ch === "{") {
      const close = findMatchingDelimiter(text, cursor);
      if (close === -1) return null;
      const inner = text.slice(cursor + 1, close).trim();
      tokens.push({ kind: "collection", empty: inner.length === 0 });
      cursor = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseQuoted(text, cursor);
      if (!parsed) {
        const end = skipStringLiteral(text, cursor);
        tokens.push({ kind: "unknown" });
        cursor = end;
        continue;
      }
      tokens.push({ kind: "string", value: parsed.value });
      cursor = parsed.next;
      continue;
    }
    const member = parseMember(text, cursor);
    if (member) {
      let next = skipSpace(text, member.next);
      if (text[next] === "(") {
        const close = findMatchingDelimiter(text, next);
        next = close === -1 ? text.length : close + 1;
        tokens.push({ kind: "call", name: member.value });
        cursor = next;
        continue;
      }
      if (member.value === "as") {
        // Ignore TypeScript `as ...` type assertions inside parenthesized sub-expressions.
        while (cursor < text.length && text[cursor] !== ")" && text[cursor] !== ":" && text[cursor] !== "?") {
          cursor += 1;
        }
        continue;
      }
      tokens.push({ kind: "member", value: member.value });
      cursor = member.next;
      continue;
    }
    tokens.push({ kind: "unknown" });
    cursor += 1;
  }
  return tokens;
}

function kleeneNot(value) {
  if (typeof value === "boolean") return !value;
  return UNKNOWN;
}

function kleeneAnd(left, right) {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return UNKNOWN;
}

function kleeneOr(left, right) {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return UNKNOWN;
}

function evaluatePlatformExpr(expr, env) {
  const tokens = tokenizePlatformExpr(expr);
  if (!tokens || tokens.length === 0) return UNKNOWN;
  let index = 0;

  const parsePrimary = () => {
    const token = tokens[index];
    if (!token) return UNKNOWN;
    if (token.kind === "(") {
      index += 1;
      const inner = parseConditional();
      if (tokens[index]?.kind === ")") index += 1;
      return inner;
    }
    if (token.kind === "string") {
      index += 1;
      return token.value;
    }
    if (token.kind === "collection") {
      index += 1;
      return { emptyCollection: token.empty };
    }
    if (token.kind === "member") {
      index += 1;
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "undefined") return undefined;
      if (token.value === "process.platform") return env.platform;
      if (token.value === "process.arch") return env.arch ?? "arm64";
      if (token.value.startsWith("process.env.")) {
        const key = token.value.slice("process.env.".length);
        return env.hostEnv?.[key];
      }
      if (env.bindings?.has(token.value)) return env.bindings.get(token.value);
      return UNKNOWN;
    }
    index += 1;
    return UNKNOWN;
  };

  const parseUnary = () => {
    if (tokens[index]?.kind === "!") {
      index += 1;
      return kleeneNot(parseUnary());
    }
    return parsePrimary();
  };

  const parseEquality = () => {
    let left = parseUnary();
    while (tokens[index]?.kind === "op" && ["===", "!==", "==", "!="].includes(tokens[index].value)) {
      const op = tokens[index].value;
      index += 1;
      const right = parseUnary();
      if (
        left === UNKNOWN ||
        right === UNKNOWN ||
        isRecord(left) ||
        isRecord(right)
      ) {
        left = UNKNOWN;
      } else {
        const equal = op === "===" || op === "==" ? left === right : left !== right;
        left = equal;
      }
    }
    return left;
  };

  const parseLogicalAnd = () => {
    let left = parseEquality();
    while (tokens[index]?.kind === "op" && tokens[index].value === "&&") {
      index += 1;
      const right = parseEquality();
      left = kleeneAnd(left, right);
    }
    return left;
  };

  const parseLogicalOr = () => {
    let left = parseLogicalAnd();
    while (tokens[index]?.kind === "op" && tokens[index].value === "||") {
      index += 1;
      const right = parseLogicalAnd();
      left = kleeneOr(left, right);
    }
    return left;
  };

  const parseConditional = () => {
    const cond = parseLogicalOr();
    if (tokens[index]?.kind !== "?") return cond;
    index += 1;
    const whenTrue = parseConditional();
    if (tokens[index]?.kind !== ":") return UNKNOWN;
    index += 1;
    const whenFalse = parseConditional();
    if (cond === true) return whenTrue;
    if (cond === false) return whenFalse;
    return UNKNOWN;
  };

  return parseConditional();
}

function collectPlatformBindings(strippedSource, env) {
  const bindings = new Map();
  const fullEnv = { ...env, bindings };
  const decl = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+);/gu;
  for (const match of strippedSource.matchAll(decl)) {
    const value = evaluatePlatformExpr(match[2], fullEnv);
    if (typeof value === "boolean" || typeof value === "string") {
      bindings.set(match[1], value);
    }
  }
  return bindings;
}

function looksLikeFunctionArg(argText) {
  return /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/su.test(argText.trim()) ||
    /^(?:async\s+)?function\b/u.test(argText.trim());
}

function findCallbackBlock(text, openParen, closeParen) {
  let best = null;
  for (let cursor = openParen + 1; cursor < closeParen; ) {
    const ch = text[cursor];
    if (ch === '"' || ch === "'" || ch === "`") {
      cursor = skipStringLiteral(text, cursor);
      continue;
    }
    if (ch === "{") {
      const end = findMatchingDelimiter(text, cursor);
      if (end !== -1 && end < closeParen && (!best || end > best.end)) {
        best = { start: cursor, end };
      }
      cursor = end === -1 ? closeParen : end + 1;
      continue;
    }
    cursor += 1;
  }
  return best;
}

function evaluateSkipCallOnHostedLinux(argText, linuxEnv) {
  const args = splitTopLevelArgs(argText);
  if (args.length === 0) return { isTestDeclaration: false, skippedOnLinux: true };
  if (args.length >= 2 && looksLikeFunctionArg(args.at(-1))) {
    return { isTestDeclaration: true, skippedOnLinux: true };
  }
  const condValue = evaluatePlatformExpr(args[0], linuxEnv);
  return { isTestDeclaration: false, skippedOnLinux: condValue === true };
}

function analyzeSpecSourceForLinux(source) {
  const text = stripComments(String(source ?? ""));
  const linuxEnv = { platform: "linux", hostEnv: {} };
  linuxEnv.bindings = collectPlatformBindings(text, linuxEnv);

  const scopeSkips = [];
  for (const match of text.matchAll(/\btest\.skip\s*\(/gu)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingDelimiter(text, openParen);
    if (closeParen === -1) continue;
    const info = evaluateSkipCallOnHostedLinux(text.slice(openParen + 1, closeParen), linuxEnv);
    if (!info.isTestDeclaration && info.skippedOnLinux) {
      // Determine the innermost `{ ... }` block enclosing this `test.skip(...)` call (or full file).
      let enclosingStart = 0;
      let enclosingEnd = text.length;
      for (let cursor = 0; cursor < match.index; ) {
        const ch = text[cursor];
        if (ch === '"' || ch === "'" || ch === "`") {
          cursor = skipStringLiteral(text, cursor);
          continue;
        }
        if (ch === "{") {
          const end = findMatchingDelimiter(text, cursor);
          if (end > match.index) {
            enclosingStart = cursor;
            enclosingEnd = end;
          }
        }
        cursor += 1;
      }
      scopeSkips.push({ pos: match.index, enclosingStart, enclosingEnd });
    }
  }

  const testCalls = [];
  for (const match of text.matchAll(/\btest(?:\.only)?\s*\(/gu)) {
    const before = text[match.index - 1] ?? "";
    if (/[\w$.]/u.test(before)) continue;
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingDelimiter(text, openParen);
    if (closeParen === -1) continue;
    const callback = findCallbackBlock(text, openParen, closeParen);
    testCalls.push({ start: match.index, end: closeParen, callback });
  }

  if (testCalls.length === 0) {
    const hasOnlySkippedDeclarations = /\btest\.(?:skip|fixme)\s*\(/u.test(text);
    return !hasOnlySkippedDeclarations;
  }

  let activeTests = 0;
  for (const testCall of testCalls) {
    const skippedByOuterScope = scopeSkips.some(
      (skip) =>
        skip.enclosingStart <= testCall.start &&
        skip.enclosingEnd >= testCall.end &&
        !(testCall.callback && skip.pos > testCall.callback.start && skip.pos < testCall.callback.end),
    );
    if (skippedByOuterScope) continue;
    const skippedInsideCallback =
      testCall.callback !== null &&
      scopeSkips.some(
        (skip) =>
          skip.enclosingStart === testCall.callback.start &&
          skip.enclosingEnd === testCall.callback.end,
      );
    if (skippedInsideCallback) continue;
    activeTests += 1;
  }
  return activeTests > 0;
}

function readSpecText(relativePath, readFile) {
  const normalized = posix(relativePath);
  if (readFile && readFile !== DEFAULT_READ_FILE) {
    try {
      const content = readFile(normalized);
      if (typeof content === "string") return content;
    } catch {
      // Fall back to the workspace file when a test fixture only stubs `main/` or `renderer/`.
    }
  }
  const absolute = path.join(PROJECT_ROOT, normalized);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, "utf8");
}

export function specHasActiveLinuxTests(specFile, readFile) {
  const spec = posix(specFile).replace(/^tests\/e2e\//u, "");
  const usingDefaultReader = readFile === undefined || readFile === DEFAULT_READ_FILE;
  if (usingDefaultReader && cachedDefaultSpecLinuxActive.has(spec)) {
    return cachedDefaultSpecLinuxActive.get(spec);
  }
  const source = readSpecText(`tests/e2e/${spec}`, readFile);
  if (source === null) return true;
  const active = analyzeSpecSourceForLinux(source);
  if (usingDefaultReader) cachedDefaultSpecLinuxActive.set(spec, active);
  return active;
}

function sourceHasDarwinDivergence(source) {
  const text = stripComments(String(source ?? ""));
  if (/\bisolatedKeychain\s*:\s*true\b/u.test(text)) return true;

  const linuxEnv = { platform: "linux", hostEnv: {} };
  linuxEnv.bindings = collectPlatformBindings(text, linuxEnv);
  const darwinHostEnv = { platform: "darwin", hostEnv: { AIDEN_E2E_COMPUTER_USE_HOST: "1" } };
  darwinHostEnv.bindings = collectPlatformBindings(text, darwinHostEnv);
  const darwinHostedEnv = { platform: "darwin", hostEnv: {} };
  darwinHostedEnv.bindings = collectPlatformBindings(text, darwinHostedEnv);

  // 1. Any test.skip(...) that skips on Linux while running on darwin (hosted or host-permissioned).
  for (const match of text.matchAll(/\btest\.skip\s*\(/gu)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingDelimiter(text, openParen);
    if (closeParen === -1) continue;
    const args = splitTopLevelArgs(text.slice(openParen + 1, closeParen));
    if (args.length === 0 || (args.length >= 2 && looksLikeFunctionArg(args.at(-1)))) continue;
    const onLinux = evaluatePlatformExpr(args[0], linuxEnv);
    const onDarwin = evaluatePlatformExpr(args[0], darwinHostEnv);
    if (onLinux === true && onDarwin === false) return true;
  }

  // 2. Any `if (...)` branch that runs assertions/checks on darwin that Linux skips.
  for (const match of text.matchAll(/\bif\s*\(/gu)) {
    const before = text[match.index - 1] ?? "";
    if (/[\w$.]/u.test(before)) continue;
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingDelimiter(text, openParen);
    if (closeParen === -1) continue;
    const condExpr = text.slice(openParen + 1, closeParen);
    const onLinux = evaluatePlatformExpr(condExpr, linuxEnv);
    const onDarwin = evaluatePlatformExpr(condExpr, darwinHostedEnv);
    if (typeof onLinux !== "boolean" || typeof onDarwin !== "boolean" || onLinux === onDarwin) continue;
    if (onDarwin === true && onLinux === false) return true;
    // `onLinux === true && onDarwin === false`: check for `else` branch or bare `return;` aborting test early on Linux.
    const afterCond = skipSpace(text, closeParen + 1);
    let bodyText = "";
    let afterBody = afterCond;
    if (text[afterCond] === "{") {
      const closeBrace = findMatchingDelimiter(text, afterCond);
      if (closeBrace !== -1) {
        bodyText = text.slice(afterCond + 1, closeBrace);
        afterBody = skipSpace(text, closeBrace + 1);
      }
    } else {
      const semi = text.indexOf(";", afterCond);
      if (semi !== -1) {
        bodyText = text.slice(afterCond, semi + 1);
        afterBody = skipSpace(text, semi + 1);
      }
    }
    if (/^else\b/u.test(text.slice(afterBody)) || /\breturn\s*;/u.test(bodyText)) {
      return true;
    }
  }

  // 3. Any spread `...(cond ? a : b)` that omits array items or object assertions on Linux while keeping them on darwin.
  for (const match of text.matchAll(/\.\.\.\s*\(/gu)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingDelimiter(text, openParen);
    if (closeParen === -1) continue;
    const spreadExpr = text.slice(openParen + 1, closeParen);
    const onLinux = evaluatePlatformExpr(spreadExpr, linuxEnv);
    const onDarwin = evaluatePlatformExpr(spreadExpr, darwinHostedEnv);
    if (onLinux?.emptyCollection === true && onDarwin !== UNKNOWN && onDarwin?.emptyCollection !== true) {
      return true;
    }
  }

  return false;
}

export function isDarwinDivergentE2ESpec(specFile, { readFile } = {}) {
  const spec = posix(specFile).replace(/^tests\/e2e\//u, "");
  if (!spec.endsWith(".spec.ts") || spec.endsWith(".live.spec.ts") || spec === "diagnostics-production.spec.ts") {
    return false;
  }
  const specPath = `tests/e2e/${spec}`;
  const specSource = readSpecText(specPath, readFile);
  if (specSource === null) return false;
  if (sourceHasDarwinDivergence(specSource)) return true;

  const companionPaths = new Set([`tests/e2e/${spec.slice(0, -".spec.ts".length)}-native.ts`]);
  const specDir = path.posix.dirname(specPath);
  for (const match of stripComments(specSource).matchAll(/["'`]([^"'`\s$]*-native\.(?:ts|mts|mjs|js))["'`]/gu)) {
    const ref = match[1];
    const resolved = ref.startsWith(".") || !ref.startsWith("tests/")
      ? posix(path.posix.normalize(path.posix.join(specDir, ref)))
      : posix(path.posix.normalize(ref));
    companionPaths.add(resolved);
  }
  for (const companion of companionPaths) {
    const companionSource = readSpecText(companion, readFile);
    if (companionSource !== null && sourceHasDarwinDivergence(companionSource)) return true;
  }
  return false;
}

export function selectRelatedUnitFiles({
  changedPaths,
  testFiles,
  sourceFiles,
  readFile,
} = {}) {
  const changed = [...new Set((changedPaths ?? []).map(posix))];
  const tests = [...new Set((testFiles ?? []).map(posix))];
  if (changed.length === 0) return { mode: "all", reason: "invalid-path-list", files: tests };
  if (changed.some((file) => requiresFullUnit(file))) {
    return { mode: "all", reason: "infrastructure", files: tests };
  }
  if (changed.some((file) => !isScannedPath(file) && !tests.includes(file))) {
    return { mode: "all", reason: "unmapped-path", files: tests };
  }

  const graphFiles = [...new Set([...(sourceFiles ?? []), ...tests])];
  const { present, importers } = buildReverseImportGraph(graphFiles, readFile);
  const reachable = new Set();
  const queue = [];
  for (const file of changed) {
    if (!present.has(file) && !tests.includes(file)) {
      return { mode: "all", reason: "unmapped-path", files: tests };
    }
    queue.push(file);
    for (const companion of companionTestFiles(file, present)) queue.push(companion);
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const importer of importers.get(file) ?? []) queue.push(importer);
  }

  const files = tests.filter((file) => reachable.has(file) || changed.includes(file)).sort();
  if (files.length === 0) return { mode: "all", reason: "unmapped-path", files: tests };
  return { mode: "related", reason: "related", files };
}

export function selectRelatedE2ESpecs({
  changedPaths,
  specs,
  sourceFiles,
  readFile,
  map = readE2ESpecMap(),
} = {}) {
  const changed = [...new Set((changedPaths ?? []).map(posix))];
  const discovered = [...new Set((specs ?? []).map(posix))];
  validateE2ESpecMap(discovered, map);
  const hostOnly = new Set(map.hostOnly ?? []);
  const runnable = hostedRunnableSpecs(discovered, map);
  if (changed.length === 0) return { mode: "all", reason: "invalid-path-list", specs: runnable };
  if (changed.some((file) => requiresFullE2E(file, map))) {
    return { mode: "all", reason: "infrastructure", specs: runnable };
  }

  const { importers, dependencyCount } = getE2EReverseImportGraph(sourceFiles, readFile);
  const isStopNode = (candidate) =>
    requiresFullE2E(candidate, map) ||
    E2E_WIRING_HUBS.has(candidate) ||
    (dependencyCount.get(candidate) ?? 0) >= E2E_AGGREGATOR_IMPORT_LIMIT;

  const selected = new Set();
  for (const file of changed) {
    if (file.startsWith("tests/e2e/") && file.endsWith(".spec.ts")) {
      const spec = file.slice("tests/e2e/".length);
      if (!hostOnly.has(spec) && runnable.includes(spec)) selected.add(spec);
      continue;
    }
    if ((importers.get(file)?.length ?? 0) >= E2E_HIGH_FANOUT_IMPORTERS) {
      return { mode: "all", reason: "high-fanout", specs: runnable };
    }
    const expanded = new Set([file]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const importer of importers.get(current) ?? []) {
        if (expanded.has(importer) || isStopNode(importer)) continue;
        expanded.add(importer);
        queue.push(importer);
      }
    }
    const matches = new Set();
    for (const candidate of expanded) {
      for (const [spec, prefixes] of Object.entries(map.specs)) {
        if (hostOnly.has(spec) || !runnable.includes(spec)) continue;
        if (prefixes.some((prefix) => pathMatchesPrefix(candidate, prefix))) {
          matches.add(spec);
        }
      }
    }
    if (matches.size === 0) {
      return { mode: "all", reason: "unmapped-path", specs: runnable };
    }
    if (matches.size >= E2E_HIGH_FANOUT_SPECS) {
      return { mode: "all", reason: "high-fanout", specs: runnable };
    }
    for (const spec of matches) selected.add(spec);
  }
  const specsSelected = runnable.filter((file) => selected.has(file));
  if (specsSelected.length === 0) {
    return { mode: "all", reason: "unmapped-path", specs: runnable };
  }
  if (!specsSelected.some((spec) => specHasActiveLinuxTests(spec, readFile))) {
    return { mode: "all", reason: "no-active-linux-specs", specs: runnable };
  }
  return { mode: "related", reason: "related", specs: specsSelected };
}

export function selectReachableTests({
  eventName,
  changedPaths,
  testFiles,
  specs,
  sourceFiles,
  readFile,
  map,
} = {}) {
  const specMap = map ?? readE2ESpecMap();
  if (eventName !== "pull_request") {
    return {
      reason: eventName === "push" || eventName === "merge_group" ? "forced-full" : "non-pull-request",
      unit: { mode: "all", reason: "forced-full", files: testFiles ?? [] },
      e2e: { mode: "all", reason: "forced-full", specs: hostedRunnableSpecs(specs ?? [], specMap) },
    };
  }
  const reader = readFile ?? DEFAULT_READ_FILE;
  const sources = sourceFiles ?? getDefaultSourceFiles();
  return {
    reason: "related",
    unit: selectRelatedUnitFiles({ changedPaths, testFiles, sourceFiles: sources, readFile: reader }),
    e2e: selectRelatedE2ESpecs({ changedPaths, specs, sourceFiles: sources, readFile: reader, map: specMap }),
  };
}

// macOS runners are the scarce CI resource, so pull requests run on Mac shards
// only the specs in the map's `macos` list (the ones that skip or assert less
// off macOS) that the PR selected, scaling past one shard when their planned
// runtime exceeds the 900s net budget; Linux shards run every selected spec.
// Every other event keeps the full suite across E2E_SHARD_COUNT macOS shards.
export function planMacE2E({
  eventName,
  desktop,
  e2e,
  map = readE2ESpecMap(),
  shardCount,
  weights,
  recorded,
  fallback = FILE_SECONDS,
  defaultSeconds = DEFAULT_SPEC_SECONDS,
} = {}) {
  if (desktop !== true) return { run: false, scope: "none", shards: [], specs: [] };
  if (eventName !== "pull_request") {
    if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("Invalid macOS E2E shard count");
    return { run: true, scope: "all", shards: Array.from({ length: shardCount }, (_, index) => index + 1), specs: [] };
  }
  const maxShards = shardCount ?? E2E_SHARD_COUNT;
  if (!Number.isInteger(maxShards) || maxShards < 1) throw new Error("Invalid macOS E2E shard count");
  const hostOnly = new Set(map.hostOnly ?? []);
  const wanted = new Set(Array.isArray(e2e?.specs) ? e2e.specs : []);
  const specs = (map.macos ?? []).filter((file) => !hostOnly.has(file) && wanted.has(file));
  if (specs.length === 0) return { run: false, scope: "none", shards: [], specs: [] };
  const weightOverrides = recorded ?? weights ?? {};
  const plannedSeconds = specs.reduce(
    (total, file) => total + specWeight(file, weightOverrides, fallback, defaultSeconds),
    0,
  );
  const count = Math.min(maxShards, Math.max(1, Math.ceil(plannedSeconds / MACOS_E2E_SHARD_BUDGET_SECONDS)));
  return {
    run: true,
    scope: "macos",
    shards: Array.from({ length: count }, (_, index) => index + 1),
    specs,
  };
}
