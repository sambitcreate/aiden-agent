# Gemini Native Upgrade Plan

Status: implementation plan only
Date: 2026-07-22
Depends on: `docs/pi-provider-integration-plan.md` (broader registry migration)
Pi packages pinned: `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core` `0.80.10`

## Scope

This plan covers a staged Gemini upgrade in three funded phases plus one explicitly deferred track:

- **Phase 0 — Catalog-driven runtime limits** (cheap win, no provider rewrite)
- **Phase 1 — Native Google provider via pi-ai** (`google-generative-ai` API, not the OpenAI-compat shim)
- **Phase 3 — Thinking/reasoning controls with shimmer UX + Gemini context caching**
- **Deferred — Gemini Live realtime multimodal** (out of scope here; see Deferred track)

Native **Google Search Grounding** and **cloud code execution** are *not* part of this plan. They are product/cost decisions that interact with the existing Exa tool and local `coding-tools.ts`, and they require a separate design.

This plan deliberately **narrows** `docs/pi-provider-integration-plan.md` to the single `google` provider so Gemini can move to its native transport without first migrating all seven presets. The full multi-provider registry migration remains the long-term target; Phase 1 here is written so its work is a strict subset of that plan's Phase 4 runtime routing.

## Why

Verified against the current codebase:

| Gap | Evidence | Consequence |
| --- | --- | --- |
| Gemini chat rides the OpenAI-compat endpoint | `main/services/config-store.ts:52-61` (`kind: "openai"`, `baseUrl: .../v1beta/openai`), `main/services/model-runtime-core.ts:33-35` | Native Gemini features (system instructions, safety settings, `responseSchema`, thinking config, context caching) are unreachable. |
| Runtime limits are fabricated | `main/services/model-runtime-core.ts:37-49` hardcodes `contextWindow: 128_000`, `maxTokens: 8192`, `reasoning: false` for every non-Codex model | Gemini's true ~1M context and 65K output (2.5 Pro/Flash) are throttled to 128K/8K. |
| Catalog already knows the real limits | `resources/model-capabilities.json` → `models-catalog-core.ts:104-105` → `model-picker.tsx:88-89` (UI display only) | The data exists but is never wired into the runtime `Model`. |
| No reasoning UI or payload mapping | `model-picker-pad.tsx` is selection-only; no `thinkingConfig` anywhere; `model-runtime-core.ts:44` sets `reasoning: false` | Users cannot control Gemini thinking budget/level. |
| No context caching | No `cachedContent`/`createCachedContent` in app TS; `usage-accounting.ts:27-36` only *reads* `cachedContentTokenCount` if returned | Workspace repo context is re-transmitted every turn, costing latency and tokens. |
| Voice is one-shot REST, chat is OpenAI adapter | `main/services/transcription.ts:105-137` (`generateContent`) vs chat OpenAI-compat | Dual integration; voice stays one-shot (acceptable — Live is deferred). |

## Non-goals

- No Gemini Live / realtime WebSocket voice or screen streaming (deferred).
- No Google Search Grounding or cloud code-execution sandbox (separate design).
- No migration of the other six presets (covered by the broader plan).
- No public-catalog calls from the running app (per `AGENTS.md` release-model policy).

---

## Phase 0 — Catalog-driven runtime limits

The fastest correct fix: stop fabricating `128K/8192` and feed the release-bundled capability snapshot into the runtime `Model`. This helps **all** providers, not just Gemini, and ships before any transport change.

### Files

- `main/services/model-runtime-core.ts`
- `main/services/models-catalog-core.ts` (expose a lookup)
- `main/services/generation-runtime.ts` (if base-url/key resolution needs the provider id for catalog slug mapping)
- focused test: `main/services/model-runtime-core.test.ts`

### Tasks

1. Add a catalog lookup `resolveRuntimeLimits(providerId, modelId): { contextWindow, maxTokens, reasoning, input }` that reads the bundled `model-capabilities.json` snapshot via the existing provider→slug mapping (`models-catalog-core.ts:42`, `gemini` → `google`).
2. In `buildModel()` (`model-runtime-core.ts:37-49`), replace the hardcoded `contextWindow`, `maxTokens`, `reasoning: false`, and `input: ["text"]` with catalog values when present.
3. Precedence: Pi-exact model metadata (when available) → bundled snapshot → conservative fallback (`128_000`/`8192`, `reasoning: false`, text-only). Unknown stays unknown; never inflate.
4. Set `input: ["text","image"]` only when the catalog marks the model vision-capable, so image attachments keep gating correctly.
5. Do **not** contact models.dev or Artificial Analysis at runtime. The bundled snapshot only.

### Exit gate

