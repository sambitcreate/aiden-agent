import assert from "node:assert/strict";
import test from "node:test";
import { createGitExecutableResolver, resolveGitExecutable } from "./git-executable.js";

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
  assert.equal(await resolveGitExecutable("git", "/workspace", {}, undefined, { ...f.deps, platform: "linux" }), "git");
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

test("memoized resolver leaves non-macOS binaries untouched", async () => {
  const f = memoFixture({});
  const resolve = createGitExecutableResolver({ ...f.deps, platform: "linux" });
  assert.equal(await resolve("git", "/w", {}), "git");
  assert.deepEqual(f.inspected, []);
});
