import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./design-project-library.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(
  new URL("./design-project-sidebar.tsx", import.meta.url),
  "utf8",
);
const inspectorSource = readFileSync(
  new URL("./design-project-inspector.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../design-projects.css", import.meta.url), "utf8");
const canvasStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("library exposes controlled search, origin filters, local storage copy, and project actions", () => {
  assert.match(source, /value=\{query\}/u);
  assert.match(source, /onQueryChange\(event\.currentTarget\.value\)/u);
  assert.match(source, /Prototype/u);
  assert.match(source, /label: "Connected"/u);
  assert.match(source, /Stored locally on this Mac/u);
  assert.match(source, /onOpenProject\(project\.id\)/u);
  assert.match(source, /onRenameProject\(project\.id\)/u);
  assert.match(source, /onDuplicateProject\(project\.id\)/u);
  assert.match(source, /onExportProject\(project\.id\)/u);
  assert.match(source, /onDeleteProject\(project\.id\)/u);
  assert.match(source, /<DropdownMenu>/u);
  assert.doesNotMatch(source, /<details/u);
});

test("library has loading, empty, filtered-empty, error, and repair states", () => {
  assert.match(source, /Loading projects…/u);
  assert.match(source, /No design projects yet/u);
  assert.match(source, /No matching projects/u);
  assert.match(source, /Projects unavailable/u);
  assert.match(source, /onRetry/u);
  assert.match(source, /data-health=\{project\.health\}/u);
  assert.match(source, /onRepairProject\(project\.id\)/u);
  assert.match(source, /project\.recoveryAction === "open-project" \? "Open" : "Repair"/u);
});

test("new projects are created immediately with a guarded local-first default title", () => {
  assert.match(sidebarSource, /createInFlightRef\.current/u);
  assert.match(
    sidebarSource,
    /if \(appendReconciliationRequired \|\| createInFlightRef\.current\) return/u,
  );
  assert.match(sidebarSource, /designerApi\.createProject\(\)/u);
  assert.match(sidebarSource, /title=\{createBusy \? "Creating…" : "New Project"\}/u);
  assert.match(sidebarSource, /onClick=\{\(\) => void createProject\(\)\}/u);
  assert.doesNotMatch(sidebarSource, /title="New Design Project"/u);
  assert.match(sidebarSource, /title="Rename Design Project"/u);
  assert.match(source, /disabled=\{createDisabled \|\| createBusy\}/u);
  assert.match(source, /aria-busy=\{createBusy \|\| undefined\}/u);
  assert.match(sidebarSource, /createDisabled=\{appendReconciliationRequired\}/u);
});

test("library rail and drawer preserve focus while text search keeps a quiet focus treatment", () => {
  assert.match(source, /data-layout=\{layout\}/u);
  assert.match(source, /role=\{layout === "drawer" \? "dialog" : undefined\}/u);
  assert.match(source, /aria-label="Close projects"/u);
  assert.match(source, /event\.key === "Escape" && layout === "drawer" && onClose/u);
  assert.match(styles, /\.design-project-library\[data-layout="rail"\]/u);
  assert.match(styles, /\.design-project-library\[data-layout="drawer"\]/u);
  assert.match(styles, /\.design-project-library\[data-layout="sidebar"\]/u);
  assert.match(
    styles,
    /\.design-project-search:focus-within[\s\S]*background: var\(--surface-control\)/u,
  );
  assert.doesNotMatch(
    styles.slice(
      styles.indexOf(".design-project-search:focus-within"),
      styles.indexOf(".design-project-filter"),
    ),
    /outline|box-shadow|border/u,
  );
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Design Project IA has explicit source-backed evidence at 390, 700, 1000, and 1280 px", () => {
  const maxWidthBreakpoints = [
    /@media \(max-width: 400px\)[\s\S]*?\.design-source-preview-control/u.test(canvasStyles)
      ? 400
      : undefined,
    /@media \(max-width: 700px\)[\s\S]*?\.design-project-library\[data-layout="drawer"\]/u.test(
      styles,
    ) && /@media \(max-width: 700px\)[\s\S]*?\.design-canvas-toolbar/u.test(canvasStyles)
      ? 700
      : undefined,
  ].filter((value): value is number => value !== undefined);
  const activeBreakpoints = (width: number) =>
    maxWidthBreakpoints.filter((breakpoint) => width <= breakpoint);

  assert.deepEqual(
    [390, 700, 1000, 1280].map((width) => ({ width, activeBreakpoints: activeBreakpoints(width) })),
    [
      { width: 390, activeBreakpoints: [400, 700] },
      { width: 700, activeBreakpoints: [700] },
      { width: 1000, activeBreakpoints: [] },
      { width: 1280, activeBreakpoints: [] },
    ],
  );

  // Compact widths preserve the same IA while drawers, comparison, source tools,
  // and the primary canvas action collapse instead of disappearing semantically.
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.design-project-comparison-grid[\s\S]*?grid-template-columns: 1fr/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.design-project-library\[data-layout="drawer"\][\s\S]*?width: 100%/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.design-project-code-toolbar[\s\S]*?flex-direction: column/u,
  );
  assert.match(
    canvasStyles,
    /@media \(max-width: 700px\)[\s\S]*?\.design-canvas-continue-label[\s\S]*?clip: rect/u,
  );
  assert.match(canvasStyles, /@media \(max-width: 400px\)[\s\S]*?\.design-source-preview-control/u);
  assert.match(source, /Stored locally on this Mac/u);
  assert.match(source, /Projects stay in Aiden until you explicitly export or continue/u);
  assert.match(inspectorSource, /role="tablist" aria-label="Design inspector views"/u);
  for (const label of ["Preview", "Code", "History"]) {
    assert.match(inspectorSource, new RegExp(`label: "${label}"`, "u"));
  }
});
