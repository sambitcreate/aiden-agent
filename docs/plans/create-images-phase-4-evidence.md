# Create Images Phase 4 Evidence

Status: **IMPLEMENTATION COMPLETE; LIVE ACCEPTANCE IN PROGRESS** — the Gemini vertical slice is source- and mock-verified; authorized live attempts exposed and repaired request- and response-compatibility defects, and one clean live rerun remains
Date: 2026-08-11; updated 2026-08-20
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
- Provider transport diagnostics stay in the main-process development log as bounded structured metadata. The renderer presents concise human status, next steps, and actions rather than request codes, attempt counters, provider bodies, prompts, paths, or credentials.

## Mocked and static verification

- The pinned endpoint, stateless `store: false`/`background: false` request, inline image delivery, response-format fields, curated Nano Banana model IDs, aspect ratios, sizes, and 14-reference ceiling were checked against Google's current [Interactions API reference](https://ai.google.dev/api/interactions-api) and [Gemini image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) on 2026-08-11.
- `npm run test:create-images`: pass — 8 pretests, 440 functional assertions, 2 durability/performance tests, and 15 Node/script checks.
- Gemini-focused coverage includes one-shot consent/replay rejection, durable provider authorization, reference-byte accounting, credential drift with zero transport calls, malformed/oversized response rejection, redirect/origin enforcement, timeout and abort ambiguity, provider error normalization, capability drift, rate/concurrency bounds, and secret/path-free persistence.
- 500-node successful journal: 1,502 events, 635,757-byte current log, 106.39 s append, 186 ms replay.
- 1,000 output-rich terminal journals × 250 asset IDs: 4.60 s restart, 4.41 s authoritative admission audit, 20.61 s modeled product path, 70 ms retention lookup, 355,073-byte derived index, bounded caches.
- `npm run type-check`: pass.
- `npm run lint`: pass.
- `git diff --check`: pass.
- `npm run build`: pass. Create Images remains lazy at 361.11 kB JS / 106.23 kB gzip and 48.82 kB CSS / 7.47 kB gzip; the lazy-boundary verifier passed.
- Provider UI React Doctor checks were run during implementation. Untracked Create Images files forced a repository-wide baseline scan; no new provider-UI-specific high-confidence diagnostic remained.
- The 2026-08-20 compatibility repair passed the 440-assertion Create Images suite, both performance tests, 15 script checks, full type-check, full lint, diff-check, React Doctor review, and `npm run build`. PNG requests omit `response_format.mime_type`, matching Google's default-format examples. Response parsing now mirrors Google's `interaction.output_image` contract by selecting the last generated image block, because Gemini 3 may expose interim thought images in the response timeline. A missing final MIME is inferred only from fully validated PNG/JPEG bytes, and a declared MIME must still match those bytes.

## Live acceptance progress and remaining exit gate

The Phase 4 plan explicitly requires manual opt-in acceptance with a real user-supplied Gemini key. On 2026-08-20, the user authorized and launched device-local reference-image runs. The first attempts were rejected before output with a safely normalized `request_rejected` result; Aiden had explicitly sent `image/png` in a response-format field that did not work on the live REST path. After that repair, Google accepted and completed a `gemini-3.1-flash-image` request in about eight seconds, but Aiden's adapter rejected the successful response as `output-invalid` before asset publication. The old parser incorrectly required exactly one image across the complete model-output timeline and an exact requested MIME. Google's current guide specifies that Gemini 3 can expose interim thought images and that `interaction.output_image` returns the last generated image block. The repaired adapter follows that final-image rule and validates the actual bounded PNG/JPEG bytes. Safe structural diagnostics now go to the main-process development log; no raw Google body, credential, prompt, image bytes, or native path is logged or shown in the renderer.

This evidence still does **not** claim a full Phase 4 GO. The repaired request has not yet completed a clean live acceptance.

The remaining acceptance is exactly:

1. the user explicitly connects their Google API key and chooses Gemini mode;
2. review and approve one text-to-image run and one device-local reference-image run;
3. verify the real response contract, durable outputs/metadata, history/restart behavior, provider-visible request accounting, cancellation copy, and absence of secrets in renderer IPC and durable records;
4. record the account-visible model/catalog result and any reported usage without storing the key or prompt content in evidence.

User-authorized live requests reached both request-validation and completed-response boundaries, but no output has yet completed Aiden's durable asset-publication path. No additional paid request was triggered by the repair work. No successful paid output, packaging, signing, notarization, or packaged acceptance was performed for this Phase 4 source gate. Final release evidence must keep the repaired real-provider acceptance open until a clean user-authorized rerun completes.
