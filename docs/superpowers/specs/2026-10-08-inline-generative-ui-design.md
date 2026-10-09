# Inline Generative UI ("Aiden Visuals") — Deep-Dive Design

Status: Proposed (2026-10-08). Successor to [Generative UI Artifacts](../../plans/generative-ui-artifacts-plan.md), which shipped `render_artifact`, the sandboxed `aiden-genui:` host, `/visualize`, and durable artifact storage.

Implementation plans:

- Phase 1 (desktop inline HTML upgrade): [`2026-10-08-inline-generative-ui-phase-1.md`](../plans/2026-10-08-inline-generative-ui-phase-1.md)
- Phases 2–6 each get their own plan when the previous phase merges. Their entry criteria are listed below.

## 1. Goal

When a chart, diagram, comparison, calculator or mockup explains something better than prose, Aiden should draw it **inside the conversation, at the point in the answer where it belongs**. It should look like part of Aiden, not an embedded web page. This must work the same way whether the user asks (`/visualize`, "show me") or the agent decides on its own, and it must reach the iOS and Android apps.

User-visible outcomes:

1. A visual appears inline at the position of the tool call in the answer. It does not sit in a fixed 22rem card appended after the message.
2. It sizes itself to its content, has no card chrome, and follows the app's theme live, including theme switches after it has rendered.
3. It renders progressively while the model is still writing it, as Claude's visualizer and ChatGPT's intelligent UI do.
4. It is built from Aiden's own components and tokens, so it looks native.
5. Clicking something inside a visual can ask a follow-up (`sendPrompt`) safely.
6. On iOS and Android the same visual appears inline: natively rendered for catalog visuals, and as a snapshot plus "open interactive" for HTML visuals.

## 2. What exists today (verified on `main` @ 203a8f208)

| Area | Today | Gap |
|---|---|---|
| Tool | `render_artifact {title, html \| path}` in `main/services/generative-ui-extension.ts`; vanilla HTML/JS plus injected Chart.js, Plotly and KaTeX; result text only, so HTML never enters Pi history | Needs a workspace with permission other than `none` (`shouldEnableGenerativeUiExtension`), so ordinary non-workspace chats cannot visualize |
| Invocation | The agent may call it at any time; `/visualize` only appends a preference sentence (`preferArtifactThisTurn`) | Guidance is one paragraph with no design-system or "when to use" detail |
| Placement | `htmlArtifactTranscriptPlan` anchors to `message:<id>` or `streaming`; frames are pushed **after** the whole message row (`message-list.tsx` `artifactFrames`) | Not interleaved with prose; the artifact has no `toolCallId` |
| Frame | `HtmlArtifactFrame`: header, Expand, Export, `bg-control`, `max-w-[42rem]`, fixed `h-[22rem]` | Not content-sized; looks like an embed |
| Theme | 4 hex colors plus `colorScheme`, snapshotted once at fetch | No spacing, radius, type, status or categorical tokens; no live re-theme |
| Streaming | `toolcall_start` opens a "Visualizing" step; no `toolcall_delta` handling | Nothing renders until the tool executes |
| Bridge | Guest→host only `"aiden:generative-ui:escape"` | No resize, sendPrompt or theme channel |
| Security | `sandbox="allow-scripts"` (opaque origin), guest CSP `connect-src 'none'`, libraries only from `aiden-genui://`, one-time 30-minute preview tokens, regex HTML validation, Playwright containment suite | Sound; must be preserved by every change |
| Storage | `generative-ui-artifact-store.ts` (stage→commit, fork/copy, crash recovery); metadata on `ChatMessage.htmlArtifacts` | Fine for HTML; catalog trees are small enough to live on the message |
| Remote | Projects `htmlArtifacts: [{id, title}]` only; iOS and Android show "Can't view on this device" | No snapshot, no tree, no live artifact event |
| Mobile | No WKWebView or WebView in either app; native chronological transcript projections (`AidenChronologicalProjection`) already place tool rows by `contentOffset` | Needs a renderer |
| CLI | Own `render_artifact` writes a standalone export file | Needs a text fallback for catalog visuals |
| Design Studio | Reuses `wrapGenerativeUiHtml` and `aiden-genui:` (`design-render-extension.ts`, `design-preview.ts`) | Every wrapper change must stay backward compatible |

