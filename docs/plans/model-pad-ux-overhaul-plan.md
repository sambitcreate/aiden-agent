# Model Pad UX and data overhaul

Status: In progress

Spec: the "now vs proposed" audit of the Model Pad (2026-10-09), with the owner's decisions:

- Settings editor **autosaves** every action and offers **Undo** (no Save Pad / Reset buttons).
- The same model reachable through two providers stays as **separate dots, visibly linked** ("also via X"). Placement keys stay `${providerId}::${modelId}`.
- Pad layout, pins, recents and the benchmark metric move from renderer localStorage into **main-process `AppSettings`** (persisted by `config-store-core`, normalized by `portable-config-core`). **No mobile / remote-protocol change.**
- OpenRouter benchmark fetch: OpenRouter's `GET /api/v1/benchmarks` has **no paging** (only `max_results`, minimum 1, no documented maximum; omitted = all rows). Raise the explicit cap instead of paging, and update the AGENTS.md policy text.

Background notes for implementers live in `.memory/model-pad.md`.

## Global Constraints

These bind every task. Reviewers check them.

1. **Tests** follow AGENTS.md: behavioral tests that call real functions with fixtures, render components (`renderToStaticMarkup`, or Testing Library + happy-dom as in `renderer/components/onboarding-bots-step.test.tsx`), or register-and-invoke IPC. No `readFileSync` + regex of production source, no tautological tests, no change-detector tests (exact className strings, keyframes, large snapshots). New test files must be registered in a `package.json` test script (`test:model-pad` for renderer Pad/picker tests, `test:model-insights` for main model-info/benchmark tests, or the script that already owns the touched area).
2. **UI rules** (AGENTS.md, `docs/design-guide.md`, `docs/settings-design-system.md`): use semantic tokens from `renderer/styles.css` / `renderer/shared/appearance.ts`, never one-off colors; shared `Button` and other primitives from `renderer/components/ui`; no decorative borders/outlines on badges, alerts, cards or controls; non-text controls keep a visible `focus-visible` treatment using the neutral `--focus-ring`; text inputs add no focus border/ring. Respect reduced motion (`document.documentElement.dataset.reduceMotion === "true"` or `prefers-reduced-motion: reduce`). Before adding or restyling an element, review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Never introduce brain icons.
3. **Network**: no new network calls. The only Model Pad network action remains the manual OpenRouter benchmark fetch (Connect & fetch / Fetch latest). Measured pace data is device-local and never transmitted.
4. **Pre-1.0, no migrations**: delete legacy shapes (localStorage Pad/pin keys, layout schema v1) instead of migrating them.
5. **Display-only metadata**: catalog-derived values (cost, canonical id, benchmark, pace) must never change runtime limits, routing or the selectable inventory.
6. **Accessibility**: the composer Pad stays a `listbox` with `aria-activedescendant`; every new interactive element has an accessible name; visual-only decorations are `aria-hidden`.
7. **Per-task bookkeeping**: append a dated bullet to `.memory/model-pad.md` (git-ignored, local only; do not force-add it) describing what changed and why. Commit with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
8. **Verification per task**: run the touched test files with `npx tsx --test <files>`, the owning script (`npm run test:model-pad` and/or `npm run test:model-insights`), `npx tsc --noEmit`, and `npx eslint <touched files>`. Report exact commands and results.

## Tasks

### Task 1: Keep benchmark scores through the provider-metadata fallback

Audit row: Backend #2 (P0).

`withProviderFallback` in `main/services/provider-model-info-core.ts` (~line 47) replaces an unmatched models.dev result with `providerInfo(modelId, metadata)` when provider metadata exists, which drops the `benchmark` field that `resolveModelInfo` (`main/services/models-catalog-core.ts` ~596-614) attached via an exact OpenRouter permaslug match. This hits OpenRouter-as-provider and custom gateways.

Requirements:
- When the fallback substitutes provider info, carry `benchmark` (and `ranking`, if present) from the catalog result onto the substituted info. The `overrides` branch must keep it too.
- No other behavior change.

