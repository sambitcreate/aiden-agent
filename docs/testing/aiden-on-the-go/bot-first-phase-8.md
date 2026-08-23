# Aiden On The Go — Bot-first Phase 8 evidence

Date: August 23, 2026

Status: implementation complete; staged rollout and external physical-system acceptance remain open.

## Shipped integration

- A reversible mobile rollout flag now fails closed when absent. Pairing advertises Bot capability support only while the flag is enabled, and the product shell independently fences home loading, search, open/create, mutation resolution, restoration, and deep-link presentation. Read-only grants can browse Bot history but cannot create a conversation or resolve mutation authority.
- The paired-installation onboarding copy introduces Bots and Workspaces before pairing. After a Bot-capable pairing, a native coachmark is anchored to the real Aiden logo, explains the one-time Full Access choice in plain language, and records its version against the exact Mac and device. Read-only pairings receive read-only guidance. Unpairing removes that device-local completion state.
- Existing Mac Bot roster, detail, and shared-chat surfaces now display the canonical photo accepted on iOS over the semantic fallback. The main process projects verified PNG content without exposing a private path. Renderer reads are visibility-gated, selected-Bot prioritized, capped at four concurrent requests, and retained within 64 entries and 32 MiB. Queued work is cancelled when the final row subscriber leaves; already-active work remains bounded.
- Telegram continues through the shared protected Bot resolver. A regression locks its surface ceiling so Computer Use, subagents, and MCP approval prompts cannot be admitted through Telegram even when a Bot otherwise has Full Access.
- The desktop onboarding Bots tile now describes the shipped reusable-helper behavior without promising the deferred Mac Messages-style redesign. Its existing dedicated 1024 × 1024 transparent artwork remains unchanged and tested.
- App Store metadata now identifies version 0.1.0 build 15 as the current processed internal TestFlight candidate.

## Review and remediation

Independent subagents reviewed the stable Phase 8 tree between implementation slices. The review loops found and closed:

- Bot work continuing from an opacity-hidden mounted SwiftUI surface while rollout was disabled;
- rollout-off deep links, restoration, search, and retained paths reaching Bot-specific work;
- a stale New Chat sheet attempting creation after the pairing became read-only;
- a per-row Mac photo query creating unbounded IPC, decoded-byte retention, and offscreen queue drain;
- onboarding copy that could promise writable Full Access behavior to a read-only pairing;
- stale internal onboarding and App Store build copy.

The final regression pairs a behavioral Swift policy test with a bounded shipping-source assertion that the creation admission check occurs before request-context acquisition and `createBotChat`. The final independent focused audit reported no remaining P0/P1 implementation or regression-coverage findings.

## Automated and physical verification

- The complete repository gate passed before the two final localized review fixes: type-check, lint, production build, Bot suites, Aiden Remote suites, onboarding, the full `npm run test` inventory, and iOS release policy. This included Telegram 177/177, onboarding 30/30, native worktree remover 33/33, and the Rust Computer Use 41/41 plus formatting and lint gates.
- After the final fixes, `npm run test:bots` passed 386/386 TypeScript tests plus 10/10 native pretests. The focused canonical-photo/onboarding track passed 71/71 tests. Type-check, lint, and `git diff --check` passed.
- `npm run test:ios-release` passed 20 Ruby tests with 42 assertions and all 30 Node release-policy tests. The shipping guard covers the fail-closed feature flag, every enumerated Bot ingress, operation-sensitive write admission, Image Playground isolation, shared-chat reuse, onboarding asset identity, and exact release metadata.
- A signed physical-device run on the connected, unlocked iPhone 13 Pro at Xcode destination `00008110-00063CD91E98801E` passed 27/27 selected tests: 15 native-integration, 10 product-shell, and two pairing/rollout tests. No simulator was used.
- Independent final review found no remaining P0/P1 security, data-loss, navigation, privacy, or bounded-resource defect in the implemented scope.

## Live development startup follow-up

The first real restart of the shared development profile exposed a macOS Keychain CLI mismatch that mocks could not reproduce: `security add-generic-password -w` prompted on a controlling terminal instead of consuming the piped secret and hit the five-second fail-closed timeout. The writer now uses `security -i` with a strictly bounded command and hex value carried only through stdin; the secret remains absent from process arguments, and the existing compare-before-store plus read-back verification remains authoritative. A temporary isolated keychain proved the real command before the development profile was retried. The focused Keychain tests, type-check, lint, and the full Bot suite pass (387/387 plus 10/10 native pretests). A live restart then created and verified all four protected Bot/Telegram authority items, restored the existing `Aiden Agent Dev` profile, and started Remote on its retained LAN port `49220` without a Bot initialization error.

## Rollout and open release acceptance

The code-level Phase 8 scope is complete, but the plan remains Active. The mobile flag is enabled in the current Debug and Release build configurations and can be overridden to `NO` for rollback. Wider release still requires owner-authorized external evidence:

1. eligible Apple Intelligence iPhone/iPad system-sheet generation, PCC/network/model/refusal/cancel states, authenticated real-Mac save, relaunch, replacement/revert, and pixel-equivalence;
2. a physical iPad for split view, Stage Manager, keyboard/pointer, rotation, VoiceOver, and large Dynamic Type;
3. two physical mobile devices paired across two Macs for grant, cache, revocation, offline, and stale-response behavior;
4. packaged Mac update → rollback → update plus canonical-photo render/restart acceptance;
5. a live Telegram-bound Bot using selected and withheld capabilities;
6. staged TestFlight acceptance for fresh and legacy profiles before wider rollout;
7. an Xcode 27 SDK re-audit and the remaining App Store privacy/support publication, review-environment, asset, and owner release decisions.

These are external hardware, installed-build, service, and publication gates. They are not represented as complete by mocked data or the iPhone 13 Pro fallback run.
