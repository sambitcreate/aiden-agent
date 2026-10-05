import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analyzeChangedPaths,
  buildDiffArgs,
  classifyChangedPath,
  decideChangedAreas,
  detectChangedAreas,
  isSafeDocumentationPath,
  parseChangedPaths,
  writeChangedAreaOutputs,
} from "./ci-changes.mjs";

const allFalse = {
  android: false,
  apple: false,
  catalog: false,
  cli: false,
  desktop: false,
  ios: false,
  linux: false,
};
const allTrue = Object.fromEntries(Object.keys(allFalse).map((name) => [name, true]));

function select(...names) {
  return { ...allFalse, ...Object.fromEntries(names.map((name) => [name, true])) };
}

function areasOf(result) {
  return Object.fromEntries(Object.keys(allFalse).map((name) => [name, result[name]]));
}

const desktopOnly = select("desktop", "catalog");

test("changed-area classification is conservative and table-driven", () => {
  const cases = [
    ["docs/guide.md", allFalse],
    ["docs/executable.js", desktopOnly],
    ["docs/chatgpt-ui-element-specimen.html", desktopOnly],
    ["docs/design-guide.md", desktopOnly],
    ["README.md", allFalse],
    ["CHANGELOG.markdown", allFalse],
    ["AGENTS.md", desktopOnly],
    ["CLAUDE.md", allFalse],
    ["PRODUCT.md", allFalse],
    ["LICENSE.md", allFalse],
    ["THIRD_PARTY_NOTICES.md", select("desktop", "catalog", "cli", "linux")],
    ["LICENSE", allTrue],
    ["NOTES.md", allTrue],
    [".papercuts/troubleshooting.md", allFalse],
    [".memory/ci-efficiency.md", allFalse],
    [".memory/notes/history.md", allFalse],
    [".memory/state.json", allTrue],
    ["android/app/src/main/MainActivity.kt", select("android")],
    ["android/app/build.gradle.kts", select("android")],
    ["ios/AidenOnTheGo/ContentView.swift", select("ios")],
    ["renderer/components/chat.tsx", desktopOnly],
    ["renderer/components/settings/linux-keyring.tsx", select("desktop", "catalog", "linux")],
    ["tests/e2e/chat.spec.ts", desktopOnly],
    ["tests/e2e/linux-packaging.spec.ts", select("desktop", "catalog", "linux")],
    ["renderer/shared/provider.ts", allTrue],
    ["main/services/chat.ts", select("desktop", "catalog", "cli", "linux")],
    ["main/services/aiden-remote-router.ts", select("desktop", "catalog", "cli", "linux", "ios", "android")],
    ["main/handlers/aiden-remote.ts", select("desktop", "catalog", "cli", "linux", "ios", "android")],
    ["native/apple-foundation-models/Package.swift", select("desktop", "catalog", "apple")],
    ["native/worktree-file-io/main.c", select("desktop", "catalog", "cli", "linux")],
    ["protocol/aiden-remote/v1/fixtures/contract.json", select("desktop", "catalog", "cli", "ios", "android")],
    ["protocol/aiden-appearance-v1.json", select("desktop", "catalog", "cli", "ios", "android")],
    ["packages/cli/src/commands.ts", select("desktop", "catalog", "cli")],
    ["packages/cli/package.json", select("desktop", "catalog", "cli")],
    ["packages/cli-playground/src/main.tsx", select("cli")],
    ["resources/model-capabilities.json", select("catalog")],
    ["resources/generative-ui/runtime.js", allTrue],
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

test("scoped paths never select mobile or Apple jobs for desktop-only server changes", () => {
  const desktopServer = decideChangedAreas(["main/services/chat.ts", "renderer/components/chat.tsx"]);
  assert.equal(desktopServer.ios, false);
  assert.equal(desktopServer.android, false);
  assert.equal(desktopServer.apple, false);

  // A protocol change and a Remote server change together still reach every
  // contract consumer.
  assert.deepEqual(
    decideChangedAreas(["protocol/aiden-remote/v1/fixtures/contract.json", "main/services/aiden-remote-router.ts"]),
    select("desktop", "catalog", "cli", "linux", "ios", "android"),
  );
  // A CLI-only change keeps the desktop lanes, which run the CLI package tests.
  assert.deepEqual(decideChangedAreas(["packages/cli/src/commands.ts", ".memory/cli.md"]), select("desktop", "catalog", "cli"));
});

test("documentation-only decisions are restricted to the explicit safe paths", () => {
  assert.equal(isSafeDocumentationPath("docs/reference.txt"), false);
  assert.equal(isSafeDocumentationPath("README.md"), true);
  assert.equal(isSafeDocumentationPath("CLAUDE.md"), true);
  assert.equal(isSafeDocumentationPath("PRODUCT.md"), true);
  assert.equal(isSafeDocumentationPath("LICENSE.md"), true);
  // Tests or packaging read these documents.
  assert.equal(isSafeDocumentationPath("AGENTS.md"), false);
  assert.equal(isSafeDocumentationPath("docs/design-guide.md"), false);
  assert.equal(isSafeDocumentationPath("THIRD_PARTY_NOTICES.md"), false);
  assert.equal(isSafeDocumentationPath("LICENSE"), false);
  assert.equal(isSafeDocumentationPath("NOTES.md"), false);
  assert.equal(isSafeDocumentationPath(".papercuts/notes.md"), true);
  assert.equal(isSafeDocumentationPath(".memory/notes.md"), true);
  assert.equal(isSafeDocumentationPath(".memory/../main/notes.md"), false);
  assert.equal(isSafeDocumentationPath("android/README.md"), false);
  assert.equal(isSafeDocumentationPath(".github/README.md"), false);
  assert.equal(isSafeDocumentationPath("renderer/AGENTS.md"), false);
  assert.equal(isSafeDocumentationPath("docs/../main/service.ts"), false);

  assert.deepEqual(decideChangedAreas(["docs/guide.md", "android/app/build.gradle"]), select("android"));
  assert.deepEqual(decideChangedAreas(["README.md", "unknown/new-file.bin"]), allTrue);
  assert.deepEqual(analyzeChangedPaths(["docs/guide.md", "README.md", ".memory/ci.md"]), {
    ...allFalse,
    areas: allFalse,
    changedCount: 3,
    safeDocsOnly: true,
    reason: "documentation-only",
  });
  assert.deepEqual(analyzeChangedPaths(["CLAUDE.md", "renderer/components/chat.tsx"]), {
    ...desktopOnly,
    areas: desktopOnly,
    changedCount: 2,
    safeDocsOnly: false,
    reason: "changed-paths",
  });
});

test("NUL-delimited changed paths preserve rename, deletion, and newline names", () => {
  const paths = parseChangedPaths(Buffer.from("android/old.txt\0android/new.txt\0renderer/line\nname.ts\0"));
  assert.deepEqual(paths, ["android/old.txt", "android/new.txt", "renderer/line\nname.ts"]);
  assert.deepEqual(decideChangedAreas(paths), select("android", "desktop", "catalog"));
  assert.deepEqual(decideChangedAreas(parseChangedPaths("ios/deleted.swift\0")), select("ios"));
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

function fakeGit({
  diffStatus = 0,
  diffOutput = "renderer/app.tsx\0",
  catFileStatus = 0,
  mergeBaseStatus = 0,
  mergeBaseOutput = `${"a".repeat(40)}\n`,
} = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "cat-file") {
      return { status: catFileStatus, stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base") {
      return { status: mergeBaseStatus, stdout: mergeBaseOutput, stderr: "" };
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
  assert.deepEqual(areasOf(result), desktopOnly);
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
  assert.deepEqual(areasOf(pushResult), select("android"));
  assert.equal(push.calls[2].args.at(-1), "base..head");

  for (const invalid of [
    { baseSha: "", headSha: "head" },
    // A created branch whose merge base with main cannot be found.
    { baseSha: "0".repeat(40), headSha: "head", mergeBaseStatus: 1 },
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
      areasOf(invalidResult),
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
  assert.deepEqual(areasOf(forced), allTrue);
  assert.equal(forced.reason, "forced-full");
  assert.equal(push.calls.at(-1).args.at(-1), "base..head");

  const pullRequest = fakeGit({ diffOutput: "docs/guide.md\0" });
  const selected = detectChangedAreas({
    baseSha: "base",
    env: { FORCE_FULL: "true" },
    eventName: "pull_request",
    headSha: "head",
    spawn: pullRequest.spawn,
  });
  assert.deepEqual(areasOf(selected), allFalse);
  assert.equal(selected.reason, "documentation-only");
});

test("a catalog-only push selects only the model catalog area", () => {
  const refresh = fakeGit({ diffOutput: "resources/model-capabilities.json\0" });
  const catalog = detectChangedAreas({
    baseSha: "base",
    env: { FORCE_FULL: "true" },
    eventName: "push",
    headSha: "head",
    spawn: refresh.spawn,
  });
  assert.deepEqual(areasOf(catalog), select("catalog"));
  assert.equal(catalog.reason, "catalog-only");
  assert.equal(catalog.safeDocsOnly, false);

  // Any other path in the same push restores the full main validation.
  for (const extra of ["docs/guide.md", "renderer/components/chat.tsx", "resources/generative-ui/runtime.js"]) {
    const mixed = fakeGit({ diffOutput: `resources/model-capabilities.json\0${extra}\0` });
    const result = detectChangedAreas({
      baseSha: "base",
      env: { FORCE_FULL: "true" },
      eventName: "push",
      headSha: "head",
      spawn: mixed.spawn,
    });
    assert.deepEqual(areasOf(result), allTrue, extra);
    assert.equal(result.reason, "forced-full", extra);
  }

  // A push that creates the catalog bot's branch has no previous tip; it is
  // classified by what it adds over main, so a snapshot-only branch stays catalog-only.
  const created = fakeGit({ diffOutput: "resources/model-capabilities.json\0" });
  const createdResult = detectChangedAreas({
    baseSha: "0".repeat(40),
    env: { FORCE_FULL: "true" },
    eventName: "push",
    headSha: "head",
    spawn: created.spawn,
  });
  assert.deepEqual(areasOf(createdResult), select("catalog"));
  assert.deepEqual(created.calls[0].args, ["merge-base", "origin/main", "head"]);
  assert.equal(created.calls.at(-1).args.at(-1), `${"a".repeat(40)}..head`);
  // Without a merge base the new branch keeps full validation.
  for (const failure of [{ mergeBaseStatus: 1 }, { mergeBaseOutput: "not-a-sha\n" }]) {
    const orphan = fakeGit({ diffOutput: "resources/model-capabilities.json\0", ...failure });
    const result = detectChangedAreas({
      baseSha: "0".repeat(40),
      env: { FORCE_FULL: "true" },
      eventName: "push",
      headSha: "head",
      spawn: orphan.spawn,
    });
    assert.deepEqual(areasOf(result), allTrue);
  }

  // A main push whose diff cannot be read stays full rather than catalog-only.
  for (const failure of [{ diffStatus: 1 }, { catFileStatus: 1 }, { diffOutput: "" }]) {
    const broken = fakeGit({ diffOutput: "resources/model-capabilities.json\0", ...failure });
    const result = detectChangedAreas({
      baseSha: "base",
      env: { FORCE_FULL: "true" },
      eventName: "push",
      headSha: "head",
      spawn: broken.spawn,
    });
    assert.deepEqual(areasOf(result), allTrue, JSON.stringify(failure));
  }
});

test("empty change results select full validation rather than skipping every lane", () => {
  assert.deepEqual(decideChangedAreas([]), allTrue);
  const empty = fakeGit({ diffOutput: "" });
  const result = detectChangedAreas({ baseSha: "base", headSha: "head", eventName: "pull_request", env: {}, spawn: empty.spawn });
  assert.deepEqual(result.areas, allTrue);
});

test("workflow outputs expose every area the CI jobs read", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-changes-"));
  try {
    const outputPath = join(directory, "output");
    writeChangedAreaOutputs(analyzeChangedPaths(["resources/model-capabilities.json"], { forceFull: true }), outputPath);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8").trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    for (const name of Object.keys(allFalse)) {
      assert.equal(outputs[name], name === "catalog" ? "true" : "false", name);
    }
    assert.equal(outputs.decision_reason, "catalog-only");
    assert.match(outputs.summary, /model catalog only/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
