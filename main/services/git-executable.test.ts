import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitExecutable } from "./git-executable.js";

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