## 3. Lessons from ChatGPT's intelligent UI (openui.com teardown)

The teardown describes this pipeline: the model writes a custom tolerant markup (DIL); the server recompiles it every few hundred ms into a JS program plus a constants table; a sandboxed iframe runs it in a locked-down worker; and only **operations on a whitelisted native component catalog** (~70 components) reach the page. What Aiden takes from that, and what it leaves:

| ChatGPT choice | Aiden decision |
|---|---|
| Native component catalog instead of raw HTML | **Adopt** as the primary path (Phase 2): it is the only route that looks native everywhere and renders natively on iOS and Android. |
| Format designed to survive truncation (auto-close, statements on their own lines) | **Adopt**: the host repairs partial markup on every recompile and reports `recoveryDiagnostics`. |
| Validate against the catalog; drop bad props and log diagnostics | **Adopt**, and close the loop ChatGPT leaves open: diagnostics go back to the model in the tool result so it can fix them on its next call. |
| Arbitrary JS for logic (worker + `new Function`) | **Reject for the catalog tier.** iOS and Android would each need a JS engine. Use declarative state and bindings instead (§5.3). Arbitrary JS stays available in the HTML tier, which already has a hardened sandbox. |
| `AppBlock` HTML escape hatch with injected Tailwind base and `--viz-*` theme vars | **Already have it** (`render_artifact`). Upgrade its theming to the full Aiden token set plus an `aiden-ui.css` class kit (Phase 1). |
| Local interactions run with no model call; follow-ups only through `issueNewTurn` | **Adopt**: local state is client-side; `sendPrompt` creates a visible, ordinary user turn. |
| Data bound by reference (prices, images) to avoid hallucinated values | **Adopt later** (Phase 6): `$file` bindings to workspace CSV/JSON read on the host. |
| Recompile the full response and re-send ~83% redundant code | **Avoid**: send the normalized tree as a keyed patch (`replace` at a node path) and constant text deltas. |
| UI state resets on reload | **Avoid**: persist the per-visual local state snapshot with the message (bounded). |
| Silent logic errors (a metric switch showed a wrong revenue total) | **Mitigate**: no arbitrary JS in the catalog; bindings are pure lookups and formatters with no arithmetic beyond a fixed function set. |

## 4. Architecture overview

There are two tiers behind one user concept, "visuals".

```
             ┌──────────── model ────────────┐
             │ visualize_guide(modules)      │ ← on-demand design docs (keeps system prompt small)
             │ render_ui  {title, markup}    │ ← Tier A: Aiden catalog (Phase 2)
             │ render_artifact {title, html} │ ← Tier B: sandboxed HTML (exists; upgraded Phase 1)
             └──────────────┬────────────────┘
        toolcall_delta (partial args)│ execute
                             ▼
 main: compile + repair + validate → normalized tree (A) / staged HTML (B)
       stream drafts (throttled)    → persisted on message (A) / artifact store (B)
                             │ chat:artifact {present|draft|reset}
                             ▼
 desktop renderer: chronological rows → visual slot after the tool's activity row
   A → <AidenUiBlock> real React components     B → <InlineHtmlVisual> auto-height iframe
                             │ Aiden Remote (feature token, next revision)
                             ▼
 iOS SwiftUI / Android Compose: A → native catalog renderer; B → snapshot image + "Open interactive" sheet
```

**Why two tiers.** The catalog covers about 80% of cases (stats, tables, charts, comparisons, steps, forms, checklists) with native fidelity on every platform. HTML covers the long tail (bespoke diagrams, simulations, canvas, 3D, Plotly). The model picks: the guide says "prefer `render_ui`; use `render_artifact` when you need custom drawing or scripting".

## 5. Tier A: Aiden UI catalog (`render_ui`)

