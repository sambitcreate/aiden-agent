# Onboarding Authentication and Provider Validation

Status: Active

## Goal

Make first-run onboarding truthfully establish a usable Aiden setup: ChatGPT/Codex
sign-in must be reachable and recoverable, API-key and endpoint setup must report
what was actually verified, and dismissing onboarding must never be recorded as a
completed configuration.

The delivery should reuse Aiden's existing provider, credential, model-selection,
and visual primitives. It must not create a second provider catalog, leak secrets
to the renderer, perform billable validation requests, or make network calls on
ordinary startup.

## Audit result

### P0 — ChatGPT sign-in is deterministically unreachable

- Onboarding looks for `openai-codex` with `isBuiltin === true` in
  `renderer/components/onboarding-flow.tsx`.
- `main/services/provider-list-core.ts` intentionally omits signed-out Codex and
  synthesizes a configured Codex item without `isBuiltin` or `authMethods`.
- The resulting branch can only show “ChatGPT sign-in is unavailable.” Even a
  configured entry cannot render actions in the generic `BuiltinProviderEditor`,
  because that editor requires `authMethods`.
- The dedicated Settings implementation already has the correct Codex-owned
  session and view state in `renderer/components/settings/codex-provider-settings.tsx`.
- Current onboarding tests only inspect source text. They never render the real
  signed-out provider-list shape, so they assert that the dead branch exists
  rather than proving it works.

### P1 — onboarding can complete without a usable provider

- The global Skip button writes a renderer `localStorage` completion bit from any
  step. There is no readiness check, confirmation, deferred state, or
  non-destructive way to reopen onboarding.
- OpenAI and Anthropic accept any nonempty string and save hard-coded custom
  provider records without contacting the provider.
- Tailscale setup can save a provider with zero models and still advance.
- Generic built-in authentication advances even when the refreshed provider is
  missing a key or models.
- Completion is not derived from the main process's authoritative profile,
  credential, provider, and model state.

### P1 — onboarding is not an application modal

- The routed shell, assistant dock, native commands, and command palette remain
  active behind onboarding.
- Command-K, Command-N, Settings, and menu navigation can create hidden stacked
  UI and focus conflicts during setup.

### P2 — auth, recovery, and accessibility gaps

- Partially completed setup is durable, but step progress is component-local.
  Reloading after a profile or provider save restarts at step one.
- Generic auth cancellation loses the Codex-specific `finishing` state around
  the credential commit boundary.
- Successful selected-provider auth can appear to fail when an unrelated global
  catalog refresh fails.
- Step transitions do not move or announce focus, progress lacks
  `aria-current`, and the feature gallery creates an unnecessarily long keyboard
  path.
- Browser-open failure is not surfaced clearly. Pi uses a fixed localhost port
  (`1455`) and swallows callback bind errors into a manual-code fallback, so
  Aiden's existing `port_busy` diagnosis cannot fire.
- Retry status currently rereads local credential state; it does not prove that
  the remote token remains accepted.

## Product decisions

1. **Setup completion is authoritative.** `completed` means the main process can
   identify at least one selectable model on a configured provider whose setup
   state satisfies that provider class's readiness contract.
2. **Keep profile required; let provider setup defer explicitly.** The provider
   step offers **Skip provider** in the top-right and records `deferred` only
   after the user finishes the tour. Deferred setup is never called completed,
   carries no stale selected-provider ID, and directs the user to Settings →
   Providers before chatting. Settings retains the non-destructive **Show
   onboarding** recovery path.
3. **The tour is optional.** Once required setup is ready, the user may choose
   **Start using Aiden** without traversing the entire feature gallery.
4. **Use native provider identities.** OpenAI and Anthropic onboarding configure
   Pi's native `openai` and `anthropic` providers, not
   `custom:onboarding-openai` or `custom:onboarding-anthropic` clones.
5. **Validation is explicit and non-billable.** Never send a chat, completion,
   malformed generation, or zero-token generation as a credential probe.
6. **Validation claims match evidence.** OAuth exchange, authoritative account or
   catalog checks, custom endpoint discovery, local endpoint reachability, and
   ambient credential resolution are different assurance levels in both data and
   copy.
7. **No background credential checks.** Validation runs only after a user chooses
   **Validate & continue**, **Check connection**, or performs a real request.
   Startup only loads stored evidence and computes whether it is stale.
8. **One Codex credential owner.** The P0 repair reuses Aiden's dedicated Pi Codex
   session. A later architecture gate must choose between the Pi-owned auth and
   inference path or an official packaged Codex CLI/app-server path. Do not run
   official `codex login` while continuing Pi inference through a separate hidden
   credential store.

## Target onboarding state

Persist a versioned, main-owned, non-secret record:

