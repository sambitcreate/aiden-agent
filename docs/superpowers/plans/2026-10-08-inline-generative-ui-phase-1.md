# Inline Generative UI — Phase 1 (Desktop Inline HTML Upgrade) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `render_artifact` visuals appear inline at their tool-call position, size themselves to their content, look and re-theme like native Aiden UI, stream while being written, and send safe follow-up prompts. Make them available in every desktop chat under an "Inline visuals" setting.

**Architecture:** This builds on the existing sandboxed `aiden-genui:` pipeline and keeps its security model. Changes by layer:
- **Shared contracts (`renderer/shared/`):**
  - a closed guest↔host bridge schema
  - an allowlisted theme-variable kit
  - a separate artifact→tool-call placement record
- **Main:** host-injected bridge script in the guest document, streamed draft previews from `toolcall_delta`, a generated `aiden-ui.css` host library, relaxed gating, and an on-demand `visualize_guide` tool.
- **Renderer:** visuals placed inside the chronological assistant rows, and the frame rebuilt as a borderless, auto-height, live-themed inline visual.

**Tech Stack:** Electron 3x, React 19, Tailwind 4, `node:test` via `tsx --test`, `renderToStaticMarkup`, and Playwright (Chromium) for containment.

**Spec:** [`docs/superpowers/specs/2026-10-08-inline-generative-ui-design.md`](../specs/2026-10-08-inline-generative-ui-design.md). Phase 1 covers spec §6 and §7.

## Global Constraints

- The HTML a model writes must never reach the renderer process as a string. The renderer sees only `aiden-genui://preview/<64-hex>` URLs, and this includes drafts.
- Guest CSP keeps `connect-src 'none'`, `frame-src 'none'` and `form-action 'none'`; host libraries load only from `aiden-genui://<name>`.
- iframe `sandbox` stays exactly `"allow-scripts"`.
- Guest→host messages are accepted only when `event.source === iframe.contentWindow` and the payload parses through `parseGuestBridgeMessage`.
- Do not add keys to `ChatHtmlArtifactV1`. Older builds drop a message's whole artifact list on an unknown key (spec §13). Placement lives in `ChatMessage.htmlArtifactPlacements`.
- `wrapGenerativeUiHtml(html, title, theme)` keeps working with today's three-argument call and four-color theme, because Design Studio (`main/services/design/design-preview.ts`) calls it.
- UI rules from AGENTS.md: shared squircle `Button`; no decorative borders or outlines; keep `focus-visible` rings; activity uses `AidenActivityMark`; semantic tokens only; Settings follow `docs/settings-design-system.md`.
- Review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before restyling the frame (Task 6).
- No new runtime dependencies. No network access added.
- Height bounds: `MIN_INLINE_VISUAL_HEIGHT = 64`, `MAX_INLINE_VISUAL_HEIGHT = 1600` (px).
- Prompt bounds: `MAX_GUEST_PROMPT_CHARS = 2000`, `GUEST_PROMPT_COOLDOWN_MS = 3000`.
- Draft throttle: `GENERATIVE_UI_DRAFT_THROTTLE_MS = 250`.
- Every new test file goes into the `test:generative-ui` script in `package.json`, which `scripts/ci-test-registry.json` already lists as the `generative-ui-chromium` lane. Run `npm run test:ci-policy` after editing `package.json`.

## Review Focus

1. **Visual re-rendered after a theme change while expanded.** The theme message must reach the frame whether it is inline or in the top-layer popover, with no reload, so no state is lost. Test: Task 6, Step 1, `theme update reaches a mounted frame without changing src`.
2. **Old chats and forked or copied chats.** Artifacts with no placement, or a placement whose `toolCallId` no longer matches any timeline step, must still render after the message, exactly once. Forks must remap `mediaId` in placements too. Tests: Task 3 `unplaced and orphaned artifacts trail the message once`, and Task 2 `copy remaps placement mediaIds`.
3. **A guest spamming `sendPrompt` or `resize`.** Unfocused or rapid prompts are rejected; huge or NaN heights clamp. Tests: Task 1 `decideGuestPrompt` matrix and `clampInlineVisualHeight` bounds.
4. **A streaming draft containing `<script>`.** It must not execute before the final artifact. Test: Task 8 Playwright `draft preview does not run model scripts`.
5. **Same-title replace mid-turn with a draft open.** Draft, then present, then a later replace must leave one frame in the step slot, not two. Test: Task 8 `present clears the draft for its toolCallId`.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/shared/generative-ui-bridge.ts` (new) | Closed guest↔host message schema, height clamp, `sendPrompt` admission policy |
| `renderer/shared/generative-ui-theme.ts` (new) | Allowlisted theme variable names, value validation, snapshot helper type |
| `renderer/shared/chat-artifacts.ts` | `HtmlArtifactPlacementV1`, lenient placement parser, `present.toolCallId?`, `draft` event |
| `renderer/shared/generative-ui.ts` | Add `aiden-ui.css` host lib name, draft CSP builder, bridge constants re-export |
| `main/services/generative-ui-html.ts` | Bridge script injection (nonce), full theme vars, transparent canvas, draft document head |
| `main/services/generative-ui-kit.ts` (new) | Generated `aiden-ui.css` class kit string |
| `main/services/generative-ui-host-libraries.ts` | Serve `aiden-ui.css` from the kit |
| `main/services/generative-ui-protocol.ts` | Streaming draft documents |
| `main/services/generative-ui-extension.ts` | `onArtifact` gets `toolCallId`; gating without workspace; `visualize_guide` tool; new prompt |
| `main/services/generative-ui-guide.ts` (new) | Guide module text |
| `main/services/llm-client.ts` | Placement collection and persistence, draft streaming on `toolcall_delta`, inline-visuals mode gating |
| `main/services/types.ts`, `renderer/lib/types.ts`, `main/services/chat-store-core.ts`, `main/services/visible-chat-projection.ts`, `main/services/chat-fork-service.ts` | `htmlArtifactPlacements` field: persist, parse, copy and fork remap |
| `renderer/lib/html-artifact-transcript.ts` | `htmlArtifactSlots()` placement into presentation rows |
| `renderer/components/message-list.tsx` | Render the slots after their activity rows and trailing artifacts after the message |
| `renderer/components/html-artifact-frame.tsx` | Rebuilt as `InlineHtmlVisual`: auto-height, borderless, hover toolbar, theme broadcast, prompt relay |
| `renderer/main/chat-pane.tsx`, `renderer/lib/generation-stream.ts`, `renderer/lib/chat-terminal-sync.ts` | Draft and placement state; prompt send-or-stage |
| `renderer/shared/appearance.ts`, `renderer/components/settings/appearance-settings.tsx` | `inlineVisuals` setting |
| `main/handlers/chat-params.ts`, `renderer/shared/slash-commands.ts`, `renderer/lib/slash-command-actions.ts` | Pass and validate the mode; `/visualize` availability |
| `tests/generative-ui/containment.spec.ts` | Bridge, draft and theme containment cases |
| `docs/pi-gui-artifacts.md`, `docs/plans/README.md`, `docs/plans/generative-ui-artifacts-plan.md`, `.memory/inline-generative-ui.md` | Docs and status |

---

### Task 1: Guest↔host bridge contract

**Files:**
- Create: `renderer/shared/generative-ui-bridge.ts`
- Create: `renderer/shared/generative-ui-bridge.test.ts`
- Modify: `package.json` (`test:generative-ui`: add `renderer/shared/generative-ui-bridge.test.ts`)

**Interfaces:**
- Produces:
  - `GENERATIVE_UI_RESIZE_MESSAGE = "aiden:generative-ui:resize"`
  - `GENERATIVE_UI_PROMPT_MESSAGE = "aiden:generative-ui:prompt"`
  - `GENERATIVE_UI_THEME_MESSAGE = "aiden:generative-ui:theme"`
  - `type GuestBridgeMessage = { type: "escape" } | { type: "resize"; height: number } | { type: "prompt"; text: string }`
  - `parseGuestBridgeMessage(data: unknown): GuestBridgeMessage | undefined`
  - `clampInlineVisualHeight(height: number): number`
  - `decideGuestPrompt(input: GuestPromptInput): GuestPromptDecision`
  - The constants `MIN_INLINE_VISUAL_HEIGHT`, `MAX_INLINE_VISUAL_HEIGHT`, `MAX_GUEST_PROMPT_CHARS` and `GUEST_PROMPT_COOLDOWN_MS`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/shared/generative-ui-bridge.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "./generative-ui.js";
import {
  GUEST_PROMPT_COOLDOWN_MS,
  MAX_GUEST_PROMPT_CHARS,
  MAX_INLINE_VISUAL_HEIGHT,
  MIN_INLINE_VISUAL_HEIGHT,
  clampInlineVisualHeight,
  decideGuestPrompt,
  parseGuestBridgeMessage,
} from "./generative-ui-bridge.js";

test("bridge accepts the legacy escape string and typed messages only", () => {
  assert.deepEqual(parseGuestBridgeMessage(GENERATIVE_UI_ESCAPE_MESSAGE), { type: "escape" });
  assert.deepEqual(
    parseGuestBridgeMessage({ type: "aiden:generative-ui:resize", height: 412.6 }),
    { type: "resize", height: 412.6 },
  );
  assert.deepEqual(
    parseGuestBridgeMessage({ type: "aiden:generative-ui:prompt", text: "Drill into EMEA" }),
    { type: "prompt", text: "Drill into EMEA" },
  );
  for (const bad of [
    null,
    "aiden:generative-ui:resize",
    { type: "aiden:generative-ui:resize" },
    { type: "aiden:generative-ui:resize", height: "400" },
    { type: "aiden:generative-ui:resize", height: 400, extra: true },
    { type: "aiden:generative-ui:prompt", text: 42 },
    { type: "aiden:generative-ui:theme", vars: {} },
    { type: "aiden:other" },
  ]) {
    assert.equal(parseGuestBridgeMessage(bad), undefined, JSON.stringify(bad));
  }
});

test("inline visual height clamps hostile values into the visible range", () => {
  assert.equal(clampInlineVisualHeight(Number.NaN), MIN_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(-5), MIN_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(Number.POSITIVE_INFINITY), MAX_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(1e9), MAX_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(300.4), 301);
});

test("guest prompts need focus, content, size, and cooldown; busy chats stage", () => {
  const base = { text: "Explain the spike", frameFocused: true, chatBusy: false, now: 10_000 };
  assert.deepEqual(decideGuestPrompt(base), { action: "send", text: "Explain the spike" });
  assert.deepEqual(decideGuestPrompt({ ...base, chatBusy: true }), {
    action: "stage",
    text: "Explain the spike",
  });
  assert.deepEqual(decideGuestPrompt({ ...base, frameFocused: false }), {
    action: "reject",
    reason: "unfocused",
  });
  assert.deepEqual(decideGuestPrompt({ ...base, text: "   " }), { action: "reject", reason: "empty" });
  assert.deepEqual(decideGuestPrompt({ ...base, text: "x".repeat(MAX_GUEST_PROMPT_CHARS + 1) }), {
    action: "reject",
    reason: "too_long",
  });
  assert.deepEqual(
    decideGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS + 1 }),
    { action: "reject", reason: "cooldown" },
  );
  assert.equal(
    decideGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS }).action,
    "send",
  );
  assert.deepEqual(decideGuestPrompt({ ...base, text: "  trim me \n" }), {
    action: "send",
    text: "trim me",
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/shared/generative-ui-bridge.test.ts`
Expected: FAIL with `Cannot find module './generative-ui-bridge.js'`.

