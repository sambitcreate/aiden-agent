# Bot-First Phase 9 Evidence

Date: August 23, 2026

## Delivered

- Exactly one writable persistent chat per Bot across Remote open/create, copy/fork, inbox, search, profile, turn, files, and access paths; independent Bot-chat deletion is rejected so legacy history cannot be promoted.
- Frozen Remote v1 compatibility retained: `createBotChat` and HTTP `201` remain unchanged for already-shipped clients while the server behavior becomes open-or-create.
- Deterministic legacy reconciliation by newest update, newest creation, then stable chat ID. Older duplicates remain readable and recoverable but read-only.
- Installation-and-device-scoped cache-first iOS Bot state with stale-while-revalidate segment merges and retained last-good UI.
- Optimistic favorite changes with authoritative confirmation and rollback.
- Layout-shaped cold-load skeletons that become static when Reduce Motion is enabled.
- Reused authenticated Remote client and `URLSession` for connection pooling.
- Honest Custom Access conflict/error handling, selected tombstones, and unavailable-skill filtering.
- New/Edit Bot are the only Bot provider/model controls. Full and Custom settings resolve audience-safe catalog IDs into revisioned, durable Bot-owned model authority. The one persistent chat is a recoverable execution mirror, so model changes preserve its history and any reduced Files, shell, connection, skill, or other grants; Bot composers and access-reduction sheets have no model selector, while Workspace composers remain unchanged.
- Safe New Bot two-step retry: a retained Bot creation result and independent chat idempotency key prevent duplicate Bots if opening the one persistent chat fails after identity creation.
- Actionable stale-model failure copy, inline durable failure presentation, and legacy stream-journal repair.
- Contact-first Bot navigation: Favorites plus one non-duplicated Bot list, long-press Pin/Unpin actions with optimistic revision reconciliation, and every row resuming the Bot's one persistent chat.
- Messages-inspired Bot presentation inside the existing shared chat view: grouped bubbles, Aiden's established plus-and-message composer, a measured 60-point centered avatar above the compact Bot-name capsule, Back leading, and a plain three-dot settings menu trailing. Bot identity opens the contact-style settings surface and model selection remains exclusively in New/Edit Bot.

## Automated evidence

- Physical iPhone 13 Pro focused XCTest selection: 182 tests executed, 179 passed, 3 configuration-dependent skips, 0 failures.
- Backend one-chat focused suite: 123/123 passed.
- Registered Bot backend suite: 402/402 passed.
- Full Aiden Remote suite: 308 passed, 1 environment-dependent skip, 0 failures.
- Application-service boundary suite: 72/72 passed.
- TypeScript type-check: passed.
- Focused Remote Bot/protocol/router suite after model-authority changes: 51/51 passed.
- Generic physical-iOS build-for-testing, including the updated Swift contract and XCTest bundle: passed.
- Final model-authority selection on the physical iPhone 13 Pro: 5/5 passed, covering New/Edit ownership, composer mutation rejection, persistent-chat model pinning and scope, and Remote mutation decoding.
- Scoped ESLint: passed.
- `git diff --check`: passed.
- Independent post-fix source-and-test re-review: no remaining P0/P1 findings; focused integrated review gates passed 121/121.
- Contact-flow shipping-source checks and Bot message-grouping XCTest coverage: passed on August 23, 2026.
- Final contact-flow selection on the physical iPhone 13 Pro passed the Bot contract, shared-chat, and product-shell suites, including stale optimistic-favorite fencing, one-section-per-Bot projection, and content-aware send/microphone behavior. The signed build was installed and visually checked against the supplied Messages geometry while retaining Aiden's prior composer spacing.
- Follow-up physical acceptance restored the complete pre-flow shared Aiden composer from `68e13c877`, replaced the overlapping two-path bubble tail with one continuous filled outline, and added a bounded decoded-avatar cache keyed by installation, device, Bot, and immutable asset revision. The focused shared-chat and generated-avatar selection passed 76/76 tests on the iPhone 13 Pro.
- The final bubble simplification removes message tails entirely: Bot text and streaming bubbles are plain 18-point continuous rounded rectangles. Read Aloud and its speech synthesizer were removed from the one shared chat view, so neither Bot nor Workspace chats expose speech playback. The focused shared-chat selection passed 60/60 tests on the physical iPhone 13 Pro.
- Bot selection now changes navigation immediately instead of awaiting a fresh chat and access round trip. An exact installation-scoped cached Bot chat hydrates on the next actor hop while fresh mutation authority resolves in the background; cold opens show a reduced-motion-aware skeleton shaped like the Bot identity header, chat bubbles, and established composer. Admission tests reject wrong-chat, wrong-Bot, Workspace-chat, and absent cache records.

