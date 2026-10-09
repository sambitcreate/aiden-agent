# Activity marks replace thinking orbs (2026-10)

Branch `feature/aiden-thinking-animations-263534`. The `thinking-orbs` canvas package (desktop) and its
vendored ports (iOS `ThinkingOrbsKit`, Android `thinkingorbs`) are gone. All three clients now draw
**activity marks**, small vector animations specified once in `docs/activity-marks.md`.

## Why
The orbs redrew a projected 3D dot cloud every frame: a 2D canvas plus rAF loop on desktop (and a
full-canvas CSS colour filter on Live), a 30 fps `TimelineView` Canvas on iOS, and per-frame
recomposition with O(n²) work on Android. The owner wanted animations that are cheap on GPU and CPU.

## Shape of the change
- Chosen set (owner pick from `docs/aiden-thinking-animations.html`): `tri-step` (thinking),
  `quad-shuffle` (tool work), `compose` (responding), `scan-grid` (searching/visualizing), `glance`
  (waiting for approval/answer), `bounce` (preparing/loading/stopping/queued). Live uses the Helix
  family (`helix-calm` frozen when ready, `-twist` connecting, `-swell` listening, `-duplex` talking,
  `-flat` unavailable) plus `glance` for approvals.
- Desktop: `renderer/components/aiden-activity-mark.tsx` (inline SVG) + `.aiden-mark` CSS in
  `renderer/styles.css`. `AgentActivity.mark` replaces `orbState`. `SubagentMark` / `AidenLiveMark`
  replace `SubagentOrb` / `AidenLiveOrb`.
- iOS: `Features/Shared/ActivityMarks/` (CAShapeLayer + CAKeyframeAnimation).
  Android: `features/shared/activitymarks/` (Compose Canvas, frame clock read only in draw).
- No wire or protocol change: every client derives its mark locally from its own activity state.

## Invariants
- Only translation, rotation, scale and opacity animate. No filters or per-frame allocation.
- Inactive, Reduced Motion (system or in-app) and off-screen marks freeze on the t = 0 pose; never
  hide them instead.
- Desktop phase offsets are inline `animation-delay`s, not CSS custom properties. The xmldom-mounted
  tests can't set custom properties, and this avoids per-shape style variables.
- When a mark's geometry or timing changes, update `docs/activity-marks.md` and all three clients together.

## Cross-platform parity notes (review of the native ports)
- Duplex strand b fades per circle (SVG `fill-opacity`; iOS fill alpha; Android per-draw alpha), never as a group.
- Helix · Flat's 45% composites once (CSS group opacity, CALayer opacity, Compose `graphicsLayer`), so its stacked strands don't darken.
- Swell's second wave adds to the braid and is not scaled by depth (desktop wraps each circle in a `<g>`).
- Search tools match whole name segments (`find|glob|grep|list|read|search` split on `_ : -`) on every client.
- Finished tool/subagent marks freeze rather than keep animating.
- Desktop inline delays are wrapped into (−D, 0] so tracks start mid-cycle like native `(t − d) mod D`.
  A positive CSS delay means a startup wait, which gives the wrong frozen pose.
- The app-wide `:root[data-reduce-motion="true"] *` rule (0.001ms, one iteration) excludes `.aiden-mark`.
  Marks freeze via `animation-play-state: paused` instead, which keeps their t = 0 pose.