- [ ] **Step 3: Implement**

```ts
// renderer/shared/generative-ui-bridge.ts
/** Closed guest↔host message contract for inline Generative UI frames. */
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "./generative-ui.js";

export const GENERATIVE_UI_RESIZE_MESSAGE = "aiden:generative-ui:resize" as const;
export const GENERATIVE_UI_PROMPT_MESSAGE = "aiden:generative-ui:prompt" as const;
export const GENERATIVE_UI_THEME_MESSAGE = "aiden:generative-ui:theme" as const;

export const MIN_INLINE_VISUAL_HEIGHT = 64;
export const MAX_INLINE_VISUAL_HEIGHT = 1600;
export const MAX_GUEST_PROMPT_CHARS = 2000;
export const GUEST_PROMPT_COOLDOWN_MS = 3000;

export type GuestBridgeMessage =
  | { type: "escape" }
  | { type: "resize"; height: number }
  | { type: "prompt"; text: string };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

export function parseGuestBridgeMessage(data: unknown): GuestBridgeMessage | undefined {
  if (data === GENERATIVE_UI_ESCAPE_MESSAGE) return { type: "escape" };
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.type === GENERATIVE_UI_RESIZE_MESSAGE && exactKeys(record, ["type", "height"])) {
    return typeof record.height === "number" ? { type: "resize", height: record.height } : undefined;
  }
  if (record.type === GENERATIVE_UI_PROMPT_MESSAGE && exactKeys(record, ["type", "text"])) {
    return typeof record.text === "string" ? { type: "prompt", text: record.text } : undefined;
  }
  return undefined;
}

export function clampInlineVisualHeight(height: number): number {
  if (Number.isNaN(height)) return MIN_INLINE_VISUAL_HEIGHT;
  return Math.min(MAX_INLINE_VISUAL_HEIGHT, Math.max(MIN_INLINE_VISUAL_HEIGHT, Math.ceil(height)));
}

export interface GuestPromptInput {
  text: string;
  /** True only while `document.activeElement` is this frame (focus moved in by a user gesture). */
  frameFocused: boolean;
  chatBusy: boolean;
  now: number;
  lastAcceptedAt?: number;
}

export type GuestPromptDecision =
  | { action: "send" | "stage"; text: string }
  | { action: "reject"; reason: "unfocused" | "empty" | "too_long" | "cooldown" };

export function decideGuestPrompt(input: GuestPromptInput): GuestPromptDecision {
  if (!input.frameFocused) return { action: "reject", reason: "unfocused" };
  const text = input.text.trim();
  if (!text) return { action: "reject", reason: "empty" };
  if (input.text.length > MAX_GUEST_PROMPT_CHARS) return { action: "reject", reason: "too_long" };
  if (input.lastAcceptedAt !== undefined && input.now - input.lastAcceptedAt < GUEST_PROMPT_COOLDOWN_MS) {
    return { action: "reject", reason: "cooldown" };
  }
  return { action: input.chatBusy ? "stage" : "send", text };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test renderer/shared/generative-ui-bridge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register and commit**

Append ` renderer/shared/generative-ui-bridge.test.ts` to the `tsx --test` file list in `package.json` → `test:generative-ui`, then run `npm run test:ci-policy` (expected PASS).

```bash
git add renderer/shared/generative-ui-bridge.ts renderer/shared/generative-ui-bridge.test.ts package.json
git commit -m "feat(generative-ui): add closed guest bridge contract"
```

---

### Task 2: Artifact → tool-call placement record

**Files:**
- Modify: `renderer/shared/chat-artifacts.ts` (types and parsers; `present` event `toolCallId?`)
- Modify: `renderer/shared/chat-artifacts.test.ts`
- Modify: `main/services/generative-ui-extension.ts` (`onArtifact(artifact, html, { toolCallId })`)
- Modify: `main/services/generative-ui-extension.test.ts`
- Modify: `main/services/llm-client.ts` (collect placements around `onArtifact` ~1754; persist beside `htmlArtifacts` at ~2316; include `toolCallId` in the `present` event)
- Modify: `main/services/types.ts:326`, `renderer/lib/types.ts:625` (add `htmlArtifactPlacements?: HtmlArtifactPlacementV1[]`)
- Modify: `main/services/chat-store-core.ts` (parse at ~842 and ~1690; copy remap at ~1412)
- Modify: `main/services/visible-chat-projection.ts:161`
- Modify: `main/services/chat-fork-service.ts` (remap placement `mediaId` wherever `htmlArtifacts` are remapped, ~194–248)
- Test: `main/services/chat-store-core*.test.ts` (whichever suite covers `htmlArtifacts` copy; find with `grep -ln "htmlArtifacts" main/services/*.test.ts`)

**Interfaces:**
- Produces:
  - `interface HtmlArtifactPlacementV1 { mediaId: string; toolCallId: string }`
  - `parseHtmlArtifactPlacements(value: unknown): HtmlArtifactPlacementV1[] | undefined`. This parser is **lenient**: it drops invalid entries one by one and returns `undefined` only for a non-array or an empty result.
  - `ChatArtifactEventV1` `present` gains `toolCallId?: string`.
  - `GenerativeUiExtensionOptions.onArtifact(artifact, html, context: { toolCallId: string })`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Confirm the downgrade hazard this design avoids**

Run: `grep -n "parseChatHtmlArtifacts" -A12 renderer/shared/chat-artifacts.ts`
Expected: the function returns `undefined` when any entry fails `parseChatHtmlArtifactV1`, which confirms that adding a key to `ChatHtmlArtifactV1` would erase artifacts in older builds. Do not change that function.

- [ ] **Step 2: Write the failing tests**

Add to `renderer/shared/chat-artifacts.test.ts`:

```ts
import { parseChatArtifactEventV1, parseHtmlArtifactPlacements } from "./chat-artifacts.js";

const MEDIA = "a".repeat(64);

test("placements keep valid entries and drop malformed ones individually", () => {
  assert.equal(parseHtmlArtifactPlacements(undefined), undefined);
  assert.equal(parseHtmlArtifactPlacements("nope"), undefined);
  assert.deepEqual(
    parseHtmlArtifactPlacements([
      { mediaId: MEDIA, toolCallId: "call_1" },
      { mediaId: MEDIA, toolCallId: "call_dup" },
      { mediaId: "bad id with spaces", toolCallId: "call_2" },
      { mediaId: "b".repeat(64), toolCallId: "" },
      { mediaId: "c".repeat(64), toolCallId: "call_3", extra: 1 },
      { mediaId: "d".repeat(64), toolCallId: "call_4" },
    ]),
    [
      { mediaId: MEDIA, toolCallId: "call_1" },
      { mediaId: "d".repeat(64), toolCallId: "call_4" },
    ],
  );
  assert.equal(parseHtmlArtifactPlacements([{ mediaId: "x", toolCallId: 1 }]), undefined);
});

test("present events may carry the producing toolCallId", () => {
  const artifact = {
    version: 1, kind: "html", id: "e".repeat(64), title: "Chart",
    mimeType: "text/html", size: 10, mediaId: MEDIA,
  };
  const parsed = parseChatArtifactEventV1({ version: 1, operation: "present", artifact, toolCallId: "call_9" });
  assert.equal(parsed?.operation === "present" && parsed.toolCallId, "call_9");
  assert.equal(
    parseChatArtifactEventV1({ version: 1, operation: "present", artifact, toolCallId: "" }),
    undefined,
  );
});
```

Add to `main/services/generative-ui-extension.test.ts`, next to the existing metadata-only result test (reuse that file's runtime factory helper):

```ts
test("onArtifact receives the producing toolCallId", async () => {
  const seen: string[] = [];
  const runtime = createGenerativeUiExtensionRuntime({
    ...baseOptions(),
    onArtifact: async (_artifact, _html, context) => {
      seen.push(context.toolCallId);
      return true;
    },
  });
  await executeTool(runtime, "call_abc", { title: "T", html: "<p>x</p>" });
  assert.deepEqual(seen, ["call_abc"]);
});
```

If the file's helpers are named differently, use its existing equivalents. The assertion is what matters.

Add a copy test in the store suite that already covers `htmlArtifacts` copy:

```ts
test("copy remaps placement mediaIds with their artifacts", async () => {
  // Arrange: a source chat whose assistant message has one html artifact and
  // htmlArtifactPlacements [{ mediaId: <same>, toolCallId: "call_1" }].
  // Act: run the suite's existing copy helper.
  // Assert: the copied message's placement mediaId === the copied artifact's
  // mediaId, toolCallId is unchanged, and it differs from the source mediaId.
});
```

Write the arrange/act steps with the suite's existing fixture helpers; the three assertions above are mandatory.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test renderer/shared/chat-artifacts.test.ts main/services/generative-ui-extension.test.ts`
Expected: FAIL (`parseHtmlArtifactPlacements` not exported; `context` undefined).

- [ ] **Step 4: Implement the shared types and parsers**

In `renderer/shared/chat-artifacts.ts`:

```ts
export interface HtmlArtifactPlacementV1 {
  mediaId: string;
  toolCallId: string;
}

const PLACEMENT_KEYS = new Set(["mediaId", "toolCallId"]);
const PRESENT_EVENT_WITH_CALL_KEYS = new Set(["version", "operation", "artifact", "toolCallId"]);

function isToolCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/** Lenient on purpose: one bad placement must never hide the artifacts it points at. */
export function parseHtmlArtifactPlacements(value: unknown): HtmlArtifactPlacementV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const placements: HtmlArtifactPlacementV1[] = [];
  for (const entry of value.slice(0, 40)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!hasExactKeys(record, PLACEMENT_KEYS)) continue;
    if (!isHtmlArtifactMediaId(record.mediaId) || !isToolCallId(record.toolCallId)) continue;
    if (seen.has(record.mediaId)) continue;
    seen.add(record.mediaId);
    placements.push({ mediaId: record.mediaId, toolCallId: record.toolCallId });
  }
  return placements.length ? placements : undefined;
}
```

Extend the `present` variant to `{ ...; artifact: ChatArtifactV1; toolCallId?: string }`. In `parseChatArtifactEventV1`, accept either `PRESENT_EVENT_KEYS` or `PRESENT_EVENT_WITH_CALL_KEYS`, and when `toolCallId` is present require `isToolCallId`.

- [ ] **Step 5: Implement the producer and persistence**

1. `generative-ui-extension.ts`: change the option type to `onArtifact: (artifact: ChatHtmlArtifactV1, html: string, context: { toolCallId: string }) => Promise<boolean | void>` and the call to `options.onArtifact(artifact, html, { toolCallId })`. For a same-title replace, keep the **first** call's `toolCallId`, so the visual stays where it first appeared. Store it in `titlesInGeneration` next to `mediaId`.
2. `llm-client.ts`: beside `displayedHtmlArtifacts`, keep `const htmlArtifactPlacements = new Map<string, string>()` (mediaId → toolCallId). In `onArtifact`, `if (!htmlArtifactPlacements.has(artifact.mediaId)) htmlArtifactPlacements.set(artifact.mediaId, context.toolCallId)`, and add `toolCallId: htmlArtifactPlacements.get(artifact.mediaId)` to the `present` event. In `persistAssistant` (where `htmlArtifacts: displayedHtmlArtifacts` is written), add:
   ```ts
   htmlArtifactPlacements: displayedHtmlArtifacts.length
     ? displayedHtmlArtifacts.flatMap((a) => {
         const toolCallId = htmlArtifactPlacements.get(a.mediaId);
         return toolCallId ? [{ mediaId: a.mediaId, toolCallId }] : [];
       })
     : undefined,
   ```
3. `chat-store-core.ts` (both parse sites) and `visible-chat-projection.ts`: `htmlArtifactPlacements: assistant ? parseHtmlArtifactPlacements(message.htmlArtifacts ? message.htmlArtifactPlacements : undefined) : undefined`.
4. Copy (~1412) and fork (`chat-fork-service.ts`): map each placement's `mediaId` through the same `remappedHtmlArtifactMediaId(newChatId, …)` call used for its artifact.
5. Do **not** add placements to the Aiden Remote projection in this phase. The Remote contract is unchanged until Phase 3.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test renderer/shared/chat-artifacts.test.ts main/services/generative-ui-extension.test.ts` plus the store suite file edited in Step 2.
Then run: `npm run typecheck` (or `npx tsc -p tsconfig.json --noEmit` if no script exists).
Expected: PASS and no type errors.

