import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitService } from "./git.js";
import { createGitExecutableResolver, resolveGitExecutable } from "./git-executable.js";

const execFileAsync = promisify(execFile);

function fixture(paths: Record<string, string>, developerDir?: string) {
  let probes = 0;
  return {
    get probes() { return probes; },
    deps: {
      platform: "darwin" as const,
      executablePath: async (candidate: string) => paths[candidate],
      developerDirectory: async () => {
        probes++;
        if (!developerDir) throw new Error("No active developer directory");
        return developerDir;
      },
    },
  };
}

test("missing developer tools never returns Apple's install-on-demand shim", async () => {
  const f = fixture({ "/usr/bin/git": "/usr/bin/git" });
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, undefined, f.deps), /Git is not installed/);
  assert.equal(f.probes, 1);
});

for (const dir of ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"]) {
  test(`uses installed Git directly from ${dir}`, async () => {
    const binary = `${dir}/usr/bin/git`;
    const f = fixture({ "/usr/bin/git": "/usr/bin/git", [binary]: binary }, dir);
    assert.equal(await resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, undefined, f.deps), binary);
  });
}

test("stale developer directory cannot enable the shim", async () => {
  const f = fixture({ "/usr/bin/git": "/usr/bin/git" }, "/removed/Xcode.app/Contents/Developer");
  await assert.rejects(resolveGitExecutable("/usr/bin/git", "/workspace", {}, undefined, f.deps), /Git is not installed/);
});

test("Homebrew after the Apple shim works without developer tools", async () => {
  const f = fixture({ "/usr/bin/git": "/usr/bin/git", "/opt/homebrew/bin/git": "/opt/homebrew/Cellar/git/bin/git" });
  assert.equal(await resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin:/opt/homebrew/bin" }, undefined, f.deps), "/opt/homebrew/Cellar/git/bin/git");
});

test("custom Git and non-macOS do not probe developer tools", async () => {
  const f = fixture({ "/custom/git": "/custom/git" });
  assert.equal(await resolveGitExecutable("/custom/git", "/workspace", {}, undefined, f.deps), "/custom/git");
  assert.equal(await resolveGitExecutable("git", "/workspace", { PATH: "/custom" }, undefined, { ...f.deps, platform: "linux" }), "/custom/git");
  assert.equal(f.probes, 0);
});

test("Linux resolves Git from absolute PATH entries and never from the workspace", async () => {
  const f = fixture({ "/workspace/git": "/workspace/git", "/usr/bin/git": "/usr/bin/git" });
  const linux = { ...f.deps, platform: "linux" as const };
  // On Linux /usr/bin/git is a real Git, not an installer shim.
  assert.equal(await resolveGitExecutable("git", "/workspace", { PATH: ".::/usr/bin" }, undefined, linux), "/usr/bin/git");
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: ":.:tools" }, undefined, linux), /Git is not installed/);
  assert.equal(f.probes, 0);
});

test("symlink to Apple shim is detected", async () => {
  const f = fixture({ "/custom/git": "/usr/bin/git" });
  await assert.rejects(resolveGitExecutable("/custom/git", "/workspace", {}, undefined, f.deps), /Git is not installed/);
});

test("cancellation during the non-installing probe remains cancellation", async () => {
  const controller = new AbortController();
  const f = fixture({ "/usr/bin/git": "/usr/bin/git" });
  f.deps.developerDirectory = async () => { controller.abort(); throw new Error("aborted"); };
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, controller.signal, f.deps), { name: "AbortError" });
});

for (const unsafePath of ["", ".", "tools", "../tools"]) {
  test(`ignores workspace-relative PATH entry ${JSON.stringify(unsafePath)}`, async () => {
    const f = fixture({ "/opt/homebrew/bin/git": "/opt/homebrew/bin/git" });
    const visited: string[] = [];
    f.deps.executablePath = async (candidate) => {
      visited.push(candidate);
      // Every candidate is executable, including a malicious workspace Git.
      return candidate;
    };
    assert.equal(
      await resolveGitExecutable("git", "/workspace", { PATH: `${unsafePath}:/opt/homebrew/bin` }, undefined, f.deps),
      "/opt/homebrew/bin/git",
    );
    assert.deepEqual(visited, ["/opt/homebrew/bin/git"]);
  });
}

test("PATH with only relative components cannot execute workspace Git", async () => {
  const f = fixture({ "/workspace/git": "/workspace/git" });
  f.deps.executablePath = async () => assert.fail("must not inspect workspace-relative candidates");
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: ":.:tools" }, undefined, f.deps), /Git is not installed/);
});

