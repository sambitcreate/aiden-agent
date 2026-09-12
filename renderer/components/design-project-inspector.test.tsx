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
  assert.match(styles, /grid-template-columns: 48px auto/u);
  assert.match(styles, /\.design-project-source mark[\s\S]*var\(--accent\)/u);
  for (const kind of ["comment", "keyword", "string", "number", "title", "variable"]) {
    assert.match(styles, new RegExp(`\\.design-project-syntax-${kind}`));
  }
});

test("code rail contains long source and keeps status surfaces in normal flow", () => {
  assert.match(source, /const sourceState = source/u);
  assert.match(source, /data-source-state=\{sourceState\}/u);
  assert.match(source, /aria-busy=\{sourceState === "loading" \? true : undefined\}/u);
  assert.match(source, /className="design-project-inspector-state"/u);
  assert.match(source, /role=\{sourceState === "stale" \? "alert" : undefined\}/u);
  assert.match(source, /aria-atomic="true"/u);
  assert.match(source, /placement="inline"/u);

  const drawerRule =
    [...styles.matchAll(/\.design-project-inspector\[data-layout="drawer"\] \{([^}]*)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("contain: inline-size")) ?? "";
  assert.match(drawerRule, /width: 100%;/u);
  assert.match(drawerRule, /max-width: 100%;/u);
  assert.match(drawerRule, /contain: inline-size;/u);
  assert.match(
    styles,
    /\[data-design-workspace-canvas\][\s\S]*:has\(> \.design-project-inspector\[data-layout="drawer"\]\)[\s\S]*width: min\(520px, 100%\);/u,
  );
  assert.match(
    styles,
    /\.design-project-inspector-panel \{[\s\S]*min-width: 0;[\s\S]*min-height: 0;/u,
  );
  assert.match(
    styles,
    /\.design-project-source \{[\s\S]*max-width: 100%;[\s\S]*min-width: 0;[\s\S]*overflow: auto;/u,
  );
  assert.match(
    styles,
    /\.design-project-source ol \{[\s\S]*width: max-content;[\s\S]*min-width: 100%;/u,
  );
  const stateRule = styles.match(/\.design-project-inspector-state \{([^}]*)\}/u)?.[1] ?? "";
  assert.match(stateRule, /display: grid;/u);
  assert.match(stateRule, /overflow: auto;/u);
  assert.doesNotMatch(stateRule, /position:\s*(?:absolute|fixed)/u);
  assert.match(styles, /\.design-project-source-footer \{[\s\S]*flex-wrap: wrap;/u);
  assert.match(styles, /\.design-project-source-footer \{[\s\S]*box-sizing: border-box;/u);
  assert.match(styles, /\.design-project-source-footer \{[\s\S]*max-height: min\(28%, 120px\);/u);
  assert.match(styles, /\.design-project-source-footer > span[\s\S]*overflow-wrap: anywhere;/u);
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
  assert.match(source, /Saved source needs reload/u);
  assert.match(source, /Reload source/u);
  assert.match(source, /sourceError && onRetrySource/u);
  assert.match(source, /Loading source…/u);
  assert.match(source, /exact saved revision or authorized connected element/u);
  assert.match(source, /sourceState === "loading" \? \(/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /No saved revisions/u);
  assert.match(source, /Previewing Revision/u);
  assert.match(source, /this Screen currently uses Revision/u);
  assert.match(source, /Return to current/u);
  assert.match(source, /Refine from this/u);
  assert.match(source, /Make current/u);
  assert.match(source, /event\.stopPropagation\(\)/u);
  assert.match(source, /!element\.closest\("\[hidden\], \[inert\], \[aria-hidden='true'\]"\)/u);
  assert.match(source, /aria-modal=\{layout === "drawer" \? true/u);
  assert.match(source, /aria-pressed=\{revision\.previewed === true\}/u);
  assert.match(styles, /\.design-project-revision\[data-previewed="true"\]/u);
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