Tests (extend `main/services/provider-model-info-core.test.ts`):
- A provider model with provider metadata, no models.dev match, and an exact OpenRouter benchmark match → returned `ModelInfo.benchmark` has the expected scores.
- Same with `metadata.overrides` set → benchmark still present and overrides still applied.

### Task 2: Move Pad layout and pins into main-process settings

Audit row: Backend #7.

Today the layout lives in localStorage key `aiden-agent.modelPadLayout.v1` (`renderer/lib/model-pad-layout.ts`) and pins in `aiden-agent.pinnedModels` (`renderer/components/model-picker.tsx`, `renderer/lib/model-picker-data.ts`). `renderer/lib/google-provider-migration.ts` rewrites both keys for provider-id aliases.

Requirements:
- Add to `AppSettings` (main `main/services/types.ts` and its renderer mirror in `renderer/lib/types.ts`): `modelPadPlacements?: Record<string, ModelPadPlacement>` (`{ x, y, xSource, ySource }`, sources `"user" | "benchmark" | "neutral"`, coordinates 0..1, at most 2,000 entries, keys ≤1,024 chars) and `pinnedModels?: string[]` (distinct `provider::model` values, at most 200).
- Normalize both fail-closed in `main/services/portable-config-core.ts` alongside `hiddenModelsByProvider` (invalid entries dropped). Both are included in portable config export/import.
- `main/services/config-store-core.ts`: when a provider id is remapped (the same places `hiddenModelsByProvider` is remapped), remap the `provider::` prefix of placement keys and pins (a canonical entry wins over its legacy duplicate); when a provider is removed, drop its placements and pins.
- Renderer: `useModelPadLayout()` and a save function read/write through the existing settings query/update path (find how other settings fields are saved from the renderer, e.g. hidden models). Pins read/write the same way. Cross-window freshness comes from the settings query, not storage events.
- Delete the localStorage code paths, the `MODEL_PAD_LAYOUT_KEY` / `PINNED_MODELS_KEY` constants, the layout schema v1 parsing, and the Pad/pin parts of `google-provider-migration.ts` (keep the selected-provider part if still needed). No import of old localStorage data.
- Callers (`model-picker.tsx`, `model-pad-settings.tsx`) keep their current behavior (the settings editor still uses its draft/Save flow in this task; Task 12 replaces it).

Tests:
- `portable-config-core` roundtrip: placements and pins survive export → import; invalid entries are dropped.
- `config-store-core`: provider-id remap moves placement keys and pins; provider removal drops them.
- Update `renderer/lib/model-pad-layout.test.ts` (fail-closed parsing without v1) and `renderer/lib/google-provider-migration.test.ts`.

### Task 3: Size the grid from the Pad, not the catalog

Audit row: UI #4 (P0).

`modelGridSize(entries.length)` in `model-picker.tsx` (~407) and `modelPadGridSize(entries.length)` in `model-pad-settings.tsx` use every visible chat model, so a 300-model catalog gives a 43×43 grid and saved placements re-snap whenever the catalog changes.

Requirements:
- Both surfaces compute the grid from the number of **placed, visible** models with the same function (keep `modelPadGridSize`: odd, minimum 7, density unchanged). The picker and the settings editor must produce identical snapped positions for the same settings.
- Adding a model in the editor computes the next placement against the grid for `placedCount + 1`.
- Adding, removing or hiding **unplaced** catalog models never changes any placed model's snapped position.
- The composer empty-state grid uses the base size.

Tests (`renderer/lib/model-picker-data.test.ts` / `model-pad-layout.test.ts`):
- `positionSavedModels` with the same placements and a 5-entry vs 300-entry catalog gives identical x/y for the placed models.
- The settings editor's reflow and the picker's positions agree for the same placements (call the same exported functions both surfaces use).

### Task 4: One marker language on both surfaces

Audit row: UI #3 (P0).

Settings draws personal placements pale and benchmark-assisted ones in full accent (`renderer/styles.css` ~982-988); the picker does the reverse (`renderer/components/model-picker-pad.tsx` ~268-271).

