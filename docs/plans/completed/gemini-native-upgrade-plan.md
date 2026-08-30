# Gemini Native Upgrade Plan

> Post-plan update (August 2026): the separately scoped Gemini 3.5 Voice
> Transcription plan shipped voice-only Live transcription. Realtime multimodal
> screen sharing remains deferred; historical statements below describe this plan's
> original boundary.

Status: Phases 0, 1, and 3 implemented on 2026-07-23–24; deferred tracks remain planned
Date: 2026-07-22
Depends on: `docs/plans/pi-provider-integration-plan.md` (broader registry migration)
Pi packages pinned: `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core` `0.80.10`

## Scope

This plan covers a staged Gemini upgrade in three funded phases plus one explicitly deferred track:

- **Phase 0 — Catalog-driven runtime limits** (cheap win, no provider rewrite)
- **Phase 1 — Native Google provider via pi-ai** (`google-generative-ai` API, not the OpenAI-compat shim)
- **Phase 3 — Thinking/reasoning controls with shimmer UX + Gemini context caching**
- **Deferred — Gemini Live realtime multimodal** (out of scope here; see Deferred track)

Native **Google Search Grounding** and **cloud code execution** are *not* part of this plan. They are product/cost decisions that interact with the existing Exa tool and local `coding-tools.ts`, and they require a separate design.

This plan deliberately **narrows** `docs/plans/pi-provider-integration-plan.md` to the single `google` provider so Gemini can move to its native transport without first migrating all seven presets. The full multi-provider registry migration remains the long-term target; Phase 1 here is written so its work is a strict subset of that plan's Phase 4 runtime routing.

## Why

Original gaps and shipped outcomes, verified against the current codebase:

| Gap | Evidence | Outcome |
| --- | --- | --- |
| Gemini chat rode the OpenAI-compat endpoint | Before Phase 1, the `gemini` preset used Google's `/v1beta/openai` compatibility route. | Phase 1 replaced it with Pi's native `google-generative-ai` transport and migrated legacy state to `google`. |
| Runtime limits were fabricated | Before Phase 0, `model-runtime-core.ts` hardcoded `contextWindow: 128_000`, `maxTokens: 8192`, `reasoning: false`, and text-only input for every non-Codex model. | Phase 0 now resolves connection-discovered overrides over provider-scoped Pi metadata, then the bundled snapshot and conservative fallback. |
| Catalog already knows the real limits | `resources/model-capabilities.json` → `models-catalog-core.ts` → `models-catalog.ts` | Phase 0 now uses this offline snapshot for runtime limits as well as display metadata; the running app still makes no catalog network request. |
| No reasoning UI or payload mapping | Before Phase 3a, `model-picker-pad.tsx` was selection-only and no thinking level reached the Pi Agent; Phase 0 identified reasoning-capable runtime models. | Phase 3a now provides a bounded per-model control and native request mapping. |
| No context caching before Phase 3b | `main/services/gemini-context-cache.ts` now owns explicit cache creation, reuse, invalidation, and cleanup. | Eligible native Google workspace turns reuse the stable Pi prefix and report cache-read usage without caching transcript or file contents. |
| Voice and chat use distinct native paths | Voice uses one-shot `generateContent`; chat uses Pi's native streaming transport. | The split is intentional: one-shot voice remains adequate while Gemini Live is deferred. |

## Non-goals

- No Gemini Live / realtime WebSocket voice or screen streaming (deferred).
- No Google Search Grounding or cloud code-execution sandbox (separate design).
- No migration of the other six presets (covered by the broader plan).
- No public-catalog calls from the running app (per `AGENTS.md` release-model policy).

---

## Phase 0 — Catalog-driven runtime limits

The fastest correct fix: stop fabricating `128K/8192` and feed the release-bundled capability snapshot into the runtime `Model`. This helps **all** providers, not just Gemini, and ships before any transport change.

**Implemented 2026-07-23.** Runtime resolution follows Pi's provider-owned model composition: a mapped built-in provider keeps its exact Pi metadata even when its base URL routes through a proxy, connection-discovered per-model fields override that metadata, the provider-scoped bundled snapshot fills remaining fields, and an unknown custom provider falls back conservatively without borrowing another provider's model. Image gating now reads only the resolved runtime model. The existing compatibility transport is intentionally unchanged until Phase 1.

### Shipped files

- `main/services/model-runtime-core.ts`
- `main/services/models-catalog-core.ts`
- `main/services/generation-runtime.ts`
- `main/services/chat-title.ts`
- focused runtime, generation, model, and title tests

### Shipped behavior

1. `resolveProviderRuntimeLimits(...)` composes connection-discovered fields, an exact Pi model, and the bundled `model-capabilities.json` entry for the selected provider/model.
2. `buildModel()` resolves `contextWindow`, `maxTokens`, reasoning, and input capabilities instead of fabricating one profile for every non-Codex model.
3. Precedence is connection-discovered fields → provider-scoped Pi exact metadata → provider-scoped bundled snapshot → conservative fallback (`128_000`/`8192`, no reasoning, text-only). Unknown providers cannot borrow another provider's model.
4. Image attachments are enabled only when the resolved runtime model includes image input.
5. The running app does not contact models.dev or Artificial Analysis; it reads the bundled snapshot only.

