# Transcript sticky headers, preparing stage, turn footers

Branch `feature/sticky-think-turn-footers`; plan `docs/plans/transcript-polish-sticky-headers-plan.md`.

- `ScrollArea` root sets `--scroll-area-sticky-top` = measured toolbar height. The var sits on the root, not the viewport or content div, because `renderer/main/chat-transition.test.tsx` source-greps the viewport `style={{...}}` and `data-scroll-content className="min-h-full"` verbatim.
- `.transcript-sticky-header` paints an opaque layered background (state var over surface var over `--color-background`). Hover and focus fills come from the CSS vars `--transcript-sticky-state`, not Tailwind `hover:bg-*`, since a Tailwind bg would replace the opaque base.
- `reasoningDisclosureLayout`: `preview` (automatic, bounded, tail-following) vs `full` (user-opened, no inner scroller). `useStickySectionCollapse` (`renderer/lib/sticky-section.ts`) restores the section position when collapsing from a pinned header.
- Pending tool steps read `Preparing <label>` (`ActivityLine.stage = "preparing"`); iOS/Android `line()` mirror it.
- `ChatMessage.turnStats` (`renderer/shared/assistant-turn-stats.ts`) is persisted on assistant messages only and aggregated in `llm-client` across all requests of a turn. It is not in the Remote projection, so mobile does not see it. `copyVisibleHistory` drops it; the footer falls back to timeline + model.
- Android unit tests here need `ANDROID_HOME=~/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@17`. No iOS simulator was available, so iOS XCTest runs in hosted CI.

- Review recovery: sticky-section and assistant-turn-stats regressions now run from pretest through test:transcript-polish, with explicit renderer-other CI lane assignments. Previously they appeared only in test:preflight and were absent from the CI source union.
