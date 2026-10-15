# Quick View Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Quick View into Claude-Code-style stacked cards that collapse and reorder by drag, add three rows backed by existing data (Folder, Pull request, Context), and reorder the top-bar buttons so Quick View is leftmost and the Environment toggle is rightmost.

**Architecture:** A pure layout module (`renderer/lib/quick-view-layout.ts`) owns section ids, persisted order and which sections the user opened (closed by default), and the drag-target maths. A presentational `QuickViewSection` card renders one section's header, chevron, collapsed summary and right-edge grip. `QuickViewCard` stops rendering a header and `+` menu and instead stacks the sections; their rows come from `EnvironmentOverview`, split into `EnvironmentRows` and `ChangesRows`. One main-process change: the context projection gains an optional per-category `breakdown` (Task 6a). No new IPC channels, no network calls, no Remote protocol or CLI change.

**Tech Stack:** React 19, TanStack Query, Tailwind tokens from `renderer/styles.css`, lucide-react, node:test + Testing Library (happy-dom) and Playwright e2e.

**Spec:** Owner decisions, 2026-10-15. The playground is `tmp/env-panel-options.html` (gitignored), with Layout = Cards, Chevron = After label, Drag by = Grip on hover. The decisions are listed under Global Constraints.

## Global Constraints

- Card style: each section is its own borderless raised card (`bg-popover`, `rounded-dialog`, `shadow-popover`), with an 8px gap and no "Quick View" header.
- Density follows Aiden's list rows (`SidebarListItem`, `renderer/components/ui.tsx:857`): `min-h-9`, `px-2.5`, `gap-2.5`, `text-regular`, icons `size-4.5`, secondary text `text-small text-tertiary`. Section titles use `text-strong font-medium`.
- The chevron sits after the label: `ChevronDown` on every section, rotating −90° when collapsed.
- The drag grip is on the **right edge** of the header. It shows on hover and on `focus-visible`, and stays visible while dragging.
- Toolbar order: `QuickViewToggle` | Terminal, Changes, Browser, Device, Files | separator | Open in editor, `⋯` | `EnvironmentPanelToggle` (far right).
- No invented features. Background tasks, MCP servers, outputs and Aiden Remote stay out.
- The Pull request row renders only when `pullRequestsApi.current(chatId)` returns a pull request. There is no Create PR button.
- **Three tiers per card** (owner, 2026-10-15): (1) collapsed header with a summary; (2) expanded inline detail; (3) a header button at the top right, left of the grip. Context, Subagents and Changes use **Open in sidebar** (`PanelRightOpen`-style icon) to open the matching Environment tool (`context`, `subagents`, `review`). Environment uses an **open-external** button (`ArrowUpRight`, label "Show {workspace} in Finder", "Show in Files" on Linux) that calls `workspacesApi.openFolder`.
- **Every card starts collapsed.** Persist only the cards the user opened (`expanded`), so a card that appears later also starts closed.
- **Cards and rows appear only once there's something to show** (owner, 2026-10-15):
  - Environment: always, when the chat has a workspace folder with access.
  - Changes: when the workspace is a Git repo **and** it has working changes, commits ahead of the last-fetched upstream, or a PR for this chat.
  - Pull request row: only once `pullRequestsApi.current(chatId)` returns a PR. There is no Create PR button.
  - Context: only once the chat has a context projection (`panel.contextDetails?.pressure`, i.e. after the first message).
  - Subagents: only once this chat has started at least one subagent (`panel.subagentViews.length > 0`), and it stays for the session after runs finish.
  - A card that appears mid-session enters with the shared popover motion (opacity + scale .97 → 1, `--motion-large-duration`), and there's no motion under Reduce Motion.
- Context's percentage matches the composer `ContextMeter` (`contextPressurePercent`). The expanded detail uses the new `pressure.breakdown` (Task 6a):
  - a stacked bar over `contextWindow` with one segment per category, sorted largest first, plus Free (`bg-control`) and Reserved for response (hatched). A marker sits at the `inputBudgetTokens` boundary.
  - a legend with tokens and % of window, then the deferred rows in muted text with "—" for % (not counted).
  - a fold, "MCP tools by server N", listing server, tool count and tokens.
  - a note covering compaction state, `compressibleHistoryMessages`, and "Deferred tools load through tool search and aren't counted until used".
  - Category colors use `--chart-1`…`--chart-8` only: Messages 1, Built-in tools 2, System prompt 3, MCP tools 4, Skills 5, Memory 6, Project instructions 7, MCP server instructions 8. Bot instructions shares 7 because the two never co-occur with distinct meaning. When `breakdown` is absent, fall back to two segments: Messages and "System prompt & tools" (`staticTokens`).
- Subagents' expanded detail lists every run in the chat, grouped Running (queued/starting/running), Needs attention, Failed (failed/timed_out/unknown), Stopped (stopped/interrupted), Completed. **Completed starts folded** as one disclosure row ("› Completed N"); the other groups are always open.
  - Each row shows the state mark, label, role pill, and `activity` or `error` (red text). The right side shows live elapsed for active runs and duration for finished ones.
  - Active rows reveal **Stop** on hover or focus, which calls `panel.stopSubagent`. A row click calls `panel.openSubagent(runId, row)`.
  - No new data is needed: everything comes from `panel.subagentViews[].snapshot`.
- **No CLI changes** (owner). `ChatContextPressureV1` is desktop-only today. It isn't in the Remote protocol, iOS, Android or `packages/cli`, and the new field is optional, so the CLI bundle must still build and pass `npm test` in `packages/cli` without edits.
- Keep the visible `focus-visible` ring on every non-text control. Status colors only appear as text or icons, never as borders.
- Pre-1.0: delete the unused `presentation="panel"` branch of `EnvironmentOverview` rather than keeping it.
- New unit test files go in the root `package.json` `test:serial` script **and** `scripts/ci-test-registry.json`, in the same lane as `renderer/lib/environment-panel-layout.test.ts`.
- Do not add `readFileSync` source-grep assertions. `environment-subagents-contract.test.ts:192` already greps `<QuickViewToggle disabled={!effectiveWorkspace} />`; keep that exact JSX text and don't add lines to that test.

## Review Focus