Requirements:
- Everywhere: personal placement (both axes `"user"`) = solid accent fill; any data-assisted placement (either axis not `"user"`) = hollow accent ring with a transparent center. The difference is shape, not only color.
- Picker options expose the same `data-placement-source="personal" | "benchmark"` vocabulary the settings markers use, and CSS keys off it in both places. Remove picker styling branches for confidences the Pad can no longer produce.
- The settings legend markers match.
- Selected/preview states stay distinguishable from both, and focus-visible stays intact.

Tests: render `ModelPickerPad` with one personal and one benchmark-assisted model and assert each option's `data-placement-source`; the settings legend renders both kinds.

### Task 5: Show the hovered model's name on the composer Pad

Audit row: UI #1 (P0).

The name of the previewed model only appears in the side card, which is hidden below 620px (`useExternalModelDetails`, `model-picker.tsx` ~142-158).

Requirements:
- `ModelPickerPad` renders a small tag next to the knob at every width: model label and provider label (truncated), positioned edge-aware (flip below near the top edge; align start/end near the left/right edges), using popover tokens. It is `aria-hidden` (the listbox already announces the active option).
- The tag follows preview (pointer, arrows) and rests on the selected model.
- No transform animation under reduced motion. The side card stays at ≥620px.

Tests: render the Pad with a preview value → the tag contains that model's label and provider; a model near the right edge gets end alignment and one near the top gets the below placement (assert via data attributes).

### Task 6: Handle a current model that is not on the Pad

Audit row: UI #2 (P0).

`active = preview ?? selected ?? models[0]` (`model-picker-pad.tsx:70`) puts the knob, the tag and the side card on the first Pad model when the current model is not placed, so it looks selected.

Requirements:
- When the selected model is not among the Pad models and nothing is previewed: no knob, no tag, no `aria-activedescendant`, Enter does nothing, and the first arrow press starts at the model closest to the Pad center.
- Show a compact row in the Pad panel: "<label> isn't on your Pad" with an **Add to Pad** button that saves a user placement (`nextModelPadPlacement`) through the Task 2 settings path, after which the knob rests on it.
- The side card shows the current (unplaced) model's details instead of the first Pad model.

Tests (Testing Library): selected model not placed → no option is active, the row text is present; activating Add to Pad saves a placement for that model.

### Task 7: Axis captions on the composer Pad

Audit row: UI #5.

Requirements:
- Inside the composer Pad's inset margin: "More capable" at the top center, "Faster" bottom-left and "More deliberate" bottom-right (same copy as settings), small tertiary text, `aria-hidden`, never overlapping markers, knob or tag.

Tests: render the Pad → the three captions are present and hidden from assistive tech.

### Task 8: Choosing on the Pad closes the picker; ignore far clicks

Audit row: UI #6.

Requirements:
- A pointer release or Enter/Space that commits a model closes the popover after the confirm pulse (~200 ms; immediately under reduced motion), matching the List view.
- Add an optional maximum distance to `nearestModel` (constant `MODEL_PAD_CAPTURE_RADIUS = 0.2` in normalized units). Pointer preview and pointer commit ignore points farther than that from every model (preview stays put; release commits nothing). Keyboard navigation is unaffected.

Tests: `nearestModel` returns `undefined` beyond the radius and the nearest model within it; a pointer release far from every model does not call `onCommit`; a commit closes the popover (Testing Library on `ModelPicker`, or the narrowest component that owns it).

### Task 9: Edit the Pad from the picker

Audit row: UI #7.

Requirements:
- Pad panel with models: an icon-only "Customize Model Pad" button (same navigation and `settingsBlockedReason` handling as the empty state).
- List rows: a hover/focus-revealed toggle next to Pin — "Add <label> to Pad" / "Remove <label> from Pad" — saving through the Task 2 path (`nextModelPadPlacement` for adds). Same reveal and focus treatment as Pin.

Tests: the row toggle has the right accessible name for on-Pad and off-Pad models and saves the expected layout; the customize button is present only when the Pad has models.

### Task 10: Type to search from the Pad

Audit row: UI #13.