### 5.1 Model-facing format: "Aiden UI Markup" (AUM)

The model writes JSX-like markup in the tool's `markup` string. It does not write a JSON tree, for three reasons:

- Models write JSX far more reliably than deeply nested JSON, and it is about 3× fewer tokens.
- A tolerant parser can auto-close open tags at a stream cut. JSON can be cut mid-key.
- Text content stays as plain text, so streaming prose inside a visual reveals naturally.

```jsx
<Visual title="Q3 revenue by region" state={{metric: "revenue"}}>
  <Row gap={3}>
    <Stat label="Total" value={$data.totals[$metric]} format="currency" trend={+0.12} />
    <Stat label="Regions" value={4} />
  </Row>
  <Segmented bind="metric" options={[{value:"revenue",label:"Revenue"},{value:"margin",label:"Margin"}]} />
  <Chart kind="bar" data={$data.byRegion} x="region" y={$metric} />
  <Button variant="accent" action={sendPrompt("Break down EMEA " + $metric + " by month")}>Drill into EMEA</Button>
  <Data name="data">{ "totals": {"revenue": 6930, "margin": 0.31}, "byRegion": [ ... ] }</Data>
</Visual>
```

Grammar (kept deliberately small):

- Elements are `<Name prop=…>children</Name>` or self-closing. Names must be in the catalog; unknown elements become diagnostics and are dropped.
- Prop values are a string literal, a number, a boolean, a JSON object or array literal, or `{expression}`.
- `<Data name="…">` holds a JSON body (at most 64 KiB per visual) bound as `$name`.
- `state={{…}}` on `<Visual>` declares local state keys with initial values. `bind="key"` on an input two-way binds it.
- An expression is a path lookup (`$data.byRegion`, `$metric`, `$data.totals[$metric]`), a literal, `+` string concatenation, a comparison (`$metric == "revenue"`), a ternary, or a call to a fixed pure function set: `fmt(value, "currency"|"percent"|"number"|"date")`, `len()`, `sum()`, `max()`, `min()`, `round()`, `filter(list, "field", value)`, `sort(list, "field", "asc"|"desc")`. There are no loops, assignments or user-defined functions.
- `<Each in={$list} as="item">…</Each>` and `<If test={…}>…</If>` handle repetition and conditions. `<Each>` is capped at 500 iterations.
- Actions (`action=` on Button, ListRow and Chart point) are `sendPrompt(expr)`, `setState("key", expr)`, `openUrl("https://…")` (host-confirmed), or `copy(expr)`.

### 5.2 Host compiler (`renderer/shared/aiden-ui/`, pure TypeScript shared by main and CLI)

- `parse.ts`: a tolerant tokenizer and parser. At EOF it auto-closes open elements, drops an unterminated attribute, and drops an incomplete expression. It returns `{ ast, recoveryDiagnostics }`.
- `catalog.ts`: the single source of truth. For each component it defines `{ name, props: schema, children: "none"|"text"|"nodes", platforms: {desktop, ios, android} }`. `npm run aiden-ui:schema` generates `protocol/aiden-ui/v1/catalog.json` from it, and the Swift and Kotlin renderers are contract-tested against that file, the same way `protocol/aiden-appearance-v1.json` is shared today.
- `compile.ts`: AST → normalized tree `AidenUiNodeV1 { t: name, k: stableKey, p: props, c?: children }`. Expressions are compiled to a small JSON expression AST (`{op:"path", path:[…]}`, etc.), never to JS source. Unknown props are dropped with `unknown_prop`, bad literals with `invalid_literal`.
- `evaluate.ts`: a pure evaluator for the expression AST, shared by the desktop renderer. Swift and Kotlin get ports verified against fixture vectors in `protocol/aiden-ui/v1/fixtures/expressions.json`.
- Limits: 2,000 nodes, depth 24, 64 KiB of data per visual, 256 KiB of serialized tree, 8 visuals per response, and 60 per chat.

### 5.3 Why declarative state instead of a JS sandbox

