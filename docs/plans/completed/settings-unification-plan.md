# Unified settings and workspace presentation

Status: Complete — implemented, reviewed, and delivered in PR #97 (2026-09-06).

## Scope

1. Hide workspace folder labels by default. Add persisted Appearance controls to show paths and choose beginning/end, last folders, or beginning truncation. Apply consistently to workspace navigation while retaining useful branch and no-folder identity.
2. Fit Personal Model Pad to its actual available width and height, including narrow/short windows, browser panels, and zoom. Keep all controls reachable by scrolling when the window cannot contain the entire page.
3. Add a global Skills switch with authoritative runtime enforcement for configured and discovered skills, stale invocations, and chat entry points. Preserve individual skill choices. Explain the control during onboarding.
4. Use Appearance's page hierarchy, soft grouped cards, inset row separators, spacing, and right-aligned controls across Settings. Preserve input focus behavior and visible keyboard focus. Align Telegram switches to the right and correct misleading setup copy.
5. Use an SD-card icon for Memory and remove brain glyphs elsewhere.

## Validation and delivery

- Extend configuration, path formatting, runtime skill enforcement, settings accessibility, and responsive layout tests; register new suites.
- Inspect both native clients for shared skill behavior and run applicable focused mobile suites.
- Run type checks, relevant tests, build, and an Electron settings size matrix. Record environmental limits and workflow friction.
- Request three independent fresh-context GPT-5.6 Sol reviewers at medium effort: adversarial runtime/security, edge cases/responsiveness, and integration/accessibility/regression. Fix validated findings and rerun affected checks.
- Create a PR in sambitcreate/aiden-agent. Have a fresh GPT-5.6 Luna reviewer at max effort watch CI; fix failures until all required checks pass.
- Update project memory and archive this plan after delivery completes.

## Implementation and verification

- All five scope items are implemented. Settings uses shared page, group, row, and semantic token conventions documented in `docs/settings-design-system.md`.
- Workspace paths are opt-in, persist across relaunch, support all three formats, and preserve grapheme clusters and meaningful whitespace. Duplicate workspace names retain distinct short IDs when paths are hidden.
- Model Pad uses measured available space. Electron coverage includes 390–1440px widths, short windows, 125%/150% zoom, open model/insight panels, keyboard movement, and saving. A 160px minimum canvas remains scrollable in very short windows.
- Global Skills enforcement covers discovery, tools, stale attachments, queued Telegram commands, existing chat journals/compaction, and Bot runtime grants without erasing saved choices. An Electron provider-boundary test verifies hidden skill instructions are absent from the next request after disabling Skills.
- Three fresh-context GPT-5.6 Sol medium reviews covered runtime/adversarial behavior, layout/edge cases, and integration/accessibility. Confirmed findings were fixed and regression-tested; runtime re-review reported no remaining actionable findings.
- Final local checks passed: full `npm test`, production build, lint, renderer and E2E type checks, focused runtime/settings/onboarding suites, existing model-picker E2E, new settings E2E, and responsive Model Pad E2E. Android's 12 focused Bot contract tests passed. The iOS test bundle compiled, but execution was blocked because both connected physical iPhones were locked; repository policy prohibits simulator fallback.
- PR [#97](https://github.com/sambitcreate/aiden-agent/pull/97) is open. Initial CI passed main verification, native/iOS compilation, Android, and release contracts. Full Electron CI exposed duplicate group headings and an outdated workspace selector, now fixed with stronger heading coverage. Model Pad reachability now retries scrolling through layout settlement and checks the actual scrollport with diagnostic bounds. All affected local Electron checks passed; fresh CI is pending.

## Additional PR review remediation

- The corrected UI revision `6278ff4de` passed all CI checks, confirmed by the GPT-5.6 Luna max watcher.
- Repository automated review then identified operator-compaction and additional Bot-catalog paths. Manual LLM/VCC compaction now uses visible-only history while Skills is disabled, and disabling cancels active operator compactions. Real journal/provider tests verify no hidden skill payload or cancelled checkpoint.
- Bot catalogs pause discovery and incarnation reconciliation. Saved exact skill bindings survive disabled reads, unrelated edits, restart, and re-enable; real content changes still fail closed. Targeted editor catalogs and authenticated dormant chat-selection entries preserve saved choices without granting new skills.
- The additive optional catalog `skillsEnabled` field is documented in the normative API/OpenAPI and shared fixtures. Desktop, iOS, and Android preserve saved choices while still preventing unavailable additions and rejecting malformed flags. Android14 focused tests passed, iOS generic app/test compilation passed, and an independent source review found no actionable concerns. Physical iPhone13 execution remains blocked by the lock screen.
- Focused remediation suites, full local tests/build/E2E, lint, type checks, and implementation CI passed after all fixes; see Delivery below.

## Delivery

PR [#97](https://github.com/sambitcreate/aiden-agent/pull/97) contains the completed implementation. Full local tests, production build, lint, type checks, and Electron E2E passed after all fixes. The CI workflow and Release consumer contract passed for implementation revision `4ad6e5ec1`, confirmed by the requested GPT-5.6 Luna max watcher. The final archive-only revision is tracked by the PR’s live checks. iOS physical execution remains the explicitly recorded device-lock limitation.
