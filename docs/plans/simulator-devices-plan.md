# Simulator Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Simulator** tab to the Environment sidebar (beside Review, Subagents, Files, and Browser). It streams and controls local iOS Simulators, and it gives the chat agent a small `device_*` tool set plus the `agent-device` CLI, so the agent can boot, watch, drive, and screenshot a simulator while the user watches.

**Architecture:** This ports T3 Code's device integration (snapshot `pingdotgg/t3code` tag `v0.0.43-nightly.20260925.2251`, commit `1c127066`, MIT) into Aiden's Electron main/renderer split. The main process owns a `DeviceHost` seam and a `DeviceService`. On explicit consent, the host installs two pinned npm tools under Aiden's data directory: `expo-device-hub` (stream and input) and `agent-device` (agent driving). The hub is a supervised loopback child that is never exposed directly. The renderer reaches it only through a main-owned, token-authenticated loopback proxy with a route allowlist. Agent tools mirror `browser-tools.ts`: main builds a port bound to a fixed workspace and generation, admission follows the browser gate, and driving guidance is returned by `device_open` rather than kept in the always-on prompt.

**Tech Stack:** Electron 43 main (Node `child_process`, `http`, `ws`), React renderer with Aiden semantic tokens, `@earendil-works/pi-ai` `Type` schemas for agent tools, `tsx --test`, and Playwright Electron E2E. Pinned external tools are `expo-device-hub@0.12.0` (MIT) and `agent-device@0.21.12` (MIT, engines `node >=22.12`). Phase 6 adds `three` (MIT).

## Decisions already made (2026-09-25)

- **Toolchain:** follow the T3 model. After consent, Aiden installs pinned `expo-device-hub` and `agent-device`. No always-on install, no `npx` at runtime.
- **Platforms:** iOS Simulator only for v1. Keep `platform` in every contract so Android can slot in later behind the same `DeviceHost` seam.
- **Also in scope:** SSH device hosts (Phase 5) and 3D device frames (Phase 6). The mobile companion preview is out of scope.

## Status (2026-09-25)

Phases 0–3 and 3.5 are implemented and uncommitted on `worktree-main-20260925`. The spike results are in [simulator-devices-spike.md](simulator-devices-spike.md). The Phase 2 acceptance script passed on a real Mac with Xcode. Phase 3 has its own task plan, [simulator-devices-phase-3.md](simulator-devices-phase-3.md), and an Electron E2E against a fake hub. Phase 4 is implemented except its manual real-simulator exit gate; 5–7 remain. See "Phase 2 as built" and "Phase 3 as built" below for where the code differs from the task text.

## Global Constraints

- Feature flag `AIDEN_EXPERIMENTAL_DEVICES`. The default is **off** until Phase 4 acceptance, and the flag is surfaced as the `devices` app capability, which fails closed like `subagents`.
- `process.platform === "darwin"` is required for the local host. The tab is hidden, not merely disabled, when the capability is false.
- Network: the only new outbound traffic is `npm install <pkg>@<exact version>` against the user's configured npm registry, and it runs only after the user presses the explicit consent action in the Simulator tab. The same rule applies on each tool's own consent step. Startup, background polling, and onboarding never trigger it. Record this in the onboarding disclosure (Phase 7).
- The hub binds `127.0.0.1` only. The renderer never receives the hub origin. Every renderer request goes through the proxy, which requires the per-launch 256-bit token. Allowlisted routes are exactly T3's iOS set (see Task 2.4). Non-GET is allowed only for `/vendor/serve-sim/api/screenshot`.
- Never proxy serve-sim's shell-exec route or its Tools panel commands. Device settings run through typed `simctl` actions in main.
- Agent tools are admitted only when `canUseDeviceTools(...)` holds. That requires `devices` capability, `agentAccess` consent, `permission` of `"full"` or `"ask"`, a renderer owner, and a context that is neither assistant-mode nor a bot. `device_open` and `device_close` require approval under `"ask"`, the same way `BROWSER_MUTATION_TOOL_NAMES` do.
- The always-on prompt block stays at 5 lines or fewer: it points at the tools and forbids raw `simctl`, `xcrun`, and `serve-sim` while a device is attached. Driving guidance lives only in the `device_open` result.
- Provenance: any file ported from T3 keeps an origin comment (`Adapted from t3code <path> @ 1c127066 (MIT)`), and `THIRD_PARTY_NOTICES.md` gains T3 Code, expo-device-hub, and agent-device entries. Apple's GLB models in the snapshot state **"No open-source or redistribution license"**, so they must **never** be copied into Aiden (see Phase 6).
- UI: review `docs/chatgpt-desktop-ui-inspiration.md`, `docs/chatgpt-ui-element-specimen.html`, and `docs/design-guide.md` before the Phase 1 and Phase 3 UI tasks. Use only the tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` and the shared squircle `Button`, with no decorative colored borders. Keep `focus-visible` rings.
- Every new test file is registered in a new `test:devices` script, and `test:devices` is appended to `npm run test`.
- Desktop-only contracts: v1 changes no Aiden Remote or native-client contract. If a later phase exposes devices over Remote, the iOS and Android consumers must be updated per AGENTS.md.

## File map

| Path | Responsibility | Phase |
| --- | --- | --- |
| `main/services/devices/feature-flag.ts` | `devicesEnabled(env, platform)` | 1 |
| `renderer/lib/app-capabilities.tsx` | add `devices` capability | 1 |
| `renderer/lib/environment-panel-state.ts` | `"devices"` tab, capability-aware normalization | 1 |
| `renderer/components/environment-panel.tsx` | tab button and tabpanel wiring | 1 |
| `renderer/components/devices-panel.tsx` | Simulator tab UI (setup → device list → stream) | 1 → 3 |
| `renderer/shared/devices.ts` | shared wire types and parsers (renderer ↔ main) | 2 |
| `main/services/devices/device-toolchain.ts` | pinned staged npm installs and version sentinel | 2 |
| `main/services/devices/device-host.ts` | `DeviceHost` interface (local and SSH) | 2 |
| `main/services/devices/local-device-host.ts` | supervised hub child, `simctl` runner, agent daemon | 2 |
| `main/services/devices/device-hub-proxy.ts` | token-authenticated loopback allowlist proxy | 2 |
| `main/services/devices/device-service.ts` | discovery, per-chat sessions, consent, state events | 2 |
| `main/services/devices/device-actions.ts` | typed `simctl` settings actions | 3 |
| `main/handlers/devices.ts` | `devices:*` IPC | 2 |
| `renderer/lib/device-stream.ts` | AVCC/WebCodecs decoder, MJPEG fallback, input socket | 3 |
| `main/services/devices/device-tools.ts` | `device_list/open/screenshot/close` agent tools | 4 |
| `main/services/devices/agent-device-shim.ts` | PATH shim that enforces `--config/--session` | 4 |
| `main/services/devices/ssh-device-host.ts` | SSH host with port forwarding | 5 |
| `renderer/components/devices/phone-viewer/*` | three.js frame renderer | 6 |

---

## Phase 0: Feasibility spike (no product code)

Goal: resolve three unknowns that change later phases. The output is `docs/plans/simulator-devices-spike.md` plus a `.memory/simulator-devices.md` note.

### Task 0.1: Node runtime for the pinned tools

- [ ] **Step 1:** In a scratch directory, run `npm install --prefix ./hub --no-fund --no-audit expo-device-hub@0.12.0` and `npm install --prefix ./agent agent-device@0.21.12`.
- [ ] **Step 2:** Start the hub under Electron's Node with `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./hub/node_modules/expo-device-hub/dist/server/cli.mjs --port 0` (use the exact CLI flags from T3 `LocalDeviceHost.ts:361-380`). Record whether `node-datachannel` (native) loads under Electron 43's ABI.
- [ ] **Step 3:** Repeat with the system `node` (≥ 22.12).
- [ ] **Step 4:** Record the decision. Prefer Electron-as-Node, because it needs no user Node. Fall back to a resolved system Node plus an explicit "Install Node 22+" setup state. Also record whether `npm` is resolvable from a packaged app's login-shell PATH. If it is not, spec the fallback: a registry tarball fetch with a pinned `integrity` from `npm view <pkg>@<v> dist.integrity`, then `npm ci` from a vendored lockfile.

### Task 0.2: Stream decode inside Aiden's renderer

- [ ] **Step 1:** Boot a simulator (`xcrun simctl boot "iPhone 17 Pro"`), start the hub, and open `http://127.0.0.1:<port>/` in an Electron `BrowserWindow` that uses Aiden's CSP from `main-window.html`.
- [ ] **Step 2:** Check that `VideoDecoder.isConfigSupported({ codec: "avc1.640033" })` (H.264 High 5.1) resolves as supported in Electron 43, and that the MJPEG fallback renders. Record the latency and CPU for both.

### Task 0.3: agent-device first-run cost

- [ ] **Step 1:** Run `agent-device devices --json`, then `agent-device snapshot -i --platform ios --udid <udid>`. Record the XCTest runner build time and whether Xcode's license and first-launch state block it. Adjust the Phase 4 quick-start copy to match.

**Exit gate:** the spike doc names the runtime, the install mechanism, the decoder path, and the measured first-run costs. Phases 2–4 may start only after this is recorded.

---

## Phase 1: Simulator tab shell (behind the flag)

Delivers a visible, keyboard-accessible **Simulator** tab that follows the Browser tab and shows a setup empty state. There is no main-process device logic yet.

### Task 1.1: `devices` feature flag and app capability

**Files:**
- Create: `main/services/devices/feature-flag.ts`
- Create: `main/services/devices/feature-flag.test.ts`
- Modify: `main/handlers/app.ts:33-36`
- Modify: `renderer/lib/app-capabilities.tsx:3-19`
- Modify: `renderer/components/environment-subagents-contract.test.ts:40-53`
- Modify: `package.json` (new `test:devices`, appended to `test`)

**Interfaces:**
- Produces: `devicesEnabled(environment?, platform?): boolean`, `DEVICES_FEATURE_FLAG`, and `AppCapabilities.devices: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/devices/feature-flag.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { DEVICES_FEATURE_FLAG, devicesEnabled } from "./feature-flag.js";

test("simulator devices stay off unless the experimental flag is set on macOS", () => {
  assert.equal(devicesEnabled({}, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: " TRUE " }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "0" }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "linux"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "win32"), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test main/services/devices/feature-flag.test.ts`
Expected: FAIL with `Cannot find module './feature-flag.js'`.

- [ ] **Step 3: Implement**

```ts
// main/services/devices/feature-flag.ts
export const DEVICES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DEVICES";

/**
 * The Simulator tab and device agent tools stay dark until explicitly enabled.
 * Local iOS Simulators need Xcode, so non-macOS hosts are always off.
 */
