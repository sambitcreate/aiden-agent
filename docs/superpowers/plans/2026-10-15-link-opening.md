# Link Opening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every link a user clicks in Aiden goes through one router. The router asks once (Aiden browser or system browser, with "Remember my choice"), then follows the saved preference, which can be changed in Settings → Links.

**Architecture:**
- **Renderer decides.** A pure function, `resolveLinkOpen`, turns a click into `browser | external | ask | file | null`.
- **One provider acts.** `LinkOpenerProvider` owns the document click and contextmenu listeners, the first-click dialog, the right-click menu, and the fallback to the system browser.
- **Main process.** It keeps the preference in the existing browser defaults file and gets three workspace-free IPC channels: read the preference, write it, and open externally.
- **Tab reuse.** `open_link` reuses an open tab with the same URL.
- **Pages inside the Aiden browser.** `target=_blank` opens a new tab instead of replacing the page.

**Tech Stack:** Electron (main and WebContentsView), React 19, TypeScript, `node:test` via `tsx`, Testing Library with the `installBotTestIpc` DOM harness, Playwright e2e.

**Spec:** [`docs/superpowers/specs/2026-10-15-link-opening-design.md`](../specs/2026-10-15-link-opening-design.md)

## Global Constraints

- **Preference values** are `"ask" | "browser" | "external"`, default `"ask"`.
  - Migration: legacy `linkTarget: "external"` becomes `"external"`; anything else becomes `"ask"`.
- **Loopback hosts always open in the Aiden browser with no prompt:** `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`.
- **Cmd/Ctrl-click never prompts.** It maps `browser → external`, `external → browser`, `ask → external`.
- **Remember my choice** is checked by default. Its hint reads "You can change this in Settings → Links."
- **Dialog copy.**
  - Title "Open this link?" with the host as the description.
  - Buttons: "Open in Aiden browser", "Open in system browser", "Copy link".
  - Escape opens nothing.
- **Always external, no prompt:**
  - `mailto:`;
  - anchors with `data-link-target="external"`;
  - any click while the browser panel can't show (no workspace, Settings, Bots, Studio, remote host, onboarding).
- **Always prompt, no Remember checkbox:** aiden-ui visual links and restricted-Markdown links. This includes routes without the panel, where the prompt offers only the system browser, so model-generated links never open without the owner's click.
- **External opens** go only through `browser:open-external`. It accepts `http`/`https` with a hostname and no credentials, or `mailto:`; everything else is rejected.
- **No new network calls, no onboarding step, no mobile or Remote protocol changes, no CLI changes.**
- **UI rules.**
  - Review `GUI.md`, `docs/design-guide.md`, `docs/settings-design-system.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before the UI tasks.
  - Use semantic tokens only.
  - No focus ring on text inputs; keep `focus-visible` on buttons and the checkbox.
  - Use the shared squircle button treatment from the `ui.tsx` `Button`.
- **Test rules (AGENTS.md).**
  - No `readFileSync` source-grep tests and no tautological tests.
  - Register each new test file in `package.json` and `scripts/ci-test-registry.json`, then run `npm run test:ci-policy`.

## Review Focus

1. **Settings-route links.** A link clicked on Settings or Bots, where `EnvironmentWorkbench` is unmounted or suppressed, must open in the system browser and create no hidden tab. Pinned by the Task 5 "unavailable surface" test.
2. **Choice saved, then IPC fails.** If the user picks Aiden with Remember checked and `browser:command` rejects (tab limit, owner window gone), the link must still open, in the system browser with a toast. The preference stays saved. Pinned by the Task 5 fallback test.
3. **Model-generated link on a panel-less route.** An aiden-ui visual on the Bots page must still prompt, offering only the system browser. Pinned by the Task 3 router test and the Task 4 dialog test.
4. **Malformed or hostile hrefs.** `javascript:`, `file:`, `http://user:pass@host`, `https://` with no host, `//cdn`, `#anchor` and `/route` are never opened. Main also rejects them. Pinned by the Task 1 `externalUrl` tests and the Task 3 router tests.
5. **Modified clicks pass through untouched.** Alt, Shift, middle-click, `download` anchors and already `defaultPrevented` clicks are ignored, so app navigation and save-as keep working. Pinned by the Task 5 test.
6. **Old preference files.** A saved `{ linkTarget: "browser" }` must load as `ask` and must not wipe the user's other browser defaults. Pinned by the Task 1 `savedLinkOpening` tests and the Task 2 migration step.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/shared/browser.ts` (modify) | `BrowserLinkOpening` type and guard; `BrowserDefaults.linkOpening`; `open_link` without `alternateTarget` |
| `main/services/browser/core.ts` (modify) | Pure helpers: `savedLinkOpening`, `externalUrl`, `sameBrowserPage` |
| `main/services/browser/service.ts` (modify) | Migration, validation, preference getter and setter, tab reuse, `target=_blank` → new tab |
| `main/handlers/browser.ts` (modify) | `browser:link-preference`, `browser:set-link-preference`, `browser:open-external` |
| `main/index.ts` (modify) | `openExternalUrl` reuses `externalUrl` |
| `renderer/lib/ipc.ts` (modify) | `browserApi.linkPreference / setLinkPreference / openExternal` |
| `renderer/lib/browser-link-routing.ts` (create; replaces `browser-links.ts`) | Pure router `resolveLinkOpen` and `isLoopbackHost` |
| `renderer/components/link-open-dialog.tsx` (create) | First-click dialog |
| `renderer/lib/link-opener.tsx` (create; replaces `use-browser-links.ts`) | Provider: listeners, dialog, context menu, fallback, `openLink`, `useBrowserSurface` |
| `renderer/components/settings/links-settings.tsx` (create) | Settings → Links |
| `renderer/components/browser-settings.tsx` (modify) | Three-option select in the panel sheet |
| Callers (modify) | `chat-pull-requests.tsx`, `chat-top-bar.tsx`, `aiden-ui-block.tsx`, `markdown.tsx`, `terminal-drawer.tsx`, two auth anchors |

---

### Task 1: Shared type and pure core helpers

**Files:**
- Modify: `renderer/shared/browser.ts` (around lines 40, 177 and 322)
- Modify: `main/services/browser/core.ts`
- Test: `main/services/browser/core.test.ts` (extend)

**Interfaces:**
- Produces, in `renderer/shared/browser.ts`:
  - `type BrowserLinkOpening = "ask" | "browser" | "external"`
  - `isBrowserLinkOpening(value: unknown): value is BrowserLinkOpening`
  - `BrowserDefaults.linkOpening: BrowserLinkOpening`, which replaces `linkTarget`
  - `BrowserCommand` `open_link` is now `{ action: "open_link"; url: string }`
- Produces, in `core.ts`:
  - `savedLinkOpening(saved: Record<string, unknown>): BrowserLinkOpening`
  - `externalUrl(value: unknown): string`, which throws `Error("This link can't be opened outside Aiden.")`
  - `sameBrowserPage(a: string, b: string): boolean`

- [ ] **Step 1: Write the failing tests** (append to `main/services/browser/core.test.ts`, reusing its existing imports and adding the three new names)

```ts
test("saved link opening keeps a valid choice and migrates the legacy target", () => {
  assert.equal(savedLinkOpening({ linkOpening: "browser" }), "browser");
  assert.equal(savedLinkOpening({ linkOpening: "external", linkTarget: "browser" }), "external");
  assert.equal(savedLinkOpening({ linkTarget: "external" }), "external");
  // The old "browser" default was never chosen by the user, so they get the prompt.
  assert.equal(savedLinkOpening({ linkTarget: "browser" }), "ask");
  assert.equal(savedLinkOpening({}), "ask");
  assert.equal(savedLinkOpening({ linkOpening: "sometimes" }), "ask");
});

test("external URLs allow only web pages and mail", () => {
  assert.equal(externalUrl("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(externalUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(externalUrl("mailto:hi@example.com"), "mailto:hi@example.com");
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "ftp://example.com",
    "not a url",
    "",
    42,
    null,
    `https://example.com/${"a".repeat(9000)}`,
  ])
    assert.throws(() => externalUrl(bad), /can't be opened outside Aiden/, String(bad).slice(0, 40));
});

