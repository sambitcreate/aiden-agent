import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMention,
  findMentionTrigger,
  formatMention,
  messageWithMentions,
  rankMentionCandidates,
  removeMentionTrigger,
} from "./composer-mentions";
import type { WorkspaceFileEntry } from "./types";

function entry(path: string, kind: WorkspaceFileEntry["kind"] = "file"): WorkspaceFileEntry {
  const parts = path.split("/");
  return {
    path,
    name: parts[parts.length - 1]!,
    parentPath: parts.slice(0, -1).join("/"),
    depth: parts.length - 1,
    kind,
  };
}

test("an @ at a word boundary starts a mention; one inside a word does not", () => {
  assert.deepEqual(findMentionTrigger("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(findMentionTrigger("look at @src/ma", 15), { start: 8, end: 15, query: "src/ma" });
  assert.deepEqual(findMentionTrigger("see (@readme", 12), { start: 5, end: 12, query: "readme" });
  assert.equal(findMentionTrigger("mail me@example.com", 19), null, "an email address is not a mention");
  assert.equal(findMentionTrigger("@ home", 6), null, "a space ends the query");
  assert.equal(findMentionTrigger("@a\nb", 4), null, "a new line ends the query");
});

test("the token runs past a caret that sits mid-word, and the full-width ＠ counts", () => {
  // Caret after "@comp" in "@composer.tsx": the query is what is before the caret,
  // the token is the whole word, so a pick replaces all of it.
  assert.deepEqual(findMentionTrigger("@composer.tsx later", 5), { start: 0, end: 13, query: "comp" });
  assert.deepEqual(findMentionTrigger("x ＠ab", 5), { start: 2, end: 5, query: "ab" });
});

test("removing the trigger leaves the surrounding text and one space", () => {
  assert.deepEqual(removeMentionTrigger("see @comp here", { start: 4, end: 9 }), { text: "see here", caret: 4 });
  assert.deepEqual(removeMentionTrigger("@comp", { start: 0, end: 5 }), { text: "", caret: 0 });
  assert.deepEqual(removeMentionTrigger("fix(@co)", { start: 4, end: 7 }), { text: "fix()", caret: 4 });
});

test("candidates rank name prefixes first, match on the path too, and skip symlinks that are not files", () => {
  const entries = [
    entry("docs", "directory"),
    entry("docs/composer-notes.md"),
    entry("renderer/components/composer.tsx"),
    entry("renderer/lib/text-match.ts"),
    entry("linked", "symlink"),
  ];
  const byName = rankMentionCandidates(entries, "comp").map((candidate) => candidate.entry.path);
  assert.deepEqual(byName, ["docs/composer-notes.md", "renderer/components/composer.tsx"]);
  const marked = rankMentionCandidates(entries, "comp")[0]!;
  assert.deepEqual(marked.ranges, [{ start: 0, end: 4 }]);

  // A path-only match finds the file and marks nothing in its name.
  const byPath = rankMentionCandidates(entries, "lib/text");
  assert.deepEqual(byPath.map((candidate) => candidate.entry.path), ["renderer/lib/text-match.ts"]);
  assert.deepEqual(byPath[0]!.ranges, []);

  assert.deepEqual(
    rankMentionCandidates(entries, "").map((candidate) => candidate.entry.path),
    ["docs", "docs/composer-notes.md", "renderer/components/composer.tsx", "renderer/lib/text-match.ts"],
  );
  assert.equal(rankMentionCandidates(entries, "", 2).length, 2);

  // "docs/" is how the folder is written, so it offers the folder itself, then what is in it.
  assert.deepEqual(
    rankMentionCandidates(entries, "docs/").map((candidate) => candidate.entry.path),
    ["docs", "docs/composer-notes.md"],
  );
});

test("mentions are written as @path, a folder with a slash, and a path with spaces quoted", () => {
  assert.equal(formatMention({ path: "src/app.ts", kind: "file" }), "@src/app.ts");
  assert.equal(formatMention({ path: "src", kind: "directory" }), "@src/");
  assert.equal(formatMention({ path: "My Notes/a \"b\".md", kind: "file" }), '@"My Notes/a \\"b\\".md"');
});

test("a message lists its mentions first in chip order, then the text", () => {
  const mentions = [
    { path: "a.ts", kind: "file" as const },
    { path: "lib", kind: "directory" as const },
  ];
  assert.equal(messageWithMentions(mentions, "compare these"), "@a.ts @lib/ compare these");
  assert.equal(messageWithMentions(mentions, ""), "@a.ts @lib/");
  assert.equal(messageWithMentions([], "plain"), "plain");
});

test("adding a path already mentioned keeps one chip in its place", () => {
  const first = addMention([], { path: "a.ts", kind: "file" });
  const second = addMention(first, { path: "b.ts", kind: "file" });
  assert.deepEqual(
    addMention(second, { path: "a.ts", kind: "file" }).map((mention) => mention.path),
    ["a.ts", "b.ts"],
  );
});
