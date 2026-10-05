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
| Joined actions, such as an action with a separate menu trigger | `.squircle-control.squircle-action-group` around direct `Button` children | 16px outer corners, square internal seams |
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

Joined actions reuse the group rule instead of per-corner utility overrides.
Their individual hover and focus fills meet at straight seams, while the group
and its end buttons share the outer squircle. Leave the group overflow visible
so each button's keyboard outline and portaled menus remain unobstructed.

## Untitled structure

Aiden adopts the structural layer of the Untitled theme (`GUI.md`, `gui/`) while keeping its own radii and preset palettes:

- **Motion.** Controls, menus, and popovers use `--motion-duration` (200ms) with `--motion-easing`; popovers enter from `--motion-popup-scale` (0.96). Shared buttons settle by `--motion-press-distance` (1px) while held. Tailwind exposes the curves as `ease-standard` and `ease-emphasized`. Shared dialogs keep their deliberate near-instant entrance and the sidebar keeps its 300ms width timing with the emphasized curve. Every motion is removed under Reduce Motion.
- **Surfaces.** Cards, sheets, popovers, and floating panels have no outline: fill and the existing elevation tokens define their edge. Inset row separators and header separators remain.
- **Fields.** Inputs, textareas, and select triggers rest on the `--surface-input` fill with their neutral resting border; focus deepens the fill to `--surface-control`. No accent border or ring.
- **Buttons.** Labeled buttons use roomier horizontal padding (12/16/20px for small/medium/large) at the existing heights.
- **Type.** Text tokens follow Untitled's step ratios anchored to the UI font-size preference (at 14px: mini 10/14, small 12/16, regular 14/20, large-strong 16/24, heading1 24/32; heading2 stays 18/24).

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