- [ ] **Step 7: Commit**

```bash
git add renderer/shared/chat-artifacts.ts renderer/shared/chat-artifacts.test.ts main/services/generative-ui-extension.ts main/services/generative-ui-extension.test.ts main/services/llm-client.ts main/services/types.ts renderer/lib/types.ts main/services/chat-store-core.ts main/services/visible-chat-projection.ts main/services/chat-fork-service.ts main/services/*.test.ts
git commit -m "feat(generative-ui): record which tool call produced each artifact"
```

---

### Task 3: Place visuals inside the chronological rows

**Files:**
- Modify: `renderer/lib/html-artifact-transcript.ts` (add `htmlArtifactSlots`)
- Create: `renderer/lib/html-artifact-transcript.test.ts`
- Modify: `renderer/components/message-list.tsx` (`AssistantResponse` row loop ~170–215; `artifactFrames` ~497–549)
- Modify: `renderer/main/chat-pane.tsx` (keep `streamingArtifactPlacements: Map<mediaId, toolCallId>` from `present.toolCallId`, passed to `MessageList`)
- Modify: `package.json` (`test:generative-ui` += `renderer/lib/html-artifact-transcript.test.ts`)

**Interfaces:**
- Consumes: `HtmlArtifactPlacementV1` (Task 2), `AssistantPresentationRow` (`renderer/lib/assistant-message-presentation.ts`).
- Produces:
  - `htmlArtifactSlots(rows: readonly AssistantPresentationRow[] | null, artifacts: readonly ChatHtmlArtifactV1[], placements: ReadonlyMap<string, string>): { byRowKey: Map<string, ChatHtmlArtifactV1[]>; trailing: ChatHtmlArtifactV1[] }`
  - `AssistantResponse` prop `visualsForRow?: (rowKey: string) => React.ReactNode`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/lib/html-artifact-transcript.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import { htmlArtifactSlots } from "./html-artifact-transcript";

const artifact = (n: string): ChatHtmlArtifactV1 => ({
  version: 1, kind: "html", id: n.repeat(64), title: `A${n}`,
  mimeType: "text/html", size: 1, mediaId: n.repeat(64),
});
const toolStep = (toolCallId: string) => ({
  id: `s-${toolCallId}`, order: 0, kind: "tool" as const, toolCallId,
  toolName: "render_artifact", label: "Render artifact", status: "completed" as const,
  startedAt: 0, updatedAt: 0,
});
const rows: AssistantPresentationRow[] = [
  { key: "text-0", kind: "text", content: "Intro", startOffset: 0, endOffset: 5 },
  { key: "activity-5-a", kind: "activity", contentOffset: 5, steps: [toolStep("call_a")] },
  { key: "text-5", kind: "text", content: "Middle", startOffset: 5, endOffset: 11 },
  { key: "activity-11-b", kind: "activity", contentOffset: 11, steps: [toolStep("call_b"), toolStep("call_c")] },
];

test("placed artifacts land after the activity row that produced them", () => {
  const a = artifact("a"), b = artifact("b"), c = artifact("c");
  const slots = htmlArtifactSlots(rows, [a, b, c], new Map([
    [a.mediaId, "call_a"], [b.mediaId, "call_b"], [c.mediaId, "call_c"],
  ]));
  assert.deepEqual(slots.byRowKey.get("activity-5-a"), [a]);
  assert.deepEqual(slots.byRowKey.get("activity-11-b"), [b, c]);
  assert.deepEqual(slots.trailing, []);
});

test("unplaced and orphaned artifacts trail the message once", () => {
  const a = artifact("a"), legacy = artifact("l"), orphan = artifact("o");
  const slots = htmlArtifactSlots(rows, [legacy, a, orphan], new Map([
    [a.mediaId, "call_a"], [orphan.mediaId, "call_missing"],
  ]));
  assert.deepEqual(slots.byRowKey.get("activity-5-a"), [a]);
  assert.deepEqual(slots.trailing, [legacy, orphan]);
});

