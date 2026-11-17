import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CAUSE_DEPTH,
  MAX_EXCEPTION_FRAMES,
  MAX_EXCEPTION_MESSAGE_LENGTH,
  WITHHELD_MESSAGE,
  countBucket,
  normalizeKnownId,
  parseSanitizedError,
  parseSanitizedFrame,
  redactExceptionMessage,
  rewriteFramePath,
  sanitizeException,
  uptimeBucket,
} from "./analytics-sanitize.js";

const APP_ROOT = "/Applications/Aiden.app/Contents/Resources/app.asar";
// Assembled here so a made-up value never sits in the source as a live-key literal.
const FAKE_TOKEN = ["sk", "live", "abcdefghijklmnopqrstuvwxyz012345"].join("_");
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
  }
});

test("chat text inside an error message never survives, however it got there", () => {
  const prompt = "please draft a letter to my landlord about the mould in flat 4";
  const reply = "Dear Sam, I am sorry to hear about the diagnosis";
  const messages = [
    `Failed to parse model reply: ${reply}`,
    `Unexpected token 'D', "${reply}" is not valid JSON`,
    `400 {"error":"invalid","messages":[{"role":"user","content":"${prompt}"}]}`,
    `Tool arguments rejected for prompt: ${prompt}`,
    prompt,
    `Cannot read properties of undefined (reading '${prompt}')`,
    `${prompt} is not a function`,
    `ENOENT: no such file or directory, open '${prompt}'`,
  ];

  for (const message of messages) {
    const serialized = JSON.stringify(sanitizeException(new Error(message), { appRoots }));
    for (const word of ["landlord", "mould", "diagnosis", "Dear Sam"]) {
      assert.equal(serialized.includes(word), false, `leaked "${word}" from: ${message}`);
    }
    assert.equal(sanitizeException(new Error(message), { appRoots }).errors[0]!.value, WITHHELD_MESSAGE);
  }
  assert.equal(sanitizeException(prompt, { appRoots }).errors[0]!.value, WITHHELD_MESSAGE);
});

test("messages the runtime writes itself stay readable", () => {
  for (const [message, expected] of [
    ["Cannot read properties of undefined (reading 'length')", "Cannot read properties of undefined (reading '[name]')"],
    ["Cannot set properties of null (setting 'x')", "Cannot set properties of null (setting '[name]')"],
    ["model.getUsage is not a function", "[name] is not a function"],
    ["Maximum call stack size exceeded", undefined],
    ["Cannot access 'store' before initialization", "Cannot access '[name]' before initialization"],
    ["EACCES: permission denied, rename '/Users/jane/a' -> '/Users/jane/b'", "EACCES: permission denied, rename '[REDACTED PATH]' -> '[REDACTED PATH]'"],
    ["EIO: i/o error, read", undefined],
    ["Failed to fetch", undefined],
    ["connect ECONNREFUSED", undefined],
    ["ENOENT: no such file or directory, open '/Users/jane/notes/plan.md'", "ENOENT: no such file or directory, open '[REDACTED PATH]'"],
  ] as const) {
    assert.equal(sanitizeException(new Error(message), { appRoots }).errors[0]!.value, expected ?? message);
  }
});

test("a sanitized message reads back unchanged, and a forged one does not get through", () => {
  for (const value of [WITHHELD_MESSAGE, "", "[non-string object]", "Maximum call stack size exceeded"]) {
    assert.equal(redactExceptionMessage(value), value);
  }
  // A kept message survives the second pass a pending record gets.
  for (const raw of [
    "Cannot read properties of undefined (reading 'length')",
    "a.b is not a function",
    "Cannot destructure property 'x' of 'y' as it is undefined.",
    "Class constructor Foo cannot be invoked without 'new'",
    "ENOENT: no such file or directory, open '/Users/jane/a.md'",
  ]) {
    const once = redactExceptionMessage(raw);
    assert.notEqual(once, WITHHELD_MESSAGE);
    assert.equal(redactExceptionMessage(once), once);
  }
  const forged = parseSanitizedError({ type: "Error", value: "the person's private note", frames: [] });
  assert.equal(forged?.value, WITHHELD_MESSAGE);
});

