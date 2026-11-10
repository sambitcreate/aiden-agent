import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_ARTIFACT_PAGE_IDEAS, workspaceArtifactNewPageRequest } from "./workspace-artifacts-view.js";

test("a New page request keeps the person's words, only trimmed", () => {
  assert.equal(workspaceArtifactNewPageRequest("  GitHub issues  "), "Make a workspace artifact page that shows GitHub issues.");
  assert.equal(workspaceArtifactNewPageRequest("What's failing?"), "Make a workspace artifact page that shows What's failing?");
  assert.equal(workspaceArtifactNewPageRequest("the deploy log, newest first."), "Make a workspace artifact page that shows the deploy log, newest first.");
  assert.equal(workspaceArtifactNewPageRequest("ship it!"), "Make a workspace artifact page that shows ship it!");
});

test("an empty New page request asks for nothing", () => {
  assert.equal(workspaceArtifactNewPageRequest(""), "");
  assert.equal(workspaceArtifactNewPageRequest(" \n "), "");
});

test("a suggestion drafts its subject, not its label", () => {
  const idea = WORKSPACE_ARTIFACT_PAGE_IDEAS.find((entry) => entry.label === "Open pull requests");
  assert.ok(idea);
  assert.equal(workspaceArtifactNewPageRequest(idea.subject), "Make a workspace artifact page that shows this repository's open pull requests.");
});
