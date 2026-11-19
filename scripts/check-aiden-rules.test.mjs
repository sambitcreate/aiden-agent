import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAidenRules } from "./check-aiden-rules.mjs";

const check = (files, allowlist = []) =>
  checkAidenRules({ files: Object.entries(files).map(([path, text]) => ({ path, text })), allowlist }).problems;
const summary = (problems) => problems.map((problem) => `${problem.file}:${problem.line} ${problem.rule}`);

test("brain icon imports, tags, icon names and brain-named files are reported in the renderer", () => {
  const problems = check({
    "renderer/components/memory.tsx": [
      'import { BrainCircuit, Cpu } from "lucide-react";',
      "export const A = () => <BrainCircuit />;",
      'const icon = "brain-cog";',
      'const font = "JetBrainsMono Nerd Font";',
    ].join("\n"),
    "renderer/assets/brain.svg": "",
    "main/services/brain.ts": 'import { BrainCircuit } from "lucide-react";',
    "renderer/components/aliases.tsx": [
      'import { LucideBrainCog, Brain2 as Thinking, Cpu as LucideBrainless } from "lucide-react";',
      "export const B = () => <LucideBrainCircuit />;",
    ].join("\n"),
  });
  assert.deepEqual(summary(problems), [
    "renderer/assets/brain.svg:1 no-brain-icon",
    "renderer/components/aliases.tsx:1 no-brain-icon",
    "renderer/components/aliases.tsx:1 no-brain-icon",
    "renderer/components/aliases.tsx:2 no-brain-icon",
    "renderer/components/memory.tsx:1 no-brain-icon",
    "renderer/components/memory.tsx:2 no-brain-icon",
    "renderer/components/memory.tsx:3 no-brain-icon",
  ]);
});

test("text inputs may not add a focus ring, outline or accent border; non-text inputs may", () => {
  const problems = check({
    "renderer/components/form.tsx": [
      'export const F = ({ on }) => (<>',
      '  <input className="h-9 focus:ring-2" />',
      '  <textarea className={cn("p-2", on && "focus-visible:outline-2")} />',
      '  <Input className="focus:border-accent" />',
      '  <Input className="focus:shadow-[0_0_0_2px_var(--accent)] focus:shadow-none" />',
      '  <Input className="border-0 focus:border-0 focus:bg-input focus-visible:outline-none" />',
      '  <input type="checkbox" className="focus-visible:ring-2" />',
      '  <button className="focus-visible:ring-2" />',
      "</>);",
    ].join("\n"),
  });
  assert.deepEqual(summary(problems), [
    "renderer/components/form.tsx:2 text-input-focus-ring",
    "renderer/components/form.tsx:3 text-input-focus-ring",
    "renderer/components/form.tsx:4 text-input-focus-ring",
    "renderer/components/form.tsx:5 text-input-focus-ring",
  ]);
  assert.match(problems[2].message, /focus:border-accent/u);
});

test("overlay DOM sniffs are reported, JSX slot attributes and non-overlay selectors are not", () => {
  const problems = check({
    "renderer/lib/keys.ts": [
      `if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) {}`,
      `root.querySelector('[role="menu"][data-state="open"]');`,
      `root.querySelector('[data-environment-surface][data-state="open"]');`,
    ].join("\n"),
    "renderer/components/sheet.tsx": 'export const S = () => <div data-slot="dialog-content" />;',
    "renderer/lib/keys.test.ts": `document.querySelector('[data-slot="dialog-content"]');`,
  });
  assert.deepEqual(summary(problems), ["renderer/lib/keys.ts:1 no-dialog-dom-sniff", "renderer/lib/keys.ts:2 no-dialog-dom-sniff"]);
});

test("governed endpoints are reported outside tests; plain mentions are not", () => {
  const problems = check({
    "main/services/eu.ts": 'const host = "https://eu.i.posthog.com";\nconst mcp = "https://mcp.posthog.com/mcp";',
    "main/services/router-catalog.ts": 'const BASE = "https://openrouter.ai/api/v1";\nfetch(`${BASE}` + "/models");',
    "main/services/router-template.ts": 'const base = "https://openrouter.ai/api/v1";\nfetch(`${base}/benchmarks`);',
    "main/services/router-chat.ts": 'const BASE = "https://openrouter.ai/api/v1";\nfetch(`${BASE}/chat/completions`);',
    "main/services/new-fetcher.ts": 'const url = "https://models.dev/api.json";\n// data from models.dev',
    "renderer/lib/thing.ts": 'fetch("https://openrouter.ai/api/v1/models?x=1");',
    "main/services/new-fetcher.test.ts": 'assert.equal(url, "https://models.dev/api.json");',
  });
  assert.deepEqual(summary(problems), [
    "main/services/eu.ts:1 network-allowlist",
    "main/services/new-fetcher.ts:1 network-allowlist",
    "main/services/router-catalog.ts:1 network-allowlist",
    "main/services/router-template.ts:1 network-allowlist",
    "renderer/lib/thing.ts:1 network-allowlist",
  ]);
});

test("tests that read production source and grep it are reported, including through a read helper", () => {
  const problems = check({
    "renderer/lib/direct.test.ts": [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("./direct.ts", import.meta.url), "utf8");',
      "assert.match(source, /x/u);",
    ].join("\n"),
    "main/helper.test.ts": [
      'const read = (file) => readFileSync(file, "utf8");',
      'for (const file of ["renderer/a.tsx", "renderer/styles.css"]) assert.doesNotMatch(read(file), /y/u);',
    ].join("\n"),
    "main/behavior.test.ts": [
      'const out = readFileSync(join(dir, "output.json"), "utf8");',
      "assert.match(out, /ok/u);",
    ].join("\n"),
    "main/fixture.test.ts": 'const t = readFileSync("tests/fixtures/sample.ts", "utf8");\nassert.ok(t.includes("a"));',
  });
  assert.deepEqual(summary(problems), ["main/helper.test.ts:1 no-source-grep-test", "renderer/lib/direct.test.ts:2 no-source-grep-test"]);
});

