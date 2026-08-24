# Companion vision model verification

Date: 2026-08-24  
Target: Aiden Agent macOS runtime and Bot editor, Aiden Remote revision 9, Aiden On The Go on a physical iPhone 13 Pro

## Verified behavior

- Vision-capable primary models receive original image attachments without invoking a companion.
- Text-only Bot models receive opaque current-chat image references and may call the exact saved companion through the tool-free `inspect_image` helper.
- A missing companion rejects a remote image turn before its one-shot upload is consumed and iOS opens the Bot setup flow.
- Bot companion selection is exact-bound, revisions policy authority, fences active leases before persistence, and fails closed on capability or credential drift.
- Legacy stored model bindings without image metadata remain valid until the user makes a new explicit capability choice.
- Image-tool cancellation and authority revocation propagate to the owning turn instead of becoming ordinary model-visible output.
- The iOS Bot chat hydrates companion and primary image capability from its pairing-scoped cache before refreshing, then persists refreshed detail and catalog state.
- Mac and iOS disclose that an attached image and a focused question go to the selected companion provider. Both surfaces explain how to recover when no image-capable model is connected.

## Automated evidence

- `npm run type-check` — passed.
- `npm run test:bots` — 417 passed, 0 failed.
- `npm run test:aiden-remote` — 311 passed, one expected skip, plus 7/7 LAN transport proofs.
- `npm run test:aiden-service-boundary` — 76 passed, 0 failed.
- `npm run test:onboarding` — 30 passed, 0 failed.
- `npm run test:ios-release` — 30 passed, 0 failed.
- Focused image, binding, and lease tests — 34 passed, 0 failed.
- `git diff --check` and protocol JSON validation — passed.

## Physical-device evidence

The development test build compiled and ran on the connected, unlocked iPhone 13 Pro (`00008110-00063CD91E98801E`). The complete test target executed 282 tests: 276 passed, six expected environment-dependent tests skipped, and zero failed.

## Independent review and remediation

Two post-implementation reviews were completed:

1. Runtime/security review: fixed pre-persistence companion lease fencing, cancellation propagation, and backward-compatible legacy capability drift.
2. Product/contract review: fixed cache-first Bot image authority, fail-closed unknown state, direct Edit Bot recovery for raced sends, complete second-provider disclosure, and no-provider empty states.

No P0 findings remained after remediation, and all affected gates were rerun successfully.

## Internal TestFlight

Version `0.1.0` build `22` was archived from implementation commit `50f9967f4`, uploaded with the checked-in internal-only export policy, processed as `VALID`, and assigned to `Internal Testers` (`3f90ffa7-29bb-429e-80a4-88422eb85b6d`). Exact build `f31801d1-91c1-4c79-8086-24bfec4c8078` reports `internalBuildState=IN_BETA_TESTING` and `externalBuildState=NOT_APPLICABLE`.
