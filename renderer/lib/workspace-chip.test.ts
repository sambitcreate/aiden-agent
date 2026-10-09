import assert from "node:assert/strict";
import test from "node:test";
import { githubRepositoryUrl } from "./workspace-chip.js";

test("github.com owner/name keys open the repository page", () => {
  assert.equal(githubRepositoryUrl("github.com/sambitcreate/aiden-agent"), "https://github.com/sambitcreate/aiden-agent");
  assert.equal(githubRepositoryUrl("github.com/Owner.Name/repo_1"), "https://github.com/Owner.Name/repo_1");
});

test("other hosts and non owner/name shapes have no GitHub link", () => {
  for (const key of [
    "gitlab.com/group/project",
    "github.example.com/team/repo",
    "github.com/group/subgroup/project",
    "github.com/owner",
    "github.com//repo",
    "github.com/owner/..",
    "github.com/owner/repo?x=1",
    "github.com/owner/re po",
  ]) {
    assert.equal(githubRepositoryUrl(key), null, key);
  }
});