`gemini-2.5-pro` resolves to `contextWindow ≈ 1_048_576`, `maxTokens ≈ 65_536`, `reasoning: true`; a model absent from the snapshot still falls back to `128K/8192`. Unit tests cover hit, miss, and partial-field cases. No network in the running app.

---

## Phase 1 — Native Google provider via pi-ai

Move Gemini chat from the generic OpenAI-compat adapter to pi-ai's `google-generative-ai` transport. This is a **single-provider** slice of the broader registry plan, reusing its contracts so the work is not throwaway.

### Strategy decision

Use pi-ai's native Google stream, not a hand-rolled `@google/genai` client. pi-ai `0.80.10` already ships the `google-generative-ai` API with thinking support, and it is the same runtime the broader migration standardizes on. Adding `@google/genai` directly would create a second Google dependency to keep in lock-step and would not integrate with Pi's `Models`/`streamSimple` dispatch.

Google is registered as a **Pi built-in provider** (`google`), reached through the same registry-lookup path the broader plan defines, rather than as a seventh preset with `kind: "openai"`.

### Files

- `main/services/provider-registry.ts` (new, or extend the Codex-established lookup seam)
- `main/services/model-runtime-core.ts`
- `main/services/llm-client.ts`
- `main/services/config-store.ts` (stop seeding `gemini` as `kind: "openai"`; map to `google`)
- `main/services/types.ts` / `renderer/lib/types.ts` (provider id `google`; no new `ProviderKind` string needed if we route by Pi provider id)
- `main/services/provider-migration.ts` (or a scoped migration step)
- `main/services/chat-title.ts` (route through the same native model)

### Tasks

1. Register Pi's built-in `google` provider and resolve the exact Pi `Model` by (`google`, modelId) at send time — mirroring how `openai-codex` already resolves through Pi `Models` (see `.memory/PROJECT-CONTEXT.md` "Pi provider-runtime status").
2. Set `streamFn` to Pi's native Google stream so requests use `google-generative-ai` against `https://generativelanguage.googleapis.com/v1beta` (not the `/openai` shim).
3. Authentication: reuse the encrypted credential layer; map the legacy `gemini` API key to the `google` provider. Reject OAuth-only credentials that are not valid for the AI Studio endpoint.
4. Migration: remap `gemini` → `google` for the stored credential, chat/settings selection, pinned models (`aiden-agent.pinnedModels` entries `gemini::<model>` → `google::<model>`), and the renderer selection keys (`aiden-agent.providerId`, `aiden-agent.model`). Preserve the user's chosen model id.
5. Model catalog: source the selectable list from Pi availability for `google`, falling back to the bundled snapshot for metadata. Keep `gemini-2.0-flash` as a safe default only if present; prefer current 2.x ids. Stop listing `gemini-1.5-*` (absent from the current bundled `google` snapshot).
6. Chat titles: route title generation through the same native `google` model via `completeSimple`, preserving existing timeout/fallback semantics and the Apple Foundation Models routing preference.
7. Vision: use `model.input.includes("image")` from Pi metadata (Phase 0 supplies this) to gate image attachments.
8. Keep cloud voice transcription (`transcription.ts`) unchanged in this phase — it already uses native `generateContent` and stays one-shot.

### Exit gate

A chat on the `google` provider streams through `google-generative-ai` (asserted in tests via a faux Google endpoint), uses the migrated credential, honors catalog-driven context/output limits from Phase 0, and legacy `gemini` selections/pins survive migration. OpenAI/Anthropic and the remaining presets are untouched.

---

## Phase 3 — Thinking controls with shimmer UX + context caching

Two coupled features that only make sense on the native transport from Phase 1.

### 3a — Thinking / reasoning controls

Expose Gemini's thinking config in the composer and pass it through the backend IPC to the Pi stream.

**Backend**

- Add a per-request `thinking` option threaded from the renderer through the chat IPC to the Pi Google stream. Per pi-ai docs, the Google path accepts `thinking: { enabled, budgetTokens }` (`budgetTokens: -1` dynamic, `0` disable) and `thinkingLevelMap` for level mapping.
- Define the DTO in both `main/services/types.ts` and `renderer/lib/types.ts`. Never accept arbitrary provider payloads from the renderer — map a small enum (e.g. `off | low | medium | high | dynamic`) to `budgetTokens`/level in main.
- Only enable when the resolved Pi model reports `reasoning: true` (from Phase 0/1 metadata). Ignore or no-op for non-reasoning models.

**Renderer / UX**