export function devicesEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const value = environment[DEVICES_FEATURE_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
```

In `main/handlers/app.ts`, import `devicesEnabled` and add `devices: devicesEnabled(),` to `capabilities`.

In `renderer/lib/app-capabilities.tsx`:

```ts
export interface AppCapabilities {
  subagents: boolean;
  geminiLive: boolean;
  devices: boolean;
}

export const DISABLED_APP_CAPABILITIES: AppCapabilities = Object.freeze({
  subagents: false,
  geminiLive: false,
  devices: false,
});

export function parseAppCapabilities(value: unknown): AppCapabilities {
  if (typeof value !== "object" || value === null) return DISABLED_APP_CAPABILITIES;
  return {
    subagents: "subagents" in value && value.subagents === true,
    geminiLive: "geminiLive" in value && value.geminiLive === true,
    devices: "devices" in value && value.devices === true,
  };
}
```

Update each `deepEqual` in `environment-subagents-contract.test.ts:40-53` to include `devices: false`, and add:

```ts
assert.deepEqual(parseAppCapabilities({ devices: true }), {
  subagents: false,
  geminiLive: false,
  devices: true,
});
assert.equal(parseAppCapabilities({ devices: "true" }).devices, false);
```

Add to `package.json`: `"test:devices": "tsx --test main/services/devices/*.test.ts renderer/lib/environment-panel-state.test.ts renderer/components/devices-panel.test.tsx"`, and append `&& npm run test:devices` to `"test"`.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx tsx --test main/services/devices/feature-flag.test.ts renderer/components/environment-subagents-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/services/devices/feature-flag.ts main/services/devices/feature-flag.test.ts main/handlers/app.ts renderer/lib/app-capabilities.tsx renderer/components/environment-subagents-contract.test.ts package.json
git commit -m "feat(devices): add experimental devices capability flag"
```

### Task 1.2: `"devices"` Environment tab state

**Files:**
- Modify: `renderer/lib/environment-panel-state.ts:1-66`
- Create: `renderer/lib/environment-panel-state.test.ts`
- Modify: `renderer/components/environment-subagents-contract.test.ts:54-73`
- Modify: `renderer/components/browser-panel.test.tsx:13`

**Interfaces:**
- Consumes: `AppCapabilities.devices` (Task 1.1).
- Produces: `EnvironmentPanelTab` including `"devices"`, `parseEnvironmentPanelTab(value: string | null): EnvironmentPanelTab | null`, `availableEnvironmentPanelTabs(subagentsEnabled: boolean, devicesEnabled?: boolean)`, `normalizeEnvironmentPanelTab(tab, subagentsEnabled, devicesEnabled?)`, and `storedEnvironmentPanelTab(storage, key, subagentsEnabled, devicesEnabled?)`. `devicesEnabled` defaults to `false`, so existing two-argument callers keep today's behavior.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/lib/environment-panel-state.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  availableEnvironmentPanelTabs,
  normalizeEnvironmentPanelTab,
  parseEnvironmentPanelTab,
  storedEnvironmentPanelTab,
} from "./environment-panel-state.js";

const storage = (value: string | null) => ({ getItem: () => value, setItem: () => undefined });

