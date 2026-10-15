import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  canonicalRepositoryKey,
  primaryRemoteUrl,
  repositoryRelativePath,
} from "./repository-identity.js";

test("every common spelling of one remote shares a credential-free canonical key", () => {
  const spellings = [
    "https://github.com/Example/Aiden.git",
    "https://GitHub.com/Example/Aiden",
    "https://x-access-token:ghp_secretvalue@github.com/Example/Aiden.git",
    "https://user:p%40ss@github.com:8443/Example/Aiden.git?token=secret#frag",
    "git@github.com:Example/Aiden.git",
    "ssh://git@github.com:22/Example/Aiden.git",
    "git+ssh://git@github.com/Example/Aiden",
    "git://github.com/Example/Aiden.git/",
  ];
  for (const url of spellings) {
    assert.equal(canonicalRepositoryKey(url), "github.com/Example/Aiden", url);
  }
});

test("canonical keys never carry userinfo, ports, queries or secrets", () => {
  const key = canonicalRepositoryKey(
    "https://deploy:hunter2-token@git.example.com:9443/team/sub/repo.git?private_token=abc",
  );
  assert.equal(key, "git.example.com/team/sub/repo");
  for (const secret of ["deploy", "hunter2", "9443", "private_token", "abc", "@", ":"]) {
    assert.equal(key!.includes(secret), false, secret);
  }
});

test("local paths, file URLs, transport helpers and unsafe paths have no identity", () => {
  for (const url of [
    "",
    "   ",
    "/Users/me/src/aiden",
    "./aiden",
    "../aiden",
    "~/src/aiden",
    "C:\\src\\aiden",
    "C:/src/aiden",
    "file:///Users/me/src/aiden",
    "ext::ssh -i key host %S repo",
    "https://github.com/",
    "git@github.com:owner/../secret",
    "https://github.com/owner/%2e%2e%2fsecret",
    "https://github.com/owner/repo name",
    "https://github.com/owner/re\u0000po",
    "https://bad_host.example/owner/repo",
    `https://github.com/${"a".repeat(2_100)}`,
  ]) {
    assert.equal(canonicalRepositoryKey(url), undefined, JSON.stringify(url));
  }
});

test("relative paths are POSIX inside the repository and absent outside it", () => {
  const top = path.join(path.sep, "work", "aiden");
  assert.equal(repositoryRelativePath(top, top), "");
  assert.equal(repositoryRelativePath(top, path.join(top, "packages", "cli")), "packages/cli");
  assert.equal(repositoryRelativePath(top, path.join(path.sep, "work", "other")), undefined);
  assert.equal(repositoryRelativePath(top, path.join(path.sep, "work")), undefined);
});

test("the primary remote is origin, else the only remote", () => {
  const fetchLine = (name: string, url: string) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;
  assert.equal(
    primaryRemoteUrl(fetchLine("upstream", "https://a.example/x/y") + fetchLine("origin", "git@b.example:o/r.git")),
    "git@b.example:o/r.git",
  );
  assert.equal(primaryRemoteUrl(fetchLine("fork", "https://a.example/x/y")), "https://a.example/x/y");
  assert.equal(
    primaryRemoteUrl(fetchLine("fork", "https://a.example/x/y") + fetchLine("upstream", "https://b.example/x/y")),
    undefined,
  );
  assert.equal(primaryRemoteUrl(""), undefined);
});
