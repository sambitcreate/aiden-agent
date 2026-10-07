import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRepositoryResolver, parseGitRemoteUrl } from "./github-local-repository.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function repository(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "aiden-local-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "-c", "user.name=Aiden", "-c", "user.email=aiden@example.test", "commit", "--quiet", "--allow-empty", "-m", "init");
  return dir;
}

test("a fork checkout reads upstream as the base and the fork as the head", async (t) => {
  const dir = repository(t);
  git(dir, "remote", "add", "origin", "git@github.com:Me/app.git");
  git(dir, "remote", "add", "upstream", "https://github.com/acme/app.git");
  git(dir, "checkout", "--quiet", "-b", "feature/login");
  git(dir, "config", "branch.feature/login.remote", "origin");
  git(dir, "config", "branch.feature/login.merge", "refs/heads/feature/login");
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/feature/login", sha);

  const result = await new LocalRepositoryResolver().resolve(dir);

  assert.deepEqual(result, {
    ok: true,
    repository: {
      host: "github.com",
      owner: "acme",
      name: "app",
      branch: "feature/login",
      headBranch: "feature/login",
      headOwner: "me",
      headSha: sha,
    },
  });
});

test("the remote marked by `gh repo set-default` wins over remote names", async (t) => {
  const dir = repository(t);
  git(dir, "remote", "add", "upstream", "https://github.com/acme/app.git");
  git(dir, "remote", "add", "mine", "https://github.com/me/app.git");
  git(dir, "config", "remote.mine.gh-resolved", "base");

  const result = await new LocalRepositoryResolver().resolve(dir);

  assert.equal(result.ok && `${result.repository.owner}/${result.repository.name}`, "me/app");
  assert.equal(result.ok && result.repository.branch, "main");
  assert.equal(result.ok && result.repository.headSha, undefined);
});

test("push remote, merge ref, and insteadOf rewrites shape the head", async (t) => {
  const dir = repository(t);
  git(dir, "config", "url.https://github.com/.insteadOf", "gh:");
  git(dir, "remote", "add", "origin", "gh:acme/app");
  git(dir, "remote", "add", "fork", "gh:me/app");
  git(dir, "checkout", "--quiet", "-b", "local-name");
  git(dir, "config", "branch.local-name.remote", "origin");
  git(dir, "config", "branch.local-name.pushRemote", "fork");
  git(dir, "config", "branch.local-name.merge", "refs/heads/remote-name");

  const result = await new LocalRepositoryResolver().resolve(dir);

  assert.ok(result.ok);
  assert.equal(`${result.repository.owner}/${result.repository.name}`, "acme/app");
  assert.equal(result.repository.headBranch, "remote-name");
  assert.equal(result.repository.headOwner, "me");
});

test("SSH host aliases resolve to the GitHub host behind them", async (t) => {
  const dir = repository(t);
  git(dir, "remote", "add", "origin", "git@github-work:acme/app.git");
  const asked: string[] = [];
  const resolver = new LocalRepositoryResolver({
    sshHostname: async (alias) => {
      asked.push(alias);
      return alias === "github-work" ? "github.com" : undefined;
    },
  });

  const first = await resolver.resolve(dir);
  await resolver.resolve(dir);

  assert.equal(first.ok && first.repository.host, "github.com");
  assert.deepEqual(asked, ["github-work"]);
});

test("enterprise hosts count only when the host check accepts them", async (t) => {
  const dir = repository(t);
  git(dir, "remote", "add", "origin", "https://git.corp.example/acme/app.git");

  assert.deepEqual(await new LocalRepositoryResolver({ sshHostname: async () => undefined }).resolve(dir), {
    ok: false,
    availability: "not-github",
    message: "This repository's remote is not hosted on GitHub.",
  });
  const enterprise = await new LocalRepositoryResolver({
    isGitHubHost: async (host) => host === "git.corp.example",
  }).resolve(dir);
  assert.equal(enterprise.ok && enterprise.repository.host, "git.corp.example");
});

test("a folder outside git is not a repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-not-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await new LocalRepositoryResolver().resolve(dir);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.availability, "not-repo");
});

test("remote URLs parse across git's URL forms without keeping credentials", () => {
  assert.deepEqual(parseGitRemoteUrl("git@github.com:Acme/App.git"), { host: "github.com", owner: "acme", name: "app", ssh: true });
  assert.deepEqual(parseGitRemoteUrl("ssh://git@ghe.example:2222/acme/app.git"), {
    host: "ghe.example",
    owner: "acme",
    name: "app",
    ssh: true,
  });
  assert.deepEqual(parseGitRemoteUrl("https://user:secret@github.com/acme/app"), {
    host: "github.com",
    owner: "acme",
    name: "app",
    ssh: false,
  });
  assert.equal(parseGitRemoteUrl("/local/path/repo.git"), undefined);
  assert.equal(parseGitRemoteUrl("https://github.com/acme/app/extra"), undefined);
});
