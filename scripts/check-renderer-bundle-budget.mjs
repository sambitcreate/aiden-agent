/* global console, process */
/**
 * Fails when the JavaScript closure the main window must load before first
 * paint (entry scripts, modulepreload tags, transitive static ESM imports, and
 * unconditional Vite __vite__mapDeps preloads) grows past the budget. Lazy
 * chunks are not counted: moving code behind a dynamic import is the intended
 * fix.
 *
 *   npm run build && npm run check:bundle-budget
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// About 3 % above the measured main-window initial JS closure after deferring
// secondary surfaces. Raise it deliberately, with a reason in the PR, rather
// than to make CI pass.
export const MAIN_WINDOW_INITIAL_JS_BUDGET = Object.freeze({ raw: 2_735_000, gzip: 880_000 });

const TAG = /<(script|link)\b[^>]*>/giu;
const REMOTE_URL = /^[a-z][a-z0-9+.-]*:/iu;
const JS_FILE = /\.(?:m?js|cjs)$/iu;
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "iu"))?.[1];

/** Lists the scripts an HTML entry loads eagerly: module scripts and modulepreloads. */
export function initialScripts(html) {
  const scripts = [];
  for (const [tag, element] of html.matchAll(TAG)) {
    const source = element.toLowerCase() === "script"
      ? attribute(tag, "src")
      : attribute(tag, "rel")?.toLowerCase() === "modulepreload" ? attribute(tag, "href") : undefined;
    if (source && !REMOTE_URL.test(source) && !scripts.includes(source)) scripts.push(source);
  }
  return scripts;
}

function isFunctionBoundary(node) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return true;
  }
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
  // Unwrap parenthesized IIFEs such as `(() => { ... })()`.
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return !(current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current);
}

function stringElements(arrayLiteral) {
  const values = [];
  for (const element of arrayLiteral.elements) {
    if (ts.isStringLiteralLike(element)) values.push(element.text);
  }
  return values;
}

function collectMapDepsTables(sourceFile) {
  const tables = new Map();
  const findAssignedArray = (node) => {
    let found = null;
    const visit = (child) => {
      if (found) return;
      if (
        ts.isBinaryExpression(child) &&
        child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isArrayLiteralExpression(child.right)
      ) {
        const items = stringElements(child.right);
        if (items.length > 0) {
          found = items;
          return;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const items = findAssignedArray(statement);
      if (items) tables.set(statement.name.text, items);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrayLiteralExpression(declaration.initializer)) {
        const items = stringElements(declaration.initializer);
        if (items.length > 0) tables.set(declaration.name.text, items);
      } else if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        const items = findAssignedArray(declaration.initializer);
        if (items) tables.set(declaration.name.text, items);
      }
    }
  }
  return tables;
}

function collectDynamicImportsInLoader(loaderNode, out) {
  const visit = (node) => {
    if (node !== loaderNode && isFunctionBoundary(node)) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(loaderNode);
}

/**
 * Extracts JS/asset specifiers unconditionally evaluated or preloaded when a
 * bundled ES module loads: static `import`/`export ... from` declarations,
 * top-level `import(...)` calls, and top-level Vite `__vitePreload` /
 * `__vite__mapDeps` lists. Dynamic imports inside lazy callbacks are ignored.
 */
function unconditionalModuleDependencies(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const mapDepsTables = collectMapDepsTables(sourceFile);
  const specifiers = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  const resolveDepsArgument = (arg) => {
    if (ts.isConditionalExpression(arg)) {
      resolveDepsArgument(arg.whenTrue);
      resolveDepsArgument(arg.whenFalse);
      return;
    }
    if (ts.isArrayLiteralExpression(arg)) {
      specifiers.push(...stringElements(arg));
      return;
    }
    if (
      ts.isCallExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      mapDepsTables.has(arg.expression.text) &&
      arg.arguments.length > 0 &&
      ts.isArrayLiteralExpression(arg.arguments[0])
    ) {
      const table = mapDepsTables.get(arg.expression.text);
      for (const element of arg.arguments[0].elements) {
        if (ts.isNumericLiteral(element)) {
          const entry = table[Number(element.text)];
          if (entry) specifiers.push(entry);
        }
      }
    }
  };

  const walkUnconditional = (node) => {
    if (isFunctionBoundary(node)) return;
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.push(node.arguments[0].text);
      } else if (
        ts.isIdentifier(node.expression) &&
        mapDepsTables.has(node.expression.text)
      ) {
        resolveDepsArgument(node);
      } else if (
        node.arguments.length >= 2 &&
        (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
      ) {
        // Top-level Vite preload helper call: `__vitePreload(() => import("./app.js"), deps, ...)`.
        const beforeCount = specifiers.length;
        resolveDepsArgument(node.arguments[1]);
        if (
          specifiers.length > beforeCount ||
          (node.arguments.length >= 3 && ts.isMetaProperty(node.arguments[2]))
        ) {
          collectDynamicImportsInLoader(node.arguments[0], specifiers);
        }
      }
    }
    ts.forEachChild(node, walkUnconditional);
  };

  for (const statement of sourceFile.statements) walkUnconditional(statement);
  return specifiers;
}

