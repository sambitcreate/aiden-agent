# Aiden design guide

## Reusable action shapes

Use the shared `Button` from `renderer/components/ui.tsx` for actions, including
icon-only controls and links rendered with `asChild`. Labeled and icon-only
buttons use the same soft squircle shape. Choose the existing size and variant
for emphasis; do not add a separate pill or circular button variant.

| Surface | Reuse | Geometry |
| --- | --- | --- |
| Buttons, toolbar actions, navigation actions, and button links | `Button`, or the shared action rule in `renderer/styles.css` for existing native buttons | `--radius-button: 16px` and `corner-shape: squircle` |
| A custom visual that must follow a button's silhouette, such as its artwork mask | `.squircle-control` | The same button radius and corner shape |
| Chat composer | `.composer-shell` | `--radius-composer: 40px` and `corner-shape: squircle` |

The renderer's action rule also covers existing `button`, `[role="button"]`, and
`[data-slot="button"]` elements, including the compact dictation window. Reuse
that rule instead of adding per-screen geometry. Radio indicators, checkboxes,
and switch tracks retain their recognizable selection shapes. Text fields keep
their existing field geometry and focus treatment.

Use native CSS geometry in the Electron renderer. Keep shadows on the shaped
element and preserve visible overflow for menus, badges, and focus rings. Apply
clipping only to an inner artwork mask that needs it, never to the whole action
or composer. No JavaScript path generation or new dependency is needed.

## Color, state, and accessibility

Reuse semantic surface, text, accent, status, and elevation tokens from
`renderer/styles.css` and `renderer/shared/appearance.ts`. Shape does not change
an action's meaning: primary actions retain their accent, destructive actions
retain their semantic treatment, and transparent actions gain a soft fill on
hover. Avoid decorative borders and outlines.

Preserve neutral `focus-visible` outlines on non-text controls, accessible labels
for icon actions, disabled semantics, and existing hit-target sizes. Text-entry
focus uses fill and caret changes without a new border or ring. Reuse existing
hover and press feedback and respect Reduce Motion; do not animate the corner
shape or add layout shifts.

## Verification

Check shared and custom actions in onboarding, the chat toolbar and composer,
queued-message dialogs, Settings, and compact windows. Exercise hover, keyboard
focus, disabled states, light and dark themes, narrow layouts, and overflow
menus. The interactive [element specimen](chatgpt-ui-element-specimen.html)
demonstrates the same geometry. Extend the button appearance contract and
Electron interaction tests when these rules change.
