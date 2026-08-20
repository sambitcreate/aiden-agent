# Create Images Phase 4 Evidence

Status: **IMPLEMENTATION COMPLETE; LIVE ACCEPTANCE PENDING** — the Gemini vertical slice is source- and mock-verified, but the plan's manual opt-in real-provider acceptance has not been authorized or run
Date: 2026-08-11
Feature gate: `AIDEN_CREATE_IMAGES_ENABLED=1`

## Shipped source surface

- Create Images reads a main-owned Gemini image-provider status derived only from the exact stored Google API-key credential kind and a release-curated capability catalog. The renderer never receives the credential, credential record, provider endpoint, or arbitrary headers.
- Generate Image nodes expose curated Gemini model, aspect-ratio, image-size, MIME, reference-image, and output-count choices. Capability drift and unsupported combinations fail closed before review or transport.
- Cloud execution is a distinct, explicit mode. Main rebuilds the immutable scoped plan, resolves exact prompt/reference/request/output accounting, and returns a one-shot renderer review plan. The renderer echoes only an HMAC-bound authorization ID, consent fingerprint, opaque token, and `reviewed: true`.
- Start revalidates workflow revision, scope, capability fingerprint, credential record/revision, accounting, expiry, and the one-shot consent. Tokens are consumed before durable publication and cannot be replayed.
- The durable run authorization records only safe provider/model/capability/credential revision/accounting fingerprints. It never stores the consent token, API key, prompt text, endpoint, remote URL, raw response, or filesystem path.
- Every Gemini attempt durably publishes `submission-prepared` before re-resolving main-owned credentials or entering the adapter. Credential drift is confirmed-not-sent. Any post-send transport loss, timeout, or abort becomes explicit ambiguity and is never automatically retried.
- The adapter uses one fixed Google Interactions endpoint and `x-goog-api-key`, rejects redirects and unexpected/private response URLs, bounds request/reference/response/output bytes, validates static image bytes and declared media, normalizes safe failures, and cancels stalled body readers.
- Paid-provider accounting is one reviewed request per initial planned request with no automatic Gemini retry. Provider concurrency/rate leases are bounded. Cost remains truthfully unavailable when the provider does not report it.
- Valid outputs enter the existing content-addressed asset store before journal success, retain safe Gemini/model/dimension/usage metadata, remain run-authorized across restart, and use the existing opaque preview-grant path.
- Renderer confirmation states the exact scope, request/output/reference counts, transfer and rights consequences, unknown provider cost, advisory cancellation, and duplicate-submission risk. Local mock remains a separate `$0`, no-network option.

## Mocked and static verification

- The pinned endpoint, stateless `store: false`/`background: false` request, inline image delivery, response-format fields, curated Nano Banana model IDs, aspect ratios, sizes, and 14-reference ceiling were checked against Google's current [Interactions API reference](https://ai.google.dev/api/interactions-api) and [Gemini image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) on 2026-08-11.
- `npm run test:create-images`: pass — 8 pretests, 397 functional tests, 2 durability/performance tests, and 12 Node/script checks.
- Gemini-focused coverage includes one-shot consent/replay rejection, durable provider authorization, reference-byte accounting, credential drift with zero transport calls, malformed/oversized response rejection, redirect/origin enforcement, timeout and abort ambiguity, provider error normalization, capability drift, rate/concurrency bounds, and secret/path-free persistence.
- 500-node successful journal: 1,502 events, 635,757-byte current log, 112.75 s append, 188 ms replay.
- 1,000 output-rich terminal journals × 250 asset IDs: 4.80 s restart, 4.66 s authoritative admission audit, 21.69 s modeled product path, 80 ms retention lookup, 355,073-byte derived index, bounded caches.
- `npm run type-check`: pass.
- `npm run lint`: pass.
- `git diff --check`: pass.
- `npm run build`: pass. Create Images remains lazy at 361.11 kB JS / 106.23 kB gzip and 48.82 kB CSS / 7.47 kB gzip; the lazy-boundary verifier passed.
- Provider UI React Doctor checks were run during implementation. Untracked Create Images files forced a repository-wide baseline scan; no new provider-UI-specific high-confidence diagnostic remained.

## Deliberately unrun exit gate

The Phase 4 plan explicitly requires manual opt-in acceptance with a real user-supplied Gemini key. No such request was made because it would contact Google and may incur provider charges. Therefore this evidence does **not** claim a full Phase 4 GO yet.

The remaining acceptance is exactly:

1. the user explicitly connects their Google API key and chooses Gemini mode;
2. review and approve one text-to-image run and one device-local reference-image run;
3. verify the real response contract, durable outputs/metadata, history/restart behavior, provider-visible request accounting, cancellation copy, and absence of secrets in renderer IPC and durable records;
4. record the account-visible model/catalog result and any reported usage without storing the key or prompt content in evidence.

No live request, paid work, packaging, signing, notarization, or packaged acceptance was performed for this Phase 4 source gate. Phase 5 may proceed as implementation work, but final release evidence must keep this real-provider acceptance open until the user explicitly authorizes it.