A JS program would need three sandboxes: a worker in Electron, JavaScriptCore on iOS (no network or timers, which is feasible but carries App Review and maintenance risk), and on Android either a WebView or a bundled QuickJS (a new native dependency). The declarative expression set covers what the catalog needs (tabs, filters, metric switches, sort, toggles, sliders driving displayed values) and evaluates identically on all three platforms with fixture-vector parity tests. Anything beyond that goes to Tier B.

### 5.4 Initial catalog (~36 components, mapped to Aiden primitives)

| Group | Components | Desktop source |
|---|---|---|
| Layout | `Visual` (root), `Stack`, `Row`, `Grid`, `Card`, `Section`, `Separator`, `Spacer` | Card = borderless `rounded-card bg-well` (the `FieldSet` surface); no decorative borders |
| Text | `Text`, `Heading`, `Markdown`, `Code`, `Math`, `Kbd` | `Text`, `Markdown`, `CodeBlock`, KaTeX |
| Data display | `Stat`, `Table`, `KeyValue`, `List`/`ListRow`, `Badge`, `Callout`, `Progress`, `Meter`, `Checklist`, `Timeline`, `Image` (attachment ref only), `Icon` (lucide allowlist), `LinkCard` | `Badge`, `Callout` (extended to green/warning/accent), `RichLink`, `ContextMeter` pattern; Table, Stat and Progress are **new shared primitives** |
| Charts | `Chart kind=bar\|line\|area\|pie\|donut\|scatter`, `BarList`, `Heatmap`, `Sparkline` | New native `Chart` component on Chart.js in the renderer, with series colors from a new `--chart-1…8` token set derived from the bot-avatar hues and never from status colors; `BarList` adapts `ModelScoreboard`; `Heatmap` adapts `ActivityHeatmap` |
| Input and state | `Segmented`, `Tabs`, `Switch`, `Checkbox`, `RadioGroup`, `Select`, `Slider`, `TextInput` | `Switch`, `RadioGroup`, `Select`, `Input`; Tabs, Segmented, Slider and Checkbox are **new shared wrappers** over the installed `radix-ui` |
| Actions | `Button`, `ButtonGroup` | Shared squircle `Button` and `.squircle-action-group` |
| Disclosure | `Disclosure`, `Tooltip` | New shared wrappers over radix |

The new shared primitives (Tabs, Segmented, Slider, Checkbox, Progress, Table, Stat, Tooltip, Disclosure, Chart) go into `renderer/components/ui.tsx` or sibling files and are **adopted by existing ad-hoc call sites**: `review-panel.tsx`, `scheduled-tasks-view.tsx`, `model-picker.tsx`, `chat-sidebar.tsx` and `about-settings.tsx`. The app and the agent then draw with the same parts, which is the point of "reuse all the components we use for this app".

## 6. Tier B: inline HTML (`render_artifact`, upgraded in Phase 1)

