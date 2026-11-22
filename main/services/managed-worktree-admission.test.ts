import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitService } from "./git.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import type { Workspace } from "./types.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function fixture(t: test.TestContext): Promise<{
  workspace: Workspace;
  worktreePath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-worktree-admission-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-usable-fs-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const worktreesRoot = path.join(temp, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Aiden Test"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "initial"]);

  const service = new GitService({ cacheTtlMs: 60_000 });
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

test("GitService.managedWorktreeUsable discovers alternate Git system config origins and fails closed on revoking edits", async (t) => {
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

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-usable-alt-sys-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const worktreesRoot = path.join(temp, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Aiden Test"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "initial"]);

  const altSystemConfig = path.join(temp, "alt-prefix-gitconfig");
  const gitWrapper = path.join(temp, "alt-git.sh");
  await fs.writeFile(
    gitWrapper,
    `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=${JSON.stringify(altSystemConfig)}\nexec git "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );

  // Case 1: Alternate system config exists with benign settings.
  await fs.writeFile(altSystemConfig, "[user]\n\tname = Alt Prefix\n");
  const service = new GitService({ gitBinary: gitWrapper, cacheTtlMs: 60_000 });
  const created = await service.createWorktree(repo, worktreesRoot, "aiden/alt-sys");

  let gitSpawns = 0;
  const internals = service as unknown as {
    run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
  };
  const originalRun = internals.run.bind(service);
  internals.run = async (cwd, args, options) => {
    gitSpawns += 1;
    return originalRun(cwd, args, options);
  };

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
  assert.equal(gitSpawns, 0, "verified alternate system config still allows 0-spawn admission");

  await fs.writeFile(altSystemConfig, "[core\n");
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
  assert.ok(gitSpawns > 0, "revoking edit to alternate system config must force Git discovery");

  // Case 2: Alternate system config starts missing, then is created to revoke.
  await fs.rm(altSystemConfig, { force: true });
  const missingSysService = new GitService({ gitBinary: gitWrapper, cacheTtlMs: 60_000 });
  let missingSysSpawns = 0;
  const missingInternals = missingSysService as unknown as {
    run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
  };
  const origMissingRun = missingInternals.run.bind(missingSysService);
  missingInternals.run = async (cwd, args, options) => {
    missingSysSpawns += 1;
    return origMissingRun(cwd, args, options);
  };

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
  missingSysSpawns = 0;
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
  assert.equal(missingSysSpawns, 0);

  await fs.writeFile(altSystemConfig, "[core\n");
  missingSysSpawns = 0;
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
  assert.ok(missingSysSpawns > 0, "creating missing alternate system config must force Git discovery");

  // Case 3: Existing empty alternate system config fails closed (never caches pure-FS proof).
  await fs.writeFile(altSystemConfig, "");
  const emptySysService = new GitService({ gitBinary: gitWrapper, cacheTtlMs: 60_000 });
  let emptySysSpawns = 0;
  const emptyInternals = emptySysService as unknown as {
    run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
  };
  const origEmptyRun = emptyInternals.run.bind(emptySysService);
  emptyInternals.run = async (cwd, args, options) => {
    emptySysSpawns += 1;
    return origEmptyRun(cwd, args, options);
  };

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
  emptySysSpawns = 0;
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
  assert.ok(emptySysSpawns > 0, "empty alternate system config must stay Git-backed and fail closed");

  // Case 4: Rewriting the Git executable wrapper in place from system config A
  // to system config B must invalidate direct admission and reprobe B (never
  // republishing a stale cached origin for A).
  const altSystemConfigB = path.join(temp, "alt-prefix-gitconfig-b");
  await fs.writeFile(altSystemConfig, "[user]\n\tname = Config A\n");
  await fs.writeFile(altSystemConfigB, "[user]\n\tname = Config B\n");
  const rerouteService = new GitService({ gitBinary: gitWrapper, cacheTtlMs: 60_000 });
  let rerouteSpawns = 0;
  const rerouteInternals = rerouteService as unknown as {
    run: (cwd: string, args: string[], options?: unknown) => Promise<unknown>;
  };
  const origRerouteRun = rerouteInternals.run.bind(rerouteService);
  rerouteInternals.run = async (cwd, args, options) => {
    rerouteSpawns += 1;
    return origRerouteRun(cwd, args, options);
  };

  assert.equal(
    await rerouteService.managedWorktreeUsable(
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
  rerouteSpawns = 0;
  assert.equal(
    await rerouteService.managedWorktreeUsable(
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
  assert.equal(rerouteSpawns, 0, "initial wrapper pointing at config A admits with 0 spawns");

  // Rewrite wrapper in place to route to config B instead of config A.
  await fs.writeFile(
    gitWrapper,
    `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=${JSON.stringify(altSystemConfigB)}\nexec git "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  rerouteSpawns = 0;
  assert.equal(
    await rerouteService.managedWorktreeUsable(
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
  assert.ok(rerouteSpawns > 0, "rewritten wrapper must invalidate proof and reprobe config B");

  // Corrupt config B while config A stays valid: must fall back and fail closed.
  await fs.writeFile(altSystemConfigB, "[core\n");
  rerouteSpawns = 0;
  await assert.rejects(
    rerouteService.managedWorktreeUsable(
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
  assert.ok(rerouteSpawns > 0, "corrupting rerouted config B must force Git discovery");
});