test("legacy messages without presentation rows trail everything", () => {
  const a = artifact("a");
  const slots = htmlArtifactSlots(null, [a], new Map([[a.mediaId, "call_a"]]));
  assert.equal(slots.byRowKey.size, 0);
  assert.deepEqual(slots.trailing, [a]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/lib/html-artifact-transcript.test.ts`
Expected: FAIL (`htmlArtifactSlots` is not exported).

- [ ] **Step 3: Implement `htmlArtifactSlots`**

Append to `renderer/lib/html-artifact-transcript.ts`:

```ts
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import { isToolStep } from "../shared/generation-timeline";

/** Put each artifact right after the activity row holding its producing tool call. */
export function htmlArtifactSlots(
  rows: readonly AssistantPresentationRow[] | null,
  artifacts: readonly ChatHtmlArtifactV1[],
  placements: ReadonlyMap<string, string>,
): { byRowKey: Map<string, ChatHtmlArtifactV1[]>; trailing: ChatHtmlArtifactV1[] } {
  const rowKeyByCall = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.kind !== "activity") continue;
    for (const step of row.steps) if (isToolStep(step)) rowKeyByCall.set(step.toolCallId, row.key);
  }
  const byRowKey = new Map<string, ChatHtmlArtifactV1[]>();
  const trailing: ChatHtmlArtifactV1[] = [];
  for (const artifact of artifacts) {
    const call = placements.get(artifact.mediaId);
    const rowKey = call ? rowKeyByCall.get(call) : undefined;
    if (!rowKey) {
      trailing.push(artifact);
      continue;
    }
    const list = byRowKey.get(rowKey);
    if (list) list.push(artifact);
    else byRowKey.set(rowKey, [artifact]);
  }
  return { byRowKey, trailing };
}
```

- [ ] **Step 4: Wire it into `message-list.tsx`**

1. Give `AssistantResponse` an optional `visualsForRow?: (rowKey: string) => React.ReactNode` prop. In the `rows.map` branch for `row.kind === "activity"`, render `{visualsForRow?.(row.key)}` immediately after `<ActivityFeed …/>`, inside the existing `React.Fragment`.
2. In `SettledMessageRow` and the streaming branch, compute
   ```ts
   htmlArtifactSlots(
     rows,
     message.htmlArtifacts ?? [],
     new Map((message.htmlArtifactPlacements ?? []).map((p) => [p.mediaId, p.toolCallId])),
   )
   ```
   For the streaming row, use the `streamingArtifacts` plus the `streamingArtifactPlacements` map from chat-pane. `rows` is the same `assistantPresentationRows(...)` result the component already computes; reuse it, don't recompute.
3. Change `artifactFrames(anchor)` so it renders only `slots.trailing` for that message, where the old code rendered every artifact. The `htmlArtifactTranscriptPlan` handoff (live vs persisted, keyed `html:<mediaId>`) stays the source of truth for **which** artifacts belong to which anchor. Slots only decide **where inside** the anchor they render. The keys must stay `html:<mediaId>` so the iframe is not remounted at stream handoff.
4. Run `npx tsx --test renderer/components/*.test.tsx` to catch any rendering regressions in existing suites.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/lib/html-artifact-transcript.test.ts renderer/lib/assistant-message-presentation.test.ts`
Expected: PASS.

- [ ] **Step 6: Register and commit**

Add `renderer/lib/html-artifact-transcript.test.ts` to `test:generative-ui`, then run `npm run test:ci-policy`.

```bash
git add renderer/lib/html-artifact-transcript.ts renderer/lib/html-artifact-transcript.test.ts renderer/components/message-list.tsx renderer/main/chat-pane.tsx package.json
git commit -m "feat(generative-ui): render visuals at their tool-call position"
```

---

### Task 4: Full Aiden theme kit for guests

**Files:**
- Create: `renderer/shared/generative-ui-theme.ts`
- Create: `renderer/shared/generative-ui-theme.test.ts`
- Create: `main/services/generative-ui-kit.ts`
- Modify: `renderer/shared/generative-ui.ts` (`GENERATIVE_UI_HOST_LIBS` += `"aiden-ui.css"`; guest CSP `style-src` += `aiden-genui://aiden-ui.css`)
- Modify: `main/services/generative-ui-host-libraries.ts` (serve the kit for `aiden-ui.css`, without reading from disk)
- Modify: `main/services/generative-ui-html.ts` (`GenerativeUiThemeTokens.vars?`; emit vars; transparent canvas)
- Modify: `main/services/generative-ui-html.test.ts`, `main/services/generative-ui-host-libraries.test.ts`
- Modify: `renderer/styles.css` (add `--chart-1` … `--chart-8` derived from the `--bot-avatar-*` hues in both schemes)
- Modify: `scripts/vendor-generative-ui-libs.mjs` only if it asserts the full `GENERATIVE_UI_HOST_LIBS` list on disk; if so, exclude the generated kit there.

**Interfaces:**
- Produces:
  - `GENERATIVE_UI_THEME_VARIABLES: readonly string[]`, the allowlist
  - `sanitizeGenerativeUiThemeVars(input: unknown): Record<string, string>`
  - `GenerativeUiThemeTokens.vars?: Record<string, string>`
  - `generativeUiKitCss(): string`
- Consumes: nothing from earlier tasks.

The allowlist is all of the following, each prefixed `--`:
- `text-primary`, `text-secondary`, `text-tertiary`, `text-quaternary`
- `surface-background`, `surface-popover`, `surface-control`, `surface-control-hover`, `surface-well`, `surface-input`, `surface-list-hover`, `surface-list-selection`
- `border-separator`, `border-field`
- `accent`, `accent-foreground`, `accent-hover`, `focus-ring`
- `status-accent`, `status-red`, `status-green`, `status-warning`, `status-accent-surface`, `status-red-surface`, `status-green-surface`, `status-warning-surface`
- `chart-1` … `chart-8`
- `radius-control`, `radius-button`, `radius-card`, `radius-pill`
- `ui-font-size`, `font-ui-family`, `font-code-family`
- `motion-duration`, `motion-easing`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/shared/generative-ui-theme.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_THEME_VARIABLES, sanitizeGenerativeUiThemeVars } from "./generative-ui-theme.js";

test("theme vars keep allowlisted names with safe values only", () => {
  const out = sanitizeGenerativeUiThemeVars({
    "--accent": "#0B7DE5",
    "--status-green-surface": "rgba(30, 160, 90, 0.16)",
    "--radius-card": "12px",
    "--ui-font-size": "14px",
    "--font-ui-family": '"Inter", ui-sans-serif, system-ui',
    "--motion-easing": "cubic-bezier(0.2, 0, 0, 1)",
    "--text-primary": "red; background: url(https://evil)",
    "--font-code-family": "x}body{display:none",
    "--surface-well": "url(data:x)",
    "--not-allowed": "#000000",
    "--chart-1": "oklch(0.7 0.1 250)",
  });
  assert.deepEqual(out, {
    "--accent": "#0b7de5",
    "--status-green-surface": "rgba(30, 160, 90, 0.16)",
    "--radius-card": "12px",
    "--ui-font-size": "14px",
    "--font-ui-family": '"Inter", ui-sans-serif, system-ui',
    "--motion-easing": "cubic-bezier(0.2, 0, 0, 1)",
    "--chart-1": "oklch(0.7 0.1 250)",
  });
});

test("the allowlist includes the categorical chart series", () => {
  for (let i = 1; i <= 8; i += 1) assert.ok(GENERATIVE_UI_THEME_VARIABLES.includes(`--chart-${i}`));
});
```

Add to `main/services/generative-ui-html.test.ts`:

```ts
test("wrapper emits sanitized vars, the kit stylesheet, and a transparent canvas", () => {
  const doc = wrapGenerativeUiHtml("<p>x</p>", "T", {
    colorScheme: "dark", canvas: "#111111", foreground: "#eeeeee", secondary: "#999999", accent: "#3388ff",
    vars: { "--radius-card": "12px", "--text-primary": "red;}" },
  });
  assert.match(doc, /--radius-card: 12px;/u);
  assert.doesNotMatch(doc, /red;\}/u);
  assert.match(doc, /href="aiden-genui:\/\/aiden-ui\.css"/u);
  assert.match(doc, /background: transparent/u);
});

test("legacy four-color theme callers still render", () => {
  const doc = wrapGenerativeUiHtml("<p>x</p>", "T", {
    colorScheme: "light", canvas: "#ffffff", foreground: "#000000", secondary: "#666666", accent: "#0b7de5",
  });
  assert.match(doc, /--artifact-accent: #0b7de5;/u);
});
```

These two are behavioral assertions on the produced document, the main function's output. They are not source greps.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/shared/generative-ui-theme.test.ts main/services/generative-ui-html.test.ts`
Expected: FAIL (module missing; no `aiden-ui.css` link).

- [ ] **Step 3: Implement the theme allowlist**

```ts
// renderer/shared/generative-ui-theme.ts
/** Semantic tokens a sandboxed guest may read. Values are validated, never trusted. */
export const GENERATIVE_UI_THEME_VARIABLES = [
  "--text-primary", "--text-secondary", "--text-tertiary", "--text-quaternary",
  "--surface-background", "--surface-popover", "--surface-control", "--surface-control-hover",
  "--surface-well", "--surface-input", "--surface-list-hover", "--surface-list-selection",
  "--border-separator", "--border-field",
  "--accent", "--accent-foreground", "--accent-hover", "--focus-ring",
  "--status-accent", "--status-red", "--status-green", "--status-warning",
  "--status-accent-surface", "--status-red-surface", "--status-green-surface", "--status-warning-surface",
  "--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8",
  "--radius-control", "--radius-button", "--radius-card", "--radius-pill",
  "--ui-font-size", "--font-ui-family", "--font-code-family",
  "--motion-duration", "--motion-easing",
] as const;

const ALLOWED = new Set<string>(GENERATIVE_UI_THEME_VARIABLES);
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([0-9a-z.,%/\s-]+\)|transparent)$/iu;
const LENGTH = /^-?\d+(\.\d+)?(px|rem|em|ms|s|%)?$/iu;
const EASING = /^(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\))$/iu;
const FONT_STACK = /^[a-z0-9 ,"'_-]+$/iu;

function safeValue(name: string, raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 200) return undefined;
  if (name.startsWith("--font-")) return FONT_STACK.test(value) ? value : undefined;
  if (name === "--motion-easing") return EASING.test(value) ? value : undefined;
  if (name.startsWith("--radius-") || name === "--ui-font-size" || name === "--motion-duration") {
    return LENGTH.test(value) ? value : undefined;
  }
  if (!COLOR.test(value)) return undefined;
  return value.startsWith("#") ? value.toLowerCase() : value;
}

export function sanitizeGenerativeUiThemeVars(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED.has(name) || typeof raw !== "string") continue;
    const value = safeValue(name, raw);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
