# Aiden On The Go — Bot-first Phase 7 evidence

Date: August 23, 2026

Status: implementation complete; eligible Apple Intelligence hardware acceptance remains open.

## Shipped implementation

- `AidenBotImagePlaygroundView` isolates the system Image Playground sheet behind iOS 18.1 availability and gates Aiden generation to iOS/iPadOS 18.4+, where Aiden can explicitly disable personalization and enumerate only Animation, Illustration, and Sketch. It supplies only the visible bounded Bot name and purpose as text concepts.
- Copy explains that Apple controls generation and may use Private Cloud Compute. Aiden does not promise universal on-device generation and does not send sheet concepts, rejected candidates, or temporary locations to Aiden's developer or the paired Mac.
- The system completion URL is synchronously copied into an app-owned protected temporary file, rejects symlinks and nonregular/oversize sources, and is deleted after ingestion. Candidate residue is bounded and removed at process launch, retried when the editor appears if protected files were unavailable while locked, and never removes unrelated files.
- The iOS normalizer admits a bounded 32 MiB system result, validates a complete single-frame image with bounded dimensions/pixels, downsamples before full decode, center-crops into a metadata-free 512 × 512 sRGB PNG, and limits the upload to 4 MiB.
- The existing Bot editor remains semantic-avatar-first. Existing Bots can open Image Playground, preview locally, choose **Use this image**, replace a generated photo, or confirm a return to the semantic avatar. New Bots are created without Apple Intelligence; the editor clearly asks the person to save first and then edit the Bot to add a generated photo.
- An accepted preview participates in editor dirty/discard behavior. Settings Save is disabled while that separate preview decision is unresolved, preventing an identity/access save from dismissing and destroying the candidate.
- Upload, lost-response reconciliation, definite rejection, retry, replacement, delete, credential revocation, installation/device switching, overlapping loads, and concurrent Mac edits are fenced by exact request context, Bot/asset revision, operation generation, mutation token, and retained idempotency identity.
- Canonical photos render over the semantic fallback in favorites, Bot/conversation rows, profile, and the existing shared Swift chat toolbar. The cache is scoped to exact Mac instance, pairing device, Bot, and immutable asset revision without invalidating the Bot inbox snapshot activation.
- Mobile privacy/support and App Review drafts now describe Apple/PCC processing, disabled Photos/person personalization, explicit accepted-image upload, developer-inaccessible processing, direct paired-Mac storage, and temporary cleanup.

## Review and remediation

A different subagent independently reviewed the stable Phase 7 tree after implementation. The review loops found and closed:

- stale same-context loads and A → B → A raster publication;
- preflight double taps and retained-retry busy-state races;
- lost PUT/DELETE response ambiguity and exact idempotency reuse;
- overwriting or deleting a photo concurrently changed on the Mac;
- candidate loss through editor Save/dismiss;
- candidate crash residue after process termination;
- wrong-Bot SwiftUI row reuse when asset revisions collide;
- privacy wording that could imply Apple never receives concepts or that Aiden's developer stores the accepted image;
- source guards that were too narrow to reject later source-image/personalization regressions.

The final independent audit reported no remaining actionable P0/P1 implementation findings.

## Automated and physical verification

- Signed `build-for-testing` succeeded against Xcode destination `00008110-00063CD91E98801E` (Sambit's unlocked iPhone 13 Pro), using Xcode 26.3 and the iPhoneOS 26.2 SDK. No simulator was used.
- A broad signed physical-device run covered 209 selected Bot/cache/product-shell/remote-client/shared-chat/native-integration tests: 206 passed, three opt-in live-environment tests skipped as expected, and zero failed.
- After final cleanup changes, the focused physical run passed all 42 `AidenBotContractTests`, all 15 `AidenBotGeneratedAvatarTests`, and all 10 then-current `AidenBotImagePlaygroundTests` (67/67).
- A separate opt-in physical test then directly verified `ImagePlaygroundViewController.isAvailable == false` on the iPhone 13 Pro. The real fallback renderer test also passed and retained an XCTest image attachment; its callback count remained zero, proving the fallback did not produce a candidate.
- Generated-avatar behavior covers a committed lost PUT with exactly one upload/no replay, ambiguous retry with the same key and single-flight busy state, lost DELETE reconciliation, concurrent replacement blocking PUT and DELETE, nested credential revocation, exact-device relaunch cache, and overlapping same-context load rejection.
- Candidate tests cover system URLs outside the ordinary temporary root, synchronous copy/removal, non-file/empty/symlink rejection, crash-residue bounds, launch cleanup, and preservation of unrelated files.
- `npm run test:ios-release` passed: 20 Ruby policy tests and 28 Node release-policy tests, including 11/11 shipping-source checks.
- `git diff --check` passed.

## Open release acceptance

No eligible physical Apple Intelligence iPhone or iPad was owner-authorized for Phase 7 acceptance. Therefore Phase 7 does **not** claim successful system generation. Before release, owner-authorized eligible physical hardware must prove:

1. system sheet → accepted preview → **Use this image** → authenticated real paired-Mac normalization/store;
2. app/Mac relaunch, exact cache restoration, replacement, and revert;
3. cancel, refusal, model download/unavailable, network, usage-limit, and PCC states;
4. pixel-equivalence between the iOS normalized candidate and the real Electron `nativeImage` canonical result used by reconciliation.

These remain explicit Phase 7 acceptance gates carried into Phase 8's release matrix, not inferred from mocked canonical bytes or the unsupported iPhone.
