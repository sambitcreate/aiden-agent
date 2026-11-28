import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOOKS_PATH, installGitHooks } from "./install-git-hooks.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "CI" ||
      key === "NODE_PATH" ||
      key === "NODE_OPTIONS" ||
      key === "AIDEN_WORKTREE_ROOT" ||
      key === "AIDEN_COMMON_ROOT" ||
      key.startsWith("GIT_")
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runCmd(command, args, { cwd, env = sanitizedEnv() }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runGit(cwd, args, envOverrides = {}) {
  return runCmd("git", args, { cwd, env: sanitizedEnv(envOverrides) });
}

function createTempWorkspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-git-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedHookedRepo(
  repoDir,
  { policyCommand = "node -e \"process.exit(0)\"", verifyStaticCommand, includeTypeCheck = false } = {},
) {
  mkdirSync(path.join(repoDir, ".githooks"), { recursive: true });
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });

  for (const hook of ["pre-commit", "pre-push"]) {
    const dest = path.join(repoDir, ".githooks", hook);
    cpSync(path.join(REPO_ROOT, ".githooks", hook), dest);
    chmodSync(dest, 0o755);
  }

  for (const script of [
    "install-git-hooks.mjs",
    "worktree-node-modules.mjs",
    "run-pre-commit.mjs",
    "check-aiden-rules.mjs",
  ]) {
    cpSync(path.join(REPO_ROOT, "scripts", script), path.join(repoDir, "scripts", script));
  }

  writeFileSync(path.join(repoDir, "scripts/aiden-rules-allowlist.json"), "[]\n", "utf8");
  cpSync(path.join(REPO_ROOT, "eslint.config.js"), path.join(repoDir, "eslint.config.js"));
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules\n", "utf8");

  if (includeTypeCheck) {
    writeFileSync(
      path.join(repoDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
            baseUrl: ".",
            paths: {
              "*": ["./node_modules/@types/*", "./node_modules/*"],
            },
          },
          include: ["renderer"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const manifest = {
    name: "aiden-hook-fixture",
    private: true,
    type: "module",
    scripts: {
      prepare: "node scripts/install-git-hooks.mjs",
      lint: "eslint .",
      "type-check":
        "NODE_OPTIONS=\"${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096\" tsc --noEmit",
      "check:aiden-rules": "node scripts/check-aiden-rules.mjs",
      "test:ci-policy": policyCommand,
      "verify:static":
        verifyStaticCommand ??
        (includeTypeCheck
          ? "npm run test:ci-policy && npm run type-check && npm run lint && npm run check:aiden-rules"
          : "npm run test:ci-policy && npm run lint && npm run check:aiden-rules"),
    },
  };
  writeFileSync(path.join(repoDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(repoDir, "node_modules"), "dir");

  assert.equal(runGit(repoDir, ["init", "-b", "main"]).status, 0);
  assert.equal(runGit(repoDir, ["config", "--local", "user.name", "Test User"]).status, 0);
  assert.equal(runGit(repoDir, ["config", "--local", "user.email", "test@example.com"]).status, 0);
  assert.equal(runGit(repoDir, ["add", "."]).status, 0);
  assert.equal(runGit(repoDir, ["commit", "-m", "initial commit"]).status, 0);
}

test("prepare configures repository-local core.hooksPath only when .git exists, CI is unset, and no custom hooksPath is set", (t) => {
  const workspace = createTempWorkspace(t);

  // 1. Directory without .git skips cleanly.
  const noGitDir = path.join(workspace, "no-git");
  mkdirSync(noGitDir, { recursive: true });
  const noGitResult = installGitHooks({ cwd: noGitDir, env: sanitizedEnv() });
  assert.equal(noGitResult.status, 0);
  assert.equal(noGitResult.action, "skipped-no-git");
  assert.equal(existsSync(path.join(noGitDir, ".git")), false);

  // 2. Real git repo with CI=1 leaves Git configuration unchanged.
  const repoDir = path.join(workspace, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedHookedRepo(repoDir);

  const ciPrepare = runCmd("npm", ["run", "prepare"], {
    cwd: repoDir,
    env: sanitizedEnv({ CI: "1" }),
  });
  assert.equal(ciPrepare.status, 0, ciPrepare.stderr);
  assert.equal(runGit(repoDir, ["config", "--local", "--get", "core.hooksPath"]).status, 1);

  // 3. Local prepare without CI sets core.hooksPath to .githooks.
  const localPrepare = runCmd("npm", ["run", "prepare"], {
    cwd: repoDir,
    env: sanitizedEnv(),
  });
  assert.equal(localPrepare.status, 0, localPrepare.stderr);
  const configured = runGit(repoDir, ["config", "--local", "--get", "core.hooksPath"]);
  assert.equal(configured.status, 0);
  assert.equal(configured.stdout.trim(), DEFAULT_HOOKS_PATH);

  // 4. Custom user core.hooksPath is preserved.
  assert.equal(runGit(repoDir, ["config", "--local", "core.hooksPath", ".custom-hooks"]).status, 0);
  const customResult = installGitHooks({ cwd: repoDir, env: sanitizedEnv() });
  assert.equal(customResult.status, 0);
  assert.equal(customResult.action, "preserved-custom");
  assert.equal(
    runGit(repoDir, ["config", "--local", "--get", "core.hooksPath"]).stdout.trim(),
    ".custom-hooks",
  );
});

test("pre-commit blocks staged ESLint and Aiden rule violations with file and line diagnostics", (t) => {
  const workspace = createTempWorkspace(t);
  const repoDir = path.join(workspace, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedHookedRepo(repoDir);
  assert.equal(installGitHooks({ cwd: repoDir, env: sanitizedEnv() }).status, 0);

  const initialHead = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();

  // Staged ESLint violation fails with exit code 1 and file:line diagnostics.
  mkdirSync(path.join(repoDir, "renderer"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "renderer/lint-bad.ts"),
    "const unusedLocal = 123;\nexport const ok = 1;\n",
    "utf8",
  );
  assert.equal(runGit(repoDir, ["add", "renderer/lint-bad.ts"]).status, 0);

  const lintCommit = runGit(repoDir, ["commit", "-m", "should fail eslint"]);
  assert.equal(lintCommit.status, 1);
  assert.match(lintCommit.stderr, /renderer\/lint-bad\.ts:1:/u);
  assert.match(lintCommit.stderr, /@typescript-eslint\/no-unused-vars/u);
  assert.equal(runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);

  assert.equal(runGit(repoDir, ["reset", "--hard", "HEAD"]).status, 0);

  // Staged Aiden design-rule violation fails with exit code 1 and file:line diagnostics.
  mkdirSync(path.join(repoDir, "renderer/components"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "renderer/components/rule-bad.tsx"),
    'import { BrainCircuit } from "lucide-react";\nexport const Icon = () => <BrainCircuit />;\n',
    "utf8",
  );
  assert.equal(runGit(repoDir, ["add", "renderer/components/rule-bad.tsx"]).status, 0);

  const ruleCommit = runGit(repoDir, ["commit", "-m", "should fail aiden rules"]);
  assert.equal(ruleCommit.status, 1);
  assert.match(ruleCommit.stderr, /renderer\/components\/rule-bad\.tsx:1 no-brain-icon/u);
  assert.equal(runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
});

test("pre-commit reads staged content from the Git index without mutating unstaged working-tree edits", (t) => {
  const workspace = createTempWorkspace(t);
  const repoDir = path.join(workspace, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedHookedRepo(repoDir);
  assert.equal(installGitHooks({ cwd: repoDir, env: sanitizedEnv() }).status, 0);

  mkdirSync(path.join(repoDir, "renderer/components"), { recursive: true });
  const targetPath = path.join(repoDir, "renderer/components/widget-fixture.tsx");

  // Case A: Staged index is valid, unstaged working tree has ESLint + Aiden rule violations.
  const stagedClean = "export const Widget = () => <div>ok</div>;\n";
  const unstagedBroken = [
    'import { BrainCircuit } from "lucide-react";',
    "const unusedDraft = 99;",
    "export const Widget = () => <BrainCircuit />;",
    "",
  ].join("\n");

  writeFileSync(targetPath, stagedClean, "utf8");
  assert.equal(runGit(repoDir, ["add", "renderer/components/widget-fixture.tsx"]).status, 0);
  writeFileSync(targetPath, unstagedBroken, "utf8");

  const cleanCommit = runGit(repoDir, ["commit", "-m", "commit staged clean"]);
  assert.equal(cleanCommit.status, 0, cleanCommit.stderr);
  assert.equal(
    runGit(repoDir, ["show", "HEAD:renderer/components/widget-fixture.tsx"]).stdout,
    stagedClean,
  );
  assert.equal(readFileSync(targetPath, "utf8"), unstagedBroken);

  // Case B: Staged index has violation, unstaged working tree fixes it.
  assert.equal(runGit(repoDir, ["add", "renderer/components/widget-fixture.tsx"]).status, 0);
  const unstagedFixed = "export const Widget = () => <span>fixed in working tree only</span>;\n";
  writeFileSync(targetPath, unstagedFixed, "utf8");

  const brokenCommit = runGit(repoDir, ["commit", "-m", "commit staged broken"]);
  assert.equal(brokenCommit.status, 1);
  assert.match(brokenCommit.stderr, /renderer\/components\/widget-fixture\.tsx:1 no-brain-icon/u);
  assert.match(brokenCommit.stderr, /renderer\/components\/widget-fixture\.tsx:2:/u);
  assert.equal(readFileSync(targetPath, "utf8"), unstagedFixed);
});

test("pre-commit runs test:ci-policy when staged paths touch CI or policy surfaces", (t) => {
  const workspace = createTempWorkspace(t);
  const markerPath = path.join(workspace, "policy-ran.txt");
  const repoDir = path.join(workspace, "repo");
  mkdirSync(repoDir, { recursive: true });

  seedHookedRepo(repoDir, {
    policyCommand: `node -e 'const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(markerPath)}, "ran"); process.exit(process.env.FAIL_POLICY === "1" ? 1 : 0);'`,
  });
  assert.equal(installGitHooks({ cwd: repoDir, env: sanitizedEnv() }).status, 0);

  mkdirSync(path.join(repoDir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(repoDir, ".github/workflows/ci.yml"), "name: CI\n", "utf8");
  assert.equal(runGit(repoDir, ["add", ".github/workflows/ci.yml"]).status, 0);

  const failedPolicy = runGit(repoDir, ["commit", "-m", "workflow edit"], { FAIL_POLICY: "1" });
  assert.equal(failedPolicy.status, 1);
  assert.equal(existsSync(markerPath), true);

  rmSync(markerPath, { force: true });
  const passedPolicy = runGit(repoDir, ["commit", "-m", "workflow edit"], { FAIL_POLICY: "0" });
  assert.equal(passedPolicy.status, 0, passedPolicy.stderr);
  assert.equal(existsSync(markerPath), true);
});

test("pre-push runs verify:static on git push and chains through a reviewed pre-push proxy", (t) => {
  const workspace = createTempWorkspace(t);
  const remoteDir = path.join(workspace, "remote.git");
  const repoDir = path.join(workspace, "repo");
  const pushMarker = path.join(workspace, "verify-static.log");
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  assert.equal(runGit(remoteDir, ["init", "--bare"]).status, 0);

  seedHookedRepo(repoDir, {
    verifyStaticCommand: `node -e 'const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(pushMarker)}, "verify\\n"); if (process.env.FAIL_STATIC === "1") process.exit(1);'`,
  });
  assert.equal(installGitHooks({ cwd: repoDir, env: sanitizedEnv() }).status, 0);
  assert.equal(runGit(repoDir, ["remote", "add", "origin", remoteDir]).status, 0);

  // Failing verify:static aborts git push.
  const failedPush = runGit(repoDir, ["push", "-u", "origin", "main"], { FAIL_STATIC: "1" });
  assert.notEqual(failedPush.status, 0);
  assert.equal(readFileSync(pushMarker, "utf8"), "verify\n");
  assert.notEqual(runGit(remoteDir, ["rev-parse", "--verify", "refs/heads/main"]).status, 0);

  // Passing verify:static allows git push.
  const okPush = runGit(repoDir, ["push", "-u", "origin", "main"], { FAIL_STATIC: "0" });
  assert.equal(okPush.status, 0, okPush.stderr);
  assert.equal(readFileSync(pushMarker, "utf8"), "verify\nverify\n");
  assert.equal(
    runGit(remoteDir, ["rev-parse", "refs/heads/main"]).stdout.trim(),
    runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim(),
  );

  // Verify GitService prepareReviewedPrePushProxy resolution & chaining contract.
  const resolvedHook = runGit(repoDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks/pre-push",
  ]);
  assert.equal(resolvedHook.status, 0);
  assert.equal(resolvedHook.stdout.trim(), path.join(repoDir, ".githooks/pre-push"));

  writeFileSync(path.join(repoDir, "README.md"), "# Updated\n", "utf8");
  assert.equal(runGit(repoDir, ["add", "README.md"]).status, 0);
  assert.equal(runGit(repoDir, ["commit", "-m", "second commit"]).status, 0);

  const proxyDir = path.join(workspace, "proxy-hooks");
  const completedPath = path.join(proxyDir, "completed");
  mkdirSync(proxyDir, { recursive: true });
  writeFileSync(
    path.join(proxyDir, "pre-push"),
    [
      "#!/bin/sh",
      "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0",
      `"${resolvedHook.stdout.trim()}" "$1" "$2"`,
      "status=$?",
      'if [ "$status" -ne 0 ]; then exit "$status"; fi',
      `printf 'complete\\n' > "${completedPath}"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

  const blockedProxyPush = runGit(repoDir, ["push", "origin", "main"], {
    FAIL_STATIC: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: proxyDir,
  });
  assert.notEqual(blockedProxyPush.status, 0);
  assert.equal(existsSync(completedPath), false);

  const allowedProxyPush = runGit(repoDir, ["push", "origin", "main"], {
    FAIL_STATIC: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: proxyDir,
  });
  assert.equal(allowedProxyPush.status, 0, allowedProxyPush.stderr);
  assert.equal(readFileSync(completedPath, "utf8"), "complete\n");
});

test("managed worktree add bypasses .githooks via core.hooksPath=/dev/null and linked worktrees resolve node_modules from the main checkout", (t) => {
  const workspace = createTempWorkspace(t);
  const remoteDir = path.join(workspace, "remote.git");
  const repoDir = path.join(workspace, "main-checkout");
  const linkedWorktree = path.join(workspace, "linked-worktree");
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  assert.equal(runGit(remoteDir, ["init", "--bare"]).status, 0);
  seedHookedRepo(repoDir, { includeTypeCheck: true });
  mkdirSync(path.join(repoDir, "renderer"), { recursive: true });
  writeFileSync(path.join(repoDir, "renderer/init.ts"), "export const ready: string = process.platform;\n", "utf8");
  assert.equal(runGit(repoDir, ["add", "renderer/init.ts"]).status, 0);
  assert.equal(runGit(repoDir, ["commit", "-m", "add typed file"]).status, 0);
  assert.equal(installGitHooks({ cwd: repoDir, env: sanitizedEnv() }).status, 0);
  assert.equal(runGit(repoDir, ["remote", "add", "origin", remoteDir]).status, 0);
  assert.equal(runGit(repoDir, ["push", "-u", "origin", "main"]).status, 0);

  // Add a failing post-checkout hook in .githooks to prove per-command core.hooksPath=/dev/null bypasses hooks.
  const postCheckoutHook = path.join(repoDir, ".githooks/post-checkout");
  writeFileSync(postCheckoutHook, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });

  const unguardedWorktree = runGit(repoDir, [
    "worktree",
    "add",
    path.join(workspace, "unguarded-wt"),
    "-b",
    "unguarded",
  ]);
  assert.notEqual(unguardedWorktree.status, 0);

  const guardedWorktree = runGit(
    repoDir,
    ["worktree", "add", linkedWorktree, "-b", "feature/worktree"],
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    },
  );
  assert.equal(guardedWorktree.status, 0, guardedWorktree.stderr);
  assert.equal(existsSync(path.join(linkedWorktree, "node_modules")), false);

  // Commit and push inside the linked worktree (which has no local node_modules).
  mkdirSync(path.join(linkedWorktree, "renderer"), { recursive: true });
  writeFileSync(path.join(linkedWorktree, "renderer/bad.ts"), "const unusedInWt = 1;\n", "utf8");
  assert.equal(runGit(linkedWorktree, ["add", "renderer/bad.ts"]).status, 0);
  const failedWtCommit = runGit(linkedWorktree, ["commit", "-m", "bad worktree commit"]);
  assert.equal(failedWtCommit.status, 1);
  assert.match(failedWtCommit.stderr, /renderer\/bad\.ts:1:/u);

  writeFileSync(path.join(linkedWorktree, "renderer/bad.ts"), "export const validInWt = 1;\n", "utf8");
  assert.equal(runGit(linkedWorktree, ["add", "renderer/bad.ts"]).status, 0);
  const passedWtCommit = runGit(linkedWorktree, ["commit", "-m", "valid worktree commit"]);
  assert.equal(passedWtCommit.status, 0, passedWtCommit.stderr);

  const wtPush = runGit(linkedWorktree, ["push", "-u", "origin", "feature/worktree"]);
  assert.equal(wtPush.status, 0, wtPush.stderr);
  assert.equal(existsSync(path.join(linkedWorktree, "node_modules")), false);
  assert.equal(runGit(linkedWorktree, ["status", "--porcelain", "--ignored"]).stdout.trim(), "");
});