Requirements:
- With the Pad focused, typing a printable character (no Ctrl/Meta/Alt) switches to List, focuses the filter input and seeds it with that character. Arrow keys, Enter, Space, Escape and Tab keep their current Pad behavior.

Tests (Testing Library): typing "c" on the Pad shows the List panel with the filter value "c"; arrow keys do not switch views.

### Task 11: Recent models in the desktop list

Audit row: UI #14 (Android parity: up to 5 stored, 3 shown, excluding the current pick).

Requirements:
- `AppSettings.recentModels?: string[]` (distinct `provider::model`, newest first, max 5), recorded whenever a model is committed from the List or the Pad. Remapped/dropped with providers like Task 2. Not included in portable config export (history, not preference).
- The List shows a "Recent" group (max 3, excluding the current model and pinned models, only models still visible) after pinned models and before the rest, only when the filter is empty.

Tests: pure helpers for recording (dedupe, cap 5, newest first) and for selecting the rows to show; config-store remap/drop; portable export excludes recents; list render shows the Recent group.

### Task 12: Autosave with Undo in the settings editor

Audit rows: UI #10 and Backend #10.

Requirements:
- Remove the draft/saved split, the **Save Pad** and **Reset changes** buttons, and the "Unsaved changes" / "Saved locally" badges.
- Every completed action persists immediately through the Task 2 path: drop after drag, add, remove, remove all, and (later tasks) quick starts and accepted suggestions. Keyboard nudges coalesce: a burst within 500 ms is one save and one undo step.
- Each persisted action shows a toast ("Moved <label>", "Added <label>", "Removed <label>", "Cleared the Pad") with an **Undo** action that restores the layout from just before that action. "Remove all models from Pad" needs no confirmation because Undo exists.
- A failed save shows an error toast and the editor returns to the last persisted layout.
- Memoize derived data (entries, grid size, reflowed placements, percentiles) and use a Set for occupied-dot lookups so dragging does not rescan every placed model per dot.
- Update `tests/e2e/model-pad-responsive.spec.ts` and `docs/settings-design-system.md` wherever they refer to saving.

Tests (Testing Library): adding a model saves immediately; Undo restores the previous layout; a nudge burst produces one save; a save failure restores the last persisted layout.

### Task 13: First visit to the settings editor

Audit row: UI #8.

Requirements:
- With zero placed models, the Browse models panel is open on mount (no animation).
- The empty Pad canvas offers two quick starts: **Add pinned & recent** (pinned then recent visible models not on the Pad, up to 8, as user placements via `nextModelPadPlacement`; disabled when there are none) and **Start from benchmarks** (enabled when insights are ready and at least one visible model has a score for the current metric; places the top 8 by percentile via `distributeCapabilityOnlyModelPadSuggestions`). Both autosave with Undo (Task 12).

Tests: zero placements → browse panel visible; pure helper for the pinned & recent quick start (order, limit, skips placed/hidden models); the benchmark quick start places at most 8.

### Task 14: Reviewable suggestions and a persisted metric

Audit row: UI #9.

Requirements:
- `AppSettings.modelPadMetric?: "intelligence" | "coding" | "agentic"` (default `"coding"`), persisted and included in portable config.
- Replace one-click "Suggest unplaced" with **Preview suggestions**: up to 8 unplaced visible models with a score for the metric (pinned and recent first, then highest percentile), shown as ghost markers distinct from both placement kinds. Clicking a ghost accepts it; a toolbar offers **Accept all (N)** and **Dismiss**. Accepted suggestions save as `xSource: "neutral", ySource: "benchmark"` with Undo.
- Legend in settings and a caption on the composer Pad read "Height: <Metric>" whenever at least one visible placement has `ySource: "benchmark"`.

Tests: pure selection helper (cap, ordering); accepting one ghost saves only that model; the composer caption appears only when a benchmark-height placement is visible.

### Task 15: Index catalog lookups and stop re-reading the key

Audit row: Backend #5.

