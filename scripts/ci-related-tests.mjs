import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./ci-test-registry.mjs";

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

export function validateE2ESpecMap(specs, map = readE2ESpecMap(), options = {}) {
  if (!isRecord(map) || map.version !== 1 || !isRecord(map.specs) || !Array.isArray(map.full)) {
    throw new Error("E2E spec-to-source map is missing or malformed");
  }
  const runnable = specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts");
  const missing = runnable.filter((file) => !Array.isArray(map.specs[file]));
  if (missing.length > 0) {
    throw new Error(`E2E spec-to-source map is missing ${missing.join(", ")}`);
  }
  const unknown = Object.keys(map.specs).filter((file) => !specs.includes(file));
  if (unknown.length > 0) {
    throw new Error(`E2E spec-to-source map lists unknown specs ${unknown.join(", ")}`);
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
  const present = new Set(files);
  const importers = new Map();
  for (const file of files) importers.set(file, []);
  for (const file of files) {
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
    for (const imported of dependencies) {
      if (imported === file) continue;
      const list = importers.get(imported);
      if (list) list.push(file);
      else importers.set(imported, [file]);
    }
  }
  return { present, importers };
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
  map = readE2ESpecMap(),
} = {}) {
  const changed = [...new Set((changedPaths ?? []).map(posix))];
  const discovered = [...new Set((specs ?? []).map(posix))];
  const runnable = discovered.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts");
  validateE2ESpecMap(discovered, map);
  if (changed.length === 0) return { mode: "all", reason: "invalid-path-list", specs: runnable };
  if (changed.some((file) => requiresFullE2E(file, map))) {
    return { mode: "all", reason: "infrastructure", specs: runnable };
  }

  const selected = new Set();
  for (const file of changed) {
    if (file.startsWith("tests/e2e/") && file.endsWith(".spec.ts")) {
      const spec = file.slice("tests/e2e/".length);
      if (runnable.includes(spec)) selected.add(spec);
      continue;
    }
    const matches = Object.entries(map.specs)
      .filter(([, prefixes]) => prefixes.some((prefix) => pathMatchesPrefix(file, prefix)))
      .map(([spec]) => spec);
    if (matches.length === 0) {
      return { mode: "all", reason: "unmapped-path", specs: runnable };
    }
    for (const spec of matches) selected.add(spec);
  }
  const specsSelected = runnable.filter((file) => selected.has(file));
  if (specsSelected.length === 0) {
    return { mode: "all", reason: "unmapped-path", specs: runnable };
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
  if (eventName !== "pull_request") {
    return {
      reason: eventName === "push" || eventName === "merge_group" ? "forced-full" : "non-pull-request",
      unit: { mode: "all", reason: "forced-full", files: testFiles ?? [] },
      e2e: { mode: "all", reason: "forced-full", specs: (specs ?? []).filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts") },
    };
  }
  const reader = readFile ?? ((file) => readFileSync(path.join(PROJECT_ROOT, file), "utf8"));
  const sources = sourceFiles ?? listSourceFiles();
  return {
    reason: "related",
    unit: selectRelatedUnitFiles({ changedPaths, testFiles, sourceFiles: sources, readFile: reader }),
    e2e: selectRelatedE2ESpecs({ changedPaths, specs, map }),
  };
}
