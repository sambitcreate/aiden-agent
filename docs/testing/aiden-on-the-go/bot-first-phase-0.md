# Bot-First Aiden On The Go — Phase 0 evidence

Date: 2026-08-22
Status: Complete — product/security contracts, the fixture-only prototype, physical-iPhone evidence, and review/remediation loops passed.

## Scope and authority

Phase 0 changes documentation and a debug-only native fixture harness. It adds no Bot endpoint, renderer control, remote mutation, persistence migration, or production capability grant.

The approved contract now fixes:

- iPhone/iPad-first delivery with Mac UX redesign deferred;
- one Aiden-logo menu with exactly **Bots** and **Workspaces**;
- the existing `AidenChatDetailView`, `AidenChatViewModel`, composer, transcript, streaming, approvals, attachments, voice, cache, and reconciliation as the only Swift chat implementation;
- explicit Full Access after Mac-owned acknowledgement of `bot-full-access-v1`, with Custom bot reductions and chat-only narrowing;
- one hidden durable non-Git managed home per Bot, the Mac-owned shell starting there, ordinary artifacts saved there, and task-needed outside-home access under Full;
- no client-authored terminal or shell endpoint;
- Mac-owned, cross-device favorite order;
- distinct server-supported and authenticated-device-granted capabilities, with ambiguous legacy grants failing closed for Bots;
- bot-chat-scoped Files authorization that cannot be bypassed through ordinary Workspace routes;
- system Image Playground with Apple-controlled processing/PCC permitted, accepted-image-only upload, paired-Mac canonical storage, and a semantic avatar fallback.

Normative files reviewed together:

- `docs/plans/bot-first-aiden-on-the-go-plan.md`
- `docs/plans/aiden-on-the-go-plan.md`
- `docs/aiden-remote-api-v1.md`
- `docs/security/aiden-remote-threat-model.md`
- `ios/PROJECT_SPEC.md`
- `ios/AGENTS.md`

## UI and architecture review

Both required repository references were reviewed in full before UI work:

- `docs/chatgpt-desktop-ui-inspiration.md`
- `docs/chatgpt-ui-element-specimen.html`

The applied design direction is identity-first and message-first: circular favorite identities, flat recent-thread rows, quiet native Search/Edit/Add controls, progressive capability disclosure, semantic Aiden theme tokens, and reduced-motion/accessibility behavior. It deliberately avoids a fixed four-column grid, a permissions-dashboard home, and a literal Messages clone.

An independent source review found seven Phase 0 blockers. The contract remediation:

1. removed an unseen Workspace-permission ceiling from Bot access;
2. required server support and device grants to be stored separately;
3. chose mounted independent product stacks plus one installation/chat-keyed shared draft store;
4. defined bot-chat-scoped Files authorization and ordinary-Workspace-route rejection;
5. clarified Mac-owned shell use versus a forbidden client-authored terminal endpoint;
6. froze the notice identifier/copy, migration copy, ownership of favorites, and degraded-state copy;
7. required this dedicated evidence artifact and the physical fixture prototype before closing the phase.

The implementation review then found live-runtime construction in the fixture path and product-state gaps. The final harness constructs neither `AidenRemoteCoordinator` nor `AidenAppearanceStore`, gives `AidenChatViewModel` a Debug-only read-only fixture runtime, and rejects every live entry point. Follow-up fixes added the blocking disclosure, distinct retained product roots, honest activity and error states, archive confirmation, adaptive navigation, accessibility behavior, and editor dismissal protection. A second review found three remaining issues—Customize-first routing, accidental reuse of an existing chat for New Conversation, and non-retained access selections. All three were fixed and re-reviewed against the stable tree.

## Fixture prototype

The harness is compiled only in Debug and enabled only by `--bot-first-prototype`. Before any live coordinator or appearance store is constructed, launch configuration routes directly to fixture state. The fixture performs no networking, persistence, credential access, Live Activity work, or remote mutation.

The prototype exercises:

- the blocking `bot-full-access-v1` notice and Customize-first path;
- independent retained Bots and Workspaces roots behind the Aiden-logo switcher;
- favorite identities, recent conversations, edit/archive behavior, and all specified loading/error/offline/degraded/archived/no-results states;
- the requested bottom Search capsule and separate New Conversation control;
- New Conversation bot selection that produces a distinct fixture chat every time;
- New/Edit Bot, semantic avatar styles, honest Image Playground-unavailable fallback, profile, and bot/chat access sheets;
- retained Full/Custom choices and chat reductions that cannot exceed the bot ceiling;
- compact navigation and a regular-width split presentation in all four Aiden themes.

Every fixture conversation routes into the production `AidenChatDetailView`, `AidenChatViewModel`, transcript, and `AidenComposerView`. The shared composer is visibly present but read-only in the fixture; there is no Bot transcript, composer, transport, cache, stream, approval, or attachment implementation.

