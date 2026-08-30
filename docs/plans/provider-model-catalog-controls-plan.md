# Provider Model Visibility and Catalog Refresh

Status: Planned

Date: 2026-08-30  
Source: provider setup screenshot and repository audit by three parallel subagents  
Related: `docs/plans/dynamic-model-catalog-plan.md`, `docs/plans/pi-provider-integration-plan.md`, and `docs/plans/onboarding-auth-and-provider-validation-plan.md`

## Goal

Make model administration in Settings → Providers deliberate and discoverable:

1. Add a provider-wide **Hide all** action beside the existing per-model switches and **Show all** action.
2. Refresh the tracked bundled models.dev capability snapshot after every push or merge to `main`, while retaining the release-time refresh already run by `npm run dist`.
3. Replace the existing icon-only provider refresh affordance with a labeled **Update model catalogs** action that explicitly refreshes selectable provider inventory and models.dev capability metadata, reports partial success honestly, and preserves offline last-known-good data.

The two catalogs remain separate authorities. A catalog refresh must never make a models.dev-only row executable.

## Current state

| Concern                       | Current implementation                                                                                                                                    | Gap                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Model visibility              | `ProviderModelVisibility` provides searchable per-model switches and **Show all**. `hiddenModelsByProvider` is persisted and projected to paired clients. | There is no atomic **Hide all** action.                                                                                          |
| Visibility wildcard           | `isModelHidden` treats `"*"` as all hidden. Google transcription-only uses it as a policy gate.                                                           | An individual model cannot override `"*"`, so reusing it for the new user action would make a switch appear broken.              |
| Selectable built-in inventory | Pi provider records plus validated, device-local pi.dev overlays; stale refresh runs after launch and explicit force refresh already exists.              | The Providers action is icon-only and easy to miss; per-source outcome is not explained.                                         |
| Capability metadata           | `resources/model-capabilities.json` is a bundled models.dev snapshot used offline.                                                                        | The tracked snapshot is not refreshed on ordinary `main` merges, and the live app has no explicit foreground refresh/cache path. |
| Release updates               | `npm run dist` invokes `release:update-model-capabilities` before packaging.                                                                              | Keep this defense-in-depth path; do not rely solely on post-merge automation.                                                    |
| Native clients                | Mac projects hidden flags/defaults through the existing remote catalog; iOS and Android filter locally.                                                   | No wire change is required, but all-hidden and refresh regressions need native verification.                                     |

## Decisions

### 1. Preserve two catalog authorities

- **Selectable inventory:** Pi/provider discovery and Aiden's validated pi.dev overlays. Only this layer may add a model to `Provider.models` or make it selectable.
- **Capability metadata:** bundled or explicitly refreshed models.dev data for names, modalities, capability hints, identity matching, and other display/ranking evidence.
- **Runtime admission:** continue using the immutable bundled release snapshot and Pi/provider model records. A device-fetched models.dev snapshot must not raise context/output limits, admit a non-chat model, change routing, or alter an active turn.

The Providers action may refresh both sources in one foreground operation, but its result must report them independently.

### 2. Amend the models.dev network policy narrowly

The current repository policy allows models.dev only through `npm run models:refresh` and `npm run dist`. Implementation must update `AGENTS.md` and its mirrored policy documentation to permit exactly two additional paths:

- the post-merge GitHub Actions workflow; and
- a user-initiated, foreground **Update model catalogs** action in Settings → Providers.

Startup, ordinary model reads, unpacked development, background polling, onboarding navigation, and model-picker opens remain network-free for models.dev. The live request uses only the fixed `https://models.dev/api.json` endpoint and never sends provider credentials, Model Pad credentials, cookies, prompts, chat content, model selections, custom endpoints, or an install identifier.

### 3. Replace the legacy visibility representation

Do not enumerate every hidden model and do not overload the policy-owned `"*"` marker. Catalogs can exceed the current 512-hidden-model/provider and 4,096-total bounds.

Introduce a versioned user-visibility rule per provider:

```ts
interface ProviderModelVisibilityRule {
  defaultVisibility: "shown" | "hidden";
  exceptions: string[];
}
```

- `defaultVisibility: "shown"` means `exceptions` are hidden model IDs.
- `defaultVisibility: "hidden"` means `exceptions` are explicitly shown model IDs.
- **Hide all** sets `{ defaultVisibility: "hidden", exceptions: [] }` atomically.
- Turning one switch on after **Hide all** adds that model to the shown exceptions.
- **Show all** removes the provider rule.
- Newly discovered models follow the provider default. After **Hide all**, a catalog refresh therefore does not unexpectedly expose a new model.

Keep the Google transcription-only policy separate from user visibility and evaluate it first. Migrate legacy arrays as follows:

