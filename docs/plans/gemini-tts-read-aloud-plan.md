# Gemini 3.8 Read Aloud and Voice Studio — Implementation Status

**Status:** Partial implementation (desktop unary-WAV slice hardened; live acceptance, streaming, Voice Studio, and native cloud-TTS parity pending).
**Branch:** `feature/gemini-3-8-tts`.
**Full plan:** the delivered `plan.md` document (September 23, 2026 audit of `7a4d9d0b`).

This document tracks the repository's implementation state against the audited
plan. The plan remains the source of truth for scope and boundaries; this file
records what is implemented on this branch and what remains gated; this is not a release-acceptance claim.

## Implemented

### Phase 0 — SDK and baseline
- `@google/genai` upgraded from 2.19.0 to the reviewed **2.24.0** (lockfile updated).
- `main/services/gemini-live/sdk-contract.test.ts` pins the new reviewed version;
  Live (7 + 181 + 58) and voice (90) regression suites pass unchanged.
- Verified 2.24.0 ships the Interactions + Voices surfaces (`client.interactions`,
  `client.voices`), `SpeechConfig`/`speech_metadata`, and `audio/wav`/`audio/l16`
  response formats. `gemini-3.8-flash-tts` ids pass through the model union's
  `(string & {})` arm; live credential acceptance remains an explicit gate.

### Phase 1 — Shared contracts and source resolution
- `renderer/shared/tts.ts`: `TtsSettingsV1`, `TtsSourceRef`, `TtsStartRequest`,
  `TtsJobPhase`/`TtsJobSnapshot`/`TtsServiceEvent`, closed `TtsSafeError` union,
  `TTS_LIMITS`, strict patch/source/start parsing (unknown fields rejected).
- `main/services/tts/source.ts`: main-owned latest-response selection (last
  assistant after the latest user turn; never scans past a newer failure), busy
  and terminal evidence (including aborted/truncated Pi output and unfinished
  timelines), SHA-256 `sourceRevision` issuance and per-dispatch revalidation.
- `main/services/tts/speech-text.ts`: deterministic remark-based projection
  (formatting stripped, link labels, inline/fenced code policies, table
  linearization with size ceilings, math/images/html exclusions with omission
  notices), sentence/paragraph segmentation with surrogate-safe hard bounds.
- `main/services/tts/settings.ts` + `credentials.ts`: version-guarded settings
  document parsing; saved-Google vs dedicated encrypted key resolution
  (`aiden-internal:tts-api-key`), fail-closed on unreadable secure storage.
- `configStore.getTtsSettings/updateTtsSettings` seam with session-seeded
  compare-and-set revisions; `tts` field on both `AppSettings` shapes;
  `runtimeSettingsFrom` normalization.

### Phase 2 — Vertical slice
- `main/services/tts/gemini-wire.ts`: request builder (`store:false`, transcript
  as transcript, style only in the annotation), strict unary response parsing,
  RIFF chunk-based WAV validation, closed error classification, voices list
  parsing.
- `main/services/tts/gemini-provider.ts`: SDK adapter with `retries: 0` on
  billable POSTs and AbortSignal propagation; loopback contract test proves the
  exact serialized body through the real SDK.
- `main/services/tts/audio-store.ts`: bounded session retention, owner-scoped
  continuation reads, contiguous-consumption tracking, atomic replacement,
  and eviction only after the full segment has been retrieved. Overflow fails
  explicitly; it never silently discards unread audio.
- `main/services/tts/service.ts` (+ `service-main.ts` bindings): job state
  machine with pending-start/terminal fencing, one active job per app,
  per-document request-ID deduplication, sequential synthesis with main-owned
  source checks before each dispatch, clearable per-request timeouts,
  pause-halt/resume-wake and idle expiry, usage reporting hook, and previews.
  Owner invalidation and Stop release even completed job audio; concurrent
  settings updates are serialized around revision checks. Only registered
  starter voices are currently admitted for synthesis.
- IPC: `tts:*` handlers with strict parsing and `rendererDocumentOwner`;
  `tts:` invoke prefix and `tts:event` notification registered in the preload
  allowlists; `ipc-contract` suite green.
- Renderer: `renderer/lib/tts-client.ts` controller + `tts-player.ts`
  (decodeAudioData scheduling, sample-exact suspend/resume, full teardown),
  generation-fenced reads/decodes, ordered coalesced pumping with at most two
  decoded segments ahead, exact job ownership, and audible-completion tracking;
  `MessageActions`/`ReadAloudButton` at the response tail, chat-pane wiring
  with new-turn revocation and settings deep link.
- Settings → Text to Speech page (connection, model, starter voices, delivery,
  reading preferences, privacy disclosure, cache clear) with search keywords.
  Previews now use the gesture-primed controller/player rather than a
  generation-only IPC call. Delivery notes are bounded local drafts saved on
  blur. Footer Stop/Pause/Resume, omission text, keyboard focus, and reduced
  motion are covered by focused tests.
- Provider onboarding explains separate default-off cloud speech opt-in and
  Google processing/billing, including local-model responses; it adds no
  network call. Feature-tour gallery reviewed and left unchanged: no new tile
  advertises unaccepted streaming, Voice Studio, or mobile cloud speech.

### Verification (September 24, 2026)

- `npm run test:tts`: **108/108** (source, strict inputs, wire/SDK loopback,
  service authority, audio retention, controller/player races, footer/settings).
- TypeScript, scoped ESLint and Vite build pass (chunk-size/Ghostty mixed-import
  warnings only); `test:ci:registry` **8/8** and IPC contract
  **8/8** pass. Every new test is in `test:tts` and the CI registry.
- Voice **90/90**, Live **7 + 181 + 58**, settings design **60/60**, onboarding
  **60/60**, focused remote chat/protocol/speech contracts **42/42** pass.
- Native consumers inspected: whole-response Copy semantics are unchanged;
  desktop TTS uses only local IPC, without changing the remote speech contract.
  Physical iPhone `AidenChatTests`: **114/114**. Android chat/progress:
  **57/57** on confirmation, after an initial 56/57 run hit a `Dispatchers.Main`
  concurrency failure in `failedSendRestoresDurableDraftAfterRestart`. Focused
  chronology/progress isolation also passed **20/20**. No native code changed.
- One independent authority reviewer completed and reported five issues; all
  five were verified and fixed with coverage. The UI reviewer reached its turn
  limit without a reliable report, so the parent performed that review. A
  final follow-up reviewer batch was not admitted (tree deadline); it is **not**
  counted as review evidence. Fresh independent final sign-off remains a gate.

## Remaining (gated, not advertised)

- **Live Google acceptance** (Phase 0 gate): credentialed probes of both 3.8 TTS
  models, voice list/get, cancellation — no key available in this checkout.
- **Production streaming PCM** (Phase 3): SSE StepDelta audio path, backpressure
  budgets, slow-consumer tests. Current playback is lossless unary WAV per
  segment.
- **Voice library, design, replication** (Phase 4): provider voice browsing,
  import-by-ID, design dialog, replication wizard with consent recording,
  cloud deletion reconciliation.
- **Release hardening** (Phase 5): usage-store integration (`text-to-speech`
  source), audio-focus arbitration with dictation/Live, Electron interaction
  tests, independent final sign-off, packaged acceptance.
- **Remote/native parity** (Phase 6): `tts-v1` negotiation, mobile playback.

## Known pre-existing failures (not from this branch)

`main/services/google-provider.test.ts` fails 3 cases on pristine `origin/main`
(models.dev catalog drift in migration defaults).