### Verification

`gemini-2.5-pro` resolves to `contextWindow ≈ 1_048_576`, `maxTokens ≈ 65_536`, `reasoning: true`; a model absent from the snapshot still falls back to `128K/8192`. Unit tests cover hit, miss, and partial-field cases. No network in the running app.

---

## Phase 1 — Native Google provider via pi-ai

Phase 1 moved Gemini chat from the generic OpenAI-compat adapter to pi-ai's `google-generative-ai` transport. It is a **single-provider** slice of the broader registry plan and reuses the same contracts.

**Implemented 2026-07-24.** A process-wide Pi registry now owns the native `google` model and stream. The compatibility `gemini` preset, encrypted credential, backend settings, renderer provider selection, pinned models, Model Pad placements, chat metadata, and scheduled tasks migrate idempotently to `google`. Settings keeps Google's endpoint and authentication contract fixed, while model discovery intersects Google's live `generateContent` catalog with Pi's supported native models. Title generation inherits the native route through the shared runtime resolver; one-shot cloud transcription keeps its existing REST implementation while reading the migrated Google credential.

### Strategy decision

Use pi-ai's native Google stream, not a hand-rolled `@google/genai` client. pi-ai `0.80.10` already ships the `google-generative-ai` API with thinking support, and it is the same runtime the broader migration standardizes on. Adding `@google/genai` directly would create a second Google dependency to keep in lock-step and would not integrate with Pi's `Models`/`streamSimple` dispatch.

Google is registered as a **Pi built-in provider** (`google`), reached through the same registry-lookup path the broader plan defines, rather than as a seventh preset with `kind: "openai"`.

### Shipped files

- `main/services/provider-registry.ts`
- `main/services/google-provider.ts`
- `main/services/model-runtime-core.ts`
- `main/services/llm-client.ts`
- `main/services/config-store.ts`, `main/services/secrets.ts`, and `main/services/schedule-store.ts`
- `renderer/lib/google-provider-migration.ts` and `renderer/shared/google-provider.ts`
- provider, model, migration, chat-store, schedule, settings, and protocol tests

### Shipped behavior

1. Pi's built-in `google` provider resolves the exact model at send time and uses the native Google stream against the fixed AI Studio endpoint rather than `/openai`.
2. The encrypted credential layer migrated the legacy `gemini` API key to `google` without exposing plaintext.
3. Stored settings, chat metadata, scheduled tasks, renderer selection, pinned models, and Model Pad placement remap `gemini` to `google` idempotently while preserving the chosen model.
4. Model discovery intersects Google's live `generateContent` list with Pi's supported native models and uses the bundled snapshot for offline metadata.
5. Chat titles inherit native Google routing through the shared runtime resolver, and vision remains gated by the resolved runtime model.
6. Cloud voice transcription intentionally retains one-shot native `generateContent` and reads the migrated Google credential.

### Verification

A chat on the `google` provider streams through `google-generative-ai` (asserted in tests via a faux Google endpoint), uses the migrated credential, honors catalog-driven context/output limits from Phase 0, and legacy `gemini` selections/pins survive migration. OpenAI/Anthropic and the remaining presets are untouched.

---

## Phase 3 — Thinking controls with shimmer UX + context caching

Two coupled features that only make sense on the native transport from Phase 1.

### 3a — Thinking / reasoning controls

Phase 3a exposes Gemini's thinking config in the composer and passes it through the backend IPC to the Pi stream.

**Implemented 2026-07-24.** Reasoning-capable native Google models now show a compact composer control drawn from the bounded `off | low | medium | high` contract, while model metadata removes choices that Pi would collapse to the same native outcome. Models that cannot truly disable thinking say **Hide** instead of **Off** and explain that their minimum thinking remains internal. The backend atomically owns each saved per-model preference, validates the small enum and exact model-supported subset, and fails closed to the no-exposed-thoughts state outside a supported native Google model. A fresh Pi Agent receives the selected `thinkingLevel`; Pi maps it to the correct Google `thinkingConfig`. Deliberately exposed thought deltas render in a collapsible transcript surface, with shimmer limited to the pre-answer thinking interval and suppressed by Aiden's Reduce Motion contract.

**Backend**

- A per-request `thinkingLevel` travels from the renderer through chat IPC into Pi Agent state. Pi's simple-stream path maps `off | low | medium | high` to the model-appropriate native Google level or token budget.
- Main and renderer share the bounded DTO; arbitrary provider payloads are never accepted from the renderer.
- Runtime exposure requires a native Google model reporting `reasoning: true`; unsupported providers and models fail closed to `off`.

**Renderer / UX**

- A compact **Thinking** control appears near the model picker only for reasoning-capable native Google models; the 2D pad remains selection-only.
- The pending thinking surface uses a muted shimmer until answer content begins. Aiden's Reduce Motion contract replaces the animation with a static state.
- Deliberately exposed thought deltas render in a collapsible affordance above the answer.
- Main-process settings, rather than `localStorage`, own the last-used thinking level per model.

