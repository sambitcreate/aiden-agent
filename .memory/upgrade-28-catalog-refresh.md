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
check their signal before touching storage. Scoped and full attempts now share
per-provider cancellation ownership, so newer attempts supersede older ones.

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

## Full-refresh ownership correction

Luna review of `2fcc0658` proved the full/native branch still bypassed account
checks. Production `providers:refresh`, `providers:updateCatalogs`, and the
command palette call `refreshBuiltinCatalogs()` without provider IDs. Startup
`ensureBuiltinCatalogs()` was another direct native refresh path. Both now use
the common refresh helper; no production `models.refresh` caller remains outside
its guarded path.

Full refresh retains exact pinned Pi OAuth and ambient-auth behavior using the
public `createModels`/provider-filter API in a per-call refresh-only collection.
Its credential adapter records the snapshots Pi reads and post-modify credentials
Pi commits, so legitimate OAuth rotation becomes the new ownership snapshot.
The collection delegates to original provider objects and Aiden's shared durable
store; it neither copies runtime catalogs nor replaces registered providers.
Production and this collection both use Pi's default AuthContext. Per-provider
attempt signals fence and supersede both full and scoped runs; finished attempts
release their map entries. Scoped setup still uses non-mutating checkAuth only.
Offline startup uses the same guarded callback without auth resolution/network.

Deferred real pi.dev full-refresh replacement/logout cases fail the previous
head. Durable/restart tests now cover both modes. Six OAuth validity/policy
controls verify full refresh rotates expired credentials, retains valid ones,
and accepts its own rotation while scoped/offline paths do not rotate. A further
case rejects an account replacement after legitimate rotation. Mixed-mode
supersession controls reject late old publication and release old callers.
Overlay coalescing now joins only a live network request; a previously failing
deferred-fetch control proves that a replacement starts its own request instead
of joining an aborted predecessor.

Final validation: 140/140 focused tests across catalog, credential, pinned-provider
contract, auth-flow-core, model-info, remote-model and DataStore tests; typecheck,
lint and diff checks pass. No full npm test during integration. Reference-source
semantics were checked against the pinned Pi source; no private SDK API or copied
OAuth implementation is used. Added product file scope: provider-registry.ts and
pi-remote-catalog.ts. No network endpoints, credential-storage format, shared
wire contracts, models.dev authority, UI, native, or dependency changes.

## Rejected post-commit write correction

Pullfrog PRRT_kwDOTctvDc6j96o2 applies to `2ee5f306`: DataStore renames the staged
file before its directory fsync, so backing.write rejection does not prove that
no publication occurred. The mutation is now inside the error/retirement scope.
A rejected mutation retains the provider queue while removing the uncertain
entry. If deletion fails, an empty-catalog replacement is attempted. Original
write errors are rethrown unchanged after successful cleanup; if cleanup also
fails, CatalogPublicationError preserves the original failure as its cause and includes
cleanup failures. A queued newer publisher remains protected and can recover.

Six committed-then-rejected real-disk regressions fail the previous head. They
cover successful deletion, delete failure with empty fallback, fallback commit
followed by durability rejection, and a queued new publisher for each. Fresh
DataStore and pinned Radius instances verify no obsolete offline hydration.
A seventh case checks failure to modify storage during either cleanup: reads
fail closed in the current process until a confirmed replacement. This is a
bounded IO guarantee, not filesystem atomicity: if both retirement operations
cannot modify the file, durable removal across process restart is not promised.
The original and cleanup failures remain visible instead of claiming success.

Final focused suites: 147/147 pass; typecheck, lint, and diff checks pass. No
DataStore core or credential adapter changes. Synthetic account replacements
and temporary directories only.

## Preserve proven unmodified current-owner caches

Luna review of `79da0580` correctly identified over-retirement after failures
before publication. Two actual DataStore regressions failed that head: size
validation and a pre-rename hook failure erased a still-owned last-good entry.
The corresponding changed-account and post-rename cases already passed and
must continue retiring the obsolete cache.

DataStore.update now accepts an optional per-call publication receipt. It starts
not-published, becomes uncertain immediately before rename/link, and published
once that syscall resolves (before directory fsync). Original errors and existing
caller behavior are unchanged. The production Pi backing-store adapter passes
this receipt through both writes and deletes. Generic backends that do not
report an outcome remain conservatively uncertain; a generic throwing mock is
not evidence of a production pre-commit failure.

After a proven not-published failure, the queue rechecks credential/provider/
attempt ownership before preserving the previous entry. Ownership loss or an
unverifiable owner still takes retirement. Potentially committed rejection still
uses guarded retirement/fallback/quarantine and cannot erase a queued newer
writer. Synchronous cloning happens before entering the mutation-error path.

Eight source-backed DataStore/production-adapter cases cover size validation,
pre-rename failure, actual directory-fsync injection after rename, and post-write
hook failure, each with stable or replaced credentials; fresh disk readers prove
the result. Six direct receipt tests cover ordinary/protected updates and both
failure sides plus success. All remain in already-registered files.
Final expanded focused validation: 377/377 pass across catalog/auth/model suites,
DataStore/resilience, and config/portable roundtrip consumers. Typecheck, lint,
and diff checks pass. Product scope now includes data-store.ts (optional receipt
instrumentation only), plus existing catalog files. No persisted schema/wire
change, no native client change, and no new network calls.

## Distinguish credential read failure from supersession

Pullfrog PRRT_kwDOTctvDc6j-CTX targets `f62be0ca` and is reproduced: initial
credential read failure left no observed snapshot, which incorrectly aborted the
native attempt and suppressed Pi's saved auth error. The wrapper now skips
unknown-owner hydration without aborting that attempt. Pinned Pi then reports
its saved credential-read error normally, retaining the original cause. Four
full/offline × failed/missing credential cases use actual Radius cache hydration;
both failure cases failed before the correction and all four now pass. The
missing-credential case remains distinct from failed storage access.

PRRT_kwDOTctvDc6j-CTa describes a caller with an injected custom AuthContext.
Live source search found no authContext assignment in main/renderer, exactly one
ProviderRegistry construction, and its createModels uses Pi's default context.
Whole-repository callsite search finds only the two ProviderRegistry methods
and this module's focused tests; there is no other production consumer/barrel.
The option is generically typed `models: Models`, which does not encode the
production default-context invariant, but no published documentation explicitly
promises arbitrary source-context inheritance. Hypothetical custom-context
collections are not a supported production path here. A new bounded
control compares original models.refresh with guarded full refresh using a
synthetic environment value and a temporary file via ctx.fileExists: effective
credentials match. No production context regression is demonstrated, so no
speculative custom-context parameter or private SDK introspection was added.
This evidence is provided to the orchestrator for review disposition.

Final focused run: 166/166 catalog/auth/model/DataStore tests; typecheck, lint,
and diff checks pass. The previous 377-test expanded DataStore/config receipt
validation remains applicable; this change does not alter that layer.