function cleanSpecifierPath(specifier) {
  return specifier.split(/[?#]/u, 1)[0] ?? "";
}

function formatRelativeSource(htmlDir, targetPath) {
  const relative = path.relative(htmlDir, targetPath).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export async function measureInitialJavaScript(htmlPath) {
  const htmlDir = path.dirname(path.resolve(htmlPath));
  const html = await readFile(htmlPath, "utf8");
  const queue = [];
  const queued = new Set();

  const enqueue = (specifier, baseDir) => {
    if (!specifier || REMOTE_URL.test(specifier)) return;
    const cleaned = cleanSpecifierPath(specifier);
    if (!cleaned || !JS_FILE.test(cleaned)) return;
    if (baseDir !== htmlDir && !cleaned.startsWith("./") && !cleaned.startsWith("../") && !cleaned.startsWith("/")) {
      return;
    }
    const resolved = cleaned.startsWith("/")
      ? path.resolve(htmlDir, `.${cleaned}`)
      : path.resolve(baseDir, cleaned);
    if (queued.has(resolved)) return;
    queued.add(resolved);
    queue.push({ resolved, source: formatRelativeSource(htmlDir, resolved) });
  };

  for (const source of initialScripts(html)) enqueue(source, htmlDir);

  const files = [];
  for (let index = 0; index < queue.length; index += 1) {
    const { resolved, source } = queue[index];
    const contents = await readFile(resolved);
    files.push({ source, raw: contents.length, gzip: gzipSync(contents, { level: 9 }).length });
    for (const dependency of unconditionalModuleDependencies(contents.toString("utf8"), resolved)) {
      enqueue(dependency, path.dirname(resolved));
    }
  }

  return {
    files,
    raw: files.reduce((total, file) => total + file.raw, 0),
    gzip: files.reduce((total, file) => total + file.gzip, 0),
  };
}

export function budgetViolations(measurement, budget = MAIN_WINDOW_INITIAL_JS_BUDGET) {
  return ["raw", "gzip"]
    .filter((kind) => measurement[kind] > budget[kind])
    .map((kind) => `${kind} ${measurement[kind]} B exceeds the ${budget[kind]} B budget`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const htmlPath = path.join(repositoryRoot, "build", "renderer", "main-window.html");
  const measurement = await measureInitialJavaScript(htmlPath);
  if (measurement.files.length === 0) throw new Error(`${htmlPath} loads no scripts; run npm run build first.`);
  for (const file of measurement.files) console.log(`${file.source}: ${file.raw} B raw, ${file.gzip} B gzip`);
  console.log(`Main window initial JS: ${measurement.raw} B raw, ${measurement.gzip} B gzip`);
  const violations = budgetViolations(measurement);
  if (violations.length > 0) {
    console.error(`Main window initial JS is over budget: ${violations.join("; ")}.`);
    process.exit(1);
  }
}
