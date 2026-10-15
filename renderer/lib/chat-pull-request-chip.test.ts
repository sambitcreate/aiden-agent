import assert from "node:assert/strict";
import test from "node:test";
import { chatPullRequestChipLabels, chatPullRequestListStatus } from "./chat-pull-request-chip.js";

test("chip labels are plain text and announce pending creations awaiting review", () => {
  const none = chatPullRequestChipLabels({ linked: 0, open: 0, pending: 0 });
  assert.equal(none.text, "Pull Requests");
  assert.equal(none.ariaLabel, "Pull requests for this chat");

  const busy = chatPullRequestChipLabels({ linked: 3, open: 2, pending: 1 });
  assert.equal(busy.text, "2 open · 3 linked");
  assert.equal(
    busy.ariaLabel,
    "Pull requests for this chat: 3 linked, 2 open, 1 pending creation needs review",
  );
  for (const label of [busy.text, busy.ariaLabel]) {
    assert.doesNotMatch(label, /[^\x20-\x7E·]/u, "no decorative glyphs");
  }

  assert.match(
    chatPullRequestChipLabels({ linked: 1, open: 0, pending: 2 }).ariaLabel,
    /2 pending creations need review$/u,
  );
});

test("the popover never claims nothing is linked before links load or after they fail", () => {
  assert.equal(chatPullRequestListStatus({ rows: 0, linksLoaded: false, linksFailed: false }), "loading");
  assert.equal(chatPullRequestListStatus({ rows: 0, linksLoaded: false, linksFailed: true }), "error");
  assert.equal(chatPullRequestListStatus({ rows: 0, linksLoaded: true, linksFailed: false }), "empty");
  // Cached or branch-discovered rows stay visible even while a reload fails.
  assert.equal(chatPullRequestListStatus({ rows: 2, linksLoaded: true, linksFailed: true }), "list");
});