1. **Placement.** The assistant message gains an optional `htmlArtifactPlacements: [{mediaId, toolCallId}]` field, and the live `present` event gains an optional `toolCallId`. `ChatHtmlArtifactV1` itself is **not** changed (see §13). Rendering moves into the chronological rows: the visual renders directly after the activity row that contains its `render_artifact` step. Legacy artifacts without a `toolCallId`, or with no matching step, keep today's after-message placement.
2. **Auto-height, borderless.** A host-injected bridge script in the guest reports the inline body's `scrollHeight` (a positioned flow root without min-height, so absolute and overflowing children count and the height shrinks with the content), re-measured by a `ResizeObserver` and a `MutationObserver`. The host clamps the height to 64–1600px (above that the frame scrolls internally and Expand is offered). The transparent canvas inherits the transcript background. Title, Expand and Export sit in a caption row below the frame, so no control covers the guest. While keyboard focus is inside the guest the frame shows the neutral focus ring.
3. **Full token kit.** The wrapper emits every allowlisted semantic variable (`--text-*`, `--surface-*`, `--accent*`, `--status-*`, `--radius-*`, `--font-*`, `--ui-font-size`, `--chart-1…8`) with validated values. It also serves `aiden-genui://aiden-ui.css`, a generated class kit (`.aiden-card`, `.aiden-btn[data-variant]`, `.aiden-badge[data-color]`, `.aiden-stat`, `.aiden-table`, `.aiden-tabs`, `.aiden-callout`) that mirrors the shared components, and the bridge sets Chart.js defaults (font, grid, tick colors, series palette).
4. **Live re-theme.** The host posts `{type:"aiden:generative-ui:theme", vars}` to every mounted frame when the appearance changes. The bridge applies the variables and fires an `aiden:themechange` event that guest code may listen to (Chart.js charts are updated by the bridge).
5. **`window.aiden.sendPrompt(text)`.** Posts `{type:"aiden:generative-ui:prompt", text}`. Neither focus nor page activation alone proves the user acted: a sandboxed guest can `focus()` itself from a timer, and `navigator.userActivation` is page-wide (a click in one visual activates the page for all of them). Both were verified in Chromium. So `createFrameGestureTracker` attributes a gesture to a visual only in three cases. First, activation turns on while that visual already holds focus: input into it, since a click elsewhere moves focus away. Second, focus enters it together with activation while the pointer is over it and the page had no input of its own; in the expanded view, where everything else is inert, the page-input check is waived. Third, focus arrives during the page's own Tab default action. The host sends a normal visible user turn only on such a gesture, with at most 2,000 characters and a 3 s cooldown per visual. While a run is starting, running, detached, or queued, the gestured prompt is staged in the composer instead. A prompt without a gesture may be staged once per visual until the user next sends, and is never sent. Known residual: a visual that steals focus while the user types into it, after more than 5 s without page input, receives those keystrokes and can count them as a gesture.
6. **Streaming drafts.** Main reads the partially parsed `html` argument from `toolcall_delta` (`partial.content[i].arguments`), throttled to 250ms, and serves it as a **draft preview** through the existing protocol with a CSP whose `script-src` is the bridge's nonce only. The browser's own incremental HTML parser renders partial markup, and model scripts do not run until the final artifact replaces the draft. Draft HTML never enters the renderer process. That preserves the invariant in `docs/pi-gui-artifacts.md`: HTML reaches the renderer only as an `aiden-genui://preview/` URL.
7. **Availability.** Inline `html` works in every desktop chat (workspace or not). `path` still requires workspace access. Bots, Telegram and assistant mode stay off until Phase 5.

## 7. Invocation policy (both tiers)

- **Agent auto-invocation.** The extension's system prompt shrinks to a short trigger list ("when a comparison, trend, structure, process or interactive what-if would be clearer as a visual than as prose; never for plain answers; never more than one visual unless asked"). It points at `visualize_guide(modules: ["catalog","charts","html","interactive"])`, which returns the detailed design guidance on demand (the same pattern as Claude's `read_me`).
- **User invocation.** `/visualize <prompt>` stays and is available in every idle chat. A composer **Visualize** chip is deferred to a later phase.
- **Setting.** Settings → Appearance → Chat → "Inline visuals": **Automatic** (default) / **Only when I ask** / **Off**. "Only when I ask" registers the tools only on `/visualize` turns; "Off" never registers them. Turns sent from a paired phone always run with visuals off until phones can render them (Phases 3–4). The setting follows the settings design system (grouped card, trailing `Select`).
- **Text alongside visuals.** The guide requires the answer to remain complete without the visual: a one-sentence takeaway in prose, and the visual's `title` doubles as alt text.

## 8. Persistence and contracts