for (const selected of [undefined, "/removed/Xcode.app/Contents/Developer"]) {
  test(`finds default CLT Git when selected directory is ${selected ?? "unavailable"}`, async () => {
    const binary = "/Library/Developer/CommandLineTools/usr/bin/git";
    const f = fixture({ "/usr/bin/git": "/usr/bin/git", [binary]: binary }, selected);
    assert.equal(await resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, undefined, f.deps), binary);
  });
}

test("default CLT fallback cannot return a symlink to Apple's shim", async () => {
  const f = fixture({
    "/usr/bin/git": "/usr/bin/git",
    "/Library/Developer/CommandLineTools/usr/bin/git": "/usr/bin/git",
  });
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, undefined, f.deps), /Git is not installed/);
});

test("cancellation during default CLT fallback remains cancellation", async () => {
  const controller = new AbortController();
  const f = fixture({ "/usr/bin/git": "/usr/bin/git" });
  f.deps.executablePath = async (candidate) => {
    if (candidate.includes("CommandLineTools")) controller.abort();
    return candidate;
  };
  await assert.rejects(resolveGitExecutable("git", "/workspace", { PATH: "/usr/bin" }, controller.signal, f.deps), { name: "AbortError" });
});

function memoFixture(paths: Record<string, string>, developerDir?: string) {
  const f = fixture(paths, developerDir);
  const inspected: string[] = [];
  const executablePath = f.deps.executablePath;
  f.deps.executablePath = async (candidate: string) => {
    inspected.push(candidate);
    return executablePath(candidate);
  };
  return Object.assign(f, { inspected });
}

const CLT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";

test("memoized resolution probes developer tools once and revalidates hits with one file check", async () => {
  const f = memoFixture({ "/usr/bin/git": "/usr/bin/git", [CLT_GIT]: CLT_GIT }, "/Library/Developer/CommandLineTools");
  const resolve = createGitExecutableResolver(f.deps);
  const env = { PATH: "/usr/bin:/bin" };
  for (let i = 0; i < 5; i++) assert.equal(await resolve("git", "/workspace", env), CLT_GIT);
  assert.equal(f.probes, 1);
  // The first resolution inspects the shim and CLT Git; each hit re-checks only the result.
  assert.deepEqual(f.inspected.slice(2), Array(4).fill(CLT_GIT));
});

test("a changed PATH or DEVELOPER_DIR resolves again", async () => {
  const f = memoFixture({
    "/usr/bin/git": "/usr/bin/git",
    [CLT_GIT]: CLT_GIT,
    "/opt/homebrew/bin/git": "/opt/homebrew/Cellar/git/bin/git",
  }, "/Library/Developer/CommandLineTools");
  const resolve = createGitExecutableResolver(f.deps);
  assert.equal(await resolve("git", "/w", { PATH: "/usr/bin" }), CLT_GIT);
  assert.equal(await resolve("git", "/w", { PATH: "/opt/homebrew/bin:/usr/bin" }), "/opt/homebrew/Cellar/git/bin/git");
  assert.equal(await resolve("git", "/w", { PATH: "/usr/bin", DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }), CLT_GIT);
  assert.equal(f.probes, 2);
});

test("a removed Git is noticed on the next command instead of being reused", async () => {
  const paths: Record<string, string> = {
    "/usr/bin/git": "/usr/bin/git",
    "/opt/homebrew/bin/git": "/opt/homebrew/bin/git",
    [CLT_GIT]: CLT_GIT,
  };
  const f = memoFixture(paths, "/Library/Developer/CommandLineTools");
  const resolve = createGitExecutableResolver(f.deps);
  const env = { PATH: "/opt/homebrew/bin:/usr/bin" };
  assert.equal(await resolve("git", "/w", env), "/opt/homebrew/bin/git");
  delete paths["/opt/homebrew/bin/git"];
  assert.equal(await resolve("git", "/w", env), CLT_GIT);
});

test("resolution is repeated after the trust window", async () => {
  let clock = 0;
  const f = memoFixture({ "/usr/bin/git": "/usr/bin/git", [CLT_GIT]: CLT_GIT }, "/Library/Developer/CommandLineTools");
  const resolve = createGitExecutableResolver(f.deps, { ttlMs: 1_000, now: () => clock });
  await resolve("git", "/w", { PATH: "/usr/bin" });
  clock = 999;
  await resolve("git", "/w", { PATH: "/usr/bin" });
  assert.equal(f.probes, 1);
  clock = 1_000;
  await resolve("git", "/w", { PATH: "/usr/bin" });
  assert.equal(f.probes, 2);
});