Requirements:
- `main/services/models-catalog-core.ts`: build lookup indexes once per catalog object (e.g. a `WeakMap` cache): per-provider id map, per-provider leaf-id map, global id and leaf maps, and any normalized-name maps the benchmark fallback needs. `findRaw`, `findRawInProvider` and the benchmark name fallback use them and return the same row the linear scans returned (first occurrence wins). Use locale-independent lowercasing for identifiers.
- `main/services/openrouter-benchmark-runtime-core.ts`: `catalog()` keeps the "has key" answer (and the parsed cache) in memory, invalidated by connect, refresh and disconnect, so ordinary `models:info` calls do not read and decrypt the credential document each time.

Tests: fixture catalog with duplicate ids across providers → lookups return the expected first-occurrence rows; `catalog()` called N times reads credentials once, and again after disconnect/connect.

### Task 16: Benchmark fetch robustness

Audit row: Backend #3.

Requirements:
- Parsing: rows that share a permaslug are dropped as ambiguous instead of rejecting the whole response; the remaining rows are kept. Record the skipped count in the cache and expose it in `ModelInsightsStatus`.
- Matching: reasoning variant markers in display names (e.g. "(Reasoning)", "(Non-reasoning)", "Thinking") are part of the normalized identity, so variants no longer collide. A model whose own name/id has no variant marker matches the base row; if only variant rows exist, use the models.dev `reasoning` flag to pick reasoning vs non-reasoning; otherwise no match (fail closed).

Tests (`main/services/openrouter-benchmark.test.ts`, `main/services/models.test.ts`): duplicate rows skipped while others survive and the count is reported; variant fixtures match the right row; ambiguous cases still fail closed.

### Task 17: Fetch every benchmark row

Audit row: Backend #11. Research (OpenRouter list-benchmarks reference): no offset/page/cursor parameter; `max_results` minimum 1, no documented maximum, omitted returns all matching rows; rate limit 30 requests/min per key.

Requirements:
- Change the fixed query to `/api/v1/benchmarks?source=artificial-analysis&max_results=500` and the local row limit to 500. Keep the response size limit at 2 MB unless a 500-row fixture shows it is too small.
- Update the policy text in `AGENTS.md` (Release model metadata section) and `docs/plans/model-insights-plan.md` to the new fixed endpoint. If `packages/cli` references the old constant or URL, keep it consistent.

Tests: the parser accepts 101–500 rows and rejects 501; the request URL matches the new fixed endpoint (via the injected fetch in the runtime-core tests).

### Task 18: Show benchmark coverage

Audit row: Backend #4.

Requirements:
- The settings Benchmark insights panel shows "<n> of <m> Pad models matched" and "<k> of <l> visible models", computed in the renderer from `ModelInfo.benchmark`, plus the skipped-ambiguous count from status (Task 16) when non-zero.
- A collapsed disclosure lists unmatched Pad models (label · provider) with a reason: "Local model" for local deployments, otherwise "No benchmark row".

Tests: pure coverage helper; render shows counts and reasons.

### Task 19: Expose models.dev cost and canonical id

Audit row: Backend #6.

Requirements:
- `ModelInfo` (main and renderer) gains `cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }` (USD per 1M tokens, as models.dev reports it) and `canonicalModelId?: string`, from the matched models.dev row. Display-only (Global Constraint 5). Confirm `scripts/update-model-capabilities.mjs` keeps both fields in the bundled snapshot.

Tests (`main/services/models.test.ts`): a fixture row with cost and canonical id yields both; a row without them yields `undefined`.

### Task 20: Link duplicate models across providers

Audit row: UI #15 (owner chose separate, linked dots).

Requirements:
- Identity: `canonicalModelId` when present, else the lowercased model id leaf (text after the last `/`, date stamp kept).
- When another visible entry shares the identity: the settings marker label, the composer tag (Task 5) and the side card show "Also via <Provider>[, <Provider>]"; Browse rows show the same secondary text; hovering or focusing a settings marker highlights its placed siblings with a subtle shared-state treatment (no decorative border).

Tests: pure sibling helper (canonical vs leaf fallback, no self-links); render shows the "Also via" text.

### Task 21: Measure pace from real chat turns