- ordinary ID arrays → `defaultVisibility: "shown"` with those IDs as hidden exceptions;
- Google `"*"` while `geminiUsageScope === "transcription_only"` → policy-owned hidden state, with any other IDs retained as ordinary user-hidden exceptions for a later full-model scope;
- any other legacy `"*"` → `defaultVisibility: "hidden"` with no shown exceptions.

Read legacy portable settings, write only the new canonical form, cap and validate exception identities, and retain the existing total/provider bounds for exceptions rather than catalog cardinality.

### 4. Use explicit, reversible UI language

- Label the action **Hide all**, not “Uncheck all.” It describes the outcome and pairs with **Show all**.
- Bulk scope is the whole provider, even while search is active. Search must not silently change the action to “matching models only.”
- In mixed state, show both actions; in all-shown/all-hidden state, show only the applicable action.
- During any bulk mutation, disable both bulk actions and all switches. Use **Hiding…** / **Showing…** and an `aria-live` status; preserve the prior list on failure.
- No confirmation dialog is needed because visibility is presentation-only, reversible, and does not break existing chats.
- Allow the header action group to wrap in the narrow setup dialog. Reuse existing semantic tokens, compact buttons, focus rings, disabled states, and reduced-motion behavior from the reviewed UI references.

### 5. Apply progressive disclosure without hiding important state

The provider setup dialog's primary task is connecting or managing the provider. A long searchable model list is secondary detail, but its current state and bulk actions are important model-management information.

- **Always visible:** available-model count, `N shown · N hidden` summary, **Hide all / Show all**, the labeled **Update model catalogs** action, busy state, blocking/recoverable errors, all-hidden warning, and the explicit catalog-network/privacy explanation.
- **Explicit disclosure:** place search and individual model switches behind a nearby **Manage individual models** trigger. Keep a stable summary visible when collapsed so non-default visibility never vanishes.
- **Contextual disclosure:** reveal retry details after a failed refresh and source-specific status after a partial result. The failure itself remains visible at the summary level.
- **Secondary detail:** exact pi.dev/models.dev source labels and timestamps may live under **Catalog details**, while the overall updated/cached/failed outcome remains visible.
- **Separate tasks:** custom-provider endpoint discovery remains in its existing editor workflow; do not fold that substantial connection task into catalog details.

Default the individual-model disclosure closed in ordinary provider setup because most users can connect the provider without scanning dozens of rows. Open it when the user explicitly chooses model management or when a model-visibility validation error requires attention. Do not persist this one-dialog expansion state across sessions. All-hidden and other non-default states remain clear in the collapsed summary.

Use a real button with `aria-expanded` and `aria-controls`; Enter and Space must toggle it, focus normally stays on the trigger, and collapsed descendants must leave both the tab order and accessibility tree. Opening or closing must preserve scroll position and keep the inverse action in the same place. Avoid decorative disclosure motion; any short transition must flatten under reduced motion.

## Delivery plan

### Phase 0 — Policy, contract, and workflow preflight

1. Record the four allowed models.dev paths in `AGENTS.md`, the mirrored contributor policy, `docs/releasing.md`, and this plan:
   - `npm run models:refresh`;
   - `npm run dist`;
   - post-merge catalog workflow;
   - explicit Providers action.
2. Inspect the `main` branch ruleset. Prefer a scoped GitHub Actions bot commit. If protected `main` rejects it, use one automation branch plus an auto-merge pull request after the focused checks; do not add a bypassing personal token.
3. Freeze the models.dev cache envelope and refresh DTO before UI work.
4. Confirm the existing provider setup and final onboarding Model freedom tile copy can explain the explicit network action without adding a new tile or illustration.

**Exit gate:** written authority, privacy, branch-protection, cache-precedence, and partial-success contracts are accepted.

### Phase 1 — Versioned model visibility state

Primary files:

- `renderer/shared/model-visibility.ts`
- `main/services/types.ts`
- `renderer/lib/types.ts`
- `main/services/config-store-core.ts`
- `main/services/portable-config-core.ts`
- `renderer/shared/gemini-usage-scope.ts`

Tasks:

1. Add normalization, migration, visibility resolution, hide-all, show-all, and single-model override helpers for the new rule.
2. Separate the Google transcription-only gate from user preferences while preserving hidden choices when the scope later changes.
3. Add atomic config-store mutations. The renderer passes only provider/model identities, never a catalog-sized model list.
4. Update every visibility consumer, including model selection/default fallback, command palette, Assistant, scheduled tasks, Telegram, Bots, and Mac-to-mobile projections.
5. Preserve existing-chat execution and recovery even when no model is visible for new work.

**Exit gate:** Hide all → show one → hide it again works for current and future catalog rows, including catalogs larger than the legacy hidden-ID ceiling.

