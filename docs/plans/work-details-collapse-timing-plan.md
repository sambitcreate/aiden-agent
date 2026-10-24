# Chat appearance and busy-send preferences

Status: Implemented on branch; local verification, review and hosted CI in progress.
Date: 2026-10-24.

## Scope

Appearance → Chat gains four controls using the shared grouped row and Select components:

- **Work details:** Compact, Standard (default), Detailed, Verbose.
- **When to collapse work details:** On completion (default), On next message.
- **Open chat links in:** the existing browser service preference, also available in Links; Ask each time, Aiden browser, System browser.
- **Send behavior while busy:** Queue (default), Steer. Cmd/Ctrl+Enter uses the other action while running, while Shift+Enter inserts a newline and idle submission stays unchanged.

The first, second and fourth preferences are additive `AppearanceConfig` v1 fields. Legacy settings normalize to the defaults; strict import/IPC parsing rejects explicit invalid values. Normal appearance preview and debounced save apply. Link opening keeps its existing persistence, live broadcasts, local-file boundaries, loopback behavior, modifier-click override, and restricted-content confirmation.

## Presentation contract

| Mode | Automatic work presentation |
| --- | --- |
| Compact | Summary headers; reasoning and full trails are available on demand. |
| Standard | Bounded reasoning and the existing three-row activity ticker during a run; the selected timing decides when retained previews fold. |
| Detailed | Reasoning previews and expanded tool activity for the eligible exchange; older automatic details fold. |
| Verbose | Automatic reasoning previews and full activity trails throughout history; manual disclosure still wins. |

On completion folds automatic previews when the turn completes. On next message retains the latest exchange until another ordinary message enters the saved transcript. Assistant continuations stay in the latest exchange. Drafts, uncommitted local queued rows and failed sends never consume eligibility. A new prompt admitted during live-to-saved handoff folds the previous reply in that same handoff.

The one-second reasoning-preview timer is removed. Automatic reasoning remains bounded; manual expansion flows at full height. Running status, shimmer and announcements derive from real lifecycle rather than whether a section is open. Errors and claim-check outcomes keep their existing attention behavior. Final answers, intermediate prose, images, visuals, attachments, question recaps and approval controls retain their independent placement. Stable row keys preserve answer and artifact identity.

Bot Quiet/Summary/Detailed settings continue deciding which activity exists. The global mode adjusts automatic disclosure for Detailed Bots, and timing retains recaps across routine/background continuations until the next user entry. Manual choices persist. These are desktop-local preferences; native clients retain their own presentation and Remote carries no new fields or revision.

## Implementation

1. Add validated schema fields, shared labels, and Appearance rows; embed the existing Links control rather than creating a competing preference.
2. Subscribe to primitive appearance preferences in transcript and composer owners. Resolve automatic work visibility separately from explicit disclosure state. Cover chronological/fallback response rendering and the independent Bot transcript path.
3. Preserve live/saved keys, honor focus and sticky-collapse behavior, and connect the busy default and alternate shortcut to existing Queue/Steer callbacks. Unsupported Steer falls back to the existing Queue affordance; explicit invalid Steer submissions retain their existing validation/draft protection.
4. Extend behavioral tests, run focused desktop/Electron/native checks, review with GPT-6.1 Sol at high effort, create a PR, and observe CI on its exact head until green. Do not merge without a separate request.

## Acceptance

- Legacy normalization, malformed values, roundtrip import/export, and stored preferences after relaunch.
- All four modes, both timings, completed labels, manual overrides, and Bot detail-level precedence.
- Handoff behind a newly admitted prompt; preserved answer/artifact element identity; regeneration isolation.
- Queue vs Steer defaults; Enter, Cmd/Ctrl+Enter, Shift+Enter, idle sends, unavailable Steer, and draft preservation.
- Settings row geometry at 390/600/1280px, keyboard access, semantic focus, and reduced motion.
- Existing link routing tests and one browser-service source of truth from either settings destination.
- iOS and Android focused chat/activity compatibility suites, even though this change adds no native settings or Remote contract.
- Required CI test registry registration, type checking, lint, and focused local suites before hosted CI.

Review the onboarding gallery: this is a small display/composer preference, without setup, permissions, provider configuration or new core capability, so no new tour tile is appropriate. Update the settings guide, composer guide, README and PRODUCT description. CLI palette generation remains unchanged, and no phone/CLI support is advertised for these desktop controls.

Verification results and PR status will be recorded when acceptance completes.

## Local verification and review

2026-10-24:

- Production build, root/Electron-spec type checks, lint and diff whitespace checks pass.
- Focused preference suite: 41 tests; settings design: 63; transcript/rich links: 70; link routing/appearance: 40; transcript polish: 7; Bot/desktop compatibility: 112; CI registry: 15; CLI palette fidelity: 4 — all pass.
- Electron: the new persistence/responsive settings scenario passes on the final build; existing follow/scroll and queue lifecycle suites pass 21/21.
- iOS `AidenChatTests`: 318 passed on an iPhone 17 Pro simulator.
- Android selected chat/agent suites: 182 ran, with one timeout in `AidenChatTest.aTitleRefreshWithoutTheCancelledRunsReplyKeepsTheLiveCard` (5 seconds). Its one allowed focused rerun passed. The separate Bot activity suite passes 50/50. No native code, timeout or retry policy changed; retain this as a known local flake in the PR.
- GPT-6.1 Sol high-effort review identified premature subgroup folding, live preference resilience under failed storage writes/remounts, and sticky-header restoration during automatic collapse. Each was fixed and covered behaviorally; final verification reported no remaining actionable findings.
- React Doctor reports three non-blocking warnings: the existing large Appearance component, recap complexity, and the intentional JSON serialization roundtrip in a preference test. No scanner suppression or new dependency was added.

Hosted CI must still be checked on the PR's exact head.
