import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRichLink,
  MAX_RICH_LINKS_PER_MESSAGE,
  tokenizeWebLinks,
} from "./rich-link.js";

test("supported service URLs produce local preview descriptors", () => {
  const cases = [
    ["https://github.com/openai/codex", "github", "repository", "openai/codex"],
    ["https://github.com/openai/codex/pull/247", "github", "pull-request", "openai/codex"],
    ["https://github.com/openai/codex/issues/12", "github", "issue", "openai/codex"],
    ["https://github.com/openai/codex/commit/abcdef1234567890", "github", "commit", "openai/codex"],
    ["https://github.com/openai/codex/releases/tag/v1.2.3", "github", "release", "openai/codex"],
    ["https://github.com/openai/codex/actions/runs/123", "github", "workflow", "openai/codex"],
    ["https://github.com/openai/codex/discussions/3", "github", "discussion", "openai/codex"],
    ["https://gitlab.com/group/project/-/merge_requests/9", "gitlab", "pull-request", "group/project"],
    ["https://gitlab.com/group/project/-/issues/8", "gitlab", "issue", "group/project"],
    ["https://docs.google.com/document/d/private-id/edit", "google-drive", "document", "Document"],
    ["https://docs.google.com/spreadsheets/d/private-id/edit", "google-drive", "spreadsheet", "Spreadsheet"],
    ["https://docs.google.com/presentation/d/private-id/edit", "google-drive", "presentation", "Presentation"],
    ["https://drive.google.com/drive/folders/private-id", "google-drive", "folder", "Shared folder"],
    ["https://tenant.sharepoint.com/:f:/s/Team/opaque", "sharepoint", "folder", "tenant"],
    ["https://onedrive.live.com/?id=secret", "sharepoint", "file", "Shared item"],
    ["https://app.box.com/folder/12345", "box", "folder", "Shared folder"],
    ["https://www.notion.so/Project-Roadmap-0123456789abcdef0123456789abcdef", "notion", "document", "Project Roadmap"],
    ["https://workspace.slack.com/archives/C123/p1720000000000000", "slack", "message", "workspace"],
    ["https://teams.microsoft.com/l/meetup-join/opaque", "teams", "meeting", "Teams meeting"],
    ["https://outlook.office.com/calendar/view/month", "outlook", "calendar", "Outlook calendar"],
    ["https://outlook.live.com/mail/0/inbox/id/opaque", "outlook", "email", "Outlook email"],
  ] as const;

  for (const [href, provider, resourceKind, primaryLabel] of cases) {
    const result = describeRichLink(href);
    assert.ok(result, href);
    assert.equal(result.provider, provider, href);
    assert.equal(result.resourceKind, resourceKind, href);
    assert.equal(result.primaryLabel, primaryLabel, href);
  }
});

test("host matching rejects lookalikes, non-web protocols, and malformed URLs", () => {
  const unsupported = [
    "https://github.com.evil.example/openai/codex/pull/1",
    "https://gitlab.com.evil.example/group/project",
    "https://docs.google.com.evil.example/document/d/id",
    "https://slack.com.evil.example/archives/C1/p1",
    "https://notion.site.evil.example/page",
    "https://github.com:8443/openai/codex/pull/1",
    "http://gitlab.com:8080/group/project",
    "javascript:alert(1)",
    "file:///Users/example/repo",
    "/relative/path",
    "not a URL",
  ];
  for (const href of unsupported) assert.equal(describeRichLink(href), null, href);
  assert.equal(describeRichLink("https://GITHUB.COM/openai/codex")?.provider, "github");
  assert.equal(describeRichLink("https://github.com:443/openai/codex")?.provider, "github");
  assert.equal(describeRichLink("http://github.com:80/openai/codex")?.provider, "github");
});