```ts
type OnboardingState = {
  version: number;
  outcome: "incomplete" | "deferred" | "completed";
  lastSatisfiedStep: "none" | "profile" | "provider" | "tour";
  selectedProviderId?: string;
};
```

At launch, derive the actual next step from authoritative profile and provider
readiness. The profile checkpoint is a resume hint; the provider checkpoint is
recorded by main only after one of onboarding's guarded validation, OAuth, or
catalog-discovery paths succeeds for that exact provider ID. Ambient credentials
and static Pi catalogs are not evidence. Never persist API-key drafts, OAuth
prompts, manual authorization codes, or provider response bodies.

```text
boot.checking
  -> profile.editing/saving/error
  -> provider.catalog_loading/choosing
     -> codex.starting/waiting/prompt/responding/cancelling/finishing
     -> api_key.validating/saving/reconciling
     -> endpoint.validating/saving/reconciling
     -> provider.defer_explicitly
  -> tour
  -> completion.persisting/error/completed_or_deferred

any idle setup state
  -> close after authoritative completion or explicit provider deferral
```

Normal completion is allowed only after a fresh selected-provider reconciliation
passes the shared usable-provider predicate. An explicit deferred record keeps
its distinct outcome, dismisses first-run setup, and can be reopened from
Settings without deleting configuration.

## Implementation checkpoint

The immediate onboarding repair now ships in the working tree:

- onboarding renders the dedicated Codex sign-in surface and advances only from
  its configured, healthy model-bearing status;
- profile/provider progress and completion are versioned in main-owned settings,
  profile remains required, provider setup has an explicit truthful defer path,
  and Settings can reopen onboarding without deleting configuration;
- OpenAI and Anthropic use their native Pi identities and validate an
  authenticated bounded model catalog from a nested setup dialog before
  replacing the stored key;
- LM Studio, Ollama, and Tailnet routes must discover a usable model before they
  can advance, and every successful path persists a selected model;
- secret-bearing discovery rejects redirects, bounds response/model data, emits
  closed errors, and distinguishes cancellation from timeout;
- malformed model IDs and credential control characters fail closed, transport
  errors cannot echo key material, and first-run Tailnet discovery is restricted
  to `.ts.net` names and Tailnet address classes;
- generic Pi credential entry remains available in Settings but cannot satisfy
  required onboarding until that provider has an authoritative non-generation
  validator;
- onboarding blocks the workbench while main-owned state loads, fences state
  writes to the active renderer document, blocks deep-link navigation, and
  reconciles setup that finishes after a close/cancel race;
- the onboarding shell is an application modal, nested confirmations render in
  the onboarding layer, compact windows keep the native traffic-light strip
  behind the rounded setup surface, browser-launch failures retain a manual
  link, step headings receive focus, progress exposes `aria-current`, and the
  feature gallery no longer adds 24 noninteractive tab stops.

The broader cross-provider evidence registry, Settings evidence UI, and the
Phase 6 credential-owner decision remain future architecture work; they are not
required for the repaired first-run completion contract.

## Validation contract

Configuration and evidence are separate:

```ts
type ConfigurationState = "missing" | "configured" | "needs_attention";
type ValidationState =
  | "unverified"
  | "validating"
  | "validated"
  | "stale"
  | "rejected"
  | "unreachable";
type Assurance = "authoritative" | "capability_probe" | "configuration_only";
type Evidence =
  | "oauth_exchange"
  | "oauth_refresh"
  | "identity"
  | "catalog"
  | "custom_catalog"
  | "local_catalog"
  | "request_success";
```

Evidence stores only `checkedAt`, `freshUntil`, `strategyVersion`, an opaque
credential revision, a canonical connection fingerprint, optional bounded model
count, and a closed sanitized error. It contains no key, key hash, complete URL,
account identifier, raw upstream response, or prompt content.

### Assurance matrix

| Provider class                                            | Safe check                                                                   | Honest result                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ChatGPT/Codex OAuth                                       | Successful OAuth exchange; later refresh or real request                     | Signed in at that time                                                 |
| OpenAI API key                                            | Authenticated `GET /v1/models`                                               | Credentials accepted and catalog accessible                            |
| Anthropic API key                                         | Authenticated Models list endpoint                                           | Credentials accepted and catalog accessible                            |
| Other built-in static-key providers                       | Provider-specific allowlisted identity/catalog endpoint, when documented     | Authoritative only if the endpoint enforces auth; otherwise unverified |
| Authenticated dynamic catalogs such as Concentrate/Radius | Intended-origin authenticated catalog                                        | Credentials and catalog capability accepted                            |
| AWS/Vertex/Azure/Cloudflare ambient or multi-field auth   | Local resolution plus documented identity/control-plane check when available | Configuration-only or provider-specific capability                     |
| Custom OpenAI/Anthropic-compatible server                 | Exact-origin bounded model discovery                                         | Endpoint reached and models listed; key enforcement not guaranteed     |
| LM Studio/Ollama/Tailnet keyless server                   | Native or generic bounded model discovery                                    | Local/private endpoint reached; not credential validation              |