test("text quoted in a message or forged into a stack cannot pass for frames", () => {
  const quoted = `please remember my pin\n    at my secret note (${APP_ROOT}/dist/main/index.js:1:1)`;
  const error = new Error(quoted);
  error.stack = `Error: ${quoted}\n    at realFrame (${APP_ROOT}/dist/main/index.js:9:9)`;
  assert.deepEqual(sanitizeException(error, { appRoots }).errors[0]!.frames.map((frame) => frame.function), ["realFrame"]);

  // A renderer's stack need not match its message at all.
  const forged = {
    name: "Error",
    message: "x",
    stack: [
      `    at my bank pin is 4921 (${APP_ROOT}/dist/renderer/app.js:1:1)`,
      `    at ${FAKE_TOKEN} (${APP_ROOT}/dist/renderer/app.js:1:1)`,
      `    at notes (${APP_ROOT}/tax-return-2025.pdf:1:1)`,
      `    at Object.<anonymous> (${APP_ROOT}/dist/renderer/app.js:2:2)`,
      `    at Foo.bar [as baz] (${APP_ROOT}/dist/renderer/app.js:3:3)`,
    ].join("\n"),
  };
  const frames = sanitizeException(forged, { appRoots }).errors[0]!.frames;
  assert.deepEqual(frames.map((frame) => frame.function), ["?", "?", "?", "Object.<anonymous>", "Foo.bar"]);
  assert.equal(frames[2]!.filename, "<external>");
  assert.equal(JSON.stringify(frames).includes("4921"), false);
  assert.equal(JSON.stringify(frames).includes("tax-return"), false);
});

test("text that fits a system error's shape is not a system error", () => {
  for (const message of [
    "ERROR: my biopsy results are in, call dr smith",
    "EDIT: please cancel my therapy appointment",
    "ＥＲＲＯＲ: ｈｕｎｔｅｒ two is here",
    "ENOENT: my landlord lives here",
    "read ENVIRONMENTSECRET123",
    "ERR_MY_PASSWORD_IS_HUNTER2",
  ]) {
    assert.equal(redactExceptionMessage(message), WITHHELD_MESSAGE, message);
  }
});

test("a name the runtime quotes can be a value from data, so it never survives", () => {
  for (const message of [
    "Cannot read properties of undefined (reading 'Xk9fQ2mZpL7vT3rB8nW4yH6jD1sA5gC0eU')",
    "Cannot set properties of undefined (setting 'sambitbiswas')",
    "my.pin.is.x1234.call.dr.smith.about.the.biopsy is not defined",
    "Cannot access 'hunter2' before initialization",
    "Class constructor Project_Falcon cannot be invoked without 'new'",
    "Cannot destructure property 'jane' of 'my.tax.return' as it is undefined.",
  ]) {
    const kept = redactExceptionMessage(message);
    for (const secret of ["Xk9f", "sambit", "biopsy", "hunter2", "Falcon", "jane", "tax"]) {
      assert.equal(kept.includes(secret), false, `${secret} in ${kept}`);
    }
  }
});

test("an error's name is kept only when it is a known error type", () => {
  for (const [name, expected] of [
    ["TypeError", "TypeError"],
    ["AbortError", "AbortError"],
    ["DOMException", "DOMException"],
    ["PostHogFetchError", "PostHogFetchError"],
    // Shaped like a class, but a name can be set from anything.
    ["AliceCancerError", "Error"],
    ["JaneDoeBiopsyResultsException", "Error"],
    ["ProjectFalconAcmeMergerError", "Error"],
    ["Project_Falcon_Acme_merger", "Error"],
    ["hunter2", "Error"],
    ["Xk9fQ2mZpL7vT3rB8nW4yH6jD1sA5gC0eU", "Error"],
    ["My_Custom_Provider_Acme", "Error"],
  ] as const) {
    assert.equal(sanitizeException({ name, message: "hi" }, { appRoots }).errors[0]!.type, expected);
    assert.equal(sanitizeException({ message: "x", cause: { name, message: "hi" } }, { appRoots }).errors[1]!.type, expected);
  }
  assert.equal(parseSanitizedError({ type: "Project_Falcon", value: "", frames: [] }), undefined);
  assert.equal(parseSanitizedError({ type: "AliceCancerError", value: "", frames: [] }), undefined);
  assert.ok(parseSanitizedError({ type: "NonError", value: "", frames: [] }));
});