### Phase 2 — Provider visibility controls

Primary files:

- `renderer/components/settings/provider-model-visibility.tsx`
- `renderer/lib/ipc.ts`
- `main/handlers/providers.ts`
- focused component and E2E tests

Tasks:

1. Keep the visibility summary and **Hide all / Show all** actions visible, and put search plus individual switches behind a specific **Manage individual models** disclosure.
2. Use a unified pending-operation state for bulk and row changes.
3. Keep the action provider-wide while filtered; expose exact shown/hidden counts from the normalized rule.
4. Disable bulk and row mutations during a pending operation and retain cached state after an error.
5. Verify collapsed/expanded, all-shown, partial, all-hidden, no-match, narrow-dialog, keyboard, screen-reader, and reduced-motion states.
6. Keep custom-provider discovery semantics intact: unsaved discovered models follow the provider rule without sending their IDs through IPC.

**Exit gate:** a user can hide all models in the pictured provider dialog, selectively re-enable one, and see model pickers update immediately without affecting existing chats.

### Phase 3 — Device-local models.dev metadata cache

Primary files:

- refactor shared validation from `scripts/model-snapshot-core.mjs` into a runtime-safe core used by both release and live paths
- new `main/services/models-dev-cache-core.ts`
- new `main/services/models-dev-cache.ts`
- `main/services/models-catalog.ts`
- provider/model-info query invalidation

Tasks:

1. Fetch only the fixed HTTPS endpoint with redirect rejection, a 30-second deadline, streaming byte bound, provider/model cardinality bounds, identity-length limits, and numeric ceilings.
2. Persist `{ schemaVersion, appVersion, fetchedAt, catalog }` atomically under Electron `userData` with mode `0600`; preserve the last-known-good cache on every failure.
3. Coalesce concurrent requests and keep raw upstream bodies/errors main-process-private.
4. On startup, hydrate a valid cache for the current app version offline. Ignore an older-version cache so a newly installed release's freshly bundled snapshot wins.
5. Split catalog consumers:
   - immutable bundled/Pi authority for runtime limits and request admission;
   - mutable validated bundled-or-device metadata for display, identity, and ranking.
6. Publish a successful refresh to in-memory readers only after the durable write commits. Active turns remain pinned.

**Exit gate:** an explicit refresh updates visible metadata without relaunch, while ordinary reads perform no network access and runtime admission remains bundle/provider-owned.

### Phase 4 — Discoverable Providers catalog update

Primary files:

- `renderer/components/settings/providers-settings.tsx`
- `renderer/components/settings/builtin-provider-editor.tsx`
- `main/handlers/providers.ts`
- `renderer/lib/ipc.ts`, `renderer/lib/queries.ts`, and `renderer/lib/types.ts`

Tasks:

1. Replace the icon-only global control with a labeled **Update model catalogs** button.
2. In one foreground operation:
   - force-refresh built-in executable inventory through the existing Pi/pi.dev path; and
   - refresh models.dev capability metadata through the new device-local cache.
3. Return independent source results and last-updated status. Partial success copy must say which source updated and which retained cached data.
4. Invalidate provider, model-info, model-picker, Bot capability, and paired-client publication state only for the sources that changed.
5. Keep the built-in provider dialog's scoped refresh available for its provider inventory, and keep custom providers on their existing **Discover models** action.
6. Add concise copy: provider catalogs determine which models can run; model details improve names and capability hints.
7. Keep the overall update/cached/error outcome beside the action; place exact source timestamps and provenance under an optional **Catalog details** disclosure. Never hide a partial failure or the foreground network/privacy consequence inside it.

**Exit gate:** the Providers surface has an obvious labeled action, newly published executable inventory appears when supported by Pi/provider authority, and models.dev-only entries never become selectable.

### Phase 5 — Refresh the tracked snapshot on `main`

Primary files:

- new `.github/workflows/model-catalog-refresh.yml`
- `package.json`
- `scripts/update-model-capabilities.mjs`
- `scripts/model-snapshot-core.mjs`
- `scripts/check-ci-policy.test.mjs`

Workflow contract:

1. Trigger on `push` to `main` and `workflow_dispatch`.
2. Use pinned checkout/setup-node actions and Node `22.22.3`; grant only `contents: write`.
3. Serialize runs under one `main` catalog concurrency group; the newest main state is authoritative.
4. Run `npm ci`, `npm run models:refresh`, and a registered focused `npm run test:model-catalog` suite.
5. Fail if anything outside `resources/model-capabilities.json` changes.
6. Commit only when the canonical snapshot differs, using the GitHub Actions bot identity.
7. Ignore a catalog-only bot commit (path and actor guard) to prevent loops.
8. Fail safely on non-fast-forward; the run for the newer `main` revision supersedes it.