`401` is rejected credentials. `403` is a permission/capability failure, not
automatically a bad key. `429`, timeout, DNS/TLS failure, and `5xx` are
inconclusive and must not erase earlier trustworthy evidence. A `2xx` response
with no usable models may validate authentication while still failing onboarding
readiness.

## Architecture

Add a main-process `ProviderValidationService` with an immutable strategy registry
for every Pi built-in plus Aiden's first-class providers and custom/local classes.
Candidate secrets remain main-process memory until validation completes.

The service must:

- bind attempts to the initiating renderer document and cancel on navigation,
  destruction, shutdown, or explicit cancellation;
- fence results by provider draft fingerprint and opaque credential revision so a
  late result cannot overwrite newer input;
- use per-attempt and total deadlines, bounded concurrency, and closed result
  codes;
- commit provider configuration, credential, catalog, default model, and evidence
  atomically, extending the existing credential-rotation journal for custom
  connections;
- preserve the previously working provider when a candidate fails or becomes
  inconclusive;
- reject cross-origin redirects for secret-bearing requests, validate the exact
  intended origin, retain TLS verification, and apply the existing private-host
  policy deliberately for local/Tailnet providers;
- bound response bytes, pages, model count, model ID length, and displayed error
  data;
- log only provider ID, validation strategy, closed result code, and coarse
  duration.

Expose owner-bound start/cancel/status IPC rather than returning raw upstream
errors. Settings and onboarding consume one shared renderer state model and one
accessible status component.

## Delivery phases

### Phase 0 — executable regression harness

- Replace source-regex onboarding assertions with rendered interaction tests.
- Add a fixture using the actual signed-out `providers:list` projection.
- Add auth/session fakes for success, prompt, browser failure, device flow,
  cancellation, finishing, expiry, and terminal failure.
- Register all new files in a CI-invoked test script; keep the focused onboarding
  script for local iteration.

**Exit gate:** a failing test reproduces the current ChatGPT dead branch and a
second test proves the existing global Skip marks an unusable setup complete.

### Phase 1 — P0 Codex onboarding repair

- Extract the dedicated Codex status/session UI from Settings into a shared
  component/state machine and use it directly in onboarding.
- Start `createCodexAuthSession` by the immutable `openai-codex` identity; never
  discover signed-out Codex through the configured-provider list.
- Offer Browser and Device Code as clear actions, with manual-code fallback,
  retry, cancel, `finishing`, and actionable browser-open/callback failure states.
- Restrict automatically opened Codex auth URLs to the expected OpenAI origins in
  addition to HTTPS validation.
- Reconcile only Codex after terminal success. Treat other catalog refreshes as
  best-effort warnings.
- Advance only when a fresh Codex status is configured, not attention-needed, and
  exposes at least one usable model.
- Add a packaged lazy-module/auth canary so the exact Pi OAuth path is verified
  inside ASAR.

**Exit gate:** a fresh install can sign in by browser or device code, cancel and
retry safely, relaunch, and select a Codex model in a packaged build.

### Phase 2 — authoritative onboarding lifecycle

- Move the versioned onboarding outcome/checkpoint to the main process.
- Derive resume position from profile and provider readiness after reload/crash.
- Remove the global Skip and do not expose a defer action during required setup.
- Preserve migrated `deferred` records without treating them as completed, and
  expose a non-destructive **Show onboarding** recovery path in Settings.
- Make onboarding an application modal: inhibit command palette, navigation,
  native menu mutations, assistant dock actions, and hidden stacked dialogs.
- Separate required setup from the optional feature tour.

**Exit gate:** no path records `completed` without a usable provider; reload and
defer/re-entry behavior remain consistent.

### Phase 3 — validation service and secure network boundary

- Add validation DTOs, evidence storage, strategy registry, owner-bound IPC,
  deadlines, cancellation, revision fencing, and sanitized closed errors.
- Harden shared discovery with exact-origin redirect rejection, SSRF review,
  bounded bodies/catalogs/pages/IDs, and distinct cancel/timeout outcomes.
- Migrate existing configured providers to `unverified`; cached catalogs never
  become validation evidence.
- Clear validation evidence during onboarding reset/provider removal and recover
  atomic rotations after interrupted writes.

**Exit gate:** security and race tests prove no secret or raw provider response
can reach URL, argv, environment, renderer notifications, logs, cache, or crash
text.

### Phase 4 — onboarding provider integrations

