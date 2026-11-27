import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitService } from "./git.js";
import { resolveGitExecutable } from "./git-executable.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import type { Workspace } from "./types.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

const execFileAsync = promisify(execFile);
// On macOS, select Apple's OS-managed `/usr/bin/git` (resolved via xcode-select
// to Apple-signed CLT/Xcode Git) so zero-spawn tests exercise the signed OS
// fast path even on hosts where Homebrew `git` precedes `/usr/bin` on PATH.
const TRUSTED_NATIVE_GIT = process.platform === "darwin" ? "/usr/bin/git" : "git";

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function fixture(t: test.TestContext): Promise<{
  workspace: Workspace;
  worktreePath: string;
}> {
  const root = await temporaryDirectory(t, "aiden-worktree-admission-");
  const repositoryPath = path.join(root, "repository");
  const worktreePath = path.join(root, "worktree");
  const workspacePath = path.join(worktreePath, "packages", "app");
  const worktreeGitDir = path.join(repositoryPath, ".git", "worktrees", "app");
  await fs.mkdir(repositoryPath, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(worktreeGitDir, { recursive: true });
  const checkoutIdentity = await fs.lstat(worktreePath);
  return {
    worktreePath,
    workspace: {
      id: "workspace-1",
      name: "Managed",
      folderPath: workspacePath,
      permission: "full",
      managedWorktree: {
        repositoryPath,
        worktreePath,
        branch: "codex/managed",
        worktreeGitDir,
        ownershipToken: "00000000-0000-4000-8000-000000000000",
        worktreeDevice: checkoutIdentity.dev,
        worktreeInode: checkoutIdentity.ino,
        createdFromHead: "a".repeat(40),
      },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

test("admits only the exact marked registration and nested workspace scope", async (t) => {
  const { workspace } = await fixture(t);
  let calls = 0;
  let pendingCalls = 0;
  await assertManagedWorktreeAdmission(
    workspace,
    async (...args) => {
      calls += 1;
      assert.deepEqual(args, [
        workspace.managedWorktree?.repositoryPath,
        workspace.managedWorktree?.worktreePath,
        workspace.managedWorktree?.branch,
        workspace.managedWorktree?.worktreeGitDir,
        workspace.managedWorktree?.ownershipToken,
        workspace.managedWorktree?.worktreeDevice,
        workspace.managedWorktree?.worktreeInode,
      ]);
      return true;
    },
    async (...args) => {
      pendingCalls += 1;
      assert.deepEqual(args, [
        workspace.managedWorktree?.worktreePath,
        workspace.managedWorktree?.worktreeGitDir,
        workspace.managedWorktree?.ownershipToken,
      ]);
      return false;
    },
  );
  assert.equal(calls, 1);
  assert.equal(pendingCalls, 1);
});

test("a durable deletion intent closes managed-worktree authority before usability checks", async (t) => {
  const { workspace } = await fixture(t);
  let usabilityChecks = 0;
  await assert.rejects(
    assertManagedWorktreeAdmission(
      workspace,
      async () => {
        usabilityChecks += 1;
        return true;
      },
      async () => true,
    ),
    /no longer available/u,
  );
  assert.equal(usabilityChecks, 0);
});

test("fails closed for markerless, unregistered, escaped, and symlink-replaced workspaces", async (t) => {
  const { workspace, worktreePath } = await fixture(t);
  const verifier = async () => true;

  await assert.rejects(
    assertManagedWorktreeAdmission(
      {
        ...workspace,
        managedWorktree: { ...workspace.managedWorktree!, ownershipToken: undefined },
      },
      verifier,
    ),
    /no longer available/u,
  );
  await assert.rejects(
    assertManagedWorktreeAdmission(workspace, async () => false),
    /no longer available/u,
  );
  await assert.rejects(
    assertManagedWorktreeAdmission(
      { ...workspace, folderPath: path.dirname(worktreePath) },
      verifier,
    ),
    /no longer available/u,
  );

  const outside = path.join(path.dirname(worktreePath), "replacement");
  await fs.mkdir(outside);
  const linked = path.join(worktreePath, "linked");
  await fs.symlink(outside, linked);
  await assert.rejects(
    assertManagedWorktreeAdmission({ ...workspace, folderPath: linked }, verifier),
    /no longer available/u,
  );
});

test("GitService.managedWorktreeUsable verifies modern worktrees via 0-spawn pure FS and catches live external drift", async (t) => {
  const prevGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    if (prevGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobalConfig;
    if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
  });
  const temp = await temporaryDirectory(t, "aiden-usable-fs-");
  const repo = path.join(temp, "repo");
  const worktreesRoot = path.join(temp, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Aiden Test"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "initial"]);

  const service = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  await service.info(repo);
  const created = await service.createWorktree(repo, worktreesRoot, "aiden/pure-fs");

  let gitSpawns = 0;
  const internals = service as unknown as {
    run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
  };
  const originalRun = internals.run.bind(service);
  internals.run = async (cwd, args, options) => {
    gitSpawns += 1;
    return originalRun(cwd, args, options);
  };

  // Seeded display info after createWorktree requires 0 git spawns.
  const seededInfo = await service.info(created.path);
  assert.equal(seededInfo.isRepo, true);
  assert.equal(seededInfo.branch, "aiden/pure-fs");
  assert.equal(seededInfo.uncommitted, 0);
  assert.equal(gitSpawns, 0, "immediate post-create gitInfo should hit the seeded display cache");

  // Live pure-FS admission uses 0 git spawns for loose refs.
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(gitSpawns, 0, "pure-FS usability verification must spawn 0 git processes");

  // Still works with 0 git spawns after refs are packed into packed-refs.
  await runGit(repo, ["pack-refs", "--all"]);
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(gitSpawns, 0);

  // External branch switch is rejected immediately (live, never cached across calls).
  await runGit(created.path, ["switch", "-c", "aiden/drifted"]);
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    false,
  );
  assert.equal(gitSpawns, 0);

  // Switch back, then tamper ownership marker: immediately rejected with 0 spawns.
  await runGit(created.path, ["switch", created.branch]);
  await fs.writeFile(
    path.join(created.worktreeGitDir, "aiden-owner"),
    "00000000-0000-4000-8000-000000000000\n",
  );
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    false,
  );
  assert.equal(gitSpawns, 0);

  // Restore valid ownership marker, verify 0-spawn admission works again, then
  // modify repository config (`core.bare=true`): must fall back to Git discovery
  // and fail closed instead of admitting across repository-config revocation.
  await fs.writeFile(
    path.join(created.worktreeGitDir, "aiden-owner"),
    `${created.ownershipToken}\n`,
  );
  gitSpawns = 0;
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(gitSpawns, 0);

  await runGit(repo, ["config", "core.bare", "true"]);
  gitSpawns = 0;
  await assert.rejects(
    service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(gitSpawns > 0, "config change must fall back to Git discovery");
  await runGit(repo, ["config", "--unset", "core.bare"]);

  // Pre-existing `[include]` target edited after initial Git-verified admission
  // must fall back to Git discovery and fail closed even though `.git/config`
  // itself is unchanged.
  const includeTarget = path.join(temp, "extra-git.cfg");
  await fs.writeFile(includeTarget, "# benign include\n");
  await runGit(repo, ["config", "--add", "include.path", includeTarget]);
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  await fs.writeFile(includeTarget, "[core\n");
  gitSpawns = 0;
  await assert.rejects(
    service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(gitSpawns > 0, "changed include.path target must fall back to Git discovery");
  await fs.writeFile(includeTarget, "");
  await runGit(repo, ["config", "--unset-all", "include.path"]);

  // Custom-named `GIT_CONFIG_GLOBAL` files (not matching `*.gitconfig` or
  // `*/config`) must also be scanned for `[include]` / `[includeIf]` and fall
  // back to Git discovery when an included target changes.
  const customGlobalConfig = path.join(temp, "custom-global.cfg");
  const globalIncludeTarget = path.join(temp, "global-extra.cfg");
  await fs.writeFile(globalIncludeTarget, "# benign global include\n");
  await fs.writeFile(customGlobalConfig, `[include]\n\tpath = ${globalIncludeTarget}\n`);
  process.env.GIT_CONFIG_GLOBAL = customGlobalConfig;
  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  await fs.writeFile(globalIncludeTarget, "[core\n");
  gitSpawns = 0;
  await assert.rejects(
    service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(gitSpawns > 0, "changed custom GIT_CONFIG_GLOBAL include target must fall back to Git discovery");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";

  // Invalidating display cache after a WorktreeSetup hook modifies the checkout
  // ensures git.info observes dirty changes instead of stale uncommitted: 0.
  await fs.writeFile(path.join(created.path, "README.md"), "# modified by hook\n");
  await service.invalidateWorktreeDisplayCache(created.path);
  const postHookInfo = await service.info(created.path);
  assert.equal(postHookInfo.isRepo, true);
  assert.equal(postHookInfo.uncommitted, 1);
});

test("GitService.managedWorktreeUsable tracks native Git system config origins, symlink chains, and GIT_EXEC_PATH", async (t) => {
  const prevGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const prevSystemConfig = process.env.GIT_CONFIG_SYSTEM;
  const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const prevExecPath = process.env.GIT_EXEC_PATH;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  delete process.env.GIT_CONFIG_SYSTEM;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_EXEC_PATH;
  t.after(() => {
    if (prevGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobalConfig;
    if (prevSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystemConfig;
    if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
    if (prevExecPath === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = prevExecPath;
  });

  const temp = await temporaryDirectory(t, "aiden-usable-native-sys-");
  const repo = path.join(temp, "repo");
  const worktreesRoot = path.join(temp, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Aiden Test"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "initial"]);

  const countSpawns = (svc: GitService) => {
    const state = { count: 0 };
    const internals = svc as unknown as {
      run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
    };
    const orig = internals.run.bind(svc);
    internals.run = async (cwd, args, options) => {
      state.count += 1;
      return orig(cwd, args, options);
    };
    return state;
  };

  // Case 1: Real native Git with explicit GIT_CONFIG_SYSTEM allows 0-spawn
  // admission while benign, and fails closed on a revoking edit.
  const altSystemConfig = path.join(temp, "alt-prefix-gitconfig");
  await fs.writeFile(altSystemConfig, "[user]\n\tname = Alt Prefix\n");
  process.env.GIT_CONFIG_SYSTEM = altSystemConfig;
  const service = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  const created = await service.createWorktree(repo, worktreesRoot, "aiden/native-sys");
  const spawns = countSpawns(service);

  assert.equal(
    await service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(spawns.count, 0, "verified native Git with explicit system config allows 0-spawn admission");

  await fs.writeFile(altSystemConfig, "[core\n");
  spawns.count = 0;
  await assert.rejects(
    service.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(spawns.count > 0, "revoking edit to system config must force Git discovery");

  // Case 2: System config starts missing, admits with 0 spawns, then is created to revoke.
  await fs.rm(altSystemConfig, { force: true });
  const missingSysService = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  const missingSpawns = countSpawns(missingSysService);
  assert.equal(
    await missingSysService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  missingSpawns.count = 0;
  assert.equal(
    await missingSysService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(missingSpawns.count, 0);

  await fs.writeFile(altSystemConfig, "[core\n");
  missingSpawns.count = 0;
  await assert.rejects(
    missingSysService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(missingSpawns.count > 0, "creating missing system config must force Git discovery");

  // Case 3: Existing empty system config fails closed (never caches pure-FS proof).
  await fs.writeFile(altSystemConfig, "");
  const emptySysService = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  const emptySpawns = countSpawns(emptySysService);
  assert.equal(
    await emptySysService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  await fs.writeFile(altSystemConfig, "[core\n");
  emptySpawns.count = 0;
  await assert.rejects(
    emptySysService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(emptySpawns.count > 0, "empty system config must stay Git-backed and fail closed");

  // Case 4: Multi-hop symlink pointing to the real native Git binary allows
  // 0-spawn admission, and repointing an intermediate symlink hop to a wrapper
  // immediately invalidates the proof and fails closed.
  await fs.writeFile(altSystemConfig, "[user]\n\tname = Valid\n");
  const realGit = await resolveGitExecutable(TRUSTED_NATIVE_GIT, repo, process.env);
  const midLink = path.join(temp, "git-mid-link");
  const outerLink = path.join(temp, "git-outer-link");
  await fs.symlink(realGit, midLink);
  await fs.symlink(midLink, outerLink);

  const linkService = new GitService({ gitBinary: outerLink, cacheTtlMs: 60_000 });
  const linkSpawns = countSpawns(linkService);
  assert.equal(
    await linkService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  linkSpawns.count = 0;
  assert.equal(
    await linkService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.equal(linkSpawns.count, 0, "multi-hop symlink to real native Git allows 0-spawn admission");

  const corruptConfig = path.join(temp, "corrupt-gitconfig");
  await fs.writeFile(corruptConfig, "[core\n");
  const failingWrapper = path.join(temp, "failing-wrapper.sh");
  await fs.writeFile(
    failingWrapper,
    `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=${JSON.stringify(corruptConfig)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await fs.rm(midLink);
  await fs.symlink(failingWrapper, midLink);
  linkSpawns.count = 0;
  await assert.rejects(
    linkService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(linkSpawns.count > 0, "repointing an intermediate symlink hop must force Git discovery");

  // Case 5: Setting GIT_EXEC_PATH fails closed to Git-backed admission.
  const execPathOut = await runGit(repo, ["--exec-path"]);
  process.env.GIT_EXEC_PATH = execPathOut;
  const execPathService = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  const execPathSpawns = countSpawns(execPathService);
  assert.equal(
    await execPathService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  execPathSpawns.count = 0;
  assert.equal(
    await execPathService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.ok(execPathSpawns.count > 0, "GIT_EXEC_PATH override must stay Git-backed");
});

test("GitService.managedWorktreeUsable fails closed for unchanged wrapper scripts and native shims with mutable delegated routing", async (t) => {
  const prevGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const prevSystemConfig = process.env.GIT_CONFIG_SYSTEM;
  const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  delete process.env.GIT_CONFIG_SYSTEM;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  t.after(() => {
    if (prevGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobalConfig;
    if (prevSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystemConfig;
    if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
  });

  const temp = await temporaryDirectory(t, "aiden-usable-shim-");
  const repo = path.join(temp, "repo");
  const worktreesRoot = path.join(temp, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Aiden Test"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "initial"]);

  const realGit = await resolveGitExecutable(TRUSTED_NATIVE_GIT, repo, process.env);
  const baseService = new GitService({ gitBinary: TRUSTED_NATIVE_GIT, cacheTtlMs: 60_000 });
  const created = await baseService.createWorktree(repo, worktreesRoot, "aiden/shim-test");

  const configA = path.join(temp, "config-a");
  const configB = path.join(temp, "config-b");
  await fs.writeFile(configA, "[user]\n\tname = Config A\n");
  await fs.writeFile(configB, "[user]\n\tname = Config B\n");

  const nestedA = path.join(temp, "nested-git-a.sh");
  const nestedB = path.join(temp, "nested-git-b.sh");
  await fs.writeFile(
    nestedA,
    `#!/bin/sh\nunset GIT_CONFIG_NOSYSTEM\nexport GIT_CONFIG_SYSTEM=${JSON.stringify(configA)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await fs.writeFile(
    nestedB,
    `#!/bin/sh\nunset GIT_CONFIG_NOSYSTEM\nexport GIT_CONFIG_SYSTEM=${JSON.stringify(configB)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );

  const nestedLink = path.join(temp, "nested-git-active");
  await fs.symlink(nestedA, nestedLink);

  const countSpawns = (svc: GitService) => {
    const state = { count: 0 };
    const internals = svc as unknown as {
      run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
    };
    const orig = internals.run.bind(svc);
    internals.run = async (cwd, args, options) => {
      state.count += 1;
      return orig(cwd, args, options);
    };
    return state;
  };

  // Case 1: Unchanged outer shell wrapper script swapping its delegated nested
  // executable from clean config A to corrupt config B must never admit via
  // cached 0-spawn proof and must reject once B is corrupt.
  const outerWrapper = path.join(temp, "outer-wrapper.sh");
  await fs.writeFile(
    outerWrapper,
    `#!/bin/sh\nexec ${JSON.stringify(nestedLink)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  const outerStatBefore = await fs.lstat(outerWrapper, { bigint: true });

  const wrapperService = new GitService({ gitBinary: outerWrapper, cacheTtlMs: 60_000 });
  const wrapperSpawns = countSpawns(wrapperService);
  assert.equal(
    await wrapperService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  wrapperSpawns.count = 0;
  assert.equal(
    await wrapperService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  assert.ok(wrapperSpawns.count > 0, "shell wrapper must not publish or reuse a 0-spawn proof");

  // Swap the delegated nested executable to config B and corrupt config B while
  // leaving outerWrapper and config A completely untouched.
  await fs.writeFile(configB, "[core\n");
  await fs.rm(nestedLink);
  await fs.symlink(nestedB, nestedLink);
  const outerStatAfter = await fs.lstat(outerWrapper, { bigint: true });
  assert.equal(outerStatAfter.ino, outerStatBefore.ino);
  assert.equal(outerStatAfter.mtimeNs, outerStatBefore.mtimeNs);
  assert.equal(outerStatAfter.ctimeNs, outerStatBefore.ctimeNs);

  wrapperSpawns.count = 0;
  await assert.rejects(
    wrapperService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(wrapperSpawns.count > 0, "unchanged wrapper swapping delegated target to corrupt config B must fail closed");

  // Case 2: Even when GIT_CONFIG_NOSYSTEM=1 is set in the parent environment,
  // a wrapper script that unsets it internally must still fail closed.
  await fs.writeFile(configB, "[user]\n\tname = Config B\n");
  await fs.rm(nestedLink);
  await fs.symlink(nestedA, nestedLink);
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const noSysWrapperService = new GitService({ gitBinary: outerWrapper, cacheTtlMs: 60_000 });
  const noSysWrapperSpawns = countSpawns(noSysWrapperService);
  assert.equal(
    await noSysWrapperService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    true,
  );
  await fs.writeFile(configB, "[core\n");
  await fs.rm(nestedLink);
  await fs.symlink(nestedB, nestedLink);
  noSysWrapperSpawns.count = 0;
  await assert.rejects(
    noSysWrapperService.managedWorktreeUsable(
      created.repositoryPath,
      created.path,
      created.branch,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
    ),
    /not a Git repository/u,
  );
  assert.ok(noSysWrapperSpawns.count > 0, "wrapper script must fail closed even with GIT_CONFIG_NOSYSTEM=1");
  delete process.env.GIT_CONFIG_NOSYSTEM;

  // Case 3: Unchanged compiled native Mach-O/ELF shim binary delegating to a
  // mutable nested executable must also fail closed (blocked by --exec-path
  // self-identity verification).
  if (process.platform === "darwin" || process.platform === "linux") {
    await fs.writeFile(configB, "[user]\n\tname = Config B\n");
    await fs.rm(nestedLink);
    await fs.symlink(nestedA, nestedLink);

    const shimSource = path.join(temp, "git-shim.c");
    const shimBinary = path.join(temp, "git-shim");
    await fs.writeFile(
      shimSource,
      `#include <unistd.h>\nint main(int argc, char **argv) {\n  (void)argc;\n  execv(${JSON.stringify(nestedLink)}, argv);\n  return 127;\n}\n`,
      "utf8",
    );
    await execFileAsync("cc", [shimSource, "-o", shimBinary]);
    const shimStatBefore = await fs.lstat(shimBinary, { bigint: true });

    const shimService = new GitService({ gitBinary: shimBinary, cacheTtlMs: 60_000 });
    const shimSpawns = countSpawns(shimService);
    assert.equal(
      await shimService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      true,
    );
    shimSpawns.count = 0;
    assert.equal(
      await shimService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      true,
    );
    assert.ok(shimSpawns.count > 0, "compiled native shim binary must not publish or reuse a 0-spawn proof");

    await fs.writeFile(configB, "[core\n");
    await fs.rm(nestedLink);
    await fs.symlink(nestedB, nestedLink);
    const shimStatAfter = await fs.lstat(shimBinary, { bigint: true });
    assert.equal(shimStatAfter.ino, shimStatBefore.ino);
    assert.equal(shimStatAfter.mtimeNs, shimStatBefore.mtimeNs);
    assert.equal(shimStatAfter.ctimeNs, shimStatBefore.ctimeNs);

    shimSpawns.count = 0;
    await assert.rejects(
      shimService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      /not a Git repository/u,
    );
    assert.ok(shimSpawns.count > 0, "unchanged native shim swapping delegated target to corrupt config B must fail closed");

    // Case 4: Even a compiled native shim that special-cases `--exec-path` to
    // report a directory containing a hard link to itself while delegating
    // ordinary Git commands through a mutable route must fail closed.
    await fs.writeFile(configB, "[user]\n\tname = Config B\n");
    await fs.rm(nestedLink);
    await fs.symlink(nestedA, nestedLink);

    const fakeExecPathDir = path.join(temp, "fake-exec-path");
    await fs.mkdir(fakeExecPathDir);
    const spoofShimSource = path.join(temp, "git-spoof-shim.c");
    const spoofShimBinary = path.join(temp, "git-spoof-shim");
    await fs.writeFile(
      spoofShimSource,
      `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\n  if (argc == 2 && strcmp(argv[1], "--exec-path") == 0) {\n    puts(${JSON.stringify(fakeExecPathDir)});\n    return 0;\n  }\n  execv(${JSON.stringify(nestedLink)}, argv);\n  return 127;\n}\n`,
      "utf8",
    );
    await execFileAsync("cc", [spoofShimSource, "-o", spoofShimBinary]);
    await fs.link(spoofShimBinary, path.join(fakeExecPathDir, "git"));
    const spoofStatBefore = await fs.lstat(spoofShimBinary, { bigint: true });

    const spoofService = new GitService({ gitBinary: spoofShimBinary, cacheTtlMs: 60_000 });
    const spoofSpawns = countSpawns(spoofService);
    assert.equal(
      await spoofService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      true,
    );
    spoofSpawns.count = 0;
    assert.equal(
      await spoofService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      true,
    );
    assert.ok(spoofSpawns.count > 0, "native shim spoofing --exec-path must not publish a 0-spawn proof");

    await fs.writeFile(configB, "[core\n");
    await fs.rm(nestedLink);
    await fs.symlink(nestedB, nestedLink);
    const spoofStatAfter = await fs.lstat(spoofShimBinary, { bigint: true });
    assert.equal(spoofStatAfter.ino, spoofStatBefore.ino);
    assert.equal(spoofStatAfter.mtimeNs, spoofStatBefore.mtimeNs);
    assert.equal(spoofStatAfter.ctimeNs, spoofStatBefore.ctimeNs);

    spoofSpawns.count = 0;
    await assert.rejects(
      spoofService.managedWorktreeUsable(
        created.repositoryPath,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      ),
      /not a Git repository/u,
    );
    assert.ok(spoofSpawns.count > 0, "unchanged native shim spoofing --exec-path must fail closed when delegated target breaks");
  }
});
