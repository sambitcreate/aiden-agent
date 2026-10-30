import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CAUSE_DEPTH,
  MAX_EXCEPTION_FRAMES,
  MAX_EXCEPTION_MESSAGE_LENGTH,
  countBucket,
  normalizeKnownId,
  rewriteFramePath,
  sanitizeException,
  uptimeBucket,
} from "./analytics-sanitize.js";

const APP_ROOT = "/Applications/Aiden.app/Contents/Resources/app.asar";
const appRoots = [APP_ROOT];

function errorWithStack(message: string, stack: string, name = "Error"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n${stack}`;
  return error;
}

test("secrets, personal paths and contact details never survive sanitizing", () => {
  const secrets = [
    "/Users/jane.doe/Projects/secret-plan",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef",
    "jane.doe@example.com",
    "https://jane:hunter2@internal.example.com/repo",
  ];
  const message = `Failed opening ${secrets.join(" while ")}`;
  const stack = [
    `    at readConfig (${APP_ROOT}/dist/main/config.js:10:5)`,
    "    at loadWorkspace (/Users/jane.doe/Projects/secret-plan/tool.js:3:9)",
    "    at Object.<anonymous> (file:///Users/jane.doe/.aiden/extensions/hook.mjs:1:1)",
  ].join("\n");
  const cause = errorWithStack(`token ${secrets[1]}`, `    at inner (/Users/jane.doe/x.js:1:1)`);
  const error = errorWithStack(message, stack);
  (error as Error & { cause?: unknown }).cause = cause;

  const serialized = JSON.stringify(sanitizeException(error, { appRoots }));

  for (const secret of [...secrets, "jane", "hunter2", "secret-plan", ".aiden"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test("each kind of sensitive value is redacted on its own", () => {
  for (const secret of [
    "jane.doe@example.com",
    "Jane.Doe+aiden@mail.example.co.uk",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "/Users/jane.doe/Projects/secret-plan",
  ]) {
    const error = new Error(`Account rejected: ${secret}`);
    (error as Error & { cause?: unknown }).cause = new Error(`because ${secret}`);
    const serialized = JSON.stringify(sanitizeException(error, { appRoots }));
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    assert.equal(serialized.includes("Account rejected"), true);
  }
});

test("frames inside the app bundle keep a relative path, function and position", () => {
  const error = errorWithStack("boom", [
    `    at async handleTurn (${APP_ROOT}/dist/main/chat.js:42:7)`,
    `    at runTool (${APP_ROOT}/node_modules/pi/agent.js:9:1)`,
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at userScript (/Users/someone/hook.js:1:1)",
  ].join("\n"));

  const [primary] = sanitizeException(error, { appRoots }).errors;

  assert.deepEqual(primary!.frames, [
    { filename: "app:///dist/main/chat.js", function: "handleTurn", lineno: 42, colno: 7, inApp: true },
    { filename: "app:///node_modules/pi/agent.js", function: "runTool", lineno: 9, colno: 1, inApp: false },
    { filename: "node:internal/process/task_queues", function: "process.processTicksAndRejections", lineno: 95, colno: 5, inApp: false },
    { filename: "<external>", function: "?", inApp: false },
  ]);
});

test("a packaged build installed anywhere still resolves frames inside app.asar", () => {
  assert.deepEqual(
    rewriteFramePath("/Volumes/External/My Apps/Aiden.app/Contents/Resources/app.asar/dist/main/index.js", []),
    { filename: "app:///dist/main/index.js", inApp: true },
  );
  assert.deepEqual(rewriteFramePath(`${APP_ROOT}/../../../../Users/x/a.js`, appRoots), { filename: "<external>", inApp: false });
  assert.deepEqual(rewriteFramePath("file:///Applications/Aiden.app/Contents/Resources/app.asar/renderer/app.js?v=1", appRoots), {
    filename: "app:///renderer/app.js",
    inApp: true,
  });
});

test("long messages, deep stacks and cause chains are bounded", () => {
  const frames = Array.from({ length: MAX_EXCEPTION_FRAMES + 20 }, (_, i) => `    at f${i} (${APP_ROOT}/a.js:${i + 1}:1)`);
  let error: Error = errorWithStack("x".repeat(5_000), frames.join("\n"));
  for (let depth = 0; depth < MAX_CAUSE_DEPTH + 5; depth += 1) {
    const outer = new Error(`level ${depth}`);
    (outer as Error & { cause?: unknown }).cause = error;
    error = outer;
  }

  const result = sanitizeException(error, { appRoots });

  assert.equal(result.errors.length, MAX_CAUSE_DEPTH + 1);
  const deep = sanitizeException(errorWithStack("x".repeat(5_000), frames.join("\n")), { appRoots }).errors[0]!;
  assert.equal(deep.frames.length, MAX_EXCEPTION_FRAMES);
  assert.ok(deep.value.length <= MAX_EXCEPTION_MESSAGE_LENGTH);
});

test("a cause cycle terminates", () => {
  const a = new Error("a");
  const b = new Error("b");
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = a;

  assert.deepEqual(sanitizeException(a, { appRoots }).errors.map((error) => error.value), ["a", "b"]);
});

test("thrown non-errors never stringify their contents", () => {
  const thrown = { apiKey: "sk-live-1234567890abcdef", toString: () => "sk-live-1234567890abcdef" };

  const [primary] = sanitizeException(thrown, { appRoots }).errors;

  assert.deepEqual(primary, { type: "NonError", value: "[non-string object]", frames: [] });
  assert.equal(sanitizeException(42, { appRoots }).errors[0]!.type, "NonError");
});

test("an unsafe error name is replaced", () => {
  const error = new Error("x");
  error.name = "Error for /Users/jane";
  assert.equal(sanitizeException(error, { appRoots }).errors[0]!.type, "Error");
});

test("the fingerprint groups the same failure and separates different ones", () => {
  const stack = `    at save (${APP_ROOT}/dist/main/store.js:1:1)`;
  const first = sanitizeException(errorWithStack("disk full at /Users/a", stack), { appRoots });
  const second = sanitizeException(errorWithStack("disk full at /Users/b", stack), { appRoots });
  const other = sanitizeException(errorWithStack("x", `    at load (${APP_ROOT}/dist/main/store.js:1:1)`), { appRoots });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.fingerprint, other.fingerprint);
  assert.match(first.fingerprint, /^[0-9a-f]{32}$/u);
});

test("ids outside the bundled list are reported as custom", () => {
  const known = new Set(["anthropic", "openai"]);
  assert.equal(normalizeKnownId("anthropic", known), "anthropic");
  assert.equal(normalizeKnownId("my-company-gateway", known), "custom");
  assert.equal(normalizeKnownId(undefined, known), "custom");
});

test("counts and uptimes fall into coarse buckets", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10, 11, Number.NaN].map(countBucket), ["0", "1", "2-3", "2-3", "4-10", "4-10", "11+", "0"]);
  assert.deepEqual([5, 60, 599, 600, 3_599, 3_600].map(uptimeBucket), ["<1m", "1-10m", "1-10m", "10-60m", "10-60m", "1h+"]);
});