```

- [ ] **Step 4: Implement the wrapper changes and the kit**

1. `generative-ui-html.ts`: extend `GenerativeUiThemeTokens` with `vars?: Record<string, string>`. `parseGenerativeUiTheme` passes `vars: sanitizeGenerativeUiThemeVars(record.vars)`. In the `:root {}` block, after the four legacy `--artifact-*` lines, emit `Object.entries(tokens.vars ?? {}).map(([k, v]) => \`  ${k}: ${v};\`).join("\n")`. Change `html, body { background: var(--artifact-canvas) }` to `background: transparent`, and set the font to `var(--font-ui-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)` at `font-size: var(--ui-font-size, 14px)`.
2. `hostLibraryTags()` already loops `GENERATIVE_UI_HOST_LIBS`, so adding `"aiden-ui.css"` emits `<link rel="stylesheet" href="aiden-genui://aiden-ui.css">`. Update `GENERATIVE_UI_GUEST_CSP` `style-src` to include `aiden-genui://aiden-ui.css`.
3. `main/services/generative-ui-kit.ts` exports `generativeUiKitCss()`. It returns a static stylesheet whose rules mirror the shared components and read **only** the allowlisted variables:
   - `.aiden-card`: `background: var(--surface-well); border-radius: var(--radius-card); padding: 16px`. No border.
   - `.aiden-btn` with `[data-variant=accent|filled|muted|transparent|destructive]`: squircle radius `var(--radius-button)`, `corner-shape: squircle`, a `:focus-visible` outline `2px solid var(--focus-ring)`, and a press `translateY(1px)`.
   - `.aiden-badge[data-color=gray|green|red|blue|warning]`: status `-surface` fills with status text colours. No border.
   - `.aiden-stat` (with `.aiden-stat-label` and `.aiden-stat-value`), `.aiden-table` (separator rows, tabular numbers), `.aiden-tabs` (`[role=tab][aria-selected=true]` uses `--surface-list-selection`), `.aiden-callout[data-color]`, `.aiden-muted`, and `.aiden-grid` (auto-fit `minmax(160px, 1fr)`).
   - Inputs: no focus ring. Focus changes the fill from `--surface-input` to `--surface-control`.
4. `generative-ui-host-libraries.ts`: when `name === "aiden-ui.css"`, return `{ bytes: Buffer.from(generativeUiKitCss(), "utf8"), mimeType: "text/css; charset=utf-8" }`. Export (`generativeUiExportDocument`) inlines it through the existing loop as long as the caller passes it in `libraries`; update the export call site in `gui-artifact-recovery.ts` to read all `GENERATIVE_UI_HOST_LIBS` through this function.
5. `renderer/styles.css`: add `--chart-1` … `--chart-8` in `:root` and `:root.dark`, mapped to the existing `--bot-avatar-{sky,mint,sun,coral,lilac,aqua,rose,lime}` values. Series never use status colours (per `gui/` chart guidance).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/shared/generative-ui-theme.test.ts main/services/generative-ui-html.test.ts main/services/generative-ui-host-libraries.test.ts && node --test scripts/vendor-generative-ui-libs.test.mjs`
Expected: PASS. If `generative-ui-host-libraries.test.ts` enumerated the old four libraries, extend its expectation to the kit through the public read function. Do not assert CSS text.

- [ ] **Step 6: Register and commit**

Add `renderer/shared/generative-ui-theme.test.ts` to `test:generative-ui`, then run `npm run test:ci-policy`.

```bash
git add renderer/shared/generative-ui-theme.ts renderer/shared/generative-ui-theme.test.ts renderer/shared/generative-ui.ts main/services/generative-ui-kit.ts main/services/generative-ui-host-libraries.ts main/services/generative-ui-html.ts main/services/generative-ui-html.test.ts main/services/generative-ui-host-libraries.test.ts main/services/gui-artifact-recovery.ts renderer/styles.css package.json
git commit -m "feat(generative-ui): give guests the full Aiden token kit"
```

---

### Task 5: Host-injected guest bridge script

**Files:**
- Modify: `main/services/generative-ui-html.ts` (replace the Escape-only inline script with the bridge)
- Modify: `tests/generative-ui/containment.spec.ts`
- Modify: `main/services/generative-ui-html.test.ts`

**Interfaces:**
- Consumes: the Task 1 message constants and the Task 4 vars.
- Produces, inside the guest:
  - `window.aiden = Object.freeze({ sendPrompt(text: string): void, theme(): Record<string,string> })`
  - an `aiden:themechange` `CustomEvent` dispatched on `window`
  - Chart.js defaults set from tokens when `window.Chart` exists
- `wrapGenerativeUiHtml(html, title, theme, options?: { bridgeNonce?: string })`. When a nonce is given, the bridge `<script>` carries `nonce="…"` (used by drafts in Task 8).

- [ ] **Step 1: Write the failing containment tests**

Add to `tests/generative-ui/containment.spec.ts`. Follow the file's existing pattern for loading a wrapped preview into a sandboxed iframe in a parent page. The existing tests build documents with `wrapGenerativeUiHtml` and route the `aiden-genui:` URL; reuse that harness.

```ts
test("bridge reports content height to the parent", async ({ page }) => {
  const messages = await loadGuestAndCollectMessages(page, '<div style="height:640px">tall</div>');
  await expect.poll(() => messages.find((m) => m?.type === "aiden:generative-ui:resize")?.height)
    .toBeGreaterThanOrEqual(640);
});

test("sendPrompt posts a typed prompt message and nothing else", async ({ page }) => {
  const messages = await loadGuestAndCollectMessages(
    page,
    '<button id="b" onclick="aiden.sendPrompt(\'Drill in\')">go</button>',
  );
  await page.frameLocator("iframe").locator("#b").click();
  await expect.poll(() => messages.filter((m) => m?.type === "aiden:generative-ui:prompt"))
    .toEqual([{ type: "aiden:generative-ui:prompt", text: "Drill in" }]);
});

test("theme messages update guest variables without reloading", async ({ page }) => {
  await loadGuestAndCollectMessages(page, "<p id=p>x</p>");
  const frame = page.frameLocator("iframe");
  await page.evaluate(() => {
    const f = document.querySelector("iframe")!;
    (f as HTMLIFrameElement).contentWindow!.postMessage(
      { type: "aiden:generative-ui:theme", colorScheme: "dark", vars: { "--accent": "#ff0000" } }, "*");
  });
  await expect.poll(() => frame.locator(":root").evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--accent").trim())).toBe("#ff0000");
});

test("guest code cannot replace window.aiden", async ({ page }) => {
  const messages = await loadGuestAndCollectMessages(
    page,
    "<script>try{window.aiden.sendPrompt=()=>{}}catch(e){};window.aiden.sendPrompt('still works')</script>",
  );
  await expect.poll(() => messages.some((m) => m?.text === "still works")).toBe(true);
});
```

`loadGuestAndCollectMessages(page, html)` is a small helper added to the spec. It mounts the wrapped document exactly as the existing tests do, installs `window.addEventListener("message", e => window.__msgs.push(e.data))` in the parent, and returns a live view through `page.evaluate(() => window.__msgs)`. Implement it from the spec's existing setup code. The existing "no fetch / no parent DOM" tests must keep passing unchanged.

The theme message is sent from parent to guest. The guest accepts it only when `event.source === window.parent`, so a guest cannot spoof its own theme message into the host.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test --config=playwright.generative-ui.config.ts`
Expected: the four new tests FAIL (no resize or prompt messages, no `window.aiden`).

- [ ] **Step 3: Implement the bridge script**

In `generative-ui-html.ts`, replace the Escape-only `<script>` with this bridge, rendered with `nonce` when `options.bridgeNonce` is set:

```ts
function bridgeScript(nonce?: string): string {
  const attr = nonce ? ` nonce="${nonce}"` : "";
  return `<script${attr}>
(() => {
  const parentWindow = window.parent;
  const post = (data) => parentWindow.postMessage(data, "*");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") post(${JSON.stringify(GENERATIVE_UI_ESCAPE_MESSAGE)});
  }, true);
  let lastHeight = 0, frame = 0;
  const report = () => {
    frame = 0;
    const height = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    post({ type: ${JSON.stringify(GENERATIVE_UI_RESIZE_MESSAGE)}, height });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
  new ResizeObserver(schedule).observe(document.documentElement);
  window.addEventListener("load", schedule);
  const applyChartDefaults = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    if (!window.Chart) return;
    window.Chart.defaults.color = v("--text-secondary");
    window.Chart.defaults.borderColor = v("--border-separator");
    window.Chart.defaults.font.family = v("--font-ui-family") || window.Chart.defaults.font.family;
    const series = [1,2,3,4,5,6,7,8].map((i) => v("--chart-" + i)).filter(Boolean);
    window.__aidenSeries = series;
    for (const chart of Object.values(window.Chart.instances || {})) chart.update("none");
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow) return;
    const data = event.data;
    if (!data || data.type !== ${JSON.stringify(GENERATIVE_UI_THEME_MESSAGE)} || typeof data.vars !== "object") return;
    const root = document.documentElement;
    root.dataset.colorScheme = data.colorScheme === "dark" ? "dark" : "light";
    root.style.colorScheme = root.dataset.colorScheme;
    for (const [name, value] of Object.entries(data.vars)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string" && !/[;{}]|url\\(/i.test(value)) {
        root.style.setProperty(name, value);
      }
    }
    applyChartDefaults();
    window.dispatchEvent(new CustomEvent("aiden:themechange"));
  });
  const api = Object.freeze({
    sendPrompt(text) {
      if (typeof text !== "string") return;
      post({ type: ${JSON.stringify(GENERATIVE_UI_PROMPT_MESSAGE)}, text: text.slice(0, ${MAX_GUEST_PROMPT_CHARS + 1}) });
    },
    theme() {
      const css = getComputedStyle(document.documentElement);
      return Object.fromEntries(${JSON.stringify(GENERATIVE_UI_THEME_VARIABLES)}.map((n) => [n, css.getPropertyValue(n).trim()]));
    },
  });
  Object.defineProperty(window, "aiden", { value: api, writable: false, configurable: false });
  window.addEventListener("DOMContentLoaded", applyChartDefaults);
})();
</script>`;
}
```

Import `GENERATIVE_UI_RESIZE_MESSAGE`, `GENERATIVE_UI_PROMPT_MESSAGE`, `GENERATIVE_UI_THEME_MESSAGE` and `MAX_GUEST_PROMPT_CHARS` from `renderer/shared/generative-ui-bridge.js`, and `GENERATIVE_UI_THEME_VARIABLES` from `renderer/shared/generative-ui-theme.js`. Place the bridge **before** `hostLibraryTags()` output, so `window.aiden` is defined before any model code runs. Chart defaults apply on `DOMContentLoaded`, after the libraries load. The host still sanitizes every var it sends (Task 6). The guest-side regex is defence in depth, not the primary check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx playwright test --config=playwright.generative-ui.config.ts && npx tsx --test main/services/generative-ui-html.test.ts`
Expected: all containment tests PASS, including the pre-existing ones.

- [ ] **Step 5: Verify Design Studio is unaffected**

Run: `npx tsx --test main/services/design/*.test.ts main/handlers/design/handlers.test.ts`
Expected: PASS. The bridge is additive; Design Studio ignores the new messages.

- [ ] **Step 6: Commit**

```bash
git add main/services/generative-ui-html.ts main/services/generative-ui-html.test.ts tests/generative-ui/containment.spec.ts
git commit -m "feat(generative-ui): inject resize, theme, and sendPrompt bridge into guests"
```

---

### Task 6: Borderless, auto-height inline visual frame

**Files:**
- Modify: `renderer/components/html-artifact-frame.tsx`. Keep the export names `HtmlArtifactFrame` and `HtmlArtifactList`; internals become the inline visual.
- Create: `renderer/components/html-artifact-frame.test.tsx`
- Create: `renderer/lib/generative-ui-theme-snapshot.ts` (reads allowlisted vars from `document.documentElement` and subscribes to appearance changes)
- Modify: `renderer/styles.css:784-806` (keep the expanded popover rules; add `.aiden-inline-visual` hover-toolbar rules using tokens only)
- Modify: `main/handlers/chats.ts:480-526` (pass `theme.vars` through `parseGenerativeUiTheme`; this needs no other change because Task 4 extended the parser)
- Modify: `package.json` (`test:generative-ui` += `renderer/components/html-artifact-frame.test.tsx`)

**Interfaces:**
- Consumes: `parseGuestBridgeMessage`, `clampInlineVisualHeight` and `GENERATIVE_UI_THEME_MESSAGE` (Task 1); `GENERATIVE_UI_THEME_VARIABLES` (Task 4).
- Produces:
  - `HtmlArtifactFrame` props `{ chatId, artifact, onGuestPrompt?: (text: string, frameFocused: boolean) => void }`
  - `readGenerativeUiTheme(): { colorScheme; canvas; foreground; secondary; accent; vars }`
  - `subscribeGenerativeUiTheme(listener): () => void`

**Design notes.** Before coding, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`.
- **Inline (default):** no `bg-control` and no header bar. The width matches the chat column (drop `max-w-[42rem]`). Height comes from the bridge, starting at 160px; it animates with `transition: height var(--motion-duration) var(--motion-easing)` and is disabled under `prefers-reduced-motion`. A floating toolbar (title as `Text variant="small"` in `text-secondary`, plus Expand and Export as `Button iconOnly size="small" variant="glass"`) sits top-right. It appears on `:hover`, on `:focus-within`, and always when the pointer is coarse. The section keeps `tabIndex={-1}`, and the iframe keeps the default `focus-visible` ring from the neutral focus token.
- **Expanded:** unchanged top-layer popover behaviour, with the iframe filling the dialog.
- **Loading:** a skeleton block at 160px using `--surface-well` (no spinner; the existing activity row already shows "Visualizing").
- **Error:** keep the existing `role="alert"` copy, rendered as a `Callout`.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/components/html-artifact-frame.test.tsx
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HtmlArtifactFrame } from "./html-artifact-frame";

const artifact = {
  version: 1 as const, kind: "html" as const, id: "a".repeat(64), title: "Revenue",
  mimeType: "text/html" as const, size: 10, mediaId: "b".repeat(64),
};

test("inline visual renders without card chrome and keeps an accessible title", () => {
  const html = renderToStaticMarkup(<HtmlArtifactFrame chatId="c1" artifact={artifact} />);
  assert.match(html, /data-inline-visual="b{64}"/u);
  assert.match(html, /aria-label="Revenue"/u);
  assert.match(html, /aria-label="Expand Revenue"/u);
  assert.match(html, /aria-label="Export Revenue"/u);
  assert.doesNotMatch(html, /<header/u);
});
```

The live behaviours (height follows the guest, theme reaches the guest without a reload, and prompts are relayed only through the bridge) are verified in Playwright. Add them to `tests/generative-ui/containment.spec.ts` by mounting the built renderer component the same way the existing "top-layer popover keeps its browsing context" case does:

```ts
test("inline visual height follows guest content within bounds", async ({ page }) => { /* mount, guest 900px tall → frame clientHeight 900; guest 5000px → 1600 */ });
test("theme update reaches a mounted frame without changing src", async ({ page }) => { /* record iframe.src; toggle :root.dark + dispatch the appearance event; guest --text-primary changes; iframe.src unchanged; same check while expanded */ });
```

Write each body with the spec's existing mount helpers; the assertions named in the comments are required.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/components/html-artifact-frame.test.tsx`
Expected: FAIL (no `data-inline-visual`, and the `<header>` is still present).