## Automated evidence

Final release-source suite:

```text
npm run test:ios-release
PASS — 20 Ruby runs / 42 assertions and 27 Node tests

git diff --check
PASS
```

Generic unsigned iPhoneOS Debug compilation:

```text
xcodebuild -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
PASS — BUILD SUCCEEDED
```

The registered source gate additionally proves that:

- the prototype is Debug-only and bypasses live dependency construction;
- the shared chat detail/view-model/composer remain the sole Swift chat implementation;
- the Bot fixture does not import transport, persistence, streaming, Live Activity, or remote mutation dependencies;
- the Bots header has no Search action and the bottom dock contains both Search and New Conversation;
- the ordinary production launch surface remains unchanged by the fixture harness.

## Physical-device evidence

Target selected for compact acceptance:

- iPhone 13 Pro (`iPhone14,2`)
- CoreDevice ID `826D57EC-4BCD-5BC0-9A31-AFB4147611F1`
- Xcode destination ID `00008110-00063CD91E98801E`

The device is connected and unlocked. This hardware may prove compact Bot UX and the honest Image Playground-unavailable fallback only. It cannot prove successful Apple Intelligence generation. A supported physical iPhone/iPad and a physical iPad layout/Stage Manager pass remain later release gates and are not inferred from fixture rendering or generic compilation.

### Compact UI captures

A signed Debug build was installed and launched with fixture-only arguments. The following 1170 × 2532 captures were inspected on the connected iPhone 13 Pro:

- `/tmp/aiden-bot-phase0-final.G23j5G/notice.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/inbox-aiden.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/inbox-slate.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/inbox-berry.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/inbox-moss.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/profile.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/editor.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/access.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/chat.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/state-error.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/state-offline.png`
- `/tmp/aiden-bot-phase0-final.G23j5G/state-no-results.png`

The inbox captures include the final bottom Search/New Conversation dock. The chat capture visibly uses the existing production composer in its disabled fixture state.

After the final P1 remediation, the exact stable source was rebuilt, signed, installed, and launched again on the same iPhone. The inspected 1170 × 2532 capture is:

- `/tmp/aiden-bot-phase0-final.G23j5G/remediated-inbox.png`

It confirms the bottom Search/New Conversation dock, active favorites, honest activity labels, and compact safe-area layout from the committed Phase 0 source.

### Physical fixture-isolation test

The latest source was compiled, installed, and exercised on the iPhone 13 Pro:

```text
AidenChatTests/testReadOnlyFixtureChatRejectsEveryLiveEntryPointWithoutMutatingItsChat
PASS — 1 test, 0 failures (0.003 seconds)
```

Result bundle:

`/tmp/aiden-bot-phase0-final.G23j5G/DerivedData/Logs/Test/Test-AidenOnTheGo-2026.08.22_21-25-28--0400.xcresult`

### Regular-width evidence harness

An app-hosted UIKit/SwiftUI harness rendered the real launch view under iPad/regular traits at 1024 × 768 in each Aiden theme. It ran on the physical iPhone 13 Pro and asserted the dimensions and nonblank rendered content:

```text
AidenBotPrototypeSnapshotTests/testRegularWidthBotInboxRendersEveryAidenThemeAtReviewSize
PASS — 1 test, 0 failures (0.719 seconds)
```

Result bundle:

`/tmp/aiden-bot-regular-evidence.Jam2ew/BotFirstPrototypeRegular.xcresult`

Kept attachments:

- Aiden: `/tmp/aiden-bot-regular-evidence.Jam2ew/attachments/BA3379A8-6EED-40E3-80FF-58EDDEC9C140.png`
- Slate: `/tmp/aiden-bot-regular-evidence.Jam2ew/attachments/20E0B75F-3D08-47A9-B6E3-D551C294FE2F.png`
- Berry: `/tmp/aiden-bot-regular-evidence.Jam2ew/attachments/EB06AC20-9B89-4245-A18A-D9B052B7162B.png`
- Moss: `/tmp/aiden-bot-regular-evidence.Jam2ew/attachments/F1A7C091-CFDA-4511-A196-907DF5145A54.png`

This is regular-width rendered evidence, not physical-iPad interaction proof. UIKit emitted non-failing appearance-cleanup diagnostics after capture. A physical iPad rotation/Stage Manager pass remains a later release gate.

## Gate status

Phase 0 is complete. Two independent review/remediation loops ended with no P0/P1 findings, and the final source passed the release-source suite, generic compilation, signed physical-iPhone compilation/install/launch, fixture-isolation test, and regular-width render harness. This authorizes Phase 1 contract/classification work, but no production Bot feature is release-ready. Successful Image Playground behavior still requires supported Apple Intelligence hardware; physical iPad interaction, Stage Manager, signing/privacy re-audit, migration, and final release acceptance remain explicit later gates.
