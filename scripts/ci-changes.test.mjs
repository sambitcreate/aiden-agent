import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  analyzeChangedPaths,
  buildDiffArgs,
  classifyChangedPath,
  decideChangedAreas,
  detectChangedAreas,
  isSafeDocumentationPath,
  parseChangedPaths,
} from "./ci-changes.mjs";

const allFalse = { android: false, apple: false, desktop: false, ios: false };
const allTrue = { android: true, apple: true, desktop: true, ios: true };

function area(name) {
  return { ...allFalse, [name]: true };
}

test("changed-area classification is conservative and table-driven", () => {
  const cases = [
    ["docs/guide.md", allFalse],
    ["README.md", allFalse],
    ["CHANGELOG.markdown", allFalse],
    [".papercuts/troubleshooting.md", allFalse],
    ["android/app/src/main/MainActivity.kt", area("android")],
    ["ios/AidenOnTheGo/ContentView.swift", area("ios")],
    ["renderer/components/chat.tsx", area("desktop")],
    ["tests/e2e/chat.spec.ts", area("desktop")],
    ["renderer/shared/provider.ts", allTrue],
    ["main/services/chat.ts", allTrue],
    ["native/apple-foundation-models/Package.swift", allTrue],
    ["scripts/ci-changes.mjs", allTrue],
    [".github/workflows/ci.yml", allTrue],
    ["package-lock.json", allTrue],
    ["vite.config.ts", allTrue],
    ["unknown/new-file.bin", allTrue],
  ];

  for (const [path, expected] of cases) {
    assert.deepEqual(classifyChangedPath(path), expected, path);
    assert.deepEqual(decideChangedAreas([path]), expected, path);
  }
});

test("documentation-only decisions are restricted to the explicit safe paths", () => {
  assert.equal(isSafeDocumentationPath("docs/reference.txt"), true);
  assert.equal(isSafeDocumentationPath("README.md"), true);
  assert.equal(isSafeDocumentationPath(".papercuts/notes.md"), true);
  assert.equal(isSafeDocumentationPath("android/README.md"), false);
  assert.equal(isSafeDocumentationPath(".github/README.md"), false);
  assert.equal(isSafeDocumentationPath("docs/../main/service.ts"), false);

  assert.deepEqual(decideChangedAreas(["docs/guide.md", "android/app/build.gradle"]), area("android"));
  assert.deepEqual(decideChangedAreas(["README.md", "unknown/new-file.bin"]), allTrue);
  assert.deepEqual(analyzeChangedPaths(["docs/guide.md", "README.md"]), {
    ...allFalse,
    areas: allFalse,
    changedCount: 2,
    safeDocsOnly: true,
    reason: "documentation-only",
  });
});

test("NUL-delimited changed paths preserve rename, deletion, and newline names", () => {
  const paths = parseChangedPaths(Buffer.from("android/old.txt\0android/new.txt\0renderer/line\nname.ts\0"));
  assert.deepEqual(paths, ["android/old.txt", "android/new.txt", "renderer/line\nname.ts"]);
  assert.deepEqual(decideChangedAreas(paths), { ...allFalse, android: true, desktop: true });
  assert.deepEqual(decideChangedAreas(parseChangedPaths("ios/deleted.swift\0")), area("ios"));
});

test("pull requests use the actual triple-dot range and pushes use a two-dot range", () => {
  assert.deepEqual(buildDiffArgs({ eventName: "pull_request", baseSha: "base", headSha: "head" }), [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "base...head",
  ]);
  assert.deepEqual(buildDiffArgs({ eventName: "push", baseSha: "base", headSha: "head" }), [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "base..head",
  ]);
});

function fakeGit({ diffStatus = 0, diffOutput = "renderer/app.tsx\0", catFileStatus = 0 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "cat-file") {
      return { status: catFileStatus, stdout: "", stderr: "" };
    }
    return { status: diffStatus, stdout: diffOutput, stderr: "" };
  };
  return { calls, spawn };
}

test("git-backed detection reads only NUL-safe output and fails open", () => {
  const pullRequest = fakeGit({ diffOutput: "renderer/app.tsx\0" });
  const result = detectChangedAreas({
    baseSha: "base",
    cwd: "/repo",
    env: {},
    eventName: "pull_request",
    headSha: "head",
    spawn: pullRequest.spawn,
  });
  assert.deepEqual({ desktop: result.desktop, apple: result.apple, ios: result.ios, android: result.android }, area("desktop"));
  assert.equal(pullRequest.calls[2].args.at(-1), "base...head");
  assert.equal(pullRequest.calls[2].options.shell, false);

  const push = fakeGit({ diffOutput: "android/app/build.gradle\0" });
  const pushResult = detectChangedAreas({
    baseSha: "base",
    env: {},
    eventName: "push",
    headSha: "head",
    spawn: push.spawn,
  });
  assert.deepEqual({ desktop: pushResult.desktop, apple: pushResult.apple, ios: pushResult.ios, android: pushResult.android }, area("android"));
  assert.equal(push.calls[2].args.at(-1), "base..head");

  for (const invalid of [
    { baseSha: "", headSha: "head" },
    { baseSha: "0".repeat(40), headSha: "head" },
    { baseSha: "base", headSha: "head", catFileStatus: 1 },
    { baseSha: "base", headSha: "head", diffStatus: 1 },
  ]) {
    const fake = fakeGit(invalid);
    const invalidResult = detectChangedAreas({
      baseSha: invalid.baseSha,
      env: {},
      eventName: "push",
      headSha: invalid.headSha,
      spawn: fake.spawn,
    });
    assert.deepEqual(
      { desktop: invalidResult.desktop, apple: invalidResult.apple, ios: invalidResult.ios, android: invalidResult.android },
      allTrue,
    );
  }
});

test("unknown changed paths force all checks even when a known area is also changed", () => {
  const result = analyzeChangedPaths(["android/app/src/Main.kt", "new-root-file"]);
  assert.deepEqual(result.areas, allTrue);
  assert.equal(result.reason, "unknown-path");
  assert.equal(result.safeDocsOnly, false);
});

test("FORCE_FULL applies to main pushes while pull requests keep path selection", () => {
  assert.deepEqual(decideChangedAreas(["docs/guide.md"], { forceFull: true }), allTrue);
  assert.deepEqual(decideChangedAreas(["docs/guide.md"], { eventName: "pull_request", forceFull: true }), allFalse);
  assert.equal(analyzeChangedPaths(["docs/guide.md"], { forceFull: true }).reason, "forced-full");

  const push = fakeGit({ diffOutput: "docs/guide.md\0" });
  const forced = detectChangedAreas({
    baseSha: "base",
    env: { FORCE_FULL: "true" },
    eventName: "push",
    headSha: "head",
    spawn: push.spawn,
  });
  assert.deepEqual({ desktop: forced.desktop, apple: forced.apple, ios: forced.ios, android: forced.android }, allTrue);
  assert.equal(forced.reason, "forced-full");
  assert.equal(push.calls.length, 0);

  const pullRequest = fakeGit({ diffOutput: "docs/guide.md\0" });
  const selected = detectChangedAreas({
    baseSha: "base",
    env: { FORCE_FULL: "true" },
    eventName: "pull_request",
    headSha: "head",
    spawn: pullRequest.spawn,
  });
  assert.deepEqual({ desktop: selected.desktop, apple: selected.apple, ios: selected.ios, android: selected.android }, allFalse);
  assert.equal(selected.reason, "documentation-only");
});