- [ ] **Step 3: Implement the theme snapshot module**

```ts
// renderer/lib/generative-ui-theme-snapshot.ts
import { GENERATIVE_UI_THEME_VARIABLES, sanitizeGenerativeUiThemeVars } from "../shared/generative-ui-theme";

export function readGenerativeUiTheme() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const raw: Record<string, string> = {};
  for (const name of GENERATIVE_UI_THEME_VARIABLES) raw[name] = styles.getPropertyValue(name);
  const vars = sanitizeGenerativeUiThemeVars(raw);
  const hex = (name: string, fallback: string) =>
    /^#[0-9a-f]{6}$/iu.test(vars[name] ?? "") ? vars[name]! : fallback;
  return {
    colorScheme: root.classList.contains("dark") ? ("dark" as const) : ("light" as const),
    canvas: hex("--surface-popover", "#f6f7f9"),
    foreground: hex("--text-primary", "#3d3f41"),
    secondary: hex("--text-secondary", "#6b6b68"),
    accent: hex("--accent", "#006ad6"),
    vars,
  };
}

/** Fires after appearance-runtime applies new tokens (class or inline-style change on <html>). */
export function subscribeGenerativeUiTheme(listener: () => void): () => void {
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; listener(); });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
```

- [ ] **Step 4: Rebuild the frame**

In `html-artifact-frame.tsx`:
1. Replace `themeTokensFromDocument()` with `readGenerativeUiTheme()` for the initial `htmlArtifactSrcdoc` fetch.
2. `HtmlArtifactIframe` gains `onHeight(height)` and `onPrompt(text, focused)`. Its message listener runs `parseGuestBridgeMessage(event.data)` only when `event.source === frameRef.current?.contentWindow`, then dispatches:
   - `escape` → `onEscape`
   - `resize` → `onHeight(clampInlineVisualHeight(h))`
   - `prompt` → `onPrompt(text, document.activeElement === frameRef.current)`
