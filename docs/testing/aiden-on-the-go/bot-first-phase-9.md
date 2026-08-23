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
- Bot-chat provider/model authority, actionable stale-model failure copy, inline durable failure presentation, and legacy stream-journal repair.

## Automated evidence

- Physical iPhone 13 Pro focused XCTest selection: 182 tests executed, 179 passed, 3 configuration-dependent skips, 0 failures.
- Backend one-chat focused suite: 123/123 passed.
- Registered Bot backend suite: 396/396 passed.
- Full Aiden Remote suite: 305 passed, 1 environment-dependent skip, 0 failures.
- TypeScript type-check: passed.
- Scoped ESLint: passed.
- `git diff --check`: passed.

Physical XCTest result bundle:

`/Users/sambitbiswas/Library/Developer/Xcode/DerivedData/AidenOnTheGo-dsudslimvchaxlcfkvlzjlfcaqoi/Logs/Test/Test-AidenOnTheGo-2026.08.23_15-01-36--0400.xcresult`

## Physical-device evidence

- Focused tests compiled, signed, installed, and ran on the connected unlocked iPhone 13 Pro (`00008110-00063CD91E98801E`).
- No simulator was used.

## Internal TestFlight evidence

- Version `0.1.0 (18)` was archived from commit `9691c7d00`, uploaded with the checked-in internal-only export policy, and processed as `VALID`.
- Exact App Store Connect build: `47ca3b75-24c4-4fa5-bb28-14767a04fbbe`.
- Assigned only to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`): `internalBuildState=IN_BETA_TESTING`, `externalBuildState=NOT_APPLICABLE`.
- App Store Connect reports minimum iOS 18.0 and `usesNonExemptEncryption=false`. No external group, Beta App Review, App Review, metadata, pricing, screenshot, or availability mutation was performed.

## External/manual gates still open

- Eligible Apple Intelligence hardware for successful Image Playground/PCC acceptance.
- Physical iPad/Stage Manager, multi-device/Mac, packaged rollback, live Telegram, wider staged TestFlight, Xcode 27, full accessibility, and App Store owner gates from Phase 8.