test("failures are not cached, so installing Git later works without restarting", async () => {
  const paths: Record<string, string> = { "/usr/bin/git": "/usr/bin/git" };
  const f = memoFixture(paths);
  const resolve = createGitExecutableResolver(f.deps);
  await assert.rejects(resolve("git", "/w", { PATH: "/usr/bin" }), /Git is not installed/);
  paths[CLT_GIT] = CLT_GIT;
  assert.equal(await resolve("git", "/w", { PATH: "/usr/bin" }), CLT_GIT);
});

test("concurrent commands share one resolution and one caller's cancellation does not fail the rest", async () => {
  let release!: (dir: string) => void;
  const f = memoFixture({ "/usr/bin/git": "/usr/bin/git", [CLT_GIT]: CLT_GIT });
  f.deps.developerDirectory = () => new Promise<string>((resolve) => { release = resolve; });
  const resolve = createGitExecutableResolver(f.deps);
  const controller = new AbortController();
  const cancelled = resolve("git", "/w", { PATH: "/usr/bin" }, controller.signal);
  const others = [resolve("git", "/w", { PATH: "/usr/bin" }), resolve("git", "/w", { PATH: "/usr/bin" })];
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release("/Library/Developer/CommandLineTools");
  assert.deepEqual(await Promise.all(others), [CLT_GIT, CLT_GIT]);
  assert.equal(f.inspected.filter((p) => p === "/usr/bin/git").length, 1);
});

test("memoized resolver leaves Windows binaries to the OS lookup", async () => {
  const f = memoFixture({});
  const resolve = createGitExecutableResolver({ ...f.deps, platform: "win32" });
  assert.equal(await resolve("git", "/w", {}), "git");
  assert.deepEqual(f.inspected, []);
});

test("memoized resolver notices when a direct symlink binary is repointed", async () => {
  const paths: Record<string, string> = {
    "/custom/git-link": "/opt/git-a/bin/git",
    "/opt/git-a/bin/git": "/opt/git-a/bin/git",
    "/opt/git-b/bin/git": "/opt/git-b/bin/git",
  };
  const f = memoFixture(paths);
  const resolve = createGitExecutableResolver(f.deps);
  assert.equal(await resolve("/custom/git-link", "/w", {}), "/opt/git-a/bin/git");
  paths["/custom/git-link"] = "/opt/git-b/bin/git";
  assert.equal(await resolve("/custom/git-link", "/w", {}), "/opt/git-b/bin/git");
});

test("memoized resolver on Linux skips a workspace-relative PATH entry", async () => {
  const f = memoFixture({ "/w/git": "/w/git", "/usr/bin/git": "/usr/bin/git" });
  const resolve = createGitExecutableResolver({ ...f.deps, platform: "linux" });
  assert.equal(await resolve("git", "/w", { PATH: ".:/usr/bin" }), "/usr/bin/git");
  assert.ok(!f.inspected.includes("/w/git"));
});

async function createTempRepoWithWorktree(t: test.TestContext, gitBinary?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-git-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const worktreesRoot = path.join(root, "worktrees");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(worktreesRoot, { recursive: true });
  const runGit = (args: string[]) =>
    execFileAsync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  await runGit(["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"]);
  await runGit(["commit", "-m", "init"]);
  const service = new GitService(gitBinary ? { gitBinary } : {});
  const created = await service.createWorktree(repo, worktreesRoot, "proof/test-branch");
  return { root, repo, service, created };
}

test(
  "VerifiedRepoIdentityProof refuses to cache pure-FS admission when repo config uses [include]",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, repo, service, created } = await createTempRepoWithWorktree(t);
    const check = () =>
      service.managedWorktreeUsable(
        repo,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      );
    // First call verifies through Git and caches the VerifiedRepoIdentityProof;
    // second call hits the pure-FS fast path while signatures match.
    assert.equal(await check(), true);
    assert.equal(await check(), true);

    // Add a valid [include] directive to repo/.git/config and re-check.
    // Because repo/.git/config now has an [include], pureFsAdmissionProof must
    // refuse to cache a VerifiedRepoIdentityProof for subsequent calls.
    const extraConfig = path.join(root, "extra.gitconfig");
    await fs.writeFile(extraConfig, "# included\n", "utf8");
    const repoConfig = path.join(repo, ".git", "config");
    const before = await fs.readFile(repoConfig, "utf8");
    await fs.writeFile(repoConfig, `${before}\n[include]\n\tpath = ${extraConfig}\n`, "utf8");
    assert.equal(await check(), true);

    // Now break ONLY the included file without modifying repo/.git/config.
    // A stale pure-FS cache would have returned true; failing closed forces
    // Git discovery, which rejects the broken included config.
    await fs.writeFile(extraConfig, "[core\n", "utf8");
    await assert.rejects(check(), /Git repository|bad config|not_a_repo/u);
  },
);

