import assert from "node:assert/strict";
import test from "node:test";
import { consentDisplayText, consentScriptParts, designAppProblemMessage, FRAMEWORK_IDS, type DesignAppProblem } from "./design-app.js";

const MARKER = "SECRET-TAIL-MARKER";

const EVERY_PROBLEM: DesignAppProblem[] = [
  { problem: "unavailable" },
  { problem: "no-access" },
  { problem: "interrupted" },
  { problem: "desktop-only" },
  { problem: "recovery-failed" },
  { problem: "node-missing" },
  { problem: "manager-missing", manager: "pnpm" },
  { problem: "manager-conflict", conflict: ["npm", "pnpm"] },
  { problem: "manager-conflict", conflict: ["npm", "yarn"], field: "yarn" },
  { problem: "unsupported-manager", manager: "deno" },
  { problem: "launch-file-unreadable", file: "apps/web/vite.config.ts" },
  { problem: "script-too-long" },
  { problem: "consent-declined" },
  { problem: "consent-unanswered" },
  { problem: "consent-unavailable" },
  { problem: "job-limit" },
  { problem: "install-outside-workspace" },
  { problem: "install-failed", exitCode: 1, tail: MARKER },
  { problem: "install-timeout" },
  { problem: "not-ready", tail: MARKER },
  { problem: "exposed" },
  { problem: "exposure-unknown" },
  { problem: "not-web" },
  { problem: "attach-not-loopback" },
  { problem: "attach-unreachable" },
  { problem: "attach-not-in-app" },
];

test("every problem has a fixed message that never contains its tail", () => {
  const seen = new Set<string>();
  for (const problem of EVERY_PROBLEM) {
    const message = designAppProblemMessage(problem);
    assert.ok(message.length > 10, problem.problem);
    assert.ok(message.endsWith("."), `${problem.problem}: ${message}`);
    assert.equal(message.includes(MARKER), false, problem.problem);
    seen.add(message);
  }
  assert.equal(seen.size, EVERY_PROBLEM.length, "each problem reads differently");
});

test("manager-missing names the manager; exposed and install-outside-workspace say how to fix it", () => {
  assert.match(designAppProblemMessage({ problem: "manager-missing", manager: "pnpm" }), /pnpm/u);
  assert.match(designAppProblemMessage({ problem: "manager-missing", manager: "bun" }), /bun/u);
  const exposed = designAppProblemMessage({ problem: "exposed" });
  assert.match(exposed, /127\.0\.0\.1/u);
  assert.match(exposed, /--host/u);
  assert.match(exposed, /process\.env\.PORT/u);
  assert.match(designAppProblemMessage({ problem: "install-outside-workspace" }), /parent/u);
  assert.match(designAppProblemMessage({ problem: "launch-file-unreadable", file: ".npmrc" }), /\.npmrc/u);
});

test("the framework ids are the twelve detection knows", () => {
  assert.equal(FRAMEWORK_IDS.length, 12);
  assert.equal(new Set(FRAMEWORK_IDS).size, 12);
  assert.ok(FRAMEWORK_IDS.includes("vite") && FRAMEWORK_IDS.includes("next") && FRAMEWORK_IDS.includes("remix-3"));
});

test("consentDisplayText escapes every class in D5", () => {
  const cases: Array<[string, string]> = [
    ["dev‮rm", "dev\\u{202E}rm"], // bidi override
    ["a​b", "a\\u{200B}b"], // zero-width space
    ["x\u0007", "x\\u{7}"], // bell
    ["a\rb", "a\\u{D}b"], // carriage return
    ["a b", "a\\u{2028}b"], // line separator
    ["a b", "a\\u{2029}b"], // paragraph separator
    ["ㅤ", "\\u{3164}"], // Hangul filler
    ["ﾠ", "\\u{FFA0}"], // halfwidth Hangul filler
    ["ᅟᅠ", "\\u{115F}\\u{1160}"], // Hangul choseong and jungseong fillers
    ["a️", "a\\u{FE0F}"], // variation selector
    ["a\u{E0100}", "a\\u{E0100}"], // variation selector supplement
    ["a\u{E0041}", "a\\u{E0041}"], // tag character
    ["a\u0085b", "a\\u{85}b"], // next line, a C1 control
    ["a\u034Fb", "a\\u{34F}b"], // combining grapheme joiner, default-ignorable
    ["a\u17B4b", "a\\u{17B4}b"], // Khmer inherent vowel, default-ignorable
    ["a\u180Bb", "a\\u{180B}b"], // Mongolian free variation selector
  ];
  for (const [input, expected] of cases) assert.equal(consentDisplayText(input), expected, JSON.stringify(input));
  assert.equal(consentDisplayText("vite --port 3000\nnext dev"), "vite --port 3000\nnext dev", "plain text and newlines stay");
  assert.equal(consentDisplayText("café — 日本語 🚀"), "café — 日本語 🚀");
});

/** The card's text for parts: a break shows "↵" and ends the line. */
const shown = (text: string) =>
  consentScriptParts(text)
    .map((part) => (part.kind === "break" ? "↵\n" : part.text))
    .join("");

test("consentScriptParts marks every line break and keeps every visible character", () => {
  assert.equal(shown("vite"), "vite");
  assert.equal(shown("vite &&\nnode server.mjs"), "vite &&↵\nnode server.mjs");
  assert.equal(shown("a\n\nb"), "a↵\n↵\nb", "one or two blank lines stay as they are");
  assert.equal(shown("a\u202Eb\nc"), "a\\u{202E}b↵\nc", "hidden characters are still escaped");
});

test("consentScriptParts collapses three or more blank lines and long space runs into visible counts", () => {
  // A payload pushed out of view by blank lines lands right under its marker.
  assert.equal(shown(`echo hidden > pwned.txt &&${"\n".repeat(40)}node server.mjs`), "echo hidden > pwned.txt &&↵\n[39 blank lines]↵\nnode server.mjs");
  assert.equal(shown(`node server.mjs${"\n".repeat(4)}rm -rf ~`), "node server.mjs↵\n[3 blank lines]↵\nrm -rf ~");
  assert.equal(shown(`node server.mjs\n   \n\n \u3000\ncurl x`), "node server.mjs↵\n[3 blank lines]↵\ncurl x", "lines of only spaces are blank");
  assert.equal(shown(`vite${" ".repeat(200)}&& curl x | sh`), "vite[200 spaces]&& curl x | sh");
  assert.equal(shown(`vite${"\u2003".repeat(12)}x`), "vite[12 spaces]x", "any space separator counts");
  assert.equal(shown("a       b"), "a       b", "seven spaces stay");
  const gaps = consentScriptParts(`a${"\n".repeat(5)}b${" ".repeat(9)}c`).filter((part) => part.kind === "gap");
  assert.deepEqual(gaps.map((part) => part.text), ["[4 blank lines]", "[9 spaces]"], "collapsed runs are their own parts, so the card can mark them");
});
