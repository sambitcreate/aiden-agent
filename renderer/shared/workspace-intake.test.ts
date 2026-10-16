import assert from "node:assert/strict";
import test from "node:test";
import { parseCloneUrl, workspaceCloneId } from "./workspace-intake.js";

test("clone URLs accept network sources and name the repository", () => {
  const accepted: Array<[string, string, string]> = [
    ["https://github.com/acme/widget.git", "https://github.com/acme/widget.git", "widget"],
    ["  https://GitHub.com/acme/widget  ", "https://github.com/acme/widget", "widget"],
    ["https://gitlab.example.com/group/sub/tool.git", "https://gitlab.example.com/group/sub/tool.git", "tool"],
    ["git@github.com:acme/widget.git", "git@github.com:acme/widget.git", "widget"],
    ["git@example.com:widget", "git@example.com:widget", "widget"],
    ["ssh://git@example.com:2222/srv/widget.git", "ssh://git@example.com:2222/srv/widget.git", "widget"],
    ["acme/widget", "https://github.com/acme/widget.git", "widget"],
    ["acme/widget.git", "https://github.com/acme/widget.git", "widget"],
    ["acme-co/my.repo_2", "https://github.com/acme-co/my.repo_2.git", "my.repo_2"],
  ];
  for (const [input, url, repoName] of accepted) {
    assert.deepEqual(parseCloneUrl(input), { ok: true, url, repoName }, input);
  }
});

test("clone URLs refuse local transports, option injection and malformed input", () => {
  const rejected: unknown[] = [
    "",
    "   ",
    undefined,
    42,
    "--upload-pack=touch /tmp/pwned",
    "-c core.sshCommand=evil",
    "ext::sh -c touch% /tmp/pwned",
    "ext::sh",
    "fd::17",
    "file:///etc",
    "file:///Users/me/repo.git",
    "/srv/repos/widget.git",
    "./widget",
    "../widget",
    "~/widget",
    "http://github.com/acme/widget.git",
    "ftp://example.com/widget.git",
    "git://example.com/widget.git",
    "https://user:token@github.com/acme/widget.git",
    "https://token@github.com/acme/widget.git",
    "https://github.com/acme/widget.git?ref=main",
    "https://github.com/acme/widget.git#main",
    "https://github.com/",
    "https://github.com/acme/..",
    "https://github.com/acme/-widget",
    "ssh://-oProxyCommand=touch%20x/widget",
    "ssh://-oProxyCommand=x@example.com/widget",
    "git@-oProxyCommand=x:widget",
    "git@example.com:-oProxyCommand=x",
    "git@example.com:acme/../../widget",
    "git@example.com:acme/widget;rm",
    "https://github.com/acme/widget\n--upload-pack=x",
    "https://github.com/acme/wid get",
    "https://github.com/acme/widget\u0000",
    "acme/widget/extra",
    // A `.git` repository name would make the clone base itself a repository.
    "https://evil.example/x/.git.git",
    "https://evil.example/x/.git",
    "acme/.git.git",
    "acme/.git",
    "acme/.GIT.git",
    "git@evil.example:x/.GIT.git",
    "ssh://git@evil.example/x/.Git.git",
    "acme/.hidden",
    "https://evil.example/x/..git",
    "-acme/widget",
    `https://github.com/acme/${"x".repeat(2_100)}`,
  ];
  for (const input of rejected) {
    const result = parseCloneUrl(input);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
  }
});

test("clone ids are bounded tokens", () => {
  assert.equal(workspaceCloneId("clone_abc-1234"), "clone_abc-1234");
  for (const bad of ["short", "has space here", "../../etc/passwd", 7, undefined, "x".repeat(65)]) {
    assert.throws(() => workspaceCloneId(bad), /Invalid clone identifier/u);
  }
});