Keep the release-time refresh in `npm run dist`. A release must never package a potentially stale workflow artifact.

**Exit gate:** every eligible main update either records a validated current snapshot or leaves the known-good snapshot untouched with a visible failed workflow; every packaged release independently refreshes and verifies again.

### Phase 6 — Onboarding, native projection, and documentation

1. Update the provider onboarding/privacy copy so users know catalog network access happens only when they choose setup/update actions; do not add automatic requests.
2. Review the final feature-tour Model freedom tile and update its data-driven copy only if needed. Do not add a new tile or PNG for a maintenance action.
3. Keep the remote API wire shape unchanged. Mac continues projecting bounded provider/model records with `hidden`; iOS and Android continue filtering locally.
4. Update troubleshooting/runbook copy for “model exists in models.dev but is not selectable” versus “provider inventory is stale.”
5. Record implementation friction in `.papercuts/troubleshooting.md` as it occurs. `.memory/` is absent in this worktree; if project memory is restored before implementation, update the relevant status/decision files.

**Exit gate:** onboarding and support copy accurately describe network/privacy and the two catalog authorities; native clients pass all-hidden regression tests without a schema change.

## Test plan

### Visibility

- Legacy-array and `"*"` migration, canonical serialization, malformed/oversized exceptions.
- Hide all → show one → hide one; Show all; mixed provider state; future models after Hide all.
- Google transcription-only policy across scope changes without losing user-hidden preferences.
- Atomic concurrent per-model and bulk writes; portable import/export round trip.
- New-chat selection with one/all/no visible models; existing chat remains executable.
- Bot, Telegram, scheduled-task, Assistant, command-palette, and remote projection regressions.
- Focused `ProviderModelVisibility` interaction tests for disclosure semantics, default state, stable summary, hidden-descendant focus removal, error surfacing, and bulk actions, plus Electron E2E coverage in Settings and the model picker.

### models.dev cache and authority

- Fixed URL/method/headers; no credentials, cookies, prompts, selections, install ID, or custom endpoint leakage.
- Redirect, timeout, abort, oversized body, excessive cardinality, malformed JSON, invalid fields, and numeric ceiling rejection.
- Atomic `0600` write, corruption fallback, in-flight dedupe, app-version invalidation, and last-known-good preservation.
- Immediate display metadata publication after success; ordinary reads stay fetch-free.
- Device metadata cannot change runtime limits, routing, selectable inventory, or an active turn.
- Partial combined refresh retains each source's last-known-good data and reports exact bounded status.

### CI, release, and native

- Workflow contract tests for trigger, permissions, concurrency, focused suite, single-file commit, and loop guard.
- Existing updater, snapshot serializer, distribution, and packaged-catalog verifier suites remain green.
- `npm run type-check`, `npm run lint`, focused suites, and `npm run test`.
- Existing Mac remote-model tests, iOS model visibility tests/build-for-testing, and Android unit/lint coverage, adding a focused Android all-hidden test if missing.

## Three-agent implementation split

Implementation should again use three parallel agents with non-overlapping ownership:

1. **Visibility and Providers UI:** versioned visibility migration, config/IPC, Hide all/Show all UX, component/E2E tests.
2. **models.dev runtime:** shared validator, secure device-local cache, catalog authority split, status/refresh DTOs, security tests.
3. **Automation and cross-client verification:** main-merge workflow, release/policy/onboarding/docs updates, CI contract tests, iOS/Android regression runs.

The primary agent owns the shared DTO merge, query invalidation, combined refresh orchestration, full test pass, and final policy/authority audit.

## Acceptance criteria

- Every provider model list offers an accessible, atomic **Hide all** action and the user can re-enable individual models afterward.
- Search never changes bulk scope, and all-hidden state is honest across desktop, Bots, schedules, Telegram, iOS, and Android.
- A labeled Providers action refreshes executable inventory and capability metadata with source-specific partial-success feedback.
- models.dev is contacted only by the four documented explicit paths and never receives user/provider data.
- User-fetched models.dev data is durable, bounded, offline-readable, and display-only; it cannot create executable inventory or widen runtime admission.
- A validated tracked snapshot is refreshed after `main` updates, while every release independently refreshes immediately before packaging.
- Existing chats keep working when their model is hidden; new chats never silently fall back to a hidden or unavailable model.

## Non-goals

- Treating models.dev as a provider or selectable inventory source.
- Background models.dev refresh on launch, timer, model-picker open, or ordinary provider reads.
- Sending provider credentials or app/user identifiers to a catalog service.
- Changing the remote iOS/Android catalog schema.
- Auto-selecting newly discovered models or silently changing existing/default selections.