test("literal curves are reported outside token definitions and comments", () => {
  const problems = check({
    "renderer/styles.css": [
      ":root {",
      "  --motion-easing: cubic-bezier(0.16, 1, 0.3, 1);",
      "}",
      "/* was cubic-bezier(0, 0, 1, 1) */",
      ".a { transition: opacity 150ms cubic-bezier(0, 0, 0.2, 1), transform 150ms cubic-bezier(0, 0, 0.2, 1); }",
      "/*",
      "  old: cubic-bezier(0, 0, 1, 1)",
      "*/",
      ".b { --shadow-curve: cubic-bezier(0, 0, 1, 1); }",
    ].join("\n"),
    "renderer/components/x.tsx": 'const c = "ease-[cubic-bezier(0.2,0,0,1)]";',
  });
  assert.deepEqual(summary(problems), [
    "renderer/components/x.tsx:1 literal-motion",
    "renderer/styles.css:5 literal-motion",
    "renderer/styles.css:5 literal-motion",
    "renderer/styles.css:9 literal-motion",
  ]);
});

test("a /* inside strings, regexes or line comments does not hide later curves", () => {
  const problems = check({
    "renderer/components/y.tsx": [
      'const glob = "assets/x/*";',
      "// matches a/* prefix",
      "const re = /^\\/*x/u;",
      "/* a real comment: cubic-bezier(0, 0, 1, 1) */",
      'const c = "ease-[cubic-bezier(0.2,0,0,1)]";',
      'const vars = { "--motion-easing": "cubic-bezier(0.16, 1, 0.3, 1)" };',
    ].join("\n"),
    "renderer/y.css": [
      '.a { background: url("x/*"); }',
      ".b { transition: opacity 1s cubic-bezier(0, 0, 1, 1); }",
    ].join("\n"),
  });
  assert.deepEqual(summary(problems), ["renderer/components/y.tsx:5 literal-motion", "renderer/y.css:2 literal-motion"]);
});

test("inline allowances need a reason", () => {
  const problems = check({
    "renderer/a.css": [
      "/* check-aiden-rules: allow literal-motion matches the macOS sheet curve */",
      ".a { transition: opacity 1s cubic-bezier(0, 0, 1, 1); }",
      ".b { transition: opacity 1s cubic-bezier(0, 0, 1, 1); } /* check-aiden-rules: allow literal-motion */",
    ].join("\n"),
  });
  assert.deepEqual(summary(problems), ["renderer/a.css:3 literal-motion"]);
  assert.match(problems[0].message, /needs a reason/u);
});

test("inline allowances work as JSX comments, above the className line, and with * in the reason", () => {
  const problems = check({
    "renderer/components/f.tsx": [
      "export const F = () => (<>",
      "  {/* check-aiden-rules: allow text-input-focus-ring the *only* field with a ring by spec */}",
      '  <input className="focus:ring-2" />',
      "  <textarea",
      "    rows={2}",
      "    // check-aiden-rules: allow text-input-focus-ring matches the system sheet",
      '    className="focus:ring-2"',
      "  />",
      '  <input className="focus:ring-2" />',
      "</>);",
    ].join("\n"),
  });
  assert.deepEqual(summary(problems), ["renderer/components/f.tsx:9 text-input-focus-ring"]);
});

const motion = (count) => ({ "renderer/m.css": Array.from({ length: count }, () => ".a { transition: all 1s cubic-bezier(0, 0, 1, 1); }").join("\n") });

test("an allowlist budget covers hits up to max and reports every hit once it is exceeded", () => {
  const entry = { rule: "literal-motion", file: "renderer/m.css", reason: "legacy", max: 2 };
  assert.deepEqual(check(motion(2), [entry]), []);
  const over = check(motion(3), [entry]);
  assert.equal(over.length, 3);
  assert.match(over[0].message, /3 in file, allowlist budget is 2/u);
});

test("the allowlist only shrinks: unused entries and loose budgets fail", () => {
  const loose = check(motion(1), [{ rule: "literal-motion", file: "renderer/m.css", reason: "legacy", max: 3 }]);
  assert.deepEqual(summary(loose), ["scripts/aiden-rules-allowlist.json:2 allowlist"]);
  assert.match(loose[0].message, /lower max to 1/u);

  const unused = check(motion(0), [
    { rule: "literal-motion", file: "renderer/m.css", reason: "legacy", max: 1 },
    { rule: "no-source-grep-test", file: "gone.test.ts", reason: "legacy" },
  ]);
  assert.deepEqual(summary(unused), ["scripts/aiden-rules-allowlist.json:2 allowlist", "scripts/aiden-rules-allowlist.json:3 allowlist"]);
  assert.ok(unused.every((problem) => /stale allowlist entry — remove it/u.test(problem.message)));
});

test("allowlist entries need a known rule and a reason, and a file-level entry covers every hit", () => {
  const problems = check(motion(4), [
    { rule: "literal-motion", file: "renderer/m.css", reason: "  " },
    { rule: "made-up", file: "x", reason: "why" },
  ]);
  assert.ok(problems.some((problem) => /has no reason/u.test(problem.message)));
  assert.ok(problems.some((problem) => /unknown rule "made-up"/u.test(problem.message)));
  assert.deepEqual(check(motion(4), [{ rule: "literal-motion", file: "renderer/m.css", reason: "legacy" }]), []);
});
