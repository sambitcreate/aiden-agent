# Skill invocation policy — 2026-09-22

Baseline `origin/main` c8c09e0d2; branch `feature/skill-mcp-session-context`.

Implemented independent `modelInvocable`/`userInvocable` policies for discovered skills from strict boolean `disable-model-invocation` and `user-invocable` frontmatter. Legacy/configured defaults remain both. Model tools, summary prompts and Pi resources use model policy; user catalog, Telegram commands, authoritative resolution and formatting use user policy. Policy edits change fingerprints and user selection IDs. In-flight model tools retain captured content/policy; global opt-out still blocks execution. Existing source collision precedence remains one identity across surfaces, with no fallback to shadowed content after opt-out.

Bot automatic skill eligibility uses model policy through existing available flags. Eligible entries sort ahead of unavailable entries before the 256 limit. iOS/Android use the existing availability field for catalog validation and tools/editor selections; no native wire changes. Onboarding Skills copy explains automatic/explicit use using the existing artwork.

Research checked: dated Notion DeepSeek→Aiden and September 11/15 digests against current Aiden and primary `deepseek-ai/deepseek-harness` docs/subsystems/skills.md and packages/skill/skill/src/index.ts (HEAD observed c36a83ff6bb95e3f82cf79f9be7c724270a8aa61). Original implementation, no source copied. Bodies already load lazily into model context; bounded disk reads retained for validation/fingerprints. MCP advertised capabilities, scoped resources, server instructions and safe request-boundary refresh remain deferred in docs/plans/skill-mcp-session-context-plan.md. MCP spills and provider upgrades outside scope.

## Validation

- `npm run test:slash-commands`: 448 passed.
- `npm run test:bots`: 449 passed.
- `npm run test:telegram`: 210 passed.
- `npm run test:onboarding`: 55 passed.
- TypeScript, full ESLint and diff whitespace checks passed.
- Android focused AidenRemoteClientTest (28) and AidenBotContractTest (14): 42 passed. Explicit SDK/JBR paths; no native edits.
- iOS physical 13 Pro command: Xcode-beta `xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination platform=iOS,id=00008110-00063CD91E98801E -derivedDataPath /tmp/aiden-skills-ios -resultBundlePath /tmp/aiden-skills-ios-tests.xcresult -only-testing:AidenOnTheGoTests/AidenBotContractTests -only-testing:AidenOnTheGoTests/AidenBotCacheTests`. Build completed, but runner launch blocked by `com.apple.dt.deviceprep Code=-3`, “Unlock Sambit’s iPhone to Continue”. Interrupted our process to release coordinated device slot. No XCTest pass or manual acceptance claim. Log `/tmp/aiden-skills-ios.log` and result bundle retained locally.

## Independent reviews

Two GPT-5.6 Sol medium reviews (blast radius/regressions; adversarial/edge cases). Fixed Telegram advertising model-only commands, Pi resource inclusion of user-only content, and Bot bounded-inventory crowding. Added matrix/resource, direct-loader, stale-policy, malformed YAML, collision and capacity regressions. Both final reviewers report no remaining actionable defect. Collision suggestion was withdrawn after checking the completed plan's single-winner contract. Telegram production mapping lacks a separate direct unit test; registry user catalog matrix and the full Telegram suite cover its inputs and dispatch. PR #214 implementation head `5ab368c17d103920f9010a1cb7cc4da5c9da808d`: hosted verify and deterministic Electron E2E passed; Pullfrog (Luna) completed with no new issues, also running 69 focused tests, Telegram210 and type-check. No unresolved review threads. Greptile review unavailable due to the account’s 50-credit trial limit. Physical iOS launch remains blocked as documented.