- Replace onboarding's OpenAI/Anthropic custom clones with native providers.
- Implement documented non-billable catalog validation for OpenAI and Anthropic,
  then atomically save credential, discovered models, and default selection.
- Route LM Studio, Ollama, and Tailnet/custom setup through the same service while
  labeling results as endpoint capability rather than credential acceptance.
- Persist a selected default model for every successful route, not only local
  runtimes.
- Classify every installed Pi provider and Concentrate. Add authoritative probes
  only where current primary documentation supports them; show **Not checked** or
  configuration-only elsewhere rather than inventing a generation probe.

**Exit gate:** invalid hosted keys cannot advance, unreachable or zero-model
endpoints cannot advance, and capability-only endpoints never claim that a key
was accepted.

### Phase 5 — shared Settings UI and runtime evidence

- Use one inline status component and copy across onboarding and Settings:
  **Checking**, **Credentials accepted**, **Endpoint reached**, **Not checked**,
  **Checked previously**, **Credentials rejected**, and **Could not reach
  provider**.
- Offer Retry and an explicit **Save without checking** in Settings. In required
  onboarding, unverified save may persist a draft but does not count as ready.
- Preserve input and focus after failures; use `role="status"`/`role="alert"`,
  focus the new step heading, set `aria-current="step"`, and respect reduced
  motion.
- Let successful real requests and normalized auth failures update evidence
  without issuing additional provider calls. Do not auto-switch models, unhide
  models, or change existing chat provenance.

**Exit gate:** onboarding and Settings show the same trustworthy provider state,
and keyboard/VoiceOver navigation passes focused acceptance.

### Phase 6 — Codex credential-owner decision

The official Codex contract currently exposes `codex login`,
`codex login --device-auth`, `codex login --with-api-key`, `codex login status`,
and `codex logout`. Aiden currently uses Pi's OAuth implementation and encrypted
`pi-provider-credentials.json`; the two sessions are independent.

- Decide whether Pi remains Aiden's declared Codex credential/inference owner or
  whether Codex moves as a unit to an officially packaged CLI/app-server path.
- Do not scrape or copy `~/.codex/auth.json`; official storage may be keyring
  backed.
- Do not use a user-installed `codex` from `PATH`.
- If migrating, pin and sign per-architecture executables outside ASAR, verify
  hashes/provenance/mode/signature, feed API keys only through stdin, and move
  inference to the same official owner rather than bridging credentials into Pi.
- Add bounded child lifecycle, output, timeout, cancellation, shutdown, and
  package tests before changing the production owner.

**Exit gate:** authentication status, logout, refresh, and inference all observe
one credential owner, with no hidden divergence from the user's Codex CLI.

## Required test matrix

| Area                       | Required cases                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex                      | Fresh signed-out start; configured; attention-needed; browser success/failure; device success/expiry; manual fallback; callback collision; wrong state; cancel; finishing; retry; relaunch |
| API keys                   | Valid; empty; `401`; `403`; `429` with bounded Retry-After; `5xx`; DNS/TLS; timeout; cancel; stale/late result; old-key preservation                                                       |
| Endpoint discovery         | `2xx` models; `2xx` empty; malformed/oversized body; too many pages/models; redirect; origin change; private/metadata targets; protocol/auth mutation                                      |
| Lifecycle                  | Reload after profile save; reload after provider save; document navigation; window destruction; shutdown; safe-storage unavailable; reset success/failure/cancel                           |
| Completion                 | No-provider block; zero-model block; confirmed defer; non-destructive re-entry; completion-write failure; back after save; duplicate click prevention                                      |
| Commands and accessibility | Command-K/menu blocked; focus on step changes/errors; `aria-current`; live status; full keyboard path; reduced motion                                                                      |
| Cross-provider isolation   | Unrelated catalog failure does not block selected provider; one validation cannot overwrite another; visibility/default/existing chats stay stable                                         |
| Security                   | No secret in URL/argv/env/log/IPC/cache; fixed renderer copy; bounded diagnostics; no generation endpoint invoked by validation                                                            |
| Packaging                  | Exact lazy auth module loads from ASAR; packaged sign-in works with empty `PATH`; arm64/x64 artifact verification if official CLI is adopted                                               |

## Rollout and observability

- Ship Phase 1 behind focused automated and packaged acceptance before widening
  provider validation.
- Record only aggregate local outcomes: provider ID, strategy, closed status,
  coarse latency, and onboarding step. No tokens, URLs, account IDs, prompt data,
  or upstream bodies.
- Track completion, defer, validation rejection, unreachable endpoint, auth cancel,
  and recovery rates locally so UI dead ends can be diagnosed.
- Update onboarding copy and the final feature-tour gallery only for capabilities
  that have shipped and passed their exit gates.
