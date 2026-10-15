# Bot chat activity · Slice C1 (workbench shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Environment panel's shell (width state and resize, the tab strip, the new-tab launcher hook point, the toggle shortcut on Close, and the open/covered/closed surface) out of `environment-panel.tsx` into a reusable `WorkbenchPanel`, so slice C2 can mount Bot tabs in the same shell. People using workspaces see no change.

**Architecture:** A new `renderer/components/workbench-panel.tsx` owns three things: `useWorkbenchWidth` (the preferred width and drag state, persisted under a key the caller passes), `WorkbenchTabStrip` (tablist, keyboard navigation, close-tab, rename hooks, the optional "+" launcher, the "Open tabs" menu and Close panel with the `environment.toggle` shortcut), and `WorkbenchPanel` (the `<aside>`, the resize separator, the strip and the mounted views). The shell is controlled and knows nothing about workspaces. Tabs and views are two separate lists, because several strip tabs (browser pages, device viewers) share one view. Open state, Quick View, Escape, suppression and the persisted surface keys stay in `EnvironmentPanelProvider` and `EnvironmentWorkbench`. `EnvironmentPanelSurface` becomes the workspace's tab set: it maps the open workspace tabs to `WorkbenchTab`s and the eight workspace bodies to `WorkbenchView`s, and keeps their markup unchanged.

**Tech Stack:** React 19, Radix `DropdownMenu` via `./ui`, lucide-react, `node:test` + Testing Library on happy-dom (`renderer/main/bots/test-dom.ts`), Playwright Electron e2e (`tests/e2e`).

**Spec:** [`docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md`](../specs/2026-10-14-bot-chat-activity-design.md): §2 decision 12, §4 slice C1 row, §8 Shell.

**Slice plans:** A ([quick fixes](2026-10-14-bot-chat-activity-a-quick-fixes.md)), B (status line + Chat activity), C1 (this), C2 (Bots sidebar + Bot side panel, stacked on C1), D (phones).

## Global Constraints

- The contract change is **None** (§4). This slice adds no IPC, no Remote protocol change, no network call and no main-process change. iOS and Android are untouched.
- Workspace behaviour does not change for people using the app. The following stay exactly as they are:
  - DOM ids: `environment-panel`, `environment-<view>-tab`, `environment-<view>-panel`.
  - Accessible names: "Environment work surface", "Environment views", "Resize environment panel", "New workspace tab", "Open tabs", "Close environment panel", `Close ${label} tab`.
  - Close's title: `Close workspace panel (${shortcut})`.
  - Data attributes: `data-environment-surface="tools"`, `data-surface-mode`, `data-state`, `data-device-tab`.
  - Every class string. Moved markup keeps its classes character for character.
- These persistence keys are unchanged, keep their values, and stay defined in `renderer/components/environment-panel.tsx`:
  - `aiden-agent.environment.open-tabs-v1`
  - `aiden-agent.environment.open`
  - `aiden-agent.quick-view.open`
  - `aiden-agent.environment.front-surface`
  - `aiden-agent.environment.surface-state-version`
  - `aiden-agent.environment.tab`
  - `aiden-agent.environment.last-tools-tab`
  - `aiden-agent.environment.width`
- `environment.toggle` keeps its default `Command+Shift+E`. Its handler stays in `renderer/main/root-view.tsx` and still calls `environmentPanel.toggleTools()`. The shell's Close button shows the binding and its `aria-keyshortcuts`.
- Suppression is unchanged: `ChatLayout` still passes `suppressed={onRemoteHost || studioSurface}`, and `QuickViewCard`, the device mini player, Escape handling and `reportSurfaceLayout` stay in `EnvironmentWorkbench`.
- Prefer moving code over rewriting it. Moved handlers, effects and JSX keep their bodies, apart from renamed props.
- Bot tabs (Activity, Files, Memory, Routines) and any route switch to them are **not** built here. That is C2. The only non-workspace tab set is the test harness in `workbench-panel.test.tsx`.
- There is no visual change, so no new tokens, colors, borders or outlines. The separator keeps its `focus-visible` treatment. Tabs and buttons keep the shared `Button` primitive.
- Tests follow AGENTS.md: behavioural oracles only, no new `readFileSync`/`assert.match` lines. Four existing source-grep lines that the move invalidates are deleted in Task 4, and behavioural tests in the same task replace them.
- `renderer/components/workbench-panel.test.tsx` is registered in `package.json` `test:serial` **and** in the `renderer-other` lane of `scripts/ci-test-registry.json`. Afterwards `npm run test:ci-policy` must pass.
- Onboarding is unchanged, because no user-facing capability changes.

## Review Focus