- **Tier A:** `ChatMessage.uiVisuals?: ChatUiVisualV1[]`, where each entry is `{version:1, kind:"ui", id, toolCallId, title, catalogVersion, tree, data, state?, fallbackText, snapshotAttachmentId?}`. Trees are small and live on the message (no store), which makes fork, copy, remote projection and memory indexing straightforward. `state` is the last local state snapshot, written back debounced (≤ 4 KiB).
- **Tier B:** unchanged store and unchanged `ChatHtmlArtifactV1`, plus the optional message field `htmlArtifactPlacements: [{mediaId, toolCallId}]`.
- **Events:** `ChatArtifactEventV1` gains `operation: "draft"` (Tier B: `{toolCallId, title, previewUrl}`; Tier A: `{toolCallId, tree}` patch) alongside `present` and `reset`.
- **Snapshots (Phase 3):** after commit, main renders each visual offscreen (a hidden `BrowserWindow` with the same sandbox and CSP for HTML; the React catalog renderer in an offscreen route for Tier A), captures a PNG at 2× of at most 1,600 px width, and stores it as an ordinary message attachment. iOS, Android, Telegram and export then reuse the attachment pipeline unchanged.
- **Aiden Remote:** add feature token `chat-visuals-v1` and claim the **next contract revision after `main` at merge time** (26 today). The message projection gains `visuals: [{id, kind:"ui"|"html", title, toolCallId, contentOffset, fallbackText, snapshotAttachmentId?, tree?}]`. `tree` is included only for `kind:"ui"` when the client advertised `chat-visuals-v1`. Per the mobile constraints:
  - Never add a new timeline step kind. Old clients fail to decode unknown step kinds and reject the chat.
  - An invalid visual is dropped to its `fallbackText`; the chat is never rejected.
  - Include visuals in the `chatRevision` hash.
  - Keep each visual well under the 1 MiB window budget (a 256 KiB tree cap).
  - Add `contract.json` fixtures (a chat with both kinds, plus a windowed page) and decode tests on desktop, iOS and Android in the same PR.
  - `htmlArtifacts` stays projected for older clients until the revision after next.

## 9. Mobile

- **Placement.** Both apps already split rows by tool-step `contentOffset` (`AidenChronologicalProjection` on iOS and Android). The visual renders after the `render_ui` / `render_artifact` tool row.
- **Tier A native renderers.** iOS `Features/Remote/Visuals/AidenUiRenderer.swift` (SwiftUI, `@Environment(\.aidenPalette)`, Swift Charts for `Chart`, no new dependency). Android `features/chat/visuals/AidenUiRenderer.kt` (Compose M3 via `aidenColorScheme`, a small Canvas chart set: bar, line, area, pie, donut, sparkline). Unsupported components render their subtree's text fallback. The expression evaluator is ported and checked against the shared fixture vectors.
- **Interactions.** Local state runs natively. `sendPrompt` maps to `POST /chats/{chatId}/turns` when idle and to the existing queue/steer input when a run is active, through the same idempotent send path as the composer. `openUrl` opens the system browser after confirmation.
- **Performance.** Visuals render only on settled messages and appear after the tool's step finishes; while streaming, the existing "Visualizing" activity shows. Models are `@Immutable` (Android) and Equatable (iOS) so settled rows never re-render per token. Heights are deterministic from the tree so windowed prepends do not jump.
- **Tier B on mobile.** Inline: the snapshot image (existing attachment views), with the title as accessibility label and `fallbackText` beneath. Optional Phase 6: an **Open interactive** button presents a full-screen sheet with a locked-down `WKWebView` (non-persistent store, no script message handlers, navigation denied) or Android `WebView` (`allowFileAccess=false`, no JS interface, `shouldOverrideUrlLoading → true`) loading the main-wrapped document over a new authorized endpoint with the same CSP and bundled libraries. This is never inline in lazy lists.
- **Final fallback.** If there is no snapshot and no supported tree, today's "Can't view on this device" card remains.

## 10. CLI and other surfaces

- **CLI (`packages/cli`):** `render_ui` compiles with the shared compiler and prints `fallbackText` (a Markdown table or list rendered by the TUI), and on request exports a standalone HTML file rendered from the tree. `render_artifact` keeps its export behaviour.
- **Telegram and Bots (Phase 5):** enable after snapshots exist. Send the snapshot image plus `fallbackText`; `sendPrompt` buttons become Telegram inline buttons.
- **Memory:** index title plus `fallbackText` only (as today: title and size).
- **Onboarding:** update the final feature-tour bento tile for visuals (with a new 1024 × 1024 transparent PNG in `renderer/assets/onboarding/`) when Phase 2 ships, per AGENTS.md.