Audit row: Backend #1. Closes the "device-local pace signal" item in `docs/plans/model-insights-plan.md`.

Requirements:
- In `main/services/llm-client.ts` streaming, per model response (not per whole turn): request start, first text or thinking delta, end, and output tokens from usage. Record a sample only for successful completions with ≥16 output tokens and ≥250 ms of generation: `ttftMs` and `tokensPerSecond = outputTokens / generationSeconds`.
- Store device-locally in `userData/model-pace.json` through the existing DataStore pattern: per `provider::model`, the last 20 samples; at most 500 models (prune least recently sampled). Corrupt files read as empty.
- Summaries: median TTFT, median tokens/s, sample count, last sampled time. Exposed over a new IPC channel (registered in the IPC contract inventory) and a renderer query hook.
- Onboarding reset deletes the file. Nothing is transmitted.

Tests: pure sample acceptance, rolling window and median; store resilience (corrupt/oversized file); IPC register-and-invoke following the existing handler test pattern.

### Task 22: Use measured speed for the pace axis

Audit row: UI #11.

Requirements:
- Placement sources gain `"measured"` (X only).
- Settings editor action **Set pace from measured speed**: for placed models with ≥3 samples, X = percentile of pace score among those models (lower is faster), where pace score = median TTFT ms + 500 / median tokens/s × 1000 (time to a 500-token answer). Sets `xSource: "measured"`, leaves Y alone, autosaves with Undo, and reports how many models changed and how many lacked samples.
- Settings marker labels show "<ttft> s first token · <tps> tok/s" when samples exist. Pad management gets **Clear measured speeds** (with confirmation, since it deletes history).

Tests: pure pace score and placement helper (insufficient samples untouched, ordering correct); the action saves the expected layout.

### Task 23: Richer hover card and benchmark freshness

Audit rows: UI #12 and Backend #12.

Requirements:
- `ModelHoverDetails` rows: **Price** "$<in> / $<out> per 1M" from `info.cost`; **Your speed** "<ttft> s first token · <tps> tok/s (<n> runs)" from pace summaries; benchmark date with "(over 60 days old)" when `asOf` is older than 60 days.
- Settings benchmark connection: when `fetchedAt` is older than 60 days, show "Benchmarks are over 60 days old. Fetch latest to update." No automatic fetching.

Tests: render details with cost and pace; staleness helper with an injected "now".

### Task 24: Remove dead code and duplicated logic

Audit rows: Backend #8 and #9.

Requirements:
- Delete `positionModels`, `estimatePosition`, the variant regex constants and unused `PositionConfidence` values; the List view's side card reads entries directly.
- Remove the dead Artificial Analysis display path from desktop model reads (`EMPTY_ARTIFICIAL_ANALYSIS_CATALOG` parameter, `hostedInfo` AA branch, `ModelInfo.ranking` if nothing reads it after this). Keep the AA runtime pieces still used by onboarding-reset cleanup and the CLI.
- One provider→author map shared by `models-catalog-core.ts` and `openrouter-benchmark-catalog-core.ts` (union, including `zai-coding-cn` and `xiaomi`); one model-id leaf normalizer; one shared pointer-to-point helper used by both Pad components.
- Move the `models:info` handler out of `main/handlers/attachments.ts` into a models/providers handler module and keep the IPC contract inventory green.

Tests: existing suites stay green; add a focused test only where shared logic changes behavior (e.g. a provider now matched through the unified author map).

### Task 25: Show cached benchmark scores in the CLI

Audit row: Backend #8 (CLI part).

The CLI's `insights` commands write `openrouter-insights.json` / `aa-insights.json`, but `/models info` reads only models.dev.

Requirements:
- `/models info` attaches benchmark scores from the CLI's OpenRouter insights cache through the same shared matcher the desktop uses (`resolveModelInfo`'s OpenRouter benchmark parameter). No network calls in `/models info`.
- Follow `packages/cli` conventions (own lockfile and tests; it bundles `main/services` sources directly).

Tests: a CLI test with a cached insights fixture shows the scores in `/models info` output; without a cache the output is unchanged.