test("preview display values omit credentials, query secrets, fragments, and message timestamps", () => {
  const github = describeRichLink(
    "https://user:password@github.com/openai/codex/pull/247?token=secret#discussion_r1",
  );
  assert.ok(github);
  assert.equal(github.safeDisplayUrl, "github.com/openai/codex/pull/247");
  assert.doesNotMatch(github.safeDisplayUrl, /user|password|secret|discussion_r1/u);

  const google = describeRichLink("https://docs.google.com/document/d/private-id/edit?usp=sharing");
  assert.equal(google?.safeDisplayUrl, "docs.google.com/document");
  const slack = describeRichLink("https://workspace.slack.com/archives/C123/p1720000000000000?thread_ts=secret");
  assert.equal(slack?.safeDisplayUrl, "workspace.slack.com/archives/C123");
});

test("URL-derived labels and display paths stay bounded for adversarial links", () => {
  const longSegment = "界".repeat(500);
  const result = describeRichLink(`https://github.com/${longSegment}/repo/blob/main/${longSegment}`);
  assert.ok(result);
  assert.ok(Array.from(result.primaryLabel).length <= 160);
  assert.ok(Array.from(result.secondaryLabel || "").length <= 120);
  assert.ok(Array.from(result.safeDisplayUrl).length <= 240);
  assert.doesNotThrow(() => describeRichLink("https://github.com/openai/codex/blob/main/%E0%A4%A"));
});

test("plain-message tokenization preserves surrounding text and balanced punctuation", () => {
  const content = "See (https://github.com/openai/codex/pull/247), then https://example.com/a_(b). Done.";
  const segments = tokenizeWebLinks(content);
  assert.equal(segments.map((segment) => segment.text).join(""), content);
  const links = segments.filter((segment) => segment.kind === "link");
  assert.deepEqual(links.map((segment) => segment.href), [
    "https://github.com/openai/codex/pull/247",
    "https://example.com/a_(b)",
  ]);
});

test("plain-message tokenization falls back without changing invalid and non-web text", () => {
  const values = [
    "src/main.ts:42",
    "/Users/example/project",
    "person@example.com",
    "javascript:alert(1)",
    "https://[invalid host",
    "Unicode stays exact: 你好 👋",
  ];
  for (const value of values) {
    const segments = tokenizeWebLinks(value);
    assert.equal(segments.map((segment) => segment.text).join(""), value);
    assert.equal(segments.some((segment) => segment.kind === "link"), false, value);
  }
});

test("plain-message tokenization leaves URLs in backtick code literal", () => {
  const content = [
    "Run `curl https://github.com/acme/repo`.",
    "``Use https://gitlab.com/group/project here``.",
    "```sh\ncurl https://docs.google.com/document/d/private/edit\n```",
    "Unclosed `https://workspace.slack.com/archives/C1/p1",
  ].join("\n");
  const segments = tokenizeWebLinks(content);
  assert.equal(segments.map((segment) => segment.text).join(""), content);
  assert.equal(segments.some((segment) => segment.kind === "link"), false);

  const withOutsideLink = `${content}\nOpen https://github.com/openai/codex instead.`;
  const outsideSegments = tokenizeWebLinks(withOutsideLink);
  assert.equal(outsideSegments.map((segment) => segment.text).join(""), withOutsideLink);
  assert.deepEqual(
    outsideSegments
      .filter((segment) => segment.kind === "link")
      .map((segment) => segment.href),
    [],
    "an unclosed backtick span intentionally protects the remainder of the message",
  );

  const closedThenOutside = "`https://github.com/acme/repo` https://github.com/openai/codex";
  assert.deepEqual(
    tokenizeWebLinks(closedThenOutside)
      .filter((segment) => segment.kind === "link")
      .map((segment) => segment.href),
    ["https://github.com/openai/codex"],
  );
});

test("trailing delimiter trimming stays linear for long generated links", () => {
  const trailing = ")".repeat(20_000);
  const value = `https://example.com/path${trailing}`;
  const [link, punctuation] = tokenizeWebLinks(value);
  assert.equal(link?.kind, "link");
  assert.equal(link?.text, "https://example.com/path");
  assert.equal(punctuation?.text, trailing);
});

test("the rich preview budget remains explicitly bounded", () => {
  assert.equal(MAX_RICH_LINKS_PER_MESSAGE, 50);
});