## 11. Security invariants (each must keep a test)

1. Tier B HTML never executes in the renderer origin and never reaches the renderer as a string: preview URLs only (drafts included).
2. The guest has no network (`connect-src 'none'`), no top navigation, no popups, no forms, and libraries only from `aiden-genui://`.
3. Guest→host messages are accepted only when `event.source` is the exact frame window, the payload parses against the closed bridge schema, and the per-type policy passes.
4. `sendPrompt` sends only on a gesture attributed to that visual (`createFrameGestureTracker`), is rate-limited, and always produces a visible user turn. A prompt without a gesture is staged at most once per visual until the user next sends. It never reaches tools directly.
5. Tier A never evaluates model-authored code. Expressions are data interpreted by a fixed evaluator with iteration and size caps.
6. `openUrl` allows only `https:` and always asks for confirmation.
7. Theme values passed to guests are allowlisted names with validated values (hex, `rgb()`/`rgba()`, px/rem numbers, font stacks without `url(`, `;`, `{` or `}`).

## 12. Phases and entry criteria

| Phase | Scope | Exit / next entry criteria |
|---|---|---|
| **1. Inline HTML upgrade (desktop)** | §6 in full, `visualize_guide`, non-workspace availability, the Inline visuals setting | Containment suite extended and green; visual acceptance in light, dark and high-contrast; Design Studio previews unchanged |
| **2. Aiden UI catalog (desktop)** | §5: compiler, catalog, new shared primitives adopted by existing call sites, `render_ui`, `AidenUiBlock`, streaming tree drafts, onboarding tile | Fixture vectors frozen; catalog JSON generated; model eval (below) passes |
| **3. Snapshots and Remote contract** | Offscreen snapshots for both tiers; `chat-visuals-v1` projection; fixtures on all three platforms | Old-client decode tests pass with visuals present |
| **4. Native mobile renderers** | iOS SwiftUI and Android Compose Tier A renderers plus `sendPrompt` | Physical-device acceptance; windowing and scroll stability |
| **5. Bots, Telegram and CLI** | Snapshot delivery, inline buttons, CLI fallback and export | Live Telegram smoke |
| **6. Advanced** | Mobile interactive HTML sheet; `$file` data binding; editing a visual in place across turns (`replaceId`) | Separate security review |

**Model evaluation gate (Phase 2):** 40 prompts across charts, comparisons, explainers, forms and dashboards, run on the default Claude, GPT and Gemini models. Measure parse success after repair (target ≥ 98%), diagnostics per visual, tokens per visual against the equivalent HTML, and appropriate-invocation precision (no visual for plain Q&A). This also chooses between AUM and a JSON fallback format if AUM underperforms.

## 13. Risks

- **Downgrade compatibility (checked).** `parseChatHtmlArtifacts` (`renderer/shared/chat-artifacts.ts`) parses each entry with exact keys and returns `undefined` for the **whole list** if any entry fails. `chat-store-core` then drops every HTML artifact on that message, and the older build's `reconcilePersisted` may treat the stored HTML as orphaned. Adding a key to `ChatHtmlArtifactV1` is therefore unsafe. Decision: keep the artifact shape frozen, and carry placement in a separate optional message field that older builds ignore. The worst case on downgrade is today's after-message placement. Tier A visuals use a new field (`uiVisuals`) for the same reason.
- **Auto-height layout thrash.** Clamp, rAF-coalesce, and ignore deltas under 2px. Content-visibility on offscreen frames.
- **Many live iframes in long chats.** Unmount the iframes of visuals scrolled far off-screen (keep their last measured height as a placeholder) once more than 6 are mounted.
- **Model over-use.** Guide rules plus the "Only when I ask" setting. Add an eval measurement for false-positive visuals.
- **Catalog drift across three platforms.** One generated `catalog.json`, fixture vectors, and CI decode tests on every platform.
