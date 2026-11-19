/* global console, process */
// Checks the AGENTS.md and docs/design-guide.md rules a script can check.
// Prints `file:line rule message` per violation and exits 1 on any.
//
// A line that needs an exception takes `// check-aiden-rules: allow <rule> <why>`
// (or `/* ... */` in CSS) on the line itself or the line above. Whole files or
// per-file budgets go in scripts/aiden-rules-allowlist.json as
// `{ "rule", "file", "reason", "max"? }`. Without `max` an entry covers every
// hit of that rule in the file; with `max` the file may have at most that many.
// An entry that covers nothing, or whose `max` is above the real count, fails,
// so the list only shrinks. There is deliberately no `--update`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ALLOWLIST_PATH = "scripts/aiden-rules-allowlist.json";
const SKIPPED_DIRS = /(^|\/)(node_modules|dist|out|build|\.git|\.memory|DerivedData|\.gradle)\//u;
const SKIPPED_PREFIXES = ["packages/cli/dist/", "docs/", "gui/"];
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?$|(^|\/)tests?\/)/u;
const RENDERER_SOURCE = /^renderer\/.*\.(?:ts|tsx)$/u;

const isTest = (file) => TEST_FILE.test(file);
const isRendererSource = (file) => RENDERER_SOURCE.test(file) && !isTest(file);

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function parse(file, text) {
  const kind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function stringTexts(node, out = []) {
  walk(node, (child) => {
    if (
      ts.isStringLiteral(child) ||
      ts.isNoSubstitutionTemplateLiteral(child) ||
      ts.isTemplateHead(child) ||
      ts.isTemplateMiddle(child) ||
      ts.isTemplateTail(child)
    ) {
      out.push(child.text);
    }
  });
  return out;
}

function isModuleSpecifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  return ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
}

// no-brain-icon — AGENTS.md: "Never introduce brain icons or brain illustrations anywhere in the app."
const BRAIN_NAME = /^(?:Lucide)?Brain(?:[A-Z0-9]\w*)?$|Brain(?:Icon|Illustration|Art|Glyph)$/u;
const BRAIN_ICON_STRING = /^(?:lucide[-:])?brain(?:-[a-z0-9]+)*$/u;
function noBrainIcon(file, text) {
  const hits = [];
  if (/^(?:renderer|public)\//u.test(file) && /brain/iu.test(path.posix.basename(file)) && !isTest(file)) {
    hits.push({ line: 1, message: "file is named for a brain; brain illustrations are not used in Aiden" });
  }
  if (!isRendererSource(file) || !/brain/iu.test(text)) return hits;
  const sourceFile = parse(file, text);
  walk(sourceFile, (node) => {
    if (ts.isImportSpecifier(node) && (BRAIN_NAME.test(node.name.text) || BRAIN_NAME.test(node.propertyName?.text ?? ""))) {
      hits.push({ line: lineOf(sourceFile, node), message: `imports ${node.propertyName?.text ?? node.name.text}; use a non-brain icon` });
    } else if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && BRAIN_NAME.test(node.tagName.getText(sourceFile))) {
      hits.push({ line: lineOf(sourceFile, node), message: `renders <${node.tagName.getText(sourceFile)}>; use a non-brain icon` });
    } else if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) && BRAIN_NAME.test(node.name.text)) {
      hits.push({ line: lineOf(sourceFile, node), message: `declares ${node.name.text}; brain illustrations are not used in Aiden` });
    } else if (ts.isStringLiteral(node) && !isModuleSpecifier(node) && BRAIN_ICON_STRING.test(node.text)) {
      hits.push({ line: lineOf(sourceFile, node), message: `names the "${node.text}" icon; use a non-brain icon` });
    }
  });
  return hits;
}