1. **Focus handoff after the `+` menu goes away.** Today `environment-focus.spec.ts` checks that choosing Browse files, Review changes or Compare branch hands focus to tools without reactivating a stacked Quick View. The same must still hold when those destinations are reached from the Folder, Changes and Compare branch rows (Task 6 moves the spec onto the rows).
2. **A saved order that names unknown or missing ids** (an older build, a hand-edited value, an id from a future build). Load must drop unknown ids, append missing defaults, and never throw (Task 1 tests).
3. **Moving a section while a conditional section is hidden.** Example: Subagents is absent and the user drags Context above Changes. Hidden ids must keep their relative place, and nothing may be lost (Task 1 tests).
4. **A tall card dragged past a short one.** The playground bug: midpoint-to-midpoint comparison never swapped. The target must use the leading edge (Task 1 tests).
5. **Breakdown must add up.** Static categories must sum exactly to `staticTokens` (the remainder goes to System prompt, never negative), and the idle-chat (ambient) projection has no MCP tools. The UI must not show an MCP row of 0 or claim deferred tools it doesn't know (Task 6a tests).
6. **Collapsed sections and keyboard users.** A collapsed body must be `inert` and hidden from the accessibility tree, and the header must report `aria-expanded`. The grip must move a section with ↑/↓ and announce its new position (Task 2 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| Create `renderer/lib/quick-view-layout.ts` | Section ids, defaults, parse/serialize, `moveSection`, `toggleSectionExpanded`, `dragTargetIndex` |
| Create `renderer/lib/quick-view-layout.test.ts` | Pure tests for the above |
| Create `renderer/components/quick-view-section.tsx` | One card: collapsible header, chevron, summary, tier-3 header action, right grip, pointer and keyboard reorder |
| Create `renderer/components/quick-view-section.test.tsx` | Testing Library behavior tests |
| Modify `renderer/components/environment-overview.tsx` | Split into `EnvironmentRows` (Folder, Local, Branch) and `ChangesRows` (Changes, Commit or push, Compare branch, Pull request); drop the `panel` presentation; new row density |
| Create `renderer/components/environment-overview.test.tsx` | Rendering tests for Folder and Pull request rows |
| Modify `renderer/components/open-in-editor-picker.tsx` | Export `usePreferredEditor` so the Folder row can open the preferred editor |
| Modify `renderer/components/environment-panel.tsx` (`QuickViewCard`, ~1520–1715) | Card stack, persisted layout, Context and Subagents sections (three tiers); remove the header and `+` menu |
| Modify `renderer/components/chat-top-bar.tsx` (`WorkspaceToolButtons`, 352–462) | `leading`, `trailing`, `end` slots |
| Modify `renderer/main/chat-pane.tsx` (2677–2709) | Pass Quick View as `leading` and Environment as `end` |
| Modify `tests/e2e/environment-focus.spec.ts`, `tests/e2e/chat-top-bar.spec.ts`, add `tests/e2e/quick-view-cards.spec.ts` | User-visible flows |
| Modify `.memory/chat-top-bar.md`, create `.memory/quick-view-cards.md`, modify `docs/plans/README.md`, `docs/chatgpt-desktop-ui-inspiration.md` (Quick View rows) | Records |

---

### Task 1: Layout model and drag maths

**Files:**
- Create: `renderer/lib/quick-view-layout.ts`
- Test: `renderer/lib/quick-view-layout.test.ts`
- Modify: `package.json` (`test:serial`, append after `renderer/lib/environment-panel-layout.test.ts`), `scripts/ci-test-registry.json` (same lane as line 781)

**Interfaces:**
- Produces:
  - `type QuickViewSectionId = "environment" | "changes" | "context" | "subagents"`
  - `interface QuickViewLayout { order: QuickViewSectionId[]; expanded: Partial<Record<QuickViewSectionId, true>> }`
  - `const DEFAULT_QUICK_VIEW_LAYOUT: QuickViewLayout`
  - `const QUICK_VIEW_LAYOUT_STORAGE_KEY = "aiden-agent.quick-view.layout"`
  - `parseQuickViewLayout(raw: string | null): QuickViewLayout`
  - `serializeQuickViewLayout(layout: QuickViewLayout): string`
  - `moveSection(layout, id, toVisibleIndex: number, visible: readonly QuickViewSectionId[]): QuickViewLayout`
  - `toggleSectionExpanded(layout, id): QuickViewLayout`
  - `dragTargetIndex(rects: readonly {top: number; height: number}[], from: number, dy: number): number`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_QUICK_VIEW_LAYOUT,
  dragTargetIndex,
  moveSection,
  parseQuickViewLayout,
  serializeQuickViewLayout,
  toggleSectionExpanded,
} from "./quick-view-layout";

test("missing or corrupt storage falls back to the default layout", () => {
  assert.deepEqual(parseQuickViewLayout(null), DEFAULT_QUICK_VIEW_LAYOUT);
  assert.deepEqual(parseQuickViewLayout("{not json"), DEFAULT_QUICK_VIEW_LAYOUT);
  assert.deepEqual(parseQuickViewLayout('"a string"'), DEFAULT_QUICK_VIEW_LAYOUT);
});

test("unknown ids are dropped, duplicates collapse, and missing sections are appended", () => {
  const layout = parseQuickViewLayout(
    JSON.stringify({ order: ["changes", "mcp", "changes"], expanded: { changes: true, mcp: true } }),
  );
  assert.deepEqual(layout.order, ["changes", "environment", "context", "subagents"]);
  assert.deepEqual(layout.expanded, { changes: true });
});

test("a saved layout round-trips", () => {
  const layout = { order: ["context", "environment", "changes", "subagents"] as const, expanded: { environment: true as const } };
  assert.deepEqual(parseQuickViewLayout(serializeQuickViewLayout({ ...layout, order: [...layout.order] })), {
    ...layout,
    order: [...layout.order],
  });
});

test("moving within visible sections keeps a hidden section's place", () => {
  // Subagents is hidden (no runs); drag Context to the top.
  const start = { order: ["environment", "changes", "subagents", "context"] as const, expanded: {} };
  const visible = ["environment", "changes", "context"] as const;
  const next = moveSection({ ...start, order: [...start.order] }, "context", 0, visible);
  assert.deepEqual(next.order, ["context", "environment", "changes", "subagents"]);
  assert.equal(next.order.length, 4);
});

test("every section starts collapsed and opening one leaves the rest closed", () => {
  assert.deepEqual(DEFAULT_QUICK_VIEW_LAYOUT.expanded, {});
  const once = toggleSectionExpanded(DEFAULT_QUICK_VIEW_LAYOUT, "changes");
  assert.deepEqual(once.expanded, { changes: true });
  assert.deepEqual(toggleSectionExpanded(once, "changes").expanded, {});
});

test("a tall card dragged up passes a short card once its top edge crosses the short card's midpoint", () => {
  const rects = [{ top: 0, height: 80 }, { top: 88, height: 160 }];
  assert.equal(dragTargetIndex(rects, 1, -40), 1); // top at 48 > midpoint 40
  assert.equal(dragTargetIndex(rects, 1, -50), 0); // top at 38 < 40
});

