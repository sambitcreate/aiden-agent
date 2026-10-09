import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarListItem } from "./ui.js";
import { ChatRowContext } from "./chat-row-context.js";
import type { SidebarRowPullRequest } from "../lib/chat-row-context.js";

function labels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]!);
}

function pullRequest(overrides: Partial<SidebarRowPullRequest> = {}): SidebarRowPullRequest {
  return {
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    title: "Tighten sidebar rows",
    state: "open",
    isDraft: false,
    checksState: "failing",
    ...overrides,
  };
}

test("a chat outside a worktree and without a PR renders no context glyphs", () => {
  assert.equal(renderToStaticMarkup(<ChatRowContext />), "");
});

test("worktree then PR glyphs expose one accessible name each and hide their icons", () => {
  const markup = renderToStaticMarkup(
    <ChatRowContext worktreeBranch="aiden/sidebar" pullRequest={pullRequest()} />,
  );
  assert.deepEqual(labels(markup), [
    "Worktree on aiden/sidebar",
    "Pull request #42, open, checks failing",
  ]);
  assert.equal(markup.match(/role="img"/gu)?.length, 2);
  assert.equal(markup.match(/<svg[^>]*aria-hidden="true"/gu)?.length, 2);
  assert.match(markup, /title="Pull request #42, open, checks failing\nTighten sidebar rows"/u);
});

test("glyphs are images, never controls nested inside the row button", () => {
  const markup = renderToStaticMarkup(
    <SidebarListItem
      title="Fix flaky test"
      trailing={<ChatRowContext worktreeBranch="aiden/fix" pullRequest={pullRequest()} />}
    />,
  );
  assert.equal(markup.match(/<button/gu)?.length, 1);
  assert.doesNotMatch(markup, /<a\b/u);
});

test("PR tone follows checks while open and is neutral without a check result", () => {
  const tone = (overrides: Partial<SidebarRowPullRequest>) =>
    /data-tone="([^"]+)"/u.exec(
      renderToStaticMarkup(<ChatRowContext pullRequest={pullRequest(overrides)} />),
    )?.[1];
  assert.equal(tone({ checksState: "failing" }), "failing");
  assert.equal(tone({ checksState: "pending" }), "pending");
  assert.equal(tone({ checksState: "passing" }), "passing");
  // No checks reported is not the same as checks passing.
  assert.equal(tone({ checksState: null }), "neutral");
  assert.equal(tone({ checksState: undefined }), "neutral");
  assert.equal(tone({ state: "merged", checksState: "failing" }), "neutral");
  assert.equal(tone({ state: "closed", checksState: "passing" }), "neutral");
  assert.equal(tone({ isDraft: true, checksState: "failing" }), "neutral");
});
