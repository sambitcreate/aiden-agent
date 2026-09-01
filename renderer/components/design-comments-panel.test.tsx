import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./design-comments-panel.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../design-comments.css", import.meta.url),
  "utf8",
);

test("comments panel is callback-driven and never imports IPC or source mutation", () => {
  assert.match(
    source,
    /onCreate:\s*\(\s*body: string,\s*target: DesignCommentTargetV1,?\s*\)/u,
  );
  assert.match(source, /onResolve: \(comment: DesignCommentV1\)/u);
  assert.match(source, /onReopen: \(comment: DesignCommentV1\)/u);
  assert.match(source, /onSelectTarget: \(target: DesignCommentTargetV1\)/u);
  assert.doesNotMatch(
    source,
    /renderer\/lib\/ipc|designerApi|writeWorkspaceFile/u,
  );
});

test("composer explains exact binding, validates before callback, and supports keyboard submission", () => {
  assert.match(source, /parseDesignCommentDraft\(draft\)/u);
  assert.match(
    source,
    /Comments require a saved revision and exact element binding\./u,
  );
  assert.match(
    source,
    /Anchored to \$\{designCommentTargetLabel\(currentTarget\)\}/u,
  );
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/u);
  assert.match(source, /event\.key === "Enter"/u);
  assert.match(
    source,
    /disabled=\{!currentTarget \|\| loading \|\| submitting\}/u,
  );
});

test("panel has drawer, loading, error, empty, stale, resolve, and reopen semantics", () => {
  assert.match(source, /role=\{layout === "drawer" \? "dialog" : undefined\}/u);
  assert.match(
    source,
    /aria-modal=\{layout === "drawer" \? false : undefined\}/u,
  );
  assert.match(
    source,
    /event\.key === "Escape" && layout === "drawer" && onClose/u,
  );
  assert.match(source, /role="alert"/u);
  assert.match(source, /Loading comments…/u);
  assert.match(source, /No saved comments yet\./u);
  assert.match(source, /Stale target/u);
  assert.match(source, /View saved target/u);
  assert.match(source, /> Resolve/u);
  assert.match(source, /> Reopen/u);
});

test("stylesheet uses semantic tokens and preserves text-input and keyboard accessibility", () => {
  assert.match(styles, /background: var\(--surface-popover\)/u);
  assert.match(styles, /color: var\(--text-primary\)/u);
  assert.match(styles, /border: 1px solid var\(--border-field\)/u);
  assert.match(
    styles,
    /\.design-comments-composer textarea:focus \{[\s\S]*border-color: var\(--border-field\);[\s\S]*outline: none;/u,
  );
  assert.match(
    styles,
    /:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/u,
  );
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /@media \(forced-colors: active\)/u);
  assert.match(styles, /@media \(max-width: 700px\)/u);
});