// text-input-focus-ring — AGENTS.md: "Text-entry controls must not add an accent border, outline, or ring when focused."
const TEXT_ENTRY_TAGS = new Set(["input", "textarea", "Input", "Textarea"]);
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "range", "color", "file", "submit", "button", "reset", "image", "hidden"]);
const FOCUS_VARIANT = /^(?:focus|focus-visible|focus-within)$/u;
// A focus shadow that names the accent is a ring by another name.
const FOCUS_UTILITY = /^-?(?:ring|outline|border)(?:-|$)|^shadow-.*accent/u;
const FOCUS_UTILITY_OK = new Set(["ring-0", "ring-transparent", "outline-none", "outline-hidden", "outline-0", "border-0", "border-none", "border-transparent"]);

function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of token) {
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth -= 1;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

export function focusRingClass(className) {
  return className.split(/\s+/u).find((token) => {
    if (!token) return false;
    const parts = splitVariants(token);
    const utility = parts.pop().replace(/^!|!$/gu, "");
    return parts.some((variant) => FOCUS_VARIANT.test(variant)) && FOCUS_UTILITY.test(utility) && !FOCUS_UTILITY_OK.has(utility);
  });
}

function textInputFocusRing(file, text) {
  if (!isRendererSource(file) || !file.endsWith(".tsx") || !/focus/u.test(text)) return [];
  const sourceFile = parse(file, text);
  const hits = [];
  walk(sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tag = node.tagName.getText(sourceFile);
    if (!TEXT_ENTRY_TAGS.has(tag)) return;
    let className;
    let classLine;
    let type;
    for (const attribute of node.attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
      const name = attribute.name.getText(sourceFile);
      if (name === "className") {
        className = attribute.initializer;
        classLine = lineOf(sourceFile, attribute);
      }
      if (name === "type" && ts.isStringLiteral(attribute.initializer)) type = attribute.initializer.text;
    }
    if (!className || NON_TEXT_INPUT_TYPES.has(type)) return;
    const bad = focusRingClass(stringTexts(className).join(" "));
    if (bad) {
      // An allowance may sit on or above the element's line or its className line.
      hits.push({ line: lineOf(sourceFile, node), allowLines: [classLine], message: `<${tag}> adds "${bad}" on focus; text entry shows focus with fill and caret only` });
    }
  });
  return hits;
}

