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
and do not log or expose credential contents. Scoped publication, ordinary Pi
reads/writes, and offline hydration now share a per-provider queue in
`pi-models-store.ts`. If ownership is lost during a durable write, its entry is
retired before releasing that slot. This prevents restart hydration of rejected
account catalogs and prevents retirement from deleting a newer writer's entry,
even if it has identical bytes. Native operations queued behind publication
check their signal before touching storage. This is not a general
same-provider/same-credential refresh-generation arbiter.

Reference: Pi checkout `2a9b4ebc680053c64e31f635b0b22d5e22564001` (MIT),
`packages/ai/src/models.ts` checks generation before/after publication persistence.
Installed 0.84.4 matches that lifecycle and supports `providers` filters. Native
refresh also resolves/rotates OAuth credentials, so replacing Aiden's scoped path
would change its explicit non-mutating auth policy. The correction is original
Aiden code; no reference source copied. Auth lane20's credential core is untouched.

Validation: 11 baseline failing cancellation/provider-identity cases, 6 further
credential-change/logout failures, and the separate real-wrapper baseline failure.
Initial 70 tests passed across pi-remote-catalog, pi-credential-store-core,
pi-provider-contract, provider-auth-flow, provider-model-info-core, and
aiden-remote-models. Tests extend the existing pretest-registered catalog file.
Type check, lint, and diff whitespace checks pass. No full npm test during campaign
integration. No UI, native wire, onboarding capability, runtime/display authority,
models.dev policy, endpoint, dependency, release or version change.

## PR168 review follow-up

Pullfrog PRRT_kwDOTctvDc6j9w7P correctly identified that suppressing live update
alone left an obsolete durable entry available to Radius on restart. Two new
baseline regressions failed using real temp-file DataStore instances and pinned
Radius offline refresh after credential replacement or cancellation during an
admitted write. The fix above adds serialized retirement rather than treating
that durable effect as an acceptable limitation.

Final 81 focused tests pass, including six real-disk/offline Radius cases with
no newer publisher, identical newer bytes, and different newer bytes; queued
reads see only settled state. Additional cases check post-write keychain failure
cleanup and queued native read/write/delete cancellation. Tests remain in the
existing registered catalog file. Type check, lint, and diff checks pass.
No DataStore core, credential adapter, native wire, or network policy changes.