test("Simulator tab sits after Browser only when the devices capability is on", () => {
  assert.deepEqual(availableEnvironmentPanelTabs(true, true), [
    "review", "subagents", "files", "browser", "devices",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(false, true), ["review", "files", "browser", "devices"]);
  assert.deepEqual(availableEnvironmentPanelTabs(true, false), ["review", "subagents", "files", "browser"]);
  assert.deepEqual(availableEnvironmentPanelTabs(true), ["review", "subagents", "files", "browser"]);
});

test("a disabled Simulator tab normalizes to Review without rewriting storage", () => {
  assert.equal(normalizeEnvironmentPanelTab("devices", true, false), "review");
  assert.equal(normalizeEnvironmentPanelTab("devices", true), "review");
  assert.equal(normalizeEnvironmentPanelTab("devices", false, true), "devices");
  let writes = 0;
  const tracked = { getItem: () => "devices", setItem: () => void writes++ };
  assert.equal(storedEnvironmentPanelTab(tracked, "tab", true, false), "review");
  assert.equal(storedEnvironmentPanelTab(tracked, "tab", true, true), "devices");
  assert.equal(writes, 0);
});

test("stored tab parsing accepts every known tab and rejects anything else", () => {
  for (const tab of ["review", "subagents", "files", "browser", "devices"] as const) {
    assert.equal(parseEnvironmentPanelTab(tab), tab);
  }
  assert.equal(parseEnvironmentPanelTab("overview"), null);
  assert.equal(parseEnvironmentPanelTab("Devices"), null);
  assert.equal(parseEnvironmentPanelTab(null), null);
  assert.equal(storedEnvironmentPanelTab(storage("bogus"), "tab", true, true), "review");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test renderer/lib/environment-panel-state.test.ts`
Expected: FAIL (`parseEnvironmentPanelTab` is not exported, and the tab arrays do not match).

- [ ] **Step 3: Implement.** Replace lines 1–66 of `renderer/lib/environment-panel-state.ts` with the following. `reduceEnvironmentSurfaceState` is unchanged.

```ts
export type EnvironmentPanelTab = "review" | "subagents" | "files" | "browser" | "devices";
export type EnvironmentSurface = "quick-view" | "tools";
export type EnvironmentSurfaceMode = "closed" | "tools-pinned" | "tools-floating";

export interface EnvironmentSurfaceState {
  quickViewOpen: boolean;
  toolsOpen: boolean;
  toolsTab: EnvironmentPanelTab;
  frontSurface: EnvironmentSurface | null;
}

export type EnvironmentSurfaceAction =
  | { type: "toggle-quick-view" }
  | { type: "show-quick-view" }
  | { type: "close-quick-view" }
  | { type: "toggle-tools"; tab: EnvironmentPanelTab }
  | { type: "show-tools"; tab?: EnvironmentPanelTab }
  | { type: "close-tools" }
  | { type: "activate"; surface: EnvironmentSurface }
  | { type: "close-all" };

export const ENVIRONMENT_PANEL_TABS = ["review", "subagents", "files", "browser", "devices"] as const;

interface EnvironmentPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface EnvironmentClosestTarget {
  closest(selector: string): unknown;
}

export function shouldRestoreEnvironmentFocus(
  activeElement: EnvironmentClosestTarget | null,
  surface: EnvironmentSurface,
): boolean {
  return Boolean(activeElement?.closest(`[data-environment-surface="${surface}"]`));
}

export function parseEnvironmentPanelTab(value: string | null): EnvironmentPanelTab | null {
  return (ENVIRONMENT_PANEL_TABS as readonly string[]).includes(value ?? "")
    ? (value as EnvironmentPanelTab)
    : null;
}

function environmentPanelTabEnabled(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
  devicesEnabled: boolean,
): boolean {
  if (tab === "subagents") return subagentsEnabled;
  if (tab === "devices") return devicesEnabled;
  return true;
}

export function availableEnvironmentPanelTabs(
  subagentsEnabled: boolean,
  devicesEnabled = false,
): readonly EnvironmentPanelTab[] {
  return ENVIRONMENT_PANEL_TABS.filter((tab) =>
    environmentPanelTabEnabled(tab, subagentsEnabled, devicesEnabled),
  );
}

export function normalizeEnvironmentPanelTab(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
  devicesEnabled = false,
): EnvironmentPanelTab {
  return environmentPanelTabEnabled(tab, subagentsEnabled, devicesEnabled) ? tab : "review";
}

export function storedEnvironmentPanelTab(
  storage: EnvironmentPanelStorage,
  key: string,
  subagentsEnabled: boolean,
  devicesEnabled = false,
): EnvironmentPanelTab {
  // Capability bootstrap starts fail-closed and can become authoritative later.
  // Preserve the raw destination instead of destructively repairing storage.
  const parsed = parseEnvironmentPanelTab(storage.getItem(key)) ?? "review";
  return normalizeEnvironmentPanelTab(parsed, subagentsEnabled, devicesEnabled);
}
```

The existing `availableEnvironmentPanelTabs(false)` and `(true)` assertions in `environment-subagents-contract.test.ts:54-59` still hold unchanged, because `devicesEnabled` defaults to `false`. Leave them in place.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx tsx --test renderer/lib/environment-panel-state.test.ts renderer/components/environment-subagents-contract.test.ts renderer/components/browser-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/environment-panel-state.ts renderer/lib/environment-panel-state.test.ts
git commit -m "feat(devices): add capability-gated Simulator environment tab state"
```

### Task 1.3: Simulator tab button, tabpanel, and setup empty state

Before starting, review `docs/chatgpt-desktop-ui-inspiration.md`, `docs/chatgpt-ui-element-specimen.html`, and `docs/design-guide.md`.

**Files:**
- Create: `renderer/components/devices-panel.tsx`
- Create: `renderer/components/devices-panel.test.tsx`
- Modify: `renderer/components/environment-panel.tsx` (lines 209–222, 256–263, 391, 461, 1141, 1282–1283, and a new tabpanel after line 1434)
- Modify: `renderer/components/environment-subagents-contract.test.ts:240,278` (source regexes)

**Interfaces:**
- Consumes: `useAppCapabilities().devices`, plus the Task 1.2 helpers.
- Produces: `<DevicesPanel workspaceId: string; active: boolean; compact: boolean />`, where `active` means the panel is presented and selected (it starts polling in Phase 3). The context value gains `devicesEnabled: boolean`.

- [ ] **Step 1: Write the failing test** (the render style copies `renderer/components/browser-panel.test.tsx`)

```tsx
// renderer/components/devices-panel.test.tsx
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DevicesPanel } from "./devices-panel.js";

test("Simulator panel explains setup before any tool is installed", () => {
  const html = renderToStaticMarkup(<DevicesPanel workspaceId="w1" active compact={false} />);
  assert.match(html, /iOS Simulator/u);
  assert.match(html, /Xcode/u);
  assert.match(html, /Set up simulator streaming/u);
  assert.doesNotMatch(html, /border-(red|green|blue|accent)/u);
});

test("Environment panel renders the Simulator tab and panel only with the devices capability", () => {
  const source = readFileSync(new URL("./environment-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /availableEnvironmentPanelTabs\(panel\.subagentsEnabled, panel\.devicesEnabled\)/u);
  assert.match(source, /tab === "devices" \? Smartphone/u);
  assert.match(source, /tab === "devices" \? "Simulator"/u);
  assert.match(source, /id="environment-devices-panel"/u);
  assert.match(source, /panel\.devicesEnabled \? \(\s*<div\s+id="environment-devices-panel"/u);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test renderer/components/devices-panel.test.tsx`
Expected: FAIL with `Cannot find module './devices-panel.js'`.

- [ ] **Step 3: Implement the panel.** It is static in this phase; Phase 3 replaces the button handler with the consent flow.

```tsx
// renderer/components/devices-panel.tsx
import { Smartphone } from "lucide-react";
import { Button, Text } from "./ui";

export interface DevicesPanelProps {
  workspaceId: string;
  /** Presented and selected. Later phases start discovery only while active. */
  active: boolean;
  compact: boolean;
}

export function DevicesPanel({ compact }: DevicesPanelProps) {
  return (
    <section
      aria-labelledby="devices-empty-title"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-control bg-well text-secondary">
        <Smartphone className="size-5" aria-hidden />
      </span>
      <h2 id="devices-empty-title" className="text-regular font-medium text-primary">
        iOS Simulator
      </h2>
      <Text variant="small" color="secondary" className={compact ? "sr-only" : "max-w-72"}>
        Watch and control Xcode simulators here, and let Aiden drive them while you watch.
        Setup installs two pinned helper tools the first time.
      </Text>
      <Button variant="muted" size="small" disabled>
        Set up simulator streaming
      </Button>
    </section>
  );
}
```

`Button` and `Text` come from `renderer/components/ui.tsx` (`variant` includes `muted`; `size` is `small | medium | large`). Confirm `bg-well` and `rounded-control` exist in `renderer/styles.css`; otherwise use the nearest existing surface token. Do not add new tokens.

- [ ] **Step 4: Wire `environment-panel.tsx`**

  1. Import `Smartphone` from `lucide-react` beside `Globe`, and import `{ DevicesPanel } from "./devices-panel"`.
  2. `storedLastToolsTab(currentTab, subagentsEnabled, devicesEnabled)`: add `if (stored === "devices" && devicesEnabled) return stored;` and pass `devicesEnabled` through to `normalizeEnvironmentPanelTab`.
  3. `initialEnvironmentSurfaceState` takes `{ subagentsEnabled, devicesEnabled }`. Replace the four-way `rawTab === …` chain with `parseEnvironmentPanelTab(rawTab) ?? storedLastToolsTab("review", subagentsEnabled, devicesEnabled)`.
  4. In `EnvironmentPanelProvider`, destructure `{ subagents: subagentsEnabled, devices: devicesEnabled }` from `useAppCapabilities()`, pass the object to `useReducer`'s initializer, and pass `devicesEnabled` as the third argument at every `normalizeEnvironmentPanelTab` call (lines 263, 391, and 461) and in their `useCallback` dependency arrays. Expose `devicesEnabled` on the context value beside `subagentsEnabled`.
  5. Line 1141: `availableEnvironmentPanelTabs(panel.subagentsEnabled, panel.devicesEnabled)`.
  6. Lines 1282–1283:

     ```tsx
     const Icon = tab === "review" ? GitCompareArrows : tab === "browser" ? Globe : tab === "devices" ? Smartphone : Files;
     const label = tab === "review" ? "Review" : tab === "subagents" ? "Subagents" : tab === "browser" ? "Browser" : tab === "devices" ? "Simulator" : "Files";
     ```

  7. After the browser tabpanel:

     ```tsx
     {panel.devicesEnabled ? (
       <div
         id="environment-devices-panel"
         role="tabpanel"
         aria-labelledby="environment-devices-tab"
         hidden={panel.tab !== "devices"}
         className="h-full min-h-0"
       >
         {active && (
           <DevicesPanel
             workspaceId={active.id}
             active={presented && panel.tab === "devices"}
             compact={width < 540}
           />
         )}
       </div>
     ) : null}
     ```

  8. In `environment-subagents-contract.test.ts`, change line 240 to `/availableEnvironmentPanelTabs\(panel\.subagentsEnabled, panel\.devicesEnabled\)/u` and line 278 to `/normalizeEnvironmentPanelTab\(nextTab, subagentsEnabled, devicesEnabled\)/u`.

- [ ] **Step 5: Run and confirm it passes**

Run: `npx tsx --test renderer/components/devices-panel.test.tsx renderer/components/environment-subagents-contract.test.ts renderer/lib/environment-panel-state.test.ts renderer/components/browser-panel.test.tsx renderer/lib/environment-panel-layout.test.ts && npm run type-check && npx eslint renderer/components/devices-panel.tsx renderer/components/environment-panel.tsx renderer/lib/environment-panel-state.ts`
Expected: PASS. Five tabs fit the existing `compactTabs` (width < 620) icon-only mode. Confirm this at 900px and 560px in Task 1.4.

- [ ] **Step 6: Commit**

```bash
git add renderer/components/devices-panel.tsx renderer/components/devices-panel.test.tsx renderer/components/environment-panel.tsx renderer/components/environment-subagents-contract.test.ts
git commit -m "feat(devices): add Simulator tab to the Environment sidebar"
```

### Task 1.4: Electron E2E for tab reachability

**Files:**
- Create: `tests/e2e/environment-devices-tab.spec.ts`. This is discovered by the existing `**/*.spec.ts` match, so no package.json change is needed.

- [ ] **Step 1:** Model the test on `tests/e2e/environment-focus.spec.ts`. Launch with `AIDEN_EXPERIMENTAL_DEVICES=1` and assert:
  - the `role="tab"` named "Simulator" is last;
  - ArrowLeft/ArrowRight/Home/End cycle through all five tabs;
  - selecting it shows `#environment-devices-panel` with "Set up simulator streaming";
  - the selection persists across reload;
  - after relaunching *without* the flag, the tab is absent and the panel shows Review, while the stored `"devices"` value is preserved.
- [ ] **Step 2:** Run `npx playwright test tests/e2e/environment-devices-tab.spec.ts`. Expected: PASS at 900px (labels) and 560px (icons with `title`).
- [ ] **Step 3:** Commit: `test(devices): cover Simulator tab keyboard, persistence and gating`.

**Phase 1 exit:** `npm run test`, `npm run type-check`, `npm run lint`, and the new E2E all pass. Update the plan row in `docs/plans/README.md` and `.memory/simulator-devices.md`.

---

## Phase 2: Toolchain, local host, proxy, and service (main process)

Everything here is main-only and unit-tested with fakes. Real `simctl` and npm are exercised only in the Phase 2 acceptance script.

### Task 2.1: Shared wire types (`renderer/shared/devices.ts`)

**Produces:**

```ts
export type DevicePlatform = "ios";
export type DeviceHostKind = "local" | "ssh";
export const LOCAL_DEVICE_HOST_ID = "local";
export interface DeviceSummary {
  hostId: string; id: string; name: string; platform: DevicePlatform;
  version: string; booted: boolean; kind: "iphone" | "ipad" | "other";
}
export type DeviceHostStatus =
  | "disabled" | "needs-consent" | "installing" | "starting" | "ready" | "unavailable" | "error";
export interface DeviceConsent { streaming: boolean; agentAccess: boolean }
export interface DeviceSession { chatId: string; hostId: string; deviceId: string; openedBy: "user" | "agent" }
export interface DeviceServiceState {
  hostStatus: DeviceHostStatus;
  hostStatuses: Record<string, { status: DeviceHostStatus; detail?: string }>;
  consent: DeviceConsent;
  devices: DeviceSummary[];
  sessions: DeviceSession[];
  toolVersions: { hub: string; agent: string };
  unavailableReason?: string; // e.g. "Install Xcode and run it once to accept the license."
}
export interface DeviceStreamGrant { origin: string; token: string; expiresAt: number }
export function parseDeviceServiceState(value: unknown): DeviceServiceState | null;
export function parseDeviceStreamGrant(value: unknown): DeviceStreamGrant | null;
```

Tests (`renderer/shared/devices.test.ts`): the parsers reject extra platforms, non-loopback origins in grants, tokens shorter than 43 base64url chars, and expired grants. The parsers must fail closed (`null`).

### Task 2.2: `device-toolchain.ts` (pinned, staged, idempotent installs)

Port T3 `DeviceToolchain.ts:118-200` to plain async Node.

**Produces:**

```ts
export const DEVICE_HUB = { name: "expo-device-hub", version: "0.12.0", entry: ["dist", "server", "cli.mjs"] } as const; // entry paths: confirm in Phase 0.1
export const AGENT_DEVICE = { name: "agent-device", version: "0.21.12", entry: ["bin", "agent-device.mjs"] } as const;
export interface ToolSpec { name: string; version: string; entry: readonly string[] }
export function deviceToolPaths(baseDir: string, spec: ToolSpec): { installDir: string; entryPath: string; sentinel: string };
export async function isToolInstalled(baseDir: string, spec: ToolSpec): Promise<boolean>;
export async function ensureTool(baseDir: string, spec: ToolSpec, deps: { runNpm(args: string[], opts: { timeoutMs: number }): Promise<{ code: number; stderr: string }> }): Promise<string /* entryPath */>;
export async function pruneOldToolVersions(baseDir: string, spec: ToolSpec): Promise<void>;
```

The base directory is `path.join(aidenConfigDir(), "devices")` (check `main/services/aiden-config-dir.ts` for the helper name).

Test cases in `device-toolchain.test.ts`, using a temp dir and a fake `runNpm`:
1. The npm args are exactly `["install", "--prefix", <staging>, "--no-fund", "--no-audit", "--ignore-scripts=false", "expo-device-hub@0.12.0"]`, with no caret or range.
2. A missing entry after install throws `verifying the installed entry point`, and nothing is published.
3. A published sentinel short-circuits the second call (zero npm runs).
4. Concurrent `ensureTool` calls share one install (a per-spec promise lock).
5. A rename race where the destination is already published counts as success.
6. The staging dir is removed on every failure path.
7. Pruning keeps only the pinned version.

### Task 2.3: `device-host.ts` and `local-device-host.ts`

**Produces:**

```ts
export interface DeviceHubEndpoint { origin: string } // http://127.0.0.1:<port>
export interface AgentDeviceEndpoint { baseUrl: string; token: string; entryPath: string }
export interface DeviceHostReady {
  nodePath: string;
  hub: DeviceHubEndpoint;
  run(command: "xcrun" | string, args: readonly string[], options?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
}
export interface DeviceHost {
  id: string; kind: DeviceHostKind;
  platformAvailability(): Promise<{ platform: "ios"; available: boolean; reason?: string }>;
  ensureReady(onPhase: (phase: "installing" | "starting", detail?: string) => void): Promise<DeviceHostReady>;
  ensureAgentReady(onPhase: (phase: "installing" | "starting", detail?: string) => void): Promise<DeviceHostReady & { agentDevice: AgentDeviceEndpoint }>;
  current(): DeviceHostReady | null;
  stopAgent(): Promise<void>;
  stop(): Promise<void>; // never shuts down simulators; the user owns those
}
export function createLocalDeviceHost(deps: LocalDeviceHostDeps): DeviceHost;
```

Behavior to port from T3 `LocalDeviceHost.ts`:
- `platformAvailability` requires `xcrun simctl help` to exit 0. It maps a missing Xcode or unaccepted license to a user-readable `reason`.
- The hub gets a reserved loopback port and is spawned with the Phase 0 runtime and flags. Readiness polls HTTP for 30s. Restarts use exponential backoff from 1s, capped at 30s, and the backoff resets after 60s of stable uptime.
- A pidfile of `{pid, commandLine}` is written beside the state. A leftover hub is killed at startup only if `ps -o command= -p <pid>` still matches.
- The agent-device daemon starts only in `ensureAgentReady`, with `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1`.
- On `app.on("will-quit")`, `stop()` runs for every host.

Tests use a fake spawner and fake clock: backoff sequence, stale pidfile, a mismatched pid not being killed, a concurrent `ensureReady` sharing one spawn, `stop()` never invoking `simctl shutdown`, and an unavailable Xcode leaving no child running.

### Task 2.4: `device-hub-proxy.ts` (the only way in)

**Produces:** `startDeviceHubProxy({ resolveHub(hostId): string | null }): Promise<{ origin: string; mintGrant(): DeviceStreamGrant; close(): Promise<void> }>`.

- The proxy binds `127.0.0.1:0`. The token is `crypto.randomBytes(32).toString("base64url")` and rotates on every `mintGrant` (a 60s TTL for new connections; established streams persist). Requests carry `?t=<token>&host=<hostId>`, and the proxy strips both before forwarding.
- The HTTP allowlist is `^/api/devices$`, `^/vendor/serve-sim/api$`, `^/vendor/serve-sim/api/screenshot$`, `^/vendor/serve-sim/api/event-log(/events)?$`, and `^/vendor/serve-sim/helper/[^/]+/panel/(1|3)/stream\.avcc$`, plus the MJPEG route identified in Phase 0.
- The WS allowlist is `^/api/devices/ws$`. Only GET/HEAD are accepted, except POST on `/vendor/serve-sim/api/screenshot`.
- Stream responses get `Cache-Control: no-transform`. `Origin` must be Aiden's renderer origin (`file://` or the dev server origin); anything else gets 403.

Tests (`device-hub-proxy.test.ts`, using a real in-process fake hub over `http` and `ws`) cover: a missing or incorrect token gets 401; an expired grant is refused for new requests; every non-allowlisted path is 404 and never reaches the hub, including `/vendor/serve-sim/api/exec`, `/vendor/serve-sim/api/tools`, `..%2f` traversal, and a double-encoded path; POST to a read route gets 405; the token and host params are absent upstream; a WS upgrade on a non-allowlisted path is destroyed; and a foreign `Origin` is refused.

### Task 2.5: `device-service.ts` and `main/handlers/devices.ts`

**Produces:**

```ts
export interface DeviceService {
  state(): DeviceServiceState;
  onState(listener: (state: DeviceServiceState) => void): () => void;
  grantConsent(kind: "streaming" | "agentAccess"): Promise<DeviceServiceState>; // persists in configStore
  revokeConsent(kind: "streaming" | "agentAccess"): Promise<DeviceServiceState>; // stops agent / hub
  refresh(): Promise<DeviceServiceState>; // `xcrun simctl list devices --json` via host.run
  open(input: { chatId: string; hostId?: string; deviceId: string; openedBy: "user" | "agent" }): Promise<DeviceSession>; // boots if needed
  close(input: { chatId: string; hostId: string; deviceId: string; shutdown?: boolean }): Promise<void>;
  sessionsForChat(chatId: string): DeviceSession[];
  screenshot(input: { hostId: string; deviceId: string }): Promise<Buffer /* PNG */>;
  streamGrant(): DeviceStreamGrant;
}
```

IPC channels are `devices:get-state`, `devices:consent`, `devices:refresh`, `devices:open`, `devices:close`, and `devices:stream-grant`, plus the `devices:state` push event. Each is guarded by `rendererDocumentOwner` exactly as `main/handlers/browser.ts` is, and each is rejected unless `devicesEnabled()`. Register them in `main/handlers/index.ts` and add them to `main/handlers/ipc-contract.test.ts` and `renderer/lib/ipc.ts` (`devicesApi`).

Tests cover: parsing of real `simctl list --json` fixtures (iOS 27.0/27.1 runtimes, unavailable runtimes excluded, and iPad classified); sessions scoped per chat; `open` being idempotent; consent persistence; revoking `agentAccess` stopping only the agent; and every IPC method refusing when the flag is off.

**Phase 2 exit:** add `scripts/devices-acceptance.mjs`, run manually on a Mac with Xcode. It consents, installs, starts the hub, lists devices, boots one, fetches one proxied screenshot, and stops. Record the evidence path in `.memory/simulator-devices.md`.

### Phase 2 as built (deviations from the task text)

- **Runtime:** the hub and agent-device run under Electron's own binary with `ELECTRON_RUN_AS_NODE=1` (the spike showed Electron-as-Node loads the hub's native dependency). No system Node is required. npm is still required for installs.
- **Tool path:** installs live in `userData/devices/tools/<name>/<version>`, staged, verified, and then renamed into place. npm runs with `--ignore-scripts=false`, because the hub's native dependency `node-datachannel` runs `prebuild-install -r napi` to fetch its prebuilt N-API binary. That download is extra network contact beyond the npm registry, and it happens only inside the consented install. The consent copy in Phase 3 must say so.
- **npm resolution:** PATH first, then `$SHELL -ilc 'command -v npm'`, then `/opt/homebrew/bin/npm` and `/usr/local/bin/npm`. A missing npm maps to the `unavailable` status with a user-readable reason.
- **Consent:** stored device-local in `userData/devices/consent.json`, not in `configStore`, because the installs it authorizes are device-local. `agentAccess` requires `streaming`.
- **Statuses:** `stopped` was added. It means consent is granted and the hub is installed, but the hub is not running. `DeviceHost.hubInstalled()` lets `refresh` start an installed hub without contacting npm. Only the consent action installs.
- **Listing:** devices come from `xcrun simctl list devices --json`, not the hub. Only available iOS runtimes are listed, booted devices first.
- **Open:** the service boots through the hub (`POST /api/devices/boot`) when the device is not booted. It then always calls `POST /vendor/serve-sim/grid/api/start`, because the stream helper must attach before any snapshot or stream. Main makes both calls directly; neither is proxied.
- **Proxy:** the input WebSocket is per device (`/vendor/serve-sim/helper/<udid>/ws`). WebSockets are piped as raw sockets that forward the `sec-websocket-*` handshake headers. HTTP responses carry CORS for the allowed renderer origins (`file://` and the dev server), and OPTIONS preflights return 204. Grants are random 32-byte tokens with a 60-second lifetime.
- **`streamGrant()`** is async, because it starts the proxy lazily on first use.
- **IPC seam:** the Electron-free registration lives in `main/services/devices/device-ipc.ts` (tested). `main/handlers/devices.ts` only wires Electron, and `shutdownDevices()` joins the app's shutdown.
- **Acceptance:** `node --import tsx scripts/devices-acceptance.mjs --allow-npm-install [--base-dir <dir>] [--udid <udid>] [--shutdown]`.

---

## Phase 3: Live stream and user controls in the Simulator tab

Write a detailed task breakdown for this phase in `docs/plans/simulator-devices-phase-3.md` after Phase 0 fixes the decoder path. Its scope, which must be covered:

- **Setup flow in `DevicesPanel`:** status rows for Xcode availability, then "Set up simulator streaming" (consent + install progress with `installing`/`starting` detail), then the device list. The device list shows booted devices first, with Boot/Open and an iPhone/iPad glyph.
- **`renderer/lib/device-stream.ts`:** port T3 `packages/client-runtime/src/device/stream.ts` (iOS path only): the AVCC envelope parser feeding a WebCodecs `VideoDecoder` onto a canvas, the MJPEG `<img>` fallback when `isConfigSupported` fails, and the binary input WebSocket for touch/press/type. Port its `stream.test.ts` and `streamFrames.test.ts` cases.
- **`useDeviceControls` + `DeviceControlsRail`:** port T3's Home, Lock, rotate, screenshot to chat attachment, and appearance (light/dark). `main/services/devices/device-actions.ts` implements these as typed `simctl` actions (`ui appearance`, `io screenshot`, `openurl`, `privacy grant`); the one-exec-per-action rule from T3 `DeviceActions.ts` applies.
- **Trackpad input:** port T3 `phoneTrackpad.ts` and its tests.
- **Lifecycle:** the grant is minted only while `active`; tab hide pauses decode; leaving the chat keeps the session; closing the chat closes its sessions but leaves simulators running.
- **Tests:** stream parser units, a `DevicesPanel` state-machine render test for each `DeviceHostStatus`, and an Electron E2E that uses a fake hub serving a canned MJPEG to verify frame paint, the input message, and reconnect.

### Phase 3 as built (deviations from the task text)

- **Trackpad deferred to Phase 6.** T3 `phoneTrackpad.ts` only maps wheel and pinch gestures to orbit and zoom of the 3D model. The flat viewer sends touches from pointer events instead.
- **Actions:** `device-actions.ts` covers `setAppearance`, `setTextSize`, `setIncreaseContrast`, `openUrl`, `setPermission` (the `simctl privacy` services), `setLocation`, and `clearLocation`. Each is one `xcrun simctl` argv with no shell, and it only reaches a device that the last listing reported as booted. Screenshots come from the hub (`/vendor/serve-sim/api/screenshot`), not `simctl io`, because the hub already owns capture.
- **Screenshot to chat** goes through `renderer/lib/composer-attach.ts`, a per-chat registry, not a window event. The composer registers while it can accept images, and delivery needs exactly one available receiver for that chat. Files enter through the composer's existing clipboard-image path, so limits and model checks still apply. With no receiver, a toast explains why.
- **Lifecycle:** the viewer gets `active && document visible`. Going inactive stops the client (decoder, sockets, and MJPEG `<img>`) and stops minting grants. A 401/403 response or a 1006/1008/4401 close renews the grant at most three times a minute before showing **Reconnect**. `chats:remove` calls `closeDeviceSessionsForChat`.
- **E2E seam:** no production switch was added. `tests/e2e/environment-devices-stream.spec.ts` pre-seeds consent and an "installed" `expo-device-hub` entry that imports `tests/e2e/device-hub-fake.mjs`, and puts a fake `xcrun` on PATH. Aiden's real host, proxy, stream client, and viewer run unchanged. The fake AVCC stream advertises an unsupported H.264 profile, which forces the real MJPEG fallback.
- **Origin:** Playwright saw no `Origin` header on the renderer's AVCC fetch from the `file://` page, and the proxy accepted every stream and input request. The proxy passes a request with no Origin and refuses one that is present but not on the allowlist, so both outcomes are safe.

---

## Phase 3.5: Simulator controls parity (no 3D)

This phase ports T3 nightly's flat-viewer controls. Nothing here depends on three.js.

- **Duo:** `renderer/lib/device-duo-control.ts` ports T3 `duoControl.ts`. It keeps one command in flight, replaces a queued command with the latest one, and fails with "Device control timed out. Its position is unknown." after 5 s. `device-stream.ts` parses the optional hinge fields in the screen config and sends `0x10` tagged JSON. It routes `0x90` control replies to the queue. On a hinged device, **Rotate** goes through the queue as an orientation command, and the next screen config acknowledges it. `DeviceDuoControls` overlays two pose groups (fold shape and stance) on the stage. It uses Aiden's own glyphs, because T3's derive from third-party art.
- **Device tools drawer:** `DeviceToolsPanel` is a toggle on the rail with `aria-controls="device-tools"`. It has these sections:
  - **App:** the frontmost app, Quit and Relaunch, Open URL, and launch by bundle ID.
  - **Simulator:** appearance, text size, Liquid Glass, color filter, and the Reduce Motion, Increase Contrast, Reduce Transparency, Show Borders, and VoiceOver switches.
  - **Location:** presets, set, and clear.
  - **Permissions:** grant, revoke, and reset, including notifications.
  - **Push notification:** sends to the frontmost app.

  The rail also gains a **Text size** menu.
- **State:** `renderer/lib/device-controls.ts` (`createDeviceControls` and `useDeviceControls`) runs one action at a time. It drops results that arrive after the drawer hides and re-reads settings on reopen. The frontmost app comes from serve-sim's `/appstate` SSE, which `device-foreground.ts` reads through the token proxy using `fetch`. It uses `fetch` rather than `EventSource` because `file://` pages send an unreliable Origin. The feed runs only while the drawer is open.
- **Main:**
  - Accessibility switches, Liquid Glass, and color filter spawn serve-sim's bundled `serve-sim-ax-settings` helper inside the simulator (`simctl spawn`).
  - Notification permission runs serve-sim's CLI as Node.
  - Push sends its APNs payload on stdin.
  - Every one of these is still a typed action with no shell and no exec route.
- **Deferred:**
  - The accessibility-tree overlay.
  - The event log panel.
  - Host diagnostics.
  - Float over chat.
  - Duo pinch and dual-panel streams.
  - The 3D trackpad (Phase 6).

---

## Phase 4: Agent tools

### Task 4.1: `device-tools.ts` pure pieces (TDD)

**Produces:**

```ts
export const DEVICE_TOOL_NAMES = ["device_list", "device_open", "device_screenshot", "device_close"] as const;
export const DEVICE_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set(["device_open", "device_close"]);
export const isDeviceToolName: (name: string) => boolean;
export const DEVICE_AGENT_GUIDANCE: string; // ≤ 5 lines
export function canUseDeviceTools(input: { enabled: boolean; agentAccess: boolean; permission: string; rendererOwner: boolean; assistantMode: boolean; bot: boolean }): boolean;
export function agentDeviceTargetArgs(device: DeviceSummary): string[]; // ["--platform","ios","--udid",id]
export function agentDeviceQuickStart(device: DeviceSummary, targetArgs: string[], command: string): string;
export function deviceToolApprovalSummary(name: string): string;
```

Test cases:
- `canUseDeviceTools` is false when any gate is false, including `permission: "read"`, bots, and assistant mode.
- `agentDeviceQuickStart` single-quotes a command path containing spaces or `'`. It includes `snapshot -i`, `click @e3`, and `fill @e5` lines, the "do not call simctl, xcrun, or serve-sim" line, and the XCTest first-use note, and it contains no Android lines.
- The target args quote a UDID that has shell metacharacters.

Port the wording from T3 `handlers.ts:14-60`, replacing "T3" with "Aiden" and "Device panel" with "Simulator tab".

### Task 4.2: Tool factory and execution

`createDeviceAgentTools(context: DeviceToolContext): AgentTool[]` follows the `createBrowserAgentTools` shape: a fixed `workspaceId`, `chatId`, and `generationId`, a `port: DeviceService`, `signal`, and `supportsImages`.
- `device_list` returns hosts, devices, and the `open` entries for this chat. If consent is missing it returns the error "Device support is off. Ask the user to enable it in the Simulator tab."
- `device_open` picks a device (the explicit id, then a booted device, then the first), ensures the agent is ready, and opens a session with `openedBy: "agent"`. It returns `{device, agentDevice: {command, targetArgs}, quickStart}` and shows the Simulator tab through the existing `showTools` event path used by the Browser `show` event.
- `device_screenshot` returns an image content block when `supportsImages` is true; otherwise it saves the image to a temp path and returns that path.
- `device_close` accepts `shutdown?: boolean`.
- Every tool honors `signal`.

Wire it in `main/services/llm-client.ts` next to the browser block (≈ lines 1065–1149): append `DEVICE_AGENT_GUIDANCE` to the system prompt only when the tools are admitted, add the names to the approval routing at ≈2582/2720, and add the tools to `disclosedBrowserTools`' sibling list. Subagents do **not** get device tools in v1; record that as an explicit exclusion in `main/services/subagents/request-capabilities-v2.ts` tests.

### Task 4.3: `agent-device-shim.ts` and PATH injection

Port T3 `AgentDeviceShim.ts`. It writes `<devicesDir>/bin/agent-device`, a POSIX `sh` script that execs the Phase 0 Node runtime with a launcher `.mjs`. The launcher refuses to run unless both `--config` and `--session` are present (help and version excepted) and strips the `AGENT_DEVICE_DAEMON_*` and `AGENT_DEVICE_CONFIG` env vars.

Prepend the shim dir to the `PATH` used by the agent's shell tool (`main/services/coding-tools.ts:1614`, `env: process.env`) **only** when `canUseDeviceTools` held at generation start, so the environment is fixed at spawn, as T3 documents. Also return the absolute command path from `device_open`, because login shells may reset `PATH`.

Tests cover: the shim's content and mode `0755`; the launcher refusing to run without the flags (execute it with a fake entry script); the PATH being unchanged when the gate is false; and quoting paths with spaces.

### Task 4.4: Agent E2E with a fake hub and a fake agent-device

A Playwright Electron test uses the faux provider pattern from the existing browser agent E2Es. It asserts that the agent calls `device_open`, that an approval appears under `"ask"`, that the Simulator tab opens and shows the session, that `device_screenshot` returns an image, and that revoking agent access mid-chat makes the next `device_open` fail with the consent message.

### Phase 4 as built (deviations from the task text)

- **Files:** `main/services/devices/device-tools.ts` (names, gate, guidance, quick start, `createDeviceAgentTools`) and `agent-device-shim.ts` (launcher, shim, per-host config, per-chat session), both adapted from T3 `handlers.ts`, `tools.ts`, `AgentDeviceShim.ts`, and `AgentDeviceTarget.ts`.
- **Consent:** the Simulator tab's ready state has a **Let Aiden use simulators** switch. Turning it on is the only path that installs `agent-device` from npm (`grantConsent("agentAccess")`), and the switch's description says so. `device_open` and `agentTarget` never install. When agent-device is missing, they tell the agent to ask the user to toggle access.
- **Gate:** `canUseDeviceTools` is checked when a generation starts (flag, consent, `full`/`ask` permission, renderer owner, not assistant mode, not a bot). Each tool call rechecks consent and that the generation is still active. `DEVICE_AGENT_GUIDANCE` is 3 lines. The long quick start is in the `device_open` result, not the system prompt.
- **Port:** the tools depend on a narrow `DeviceToolPort` rather than the whole `DeviceService`. `device_open` resolves the agent target first, so a missing install fails before a session opens. It then opens with `openedBy: "agent"` and reveals the Simulator tab via a new `devices:reveal` broadcast, filtered to the active chat in `environment-panel.tsx`.
- **Screenshots:** without vision support, `device_screenshot` writes a 0600 PNG and returns its path.
- **PATH:** `buildCodingTools(root, observer, { pathPrefix })` prepends the shim dir only for `run_command` in generations where the gate held. The launcher refuses to run without `--config` and `--session` (except `--help` and `--version`) and strips the `AGENT_DEVICE_DAEMON_*` and `AGENT_DEVICE_CONFIG` env vars.
- **Approvals:** under Ask first, `device_open` and `device_close` need approval, with summaries from `deviceToolApprovalSummary`. Subagents never get device tools; `request-capabilities-v2.test.ts` pins this.
- **E2E:** `tests/e2e/environment-devices-agent.spec.ts` seeds `tests/e2e/agent-device-fake.mjs` as the installed agent-device next to the fake hub. It covers: no device tools before consent, the switch, `device_list`/`open`/`screenshot`, the pinned shim on PATH, the launcher refusal, the auto-reveal, the Ask-first approval for `device_close`, and tools removed after revoke. The mid-generation revoke is covered by unit tests (`device-tools.test.ts`), not the E2E. The faux LM Studio now skips pi-ai's "Attached image(s) from tool result:" user carrier when matching a scenario prompt.

**Phase 4 exit:** manual acceptance on a real simulator. Ask Aiden to "open the Settings app on the simulator and turn on Dark Mode", and confirm that it opens a device, drives it through `agent-device`, and verifies the result with `device_screenshot`. Record the evidence in memory. After this gate, decide whether to flip the flag default.

---

## Phase 5: SSH device hosts

This phase gets a separate detailed plan, `docs/plans/simulator-devices-phase-5-ssh.md`, written after Phase 4. Its scope:
- Port T3 `SshDeviceHost.ts`, `sshDeviceScript.ts`, `localSshDeviceHost.ts`, and their tests behind the Phase 2 `DeviceHost` interface. The remote host runs the pinned hub and agent-device under its own Node. Both endpoints are forwarded to loopback with `ssh -L`, and the proxy and tools stay unchanged apart from carrying `hostId`.
- Settings → **Simulator hosts** (new section per `docs/settings-design-system.md`): add/edit/remove `{id, label, destination(user@host), port?, identityFile?}`, "Test connection", and per-host tool versions (port T3 `DeviceHostsSettings.tsx`, `DeviceHostAvailability.tsx`, and `DeviceToolVersions.tsx`).
- Uses the system `ssh` binary with the user's own config and agent. Aiden stores no private keys and no passwords. `BatchMode=yes` means an interactive prompt surfaces as a clear error.
- Before starting this phase, check `main/services/peer-host-registry.ts` for reusable host-identity or storage patterns.

## Phase 6: 3D device frames

This phase also gets its own plan, `docs/plans/simulator-devices-phase-6-3d.md`. Its scope:
- Add `three` (MIT) and port T3 `phoneViewer.ts`, `phoneScene.ts`, `modelScene.ts`, `deviceFraming.ts`, `deviceMotion.ts`, `renderScheduler.ts`, `shapeProfile.ts`, `deviceViewSnap.ts`, `screenshot.ts`, and their tests. The live stream canvas becomes the screen texture.
- **Licensing blocker:** T3's `models/*.glb` are converted Apple AR assets and ship with "No open-source or redistribution license". Do **not** copy them. Options for the Phase 6 plan: (a) procedural bezels generated from `shapeProfile.ts` corner radii, which is the recommended default; (b) Aiden-authored GLBs; or (c) a user-supplied model directory. Duo and foldable viewers stay out of scope because they are Android-oriented or hypothetical hardware.
- Respect `prefers-reduced-motion` (a static frame with no parallax) and cap the render loop to visible, active tabs only.

## Phase 7: Settings, onboarding, docs, and release

- Settings → **Simulator**: consent toggles (streaming, agent access), tool versions with update/prune, and "Remove installed tools".
- Onboarding: add a concise disclosure that turning on the Simulator installs npm tools, plus a feature-tour bento tile with a new 1024×1024 transparent PNG in `renderer/assets/onboarding/`. Extend the onboarding asset contract test. Do this only once the flag defaults on.
- Docs: `docs/devices.md` (user) and an internals section adapted from T3 `docs/internals/devices.md`.
- `THIRD_PARTY_NOTICES.md`: T3 Code (MIT), expo-device-hub (MIT), and agent-device (MIT). Keep the index row in `docs/plans/README.md` and `.memory/simulator-devices.md` current.

## Risks

| Risk | Mitigation |
| --- | --- |
| `node-datachannel` native ABI mismatch under Electron's Node | Phase 0.1 decides the runtime before any code depends on it |
| `npm` missing in the packaged app's environment | Phase 0.1 fallback: integrity-pinned tarball plus a vendored lockfile |
| The hub's unauthenticated exec route | Loopback-only bind, a proxy allowlist, and an adversarial proxy test suite (Task 2.4) |
| The agent bypasses tools with raw `simctl` | Prompt line, `device_open` guidance, and the shim; no hard block (the agent's shell is general-purpose by design) |
| XCTest runner build is slow on first `agent-device` use | Quick-start note; Phase 0.3 measures it |
| Apple model licensing | Never bundle T3 GLBs (Phase 6) |
