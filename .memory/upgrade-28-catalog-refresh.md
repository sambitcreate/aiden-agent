# Scoped catalog publication ownership — 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

Aiden's scoped `refreshPiCatalogs` path called provider refresh directly and its
publish callback unconditionally persisted and updated live provider state.
Timeout races released the caller without fencing late publication. Replacing or
removing a provider or changing/deleting credentials also left publication valid.
A real `withPiRemoteCatalog` deferred-response test proves obsolete catalog data
is persisted after key replacement on baseline; no real network or credentials.

Publication now checks caller cancellation, current provider object identity,
and deep equality with the captured credential before entering persistence and
again before the synchronous update. Credential checks are read-only, abortable,
and do not log or expose credential contents. Already-started storage mutations
may finish; their obsolete live updates are suppressed. This is not transactional
rollback, nor a general same-provider/same-credential refresh-generation arbiter.

Reference: Pi checkout `2a9b4ebc680053c64e31f635b0b22d5e22564001` (MIT),
`packages/ai/src/models.ts` checks generation before/after publication persistence.
Installed 0.84.4 matches that lifecycle and supports `providers` filters. Native
refresh also resolves/rotates OAuth credentials, so replacing Aiden's scoped path
would change its explicit non-mutating auth policy. The correction is original
Aiden code; no reference source copied. Auth lane20's credential core is untouched.

Validation: 11 baseline failing cancellation/provider-identity cases, 6 further
credential-change/logout failures, and the separate real-wrapper baseline failure.
Final 70 tests pass across pi-remote-catalog, pi-credential-store-core,
pi-provider-contract, provider-auth-flow, provider-model-info-core, and
 aiden-remote-models. Tests extend the existing pretest-registered catalog file.
Type check, lint, and diff whitespace checks pass. No full npm test during campaign
integration. No UI, native wire, onboarding capability, runtime/display authority,
models.dev policy, endpoint, dependency, release or version change.