Physical XCTest result bundle:

`/Users/sambitbiswas/Library/Developer/Xcode/DerivedData/AidenOnTheGo-dsudslimvchaxlcfkvlzjlfcaqoi/Logs/Test/Test-AidenOnTheGo-2026.08.23_15-01-36--0400.xcresult`

Final model-authority XCTest result bundle:

`/tmp/aiden-model-authority-final/Logs/Test/Test-AidenOnTheGo-2026.08.23_16-16-45--0400.xcresult`

## Physical-device evidence

- Focused tests compiled, signed, installed, and ran on the connected unlocked iPhone 13 Pro (`00008110-00063CD91E98801E`).
- No simulator was used.

## Internal TestFlight evidence

- Version `0.1.0 (18)` was archived from commit `9691c7d00`, uploaded with the checked-in internal-only export policy, and processed as `VALID`.
- Exact App Store Connect build: `47ca3b75-24c4-4fa5-bb28-14767a04fbbe`.
- Assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`): `internalBuildState=IN_BETA_TESTING`, `externalBuildState=NOT_APPLICABLE`.
- App Store Connect reports minimum iOS 18.0 and `usesNonExemptEncryption=false`. No external group, Beta App Review, App Review, metadata, pricing, screenshot, or availability mutation was performed.

## Internal TestFlight evidence — build 19

- Version `0.1.0 (19)` was archived from commit `190329463`, uploaded with the checked-in internal-only export policy, and processed as `VALID`.
- Exact App Store Connect build: `e52c1988-56e6-4cea-8de3-ce27711ef970`.
- `internalBuildState=READY_FOR_BETA_TESTING` for `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`), `externalBuildState=NOT_APPLICABLE`; App Store Connect reports minimum iOS 18.0 and `usesNonExemptEncryption=false`.
- The iOS binary carries the same Bot contract as build 18 at the bumped build number; the paired Mac gains resilient Bot access saves, desktop capability/access IPC, and the five-page Mac bot editor wizard. No external group, Beta App Review, App Review, metadata, pricing, screenshot, or availability mutation was performed.

## Internal TestFlight evidence — build 20

- Version `0.1.0 (20)` was archived from source commit `78e6c77f9`, exported and uploaded with the checked-in internal-only policy, and processed as `VALID`.
- Exact App Store Connect build: `835fe999-4821-4755-8906-2d71c56a4f11`.
- Assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`): `internalBuildState=IN_BETA_TESTING`, `externalBuildState=NOT_APPLICABLE`; App Store Connect reports minimum iOS 18.0 and `usesNonExemptEncryption=false`.
- Build 20 contains the post-build-19 save hardening, contact-first Bot flow, stable avatar cache, restored shared composer, rounded tail-free bubbles, removal of Read Aloud, and immediate exact-cache Bot chat hydration with layout-shaped cold skeletons. No external group, Beta App Review, App Review, metadata, pricing, screenshot, or availability mutation was performed.

## Post-build 19 save hardening

- Desktop New Bot now sends identity and access through the main-owned atomic creation transaction, so an access failure cannot leave an identity-only Bot behind.
- Bot and chat access saves no longer ignore runtime inventory invalidation. They retry the entire snapshot/bind/write transaction under a fresh lease up to three times, then fail closed without publishing policy if the inventory keeps changing.
- Mac and iOS Edit Bot retries use a three-way merge: only fields deliberately changed from the editor baseline survive, while unrelated authoritative edits from another surface are adopted. Provider and model remain one indivisible binding during that merge.
- `npm run test:bots`: 414 passed, 0 failed. `npm run type-check`: passed. The focused iOS conflict-rebase test built and executed on the physical iPhone 13 Pro (`00008110-00063CD91E98801E`): 1 passed, 0 failed.
- These changes are included in internal TestFlight build 20.

## External/manual gates still open

- Eligible Apple Intelligence hardware for successful Image Playground/PCC acceptance.
- Physical iPad/Stage Manager, multi-device/Mac, packaged rollback, live Telegram, wider staged TestFlight, Xcode 27, full accessibility, and App Store owner gates from Phase 8.