test("a card dragged down uses its bottom edge", () => {
  const rects = [{ top: 0, height: 160 }, { top: 168, height: 80 }, { top: 256, height: 80 }];
  assert.equal(dragTargetIndex(rects, 0, 40), 0); // bottom 200 < 208
  assert.equal(dragTargetIndex(rects, 0, 50), 1); // bottom 210 > 208
  assert.equal(dragTargetIndex(rects, 0, 500), 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test renderer/lib/quick-view-layout.test.ts`
Expected: FAIL. Cannot find module `./quick-view-layout`.

- [ ] **Step 3: Implement**

```ts
// Quick View card order and which cards the user opened (all start closed). Device-local, per user, not per workspace.
export type QuickViewSectionId = "environment" | "changes" | "context" | "subagents";

export interface QuickViewLayout {
  order: QuickViewSectionId[];
  expanded: Partial<Record<QuickViewSectionId, true>>;
}

const SECTION_IDS: readonly QuickViewSectionId[] = ["environment", "changes", "context", "subagents"];
export const QUICK_VIEW_LAYOUT_STORAGE_KEY = "aiden-agent.quick-view.layout";
export const DEFAULT_QUICK_VIEW_LAYOUT: QuickViewLayout = { order: [...SECTION_IDS], expanded: {} };

const isSectionId = (value: unknown): value is QuickViewSectionId =>
  typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);

export function parseQuickViewLayout(raw: string | null): QuickViewLayout {
  if (!raw) return DEFAULT_QUICK_VIEW_LAYOUT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_QUICK_VIEW_LAYOUT;
  }
  if (!value || typeof value !== "object") return DEFAULT_QUICK_VIEW_LAYOUT;
  const record = value as { order?: unknown; expanded?: unknown };
  const order: QuickViewSectionId[] = [];
  for (const id of Array.isArray(record.order) ? record.order : []) {
    if (isSectionId(id) && !order.includes(id)) order.push(id);
  }
  for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
  const expanded: QuickViewLayout["expanded"] = {};
  if (record.expanded && typeof record.expanded === "object") {
    for (const [id, flag] of Object.entries(record.expanded)) {
      if (isSectionId(id) && flag === true) expanded[id] = true;
    }
  }
  return { order, expanded };
}

export function serializeQuickViewLayout(layout: QuickViewLayout): string {
  return JSON.stringify(layout);
}

/** Moves `id` to `toVisibleIndex` among `visible`; hidden sections follow, keeping their relative order. */
export function moveSection(
  layout: QuickViewLayout,
  id: QuickViewSectionId,
  toVisibleIndex: number,
  visible: readonly QuickViewSectionId[],
): QuickViewLayout {
  const shown = layout.order.filter((entry) => visible.includes(entry) && entry !== id);
  const index = Math.max(0, Math.min(shown.length, toVisibleIndex));
  shown.splice(index, 0, id);
  const hidden = layout.order.filter((entry) => !shown.includes(entry));
  return { ...layout, order: [...shown, ...hidden] };
}

export function toggleSectionExpanded(layout: QuickViewLayout, id: QuickViewSectionId): QuickViewLayout {
  const expanded = { ...layout.expanded };
  if (expanded[id]) delete expanded[id];
  else expanded[id] = true;
  return { ...layout, expanded };
}

/**
 * Index the dragged card lands on. The leading edge decides: moving up, the card's top
 * must pass a neighbour's midpoint; moving down, its bottom. Midpoint-to-midpoint never
 * lets a tall card pass a short one.
 */
export function dragTargetIndex(
  rects: readonly { top: number; height: number }[],
  from: number,
  dy: number,
): number {
  const top = rects[from].top + dy;
  const bottom = top + rects[from].height;
  for (let index = 0; index < from; index += 1) {
    if (top < rects[index].top + rects[index].height / 2) return index;
  }
  let target = from;
  for (let index = from + 1; index < rects.length; index += 1) {
    if (bottom > rects[index].top + rects[index].height / 2) target = index;
  }
  return target;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test renderer/lib/quick-view-layout.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Register the test** in `package.json` `test:serial` (append `renderer/lib/quick-view-layout.test.ts` right after `renderer/lib/environment-panel-layout.test.ts`) and in `scripts/ci-test-registry.json` next to line 781. Run `node --test scripts/ci-test-registry.test.mjs`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/lib/quick-view-layout.ts renderer/lib/quick-view-layout.test.ts package.json scripts/ci-test-registry.json
git commit -m "Quick View: layout model for card order, collapse and drag targets"
```

---

### Task 2: `QuickViewSection` card

**Files:**
- Create: `renderer/components/quick-view-section.tsx`
- Test: `renderer/components/quick-view-section.test.tsx`
- Modify: `package.json` `test:serial` + `scripts/ci-test-registry.json` (next to `renderer/components/workbench-panel.test.tsx`)

**Interfaces:**
- Consumes: `dragTargetIndex` from Task 1.
- Produces (every section collapses; tier 3 is `headerAction`):

```ts
export interface QuickViewSectionProps {
  id: QuickViewSectionId;
  title: string;
  /** Shown at the trailing edge while collapsed. */
  summary?: React.ReactNode;
  /** Accessible text for the summary (e.g. "9 percent used"). */
  summaryLabel?: string;
  collapsed: boolean;
  onToggle: () => void;
  index: number;      // position among visible sections
  count: number;      // number of visible sections
  onMove: (id: QuickViewSectionId, toIndex: number) => void;
  /** Visible sibling cards' rects at drag start, in visible order; supplied by the parent. */
  measureSiblings: () => DOMRect[];
  /** Tier 3 header button, left of the grip: Open in sidebar (`PanelRightOpen`) or open-external (`ArrowUpRight`). */
  headerAction?: { kind: "sidebar" | "external"; label: string; onSelect: () => void };
  /** Live drop target while dragging (null when the drag ends) so the parent can shift siblings. */
  onDragPreview?: (id: QuickViewSectionId, to: number | null) => void;
  children?: React.ReactNode;
}
export function QuickViewSection(props: QuickViewSectionProps): React.JSX.Element;
```

Markup contract (tests rely on the roles and names, not on classes):
- `<section aria-labelledby={headingId} data-quick-view-section={id}>` is the card: `rounded-dialog bg-popover shadow-popover`.
- The header is an `h2` containing a `button` with `aria-expanded` and `aria-controls`. The button text is `title`, followed by the chevron (`ChevronDown`, `transition-transform`, `-rotate-90` when collapsed), then the summary (`ml-auto text-small text-tertiary tabular-nums`).
- The grip is a separate `button` placed **after** the header button, at the right edge: `aria-label={`Move ${title}`}`, `aria-keyshortcuts="ArrowUp ArrowDown"`, `GripVertical size-3.5`. It uses `opacity-0 group-hover/qv:opacity-100 focus-visible:opacity-100` and `cursor-grab touch-none`. While a drag is active the card gets `data-dragging` with `shadow-dialog scale-[1.02]`.
- The body is a `div id={bodyId}` with `inert` and `hidden` when collapsed. The expand animation uses `grid-rows-[0fr]` → `grid-rows-[1fr]` over `--motion-duration`, and `motion-reduce:transition-none`.
- Pointer drag works on the grip: `setPointerCapture`, a 4px threshold, `translateY` clamped to the first and last sibling ±8px. On `pointerup` it calls `onMove(id, dragTargetIndex(rects, index, dy))`. While dragging, siblings shift through a CSS variable the parent sets (Task 6). In this task, only the dragged card translates.
- Keyboard: on the grip, `ArrowUp` and `ArrowDown` call `onMove(id, index ∓ 1)` (bounded), then keep focus on the grip (the parent re-renders and restores focus by `data-quick-view-section`). It announces through the existing polite live region pattern: `aria-live` text "`${title}` moved to position n of count".

- [ ] **Step 1: Write the failing tests**

```tsx
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuickViewSection } from "./quick-view-section";

afterEach(cleanup);

function Harness({ sidebar = false, index = 1, onMove = () => {} }: { sidebar?: boolean; index?: number; onMove?: (id: string, to: number) => void }) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <QuickViewSection
      id="changes"
      title="Changes"
      summary={<span>+12 −3</span>}
      summaryLabel="12 additions, 3 deletions"
      headerAction={sidebar ? { kind: "sidebar", label: "Open Changes in sidebar", onSelect: () => onMove("sidebar", -1) } : undefined}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
      index={index}
      count={3}
      onMove={onMove as never}
      measureSiblings={() => []}
    >
      <button type="button">Compare branch</button>
    </QuickViewSection>
  );
}