test(
  "VerifiedRepoIdentityProof refuses to cache pure-FS admission for a shebang wrapper git binary",
  { skip: process.platform === "win32" },
  async (t) => {
    const wrapperDir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-git-wrap-"));
    t.after(() => fs.rm(wrapperDir, { recursive: true, force: true }));
    const wrapperPath = path.join(wrapperDir, "git-wrapper");
    const countFile = path.join(wrapperDir, "calls.log");
    const realGit = await resolveGitExecutable("git", wrapperDir, process.env);
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\necho call >> "${countFile}"\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const { repo, service, created } = await createTempRepoWithWorktree(t, wrapperPath);
    const check = () =>
      service.managedWorktreeUsable(
        repo,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      );
    assert.equal(await check(), true);
    const callsAfterFirst = (await fs.readFile(countFile, "utf8")).trim().split("\n").length;
    assert.equal(await check(), true);
    const callsAfterSecond = (await fs.readFile(countFile, "utf8")).trim().split("\n").length;
    assert.ok(
      callsAfterSecond > callsAfterFirst,
      "wrapper binary must never satisfy the 0-spawn pure-FS admission proof",
    );
  },
);

test(
  "VerifiedRepoIdentityProof fails closed out of pure-FS fast path when GIT_EXEC_PATH is set",
  { skip: process.platform === "win32" },
  async (t) => {
    const previousExecPath = process.env.GIT_EXEC_PATH;
    const previousTrace = process.env.GIT_TRACE;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const { root, repo, service, created } = await createTempRepoWithWorktree(t, "/usr/bin/git");
    const fakeExecDir = path.join(root, "fake-exec");
    const traceFile = path.join(root, "git-trace.log");
    await fs.mkdir(fakeExecDir, { recursive: true });
    t.after(() => {
      if (previousExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = previousExecPath;
      if (previousTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previousTrace;
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    });

    delete process.env.GIT_EXEC_PATH;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_TRACE = traceFile;

    const readTrace = () => fs.readFile(traceFile, "utf8").catch(() => "");
    const check = () =>
      service.managedWorktreeUsable(
        repo,
        created.path,
        created.branch,
        created.worktreeGitDir,
        created.ownershipToken,
        created.worktreeDevice,
        created.worktreeInode,
      );

    // First call runs Git and caches the VerifiedRepoIdentityProof.
    assert.equal(await check(), true);
    const traceAfterFirst = await readTrace();
    assert.ok(traceAfterFirst.length > 0, "initial check must invoke Git to mint the proof");

    // Second call with identical environment and untouched signed paths must
    // hit the 0-spawn pure-FS fast path (no new Git trace entries).
    assert.equal(await check(), true);
    const traceAfterFastPath = await readTrace();
    assert.equal(
      traceAfterFastPath,
      traceAfterFirst,
      "unchanged check without GIT_EXEC_PATH must use the 0-spawn pure-FS fast path",
    );

    // Set GIT_EXEC_PATH while leaving all signed repo and config paths intact.
    // The environment fence must invalidate the cached proof and invoke Git.
    process.env.GIT_EXEC_PATH = fakeExecDir;
    assert.equal(await check(), true);
    const traceAfterExecPath = await readTrace();
    assert.ok(
      traceAfterExecPath.length > traceAfterFastPath.length,
      "setting GIT_EXEC_PATH must bypass the cached proof and invoke Git",
    );
    assert.match(
      traceAfterExecPath.slice(traceAfterFastPath.length),
      /rev-parse/u,
      "Git discovery must run when GIT_EXEC_PATH invalidates the cached proof",
    );

    // A subsequent call while GIT_EXEC_PATH remains set must still invoke Git
    // (no new proof may be cached under GIT_EXEC_PATH).
    assert.equal(await check(), true);
    const traceAfterRepeatExecPath = await readTrace();
    assert.ok(
      traceAfterRepeatExecPath.length > traceAfterExecPath.length,
      "pure-FS proof must not be re-cached while GIT_EXEC_PATH is set",
    );
  },
);