test("same browser page compares normalized URLs", () => {
  assert.equal(sameBrowserPage("https://Example.com", "https://example.com/"), true);
  assert.equal(sameBrowserPage("https://example.com/a", "https://example.com/b"), false);
  assert.equal(sameBrowserPage("https://example.com/#x", "https://example.com/#y"), false);
  assert.equal(sameBrowserPage("about:blank", "nope"), false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test main/services/browser/core.test.ts`
Expected: FAIL with `savedLinkOpening` / `externalUrl` / `sameBrowserPage` not exported.

- [ ] **Step 3: Implement the shared type** (`renderer/shared/browser.ts`)

```ts
export type BrowserLinkOpening = "ask" | "browser" | "external";
const BROWSER_LINK_OPENINGS: readonly string[] = ["ask", "browser", "external"];
export function isBrowserLinkOpening(value: unknown): value is BrowserLinkOpening {
  return typeof value === "string" && BROWSER_LINK_OPENINGS.includes(value);
}
```

Then make three edits in the same file:
- In `BrowserDefaults`, replace `linkTarget: "browser" | "external";` with `linkOpening: BrowserLinkOpening;`.
- In `DEFAULT_BROWSER_SETTINGS`, replace `linkTarget: "browser",` with `linkOpening: "ask",`.
- In the `BrowserCommand` union, change the member to `{ action: "open_link"; url: string }`.

- [ ] **Step 4: Implement the core helpers** (`main/services/browser/core.ts`; import the type and guard from `../../../renderer/shared/browser.js` alongside the existing imports)

```ts
/** Reads the saved link preference, migrating the pre-"ask" `linkTarget`. */
export function savedLinkOpening(saved: Record<string, unknown>): BrowserLinkOpening {
  if (isBrowserLinkOpening(saved.linkOpening)) return saved.linkOpening;
  return saved.linkTarget === "external" ? "external" : "ask";
}

/** Validates a URL the user asked to open in the system browser. */
export function externalUrl(value: unknown): string {
  const refuse = () => new Error("This link can't be opened outside Aiden.");
  if (typeof value !== "string" || !value || value.length > 8_192) throw refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  if (url.protocol === "mailto:") return url.href;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw refuse();
  return url.href;
}

export function sameBrowserPage(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx tsx --test main/services/browser/core.test.ts`
Expected: PASS. `npm run typecheck` (or `npx tsc --noEmit -p .`) will now report the remaining `linkTarget` / `alternateTarget` users. Task 2 and Task 3 fix them, so don't commit until the typecheck is clean at the end of Task 2.

---

### Task 2: Service, IPC, and the panel settings sheet

**Files:**
- Modify: `main/services/browser/service.ts`. Line numbers are as of `f1f416c2a`:
  - `load` around line 227
  - window-open handler around lines 720-750
  - `open_link` around line 1932
  - `validDefaults` around line 1414
- Modify: `main/handlers/browser.ts`
- Modify: `main/index.ts:1142-1155` (`openExternalUrl`)
- Modify: `renderer/lib/ipc.ts:879` (`browserApi`)
- Modify: `renderer/components/browser-settings.tsx:69`
- Modify: `tests/e2e/browser.spec.ts:272`

**Interfaces:**
- Consumes (Task 1): `savedLinkOpening`, `externalUrl`, `sameBrowserPage`, `isBrowserLinkOpening`, `BrowserLinkOpening`.
- Produces, on `BrowserService`:
  - `linkOpening(): BrowserLinkOpening`
  - `setLinkOpening(value: unknown): BrowserLinkOpening`
- Produces IPC:
  - `browser:link-preference` → `BrowserLinkOpening`
  - `browser:set-link-preference(value)` → `BrowserLinkOpening`
  - `browser:open-external(url)` → `void`
- Produces, in the renderer:
  - `browserApi.linkPreference(): Promise<BrowserLinkOpening>`
  - `browserApi.setLinkPreference(value: BrowserLinkOpening): Promise<BrowserLinkOpening>`
  - `browserApi.openExternal(url: string): Promise<void>`
- Produces, in `open_link`: always the Aiden browser. It reuses a same-URL tab in that workspace, shows it, and returns `{ tabId }`.

- [ ] **Step 1: Migrate on load.** In `load()`, replace the `saved.defaults` branch:

```ts
      if (saved.defaults && typeof saved.defaults === "object") {
        const legacy = saved.defaults as Record<string, unknown>;
        const { linkTarget: _legacyTarget, ...current } = legacy;
        this.defaults = this.validDefaults({
          ...(current as Partial<BrowserDefaults>),
          linkOpening: savedLinkOpening(legacy),
        });
      }
```

- [ ] **Step 2: Validate.** In `validDefaults`, replace the `linkTarget` check:

```ts
    if (!isBrowserLinkOpening(result.linkOpening))
      throw new Error("Invalid link opening preference.");
    delete (result as { linkTarget?: unknown }).linkTarget;
```

- [ ] **Step 3: Add the preference methods.** Add them next to `getState`. `save()` and `emitAll()` are the methods the `defaults` command already uses.

```ts
  linkOpening(): BrowserLinkOpening {
    return this.defaults.linkOpening;
  }

  setLinkOpening(value: unknown): BrowserLinkOpening {
    if (!isBrowserLinkOpening(value)) throw new Error("Invalid link opening preference.");
    this.defaults = { ...this.defaults, linkOpening: value };
    this.save();
    this.emitAll();
    return value;
  }
```

- [ ] **Step 4: Reuse tabs in `open_link`**

```ts
      case "open_link": {
        const url = browserUrl(command.url);
        const existing = this.workspace(workspaceId).state.tabs.find((candidate) =>
          sameBrowserPage(candidate.url, url),
        );
        const live = existing ? this.tabs.get(existing.id) : undefined;
        if (live) {
          this.activateTab(live);
          this.emit(workspaceId);
          // `select` only emits `show` for agents; a user's link click must bring the panel forward.
          if (!live.state.floating)
            this.emit(workspaceId, { type: "show", workspaceId, tabId: live.state.id });
          result.tabId = live.state.id;
        } else {
          const created = await this.create(workspaceId, url, undefined, true);
          result.tabId = created.state.id;
        }
        break;
      }
```

- [ ] **Step 5: Handle `target=_blank` inside the Aiden browser.** In `setWindowOpenHandler`, replace the trailing `linkTarget` branch. Keep the OAuth popup branch above it unchanged.

```ts
      if (this.defaults.linkOpening === "external") {
        void shell.openExternal(url);
        return { action: "deny" };
      }
      const workspaceId = tab.state.workspaceId;
      void this.create(workspaceId, url, tab.state.profileId, true).catch(() => {
        // At the tab limit (or with no owner window) load it in place, as before.
        tab.navigationCommand = undefined;
        void wc.loadURL(url).catch(() => {});
      });
      return { action: "deny" };
```

- [ ] **Step 6: Add the IPC handlers.** In `main/handlers/browser.ts`, add these inside `registerBrowserHandlers`. Import `shell` from `electron` (or from `../platform.js` if it re-exports it; check that file first) and `externalUrl` from `../services/browser/core.js`.

```ts
  ipcMain.handle("browser:link-preference", (event) => {
    rendererDocumentOwner(event, () => new Error("Link settings require the active application document."));
    return browserService.linkOpening();
  });
  ipcMain.handle("browser:set-link-preference", (event, value: unknown) => {
    rendererDocumentOwner(event, () => new Error("Link settings require the active application document."));
    return browserService.setLinkOpening(value);
  });
  ipcMain.handle("browser:open-external", async (event, value: unknown) => {
    rendererDocumentOwner(event, () => new Error("Opening links requires the active application document."));
    await shell.openExternal(externalUrl(value));
  });
```

- [ ] **Step 7: Share validation with the main-window guard.** In `main/index.ts`, rewrite `openExternalUrl` so the window guards and the IPC accept the same URLs:

```ts
function openExternalUrl(value: string): void {
  try {
    void shell.openExternal(externalUrl(value));
  } catch {
    logger.warn("main", "Blocked invalid external URL", { value });
  }
}
```

The one behavior change: `http://user:pass@host` is now blocked here too, which is the point.

- [ ] **Step 8: Extend the renderer bridge** (`renderer/lib/ipc.ts`, inside `browserApi`)

```ts
  linkPreference: () =>
    invoke<import("../shared/browser").BrowserLinkOpening>("browser:link-preference"),
  setLinkPreference: (value: import("../shared/browser").BrowserLinkOpening) =>
    invoke<import("../shared/browser").BrowserLinkOpening>("browser:set-link-preference", value),
  openExternal: (url: string) => invoke<void>("browser:open-external", url),
```

- [ ] **Step 9: Update the panel settings sheet.** In `renderer/components/browser-settings.tsx:69`, the select becomes three options and writes through the new setter, which also refreshes Settings → Links via `emitAll`:

```tsx
          <select
            className="browser-select"
            value={state.defaults.linkOpening}
            onChange={(event) =>
              void browserApi
                .setLinkPreference(event.target.value as BrowserLinkOpening)
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Couldn't save this setting."),
                )
            }
          >
            <option value="ask">Ask each time</option>
            <option value="browser">Aiden browser</option>
            <option value="external">System browser</option>
          </select>
```

Keep the existing label "Open links in". Import `browserApi`, `toast` and the type if the file doesn't already.

- [ ] **Step 10: Fix the existing e2e setup line.** In `tests/e2e/browser.spec.ts:272`, change `defaults: { linkTarget: "browser" }` to `defaults: { linkOpening: "browser" }`. The test's assertion still holds: an anchor click with preference `browser` makes a second tab, because the URL differs from the first tab. Task 8 adds the new e2e coverage.

- [ ] **Step 11: Typecheck and run the browser suite**

Run: `npm run typecheck && npm run test:browser`
Expected: the only remaining type errors are in `renderer/lib/browser-links.ts`, `use-browser-links.ts` and `terminal-drawer.tsx` (`alternateTarget`); Task 3 removes them. If you prefer a green commit here, temporarily drop `alternateTarget` from `browser-links.ts` in this task and let Task 3 delete the file.

- [ ] **Step 12: Commit**

```bash
git add renderer/shared/browser.ts main/services/browser/core.ts main/services/browser/core.test.ts main/services/browser/service.ts main/handlers/browser.ts main/index.ts renderer/lib/ipc.ts renderer/components/browser-settings.tsx tests/e2e/browser.spec.ts renderer/lib/browser-links.ts
git commit -m "Browser: link-opening preference with ask default, tab reuse, and external-open IPC"
```

---

### Task 3: Pure link router

**Files:**
- Create: `renderer/lib/browser-link-routing.ts`
- Create: `renderer/lib/browser-link-routing.test.ts`. The `test:browser` glob `renderer/lib/browser-*.test.ts` already picks it up.
- Delete: `renderer/lib/browser-links.ts`, `renderer/lib/browser-links.test.ts`. Port the old test's still-valid cases (relative `.html`/`.pdf`, `#`, `//`, other schemes) into the new file.

**Interfaces:**
- Produces:

```ts
export interface LinkModifiers { metaKey: boolean; ctrlKey: boolean }
export interface LinkRouteInput {
  href: string;
  modifiers: LinkModifiers;
  preference: BrowserLinkOpening;
  browserAvailable: boolean;
  forceExternal?: boolean;   // data-link-target="external"
  forcePrompt?: boolean;     // aiden-ui / restricted Markdown
}
export type LinkRoute =
  | { kind: "browser" | "external"; url: string }
  | { kind: "ask"; url: string; remember: boolean; inApp: boolean }
  | { kind: "file"; path: string };
export function resolveLinkOpen(input: LinkRouteInput): LinkRoute | null;
export function isLoopbackHost(hostname: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, resolveLinkOpen, type LinkRouteInput } from "./browser-link-routing";

const plain = { metaKey: false, ctrlKey: false };
const cmd = { metaKey: true, ctrlKey: false };
const route = (over: Partial<LinkRouteInput>) =>
  resolveLinkOpen({ href: "https://example.com/", modifiers: plain, preference: "ask", browserAvailable: true, ...over });

test("the preference decides a plain web link, and ask prompts with remember", () => {
  assert.deepEqual(route({ preference: "ask" }), { kind: "ask", url: "https://example.com/", remember: true, inApp: true });
  assert.deepEqual(route({ preference: "browser" }), { kind: "browser", url: "https://example.com/" });
  assert.deepEqual(route({ preference: "external" }), { kind: "external", url: "https://example.com/" });
});

test("cmd or ctrl flips the destination and never prompts", () => {
  assert.equal(route({ preference: "browser", modifiers: cmd })?.kind, "external");
  assert.equal(route({ preference: "external", modifiers: cmd })?.kind, "browser");
  assert.equal(route({ preference: "ask", modifiers: { metaKey: false, ctrlKey: true } })?.kind, "external");
});

test("loopback hosts open in Aiden whatever the preference, and cmd sends them out", () => {
  for (const href of ["http://localhost:5173/", "http://app.localhost/", "http://127.0.0.1:3000/x", "http://[::1]:8080/", "http://0.0.0.0:4000/"]) {
    assert.equal(route({ href, preference: "external" })?.kind, "browser", href);
    assert.equal(route({ href, preference: "ask" })?.kind, "browser", href);
    assert.equal(route({ href, preference: "ask", modifiers: cmd })?.kind, "external", href);
  }
  assert.equal(isLoopbackHost("localhost.example.com"), false);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
});

test("without a visible browser panel every web link goes out with no prompt", () => {
  assert.equal(route({ browserAvailable: false, preference: "browser" })?.kind, "external");
  assert.equal(route({ browserAvailable: false, href: "http://localhost:3000/" })?.kind, "external");
  assert.equal(route({ browserAvailable: false, href: "report.html" }), null);
});

test("explicitly external and mailto links skip the prompt", () => {
  assert.equal(route({ forceExternal: true, preference: "browser" })?.kind, "external");
  assert.deepEqual(route({ href: "mailto:hi@example.com" }), { kind: "external", url: "mailto:hi@example.com" });
});

test("model-generated links always prompt, without remember, unless cmd-clicked", () => {
  assert.deepEqual(route({ forcePrompt: true, preference: "browser" }), { kind: "ask", url: "https://example.com/", remember: false, inApp: true });
  assert.deepEqual(route({ forcePrompt: true, href: "http://localhost:3000/" }), { kind: "ask", url: "http://localhost:3000/", remember: false, inApp: true });
  // Without the panel the prompt still appears, offering only the system browser.
  assert.deepEqual(route({ forcePrompt: true, browserAvailable: false }), { kind: "ask", url: "https://example.com/", remember: false, inApp: false });
  assert.equal(route({ forcePrompt: true, preference: "browser", modifiers: cmd })?.kind, "external");
});

test("workspace HTML and PDF links preview in Aiden; everything else is left to the app", () => {
  assert.deepEqual(route({ href: "docs/My%20Report.html#top" }), { kind: "file", path: "docs/My Report.html" });
  assert.deepEqual(route({ href: "out.pdf?page=2" }), { kind: "file", path: "out.pdf" });
  assert.deepEqual(route({ href: "/abs/out.html" }), { kind: "file", path: "/abs/out.html" });
  for (const href of ["#section", "/settings", "//cdn.example.com/x", "javascript:alert(1)", "file:///etc/hosts", "notes.md", "https://", "https://user:pw@example.com/", "bad%zz.html"])
    assert.equal(route({ href }), null, href);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test renderer/lib/browser-link-routing.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { BrowserLinkOpening } from "../shared/browser";

// (interfaces exactly as in the Interfaces block above)

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function webUrl(href: string): URL | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function filePath(href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return null;
  const path = href.split(/[?#]/, 1)[0];
  if (!/\.(?:html?|pdf)$/i.test(path)) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

export function resolveLinkOpen(input: LinkRouteInput): LinkRoute | null {
  const { href, modifiers, preference, browserAvailable } = input;
  if (/^mailto:/i.test(href)) {
    try {
      return { kind: "external", url: new URL(href).href };
    } catch {
      return null;
    }
  }
  const url = webUrl(href);
  if (!url) {
    const path = browserAvailable ? filePath(href) : null;
    return path ? { kind: "file", path } : null;
  }
  const flip = modifiers.metaKey || modifiers.ctrlKey;
  if (input.forceExternal) return { kind: "external", url: url.href };
  if (input.forcePrompt)
    return flip
      ? { kind: "external", url: url.href }
      : { kind: "ask", url: url.href, remember: false, inApp: browserAvailable };
  if (!browserAvailable) return { kind: "external", url: url.href };
  const base: BrowserLinkOpening = isLoopbackHost(url.hostname) ? "browser" : preference;
  if (flip) return { kind: base === "external" ? "browser" : "external", url: url.href };
  if (base === "ask") return { kind: "ask", url: url.href, remember: true, inApp: true };
  return { kind: base, url: url.href };
}
```

Note: `filePath` keeps the old rule (only `//` is rejected). App routes like `/settings` are still ignored because they don't end in `.html`/`.htm`/`.pdf`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx tsx --test renderer/lib/browser-link-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete the old module** (`git rm renderer/lib/browser-links.ts renderer/lib/browser-links.test.ts`). Two files still import it. Keep them compiling until Tasks 5 and 6 rewire them:
  - In `use-browser-links.ts`, import `resolveLinkOpen` and open `kind: "browser"`/`"file"` routes with `browserApi.command` exactly as before, with preference `"browser"` and `browserAvailable: true`. Task 5 deletes this file.
  - In `terminal-drawer.tsx`, set `canActivateLink: (url) => resolveLinkOpen({ href: url, modifiers: { metaKey: false, ctrlKey: false }, preference: "browser", browserAvailable: true }) !== null`, and leave `onLinkActivate` for Task 6.

- [ ] **Step 6: Commit**

```bash
git add -A renderer/lib/browser-link-routing.ts renderer/lib/browser-link-routing.test.ts renderer/lib/browser-links.ts renderer/lib/browser-links.test.ts renderer/components/terminal-drawer.tsx
git commit -m "Browser: one pure router for link clicks (ask, loopback, cmd flip, forced surfaces)"
```

---

### Task 4: First-click dialog

**Files:**
- Create: `renderer/components/link-open-dialog.tsx`
- Create: `renderer/components/link-open-dialog.test.tsx`
- Modify: `package.json` `test:browser`: append `renderer/components/link-open-dialog.test.tsx`
- Modify: `scripts/ci-test-registry.json` only if `npm run test:ci-policy` asks for it. `test:browser` is already an isolated registry command, so the policy should accept the file through that script.

**Interfaces:**
- Produces:

```ts
export type LinkOpenChoice = { target: "browser" | "external"; remember: boolean };
export function LinkOpenDialog(props: {
  url: string | null;            // null = closed
  rememberable: boolean;         // false for aiden-ui / restricted Markdown
  inApp: boolean;                // false when the panel can't show: only the system browser is offered
  onChoose: (choice: LinkOpenChoice) => void;
  onCancel: () => void;
}): JSX.Element;
```

- [ ] **Step 1: Read the references.** Read `docs/chatgpt-desktop-ui-inspiration.md` (dialog section) and `docs/chatgpt-ui-element-specimen.html` (modal and checkbox), plus `Dialog` in `renderer/components/ui.tsx`. Confirm which props it takes for title, description, footer and size. Use `Dialog`'s own footer slot when it has one. Otherwise lay the buttons out the way `aiden-ui-block.tsx`'s current link dialog does.

- [ ] **Step 2: Write the failing test**

```tsx
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { LinkOpenDialog, type LinkOpenChoice } from "./link-open-dialog";

afterEach(cleanup);

function setup(rememberable = true, inApp = true) {
  const choices: LinkOpenChoice[] = [];
  let cancelled = 0;
  render(
    <LinkOpenDialog
      url="https://docs.example.com/guide?x=1"
      rememberable={rememberable}
      inApp={inApp}
      onChoose={(choice) => choices.push(choice)}
      onCancel={() => (cancelled += 1)}
    />,
  );
  return { choices, cancelled: () => cancelled };
}

test("shows the host and full URL and remembers by default", () => {
  installBotTestIpc();
  const { choices } = setup();
  const dialog = screen.getByRole("dialog", { name: "Open this link?" });
  assert.ok(dialog.textContent?.includes("docs.example.com"));
  assert.ok(dialog.textContent?.includes("https://docs.example.com/guide?x=1"));
  const remember = screen.getByRole("checkbox", { name: "Remember my choice" }) as HTMLInputElement;
  assert.equal(remember.checked, true);
  assert.ok(screen.getByText("You can change this in Settings → Links."));
  fireEvent.click(screen.getByRole("button", { name: "Open in Aiden browser" }));
  assert.deepEqual(choices, [{ target: "browser", remember: true }]);
});

test("unchecking remember and choosing the system browser reports a one-off choice", () => {
  installBotTestIpc();
  const { choices } = setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  assert.deepEqual(choices, [{ target: "external", remember: false }]);
});

test("model-generated links get no remember checkbox and Escape opens nothing", () => {
  installBotTestIpc();
  const { choices, cancelled } = setup(false);
  assert.equal(screen.queryByRole("checkbox"), null);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(choices.length, 0);
  assert.equal(cancelled(), 1);
});

test("without the panel only the system browser is offered", () => {
  installBotTestIpc();
  const { choices } = setup(false, false);
  assert.equal(screen.queryByRole("button", { name: "Open in Aiden browser" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  assert.deepEqual(choices, [{ target: "external", remember: false }]);
});

test("copy link copies the URL without choosing", async () => {
  installBotTestIpc();
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void written.push(text) } });
  const { choices } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await Promise.resolve();
  assert.deepEqual(written, ["https://docs.example.com/guide?x=1"]);
  assert.equal(choices.length, 0);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test renderer/components/link-open-dialog.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement.** Adapt the prop names to `Dialog`'s real API from Step 1.

```tsx
import * as React from "react";
import { Copy } from "lucide-react";
import { Button, Dialog, Text, toast } from "./ui";

export type LinkOpenChoice = { target: "browser" | "external"; remember: boolean };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LinkOpenDialog({
  url,
  rememberable,
  inApp,
  onChoose,
  onCancel,
}: {
  url: string | null;
  rememberable: boolean;
  inApp: boolean;
  onChoose: (choice: LinkOpenChoice) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = React.useState(true);
  React.useEffect(() => {
    if (url) setRemember(true);
  }, [url]);
  const choose = (target: LinkOpenChoice["target"]) =>
    onChoose({ target, remember: rememberable && remember });
  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Open this link?"
      description={url ? hostOf(url) : undefined}
    >
      <Text className="break-all text-muted-foreground select-text">{url}</Text>
      {rememberable ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0 accent-accent"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            aria-describedby="link-open-remember-hint"
          />
          <span>
            Remember my choice
            <Text id="link-open-remember-hint" className="text-muted-foreground">
              You can change this in Settings → Links.
            </Text>
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          className="mr-auto"
          onClick={() => {
            if (!url) return;
            void navigator.clipboard
              .writeText(url)
              .then(() => toast.success("Link copied."))
              .catch(() => toast.error("Couldn't copy the link."));
          }}
        >
          <Copy aria-hidden="true" className="size-4" />
          Copy link
        </Button>
        <Button variant={inApp ? "secondary" : undefined} onClick={() => choose("external")} autoFocus={!inApp}>
          Open in system browser
        </Button>
        {inApp ? (
          <Button onClick={() => choose("browser")} autoFocus>
            Open in Aiden browser
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
```

The label wraps the input but the visible name must be exactly "Remember my choice". If Testing Library includes the hint text in the accessible name, move the hint out of the `<label>` and keep `aria-describedby`.

- [ ] **Step 5: Run the test, then the browser suite**

Run: `npx tsx --test renderer/components/link-open-dialog.test.tsx && npm run test:browser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/link-open-dialog.tsx renderer/components/link-open-dialog.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Browser: first-click link dialog with remember-my-choice"
```

---

### Task 5: `LinkOpenerProvider`: listeners, menu, fallback, and panel availability

**Files:**
- Create: `renderer/lib/link-opener.tsx`
- Create: `renderer/lib/link-opener.test.tsx`; append it to `test:browser` in `package.json`
- Delete: `renderer/lib/use-browser-links.ts`
- Modify: `renderer/components/environment-panel.tsx`:
  - line 296: remove `useBrowserLinks(activeId)` and its import;
  - `EnvironmentWorkbench` around line 1750: register the surface;
  - `EnvironmentPanelProvider`: wrap its children in `LinkOpenerProvider`.

**Interfaces:**
- Consumes:
  - from Task 2: `browserApi.linkPreference`, `setLinkPreference`, `openExternal`, `command`, `onEvent`;
  - from Task 3: `resolveLinkOpen`;
  - from Task 4: `LinkOpenDialog`.
- Produces:

```ts
export interface OpenLinkOptions {
  modifiers?: { metaKey: boolean; ctrlKey: boolean };
  workspaceId?: string | null;   // defaults to the active workspace
  forcePrompt?: boolean;
  forceExternal?: boolean;
}
export function LinkOpenerProvider(props: React.PropsWithChildren<{ workspaceId: string | null }>): JSX.Element;
export function useLinkOpener(): {
  openLink: (href: string, options?: OpenLinkOptions) => boolean; // true if handled
  canOpen: (href: string) => boolean;
  preference: BrowserLinkOpening;
};
/** Mount while the browser panel can actually be shown on this route. */
export function useBrowserSurface(active: boolean): void;
```

`LinkOpenerProvider` is mounted app-wide through `EnvironmentPanelProvider` in `renderer/main/root-view.tsx`, so Settings, Bots and onboarding are inside it. They just never register a browser surface. `useLinkOpener()` outside any provider (isolated component tests, detached windows) returns a fallback that sends `http(s)`/`mailto` to `browserApi.openExternal` and returns `false` for everything else.

- [ ] **Step 1: Write the failing tests**

```tsx
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { LinkOpenerProvider, useBrowserSurface } from "./link-opener";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function Surface() {
  useBrowserSurface(true);
  return null;
}

function app({ surface = true, href = "https://example.com/" } = {}) {
  return (
    <LinkOpenerProvider workspaceId="ws-1">
      {surface ? <Surface /> : null}
      <a href={href}>link</a>
      <a href="https://accounts.example.com/" data-link-target="external">sign in</a>
      <a href="/settings">route</a>
    </LinkOpenerProvider>
  );
}

function ipc(preference: string, overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  return installBotTestIpc({
    "browser:link-preference": () => preference,
    "browser:set-link-preference": (value) => value,
    "browser:open-external": () => undefined,
    "browser:command": () => ({ tabId: "tab-1" }),
    ...overrides,
  });
}
const sent = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((call) => call.channel !== "browser:link-preference");

test("first click asks; remembered Aiden choice is saved and opens in the panel", async () => {
  const calls = ipc("ask");
  render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  fireEvent.click(await screen.findByRole("button", { name: "Open in Aiden browser" }));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:set-link-preference", args: ["browser"] },
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);
  // The saved choice applies to the next click with no prompt.
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
});

test("without a browser surface (Settings, Bots) links go out with no prompt and no tab", async () => {
  const calls = ipc("browser");
  render(app({ surface: false }));
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/"] }]);
});

test("a failed in-app open falls back to the system browser", async () => {
  const calls = ipc("browser", { "browser:command": () => { throw new Error("Close a browser tab before opening more than 24."); } });
  render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls).map((call) => call.channel), ["browser:command", "browser:open-external"]);
});

test("loopback opens in Aiden even when the preference is external; auth links go out", async () => {
  const calls = ipc("external");
  render(app({ href: "http://localhost:5173/" }));
  await flush();
  fireEvent.click(screen.getByText("link"));
  fireEvent.click(screen.getByText("sign in"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "http://localhost:5173/" }] },
    { channel: "browser:open-external", args: ["https://accounts.example.com/"] },
  ]);
});

test("app routes and modified clicks are left alone", async () => {
  const calls = ipc("browser");
  render(app());
  await flush();
  for (const init of [{ altKey: true }, { shiftKey: true }, { button: 1 }])
    fireEvent.click(screen.getByText("link"), init);
  const route = new MouseEvent("click", { bubbles: true, cancelable: true });
  screen.getByText("route").dispatchEvent(route);
  await flush();
  assert.equal(route.defaultPrevented, false);
  assert.deepEqual(sent(calls), []);
});

test("right-click offers both destinations and copy", async () => {
  const calls = ipc("ask");
  render(app());
  await flush();
  fireEvent.contextMenu(screen.getByText("link"));
  const item = await screen.findByRole("menuitem", { name: "Open in system browser" });
  assert.ok(screen.getByRole("menuitem", { name: "Open in Aiden browser" }));
  assert.ok(screen.getByRole("menuitem", { name: "Copy link" }));
  fireEvent.click(item);
  await flush();
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/"] }]);
});
```

If Radix's `DropdownMenu` needs pointer events the harness lacks, open the menu with `fireEvent.pointerDown` / `keyDown` the way `chat-pull-requests` tests do (`git grep -n "menuitem" renderer/**/*.test.tsx`).

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test renderer/lib/link-opener.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `renderer/lib/link-opener.tsx`**

```tsx
import * as React from "react";
import { browserApi } from "./ipc";
import { resolveLinkOpen, type LinkRoute } from "./browser-link-routing";
import type { BrowserLinkOpening } from "../shared/browser";
import { LinkOpenDialog, type LinkOpenChoice } from "../components/link-open-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "../components/ui";

export interface OpenLinkOptions {
  modifiers?: { metaKey: boolean; ctrlKey: boolean };
  workspaceId?: string | null;
  forcePrompt?: boolean;
  forceExternal?: boolean;
}

interface LinkOpener {
  openLink: (href: string, options?: OpenLinkOptions) => boolean;
  canOpen: (href: string) => boolean;
  preference: BrowserLinkOpening;
  registerSurface: () => () => void;
}

const NO_MODIFIERS = { metaKey: false, ctrlKey: false };
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function openExternal(url: string): void {
  void browserApi.openExternal(url).catch((error: unknown) => toast.error(message(error, "Couldn't open this link.")));
}

const FALLBACK: LinkOpener = {
  // Only for components rendered outside the app-wide provider (isolated tests, detached windows).
  // forcePrompt callers are always inside the provider, so it is ignored here.
  openLink: (href, options) => {
    const route = resolveLinkOpen({ href, modifiers: options?.modifiers ?? NO_MODIFIERS, preference: "external", browserAvailable: false });
    if (route?.kind !== "external") return false;
    openExternal(route.url);
    return true;
  },
  canOpen: (href) => resolveLinkOpen({ href, modifiers: NO_MODIFIERS, preference: "external", browserAvailable: false }) !== null,
  preference: "external",
  registerSurface: () => () => undefined,
};

const LinkOpenerContext = React.createContext<LinkOpener>(FALLBACK);

export function useLinkOpener(): Omit<LinkOpener, "registerSurface"> {
  return React.useContext(LinkOpenerContext);
}

export function useBrowserSurface(active: boolean): void {
  const { registerSurface } = React.useContext(LinkOpenerContext);
  React.useEffect(() => (active ? registerSurface() : undefined), [active, registerSurface]);
}

type Pending = { url: string; workspaceId: string | null; remember: boolean; inApp: boolean };
type Menu = { url: string; x: number; y: number; web: boolean; workspaceId: string | null };

export function LinkOpenerProvider({ workspaceId, children }: React.PropsWithChildren<{ workspaceId: string | null }>) {
  const [preference, setPreference] = React.useState<BrowserLinkOpening>("ask");
  const [surfaces, setSurfaces] = React.useState(0);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [menu, setMenu] = React.useState<Menu | null>(null);
  const state = React.useRef({ preference, surfaces, workspaceId });
  state.current = { preference, surfaces, workspaceId };

  React.useEffect(() => {
    let live = true;
    void browserApi.linkPreference().then((value) => live && setPreference(value)).catch(() => undefined);
    const off = browserApi.onEvent((event) => {
      if (event.type === "state" && event.state.defaults) setPreference(event.state.defaults.linkOpening);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const openInBrowser = React.useCallback((target: string, url: string) => {
    void browserApi.command(target, { action: "open_link", url }).catch((error: unknown) => {
      toast.message(`${message(error, "The Aiden browser couldn't open this link.")} Opened it in your system browser.`);
      openExternal(url);
    });
  }, []);

  const perform = React.useCallback(
    (route: LinkRoute, target: string | null) => {
      if (route.kind === "external") openExternal(route.url);
      else if (route.kind === "ask")
        setPending({ url: route.url, workspaceId: target, remember: route.remember, inApp: route.inApp && Boolean(target) });
      else if (route.kind === "browser" && target) openInBrowser(target, route.url);
      else if (route.kind === "file" && target)
        void browserApi.command(target, { action: "open_file", path: route.path }).catch((error: unknown) =>
          toast.error(message(error, "Couldn't open this file.")),
        );
    },
    [openInBrowser],
  );

  const route = React.useCallback((href: string, options: OpenLinkOptions = {}) => {
    const { preference: current, surfaces: count, workspaceId: active } = state.current;
    const target = options.workspaceId === undefined ? active : options.workspaceId;
    const resolved = resolveLinkOpen({
      href,
      modifiers: options.modifiers ?? NO_MODIFIERS,
      preference: current,
      browserAvailable: Boolean(target) && count > 0,
      forcePrompt: options.forcePrompt,
      forceExternal: options.forceExternal,
    });
    return { resolved, target: target ?? null };
  }, []);

  const openLink = React.useCallback(
    (href: string, options?: OpenLinkOptions) => {
      const { resolved, target } = route(href, options);
      if (!resolved) return false;
      perform(resolved, target);
      return true;
    },
    [perform, route],
  );

  React.useEffect(() => {
    const anchorOf = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      return anchor instanceof HTMLAnchorElement && !anchor.hasAttribute("download") ? anchor : null;
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const anchor = anchorOf(event);
      if (!anchor) return;
      const handled = openLink(anchor.getAttribute("href") ?? "", {
        modifiers: event,
        forceExternal: anchor.dataset.linkTarget === "external",
      });
      if (handled) event.preventDefault();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const anchor = anchorOf(event);
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      const { resolved, target } = route(href, { forceExternal: anchor.dataset.linkTarget === "external" });
      if (!resolved || resolved.kind === "file") return;
      event.preventDefault();
      setMenu({ url: resolved.url, x: event.clientX, y: event.clientY, web: !resolved.url.startsWith("mailto:"), workspaceId: target && state.current.surfaces > 0 ? target : null });
    };
    document.addEventListener("click", onClick);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [openLink, route]);

  const registerSurface = React.useCallback(() => {
    setSurfaces((count) => count + 1);
    return () => setSurfaces((count) => count - 1);
  }, []);

  const choose = React.useCallback(
    (choice: LinkOpenChoice) => {
      const current = pending;
      setPending(null);
      if (!current) return;
      if (choice.remember) {
        setPreference(choice.target);
        void browserApi.setLinkPreference(choice.target).catch((error: unknown) =>
          toast.error(message(error, "Couldn't save your link preference.")),
        );
      }
      if (choice.target === "browser" && current.workspaceId) openInBrowser(current.workspaceId, current.url);
      else openExternal(current.url);
    },
    [openInBrowser, pending],
  );

  const value = React.useMemo<LinkOpener>(
    () => ({
      openLink,
      canOpen: (href) => route(href).resolved !== null,
      preference,
      registerSurface,
    }),
    [openLink, preference, registerSurface, route],
  );

  return (
    <LinkOpenerContext.Provider value={value}>
      {children}
      <LinkOpenDialog
        url={pending?.url ?? null}
        rememberable={pending?.remember ?? true}
        inApp={pending?.inApp ?? true}
        onChoose={choose}
        onCancel={() => setPending(null)}
      />
      <DropdownMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 0, height: 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {menu?.web ? (
            <DropdownMenuItem
              disabled={!menu.workspaceId}
              onSelect={() => menu.workspaceId && openInBrowser(menu.workspaceId, menu.url)}
            >
              Open in Aiden browser
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => menu && openExternal(menu.url)}>Open in system browser</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              menu &&
              void navigator.clipboard.writeText(menu.url).then(
                () => toast.success("Link copied."),
                () => toast.error("Couldn't copy the link."),
              )
            }
          >
            Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </LinkOpenerContext.Provider>
  );
}
```

Check two names against the real code before relying on them:
- **The state event shape.** Look at `BrowserEvent` in `renderer/shared/browser.ts` and at how `browser-panel.tsx` reads `defaults` from a state event. Use that exact discriminant and path.
- **The toast API.** Check `toast` in `ui.tsx` and use `toast.message` or `toast(...)`, whichever exists.

Add `lucide-react` icons to the menu items (`AppWindow`, `ExternalLink`, `Copy`) if neighboring menus use icons.

- [ ] **Step 4: Mount it**
  - In `EnvironmentPanelProvider` (environment-panel.tsx around line 296), delete `useBrowserLinks(activeId);` and its import. Wrap the returned tree: `<LinkOpenerProvider workspaceId={activeId ?? null}> ... </LinkOpenerProvider>`, just inside `EnvironmentPanelContext.Provider`.
  - In `EnvironmentWorkbench`, add `useBrowserSurface(!suppressed);` next to `const panel = useEnvironmentPanel();`.
  - Delete `renderer/lib/use-browser-links.ts`.

Verify that onboarding renders outside `EnvironmentWorkbench`, or with it suppressed: `git grep -n "EnvironmentWorkbench" renderer`. If onboarding mounts the workbench unsuppressed, pass `suppressed` there too.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx tsx --test renderer/lib/link-opener.test.tsx && npm run test:browser && npm run typecheck`
Expected: PASS. `typecheck` may still flag `terminal-drawer.tsx`, which Task 6 fixes.

- [ ] **Step 6: Commit**

```bash
git add -A renderer/lib/link-opener.tsx renderer/lib/link-opener.test.tsx renderer/lib/use-browser-links.ts renderer/components/environment-panel.tsx package.json
git commit -m "Browser: LinkOpenerProvider routes every anchor click, with prompt, menu, and fallback"
```

---

### Task 6: Route the remaining callers

**Files:**
- Modify: `renderer/components/chat-pull-requests.tsx:64` (`openPullRequestExternal`) and its call sites, including `git-push-dialog.tsx`
- Modify: `renderer/components/chat-top-bar.tsx:282`
- Modify: `renderer/components/aiden-ui/aiden-ui-block.tsx:190-325`
- Modify: `renderer/components/markdown.tsx:194-214` (`RestrictedLink` / `policy.openLink`)
- Modify: `renderer/components/terminal-drawer.tsx:396-407`
- Modify: `renderer/components/settings/codex-provider-settings.tsx` (~460) and `renderer/components/settings/builtin-provider-editor.tsx` (~308): add `data-link-target="external"` to the sign-in anchors
- Test: extend `renderer/lib/link-opener.test.tsx` and any existing aiden-ui block test (`git grep -ln "Open link?" renderer`)

**Interfaces:**
- Consumes (Task 5): `useLinkOpener().openLink(href, { modifiers?, workspaceId?, forcePrompt? })`, `canOpen(href)`.
- Produces: `openPullRequestExternal` is removed. Its callers call `openLink(url)`.

- [ ] **Step 1: Write the failing test for the forced prompt** (append to `renderer/lib/link-opener.test.tsx`)

```tsx
test("openLink with forcePrompt asks even when a preference is saved, without remember", async () => {
  const calls = ipc("browser");
  function Caller() {
    const { openLink } = useLinkOpener();
    return <button onClick={() => openLink("https://example.com/x", { forcePrompt: true })}>visual</button>;
  }
  render(
    <LinkOpenerProvider workspaceId="ws-1">
      <Surface />
      <Caller />
    </LinkOpenerProvider>,
  );
  await flush();
  fireEvent.click(screen.getByText("visual"));
  await screen.findByRole("dialog", { name: "Open this link?" });
  assert.equal(screen.queryByRole("checkbox"), null);
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  await flush();
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/x"] }]);
});
```

Run it: `npx tsx --test renderer/lib/link-opener.test.tsx`. It should PASS already, because Task 5 built `forcePrompt`. It pins the contract the aiden-ui and Markdown rewiring rely on. If it fails, fix Task 5's code before going on.

- [ ] **Step 2: PR chips and GitHub.** In `chat-pull-requests.tsx`:
  - delete `openPullRequestExternal`;
  - in each component that used it, add `const { openLink } = useLinkOpener();`;
  - replace `openPullRequestExternal(x)` with `openLink(x)`.

  Do the same in `git-push-dialog.tsx`, which imports it. In `chat-top-bar.tsx:282`, replace `window.open(githubUrl, "_blank", "noopener,noreferrer")` with `openLink(githubUrl)`. Menu `onSelect` has no modifier keys; that's fine.

- [ ] **Step 3: aiden-ui visuals.** In `aiden-ui-block.tsx`:
  - delete the `pendingUrl` state and its confirm `Dialog` (around lines 197 and 305-325);
  - where it set `setPendingUrl(url)` for an `https:` URL, call `openLink(url, { forcePrompt: true })` instead;
  - keep the `onActionRef.current?.({ kind: "open", url })` notification exactly where it fired before (on confirm). The provider doesn't report the user's choice back, so fire it when `openLink` returns `true`. Note in the PR that the action now fires on request rather than on confirmation.

  If an existing test asserts the old "Open link?" dialog, update it to the new title "Open this link?" and button names.

- [ ] **Step 4: Restricted Markdown.** In `markdown.tsx`, find where `policy.openLink` is created. If it is built in a caller (`git grep -n "openLink" renderer`), have that caller pass `(href) => openLink(href, { forcePrompt: true })`. Keep `RestrictedLink`'s own `preventDefault`. It stops the document listener from routing the click a second time, because that listener skips `defaultPrevented` events.

- [ ] **Step 5: Terminal links.** In `terminal-drawer.tsx`:

```tsx
  const { openLink, canOpen } = useLinkOpener();
  // ...
          canActivateLink: (url) => canOpen(url),
          onLinkActivate: (url, event) => {
            openLink(url, { modifiers: event, workspaceId: session.workspaceId });
          },
```

`canOpen` and `openLink` change identity when the preference changes. Read them through a ref inside the terminal setup effect, so the terminal isn't rebuilt on a preference change.

- [ ] **Step 6: Auth anchors.** Add `data-link-target="external"` to the "Open sign-in page" anchors in `codex-provider-settings.tsx` and `builtin-provider-editor.tsx`. These render on Settings, which already routes externally. The attribute keeps them external if they are reused on a panel route.

- [ ] **Step 7: Verify no direct `window.open` link calls remain**

Run: `git grep -n "window.open(" renderer -- ':!*.test.*'`
Expected: none for user-clicked links. Report any intentional leftovers in the PR description.

- [ ] **Step 8: Run the suites**

Run: `npm run typecheck && npm run test:browser && npx tsx --test $(git grep -l "aiden-ui-block\|chat-pull-requests\|terminal-drawer" -- 'renderer/**/*.test.tsx' 'renderer/**/*.test.ts')`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A renderer/components renderer/lib/link-opener.test.tsx
git commit -m "Browser: PR chips, GitHub, aiden-ui, Markdown, and terminal links use the link router"
```

---

### Task 7: Settings → Links

**Files:**
- Modify: `renderer/shared/settings-section.ts`. Add `"links"` to `SETTINGS_SECTIONS` before `"shortcut"`, and add a destination entry.
- Modify: `renderer/main/settings-view.tsx`:
  - `NAV_ICONS`: `links: <Link2 className="size-5" />`
  - `CONTENT`: `links: LinksSettings`
  - `DESCRIPTIONS`: `links: "Choose where links you click open."`
- Create: `renderer/components/settings/links-settings.tsx`
- Create: `renderer/components/settings/links-settings.test.tsx`
- Modify: `package.json`. Append the new test to `test:browser`, and to `test:settings-design` if that script lists per-section tests.
- Modify: `scripts/ci-test-registry.json` as `test:ci-policy` requires.

**Interfaces:**
- Consumes (Task 2): `browserApi.linkPreference`, `browserApi.setLinkPreference`, `browserApi.onEvent`.
- Produces: `export function LinksSettings(): JSX.Element`.

- [ ] **Step 1: Read `docs/settings-design-system.md`** and one small section (`about-settings.tsx`) to match `FieldSet`/`Field` usage and the trailing-control layout. Check how `ui.tsx`'s `Select` exposes its trigger label for Testing Library.

- [ ] **Step 2: Write the failing test**

```tsx
import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { LinksSettings } from "./links-settings";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

test("shows the saved preference and saves a new one", async () => {
  const calls = installBotTestIpc({
    "browser:link-preference": () => "external",
    "browser:set-link-preference": (value) => value,
  });
  render(<LinksSettings />);
  await flush();
  const trigger = screen.getByRole("combobox", { name: "Open links in" });
  assert.match(trigger.textContent ?? "", /System browser/);
  assert.ok(screen.getByText(/local dev servers always open in Aiden/i));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: "Ask each time" }));
  await flush();
  assert.deepEqual(calls.at(-1), { channel: "browser:set-link-preference", args: ["ask"] });
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Ask each time/);
});

test("a failed save restores the previous choice", async () => {
  installBotTestIpc({
    "browser:link-preference": () => "browser",
    "browser:set-link-preference": () => { throw new Error("disk full"); },
  });
  render(<LinksSettings />);
  await flush();
  fireEvent.click(screen.getByRole("combobox", { name: "Open links in" }));
  fireEvent.click(await screen.findByRole("option", { name: "System browser" }));
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Aiden browser/);
});
```

Also extend `renderer/lib/settings-section.test.ts` only if it lists destinations explicitly. It uses `SETTINGS_DESTINATIONS.length`, so check that its expectations still hold and fix any hard-coded count.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test renderer/components/settings/links-settings.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```tsx
import * as React from "react";
import { browserApi } from "../../lib/ipc";
import type { BrowserLinkOpening } from "../../shared/browser";
import { Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "../ui";

const LABELS: Record<BrowserLinkOpening, string> = {
  ask: "Ask each time",
  browser: "Aiden browser",
  external: "System browser",
};
const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

export function LinksSettings() {
  const [value, setValue] = React.useState<BrowserLinkOpening | null>(null);
  React.useEffect(() => {
    let live = true;
    void browserApi.linkPreference().then((next) => live && setValue(next)).catch(() => live && setValue("ask"));
    const off = browserApi.onEvent((event) => {
      if (event.type === "state" && event.state.defaults) setValue(event.state.defaults.linkOpening);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const change = (next: BrowserLinkOpening) => {
    const previous = value;
    setValue(next);
    void browserApi.setLinkPreference(next).catch((error: unknown) => {
      setValue(previous);
      toast.error(error instanceof Error ? error.message : "Couldn't save this setting.");
    });
  };
  return (
    <FieldSet title="Links">
      <Field
        label="Open links in"
        description={`Local dev servers always open in Aiden. ${MOD}-click a link to open it in the other browser.`}
      >
        <Select value={value ?? undefined} onValueChange={(next) => change(next as BrowserLinkOpening)} disabled={value === null}>
          <SelectTrigger aria-label="Open links in">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(LABELS) as BrowserLinkOpening[]).map((key) => (
              <SelectItem key={key} value={key}>
                {LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldSet>
  );
}
```

Use the project's existing platform helper (`IS_MAC` is used in `chat-top-bar.tsx`; import it from the same module) instead of reading `navigator.platform` here. Use the same `BrowserEvent` state discriminant you confirmed in Task 5.

- [ ] **Step 5: Wire the section.** Add the destination to `SETTINGS_DESTINATIONS`:

```ts
  {
    id: "links",
    title: "Links",
    group: "App",
    keywords: ["browser", "open links", "external", "system browser", "aiden browser", "url"],
  },
```

Add the three `settings-view.tsx` map entries listed under Files (`Link2` from `lucide-react`). The page heading follows the default (`heading` true), so `SettingsPage` renders "Links" with the description.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx tsx --test renderer/components/settings/links-settings.test.tsx renderer/lib/settings-section.test.ts && npm run test:settings-design && npm run test:ci-policy && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/shared/settings-section.ts renderer/main/settings-view.tsx renderer/components/settings/links-settings.tsx renderer/components/settings/links-settings.test.tsx renderer/lib/settings-section.test.ts package.json scripts/ci-test-registry.json
git commit -m "Settings: Links section for where clicked links open"
```

---

### Task 8: End-to-end coverage, docs, and memory

**Files:**
- Modify: `tests/e2e/browser.spec.ts`
- Create: `.memory/link-opening.md`; update the `.memory/` index file if one exists
- Modify: `docs/plans/README.md`. Move this plan's row to Done in the same PR that lands the feature.
- Modify: `docs/superpowers/specs/2026-10-15-link-opening-design.md` status line

**Interfaces:**
- Consumes: everything above. Use the spec's `command(page, …)` helper and the existing workspace fixture in `browser.spec.ts`.

- [ ] **Step 1: Add the e2e tests** (next to the existing anchor test around line 272, reusing its helpers and setup)

```ts
test("first link click asks, remembers Aiden, then reuses the tab", async () => {
  // Fresh profile: preference is "ask".
  await command(page, { action: "defaults", defaults: { linkOpening: "ask" } });
  const before = (await state(page)).tabs.length;
  await addAnchor(page, "https://example.com/");          // helper: inject <a href> into the chat surface
  await page.getByRole("link", { name: "https://example.com/" }).click();
  const dialog = page.getByRole("dialog", { name: "Open this link?" });
  await expect(dialog.getByRole("checkbox", { name: "Remember my choice" })).toBeChecked();
  await dialog.getByRole("button", { name: "Open in Aiden browser" }).click();
  await expect.poll(async () => (await state(page)).tabs.length).toBe(before + 1);
  await page.getByRole("link", { name: "https://example.com/" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).tabs.length).toBe(before + 1);
  expect((await state(page)).defaults.linkOpening).toBe("browser");
});

test("localhost links open in Aiden with no prompt even when the preference is external", async () => {
  await command(page, { action: "defaults", defaults: { linkOpening: "external" } });
  const before = (await state(page)).tabs.length;
  await addAnchor(page, `${previewServerUrl}/`);           // the spec's existing local fixture server
  await page.getByRole("link", { name: previewServerUrl, exact: false }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).tabs.length).toBe(before + 1);
});
```

If `browser.spec.ts` lacks an `addAnchor` / `state` helper, use the inline `page.evaluate` it already uses at line 272 to create the anchor, and `browserApi.getState` through its existing `command`/state helper. External opens can't be observed in e2e without stubbing `shell.openExternal`. Don't add such a stub; the Task 5 unit tests cover the external branch.

Add one relaunch-persistence check only if the spec already has a relaunch helper (`git grep -n "relaunch\|restartApp" tests/e2e`). Otherwise the Task 1 migration tests and the `save()` path cover persistence. Say so in the PR.

- [ ] **Step 2: Run the e2e browser spec**

Run: `npx playwright test tests/e2e/browser.spec.ts`
Expected: PASS. If a test fails and then passes on rerun, follow AGENTS.md: record it, and don't raise timeouts.

- [ ] **Step 3: Write `.memory/link-opening.md`** (match the format of the existing `.memory/` files)

```markdown
# Link opening

- One router: `renderer/lib/browser-link-routing.ts` (`resolveLinkOpen`), driven by `LinkOpenerProvider` (`renderer/lib/link-opener.tsx`) mounted in `EnvironmentPanelProvider`.
- Preference `BrowserDefaults.linkOpening` = ask | browser | external (default ask), stored in the browser service JSON; legacy `linkTarget: "external"` migrates to external, anything else to ask.
- Loopback always opens in Aiden; Cmd/Ctrl flips; no visible panel (Settings, Bots, Studio, remote, onboarding) → system browser; `data-link-target="external"` forces external; aiden-ui and restricted Markdown always prompt without remember (system browser only when no panel).
- Panel availability = `useBrowserSurface(!suppressed)` in `EnvironmentWorkbench`.
- IPC: `browser:link-preference`, `browser:set-link-preference`, `browser:open-external` (validated by `externalUrl` in `main/services/browser/core.ts`, shared with the main-window guard).
- `open_link` reuses a same-URL tab and emits `show`; in-app failures fall back to the system browser with a toast.
- Inside the Aiden browser, target=_blank opens a new tab with the opener's profile (same-tab at the 24-tab limit; external when the preference is external).
- Spec/plan: docs/superpowers/specs|plans/2026-10-15-link-opening*.
```

- [ ] **Step 4: Update the docs index and spec status.** In `docs/plans/README.md`, set this plan's row to Done and link the PR. Set the spec's status line to "implemented".

- [ ] **Step 5: Run the full local gate**

Run: `npm run typecheck && npm run test:browser && npm run test:settings-design && npm run test:ci-policy && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/browser.spec.ts .memory docs/plans/README.md docs/superpowers/specs/2026-10-15-link-opening-design.md
git commit -m "Browser: e2e for first-click prompt, tab reuse, and loopback; link-opening memory"
```