// no-dialog-dom-sniff — plan unit 1: open overlays come from the shared layer stack, not DOM queries
// for `[data-slot="dialog-content"]` or an open menu/popover (docs/plans/ui-sdk-lessons-plan.md).
const DIALOG_SLOT = /\[data-slot=["']?dialog-content["']?\]/u;
const OPEN_STATE = /\[data-state=["']?open["']?\]/u;
const OVERLAY_MARKER = /\[(?:role=["']?(?:menu|dialog|alertdialog|listbox)["']?|data-slot=["']?[\w-]*(?:content|overlay)["']?|data-radix-popper-content-wrapper)\]/u;
export function isOverlaySniff(selector) {
  return DIALOG_SLOT.test(selector) || (OPEN_STATE.test(selector) && OVERLAY_MARKER.test(selector));
}

function noDialogDomSniff(file, text) {
  if (!isRendererSource(file) || !/data-(?:slot|state)=/u.test(text)) return [];
  const sourceFile = parse(file, text);
  const hits = [];
  walk(sourceFile, (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isJsxAttribute(node.parent) && isOverlaySniff(node.text)) {
      hits.push({ line: lineOf(sourceFile, node), message: `sniffs the DOM for an open overlay (${node.text}); ask the layer stack instead` });
    }
  });
  return hits;
}

// network-allowlist — AGENTS.md "Release model metadata" and "Product analytics": these hosts are
// contacted only by their fixed, manual or consented owners.
const NETWORK_HOSTS = [
  /\/\/models\.dev\b/u,
  // PostHog ingestion hosts (us.i, eu.i, app); the user-added PostHog MCP connector is not analytics.
  /\/\/(?:[\w-]+\.)*(?:i|app)\.posthog\.com\b/u,
  /\/\/api\.fal\.ai\b/u,
  /\/\/api\.replicate\.com\b/u,
  /openrouter\.ai\/api\/v1\/(?:models|benchmarks)\b/u,
  /\/\/(?:[\w-]+\.)*artificialanalysis\.ai\b/u,
];
const OPENROUTER_BASE = /\/\/openrouter\.ai\/api\/v1\b/u;
function networkAllowlist(file, text) {
  if (!CODE_FILE.test(file) || isTest(file)) return [];
  const hits = [];
  text.split("\n").forEach((line, index) => {
    const match = NETWORK_HOSTS.map((pattern) => line.match(pattern)).find(Boolean);
    if (match) hits.push({ line: index + 1, message: `names the governed endpoint "${match[0]}"; only its owning module may` });
  });
  // The OpenRouter base URL is fine for inference, but not in a file that also builds a catalog path.
  if (hits.length === 0 && /(?:["'`]|\})\/(?:models|benchmarks)\b/u.test(text)) {
    text.split("\n").forEach((line, index) => {
      if (OPENROUTER_BASE.test(line)) hits.push({ line: index + 1, message: "joins the OpenRouter API base with a /models or /benchmarks path; only the catalog owners may" });
    });
  }
  return hits;
}

// no-source-grep-test — AGENTS.md Tests: "Do not add or extend tests that readFileSync production
// .ts / .tsx / .css ... and assert.match / assert.doesNotMatch / substring counts against that source".
const PRODUCTION_SOURCE_PATH = /\.(?:tsx?|[cm]ts|css)$/u;
const NOT_PRODUCTION_PATH = /\.(?:test|spec)\.|\.d\.ts$|fixture/u;
const isSourcePath = (value) => PRODUCTION_SOURCE_PATH.test(value) && !NOT_PRODUCTION_PATH.test(value);

// Does `node` (a read call's path argument) name a production source file? Follows identifiers to
// their variable, for-of or parameter origins a few levels, so `read(file)` helpers are seen through.
function namesSourcePath(node, index, depth, seen = new Set()) {
  if (depth > 4 || seen.has(node)) return false;
  seen.add(node);
  if (stringTexts(node).some(isSourcePath)) return true;
  const names = new Set();
  walk(node, (child) => {
    if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) names.add(child.text);
  });
  for (const name of names) {
    for (const origin of index.get(name) ?? []) {
      if (namesSourcePath(origin, index, depth + 1, seen)) return true;
    }
  }
  return false;
}

// Maps each name to the expressions its value can come from in this file.
function originIndex(sourceFile) {
  const index = new Map();
  const add = (name, node) => {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(node);
  };
  const callsByName = new Map();
  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (!callsByName.has(name)) callsByName.set(name, []);
      callsByName.get(name).push(node);
    }
  });
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) add(node.name.text, node.initializer);
      const loop = node.parent?.parent;
      if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) add(node.name.text, loop.expression);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const fn = node.parent;
      const position = fn.parameters.indexOf(node);
      let fnName = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : "";
      if (!fnName && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) fnName = fn.parent.name.text;
      if (!fnName && ts.isCallExpression(fn.parent)) {
        // `paths.map((file) => read(file))`: the parameter comes from the array being mapped.
        if (ts.isPropertyAccessExpression(fn.parent.expression)) add(node.name.text, fn.parent.expression.expression);
        return;
      }
      for (const call of callsByName.get(fnName) ?? []) {
        if (call.arguments[position]) add(node.name.text, call.arguments[position]);
      }
    }
  });
  return index;
}

function noSourceGrepTest(file, text) {
  if (!isTest(file) || !CODE_FILE.test(file) || !/readFile/u.test(text)) return [];
  const sourceFile = parse(file, text);
  const reads = [];
  let asserts = false;
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if ((name === "readFileSync" || name === "readFile") && node.arguments[0]) reads.push(node);
    if (name === "match" || name === "doesNotMatch" || name === "includes") asserts = true;
    if (name === "test" && ts.isPropertyAccessExpression(node.expression) && ts.isRegularExpressionLiteral(node.expression.expression)) asserts = true;
  });
  if (!asserts || reads.length === 0) return [];
  const index = originIndex(sourceFile);
  const read = reads.find((call) => namesSourcePath(call.arguments[0], index, 0));
  if (!read) return [];
  return [{ line: lineOf(sourceFile, read), message: "reads production source and greps it; test the behavior instead" }];
}