1. **A tab that cannot be closed** (C2's Bot Activity tab, here `closable: false`). Expected: the tab has no close button, and Delete on it does nothing. Closable tabs beside it still close. Test: Task 3, step 1, test "Delete closes a closable tab but never a fixed one".
2. **A saved width that is out of range or garbage, and keyboard resizing past the bounds.** Expected: a stored width outside 480–720, empty or non-numeric falls back to 560. Arrow, Home and End never go past the bounds the container allows, and the clamped value is what gets stored and read back after a remount. Tests: Task 2, step 1, and Task 4, step 1, test "keyboard resizing clamps…".
3. **A closed or covered shell.** Covered happens when Quick View stacks in front, or on a paired host or Studio. Expected: it stays out of the tab order and the accessibility tree (`inert`, `aria-hidden`), keeps its open state and selected tab, and reopens on the same tab. Test: Task 4, step 1, tests "a non-workspace tab set renders and toggles through the shell" and "a covered shell keeps its open state…".
4. **A Git operation in flight.** Expected: tabs, close-tab, "+" and the "Open tabs" items are disabled, but Close panel stays usable (today's behaviour). Test: Task 3, step 1, test "busy disables tab navigation but leaves Close panel usable".
5. **Relaunching the app.** Expected: the panel comes back open, with the same open tabs and the width the person set. The `environment.toggle` command still closes the panel and reopens it on the launcher. Test: Task 1, step 1.

---

## File map

| File | Responsibility |
|---|---|
| Create `renderer/components/workbench-panel.tsx` | `useWorkbenchWidth`, `WorkbenchTab`, `WorkbenchView`, `WorkbenchTabStrip`, `WorkbenchPanel` |
| Create `renderer/components/workbench-panel.test.tsx` | Strip behaviour and the test-only non-workspace consumer of the shell |
| Modify `renderer/lib/environment-panel-layout.ts` (+ its `.test.ts`) | `storedWorkbenchWidth` (pure saved-width parse) |
| Modify `renderer/lib/environment-panel-state.ts` (+ its `.test.ts`) | `environmentPanelViewOrder` (workspace view order and capability gating) |
| Modify `renderer/components/environment-panel.tsx` | `EnvironmentWorkbench` uses `useWorkbenchWidth`. `EnvironmentPanelSurface` renders through `WorkbenchPanel`. `storedPanelWidth`, the strip markup and the resize handlers move out. |
| Modify `renderer/components/environment-subagents-contract.test.ts:159,242-244` | Delete four source-grep lines the move invalidates (behavioural replacements are in Task 4) |
| Modify `tests/e2e/workspace-panel.spec.ts` | Relaunch + toggle-command characterization test |
| Modify `package.json` (`test:serial`), `scripts/ci-test-registry.json` | Register the new test file |
| Modify `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` §8, `docs/plans/README.md`; create `.memory/workbench-shell.md` | Docs, plan index, project memory |

---

### Task 1: Pin today's behaviour in Electron (characterization)

This test is written first and must **pass on the unrefactored code**. It is the oracle that the later tasks keep the behaviour.

**Files:**
- Modify: `tests/e2e/workspace-panel.spec.ts` (add after the first test, which ends around line 67)

**Interfaces:**
- Consumes: the existing `aiden` fixture (`page`, `app`, `relaunch()`), `finishLmStudioOnboarding`.
- Produces: nothing for later tasks. It is a regression oracle.

- [ ] **Step 1: Write the characterization test**

```ts
test("Environment keeps its tabs, width and open state across a relaunch and answers its toggle command", async ({
  aiden,
}) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const setWindowWidth = (width: number) =>
    aiden.app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
  const sendToggle = () =>
    aiden.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:command", { commandId: "environment.toggle" });
      }
    });
  await setWindowWidth(1600);
  let panel = page.getByRole("complementary", { name: "Environment work surface" });
  await page.locator("[data-environment-toggle]").click();
  await panel.getByRole("button", { name: "Files", exact: true }).click();
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await panel.getByRole("button", { name: "Context", exact: true }).click();
  let separator = panel.getByRole("separator", { name: "Resize environment panel" });
  await expect(separator).toHaveAttribute("aria-valuenow", "560");
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "544");

  page = await aiden.relaunch();
  await setWindowWidth(1600);
  panel = page.getByRole("complementary", { name: "Environment work surface" });
  separator = panel.getByRole("separator", { name: "Resize environment panel" });
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveCount(1);
  await expect(panel.getByRole("tab", { name: "Context", exact: true })).toHaveCount(1);
  await expect(panel.getByRole("tabpanel", { name: "New tab" })).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", "544");

  await sendToggle();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "closed");
  await sendToggle();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  await expect(panel.getByRole("tabpanel", { name: "New tab" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveCount(1);
});
```

Why these values: the launcher replaces itself with Files, "+" appends a launcher that Context then replaces, so `open-tabs-v1` holds `[files, context]`. On launch the provider appends `new-tab` and selects it (`initialEnvironmentSurfaceState` always starts on `new-tab`). At 1600px the default 560 fits inline, and ArrowRight narrows by 16 to 544.

- [ ] **Step 2: Run it against the current code**

Run: `npm run test:e2e:workspace-panel -- -g "keeps its tabs, width and open state"`
Expected: PASS. If it fails, the test is wrong, not the app: fix the test before touching `environment-panel.tsx`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/workspace-panel.spec.ts
git commit -m "e2e: pin Environment relaunch persistence and the toggle command"
```

---

### Task 2: Workbench width state hook

**Files:**
- Modify: `renderer/lib/environment-panel-layout.ts` (append), `renderer/lib/environment-panel-layout.test.ts` (append)
- Create: `renderer/components/workbench-panel.tsx`
- Modify: `renderer/components/environment-panel.tsx`: imports (lines 38-46), `storedPanelWidth` (242-249), `EnvironmentPanelSurface` props and `commitWidth` (1234-1250, 1396-1403), `EnvironmentWorkbench` state (1895-1896) and the surface call (2028-2036)

**Interfaces:**
- Consumes: `DEFAULT_PANEL_WIDTH`, `MIN_PANEL_WIDTH`, `MAX_PANEL_WIDTH` (already in `environment-panel-layout.ts`).
- Produces:
  - `storedWorkbenchWidth(stored: string | null): number` in `renderer/lib/environment-panel-layout.ts`
  - `interface WorkbenchWidthState { preferredWidth: number; setPreferredWidth(width: number): void; commitPreferredWidth(width: number): void; resizing: boolean; setResizing(resizing: boolean): void }`
  - `useWorkbenchWidth(storageKey: string): WorkbenchWidthState` in `renderer/components/workbench-panel.tsx`. `commitPreferredWidth` expects an already-clamped width, sets it, and stores `String(Math.round(width))`.

- [ ] **Step 1: Write the failing test**

Append to `renderer/lib/environment-panel-layout.test.ts`, and add `storedWorkbenchWidth` to its import list from `./environment-panel-layout.js`:

```ts
test("a saved workbench width is used only when it is a number inside the saved range", () => {
  assert.equal(storedWorkbenchWidth(null), 560);
  assert.equal(storedWorkbenchWidth("600"), 600);
  assert.equal(storedWorkbenchWidth("480"), 480);
  assert.equal(storedWorkbenchWidth("720"), 720);
  assert.equal(storedWorkbenchWidth("479"), 560);
  assert.equal(storedWorkbenchWidth("721"), 560);
  assert.equal(storedWorkbenchWidth(""), 560);
  assert.equal(storedWorkbenchWidth("wide"), 560);
  assert.equal(storedWorkbenchWidth("Infinity"), 560);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test renderer/lib/environment-panel-layout.test.ts`
Expected: FAIL, `storedWorkbenchWidth` is not exported.

- [ ] **Step 3: Implement**

Append to `renderer/lib/environment-panel-layout.ts`:

```ts
/** A saved preferred width, or the default when it is missing, unparsable or outside the saved range. */
export function storedWorkbenchWidth(stored: string | null): number {
  if (stored === null) return DEFAULT_PANEL_WIDTH;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH
    ? parsed
    : DEFAULT_PANEL_WIDTH;
}
```

Create `renderer/components/workbench-panel.tsx`:

```tsx
import * as React from "react";
import { storedWorkbenchWidth } from "../lib/environment-panel-layout";

export interface WorkbenchWidthState {
  /** The person's preferred width; the rendered width is resolved against the container. */
  preferredWidth: number;
  /** Live updates while dragging. Not persisted. */
  setPreferredWidth: (width: number) => void;
  /** Sets and persists an already-clamped width. */
  commitPreferredWidth: (width: number) => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
}

/** Preferred width and drag state for a workbench, persisted under `storageKey`. */
export function useWorkbenchWidth(storageKey: string): WorkbenchWidthState {
  const [preferredWidth, setPreferredWidth] = React.useState(() =>
    storedWorkbenchWidth(localStorage.getItem(storageKey)),
  );
  const [resizing, setResizing] = React.useState(false);
  const commitPreferredWidth = React.useCallback(
    (width: number) => {
      setPreferredWidth(width);
      localStorage.setItem(storageKey, String(Math.round(width)));
    },
    [storageKey],
  );
  return { preferredWidth, setPreferredWidth, commitPreferredWidth, resizing, setResizing };
}
```

In `renderer/components/environment-panel.tsx`:

1. Delete `storedPanelWidth` (lines 242-249). Keep `WIDTH_STORAGE_KEY` (line 223) where it is.
2. In the `../lib/environment-panel-layout` import, remove `DEFAULT_PANEL_WIDTH`, `MAX_PANEL_WIDTH` and `MIN_PANEL_WIDTH`. Add `import { useWorkbenchWidth } from "./workbench-panel";` after the `./device-workspace-tabs` import.
3. Add a `persistWidth` prop to `EnvironmentPanelSurface`:

```tsx
function EnvironmentPanelSurface({
  width,
  containerWidth,
  inline,
  presented,
  resizing,
  setResizing,
  setWidth,
  persistWidth,
}: {
  width: number;
  containerWidth: number;
  inline: boolean;
  presented: boolean;
  resizing: boolean;
  setResizing: (value: boolean) => void;
  setWidth: (value: number) => void;
  /** Stores an already-clamped width under the workbench width key. */
  persistWidth: (value: number) => void;
}) {
```

4. Replace the surface's `commitWidth` (lines 1396-1403) with:

```tsx
  const commitWidth = React.useCallback(
    (nextWidth: number) => persistWidth(clampToResizeBounds(nextWidth)),
    [clampToResizeBounds, persistWidth],
  );
```

5. In `EnvironmentWorkbench`, replace

```tsx
  const [resizing, setResizing] = React.useState(false);
  const [preferredWidth, setPreferredWidth] = React.useState(storedPanelWidth);
```

with

```tsx
  const panelWidth = useWorkbenchWidth(WIDTH_STORAGE_KEY);
  const resizing = panelWidth.resizing;
```

Then change `resolveEnvironmentPanelLayout(preferredWidth, containerWidth)` to `resolveEnvironmentPanelLayout(panelWidth.preferredWidth, containerWidth)`, and change the surface call to:

```tsx
      <EnvironmentPanelSurface
        width={renderedWidth}
        containerWidth={containerWidth}
        inline={inline}
        presented={toolsPresented}
        resizing={resizing}
        setResizing={panelWidth.setResizing}
        setWidth={panelWidth.setPreferredWidth}
        persistWidth={panelWidth.commitPreferredWidth}
      />
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/lib/environment-panel-layout.test.ts && npx tsc --noEmit`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/environment-panel-layout.ts renderer/lib/environment-panel-layout.test.ts renderer/components/workbench-panel.tsx renderer/components/environment-panel.tsx
git commit -m "Workbench: move panel width state into useWorkbenchWidth"
```

---

### Task 3: `WorkbenchTabStrip`

**Files:**
- Modify: `renderer/components/workbench-panel.tsx`
- Create: `renderer/components/workbench-panel.test.tsx`
- Modify: `renderer/components/environment-panel.tsx`: lucide import (lines 2-10), surface lines 1252-1253 (shortcut hooks), 1282 (`tabMenuSelectionRef`), 1314-1319 (`StripTab`, `stripTabs`), 1490-1518 (`<header>`)
- Modify: `package.json` (`test:serial`), `scripts/ci-test-registry.json` (`renderer-other` lane)

**Interfaces:**
- Consumes: `Button`, `DropdownMenu*` from `./ui`; `useShortcutLabel`, `useShortcutBinding` from `../lib/command-system`; `ariaKeyShortcut` from `../shared/keybindings`.
- Produces:

```ts
export interface WorkbenchTab {
  id: string;            // unique in the strip (React key, menu entry)
  viewId: string;        // the view it shows; ids are `${idPrefix}-${viewId}-tab` / `-panel`
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  selected: boolean;
  closable?: boolean;    // default true; false = no close button, Delete ignored
  title?: string;        // tooltip, default label
  onRename?: () => void; // F2 and double-click call it
  editor?: React.ReactNode;                                  // replaces the button while renaming
  wrap?: (tabButton: React.ReactElement) => React.ReactNode; // e.g. a context menu
  dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>; // on the tab's wrapper
}
export interface WorkbenchTabStripProps<T extends WorkbenchTab> {
  tabs: readonly T[];
  idPrefix: string;
  tabListLabel: string;
  busy?: boolean;
  activeTabRef: React.RefObject<HTMLButtonElement | null>;
  onSelectTab: (tab: T) => void;
  onCloseTab: (tab: T) => void;
  newTab?: { label: string; onOpen: () => void }; // the launcher hook point; absent = no "+"
  closeLabel: string;
  closeTitle: string;    // rendered as `${closeTitle} (${environment.toggle shortcut})`
  onClose: () => void;
}
export function WorkbenchTabStrip<T extends WorkbenchTab>(props: WorkbenchTabStripProps<T>): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `renderer/components/workbench-panel.test.tsx`:

```tsx
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../lib/command-system";
import { COMMAND_IDS } from "../shared/keybindings";
import { WorkbenchTabStrip, type WorkbenchTab } from "./workbench-panel";

const SHORTCUTS = {
  effective: Object.fromEntries(
    COMMAND_IDS.map((id) => [id, id === "environment.toggle" ? "Command+Shift+E" : null]),
  ),
  global: [],
};

beforeEach(() => {
  installBotTestIpc({ "shortcut:get": () => SHORTCUTS });
  localStorage.clear();
});
afterEach(cleanup);

function renderWithCommands(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommandSystemProvider>{ui}</CommandSystemProvider>
    </QueryClientProvider>,
  );
}

const STRIP_TABS: { id: string; label: string; closable?: boolean; renameable?: boolean }[] = [
  { id: "notes", label: "Notes" },
  { id: "log", label: "Log", renameable: true },
  { id: "pinned", label: "Pinned", closable: false },
];

function StripHarness({
  busy = false,
  launcher = true,
  events,
}: {
  busy?: boolean;
  launcher?: boolean;
  events: string[];
}) {
  const [openIds, setOpenIds] = React.useState(STRIP_TABS.map((tab) => tab.id));
  const [selectedId, setSelectedId] = React.useState("notes");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const tabs: WorkbenchTab[] = STRIP_TABS.filter((tab) => openIds.includes(tab.id)).map((tab) => ({
    id: tab.id,
    viewId: tab.id,
    label: tab.label,
    selected: tab.id === selectedId,
    closable: tab.closable,
    dataAttributes: { "data-note-tab": tab.id },
    wrap: tab.renameable ? (button) => <span data-tab-wrapper={tab.id}>{button}</span> : undefined,
    onRename: tab.renameable
      ? () => {
          events.push(`rename:${tab.id}`);
          setRenamingId(tab.id);
        }
      : undefined,
    editor:
      renamingId === tab.id ? (
        <input aria-label={`Rename ${tab.label}`} defaultValue={tab.label} />
      ) : undefined,
  }));
  return (
    <WorkbenchTabStrip
      tabs={tabs}
      idPrefix="test"
      tabListLabel="Test views"
      busy={busy}
      activeTabRef={activeTabRef}
      onSelectTab={(tab) => {
        events.push(`select:${tab.id}`);
        setSelectedId(tab.id);
      }}
      onCloseTab={(tab) => {
        events.push(`close:${tab.id}`);
        setOpenIds((ids) => ids.filter((id) => id !== tab.id));
      }}
      newTab={launcher ? { label: "New test tab", onOpen: () => events.push("new-tab") } : undefined}
      closeLabel="Close test panel"
      closeTitle="Close test panel"
      onClose={() => events.push("close-panel")}
    />
  );
}

const selected = (name: string) =>
  screen.getByRole("tab", { name }).getAttribute("aria-selected");

test("a non-workspace tab set renders as one tablist with a single tab stop", () => {
  renderWithCommands(<StripHarness events={[]} />);
  const list = screen.getByRole("tablist", { name: "Test views" });
  assert.deepEqual(
    Array.from(list.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
    ["Notes", "Log", "Pinned"],
  );
  const notes = screen.getByRole("tab", { name: "Notes" });
  assert.equal(notes.getAttribute("aria-selected"), "true");
  assert.equal(notes.id, "test-notes-tab");
  assert.equal(notes.getAttribute("aria-controls"), "test-notes-panel");
  assert.equal(notes.tabIndex, 0);
  assert.equal(screen.getByRole("tab", { name: "Log" }).tabIndex, -1);
  assert.equal(screen.getByRole("tab", { name: "Log" }).id, "");
  assert.ok(screen.getByRole("tab", { name: "Log" }).closest('[data-tab-wrapper="log"]'));
  assert.ok(screen.getByRole("tab", { name: "Pinned" }).closest('[data-note-tab="pinned"]'));
});

test("arrow keys, Home and End move the selection and wrap at the ends", () => {
  renderWithCommands(<StripHarness events={[]} />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "ArrowRight" });
  assert.equal(selected("Log"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "End" });
  assert.equal(selected("Pinned"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "ArrowRight" });
  assert.equal(selected("Notes"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "ArrowLeft" });
  assert.equal(selected("Pinned"), "true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "Home" });
  assert.equal(selected("Notes"), "true");
});

test("Delete closes a closable tab but never a fixed one", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness events={events} />);
  assert.equal(screen.queryByRole("button", { name: "Close Pinned tab" }), null);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Pinned" }), { key: "Delete" });
  assert.ok(screen.getByRole("tab", { name: "Pinned" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "Delete" });
  assert.equal(screen.queryByRole("tab", { name: "Log" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Close Notes tab" }));
  assert.equal(screen.queryByRole("tab", { name: "Notes" }), null);
  assert.deepEqual(events, ["close:log", "close:notes"]);
});

test("F2 and double-click rename only tabs that support it, and the editor replaces the button", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness events={events} />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "F2" });
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Notes" }));
  assert.deepEqual(events, []);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Log" }), { key: "F2" });
  assert.deepEqual(events, ["rename:log"]);
  assert.ok(screen.getByRole("textbox", { name: "Rename Log" }));
  assert.equal(screen.queryByRole("tab", { name: "Log" }), null);
  assert.ok(screen.getByRole("button", { name: "Close Log tab" }));
  cleanup();

  const clicks: string[] = [];
  renderWithCommands(<StripHarness events={clicks} />);
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Log" }));
  assert.deepEqual(clicks, ["rename:log"]);
});

test("busy disables tab navigation but leaves Close panel usable", async () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness busy events={events} />);
  for (const name of ["Notes", "Log", "Pinned"]) {
    assert.equal((screen.getByRole("tab", { name }) as HTMLButtonElement).disabled, true, name);
  }
  assert.equal((screen.getByRole("button", { name: "Close Notes tab" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "New test tab" }) as HTMLButtonElement).disabled, true);
  fireEvent.keyDown(screen.getByRole("button", { name: "Open tabs" }), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.getAttribute("aria-disabled")), ["true", "true", "true"]);
  const close = screen.getByRole("button", { name: "Close test panel" }) as HTMLButtonElement;
  assert.equal(close.disabled, false);
  fireEvent.click(close);
  assert.deepEqual(events, ["close-panel"]);
});

test("the new-tab launcher appears only when the tab set has one", () => {
  const events: string[] = [];
  renderWithCommands(<StripHarness launcher={false} events={events} />);
  assert.equal(screen.queryByRole("button", { name: "New test tab" }), null);
  cleanup();
  renderWithCommands(<StripHarness events={events} />);
  fireEvent.click(screen.getByRole("button", { name: "New test tab" }));
  assert.deepEqual(events, ["new-tab"]);
});

test("Open tabs lists every tab and selects the one chosen", async () => {
  renderWithCommands(<StripHarness events={[]} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Open tabs" }), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Notes", "Log", "Pinned"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Pinned" }));
  assert.equal(selected("Pinned"), "true");
});

test("Close panel names the panel toggle shortcut", async () => {
  renderWithCommands(<StripHarness events={[]} />);
  const close = screen.getByRole("button", { name: "Close test panel" });
  await waitFor(() =>
    assert.match(close.getAttribute("aria-keyshortcuts") ?? "", /^(Meta|Control)\+Shift\+E$/u),
  );
  assert.match(close.getAttribute("title") ?? "", /^Close test panel \((?!Unassigned).+\)$/u);
});
```

Register the file:
- `package.json` `test:serial`: replace `renderer/lib/environment-panel-layout.test.ts ` with `renderer/lib/environment-panel-layout.test.ts renderer/components/workbench-panel.test.tsx `.
- `scripts/ci-test-registry.json`, `renderer-other` lane: after `"renderer/lib/environment-panel-state.test.ts",` add `"renderer/components/workbench-panel.test.tsx",`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/components/workbench-panel.test.tsx`
Expected: FAIL, `WorkbenchTabStrip` is not exported from `./workbench-panel`.

- [ ] **Step 3: Implement the strip**

Replace the import block of `renderer/components/workbench-panel.tsx` with:

```tsx
import * as React from "react";
import { List, PanelRightClose, Plus, X } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { storedWorkbenchWidth } from "../lib/environment-panel-layout";
```

Append to the same file. The markup is the old `<header>` from `environment-panel.tsx:1490-1518`, with the workspace specifics turned into props:

```tsx
/**
 * One entry in the workbench tab strip. Several tabs may show the same view
 * (each browser page and device viewer is its own tab over one view).
 */
export interface WorkbenchTab {
  /** Unique in the strip: the React key and the "Open tabs" entry. */
  id: string;
  /** The view this tab shows; ids are `${idPrefix}-${viewId}-tab` and `-panel`. */
  viewId: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  selected: boolean;
  /** Defaults to true. A fixed tab gets no close button and ignores Delete. */
  closable?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
  /** F2 and double-click call this. */
  onRename?: () => void;
  /** Replaces the tab button while a rename is in progress. */
  editor?: React.ReactNode;
  /** Wraps the tab button, for example in a context menu. */
  wrap?: (tabButton: React.ReactElement) => React.ReactNode;
  /** Extra `data-*` attributes on the tab's wrapper. */
  dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>;
}

export interface WorkbenchTabStripProps<T extends WorkbenchTab> {
  tabs: readonly T[];
  idPrefix: string;
  tabListLabel: string;
  /** A Git operation (or similar) is in flight: navigation is disabled, Close panel is not. */
  busy?: boolean;
  activeTabRef: React.RefObject<HTMLButtonElement | null>;
  onSelectTab: (tab: T) => void;
  onCloseTab: (tab: T) => void;
  /** The launcher hook point. Without it the strip has no "+" button. */
  newTab?: { label: string; onOpen: () => void };
  closeLabel: string;
  /** Shown as `${closeTitle} (${shortcut})` with the `environment.toggle` binding. */
  closeTitle: string;
  onClose: () => void;
}

export function WorkbenchTabStrip<T extends WorkbenchTab>({
  tabs,
  idPrefix,
  tabListLabel,
  busy = false,
  activeTabRef,
  onSelectTab,
  onCloseTab,
  newTab,
  closeLabel,
  closeTitle,
  onClose,
}: WorkbenchTabStripProps<T>) {
  const toggleShortcut = useShortcutLabel("environment.toggle");
  const toggleShortcutBinding = useShortcutBinding("environment.toggle");
  const tabMenuSelectionRef = React.useRef(false);
  return (
    <header className="drag-region flex h-13 shrink-0 items-center gap-1 border-b border-separator px-2">
      <div className="no-drag flex min-w-0 flex-1 gap-1 overflow-x-auto py-1" role="tablist" aria-label={tabListLabel}>
        {tabs.map((entry, index) => {
          const Icon = entry.icon;
          const closable = entry.closable !== false;
          const tabButton = <Button ref={entry.selected ? activeTabRef : undefined} id={entry.selected ? `${idPrefix}-${entry.viewId}-tab` : undefined} variant="transparent" size="small" role="tab" tabIndex={entry.selected ? 0 : -1} aria-selected={entry.selected} aria-controls={`${idPrefix}-${entry.viewId}-panel`} title={entry.title ?? entry.label} disabled={busy} onClick={() => onSelectTab(entry)} onDoubleClick={entry.onRename} onKeyDown={(event) => {
              if (event.key === "Delete") { event.preventDefault(); if (closable) onCloseTab(entry); return; }
              if (event.key === "F2" && entry.onRename) { event.preventDefault(); entry.onRename(); return; }
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              onSelectTab(tabs[next]);
            }}>{Icon ? <Icon className="size-4 shrink-0" /> : null}<span className="max-w-32 truncate">{entry.label}</span></Button>;
          return <div key={entry.id} {...entry.dataAttributes} className={cn("flex min-w-0 shrink-0 items-center rounded-control", entry.selected && "bg-list-selection")}>
            {entry.editor ?? (entry.wrap ? entry.wrap(tabButton) : tabButton)}
            {closable ? <Button variant="transparent" size="small" iconOnly disabled={busy} aria-label={`Close ${entry.label} tab`} onClick={() => onCloseTab(entry)}><X className="size-3" /></Button> : null}
          </div>;
        })}
      </div>
      {newTab ? <Button variant="transparent" size="small" iconOnly className="no-drag" disabled={busy} aria-label={newTab.label} onClick={newTab.onOpen}><Plus /></Button> : null}
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="transparent" size="small" iconOnly className="no-drag" aria-label="Open tabs"><List /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={(event) => { if (tabMenuSelectionRef.current) { event.preventDefault(); tabMenuSelectionRef.current = false; requestAnimationFrame(() => activeTabRef.current?.focus()); } }}>{tabs.map((entry) => <DropdownMenuItem key={entry.id} disabled={busy} onSelect={() => { tabMenuSelectionRef.current = true; onSelectTab(entry); }}>{entry.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      <Button variant="transparent" size="small" iconOnly onClick={onClose} aria-label={closeLabel} aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)} title={`${closeTitle} (${toggleShortcut})`} className="no-drag"><PanelRightClose /></Button>
    </header>
  );
}
```

`storedWorkbenchWidth` is still used by `useWorkbenchWidth`. `List`, `PanelRightClose`, `Plus`, `X`, `cn` and the `DropdownMenu` parts are used here.

- [ ] **Step 4: Make the workspace use the strip**

In `renderer/components/environment-panel.tsx`:

1. Remove `List` and `X` from the lucide import. Keep `PanelRightClose`, `PanelRightOpen`, `Plus`, `Files` and `GitCompareArrows`.
2. Change the workbench import to `import { WorkbenchTabStrip, useWorkbenchWidth, type WorkbenchTab } from "./workbench-panel";`.
3. In `EnvironmentPanelSurface`, delete `toggleShortcut` / `toggleShortcutBinding` (lines 1252-1253) and `tabMenuSelectionRef` (line 1282).
4. Replace `type StripTab = …` and `const stripTabs = …` (lines 1314-1319) with:

```tsx
  type StripTab = WorkbenchTab & { kind: EnvironmentPanelTab; deviceKey?: string | null };
  const toolIcon = (kind: EnvironmentPanelTab) =>
    WORKSPACE_TOOLS.find((tool) => tool.id === kind)?.icon ?? Plus;
  const stripTabs = panelTabs.flatMap<StripTab>((kind) => kind === "browser" && browser?.tabs.length
    ? browser.tabs.map((page) => ({ id: page.id, viewId: kind, kind, icon: toolIcon(kind), label: page.title || "Browser", selected: panel.tab === "browser" && browser.activeTabId === page.id }))
    : kind === "devices"
      ? devices.entries.map((entry) => ({ id: entry.key ? `device:${entry.key}` : "devices", viewId: kind, kind, icon: toolIcon(kind), label: entry.label, selected: panel.tab === "devices" && entry.selected, deviceKey: entry.key }))
      : [{ id: kind, viewId: kind, kind, icon: toolIcon(kind), label: workspaceToolLabel(kind), selected: panel.tab === kind }]);
```

5. Directly after `closeStripTab` (ends at line 1347), add the device decorations. The rename, context menu and `data-device-tab` behaviour is moved from the old inline JSX:

```tsx
  const finishRename = () => { setRenamingDevice(null); requestAnimationFrame(() => activeTabRef.current?.focus()); };
  const decoratedTabs = stripTabs.map<StripTab>((entry) => {
    const deviceKey = entry.deviceKey;
    if (!deviceKey) return entry;
    return {
      ...entry,
      title: `${entry.label} — double-click to rename`,
      onRename: () => setRenamingDevice(deviceKey),
      dataAttributes: { "data-device-tab": deviceKey },
      editor: renamingDevice === deviceKey
        ? <DeviceTabRenameInput title={entry.label} onCommit={(title) => { devices.rename(deviceKey, title); finishRename(); }} onCancel={finishRename} />
        : undefined,
      wrap: (tabButton) => <DeviceTabContextMenu floating={devices.floating === deviceKey} onRename={() => setRenamingDevice(deviceKey)} onFloat={() => { devices.float(deviceKey); panel.closeTools(); }} onClose={() => closeStripTab(entry)}>{tabButton}</DeviceTabContextMenu>,
    };
  });
```

The device picker entry has `deviceKey: null`. It stays undecorated, but `selectStripTab` still sees `deviceKey !== undefined` and routes it to the picker, as today.

6. Replace the whole `<header …>…</header>` (lines 1490-1518) with:

```tsx
      <WorkbenchTabStrip
        tabs={decoratedTabs}
        idPrefix="environment"
        tabListLabel="Environment views"
        busy={panel.gitOperationBusy}
        activeTabRef={activeTabRef}
        onSelectTab={selectStripTab}
        onCloseTab={closeStripTab}
        newTab={{ label: "New workspace tab", onOpen: () => openTool("new-tab") }}
        closeLabel="Close environment panel"
        closeTitle="Close workspace panel"
        onClose={panel.closeTools}
      />
```

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test renderer/components/workbench-panel.test.tsx && npx tsc --noEmit && npm run test:ci-policy`
Expected: all 8 strip tests PASS, no type errors, and CI policy PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/workbench-panel.tsx renderer/components/workbench-panel.test.tsx renderer/components/environment-panel.tsx package.json scripts/ci-test-registry.json
git commit -m "Workbench: extract the tab strip and its launcher hook point"
```

---

### Task 4: `WorkbenchPanel` shell (surface, resize, views)

**Files:**
- Modify: `renderer/components/workbench-panel.tsx` (append), `renderer/components/workbench-panel.test.tsx` (append)
- Modify: `renderer/lib/environment-panel-state.ts` (append), `renderer/lib/environment-panel-state.test.ts` (append)
- Modify: `renderer/components/environment-panel.tsx`: surface lines 1284 and 1358 (`widthRef`), 1390-1445 (resize), 1447-1648 (return)
- Modify: `renderer/components/environment-subagents-contract.test.ts:159,242-244`

**Interfaces:**
- Consumes: `WorkbenchTab`, `WorkbenchTabStrip`, `WorkbenchTabStripProps`, `useWorkbenchWidth` (Tasks 2-3); `resolveEnvironmentPanelResizeBounds`, `resolveEnvironmentPanelLayout` from `../lib/environment-panel-layout`.
- Produces:

```ts
export interface WorkbenchViewContext { presented: boolean; selected: boolean; width: number }
export interface WorkbenchView { id: string; render: (context: WorkbenchViewContext) => React.ReactNode }
export interface WorkbenchPanelProps<T extends WorkbenchTab>
  extends Omit<WorkbenchTabStripProps<T>, "activeTabRef"> {
  id: string; label: string; resizeLabel: string;
  open: boolean; presented: boolean; inline: boolean;
  width: number; containerWidth: number; resizing: boolean;
  onResizingChange: (resizing: boolean) => void;
  onWidthChange: (width: number) => void;   // live, already clamped
  onWidthCommit: (width: number) => void;   // clamped; persist it
  onActivate?: () => void;
  views: readonly WorkbenchView[];          // all mounted; only selectedViewId is visible
  selectedViewId: string;
  activeTabRef?: React.RefObject<HTMLButtonElement | null>;
  surfaceRef?: React.RefObject<HTMLElement | null>;
}
export function WorkbenchPanel<T extends WorkbenchTab>(props: WorkbenchPanelProps<T>): JSX.Element;
// renderer/lib/environment-panel-state.ts
export function environmentPanelViewOrder(subagentsEnabled: boolean, devicesEnabled?: boolean): EnvironmentPanelTab[];
```

The shell always renders `data-environment-surface="tools"`. That keeps Escape, focus restoration and `activateSurface` working for any tab set mounted in the Environment workbench.

- [ ] **Step 1: Write the failing tests**

Append to `renderer/lib/environment-panel-state.test.ts`, and add `environmentPanelViewOrder` to its import list:

```ts
test("the tools surface mounts workspace views in a fixed order and leaves out disabled ones", () => {
  assert.deepEqual(environmentPanelViewOrder(false, false), ["new-tab", "context", "terminal", "review", "files", "browser"]);
  assert.deepEqual(environmentPanelViewOrder(true, false), ["new-tab", "context", "terminal", "review", "subagents", "files", "browser"]);
  assert.deepEqual(environmentPanelViewOrder(false, true), ["new-tab", "context", "terminal", "review", "files", "browser", "devices"]);
  assert.deepEqual(environmentPanelViewOrder(true, true), ["new-tab", "context", "terminal", "review", "subagents", "files", "browser", "devices"]);
});
```

Append to `renderer/components/workbench-panel.test.tsx`. Extend its imports to `import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";`, `import { resolveEnvironmentPanelLayout } from "../lib/environment-panel-layout";` and `import { WorkbenchPanel, WorkbenchTabStrip, useWorkbenchWidth, type WorkbenchTab, type WorkbenchView } from "./workbench-panel";`. Then add:

```tsx
const WIDTH_KEY = "test.notes-workbench.width";

/** The test-only consumer: a non-workspace tab set mounted through the shell. */
function NotesWorkbench({
  containerWidth = 1600,
  initiallyOpen = false,
  covered = false,
}: {
  containerWidth?: number;
  initiallyOpen?: boolean;
  covered?: boolean;
}) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const [selectedId, setSelectedId] = React.useState("notes");
  const panelWidth = useWorkbenchWidth(WIDTH_KEY);
  const { width, inline } = resolveEnvironmentPanelLayout(panelWidth.preferredWidth, containerWidth);
  const tabs: WorkbenchTab[] = [
    { id: "notes", viewId: "notes", label: "Notes", selected: selectedId === "notes", closable: false },
    { id: "log", viewId: "log", label: "Log", selected: selectedId === "log", closable: false },
  ];
  const views: WorkbenchView[] = [
    {
      id: "notes",
      render: ({ selected, presented }) => (
        <p>Notes body {selected ? "selected" : "idle"} {presented ? "presented" : "hidden"}</p>
      ),
    },
    { id: "log", render: ({ width: viewWidth }) => <p>Log body at {viewWidth}px</p> },
  ];
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>Toggle notes panel</button>
      <WorkbenchPanel
        id="notes-panel"
        label="Notes work surface"
        resizeLabel="Resize notes panel"
        open={open}
        presented={open && !covered}
        inline={inline}
        width={width}
        containerWidth={containerWidth}
        resizing={panelWidth.resizing}
        onResizingChange={panelWidth.setResizing}
        onWidthChange={panelWidth.setPreferredWidth}
        onWidthCommit={panelWidth.commitPreferredWidth}
        views={views}
        selectedViewId={selectedId}
        tabs={tabs}
        idPrefix="notes"
        tabListLabel="Notes views"
        onSelectTab={(tab) => setSelectedId(tab.viewId)}
        onCloseTab={() => undefined}
        closeLabel="Close notes panel"
        closeTitle="Close notes panel"
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const notesSurface = () =>
  screen.getByRole("complementary", { name: "Notes work surface", hidden: true });

test("a non-workspace tab set renders and toggles through the shell", () => {
  renderWithCommands(<NotesWorkbench />);
  const surface = notesSurface();
  assert.equal(surface.getAttribute("data-state"), "closed");
  assert.equal(surface.hasAttribute("inert"), true);
  assert.equal(surface.getAttribute("aria-hidden"), "true");
  assert.equal(screen.getByRole("separator", { name: "Resize notes panel", hidden: true }).tabIndex, -1);

  fireEvent.click(screen.getByRole("button", { name: "Toggle notes panel" }));
  assert.equal(surface.getAttribute("data-state"), "open");
  assert.equal(surface.hasAttribute("inert"), false);
  assert.equal(surface.hasAttribute("aria-modal"), false);
  assert.equal(within(surface).queryByRole("dialog"), null);
  assert.equal(screen.getByRole("separator", { name: "Resize notes panel" }).tabIndex, 0);
  assert.match(screen.getByRole("tabpanel", { name: "Notes" }).textContent ?? "", /Notes body selected presented/u);
  assert.equal(document.getElementById("notes-log-panel")?.hasAttribute("hidden"), true);

  fireEvent.click(screen.getByRole("tab", { name: "Log" }));
  assert.match(screen.getByRole("tabpanel", { name: "Log" }).textContent ?? "", /Log body at 560px/u);
  assert.equal(document.getElementById("notes-notes-panel")?.hasAttribute("hidden"), true);

  fireEvent.click(screen.getByRole("button", { name: "Close notes panel" }));
  assert.equal(surface.getAttribute("data-state"), "closed");
  fireEvent.click(screen.getByRole("button", { name: "Toggle notes panel" }));
  assert.equal(surface.getAttribute("data-state"), "open");
  assert.equal(screen.getByRole("tab", { name: "Log" }).getAttribute("aria-selected"), "true");
});

test("a covered shell keeps its open state but leaves the tab order and the accessibility tree", () => {
  renderWithCommands(<NotesWorkbench initiallyOpen covered />);
  const surface = notesSurface();
  assert.equal(surface.getAttribute("data-state"), "covered");
  assert.equal(surface.hasAttribute("inert"), true);
  assert.equal(surface.getAttribute("aria-hidden"), "true");
  assert.match(document.getElementById("notes-notes-panel")?.textContent ?? "", /Notes body selected hidden/u);
});

test("keyboard resizing clamps to the bounds the container allows and keeps the clamped width", () => {
  const view = renderWithCommands(<NotesWorkbench initiallyOpen containerWidth={1600} />);
  const separator = () => screen.getByRole("separator", { name: "Resize notes panel" });
  assert.equal(separator().getAttribute("aria-valuenow"), "560");
  assert.equal(separator().getAttribute("aria-valuemin"), "480");
  assert.equal(separator().getAttribute("aria-valuemax"), "720");
  fireEvent.keyDown(separator(), { key: "End" });
  assert.equal(separator().getAttribute("aria-valuenow"), "720");
  fireEvent.keyDown(separator(), { key: "ArrowLeft" });
  assert.equal(separator().getAttribute("aria-valuenow"), "720");
  assert.equal(localStorage.getItem(WIDTH_KEY), "720");
  fireEvent.keyDown(separator(), { key: "Home" });
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  assert.equal(separator().getAttribute("aria-valuenow"), "480");
  fireEvent.keyDown(separator(), { key: "ArrowLeft", shiftKey: true });
  assert.equal(separator().getAttribute("aria-valuenow"), "520");
  assert.equal(localStorage.getItem(WIDTH_KEY), "520");
  view.unmount();
  renderWithCommands(<NotesWorkbench initiallyOpen containerWidth={1600} />);
  assert.equal(separator().getAttribute("aria-valuenow"), "520");
});

test("the shell pins beside the content when it fits and floats when it does not", () => {
  renderWithCommands(<NotesWorkbench initiallyOpen containerWidth={1100} />);
  assert.equal(notesSurface().getAttribute("data-surface-mode"), "tools-pinned");
  const separator = screen.getByRole("separator", { name: "Resize notes panel" });
  assert.equal(separator.getAttribute("aria-valuemax"), "540");
  fireEvent.keyDown(separator, { key: "End" });
  assert.equal(separator.getAttribute("aria-valuenow"), "540");
  cleanup();
  renderWithCommands(<NotesWorkbench initiallyOpen containerWidth={900} />);
  assert.equal(notesSurface().getAttribute("data-surface-mode"), "tools-floating");
});
```

Oracle notes: at 1600px the inline bounds are 480–min(720, 1600−560) = 480–720. At 1100px inline still fits (1100−480 ≥ 560) and the maximum is 1100−560 = 540. At 900px the minimum panel no longer leaves 560px of content, so the shell floats. These numbers come from the layout constants, not from the shell's code.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/lib/environment-panel-state.test.ts renderer/components/workbench-panel.test.tsx`
Expected: FAIL. `environmentPanelViewOrder` and `WorkbenchPanel` are not exported.

- [ ] **Step 3: Implement the view order**

Append to `renderer/lib/environment-panel-state.ts`:

```ts
/** Workspace views in the order the tools surface mounts them. */
const ENVIRONMENT_PANEL_VIEW_ORDER = [
  "new-tab",
  "context",
  "terminal",
  "review",
  "subagents",
  "files",
  "browser",
  "devices",
] as const satisfies readonly EnvironmentPanelTab[];

/** Views the tools surface mounts, in DOM order; a disabled capability's view is not mounted at all. */
export function environmentPanelViewOrder(
  subagentsEnabled: boolean,
  devicesEnabled = false,
): EnvironmentPanelTab[] {
  return ENVIRONMENT_PANEL_VIEW_ORDER.filter((tab) =>
    environmentPanelTabEnabled(tab, subagentsEnabled, devicesEnabled),
  );
}
```

- [ ] **Step 4: Implement the shell**

In `renderer/components/workbench-panel.tsx`, change the layout import to `import { resolveEnvironmentPanelResizeBounds, storedWorkbenchWidth } from "../lib/environment-panel-layout";`. Then append the following. The `<aside>`, the separator and the resize handlers are moved from `environment-panel.tsx:1390-1489`:

```tsx
export interface WorkbenchViewContext {
  /** The surface is open and in front. */
  presented: boolean;
  /** This view is the selected one. */
  selected: boolean;
  /** The rendered surface width, for compact layouts. */
  width: number;
}

export interface WorkbenchView {
  id: string;
  render: (context: WorkbenchViewContext) => React.ReactNode;
}

export interface WorkbenchPanelProps<T extends WorkbenchTab>
  extends Omit<WorkbenchTabStripProps<T>, "activeTabRef"> {
  id: string;
  label: string;
  resizeLabel: string;
  open: boolean;
  /** Open and not covered by a surface stacked in front of it. */
  presented: boolean;
  inline: boolean;
  width: number;
  containerWidth: number;
  resizing: boolean;
  onResizingChange: (resizing: boolean) => void;
  /** Live width while dragging, already clamped. */
  onWidthChange: (width: number) => void;
  /** Final width after a drag or a key, already clamped; persist it. */
  onWidthCommit: (width: number) => void;
  onActivate?: () => void;
  /** Every view stays mounted; only `selectedViewId` is visible. */
  views: readonly WorkbenchView[];
  selectedViewId: string;
  activeTabRef?: React.RefObject<HTMLButtonElement | null>;
  surfaceRef?: React.RefObject<HTMLElement | null>;
}

export function WorkbenchPanel<T extends WorkbenchTab>({
  id,
  label,
  resizeLabel,
  open,
  presented,
  inline,
  width,
  containerWidth,
  resizing,
  onResizingChange,
  onWidthChange,
  onWidthCommit,
  onActivate,
  views,
  selectedViewId,
  activeTabRef: providedActiveTabRef,
  surfaceRef: providedSurfaceRef,
  tabs,
  idPrefix,
  tabListLabel,
  busy,
  onSelectTab,
  onCloseTab,
  newTab,
  closeLabel,
  closeTitle,
  onClose,
}: WorkbenchPanelProps<T>) {
  const ownActiveTabRef = React.useRef<HTMLButtonElement | null>(null);
  const ownSurfaceRef = React.useRef<HTMLElement | null>(null);
  const activeTabRef = providedActiveTabRef ?? ownActiveTabRef;
  const surfaceRef = providedSurfaceRef ?? ownSurfaceRef;
  const widthRef = React.useRef(width);
  widthRef.current = width;

  const resizeBounds = resolveEnvironmentPanelResizeBounds(containerWidth, inline);
  const clampToResizeBounds = React.useCallback(
    (nextWidth: number) => Math.min(resizeBounds.max, Math.max(resizeBounds.min, nextWidth)),
    [resizeBounds.max, resizeBounds.min],
  );

  const commitWidth = React.useCallback(
    (nextWidth: number) => onWidthCommit(clampToResizeBounds(nextWidth)),
    [clampToResizeBounds, onWidthCommit],
  );

  const beginResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !open) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = widthRef.current;
      onResizingChange(true);
      const move = (moveEvent: PointerEvent) => {
        onWidthChange(clampToResizeBounds(startWidth + startX - moveEvent.clientX));
      };
      const finish = (endEvent: PointerEvent) => {
        commitWidth(
          endEvent.type === "pointerup" ? startWidth + startX - endEvent.clientX : widthRef.current,
        );
        onResizingChange(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [clampToResizeBounds, commitWidth, open, onResizingChange, onWidthChange],
  );

  const resizeWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 40 : 16;
      let next = width;
      if (event.key === "ArrowLeft") next += increment;
      else if (event.key === "ArrowRight") next -= increment;
      else if (event.key === "Home") next = resizeBounds.min;
      else if (event.key === "End") next = resizeBounds.max;
      else return;
      event.preventDefault();
      commitWidth(next);
    },
    [commitWidth, resizeBounds.max, resizeBounds.min, width],
  );

  return (
    <aside
      ref={surfaceRef}
      id={id}
      data-environment-surface="tools"
      data-surface-mode={inline ? "tools-pinned" : "tools-floating"}
      data-state={open ? (presented ? "open" : "covered") : "closed"}
      inert={!presented ? true : undefined}
      aria-hidden={!presented ? true : undefined}
      aria-label={label}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      className={cn(
        "environment-panel absolute z-30 flex min-h-0 flex-col overflow-hidden bg-popover text-primary",
        inline
          ? "inset-y-0 right-0 border-l border-separator"
          : "bottom-3 right-3 rounded-sheet shadow-dialog",
        // Float below the top bar so its tool buttons stay reachable, like Quick View.
        !inline && "top-14",
        resizing
          ? "transition-none"
          : "transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        (!open || !presented) && !inline && "translate-x-[calc(100%+0.75rem)]",
      )}
      style={{
        width: open ? width : inline ? 0 : width,
        opacity: open && presented ? 1 : 0,
        pointerEvents: open && presented ? "auto" : "none",
      }}
    >
      <div
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={resizeBounds.min}
        aria-valuemax={resizeBounds.max}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-y-0 left-0 z-40 -ml-1 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-accent"
      />

      <WorkbenchTabStrip
        tabs={tabs}
        idPrefix={idPrefix}
        tabListLabel={tabListLabel}
        busy={busy}
        activeTabRef={activeTabRef}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        newTab={newTab}
        closeLabel={closeLabel}
        closeTitle={closeTitle}
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 @container">
        {views.map((view) => {
          const selected = view.id === selectedViewId;
          return (
            <div
              key={view.id}
              id={`${idPrefix}-${view.id}-panel`}
              role="tabpanel"
              aria-labelledby={`${idPrefix}-${view.id}-tab`}
              hidden={!selected}
              className="h-full min-h-0"
            >
              {view.render({ presented, selected, width })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
```

The strip props are destructured one by one rather than spread. A rest spread over the generic `Omit` does not type-check reliably.

- [ ] **Step 5: Render the workspace through the shell**

In `renderer/components/environment-panel.tsx`:

1. Change the workbench import to `import { WorkbenchPanel, useWorkbenchWidth, type WorkbenchTab, type WorkbenchView } from "./workbench-panel";`. Remove `resolveEnvironmentPanelResizeBounds` from the layout import, and add `environmentPanelViewOrder` to the `../lib/environment-panel-state` import.
2. In `EnvironmentPanelSurface`, delete `const widthRef = React.useRef(width);` (line 1284), `widthRef.current = width;` (line 1358), and everything from `const resizeBounds = …` to the end of `resizeWithKeyboard` (lines 1390-1445).
3. Replace the surface's whole `return (<aside …>…</aside>);` (lines 1447-1648) with the following. Each body is the old tabpanel's child, unchanged:

```tsx
  const viewBodies: Record<EnvironmentPanelTab, () => React.ReactNode> = {
    "new-tab": () => (
      <WorkspaceToolLauncher hasWorkspace={Boolean(active)} hasFolderAccess={Boolean(active?.folderPath && active.permission !== "none")} canOpenTerminal={terminal.canOpen} subagents={panel.subagentsEnabled} devices={panel.devicesEnabled} busy={panel.gitOperationBusy} onOpen={openTool} onQuickView={panel.showQuickView} onUrl={openBrowserUrl} />
    ),
    context: () => <ChatContextPanel details={panel.contextDetails} />,
    terminal: () => <TerminalSideTarget presented={presented && panel.tab === "terminal"} />,
    review: () => (
      <ReviewPanel
        workspace={active}
        chatId={panel.activeChat.chatId ?? undefined}
        active={presented && panel.tab === "review"}
        mode={panel.reviewMode}
        onModeChange={panel.openReview}
        onOpenFile={panel.openFile}
      />
    ),
    subagents: () => (
      <SubagentsPanel
        chatId={panel.subagents.chatId}
        workspaceId={panel.subagents.workspaceId}
        runs={panel.subagentViews}
        handoffSnapshots={panel.subagents.handoffSnapshots}
        selectedRunId={panel.selectedSubagentRunId}
        selectedRunSnapshot={
          panel.subagentViews.find((run) => run.runId === panel.selectedSubagentRunId)
            ?.snapshot
        }
        detailLoading={panel.subagentDetailLoading}
        detailError={panel.subagentDetailError}
        effectActivity={panel.subagentDetailEffects}
        onSelectedRunChange={panel.selectSubagent}
        onRetryDetail={panel.retrySubagentDetail}
        onStopRun={panel.stopSubagent}
        stopPendingRunIds={panel.subagentStopPendingRunIds}
        stopErrorsByRunId={panel.subagentStopErrorsByRunId}
        onDetailAnnouncement={panel.announceSubagentDetail}
        detailRequestVersion={panel.subagentFocusDetailVersion}
        compact={width < 620}
        active={presented && panel.tab === "subagents"}
        ownerReplacementFallbackFocusTarget={() => activeTabRef.current}
      />
    ),
    files: () => (
      <FilesPanel
        workspace={active}
        active={presented && panel.tab === "files"}
        requestedPath={activeFileRequest?.path ?? null}
        requestedPathKey={activeFileRequest?.id ?? 0}
        compact={width < 540}
        interactionBlockedReason={
          panel.gitOperationBusy ? "Wait for the current Git operation to finish." : null
        }
        onEditorStateChange={panel.reportEditorState}
      />
    ),
    browser: () =>
      active && (
        <React.Suspense fallback={null}>
          <BrowserPanel
            workspaceId={active.id}
            integratedTabs
            onStateChange={commitBrowserState}
            active={presented && panel.tab === "browser"}
            onDock={() => panel.showTools("browser")}
          />
        </React.Suspense>
      ),
    devices: () =>
      active && (
        <React.Suspense fallback={null}>
          <DevicesPanel
            workspaceId={active.id}
            chatId={panel.activeChat.chatId ?? undefined}
            active={presented && panel.tab === "devices"}
            compact={width < 540}
            selected={devices.selected}
            floating={devices.floating}
            onOpened={(session) => devices.opened(session)}
            onClosed={(session) => devices.dismiss(deviceTabKey(session))}
            onFloat={(session) => {
              devices.float(deviceTabKey(session));
              panel.closeTools();
            }}
            onDock={(session) => {
              if (chatId) deviceWorkspace.setFloating(chatId, null);
              devices.select(deviceTabKey(session));
            }}
          />
        </React.Suspense>
      ),
  };
  const views: WorkbenchView[] = environmentPanelViewOrder(
    panel.subagentsEnabled,
    panel.devicesEnabled,
  ).map((id) => ({ id, render: viewBodies[id] }));

  return (
    <WorkbenchPanel
      id="environment-panel"
      label="Environment work surface"
      resizeLabel="Resize environment panel"
      open={fullOpen}
      presented={presented}
      inline={inline}
      width={width}
      containerWidth={containerWidth}
      resizing={resizing}
      onResizingChange={setResizing}
      onWidthChange={setWidth}
      onWidthCommit={persistWidth}
      onActivate={() => panel.activateSurface("tools")}
      surfaceRef={surfaceRef}
      activeTabRef={activeTabRef}
      views={views}
      selectedViewId={panel.tab}
      tabs={decoratedTabs}
      idPrefix="environment"
      tabListLabel="Environment views"
      busy={panel.gitOperationBusy}
      onSelectTab={selectStripTab}
      onCloseTab={closeStripTab}
      newTab={{ label: "New workspace tab", onOpen: () => openTool("new-tab") }}
      closeLabel="Close environment panel"
      closeTitle="Close workspace panel"
      onClose={panel.closeTools}
    />
  );
```

4. `WorkbenchTabStrip` is no longer imported here; the shell renders it. `surfaceRef` stays `React.useRef<HTMLElement | null>(null)`. The focus effects (lines 1360-1388) stay in the surface unchanged, because the Subagents heading hand-off is workspace-specific.

- [ ] **Step 6: Replace the invalidated source-grep lines**

In `renderer/components/environment-subagents-contract.test.ts`, delete these four lines and nothing else:

```ts
  assert.match(environment, /data-surface-mode=\{inline \? "tools-pinned" : "tools-floating"\}/u);
```
```ts
  assert.match(environment, /\{panel\.subagentsEnabled \? \(\s*<div/u);
  assert.match(environment, /id="environment-subagents-panel"/u);
  assert.match(environment, /hidden=\{panel\.tab !== "subagents"\}/u);
```

They described markup that now lives in the shell. The behaviour they guarded is now tested directly: the surface mode in "the shell pins beside the content…", panel ids, labelling and hidden state in "a non-workspace tab set renders and toggles…", and Subagents mounting only when enabled in "the tools surface mounts workspace views…". Do not add new `assert.match` lines. The remaining lines of those tests still match, because the subagents body keeps `active={presented && panel.tab === "subagents"}`, `compact={width < 620}` and `ownerReplacementFallbackFocusTarget={() => activeTabRef.current}` verbatim.

- [ ] **Step 7: Run the focused suites**

Run:
```bash
npx tsx --test renderer/components/workbench-panel.test.tsx renderer/lib/environment-panel-state.test.ts renderer/lib/environment-panel-layout.test.ts
npm run test:subagents
npm run test:devices
npm run test:browser
npx tsc --noEmit
npm run lint
```
Expected: all PASS. That covers 12 workbench tests, the new view-order test, and the unchanged contract tests in `test:subagents`.

- [ ] **Step 8: Run the Electron specs for the panel**

Run:
```bash
npm run type-check:e2e && npm run build
npx playwright test tests/e2e/workspace-panel.spec.ts tests/e2e/environment-focus.spec.ts tests/e2e/chat-top-bar.spec.ts tests/e2e/browser.spec.ts tests/e2e/chat-shell-interactions.spec.ts tests/e2e/studio-foundation.spec.ts tests/e2e/environment-devices-tab.spec.ts tests/e2e/environment-devices-stream.spec.ts tests/e2e/environment-devices-features.spec.ts tests/e2e/environment-devices-agent.spec.ts tests/e2e/environment-devices-android.spec.ts --config=playwright.config.ts --fail-on-flaky-tests
```
Expected: all PASS, including Task 1's characterization test. A failure means the move changed behaviour. Fix the move, never the spec. Per AGENTS.md, a spec that fails and then passes on rerun is still a bug: record it in the PR description.

- [ ] **Step 9: Commit**

```bash
git add renderer/components/workbench-panel.tsx renderer/components/workbench-panel.test.tsx renderer/lib/environment-panel-state.ts renderer/lib/environment-panel-state.test.ts renderer/components/environment-panel.tsx renderer/components/environment-subagents-contract.test.ts
git commit -m "Workbench: extract WorkbenchPanel and mount the workspace tab set through it"
```

---

### Task 5: Docs, memory and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` (§8 Shell), `docs/plans/README.md`
- Create: `.memory/workbench-shell.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the record C2 starts from.

- [ ] **Step 1: Record the shell in the spec**

In §8, under the **Shell** bullet, add a sub-bullet:

> - Implemented in C1 as `WorkbenchPanel` (`renderer/components/workbench-panel.tsx`). It is controlled. Tabs (`WorkbenchTab`: `id`, `viewId`, `label`, `icon?`, `selected`, `closable?`, rename/wrap hooks) and views (`WorkbenchView`: `id`, `render({ presented, selected, width })`) are separate lists, because several strip tabs can share one view. `newTab` is the launcher hook point; without it there is no "+". The open state, Quick View, Escape and suppression stay in `EnvironmentPanelProvider`/`EnvironmentWorkbench`, so the `environment.toggle` shortcut and the persisted open bit apply to any tab set mounted there.

- [ ] **Step 2: Update the plan index**

In `docs/plans/README.md`, find the row that starts `- [Bot chat activity, Bots sidebar and side panel]`, which slice A adds. In it, change `C1 workbench shell extraction` to `C1 workbench shell extraction ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-c1-workbench-shell.md))`. If slice A has not landed and the row is missing, add this row under "Active and partial", after the Bot memory entry:

```markdown
- [Bot chat activity, Bots sidebar and side panel](../superpowers/specs/2026-10-14-bot-chat-activity-design.md) — Active (2026-10-14). Five stacked slices: A quick fixes ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-a-quick-fixes.md)), B quiet status line + per-Bot Chat activity setting, C1 workbench shell extraction ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-c1-workbench-shell.md)), C2 Bots-only sidebar + Bot side panel (stacked on C1), D phones (Remote revision 30, `bot-activity-v1`).
```

- [ ] **Step 3: Write project memory**

Create `.memory/workbench-shell.md`:

```markdown
# Workbench shell (Bot chat activity slice C1) — 2026-10-14

