import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./design-project-inspector.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../design-projects.css", import.meta.url), "utf8");

test("inspector exposes Preview, Code, and History as an accessible controlled tablist", () => {
  assert.match(source, /id: "preview", label: "Preview"/u);
  assert.match(source, /id: "code", label: "Code"/u);
  assert.match(source, /id: "history", label: "History"/u);
  assert.match(source, /role="tablist"/u);
  assert.match(source, /aria-selected=\{selected\}/u);
  assert.match(source, /ArrowLeft/u);
  assert.match(source, /ArrowRight/u);
  assert.match(source, /event\.key === "Home"/u);
  assert.match(source, /event\.key === "End"/u);
});

test("code surface provides line numbers, find, provenance, copy, save, and bundle export callbacks", () => {
  assert.match(source, /designProjectSourceLines\(source\.content\)/u);
  assert.match(source, /countDesignProjectSourceMatches\(source\.content, findQuery\)/u);
  assert.match(source, /designProjectSourceMatchRanges\(line, query\)/u);
  assert.match(source, /SOURCE_TOKEN_PATTERN/u);
  assert.match(source, /design-project-syntax-\$\{token\.kind\}/u);
  assert.match(source, /<span className="sr-only">Find in source<\/span>/u);
  assert.match(source, /onCopySource\(source\)/u);
  assert.match(source, /onSaveSource\(source\)/u);
  assert.match(source, /onExportBundle/u);
  assert.match(source, /latestExportName && onRevealExport/u);
  assert.match(source, /title=\{`Reveal \$\{latestExportName\}`\}/u);
  assert.match(source, /Hash \{source\.contentHash\.slice\(0, 12\)\}/u);
  assert.match(source, /source\.provenance/u);
  assert.match(source, /Read-only workspace source · Designer Action required/u);
  assert.match(source, /design-project-line-number/u);
  assert.match(styles, /grid-template-columns: 48px minmax\(max-content, 1fr\)/u);
  assert.match(styles, /\.design-project-source mark[\s\S]*var\(--accent\)/u);
  for (const kind of ["comment", "keyword", "string", "number", "title", "variable"]) {
    assert.match(styles, new RegExp(`\\.design-project-syntax-${kind}`));
  }
});

test("code shortcuts, drawer semantics, empty states, and revision actions remain explicit", () => {
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/u);
  assert.match(source, /event\.key\.toLocaleLowerCase\(\) === "f"/u);
  assert.match(source, /event\.key\.toLocaleLowerCase\(\) === "s"/u);
  assert.match(source, /role=\{layout === "drawer" \? "dialog" : undefined\}/u);
  assert.match(source, /aria-label="Close inspector"/u);
  assert.match(source, /event\.key === "Escape" && layout === "drawer" && onClose/u);
  assert.match(source, /Nothing selected/u);
  assert.match(source, /Source unavailable/u);
  assert.match(source, /Loading workspace source…/u);
  assert.match(source, /sourceLoading \? \(/u);
  assert.match(source, /role="status" aria-live="polite"/u);
  assert.match(source, /No saved revisions/u);
  assert.match(source, /key=\{`\$\{revision\.lineageId\}:\$\{revision\.id\}`\}/u);
  assert.match(source, /data-lineage-id=\{revision\.lineageId\}/u);
  assert.match(source, /Generated revisions/u);
  assert.match(source, /Designer Actions/u);
  assert.match(source, /Project and preview/u);
  assert.match(source, /Project-backed actions survive restart/u);
  assert.match(source, /Live preview actions remain separate/u);
  assert.doesNotMatch(source, /Session only|do not survive\s+restart yet/u);
  assert.match(source, /onSelectRevision\(revision\.lineageId, revision\.id\)/u);
  assert.match(source, /onCompareRevision\(revision\.lineageId, revision\.id\)/u);
  assert.match(source, /Revision comparison/u);
  assert.match(source, /Close revision comparison/u);
  assert.match(styles, /\.design-project-comparison-grid/u);
});
