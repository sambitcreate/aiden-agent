# Onboarding feature-tour art is drawn in code (2026-10-09)

Branch `feature/onboarding-images-redesign-9b7684`. The 28 AI-generated clay PNGs in
`renderer/assets/onboarding/` (10.5 MB) are gone, along with `npm run assets:onboarding`, its
optimizer script, and the `pngjs` devDependency.

## Why
The owner no longer liked the clay renders. They were also a fixed navy palette that ignored light mode
and the theme presets. Standard tiles showed them at 76 px, so their detail was lost. The ghost repeated in
26 of 28 images. Thinking Controls showed a brain, which AGENTS.md forbids. None of it could be edited
without regenerating the art.

## Decision
Five directions were mocked: Snapshot, Exploded (isometric), Line, Wisp (pastel and mascot), and Glyph.
The owner chose **Snapshot with Wisp colours**. Each tile is a stylized, cropped slice of the real surface
it introduces, tinted with one Bot avatar colour. The tint is mixed into the popover surface, so it follows
light, dark, and every preset. The mascot was not carried over.

## Shape
- `renderer/components/onboarding-feature-gallery.tsx` holds the tour data (`onboardingFeatures`) and the
  bento (`OnboardingFeatureGallery`), extracted from `onboarding-flow.tsx`. The tiles are `oa-tile` with an
  inline `--oa-tint`.
- The art lives in `renderer/components/onboarding-art/`:
  - `art-kit.tsx` has the primitives: `ArtWindow`, `Bar`, `ArtChip`, `ArtButton`, `ArtComposer`,
    `Radio`, `Toggle`, `DiffStat`, `TrafficLights`.
  - `feature-art.tsx` is the registry: feature id to `{ tint, Art }`. `FeatureArtId` is the tour's id
    type.
  - `create-art`, `extend-art`, and `control-art` (`.tsx` and `.css`) hold one vignette per tile, grouped
    like the tour.
  - `onboarding-art.css` is imported from `renderer/styles.css`. It holds the tint variables
    (`--oa-surface`, `--oa-fill`, `--oa-bar*`, `--oa-ink`) and the motion vocabulary (`oa-anim-*`).
- Rows grow to fit the longest hover description, so standard and tall tiles range from about 118 to
  270 px. Vignettes anchor top-left and run past a soft bottom fade.
- Motion is gated on `prefers-reduced-motion: no-preference` and `:root:not([data-reduce-motion="true"])`.
  Under Reduce Motion no animation is set, so the markup is the still pose. Thinking Controls reuses the
  real `AidenActivityMark`.

## Tests
`onboarding-flow.test.tsx` renders the gallery with `renderToStaticMarkup`:
- Every tile has its own art, with no orphans and no `<img>` or `url(`.
- Each tint comes from `BOT_AVATAR_COLORS`, and neighbouring tiles in a group never share one.
- The feature-copy assertions now read the rendered text, not grepped source.

## Native clients
- iOS matches (2026-10-09). The three onboarding pages draw native SwiftUI vignettes in the same Snapshot
  style, and the `OnboardingBuild`/`Extend`/`Control` imagesets are gone.
  - `ios/AidenOnTheGo/Features/Remote/AidenOnboardingArtwork.swift` holds `AidenMobileOnboardingPhase.artTint`
    (build lilac, extend periwinkle, control mint, matching the desktop `workspace`, `models`, and
    `schedules` tiles), `AidenOnboardingArtColors` (the `--oa-*` mixes over `AidenPalette.raisedHex` via the
    now-internal `Color.mixHex`), `AidenOnboardingArtMotion`, the `AidenOnboardingArtwork` tile, and the
    `OnboardingArt*` kit.
  - `AidenOnboardingVignettes.swift` has one view per page. Build shows the workspace chat with the
    Workspaces/Bots switcher menu and a file tree. Extend shows the composer's model menu by provider with a
    thinking-level submenu and a pending image. Control shows Scheduled Tasks with real
    `AidenScheduledTaskPresentation.cadence` labels and a Run Now/Pause/Edit card.
  - Each vignette is drawn on a fixed 300 × 220 pt canvas and scaled by
    `AidenMobileOnboardingLayout.artworkSize(for:)`, which caps the width at 320 pt. Only the visible page
    animates, on a `TimelineView` that is paused under system or in-app Reduce Motion and Low Power Mode.
    A page joins the loop at `AidenOnboardingArtMotion.entry`, its hold, so swiping in never collapses the
    art before it retypes.
  - `AidenOnboardingArtTests` covers distinct tints, 3:1 ink contrast and theme-following tiles in every
    preset, Reduce Motion and Low Power gating, the loop resting on the still pose, and an `ImageRenderer`
    pixel check of the tinted tile in light and dark.
- Android never used these images.

## Dev harness
A gitignored throwaway at `tmp/onboarding-art-preview.html` renders the real gallery through
`npm run dev:renderer`:
`http://127.0.0.1:4143/tmp/onboarding-art-preview.html?group=create|extend|control&scheme=light|dark&preset=<id>&motion=off`.
`npx playwright screenshot` against it works for headless review.
