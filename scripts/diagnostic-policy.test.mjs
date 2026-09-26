import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(relative, extension) {
  const base = path.join(root, relative);
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(extension)) output.push(target);
    }
  };
  visit(base);
  return output;
}

const consoleMethods = new Set(["debug", "info", "log", "warn", "error"]);

function unwrapExpression(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) node = node.expression;
  return node;
}

function memberName(node) {
  node = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const key = unwrapExpression(node.argumentExpression);
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  }
  return undefined;
}

function runtimeConsoleCalls(source, fileName = "fixture.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(file.parseDiagnostics, [], `Cannot parse diagnostic-policy input: ${fileName}`);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const method = unwrapExpression(node.expression);
      if (consoleMethods.has(memberName(method))) {
        const receiver = unwrapExpression(method.expression);
        if (ts.isIdentifier(receiver) && receiver.text === "console" || memberName(receiver) === "console") {
          calls.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
        }
      }
    }
    // Literal source text has no call nodes; template substitutions and nested
    // function bodies do, and must still satisfy the main-process sink policy.
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

test("console policy ignores source strings, comments, regexes and uncalled references", () => {
  assert.deepEqual(runtimeConsoleCalls([
    '// console.warn("comment");',
    '/* globalThis.console.error("comment"); */',
    'export const injectedSource = "console.log(\\"guest\\")";',
    "const template = `console.info('guest') ${'console.error(guest)'}`;",
    'const pattern = /console.log\\(/;',
    'const reference = console.warn;',
  ].join("\n")), []);
});

test("console policy detects direct, global, computed and optional runtime calls", () => {
  const calls = [
    'console.debug("debug");',
    'console.info("info");',
    '(console.log)("log");',
    'globalThis.console.warn("warn");',
    'global["console"]["error"]("error");',
    'window.console?.log?.("optional");',
    'self.console[`info`]("computed");',
    '(console as Console)!.warn("typed");',
    'console["l\\u006fg"]("escaped method");',
    'const unrelated = { console: { log() {} } }; unrelated.console.log();',
    'class Worker { run() { this.console.log("qualified receiver"); } }',
    'getContext().console.error("qualified receiver");',
  ];
  assert.deepEqual(runtimeConsoleCalls(calls.join("\n")), calls.map((_, index) => index + 1));
});

test("console policy traverses nested code and executable template substitutions", () => {
  assert.deepEqual(runtimeConsoleCalls([
    'function nested() { return () => { console.error("nested"); }; }',
    'class Worker { run() { globalThis.console.warn("nested method"); } }',
    'const template = `guest code ${console.log("main process")}`;',
    'const tagged = String.raw`guest ${(() => console.debug("main process"))()}`;',
  ].join("\n")), [1, 2, 3, 4]);
  assert.throws(() => runtimeConsoleCalls('console.log("unterminated)'), /Cannot parse/);
});

test("desktop runtime console calls are confined to the reviewed sink", () => {
  const offenders = filesUnder("main", ".ts")
    .filter((file) => !file.endsWith(".test.ts") && path.basename(file) !== "platform.ts")
    .flatMap((file) => runtimeConsoleCalls(fs.readFileSync(file, "utf8"), file)
      .map((line) => `${path.relative(root, file)}:${line}`));
  assert.deepEqual(offenders, []);
});

test("iOS logging is confined to the typed wrapper", () => {
  const allowed = path.join(root, "ios/AidenOnTheGo/AidenOnTheGoApp.swift");
  const offenders = filesUnder("ios/AidenOnTheGo", ".swift")
    .filter((file) => file !== allowed)
    .filter((file) => /\b(?:Logger\s*\(|os_log\s*\(|print\s*\()/u.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("Android logging is confined to the typed wrapper", () => {
  const allowed = path.join(
    root,
    "android/app/src/main/java/sbtbiswas/AidenOnTheGo/diagnostics/AidenDiagnostics.kt",
  );
  const offenders = filesUnder("android/app/src/main/java", ".kt")
    .filter((file) => file !== allowed)
    .filter((file) => /\b(?:Log\.[diewv]|print(?:ln)?)\s*\(/u.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("Electron crash capture remains explicit and upload-disabled", () => {
  const runtimeFiles = filesUnder("main", ".ts").filter((file) => !file.endsWith(".test.ts"));
  const starters = runtimeFiles.filter((file) => /crashReporter\.start\s*\(/u.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(starters.map((file) => path.relative(root, file)), ["main/handlers/diagnostics.ts"]);
  const handler = fs.readFileSync(starters[0], "utf8");
  assert.match(handler, /uploadToServer:\s*false/u);
  assert.doesNotMatch(handler, /submitURL/u);
  assert.match(handler, /rendererDocumentOwner/u);
  assert.match(handler, /showMessageBox/u);
  assert.match(handler, /createRendererDiagnosticRateLimiter/u);
  assert.match(handler, /AIDEN_DISABLE_PRODUCTION_DIAGNOSTICS/u);
  assert.match(handler, /durableReferenceId\s*=\s*`RD-\$\{randomUUID\(\)\}`/u);
  assert.doesNotMatch(handler, /fields:\s*\{[\s\S]{0,200}referenceId:\s*report\.referenceId/u);
});

test("release runs signed packaged diagnostics acceptance before publication", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const dist = release.indexOf("run: npm run dist");
  const packaged = release.indexOf("run: npm run test:e2e:diagnostics:packaged");
  const publish = release.indexOf("bash scripts/publish-github-release.sh");
  assert.ok(dist >= 0 && packaged > dist && publish > packaged);
});

test("release installs Chromium before JavaScript containment tests", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const install = release.indexOf("run: npx playwright install chromium");
  const testSuite = release.indexOf("run: npm test");
  assert.ok(install >= 0 && testSuite > install);
});

test("CI uploads only the fixed sanitized receipt with short retention", () => {
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const source = fs.readFileSync(path.join(root, workflow), "utf8");
    const uploadBlocks = source.match(/uses:\s*actions\/upload-artifact@[\s\S]*?(?=\n\s*- name:|\n\s*\w+:\s*$|$)/gu) ?? [];
    const diagnosticUploads = uploadBlocks.filter((block) => /e2e-safe-receipt/u.test(block));
    assert.equal(diagnosticUploads.length, 1, `${workflow} must retain exactly one failure receipt`);
    for (const block of diagnosticUploads) {
      assert.match(block, /path:\s*test-results\/e2e-safe-receipt\.json/u);
      assert.match(block, /retention-days:\s*7/u);
      assert.doesNotMatch(block, /playwright-report|test-results\/e2e\s*$/mu);
    }
  }
});