3. Add an effect: `subscribeGenerativeUiTheme(() => frameRef.current?.contentWindow?.postMessage({ type: GENERATIVE_UI_THEME_MESSAGE, colorScheme, vars }, "*"))`, using a fresh `readGenerativeUiTheme()` each time. Also post once on the iframe's `load` event, so a frame fetched with an older snapshot catches up.
4. The inline layout is `<section data-inline-visual={mediaId} aria-label={title} className="aiden-inline-visual group relative">`, with a toolbar `div` and a frame container `style={{ height: expanded ? undefined : height }}`. Delete the inline `<header>`. Keep the expanded `<header>` as is.
5. Keep the popover, the isolation logic and export exactly as they are.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test renderer/components/html-artifact-frame.test.tsx && npx playwright test --config=playwright.generative-ui.config.ts`
Expected: PASS.

- [ ] **Step 6: Manual visual acceptance**

Run the app (`npm run dev`, or the project's `run` skill). Ask: "Render a small bar chart of these numbers: 3, 7, 2." Verify all of the following:
- (a) the chart sits directly under the "Render artifact" activity row, not after the message;
- (b) there is no card background, and the frame hugs its content;
- (c) toggling light/dark in Settings → Appearance re-themes it with no reload or flash;
- (d) Tab reaches Expand and Export with visible focus rings;
- (e) Expand and then Escape returns focus.

Capture light, dark and high-contrast screenshots for the PR.

- [ ] **Step 7: Register and commit**

Add `renderer/components/html-artifact-frame.test.tsx` to `test:generative-ui`, then run `npm run test:ci-policy`.

```bash
git add renderer/components/html-artifact-frame.tsx renderer/components/html-artifact-frame.test.tsx renderer/lib/generative-ui-theme-snapshot.ts renderer/styles.css main/handlers/chats.ts tests/generative-ui/containment.spec.ts package.json
git commit -m "feat(generative-ui): borderless auto-height inline visuals with live theming"
```

---

### Task 7: Safe `sendPrompt` from visuals

**Files:**
- Modify: `renderer/components/message-list.tsx` (thread an `onVisualPrompt` callback to `HtmlArtifactFrame`)
- Modify: `renderer/main/chat-pane.tsx` (implement send-or-stage around `handleSend` ~1542 and the composer draft setter)
- Modify: `tests/e2e/` (add one case to the existing chat e2e suite that drives a fake model, if one exists; find with `grep -ln "render_artifact" tests/e2e`)

**Interfaces:**
- Consumes: `decideGuestPrompt` (Task 1); `HtmlArtifactFrame` `onGuestPrompt` (Task 6).
- Produces: the `MessageList` prop `onVisualPrompt?: (mediaId: string, text: string, frameFocused: boolean) => void`.

- [ ] **Step 1: Write the failing test**

If a fake-model e2e harness exists (check `tests/e2e/*generative*` or `*artifact*`), add:

```ts
test("a visual's sendPrompt starts a visible user turn when idle", async () => {
  // Fake model renders render_artifact with:
  //   <button id=go onclick="aiden.sendPrompt('Tell me more about B')">go</button>
  // Click #go inside the frame.
  // Expect: a user message bubble with exactly "Tell me more about B" appears,
  // and a second click within 3 s adds no second bubble.
});
```

If no such harness exists, put the policy coverage in Task 1's unit tests (already done) and do Step 4's manual check. Do not add a source-grep test.

- [ ] **Step 2: Implement**

In `chat-pane.tsx`, keep `const lastVisualPromptAt = useRef(new Map<string, number>())`.

```ts
const onVisualPrompt = useCallback((mediaId: string, text: string, frameFocused: boolean) => {
  const decision = decideGuestPrompt({
    text, frameFocused, chatBusy: isGenerating, now: Date.now(),
    lastAcceptedAt: lastVisualPromptAt.current.get(mediaId),
  });
  if (decision.action === "reject") return;
  lastVisualPromptAt.current.set(mediaId, Date.now());
  if (decision.action === "stage") setComposerDraft(decision.text);
  else void handleSend(decision.text);
}, [handleSend, isGenerating, setComposerDraft]);
```

Use the chat-pane's actual names for the busy flag, the draft setter and the send call (`handleSend` at ~1542). Read that block first and match its signature. The prompt must go through the **same** send path as typed input, so queueing, steering rules, attachments and permission checks all apply, and it shows as a normal user bubble.

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test renderer/shared/generative-ui-bridge.test.ts`, plus the e2e case if added (`npx playwright test <file> -g "sendPrompt"`).
Expected: PASS.

- [ ] **Step 4: Manual check**

Ask: "Make 3 buttons that each ask a follow-up question about colors." Clicking one sends a visible user message. Clicking during a running response puts the text in the composer instead.

- [ ] **Step 5: Commit**

```bash
git add renderer/components/message-list.tsx renderer/main/chat-pane.tsx tests/e2e
git commit -m "feat(generative-ui): let visuals send focused, rate-limited follow-up prompts"
```

---

### Task 8: Stream visuals while they are written

**Files:**
- Modify: `renderer/shared/generative-ui.ts` (`GENERATIVE_UI_DRAFT_THROTTLE_MS = 250`; `generativeUiDraftCsp(nonce: string): string`)
- Modify: `renderer/shared/chat-artifacts.ts` (event `operation: "draft"`)
- Modify: `main/services/generative-ui-protocol.ts` (`openGenerativeUiDraftStream`)
- Modify: `main/services/generative-ui-html.ts` (`generativeUiDraftDocumentHead(title, theme, nonce): string`)
- Create: `main/services/generative-ui-draft.ts` (pure delta tracker)
- Create: `main/services/generative-ui-draft.test.ts`
- Modify: `main/services/generative-ui-protocol.test.ts`
- Modify: `main/services/llm-client.ts` (the `message_update` handler near `toolcall_start` ~3524)
- Modify: `renderer/lib/generation-stream.ts:177-197`, `renderer/lib/chat-terminal-sync.ts:635`, `renderer/main/chat-pane.tsx:1267-1300` (draft state by `toolCallId`)
- Modify: `renderer/components/message-list.tsx` (render a draft frame in the step's slot when no presented artifact exists for that call yet)
- Modify: `tests/generative-ui/containment.spec.ts`
- Modify: `package.json` (`test:generative-ui` += `main/services/generative-ui-draft.test.ts`)

**Interfaces:**
- Consumes: Task 3 slots, the Task 5 bridge with a nonce, and Task 6's frame.
- Produces:
  - `ChatArtifactEventV1` adds `{ version: 1; operation: "draft"; toolCallId: string; title?: string; src: string } | { version: 1; operation: "draft_end"; toolCallId: string }`
  - `createGenerativeUiDraftTracker(): { update(toolCallId: string, args: unknown): DraftAction | undefined; end(toolCallId: string): void }`
  - `type DraftAction = { kind: "open"; toolCallId: string; title?: string } | { kind: "append"; toolCallId: string; chunk: string } | { kind: "restart"; toolCallId: string; title?: string }`
  - `openGenerativeUiDraftStream(title, theme): { src: string; append(chunk: string): void; close(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// main/services/generative-ui-draft.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createGenerativeUiDraftTracker } from "./generative-ui-draft.js";

test("tracker opens once, appends only new suffixes, and restarts on non-prefix edits", () => {
  const t = createGenerativeUiDraftTracker();
  assert.equal(t.update("c1", { title: "T" }), undefined);
  assert.deepEqual(t.update("c1", { title: "T", html: "<div>" }), { kind: "open", toolCallId: "c1", title: "T" });
  assert.deepEqual(t.update("c1", { title: "T", html: "<div>" }), { kind: "append", toolCallId: "c1", chunk: "<div>" });
  assert.equal(t.update("c1", { title: "T", html: "<div>" }), undefined);
  assert.deepEqual(t.update("c1", { title: "T", html: "<div><p>hi" }), { kind: "append", toolCallId: "c1", chunk: "<p>hi" });
  assert.deepEqual(t.update("c1", { title: "T", html: "<section>" }), { kind: "restart", toolCallId: "c1", title: "T" });
});

test("path-based and non-object args never open a draft", () => {
  const t = createGenerativeUiDraftTracker();
  assert.equal(t.update("c2", { title: "T", path: "a.html" }), undefined);
  assert.equal(t.update("c3", "not json yet"), undefined);
});
```

The first `update` with HTML returns `open`; the caller opens the stream and immediately calls `update` again, which yields the first `append`. That two-step protocol keeps the stream lifecycle explicit, which is why the second call above returns the full `<div>` chunk.

Add to `main/services/generative-ui-protocol.test.ts` (it already stubs Electron's `protocol`; reuse its stub to invoke the handler):

```ts
test("draft stream serves appended chunks under a nonce-only script policy", async () => {
  const draft = openGenerativeUiDraftStream("T", undefined);
  draft.append("<p>one</p>");
  draft.append("<script>window.ran=1</script>");
  draft.close();
  const response = await invokeHandler(draft.src);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]{16,}'/u);
  assert.doesNotMatch(csp, /'unsafe-inline'[^;]*script|script-src[^;]*'unsafe-inline'/u);
  const body = await response.text();
  assert.match(body, /<p>one<\/p>/u);
});
```

Add a Playwright containment case:

```ts
test("draft preview does not run model scripts", async ({ page }) => {
  // Serve a draft document (head from generativeUiDraftDocumentHead + "<script>parent.postMessage('ran','*')</script><p id=x>ok</p>")
  // with the draft CSP header; expect #x visible, no 'ran' message, and a resize message present.
});
```

Add to `renderer/lib/html-artifact-transcript.test.ts`:

```ts
test("present clears the draft for its toolCallId", () => {
  // Use the exported reducer that chat-pane uses for draft state
  // (reduceVisualDrafts(state, event)); present{toolCallId:"c1"} after draft{toolCallId:"c1"}
  // leaves no draft for c1, and draft_end removes it too.
});
```

Export `reduceVisualDrafts(state: ReadonlyMap<string, { src: string; title?: string }>, event: ChatArtifactEventV1): Map<…>` from `html-artifact-transcript.ts` so chat-pane and the test share it. A `reset` event empties the map.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/generative-ui-draft.test.ts main/services/generative-ui-protocol.test.ts renderer/lib/html-artifact-transcript.test.ts`
Expected: FAIL (modules and exports missing).

- [ ] **Step 3: Implement the tracker**

```ts
// main/services/generative-ui-draft.ts
export type DraftAction =
  | { kind: "open"; toolCallId: string; title?: string }
  | { kind: "append"; toolCallId: string; chunk: string }
  | { kind: "restart"; toolCallId: string; title?: string };

export function createGenerativeUiDraftTracker() {
  const state = new Map<string, { sent: string; opened: boolean }>();
  return {
    update(toolCallId: string, args: unknown): DraftAction | undefined {
      if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
      const record = args as Record<string, unknown>;
      if (typeof record.path === "string" || typeof record.html !== "string" || !record.html) return undefined;
      const title = typeof record.title === "string" ? record.title : undefined;
      const html = record.html;
      const current = state.get(toolCallId);
      if (!current) {
        state.set(toolCallId, { sent: "", opened: true });
        return { kind: "open", toolCallId, title };
      }
      if (!html.startsWith(current.sent)) {
        state.set(toolCallId, { sent: "", opened: true });
        return { kind: "restart", toolCallId, title };
      }
      const chunk = html.slice(current.sent.length);
      if (!chunk) return undefined;
      current.sent = html;
      return { kind: "append", toolCallId, chunk };
    },
    end(toolCallId: string): void {
      state.delete(toolCallId);
    },
  };
}
```

- [ ] **Step 4: Implement the streaming protocol document**

1. `renderer/shared/generative-ui.ts`:
   ```ts
   export const GENERATIVE_UI_DRAFT_THROTTLE_MS = 250;
   export function generativeUiDraftCsp(nonce: string): string {
     return GENERATIVE_UI_GUEST_CSP.replace("script-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`);
   }
   ```
   `generativeUiDraftCsp` keeps the host library sources, so Chart.js and KaTeX may load. Model inline scripts are blocked until the final artifact.
2. `generative-ui-html.ts`: `generativeUiDraftDocumentHead(title, theme, nonce)` returns the same document as `wrapGenerativeUiHtml`, up to and including `<body>` plus the nonce'd bridge, with **no** fragment and no closing tags. Factor the shared head builder out of `wrapGenerativeUiHtml` so the two cannot drift.
3. `generative-ui-protocol.ts`: `openGenerativeUiDraftStream(title, theme)` generates a 64-hex token and a 16-byte base64 nonce, and creates a `ReadableStream<Uint8Array>` whose controller is captured. The map entry is `{ kind: "draft", stream, csp, expiresAt }`; the first request for the token returns `new Response(stream, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": generativeUiDraftCsp(nonce), "cache-control": "no-store", "x-content-type-options": "nosniff" } })` and deletes the entry, because a draft is served once. `append` enqueues UTF-8 bytes and `close` closes the controller. Drafts expire after 2 minutes, closing the stream.
4. `llm-client.ts`, in the `message_update` switch next to `toolcall_start`:
   ```ts
   if (e.type === "toolcall_delta" && generativeUiRuntime) {
     const block = e.partial.content[e.contentIndex];
     if (block?.type === "toolCall" && block.name === GENERATIVE_UI_TOOL_NAME && block.id) {
       draftThrottle.schedule(block.id, () => {
         const action = draftTracker.update(block.id, block.arguments);
         // open/restart → close any old stream for this id, open a new one, emit
         //   chat:artifact {version:1, operation:"draft", toolCallId, title, src}, then call update() again to emit the first append.
         // append → stream.append(validatedChunk)
       });
     }
   }
   ```
   `draftThrottle` coalesces per `toolCallId` to `GENERATIVE_UI_DRAFT_THROTTLE_MS` (a trailing-edge timer). It is flushed and cleared on `toolcall_end`, on tool execution start, on abort and in the generation's `finally`; each of those also calls `draftTracker.end(id)`, closes the stream and emits `draft_end`.
   - Before appending, check the **accumulated** draft with `validateGenerativeUiHtml`'s pattern checks, which a new exported `isDraftHtmlAcceptable(html: string): boolean` wraps without throwing. On failure, stop drafting for that call (close and emit `draft_end`); the final execute reports the real error.
   - Verify `block.arguments` is the partially parsed object. Check `node_modules/@earendil-works/pi-ai/dist/types.d.ts` around the `toolcall_delta` declaration and `dist/utils/json-parse.js`. If only `e.delta` raw JSON is available, accumulate it per id and parse it with pi-ai's exported streaming JSON parser.
5. Renderer: subscribe to `draft` and `draft_end` exactly where `present` is handled (`generation-stream.ts`, `chat-terminal-sync.ts`) and keep the result in `chat-pane` through `reduceVisualDrafts`. In `message-list.tsx`, a row's slot renders `<HtmlArtifactDraftFrame src title />` for each draft whose `toolCallId` is in that row and has no presented artifact yet. It reuses `HtmlArtifactIframe`, with no toolbar, height from the bridge, and the `AidenActivityMark` for "Visualizing" in the toolbar position.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test main/services/generative-ui-draft.test.ts main/services/generative-ui-protocol.test.ts renderer/lib/html-artifact-transcript.test.ts && npx playwright test --config=playwright.generative-ui.config.ts`
Expected: PASS.

- [ ] **Step 6: Manual check**

Ask for "an interactive dashboard with 3 stat cards and a line chart". The cards appear progressively while the model writes. The chart canvas appears empty and fills in when the tool completes. There is no flash at the swap to the final frame: same slot, and a height match within 1 frame.

- [ ] **Step 7: Register and commit**

Add `main/services/generative-ui-draft.test.ts` to `test:generative-ui`, then run `npm run test:ci-policy`.

```bash
git add renderer/shared/generative-ui.ts renderer/shared/chat-artifacts.ts main/services/generative-ui-protocol.ts main/services/generative-ui-protocol.test.ts main/services/generative-ui-html.ts main/services/generative-ui-draft.ts main/services/generative-ui-draft.test.ts main/services/llm-client.ts renderer/lib/generation-stream.ts renderer/lib/chat-terminal-sync.ts renderer/lib/html-artifact-transcript.ts renderer/lib/html-artifact-transcript.test.ts renderer/main/chat-pane.tsx renderer/components/message-list.tsx tests/generative-ui/containment.spec.ts package.json
git commit -m "feat(generative-ui): stream visuals as drafts while the model writes them"
```

---

### Task 9: Availability, guidance, `visualize_guide`, and the Inline visuals setting

**Files:**
- Modify: `main/services/generative-ui-extension.ts` (`shouldEnableGenerativeUiExtension` without a workspace requirement; `path` only when a workspace exists; new system prompt; `visualize_guide` tool)
- Create: `main/services/generative-ui-guide.ts`
- Modify: `main/services/generative-ui-extension.test.ts`
- Modify: `main/services/llm-client.ts:1716-1783` (`workspaceRoot: folderPath` optional; mode gating)
- Modify: `main/handlers/chat-params.ts` (`inlineVisuals` param), `main/services/types.ts:916` (`GenerationParams.inlineVisuals?: InlineVisualsMode`)
- Modify: `main/handlers/chat.parse.test.ts` (param validation)
- Modify: `renderer/shared/appearance.ts` (`inlineVisuals`), `renderer/shared/appearance.test.ts`
- Modify: `renderer/components/settings/appearance-settings.tsx` (or the Chat settings page if one exists; follow `docs/settings-design-system.md`)
- Modify: `renderer/main/chat-pane.tsx` (send `inlineVisuals` with every generation)
- Modify: `renderer/shared/slash-commands.ts:527-539` (`/visualize` availability `idle-chat-session`) and `renderer/lib/slash-command-actions.ts:144-150` (drop the workspace gate; add an "off" gate)
- Modify: `renderer/lib/slash-command-actions.test.ts`, `renderer/shared/slash-commands.test.ts`
- Modify: `tests/e2e/settings-unification.spec.ts` (setting persists across relaunch)

**Interfaces:**
- Produces:
  - `type InlineVisualsMode = "automatic" | "on_request" | "off"` (exported from `renderer/shared/appearance.ts`)
  - `AppearanceConfig.inlineVisuals: InlineVisualsMode` (default `"automatic"`)
  - `GenerationParams.inlineVisuals?: InlineVisualsMode`
  - `shouldEnableGenerativeUiExtension(scope & { inlineVisuals?: InlineVisualsMode; visualize?: boolean })`
  - `VISUALIZE_GUIDE_TOOL_NAME = "visualize_guide"`
  - `generativeUiGuide(modules: readonly GuideModule[]): string`, with `GuideModule = "html" | "design" | "charts" | "interactive"`

- [ ] **Step 1: Write the failing tests**

Extend the enablement matrix in `generative-ui-extension.test.ts`:

```ts
test("visuals are available without a workspace and follow the inline-visuals mode", () => {
  const base = { usageSource: "chat", assistantMode: false, permission: "none", excluded: false };
  assert.equal(shouldEnableGenerativeUiExtension({ ...base }), true);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "off", visualize: true }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "on_request" }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "on_request", visualize: true }), true);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, interactionSurface: "telegram" }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, assistantMode: true }), false);
});

test("path rendering is refused without a workspace while inline html works", async () => {
  const runtime = createGenerativeUiExtensionRuntime({ ...baseOptions(), workspaceRoot: undefined });
  await assert.rejects(executeTool(runtime, "c1", { title: "T", path: "a.html" }), /workspace/u);
  await executeTool(runtime, "c2", { title: "T", html: "<p>x</p>" });
});

test("visualize_guide returns only the requested modules", async () => {
  const runtime = createGenerativeUiExtensionRuntime(baseOptions());
  const text = await executeGuide(runtime, { modules: ["charts"] });
  assert.match(text, /Chart\.js/u);
  assert.doesNotMatch(text, /## HTML structure/u);
});
```

`executeGuide` mirrors the file's `executeTool` helper for the second tool. The `/## HTML structure/` heading is the `html` module's first heading as defined in Step 3; the assertion checks module selection, not prose.

In `appearance.test.ts`:

```ts
test("inline visuals default to automatic and reject unknown modes", () => {
  assert.equal(normalizeAppearanceConfig({}).inlineVisuals, "automatic");
  assert.equal(normalizeAppearanceConfig({ inlineVisuals: "off" }).inlineVisuals, "off");
  assert.throws(() => parseAppearanceConfig({ ...validV1Config(), inlineVisuals: "sometimes" }), /Inline visuals/u);
});
```

In `chat.parse.test.ts`, assert that `inlineVisuals: "automatic" | "on_request" | "off"` parse and that `"x"` and `1` are rejected, using the file's existing parser call.

In `slash-command-actions.test.ts`, assert that `/visualize` is available with `hasWorkspaceArtifactAccess: false`, and unavailable with reason `"Inline visuals are off. Turn them on in Settings → Appearance."` when `inlineVisuals: "off"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test main/services/generative-ui-extension.test.ts renderer/shared/appearance.test.ts main/handlers/chat.parse.test.ts renderer/lib/slash-command-actions.test.ts renderer/shared/slash-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the guide and gating**

1. `generative-ui-guide.ts` exports `generativeUiGuide(modules)`, which concatenates the selected sections:
   - **design:** use `aiden-ui.css` classes (`.aiden-card`, `.aiden-btn[data-variant]`, `.aiden-badge`, `.aiden-stat`, `.aiden-table`, `.aiden-tabs`, `.aiden-callout`, `.aiden-grid`) and `var(--…)` tokens; never hard-code colours; a transparent background; no outer borders, shadows or headings repeating the title; sentence case; at most ~600px of content height unless asked.
   - **html** (`## HTML structure`): a fragment rather than a full document; one root element; inline `<style>` then markup then `<script>`; no network; `window.aiden.sendPrompt(text)` for follow-ups; listen for `aiden:themechange` to redraw custom canvases.
   - **charts:** Chart.js is preconfigured with Aiden colours (`window.__aidenSeries` holds the series palette); use `responsive: true, maintainAspectRatio: false` inside a fixed-height container; Plotly for 3D and statistical charts; KaTeX for math.
   - **interactive:** keep state in JS variables; buttons that ask a question call `aiden.sendPrompt`; never auto-send on load.
2. `generative-ui-extension.ts`:
   - `shouldEnableGenerativeUiExtension` drops the `workspaceRoot` and `permission` requirements. It returns `false` for `inlineVisuals === "off"`, and for `"on_request"` unless `visualize === true`.
   - `workspaceRoot` becomes optional. The `path` branch throws `"render_artifact path requires workspace access; pass html instead."` when absent, and the `path` schema description says so.
   - Add the second tool `visualize_guide { modules: string[] }`, validated against `GuideModule`, which returns `generativeUiGuide(modules)` as text. Declare it with `declarePiRuntimeReplay(…, "never")` like `render_artifact`.
   - Replace the system prompt with: "Aiden can draw inline visuals in this chat with render_artifact. Use one when a comparison, trend, structure, process, or interactive what-if is clearer as a visual than as prose — not for plain answers, and usually at most one per reply. Before your first visual in a conversation, call visualize_guide with the modules you need. Keep the reply complete without the visual: state the key takeaway in a sentence." Then append the existing `/visualize` sentence when `preferArtifactThisTurn` is set.
3. `llm-client.ts`: pass `inlineVisuals: params.inlineVisuals ?? "automatic"` and `visualize` into the enablement scope; pass `workspaceRoot: folderPath` (it may be undefined). Keep `!botContext`.
4. `chat-params.ts`: add `inlineVisuals` to the allowed keys, with validation against the three literals.
5. `appearance.ts`: add the field, the default, normalisation, and a parse error `"Inline visuals mode is unsupported."`, mirroring the `showComposerContextUsage` change in commit 45258be3c.
6. Settings UI: an **Inline visuals** row in a grouped card with a trailing `Select` (Automatic / Only when I ask / Off) and the description "Let Aiden draw charts, diagrams, and interactive explainers in the chat."
7. `chat-pane.tsx`: include `inlineVisuals: appearance.inlineVisuals` in every `startGeneration` params object.
8. Slash command: availability `idle-chat-session`; replace the workspace gate with the off gate.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command, then `npx playwright test tests/e2e/settings-unification.spec.ts -g "inline visuals"` (after adding a case that changes the select, relaunches and asserts the persisted value, mirroring the chat-width case).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/services/generative-ui-extension.ts main/services/generative-ui-extension.test.ts main/services/generative-ui-guide.ts main/services/llm-client.ts main/handlers/chat-params.ts main/handlers/chat.parse.test.ts main/services/types.ts renderer/shared/appearance.ts renderer/shared/appearance.test.ts renderer/components/settings/appearance-settings.tsx renderer/main/chat-pane.tsx renderer/shared/slash-commands.ts renderer/shared/slash-commands.test.ts renderer/lib/slash-command-actions.ts renderer/lib/slash-command-actions.test.ts tests/e2e/settings-unification.spec.ts
git commit -m "feat(generative-ui): visuals in every chat with an Inline visuals setting and on-demand guide"
```

---

### Task 10: Full verification, docs, and status

**Files:**
- Modify: `docs/pi-gui-artifacts.md` (placement, bridge, drafts, availability)
- Modify: `docs/plans/generative-ui-artifacts-plan.md` (status note: succeeded by the inline plan)
- Modify: `docs/plans/README.md` (row for "Inline Generative UI" → Active, Phase 1)
- Create: `.memory/inline-generative-ui.md`
- Modify: `main/services/generation-timeline.ts:239` only if the "Render artifact" label should read "Visualizing <title>" once settled. Keep it if unsure.

- [ ] **Step 1: Run the full touched suites**

Run, one at a time, and record the counts:

```bash
npm run test:generative-ui
npx tsx --test renderer/lib/assistant-message-presentation.test.ts renderer/lib/chat-message-queue.test.ts renderer/shared/appearance.test.ts main/handlers/chat.parse.test.ts
npx tsx --test main/services/design/*.test.ts main/handlers/design/handlers.test.ts
npm run test:ci-policy
npm run typecheck
npm run lint
```

Expected: all PASS. If any pre-existing failure appears, rerun it once; if it still fails, record the spec, the symptom and the run in the PR description (AGENTS.md flaky policy). Do not raise timeouts.

- [ ] **Step 2: Check the mobile contract is untouched**

Run: `npx tsx --test main/services/aiden-remote-protocol.test.ts main/services/aiden-remote-chats.test.ts`
Expected: PASS with contract revision unchanged (26). Phase 1 must not change the Remote projection; placements and drafts are desktop-only until Phase 3.

- [ ] **Step 3: Update the docs and memory**

- `docs/pi-gui-artifacts.md`: describe `htmlArtifactPlacements`, the bridge message types, the nonce'd draft stream (and that draft HTML never reaches the renderer), availability without a workspace, the setting, and `visualize_guide`.
- `docs/plans/README.md`: add a row linking the spec and this plan, with status "Active — Phase 1 (desktop inline HTML) in progress", and update the Generative UI Artifacts row to "Succeeded by Inline Generative UI".
- `.memory/inline-generative-ui.md`: key decisions (placement in a separate field and why; nonce'd draft CSP; focus-gated `sendPrompt`; full token kit allowlist; Design Studio compatibility), file map, and test commands. Add a pointer line in `.memory/PROJECT-CONTEXT.md` if that file indexes topics.

- [ ] **Step 4: Commit**

```bash
git add docs/pi-gui-artifacts.md docs/plans/generative-ui-artifacts-plan.md docs/plans/README.md .memory/inline-generative-ui.md .memory/PROJECT-CONTEXT.md main/services/generation-timeline.ts
git commit -m "docs(generative-ui): document inline visuals phase 1"
```

---

## Phase 2+ hand-off notes (not tasks in this plan)

When Phase 1 merges, write `docs/superpowers/plans/<date>-inline-generative-ui-phase-2.md` for the Aiden UI catalog (spec §5), starting with:
- the model evaluation harness (spec §12 gate), so AUM vs JSON is decided on data before the compiler is built;
- the shared primitives (Tabs, Segmented, Slider, Checkbox, Progress, Table, Stat, Tooltip, Disclosure, Chart), each adopted by its existing ad-hoc call site in the same PR;
- the `renderer/shared/aiden-ui/` parse → compile → evaluate pipeline, with fixture vectors in `protocol/aiden-ui/v1/fixtures/`.
