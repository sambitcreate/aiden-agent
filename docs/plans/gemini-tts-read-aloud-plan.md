# Gemini 3.8 Read Aloud and Voice Studio — Implementation Status

**Status:** Partial implementation (desktop unary-WAV and desktop-configured native playback implemented; live acceptance, streaming, Voice Studio, and physical playback verification pending).
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
  Saved Google resolves through the encrypted managed `piCredentialStore`,
  not the legacy custom-provider secret map.
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
  continuation reads and atomic replacement. Reads never evict a soundbite
  prefix. The service evicts only whole inactive soundbites; active audio
  overflow fails explicitly rather than dropping words or breaking replay.
- `main/services/tts/service.ts` (+ `service-main.ts` bindings): job state
  machine with pending-start/terminal fencing, one active job per app,
  per-document request-ID deduplication, sequential synthesis with main-owned
  source checks before each dispatch, clearable per-request timeouts,
  pause-halt/resume-wake and idle expiry, usage reporting hook, and previews.
  Stop halts audible playback but preserves completed audio for session replay;
  owner invalidation and cache clear release it. Canonical response/effective
  speech-setting identities reuse the same soundbite with no provider/usage
  call, even with a fresh request ID. Bounded identity tombstones survive
  eviction/clear, so unavailable or possibly-billed failed audio is never
  regenerated automatically. Previews follow the same replay policy. Concurrent
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
  models, voice list/get, cancellation. A key is configured in the isolated dev
  profile; no automated paid live-acceptance probes have been run.
- **Production streaming PCM** (Phase 3): SSE StepDelta audio path, backpressure
  budgets, slow-consumer tests. Current playback is lossless unary WAV per
  segment.
- **Voice library, design, replication** (Phase 4): provider voice browsing,
  import-by-ID, design dialog, replication wizard with consent recording,
  cloud deletion reconciliation.
- **Release hardening** (Phase 5): audio-focus arbitration with dictation/Live, Electron interaction
  tests, independent final sign-off, packaged acceptance.
- **Remote/native parity** (Phase 6, user-requested): `tts-v1` negotiation,
  authenticated device/chat-scoped audio delivery and iOS/Android playback.
  Existing `/speech` handles transcription, not TTS; do not reuse its writable
  model-selection routes for read-aloud configuration. Native playback must
  inherit desktop enablement, credentials, voice and reading policy. Native
  Settings must be read-only with “Enable Read Aloud in the desktop app under
  Settings → Text to Speech” guidance, and refresh status after desktop setup.
  TODO (future feature): allow mobile configuration only with a separately
  designed/authorized contract; do not expose settings/key mutations now.
  Recheck Bot-chat/device access before each dispatch and audio read, scope
  Stop to the owning device/job, fence navigation/background/revocation, and
  never auto-regenerate after transport loss or cache eviction. This integration
  is implemented below; physical/cloud playback acceptance is not yet claimed.

## Known pre-existing failures (not from this branch)

`main/services/google-provider.test.ts` fails 3 cases on pristine `origin/main`
(models.dev catalog drift in migration defaults).


## Desktop-owned mobile playback — September 24, 2026

Implemented the authenticated `tts-v1` Remote API and iOS/Android Read Aloud
controls for the latest eligible assistant response. Both use the desktop's
configuration, canonical source IDs, bounded in-memory WAV chunks, retained
soundbite replay and owner/request-scoped Stop. Desktop audible completion now
releases the shared playback slot without deleting its retained soundbite.
Native lifecycle, audio focus/interruption/headphone removal, microphone entry,
context changes and authorization/source changes stop playback. Settings are
read-only, refreshable, and direct users to desktop Settings → Text to Speech;
explicit TODOs retain mobile configuration as future work. Pairing/onboarding
now disclose desktop ownership and the Google text/billing boundary. Reviewed
the existing On The Go gallery tile; no new unaccepted Voice Studio capability
or illustration is advertised.

Verification: TypeScript/scoped ESLint/diff hygiene and Electron build pass.
TTS suite 122 tests; full Remote suite 17 + 441 + 7 passed, with one existing
skipped case. Android chat/progress/client/Bot suites 101 passed and debug APK
assembled. iOS unsigned `build-for-testing` passed (including new tests).
Physical XCTest was attempted on the available Smbt16ProMax but blocked because
it was locked; stopped the waiting run, and do not count it as a pass. Final
independent review was not admitted (subagent tree deadline); no sign-off is
claimed. Real-device audible playback and live Google acceptance remain open.
Evidence: `/tmp/aiden-native-tts.0Ef4XD/` on the development Mac.


### Unlocked iPhone verification and simulator permission

After the owner unlocked Smbt16ProMax, reran AidenChatTests,
AidenRemoteClientTests and AidenRemotePhase0Tests on that physical iPhone:
**224 passed, 5 skipped, 0 failures (229 total)**. The three new Read Aloud
regressions passed. This supersedes the earlier locked-device test blocker;
it does not establish live Google synthesis or real audible playback acceptance.
Log: `/tmp/aiden-ios-unlocked.keqYnW/tests.log`; result bundle:
`/tmp/aiden-tts-ios-device/Logs/Test/Test-AidenOnTheGo-2026.09.24_16-34-59--0400.xcresult`.

At the owner's explicit request, `ios/AGENTS.md` now permits simulator testing
and no longer requires the unavailable iPhone 13 Pro as the default destination.
Physical-device evidence remains necessary for hardware, actual audio routing,
and signing/Keychain/entitlements acceptance. No simulator run is claimed here.


### PR publication follow-up

The original PR CI lint failure was traced to test setters returning assignment
values and an unused segmentation counter. Both are corrected without changing
segmentation behavior. Fresh full ESLint, application and E2E TypeScript checks,
CI registry (8 tests), TTS (122 tests), and diff hygiene pass locally. PR #245
remains draft pending the acceptance/review gates above; rerun CI is authoritative
for the new published revision.


### PR #245 review corrections — September 25, 2026

Addressed all five Pullfrog findings against published `7bd5080`: production
usage-store binding with once-only dispatch settlement; strict 24 kHz mono WAV;
native progress-based watchdogs instead of the 15-minute cap; reclaimable remote
sessions with independent bounded anti-rebilling ledgers; and projected
failed/cancelled outcome checks in both native speaker eligibility paths.
Native hosted-cost labels now distinguish unpriced requests from free usage.

Validation: TTS 128; usage store 14; CI registry 8; Remote 17 + 441 + 7 passed
(one skipped); Android 108 passed; iPhone 17 / iOS 26.4 simulator 227 passed,
5 skipped, 0 failures (232 total). TypeScript, scoped ESLint, diff hygiene and
Electron build pass. Evidence: `/tmp/aiden-pr245-review-fixes/`. The first native
cost test assumed a nonexistent fixture entry, which was corrected to typed
fixtures; a subsequent simulator runner stalled before XCTest connection and
was terminated. A fresh isolated simulator completed the final suite above.
No new paid synthesis was performed; prior owner-confirmed manual verification
is separate from these automated results.

Existing head CI and Hermes were green; Hermes reported no findings on `7bd5080`.
Fresh CI/Hermes results for this correction commit must be checked after push.
An additional local subagent review was not admitted (tree deadline); no new
local reviewer sign-off is claimed. PR is ready for review, not draft; full
Voice Studio/streaming scope remains partial.