// literal-motion — GUI.md: "Do not introduce colors, text steps, spacing steps, radii, shadows, or motion
// values to finish a screen." Curves live in the `--motion-*` / `--ease-*` token definitions.
const TOKEN_DEFINITION = /--(?:motion|ease)-[\w-]*["']?\s*:[^;]*$/u;

// CSS lines with /* */ comment content blanked (across lines), skipping quoted strings, so
// `url("x/*")` does not open a comment. Line numbers are kept.
function cssCodeLines(text) {
  let inComment = false;
  return text.split("\n").map((line) => {
    let code = "";
    let quote = "";
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      if (inComment) {
        if (line.startsWith("*/", at)) {
          inComment = false;
          at += 1;
        }
      } else if (quote) {
        code += char;
        if (char === "\\") code += line[++at] ?? "";
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
        code += char;
      } else if (line.startsWith("/*", at)) {
        inComment = true;
        at += 1;
      } else {
        code += char;
      }
    }
    return code;
  });
}

const MOTION_MESSAGE = "uses a literal cubic-bezier(); use a motion token (var(--motion-easing), ease-standard, ease-emphasized)";
const TOKEN_KEY = /^--(?:motion|ease)-/u;

function literalMotion(file, text) {
  if (!/^renderer\/.*\.(?:css|ts|tsx)$/u.test(file) || isTest(file) || !text.includes("cubic-bezier(")) return [];
  const hits = [];
  if (file.endsWith(".css")) {
    cssCodeLines(text).forEach((line, index) => {
      for (let at = line.indexOf("cubic-bezier("); at !== -1; at = line.indexOf("cubic-bezier(", at + 1)) {
        if (!TOKEN_DEFINITION.test(line.slice(0, at))) hits.push({ line: index + 1, message: MOTION_MESSAGE });
      }
    });
    return hits;
  }
  // Code: only string and template text counts, so comments and regexes are never scanned.
  const sourceFile = parse(file, text);
  walk(sourceFile, (node) => {
    const isText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (!isText) return;
    const parent = node.parent;
    if (parent && ts.isPropertyAssignment(parent) && parent.initializer === node && TOKEN_KEY.test(parent.name.getText(sourceFile).replace(/^["']|["']$/gu, ""))) return;
    const raw = node.getText(sourceFile);
    const start = node.getStart(sourceFile);
    for (let at = raw.indexOf("cubic-bezier("); at !== -1; at = raw.indexOf("cubic-bezier(", at + 1)) {
      const lineStart = raw.lastIndexOf("\n", at) + 1;
      if (TOKEN_DEFINITION.test(raw.slice(lineStart, at))) continue;
      hits.push({ line: sourceFile.getLineAndCharacterOfPosition(start + at).line + 1, message: MOTION_MESSAGE });
    }
  });
  hits.sort((a, b) => a.line - b.line);
  return hits;
}

export const RULES = {
  "no-brain-icon": noBrainIcon,
  "text-input-focus-ring": textInputFocusRing,
  "no-dialog-dom-sniff": noDialogDomSniff,
  "network-allowlist": networkAllowlist,
  "no-source-grep-test": noSourceGrepTest,
  "literal-motion": literalMotion,
};

// Ends as a line comment, a CSS comment, or a JSX `{/* ... */}` comment.
const ALLOW_COMMENT = /check-aiden-rules:\s*allow\s+([\w-]+)(?:\s+(.*?))?\s*(?:\*\/\s*\}?)?\s*$/u;
function inlineAllowance(lines, hit, rule) {
  const anchors = [hit.line, ...(hit.allowLines ?? [])].filter(Boolean);
  for (const candidate of anchors.flatMap((line) => [lines[line - 1], lines[line - 2]])) {
    const match = candidate?.match(ALLOW_COMMENT);
    if (match && match[1] === rule) return { reason: match[2]?.trim() ?? "" };
  }
  return null;
}

/**
 * Runs every rule over `files` (`[{ path, text }]`, repo-relative POSIX paths) and applies
 * `allowlist` (the parsed JSON array). Returns `problems` as `{ file, line, rule, message }`
 * plus the count of inline allowances honored.
 */
export function checkAidenRules({ files, allowlist, allowlistPath = ALLOWLIST_PATH }) {
  const problems = [];
  const counts = new Map();
  let allowances = 0;
  const entries = new Map();

  allowlist.forEach((entry, index) => {
    const at = { file: allowlistPath, line: index + 2, rule: "allowlist" };
    if (!RULES[entry?.rule]) return problems.push({ ...at, message: `unknown rule "${entry?.rule}"` });
    if (typeof entry.file !== "string" || !entry.file) return problems.push({ ...at, message: `${entry.rule} entry has no file` });
    if (typeof entry.reason !== "string" || !entry.reason.trim()) return problems.push({ ...at, message: `${entry.rule} ${entry.file} has no reason` });
    if (entry.max !== undefined && (!Number.isInteger(entry.max) || entry.max < 1)) return problems.push({ ...at, message: `${entry.rule} ${entry.file} max must be a positive integer` });
    const key = `${entry.rule}\0${entry.file}`;
    if (entries.has(key)) return problems.push({ ...at, message: `${entry.rule} ${entry.file} is listed twice` });
    entries.set(key, { ...entry, at });
  });

  const hitsByKey = new Map();
  for (const { path: file, text } of files) {
    const lines = text.split("\n");
    for (const [rule, check] of Object.entries(RULES)) {
      for (const hit of check(file, text)) {
        const allowance = inlineAllowance(lines, hit, rule);
        if (allowance?.reason) {
          allowances += 1;
          continue;
        }
        if (allowance) {
          problems.push({ file, line: hit.line, rule, message: "inline allowance needs a reason after the rule id" });
          continue;
        }
        const key = `${rule}\0${file}`;
        if (!hitsByKey.has(key)) hitsByKey.set(key, []);
        hitsByKey.get(key).push({ file, line: hit.line, rule, message: hit.message });
      }
    }
  }

  for (const [key, hits] of hitsByKey) {
    const entry = entries.get(key);
    counts.set(key, hits.length);
    if (!entry) {
      problems.push(...hits);
    } else if (entry.max !== undefined && hits.length > entry.max) {
      problems.push(...hits.map((hit) => ({ ...hit, message: `${hit.message} (${hits.length} in file, allowlist budget is ${entry.max})` })));
    }
  }

  for (const [key, entry] of entries) {
    const count = counts.get(key) ?? 0;
    if (count === 0) {
      problems.push({ ...entry.at, message: `stale allowlist entry — remove it (${entry.rule} ${entry.file} has no hits)` });
    } else if (entry.max !== undefined && count < entry.max) {
      problems.push({ ...entry.at, message: `stale allowlist entry — lower max to ${count} (${entry.rule} ${entry.file})` });
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { problems, allowances };
}

const RELEVANT_FILE = /\.(?:[cm]?[jt]s|tsx|jsx|css|svg|png|webp)$/u;
export function listRepoFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0"))].filter(
    (file) => file && RELEVANT_FILE.test(file) && !SKIPPED_DIRS.test(file) && !SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

function readRepoFiles(root) {
  const files = [];
  for (const file of listRepoFiles(root)) {
    if (!/\.(?:[cm]?[jt]s|tsx|jsx|css)$/u.test(file)) {
      files.push({ path: file, text: "" });
      continue;
    }
    try {
      files.push({ path: file, text: readFileSync(path.join(root, file), "utf8") });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error; // deleted but still in the index
    }
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const allowlist = JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), "utf8"));
  const { problems, allowances } = checkAidenRules({ files: readRepoFiles(root), allowlist });
  for (const problem of problems) console.log(`${problem.file}:${problem.line} ${problem.rule} ${problem.message}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s). Fix them, or add an entry with a reason to ${ALLOWLIST_PATH} (see docs/design-guide.md "Enforced rules").`);
    process.exit(1);
  }
  console.log(`Aiden design rules pass (${allowlist.length} allowlist entries, ${allowances} inline allowances).`);
}