- `renderer/components/workbench-panel.tsx` holds `useWorkbenchWidth(storageKey)`, `WorkbenchTabStrip` and `WorkbenchPanel`. The shell is controlled and workspace-agnostic. It always renders `data-environment-surface="tools"`, so Escape, focus restoration and `activateSurface` in `EnvironmentWorkbench` cover any tab set.
- Tabs vs views: `WorkbenchTab` (strip entries; browser pages and device viewers are many tabs over one view) and `WorkbenchView` (`render({ presented, selected, width })`, all mounted, `hidden` unless selected). Ids are `${idPrefix}-${viewId}-tab` / `-panel`.
- The workspace tab set is still `EnvironmentPanelSurface` in `environment-panel.tsx`. It maps open tabs to `WorkbenchTab`s (device rename and context menu via `onRename`/`editor`/`wrap`/`dataAttributes`) and bodies to views in `environmentPanelViewOrder(...)` order. The focus-on-open and Subagents heading hand-off effects stay there.
- Open state, Quick View, persistence keys (`aiden-agent.environment.*`, `aiden-agent.quick-view.open`) and the `environment.toggle` handler (root-view) did not move. Width is still `aiden-agent.environment.width`, parsed by `storedWorkbenchWidth`.
- Tests: `renderer/components/workbench-panel.test.tsx` (strip and a test-only Notes/Log consumer: toggle, covered, keyboard resize clamp + persistence, pinned/floating), `environment-panel-state.test.ts` (view order), `environment-panel-layout.test.ts` (stored width). e2e `workspace-panel.spec.ts` pins relaunch persistence and the `app:command` toggle. Four source-grep lines in `environment-subagents-contract.test.ts` were replaced by these.
- For C2: the toggle (`toggleTools`) dispatches `toggle-tools` with `new-tab`, which appends a launcher to the workspace's open tabs. A Bot-route toggle must not reuse it blindly. The shell has no focus-on-open of its own.
```

- [ ] **Step 4: Run every affected suite**

```bash
npx tsc --noEmit
npm run lint
npm run test:ci-policy
npm run test:subagents
npm run test:devices
npm run test:browser
npm run test:command-system
npm run test:settings-design
npm run test:linux-contracts
npm test
```
Expected: all PASS. `npm test` runs the CI lanes, which include `test:serial` and so `workbench-panel.test.tsx`, `environment-panel-layout.test.ts` and `dialog-motion-contract.test.ts`. Also confirm Task 4 Step 8's Playwright run is green on the final head.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md docs/plans/README.md .memory/workbench-shell.md
git commit -m "Docs: record the workbench shell for Bot chat activity C1"
```