test("a folder named like the bundle, in any form, is not the bundle", () => {
  for (const location of [
    "/Users/sam/app.asar/AcmeMergerPlan/budget_2027.js",
    "file:///Users/sam/app.asar/AcmeMergerPlan/budget_2027.js",
    "C:\\Users\\sam\\app.asar\\Plan\\budget.js",
    "\\\\server\\share\\app.asar\\Plan\\budget.js",
    "https://evil.example/app.asar/UserName/plan.js",
  ]) {
    assert.deepEqual(rewriteFramePath(location, appRoots), { filename: "<external>", inApp: false }, location);
  }
});

test("a message longer than any bound still cannot pass its tail off as frames", () => {
  const tail = `\n    at handleAcmeMerger (<anonymous>)\n    at patientNotes (node:internal/patient_has_cancer/notes:1:1)\n    at cardNumber (${APP_ROOT}/a.js:4111111111111111:1)`;
  const message = `${"m".repeat(20_000)}${tail}`;
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at realFrame (${APP_ROOT}/a.js:9:9)`;
  assert.deepEqual(sanitizeException(error, { appRoots }).errors[0]!.frames.map((frame) => frame.function), ["realFrame"]);

  // The same lines when the header does not match at all, as in a stack from
  // an error whose message was changed after it was created.
  const frames = sanitizeException({ message: "other", stack: tail }, { appRoots }).errors[0]!.frames;
  const sent = JSON.stringify(frames);
  for (const leak of ["Acme", "patient", "cancer", "4111111111111111", "cardNumber"]) assert.equal(sent.includes(leak), false, leak);
});

test("a read-back frame cannot carry what the sanitizer would have removed", () => {
  const base = { filename: "<anonymous>", function: "?", inApp: false };
  assert.ok(parseSanitizedFrame(base));
  assert.equal(parseSanitizedFrame({ ...base, function: "handleAcmeMerger" }), undefined);
  assert.equal(parseSanitizedFrame({ ...base, filename: "node:patient_has_cancer" }), undefined);
  assert.equal(parseSanitizedFrame({ filename: "app:///a.js", function: "f", lineno: 4111111111111111, colno: 1, inApp: true }), undefined);
  assert.ok(parseSanitizedFrame({ filename: "node:fs", function: "?", lineno: 1, colno: 1, inApp: false }));
});

test("a token-shaped error name falls back to Error", () => {
  const error = new Error("x");
  error.name = FAKE_TOKEN;
  assert.equal(sanitizeException(error, { appRoots }).errors[0]!.type, "Error");
  error.name = "ZodError";
  assert.equal(sanitizeException(error, { appRoots }).errors[0]!.type, "ZodError");
});

test("enormous messages and stacks finish quickly and stay bounded", () => {
  const error = new Error(`${"a@".repeat(2_000_000)}`);
  error.stack = `${"    at ".repeat(1_000_000)}\n${"x ".repeat(2_000_000)}`;
  const started = performance.now();
  const result = sanitizeException(error, { appRoots });
  assert.ok(performance.now() - started < 500);
  assert.equal(result.errors[0]!.value, WITHHELD_MESSAGE);
});

test("frames inside the app bundle keep a relative path, function and position", () => {
  const error = errorWithStack("Failed to fetch", [
    `    at async handleTurn (${APP_ROOT}/dist/main/chat.js:42:7)`,
    `    at runTool (${APP_ROOT}/node_modules/pi/agent.js:9:1)`,
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at userScript (/Users/someone/hook.js:1:1)",
  ].join("\n"));

  const [primary] = sanitizeException(error, { appRoots }).errors;

  assert.deepEqual(primary!.frames, [
    { filename: "app:///dist/main/chat.js", function: "handleTurn", lineno: 42, colno: 7, inApp: true },
    { filename: "app:///node_modules/pi/agent.js", function: "runTool", lineno: 9, colno: 1, inApp: false },
    { filename: "node:internal", function: "?", lineno: 95, colno: 5, inApp: false },
    { filename: "<external>", function: "?", inApp: false },
  ]);
});

test("a packaged build resolves frames under its own app path, wherever it is installed", () => {
  assert.deepEqual(
    rewriteFramePath(
      "/Volumes/External/My Apps/Aiden.app/Contents/Resources/app.asar/dist/main/index.js",
      ["/Volumes/External/My Apps/Aiden.app/Contents/Resources/app.asar"],
    ),
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
  const a = new Error("Failed to fetch");
  const b = new Error("Load failed");
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = a;

  assert.deepEqual(sanitizeException(a, { appRoots }).errors.map((error) => error.value), ["Failed to fetch", "Load failed"]);
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