### 3b — Gemini context caching

Cache the stable workspace/system prefix so long sessions and large repo contexts are not re-transmitted each turn.

**Implemented 2026-07-24.** Eligible native Google turns in mounted workspaces now cache Pi's exact stable system instruction and tool definitions plus a bounded deterministic metadata-only workspace file/Git index. The cache excludes transcript history and file contents. Aiden fingerprints the credential, model, stable Pi payload, and workspace snapshot; reuses identical caches for one hour; retains at most eight live fingerprints per workspace; shares in-flight creation while preserving per-waiter cancellation; and uses bounded create/delete requests. Unsupported, undersized, timed-out, or unavailable caches fail open with a short negative backoff. Changed content receives a distinct cache; older entries remain only within the eight-entry/TTL bound and are deleted on eviction, expiry cleanup, explicit workspace invalidation or removal, and shutdown. Google cache-read tokens flow into the existing usage ledger.

**What is cached** (stable prefix only): system prompt, tool definitions, and a bounded metadata-only workspace index containing relative file names and Git status. Do **not** cache volatile transcript history or workspace file contents.

**Backend**

- `main/services/gemini-context-cache.ts` owns lifecycle through Google's fixed `cachedContents` API: create on the first eligible turn, reuse by cache name, create a distinct entry when the fingerprint changes, and delete on expiry cleanup, invalidation, eviction, or app shutdown.
- Key the cache by a content fingerprint of the credential, model, system prompt, tool set, and workspace snapshot so identical prefixes reuse one cache and changed content cannot.
- Thread the cache reference into the Pi Google request. Surface `cachedContentTokenCount` (already read by `usage-accounting.ts:27-36`) into the usage ledger as cache-read tokens.
- Fail open with bounded requests and negative backoff: if cache creation fails or is unsupported for the model, continue the turn uncached.
- Respect the privacy boundary: cache only native `google` turns with a mounted folder and workspace permission above **No Access**. Credentials stay in request headers, and no cache metadata crosses the preload boundary.

**Exit gate (Phase 3)**

Phase 3 is complete: a reasoning-capable `google` model shows the Thinking control; selecting a level changes the streamed request's thinking config; the shimmer renders during the thinking phase and respects Reduce Motion. Eligible mounted workspaces reuse context caches with fingerprint and TTL bounds, cache reads are metered, and cache failure never blocks a turn.

---

## Deferred — Gemini Live realtime multimodal

Intentionally out of scope. Rationale captured so a future plan can pick it up:

- Product surface is large (floating window / menu-bar tray presence, interruptibility, mic & screen permissions, UX for live screen/canvas streaming) — not a transport swap.
- Current one-shot voice (`MediaRecorder` → `generateContent`) is adequate for dictation; Live is a new interaction model, not a fix.
- Builds on the native transport from Phase 1 but would add a WebSocket bridge in `main/services/` plus significant renderer work.

Revisit as a standalone plan once Phases 0–3 are stable and there is validated product demand for low-latency interruptible voice / real-time screen share.

---

## Completed delivery split

1. **Phase 0:** catalog-driven runtime limits + tests.
2. **Phase 1:** native `google` provider, credential/selection/pin migration, title routing.
3. **Phase 3a:** thinking config plumbing + composer Thinking control + shimmer.
4. **Phase 3b:** Gemini context cache service + usage accounting.

The phases landed as isolated local commits. Their focused coverage and the current full verification matrix pass.

## Test matrix (delta, in addition to the broader plan's matrix)

| Area | Required coverage |
| --- | --- |
| Runtime limits | catalog hit/miss/partial, vision gating, fallback stays 128K/8192, no runtime network |
| Native Google | `google-generative-ai` dispatch via faux endpoint, credential mapping, migrated selection/pins, 1.5 ids removed |
| Thinking | level→budget mapping in main, renderer enum validation, no-op on non-reasoning models, Reduce Motion shimmer fallback |
| Context cache | fingerprint reuse, TTL/invalidation on workspace change, bounded churn and requests, per-waiter cancellation, fail-open on cache error, cache-read token accounting, folderless and **No Access** workspaces never cache |

No test requires real Google credentials, paid tokens, or public network access.

## Definition of done

- Gemini chat runs on the native `google-generative-ai` transport, not the OpenAI-compat shim.
- Runtime context/output limits come from the bundled snapshot (Gemini ≈ 1M / 65K where applicable), not a hardcoded 128K/8192.
- Reasoning-capable Gemini models expose a Thinking control; thinking streams with a shimmer affordance that respects Reduce Motion.
- Workspace prefix is context-cached with fingerprint reuse, and cache-read tokens are metered; cache failure never blocks a turn.
- Legacy `gemini` credentials, selections, and pins migrate to `google` without silent loss.
- No credentials or provider payloads cross the preload boundary; no runtime public-catalog calls.
- Gemini Live multimodal remains explicitly deferred with rationale recorded.