test("collapsing hides the rows from the accessibility tree and reports the state", () => {
  render(<Harness />);
  const header = screen.getByRole("button", { name: /Changes/ });
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByRole("button", { name: "Compare branch" }));
  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("button", { name: "Compare branch" }), null);
});

test("the Open in sidebar button opens the tool without collapsing the card", () => {
  const calls: unknown[] = [];
  render(<Harness sidebar onMove={(id, to) => calls.push([id, to])} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Changes in sidebar" }));
  assert.deepEqual(calls, [["sidebar", -1]]);
  assert.equal(screen.getByRole("button", { name: /^Changes/ }).getAttribute("aria-expanded"), "true");
});
  assert.equal(header.hasAttribute("aria-expanded"), false);
  fireEvent.click(header);
  assert.deepEqual(calls, [["opened", -1]]);
});

test("the grip moves the section with arrow keys and stops at the ends", () => {
  const moves: unknown[] = [];
  const { rerender } = render(<Harness index={1} onMove={(id, to) => moves.push([id, to])} />);
  const grip = screen.getByRole("button", { name: "Move Changes" });
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  rerender(<Harness index={0} onMove={(id, to) => moves.push([id, to])} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Changes" }), { key: "ArrowUp" });
  assert.deepEqual(moves, [["changes", 0], ["changes", 2]]);
  assert.match(screen.getByRole("status").textContent ?? "", /Changes moved to position/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test renderer/components/quick-view-section.test.tsx`
Expected: FAIL. Module not found.

- [ ] **Step 3: Implement** `quick-view-section.tsx` following the markup contract above. Use `cn` from `../lib/ui-utils`, `ChevronDown`, `ChevronRight` and `GripVertical` from `lucide-react`, and `React.useId()` for the heading and body ids. Header button classes: `flex min-h-9 flex-1 items-center gap-1 rounded-control px-2.5 text-left text-strong font-medium text-primary outline-none hover:bg-list-hover focus-visible:bg-list-hover`. Do not add a focus border or outline to the header; it uses the shared `focus-visible:bg-list-hover` like the other rows, and the grip keeps the global focus ring. Keep a `status` live region (`sr-only`, `role="status"`) inside the card for the move announcement.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test renderer/components/quick-view-section.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Register** in `test:serial` and the registry next to `renderer/components/workbench-panel.test.tsx`, then run `node --test scripts/ci-test-registry.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/quick-view-section.tsx renderer/components/quick-view-section.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Quick View: collapsible, reorderable section card"
```

---

### Task 3: Split `EnvironmentOverview` into section rows at Aiden density

**Files:**
- Modify: `renderer/components/environment-overview.tsx`
- Test: `renderer/components/environment-overview.test.tsx` (created here and extended in Tasks 4–5; register it in `test:serial` + registry)

**Interfaces:**
- Produces:

```ts
export function EnvironmentRows(props: {
  workspace: Workspace;
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onCreateWorktree?: (branchName: string) => Promise<void>;
  onBrowseFiles: () => void;            // used by Task 4
}): React.JSX.Element;

export function ChangesRows(props: {
  workspace: Workspace;
  chatId?: string;
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onOpenReview: (mode: "changes" | "compare") => void;
}): React.JSX.Element | null;           // null when not a Git repo and no review data

/** Collapsed-header summaries, from the same queries the rows use. */
export function useChangesSummary(workspaceId: string | undefined, active: boolean):
  { node: React.ReactNode; label: string } | null;
export function useEnvironmentSummary(workspace: Workspace | undefined):
  { node: React.ReactNode; label: string } | null;   // branch name, or "Local"

export function QuickViewUnavailable(props: { workspace: Workspace | undefined }): React.JSX.Element | null;
// The existing "No workspace folder" / "File access is off" EmptyState, inline placement.
```

- Delete `EnvironmentOverview`, its `presentation` prop and the non-compact branch (the only caller is `QuickViewCard`, rewritten in Task 6). The commit and push dialogs, their refs and the warning `<Text role="status">` lines move into `ChangesRows` unchanged.
- One shared row class replaces the six copies of `grid min-h-11 … px-2`:

```ts
const ROW = "grid min-h-9 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2.5 text-left text-regular text-primary outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45";
```

  Icons stay `size-4.5 text-secondary`. The Local row keeps `localDetail` ("Isolated worktree" or "Runs on this device"). The branch row keeps `GitBranchPicker triggerVariant="overview"`; check its trigger renders at `min-h-9` and, if it hard-codes `min-h-11`, change that variant's class in `git-branch-picker.tsx`.

- [ ] **Step 1: Write failing tests** for the split. The IPC fixtures use `installBotTestIpc` (`renderer/main/bots/test-dom.ts:120`) and `createBotTestQueryClient()` (`renderer/main/bots/test-providers.tsx:18`), as in `renderer/components/settings/voice-settings.test.tsx`. Find the channel names behind `useGitReview`, `useGitInfo` and `useGitPushCapability` in `renderer/lib/ipc.ts` and stub them.

```tsx
test("Changes rows show line totals, commit/push and compare for a repository", async () => {
  installBotTestIpc({
    "git:review": () => reviewFixture({ fileCount: 2, additions: 12, deletions: 3 }),
    "git:info": () => ({ isRepo: true, branch: "feature/x", detached: false, unborn: false }),
    "git:pushCapability": () => ({ allowed: true, ahead: 1, branch: "feature/x", suggestedRemote: "origin" }),
  });
  renderWithClient(<ChangesRows workspace={WORKSPACE} active mutationBlockedReason={null} onGitOperationBusyChange={() => {}} onOpenReview={() => {}} />);
  assert.ok(await screen.findByRole("button", { name: /Changes, 2 files, 12 known additions, 3 known deletions/ }));
  assert.ok(screen.getByRole("button", { name: /Commit or push/ }));
  assert.ok(screen.getByRole("button", { name: /Compare branch/ }));
});

test("Changes rows render nothing outside a Git repository", async () => {
  installBotTestIpc({ "git:review": () => ({ isRepo: false }), "git:info": () => ({ isRepo: false }) });
  const { container } = renderWithClient(<ChangesRows workspace={WORKSPACE} active mutationBlockedReason={null} onGitOperationBusyChange={() => {}} onOpenReview={() => {}} />);
  await waitFor(() => assert.equal(container.querySelector("button"), null));
});
```

  Set the channel strings and `reviewFixture` from the real `GitReview` type in `renderer/lib/types.ts` before running. The test must not guess them.

- [ ] **Step 2:** Run `npx tsx --test renderer/components/environment-overview.test.tsx`. Expected: FAIL (`ChangesRows` not exported).
- [ ] **Step 3:** Implement the split as specified.
- [ ] **Step 4:** Run the test again (PASS), then `npm run type-check`. The type check is expected to fail only at `QuickViewCard` until Task 6, so temporarily render `<EnvironmentRows/>` + `<ChangesRows/>` in `QuickViewCard`'s existing body to keep the tree compiling.
- [ ] **Step 5:** Register the test and commit: `git commit -m "Quick View: split overview into Environment and Changes rows at list density"`.

---

### Task 4: Folder row (Browse files, Open in editor) and Environment's external action

**Files:**
- Modify: `renderer/components/open-in-editor-picker.tsx`, `renderer/components/environment-overview.tsx`
- Test: extend `renderer/components/environment-overview.test.tsx`

**Interfaces:**
- Produces from `open-in-editor-picker.tsx`:

```ts
export function usePreferredEditor(workspaceId: string | undefined, folderPath: string | undefined): {
  preferredEditor: ExternalEditor | undefined;
  openPreferredEditor: () => Promise<void>;
};
```

  Move the existing `preferredEditor` / `refreshEditors` / `openInEditor` / `openPreferredEditor` logic (lines ~60–125) into this hook unchanged. `OpenInEditorPicker` calls the hook. The `useCommandHandler("workspace.openPreferredEditor", …)` registration stays in `OpenInEditorPicker` only, so the command isn't registered twice.

- Row, first in `EnvironmentRows`, shown only when `workspace.folderPath`:
  - The main button uses `ROW`, a `Folder` icon, and the text `{workspace.name}`, followed by `<span className="text-tertiary"> · {parent folder, ~-abbreviated}</span>`. It calls `onBrowseFiles()` with `aria-label={`Browse files in ${workspace.name}`}` and `title={workspace.folderPath}`.
  - It has one trailing icon button (`Button variant="transparent" size="small" iconOnly`, `size-3.5` icon): `Open in ${preferredEditor.label}`, `SquareArrowOutUpRight`, which calls `openPreferredEditor()`. It renders only when `preferredEditor` is set.
  - **Show in Finder** is not on the row. It is the Environment card's tier-3 `headerAction` (`kind: "external"`), built in Task 6 by calling the `useShowWorkspaceFolder(workspace)` hook exported here. The hook wraps `workspacesApi.openFolder(workspace.id)`, shows errors in a toast, and returns `{ label, show }`.
  - Both are disabled when `workspace.permission === "none"`. With access off, `QuickViewUnavailable` already replaces the whole card anyway. On Linux the Finder label is "Show in Files": use the existing platform helper if one exists, otherwise "Open folder". Grep for the wording `chat-top-bar.tsx:266` uses and reuse it.
  - Use the existing `truncate-path` helper (`renderer/lib/truncate-path.ts`) for the parent path.

- [ ] **Step 1: Failing tests**

```tsx
test("the folder row browses files and offers the preferred editor", async () => {
  const calls = installBotTestIpc({ ...repoFixtures, "workspaces:openFolder": () => undefined, "editors:list": () => [{ id: "vscode", label: "VS Code" }] });
  const browsed: string[] = [];
  renderWithClient(<EnvironmentRows workspace={WORKSPACE} active mutationBlockedReason={null} onGitOperationBusyChange={() => {}} onBrowseFiles={() => browsed.push("files")} />);
  fireEvent.click(await screen.findByRole("button", { name: `Browse files in ${WORKSPACE.name}` }));
  assert.deepEqual(browsed, ["files"]);
  assert.equal(screen.queryByRole("button", { name: /Show .* in Finder/ }), null); // lives in the card header now
  assert.ok(await screen.findByRole("button", { name: "Open in VS Code" }));
});
```

  Check the real editor-list channel name and the `calls` record shape in `open-in-editor-picker.tsx` and `test-dom.ts` before running.

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the hook extraction and the row.
- [ ] **Step 4:** Run `environment-overview.test.tsx` again (PASS) and `npx tsx --test renderer/lib/editor-preference.test.ts` (still passes).
- [ ] **Step 5:** Commit: `git commit -m "Quick View: folder row with Browse files, Finder and editor actions"`.

---

### Task 5: Pull request row (only when a PR exists)

**Files:**
- Modify: `renderer/components/environment-overview.tsx` (`ChangesRows`)
- Test: extend `renderer/components/environment-overview.test.tsx`

**Interfaces:**
- Consumes: `useChatCurrentPullRequest(chatId, active)` (`renderer/lib/queries.ts:532`), `ChatPullRequestStateIcon` and `openPullRequestExternal` (`renderer/components/chat-pull-requests.tsx:64,111`).
- Row, last in `ChangesRows`, rendered only when `chatId && current.data?.pullRequest`:
  - A `<button>` using `ROW`, with `ChatPullRequestStateIcon` in the icon column (wrapped so it sits at `size-4.5` alignment), the name `#{number} {title ?? headBranch}` (truncated), and trailing text `Open` / `Draft` / `Merged` / `Closed` in `text-small text-tertiary`. Reuse the label logic in `chat-pull-requests.tsx:104` by exporting `stateLabel` as `chatPullRequestStateLabel`.
  - On click: `openPullRequestExternal(view.url)`. `aria-label={`Pull request #${number}, ${state}. Opens on GitHub`}`.
  - No row while loading, on error, or when `pullRequest` is `undefined`/`null`. No Create PR button.

- [ ] **Step 1: Failing tests**: one where `pullRequests:current` returns `{ pullRequest: PR_VIEW, reason: "created" }`, asserting the row exists and clicking it calls `window.open` with the PR url (stub `window.open`), and one where it returns `{ pullRequest: undefined, reason: "none" }`, asserting there is no `/Pull request/` button.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Quick View: show the chat's pull request once one exists"`.

---

### Task 6: `QuickViewCard` becomes the card stack

**Files:**
- Modify: `renderer/components/environment-panel.tsx` (`QuickViewCard`, lines ~1520–1715; drop the `DropdownMenu` and the `menuButtonRef`/`menuDestinationRef` focus code)
- Modify: `tests/e2e/environment-focus.spec.ts` (move the menu cases onto rows)
- Create: `tests/e2e/quick-view-cards.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–5, `panel.contextDetails` (`environment-panel.tsx:1073`, which already carries the live `pressure` and `compacting` that chat-pane publishes at `chat-pane.tsx:1138`), `contextPressurePercent` (`renderer/shared/context-pressure.ts:140`), `subagentOverviewSummary` and `SubagentMark` (existing).

Behavior:
- The `<aside id="quick-view-card" aria-label="Quick View">` keeps its positioning, `data-state`, `inert` and motion classes. Its own surface classes (`rounded-sheet bg-popover shadow-dialog`) are removed. The aside becomes a transparent `flex flex-col gap-2 overflow-y-auto` stack with `p-0.5`, so card shadows aren't clipped. The `drag-region` header is removed, and the area between cards gets `no-drag`.
- Layout state: `const [layout, setLayout] = React.useState(() => parseQuickViewLayout(localStorage.getItem(QUICK_VIEW_LAYOUT_STORAGE_KEY)))`. Writes go through `localStorage.setItem` inside `try/catch`, the same as `QUICK_VIEW_OPEN_STORAGE_KEY` (line 265).
- Visible sections, in `layout.order`:
  - `environment`: always shown when `active` has a folder with access. Otherwise the stack renders only `QuickViewUnavailable`. `headerAction = { kind: "external", ...useShowWorkspaceFolder(active) }`.
  - `changes`: visible when `git.isRepo && (review.summary.fileCount > 0 || push.ahead > 0 || currentPullRequest)`. Compute this with a `useChangesVisibility(workspaceId, chatId, active)` hook in `environment-overview.tsx` that reads the same three queries `ChangesRows` uses, so there's no extra polling.
  - `context`: shown when `panel.contextDetails?.pressure` is set. Summary is `{percent}%` plus a 40×6 meter (`bg-accent` fill, `bg-support-warning` at ≥80% or `shouldCompact`). The body is a new `ContextBreakdown` component (`renderer/components/context-breakdown.tsx`, pure props `{ pressure, compacting }`), as specified in Global Constraints. `headerAction={{ kind: "sidebar", label: "Open Context in sidebar", onSelect: () => panel.showTools("context") }}`.
  - `subagents`: shown when `panel.subagentsEnabled && panel.subagentViews.length > 0` (any run started in this chat, finished ones included). Summary is `subagentSummary.secondary`. The body is a new `SubagentRunGroups` component (`renderer/components/subagent-run-groups.tsx`, props `{ views, onOpen, onStop, stopPendingRunIds }`) with the grouping above. Grouping is a pure helper `groupSubagentRuns(views)` in `renderer/lib/subagent-panel-state.ts`, tested next to `subagentOverviewSummary`. `headerAction={{ kind: "sidebar", label: "Open Subagents in sidebar", onSelect: () => panel.showTools("subagents") }}`.
  - `changes` gets `headerAction={{ kind: "sidebar", label: "Open Changes in sidebar", onSelect: () => panel.openReview("changes") }}`.
  - Newly visible cards get a `data-entering` attribute for one animation frame cycle (`quick-view-card-enter` keyframes in `renderer/styles.css`, opacity/scale only, disabled under `prefers-reduced-motion` and `[data-reduce-motion="true"]`). Track this with a `useRef<Set<QuickViewSectionId>>` of ids shown on the previous render.
- `EnvironmentRows onBrowseFiles={() => panel.showTools("files")}`. Changes uses `panel.openReview`.
- Sibling shift during drag: the parent owns `dragState: { id, to } | null`, set through `QuickViewSection`'s `onDragPreview(id, to)` prop (Task 2). It also applies `style={{ translate: `0 ${offset}px` }}` with `transition-[translate] duration-(--motion-large-duration)` to the cards between `from` and `to`. `offset` is the dragged card's height + 8. `measureSiblings` returns the visible cards' `getBoundingClientRect()` via a `Map<id, HTMLElement>` ref.
- Focus on open (replacing `menuButtonRef.current?.focus()` at 1558): focus the first section's header button when `open && present && presented && panel.frontSurface === "quick-view"`.
- After a keyboard move, restore focus to `[data-quick-view-section="${id}"] [aria-label^="Move "]` in a layout effect.

Steps:
- [ ] **Step 1: Rewrite the menu focus spec first (failing).** In `tests/e2e/environment-focus.spec.ts`, replace the loop over `["Browse files", "Review changes", "Compare branch"]` menu items with rows: `quickView.getByRole("button", { name: /^Browse files in / })`, `quickView.getByRole("button", { name: /^Changes,/ })`, and `quickView.getByRole("button", { name: /^Compare branch/ })`. Keep every existing assertion about which tools tab is selected and that tools are not `inert` after activation at 900px. Delete the "Escape dismisses Quick View actions before closing the surface" case's menu part, and keep its "Escape closes Quick View and returns focus to `[data-quick-view-toggle]`" assertion. In the Git-busy case, assert the rows are disabled instead of the menu items.
- [ ] **Step 2: New spec `tests/e2e/quick-view-cards.spec.ts`** (reuse the `aiden` fixture and Git-repo workspace setup from `chat-top-bar.spec.ts:71`):

```ts
test("sections collapse, survive a reload, and reorder by keyboard and pointer", async ({ aiden }) => {
  const { page } = aiden;
  await page.locator("[data-quick-view-toggle]").click();
  const quickView = page.getByRole("complementary", { name: "Quick View" });
  // Every card starts closed; open Changes, then close it again.
  const changesHeader = quickView.getByRole("button", { name: /^Changes/, expanded: false });
  await changesHeader.click();
  await expect(quickView.getByRole("button", { name: /^Compare branch/ })).toBeVisible();
  await changesHeader.click();
  await expect(quickView.getByRole("button", { name: /^Changes/ })).toHaveAttribute("aria-expanded", "false");
  await expect(quickView.getByRole("button", { name: /^Compare branch/ })).toHaveCount(0);

  const order = () => quickView.locator("[data-quick-view-section]").evaluateAll((els) => els.map((el) => el.getAttribute("data-quick-view-section")));
  // The fixture repo has uncommitted edits so Changes is visible; no messages and no subagents, so Context and Subagents are absent.
  expect(await order()).toEqual(["environment", "changes"]);
  await quickView.getByRole("button", { name: "Move Changes" }).focus();
  await page.keyboard.press("ArrowUp");
  expect(await order()).toEqual(["changes", "environment"]);
  await expect(quickView.getByRole("button", { name: "Move Changes" })).toBeFocused();

  const grip = quickView.getByRole("button", { name: "Move Changes" });
  const env = quickView.locator('[data-quick-view-section="environment"]');
  await grip.hover();
  const from = await grip.boundingBox();
  const target = await env.boundingBox();
  await page.mouse.move(from!.x + 4, from!.y + 4);
  await page.mouse.down();
  await page.mouse.move(from!.x + 4, target!.y + target!.height + 20, { steps: 12 });
  await page.mouse.up();
  await expect.poll(order).toEqual(["environment", "changes"]);

  await page.reload();
  await page.locator("[data-quick-view-toggle]").click();
  await expect(quickView.getByRole("button", { name: /^Changes/ })).toHaveAttribute("aria-expanded", "false");
});

test("Changes stays hidden on a clean, pushed repo without a PR", async ({ aiden }) => {
  const { page } = aiden; // use the clean-repo fixture from chat-top-bar.spec.ts
  await page.locator("[data-quick-view-toggle]").click();
  const quickView = page.getByRole("complementary", { name: "Quick View" });
  await expect(quickView.locator('[data-quick-view-section="environment"]')).toBeVisible();
  await expect(quickView.locator('[data-quick-view-section="changes"]')).toHaveCount(0);
});

test("the grip sits at the right edge and appears on hover", async ({ aiden }) => {
  const { page } = aiden;
  await page.locator("[data-quick-view-toggle]").click();
  const card = page.locator('[data-quick-view-section="environment"]');
  const grip = card.getByRole("button", { name: "Move Environment" });
  await expect(grip).toHaveCSS("opacity", "0");
  await card.hover();
  await expect(grip).not.toHaveCSS("opacity", "0");
  const [g, c] = [await grip.boundingBox(), await card.boundingBox()];
  expect(c!.x + c!.width - (g!.x + g!.width)).toBeLessThan(16);
});
```

  If the fixture enables Context pressure or subagents, extend the `order()` expectations to match. Do not hard-code sections the fixture does not produce.

- [ ] **Step 3:** Run `npm run test:e2e -- tests/e2e/quick-view-cards.spec.ts tests/e2e/environment-focus.spec.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement the `QuickViewCard` rewrite.
- [ ] **Step 5:** Run those specs plus `tests/e2e/workspace-panel.spec.ts` (Quick View dock/float at line 149), `tests/e2e/chat-shell-interactions.spec.ts` and `tests/e2e/chat-top-bar.spec.ts:170`. Expected: PASS. Then run `npx tsx --test renderer/components/environment-subagents-contract.test.ts renderer/lib/environment-panel-layout.test.ts renderer/lib/environment-panel-state.test.ts`. Expected: PASS.
- [ ] **Step 6:** Commit: `git commit -m "Quick View: stacked cards with collapse, reorder and Context"`.

---

### Task 6a: Per-category context breakdown in the projection (main)

**Files:**
- Modify: `main/services/generation-context.ts` (`GenerationContextOptions` :23, `estimateStaticContextTokens` :140, `projectNextContextUsage` :424, `chatContextPressureFromProjection` :499), `main/services/chat-system-prompt.ts` (:15–67), `main/services/mcp-server-instructions.ts` (:53–75), `main/services/memory-context.ts` (:387), `main/services/llm-client.ts` (:2894–2968, profiles :3127/:3190), `main/services/context-pressure.ts` (`ambientContextOptions`), `renderer/shared/context-pressure.ts` (type + strict parser :46)
- Test: `main/services/generation-context.test.ts`, `renderer/shared/context-pressure.test.ts`

**Interfaces:**
- Produces in `renderer/shared/context-pressure.ts` (shared by main and renderer):

```ts
export type ContextCategoryId =
  | "system-prompt" | "builtin-tools" | "mcp-tools" | "skills" | "memory"
  | "project-instructions" | "mcp-instructions" | "bot-instructions";
export interface ContextBreakdownV1 {
  /** Static categories; tokens sum exactly to staticTokens. Zero-token categories are omitted. */
  categories: { id: ContextCategoryId; tokens: number }[];
  /** Tools held back behind tool search; not counted in contextTokens. */
  deferred: { id: "mcp-tools"; tokens: number; count: number; servers: { name: string; count: number; tokens: number }[] }[];
}
export interface ChatContextPressureV1 { /* …existing… */ breakdown?: ContextBreakdownV1 }
```

- Produces in `generation-context.ts`: `GenerationContextOptions.promptSections?: Partial<Record<Exclude<ContextCategoryId, "system-prompt" | "builtin-tools" | "mcp-tools">, string>>` and `GenerationContextOptions.deferredTools?: readonly AgentTool[]`. Also `estimateContextBreakdown(options): ContextBreakdownV1`, using the same `chars / 4` rule and the cached `toolChars` as `estimateStaticContextTokens`.

**How categories are measured:**
- **Tools:** a declared tool with `codemode === true && discovery` is `mcp-tools`; every other declared tool is `builtin-tools`. Deferred tools are the `deferred` half of `partitionPiCodemodeTools` (`pi-runtime-tool.ts:24`), passed as `deferredTools`. Per-server grouping uses `discovery.server` (check the exact field in `main/services/mcp.ts:580`).
- **Prompt sections:** record each section's text where it is built:
  - `skills` from `skillsSuffix` in `chat-system-prompt.ts` plus the extension `skillsPrompt`
  - `memory` from `memory-context.ts`'s `volatileSystemPrompt`
  - `mcp-instructions` from the block `withMcpServerInstructions` appends
  - `bot-instructions` from `withBotRuntimeInstructions`
  - `project-instructions` from the AGENTS.md section. Measure it as `systemPrompt.length - withoutAgentsInstructions(systemPrompt).length`, because `updateGenerationContextOptions` (:671) rebuilds `systemPrompt` from messages.
  - **System prompt** is the remainder: `staticChars − Σ section chars − Σ tool chars`, clamped at ≥ 0. If clamping triggers (a section was trimmed upstream), scale the sections down proportionally so the total still equals `staticTokens`.
- Thread `promptSections` and `deferredTools` through `llm-client.ts` into the remembered profile (:3127, :3190) and `nextRequestContextOptions`. `ambientContextOptions` (idle chats) records only what it builds: skills and project instructions. It has no MCP tools or instructions, so those categories are simply absent, never 0.
- `chatContextPressureFromProjection` attaches `breakdown`. The renderer's strict `parseChatContextPressure` must accept and validate it: drop it entirely if any entry is malformed or the category sum ≠ `staticTokens`, and keep the rest of the pressure.

- [ ] **Step 1: Failing tests** in `generation-context.test.ts`:
  - The categories sum to `staticTokens` for a fixture with a base prompt, a skills suffix, an AGENTS.md section, two built-in tools, one MCP tool (`codemode: true, discovery: { server: "figma" }`) and two deferred MCP tools. `mcp-tools` equals that one tool's estimate, and `deferred[0].count === 2`, with `servers[0].name === "figma"`.
  - With no MCP tools and no deferred tools, there are no `mcp-tools` and no `deferred` entries.
  - When a recorded section is longer than the final prompt, system-prompt is ≥ 0 and the sum still equals `staticTokens`.
  - Extend the existing ":684 DTO mirrors projection" test so `breakdown` survives `chatContextPressureFromProjection`.
  In `renderer/shared/context-pressure.test.ts`: a valid breakdown round-trips; one with a bad category id, negative tokens, or a sum mismatch is dropped while `percentOfUsableInput` survives; a payload without `breakdown` still parses (back-compat with an older main build isn't needed pre-1.0, but the field stays optional for the ambient path).
- [ ] **Step 2:** Run `npx tsx --test main/services/generation-context.test.ts renderer/shared/context-pressure.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement as described.
- [ ] **Step 4:** Run those two files plus `main/services/pi-agent-runtime-harness.test.ts main/services/agents-instructions.test.ts main/handlers/chat-session-params.test.ts renderer/components/context-meter.test.tsx renderer/lib/context-pressure-feed.test.ts`. Expected: PASS. Then run `cd packages/cli && npm run build && npm test` with no CLI edits. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Context: per-category breakdown in the next-request projection"`.

---

### Task 6b: Context breakdown and subagent groups

**Interfaces:** Consumes `ContextBreakdownV1` from Task 6a.

**Files:** Create `renderer/components/context-breakdown.tsx` + `.test.tsx`, `renderer/components/subagent-run-groups.tsx` + `.test.tsx`. Modify `renderer/lib/subagent-panel-state.ts` (+ its existing test). Register the new tests.

- [ ] **Step 1: Failing tests.**
  - `ContextBreakdown`, with a fixture pressure of 31% (`contextTokens 299_800`, `messageTokens 273_400`, `staticTokens 26_400`, window 1M, reserved 33k) and a `breakdown` of built-in tools 11.8k, system prompt 6.2k, skills 2.4k, MCP tools 2.1k, project instructions 1.9k, MCP instructions 1.1k, memory 0.9k, plus deferred MCP tools 61.4k / 142 across four servers:
    - it renders "31% used"
    - the legend lists Messages first (largest) and the categories in descending order, then Reserved for response and Free space
    - the deferred row shows 61.4k and "—"
    - "MCP tools by server 142" starts with `aria-expanded="false"`, and opening it lists the four servers
    - the bar's `role="img"` label names every segment
    - without `breakdown`, the legend falls back to Messages + "System prompt & tools"
    - with `shouldCompact: true`, the note reads "Aiden will compact context before the next request."
  - `groupSubagentRuns`: runs in each of the 10 view states land in the five groups in the order Running, Needs attention, Failed, Stopped, Completed, and empty groups are omitted.
  - `SubagentRunGroups`:
    - Completed starts as one "Completed 3" disclosure row with `aria-expanded="false"`, and opening it shows 3 rows
    - Stop is present only on active rows and calls `onStop` with the run
    - clicking a row calls `onOpen(runId)`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `formatContextTokenCount` for numbers and add `--chart-1`/`--chart-2` swatches (existing tokens). The elapsed time ticks once per second through one shared interval, only while an active run is shown. Stop uses the existing stop-pending state (`subagentStopPendingRunIds`) to disable the button and show "Stopping…".
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Quick View: inline context breakdown and grouped subagent runs"`.

---

### Task 7: Toolbar order (Quick View leftmost, Environment far right)

**Files:**
- Modify: `renderer/components/chat-top-bar.tsx` (`WorkspaceToolButtons`), `renderer/main/chat-pane.tsx:2677–2709`
- Test: extend `tests/e2e/chat-top-bar.spec.ts`

**Interfaces:**
- `WorkspaceToolButtons` props become `{ …existing, leading?: React.ReactNode; trailing?: React.ReactNode; end?: React.ReactNode }`.
- Render order:
  1. `leading`, then a separator `<span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-separator" />`
  2. `terminalButton`, then the tool buttons
  3. a separator, then `trailing`
  4. `⋯`
  5. `end`
  `leading` and `end` stay visible in compact mode. Only the tool buttons fold into `⋯`, as today.
- `chat-pane.tsx`: `leading={<QuickViewToggle disabled={!effectiveWorkspace} />}` (keep that exact JSX text), `trailing={<OpenInEditorPicker … />}`, `end={<EnvironmentPanelToggle />}`.

- [ ] **Step 1: Failing e2e**, added to `chat-top-bar.spec.ts` in the Git-repo describe block:

```ts
test("Quick View leads the workspace tools and Environment ends them", async ({ aiden }) => {
  const { page } = aiden;
  const group = page.locator("[data-workspace-tool-buttons]");
  const xs = async (selector: string) => (await group.locator(selector).boundingBox())!.x;
  const quickView = await xs("[data-quick-view-toggle]");
  const terminal = await xs("[data-terminal-toggle]");
  const environment = await xs("[data-environment-toggle]");
  const more = await xs('button[aria-label="More workspace tools"]');
  expect(quickView).toBeLessThan(terminal);
  expect(environment).toBeGreaterThan(more);
  for (const width of [680, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(group.locator("[data-quick-view-toggle]")).toBeVisible();
    await expect(group.locator("[data-environment-toggle]")).toBeVisible();
  }
});
```

- [ ] **Step 2:** Run `npm run test:e2e -- tests/e2e/chat-top-bar.spec.ts`. Expected: the new test FAILS.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the whole `chat-top-bar.spec.ts` (including the no-overlap widths at 680/760/900) and `chat-shell-interactions.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Top bar: Quick View first, Environment toggle last"`.

---

### Task 8: Records and full verification

**Files:**
- Create `.memory/quick-view-cards.md`: decisions (cards, density = `SidebarListItem`, right-edge grip, three tiers, all cards closed by default, visibility rules, layout key `aiden-agent.quick-view.layout`, no `+` menu, context `breakdown` categories and how each is measured), what was deliberately left out (MCP server status, outputs, background tasks, Aiden Remote, Create PR, CLI display of the breakdown), and the tests.
- Modify `.memory/chat-top-bar.md`: the toolbar order line.
- Modify `docs/chatgpt-desktop-ui-inspiration.md` "Overview states": add Folder, Pull request and Context rows, and note that the menu is gone.
- Modify `docs/plans/README.md`: add an Active row linking this plan, and move it to completed once merged.

- [ ] **Step 1:** Write the records.
- [ ] **Step 2:** Run `npm run type-check`, `npm run lint` (if present), `npm run test:serial`, `npm run test:subagents`, `npm run test:devices` and `npm run test:e2e`. Expected: all PASS. Record any flaky spec per AGENTS.md (one rerun at most).
- [ ] **Step 3: Native clients check.** This change is renderer-only, with no Remote protocol, transcript or activity change. Confirm with `git diff --stat origin/main -- main/ ios/ android/` (expect no files) and say so in the PR body.
- [ ] **Step 4: Manual visual pass.** Light, dark and the Paper preset; Reduce Motion on (no translate or rotate animation); 680px and 900px widths (stacked versus docked Quick View); keyboard-only reorder.
- [ ] **Step 5:** Commit: `git commit -m "Quick View cards: memory, docs and plan index"`.

---

## Self-review notes

- Spec coverage:
  - Cards → Task 6
  - Density → Tasks 3 and 2
  - Chevron after label → Task 2
  - Right-edge hover grip → Tasks 2 and 6
  - Drag and keyboard reorder → Tasks 1, 2 and 6
  - Collapsed by default → Tasks 1 and 6
  - Three tiers → Tasks 2, 4 and 6
  - Visibility rules → Tasks 5 and 6
  - Folder + editor + external Finder → Tasks 4 and 6
  - PR only when created → Task 5
  - Context breakdown → Tasks 6a and 6b
  - Subagent groups with Completed folded → Task 6b
  - Toolbar order → Task 7
  - No CLI changes → Task 6a Step 4 builds the CLI without edits
- Onboarding: no new first-run setup or capability. Quick View is not a gallery tile, so no onboarding change.
- Settings: no new setting. Layout is implicit, device-local UI state like `quick-view.open`.