- Add a **Thinking** control in the composer near the model picker (a compact segmented/stepped control, not the 2D pad — the pad stays selection-only). Surface it only for reasoning-capable models.
- **Shimmer effect:** while the model is in its thinking phase, render the assistant's pending/thinking region with a shimmer (an animated gradient sweep) to signal active reasoning distinct from normal token streaming. Implement with the existing Tailwind/component layer — a CSS keyframed background-position sweep on a muted surface, gated by `prefers-reduced-motion`/the Reduce Motion preference (render a static "Thinking…" state instead).
- Stream thinking distinctly: if the Pi stream exposes thinking/reasoning deltas, render them in a collapsible "Thinking" affordance above the final answer, shimmering until the first content delta arrives.
- Persist the last-used thinking level per model in backend settings (consistent with model-selection persistence), not `localStorage` as the authority.

### 3b — Gemini context caching

Cache the stable workspace/system prefix so long sessions and large repo contexts are not re-transmitted each turn.

**What to cache** (stable prefix only): system prompt, tool definitions, and the workspace repo context snapshot (git status summary + project file summaries) that Aiden already assembles. Do **not** cache volatile per-turn transcript history.

**Backend**

- New `main/services/gemini-context-cache.ts` owning cache lifecycle through the Google `cachedContents` API: create on workspace mount / first turn, reuse by cache name, refresh on TTL or when the workspace fingerprint changes, and delete on workspace unmount/app shutdown.
- Key the cache by a content fingerprint (hash of system prompt + tool set + workspace snapshot) so identical prefixes reuse one cache; bump on change.
- Thread the cache reference into the Pi Google request. Surface `cachedContentTokenCount` (already read by `usage-accounting.ts:27-36`) into the usage ledger as cache-read tokens.
- Fail open: if cache creation fails or is unsupported for the model, fall back to an uncached request without failing the turn.
- Respect the privacy boundary: caching sends workspace content to Google; only do it when the `google` provider is active and the user has not required a local-only session.

**Exit gate (Phase 3)**

A reasoning-capable `google` model shows the Thinking control; selecting a level changes the streamed request's thinking config; the shimmer renders during the thinking phase and respects Reduce Motion. With a workspace mounted, repeat turns reuse a context cache (verified by fingerprint reuse and cache-read token accounting), and cache failure never blocks a turn.

---

## Deferred — Gemini Live realtime multimodal

Intentionally out of scope. Rationale captured so a future plan can pick it up:

- Product surface is large (floating window / menu-bar tray presence, interruptibility, mic & screen permissions, UX for live screen/canvas streaming) — not a transport swap.
- Current one-shot voice (`MediaRecorder` → `generateContent`) is adequate for dictation; Live is a new interaction model, not a fix.
- Depends on the native transport landing first (Phase 1) but adds a WebSocket bridge in `main/services/` plus significant renderer work.

Revisit as a standalone plan once Phases 0–3 are stable and there is validated product demand for low-latency interruptible voice / real-time screen share.

---

## Sequencing & PR split

1. **PR 1 — Phase 0:** catalog-driven runtime limits + tests.
2. **PR 2 — Phase 1:** native `google` provider, credential/selection/pin migration, title routing.
3. **PR 3 — Phase 3a:** thinking config plumbing + composer Thinking control + shimmer.
4. **PR 4 — Phase 3b:** Gemini context cache service + usage accounting.

Each PR keeps prior behavior available until its replacement is test-covered, matching the repository's staged-migration convention.

## Test matrix (delta, in addition to the broader plan's matrix)

| Area | Required coverage |
| --- | --- |
| Runtime limits | catalog hit/miss/partial, vision gating, fallback stays 128K/8192, no runtime network |
| Native Google | `google-generative-ai` dispatch via faux endpoint, credential mapping, migrated selection/pins, 1.5 ids removed |
| Thinking | level→budget mapping in main, renderer enum validation, no-op on non-reasoning models, Reduce Motion shimmer fallback |
| Context cache | fingerprint reuse, TTL/invalidation on workspace change, fail-open on cache error, cache-read token accounting, local-only session never caches |

No test requires real Google credentials, paid tokens, or public network access.

## Definition of done

- Gemini chat runs on the native `google-generative-ai` transport, not the OpenAI-compat shim.
- Runtime context/output limits come from the bundled snapshot (Gemini ≈ 1M / 65K where applicable), not a hardcoded 128K/8192.
- Reasoning-capable Gemini models expose a Thinking control; thinking streams with a shimmer affordance that respects Reduce Motion.
- Workspace prefix is context-cached with fingerprint reuse, and cache-read tokens are metered; cache failure never blocks a turn.
- Legacy `gemini` credentials, selections, and pins migrate to `google` without silent loss.
- No credentials or provider payloads cross the preload boundary; no runtime public-catalog calls.
- Gemini Live multimodal remains explicitly deferred with rationale recorded.
