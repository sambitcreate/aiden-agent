# Aiden design guide

## Reusable action shapes

Use the shared `Button` from `renderer/components/ui.tsx` for actions, including
icon-only controls and links rendered with `asChild`. Labeled and icon-only
buttons use the same soft squircle shape. Choose the existing size and variant
for emphasis; do not add a separate pill or circular button variant.

| Surface | Reuse | Geometry |
| --- | --- | --- |
| Buttons, toolbar actions, navigation actions, and button links | `Button`, or the shared action rule in `renderer/styles.css` for existing native buttons | `--radius-button: 16px` and `corner-shape: squircle` |
| Window top-bar actions (sidebar toggle, history, chat tools, header menus) | `Button` with `variant="bar"` and `size="small"` | The same squircle at 28px: no fill at rest, list-hover fill on hover, list-selection fill while `aria-pressed`/`aria-expanded` |
| A custom visual that must follow a button's silhouette, such as its artwork mask | `.squircle-control` | The same button radius and corner shape |
| Joined actions, such as an action with a separate menu trigger | `.squircle-control.squircle-action-group` around direct `Button` children | 16px outer corners, square internal seams |
| Chat composer | `.composer-shell` | `--radius-composer: 40px` and `corner-shape: squircle` |
| Tool approval card above the composer | `.composer-shell` on the card, `.approval-well` for its code and note wells, `.approval-icon-tile` for the icon | The composer's 40px squircle; wells use the composer radius less the card's 16px padding; the icon tile is a 14px squircle |

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

## Approval card

A tool approval reads top to bottom as one centered question: an accent icon
tile, the action as a plain question ("Run this command?", "Edit forecast.ts?"),
the exact request in a monospaced well, one quiet line under it ("Aiden is
paused until you choose.", or the file and its size of change), and two equal
large buttons. Deny is the filled neutral action and keeps initial focus; Allow
once is the accent action. When the host offers remembered scopes, Allow once
becomes a joined action whose chevron menu lists **Allow for this chat** and
**Always allow in this workspace**, each with one line on what it covers: a
command rule covers only that exact command, but a file rule covers any later
edit (or write) to that file, whatever it changes, so the line says so. A
file change shows removed and added lines on the soft red and green status
fills, with screen-reader labels instead of relying on color. Specialized
approvals (scheduled tasks, subagent grants, form fills, classifiers) keep their
own review bodies inside the same card. The iPhone and Android cards use the
same layout and wording; they show the approval summary instead of a diff,
because phones never receive tool arguments. A long request folds behind
**Show all**, and once expanded it scrolls inside a bounded well, so Show less
and the buttons stay on screen when the card sits in a non-scrolling footer.

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

Solid fills that carry a label or glyph use the `--fill-accent*` and
`--fill-danger*` pairs (`bg-fill-accent text-fill-accent-foreground`): primary
and destructive buttons, highlighted menu rows, checked switches, checkboxes and
radios, and send buttons. The hue moves toward black just enough for white
content to reach WCAG AA (4.5:1). Light presets already pass and keep their
accent, dark presets deepen, and a white accent (Monochrome) keeps black content.
Hover and press stay visible even on a pure black or white fill. iOS
(`AidenSolidFill`) and Android (`AidenPalette.accentFill`/`dangerFill`) use the
same rule and values. Keep `--accent`
for dots, bars and other non-text marks, and use `text-accent-text` when the
accent colors text (links, inline actions): it is corrected to stay readable on
every surface and on hovered or selected rows. A highlighted menu row turns all of
its content, including icons and secondary labels, to the row's foreground;
destructive rows highlight with the danger fill rather than the accent.

Preserve neutral `focus-visible` outlines on non-text controls, accessible labels
for icon actions, disabled semantics, and existing hit-target sizes. Rings are
for keyboard navigation only: after a click, `renderer/lib/input-modality.ts`
marks `<html data-input-modality="pointer">` and every ring is hidden until the
next navigation key, so style rings with `:focus-visible` and never on `:focus`
or hover. Text-entry
focus uses fill and caret changes without a new border or ring. Reuse existing
hover and press feedback and respect Reduce Motion; do not animate the corner
shape or add layout shifts.

## Loading and optimistic updates

Reads follow the cache-first rule ([plan](plans/cache-first-loading-states-plan.md)):
saved or last-known data renders at once and revalidates underneath, shaped
skeletons appear only on a true first read with nothing saved, an empty state
only once the read has settled, and connection status stays quiet. Reads never
show indeterminate spinners.

Writes follow the instant rule ([plan](plans/instant-ui-optimistic-updates-plan.md)):
a tap changes the screen before the round trip. Rename, toggle, send, resume,
dismiss and list edits apply to the local cache or view first and settle when
the host answers; a failure rolls the row back and shows one toast or inline
error, never a second confirmation. Sends show a pending echo keyed by one
idempotent request id that is kept across a retry. Navigation never waits for
the network: open from the cache or from the create receipt and refresh behind
the new screen. Destructive actions that cannot be restored keep a pending label
(Delete Bot, Remove workspace) until the host confirms; rows that can be
restored are removed at once and put back on failure. Feature gates on phones
read the pairing's saved `/server` features until the connection answers.

## Activity marks

Show agent activity with the shared activity marks (`AidenActivityMark` on desktop), never with new spinners, canvas loops or shimmering icons. Geometry, timing and the phase mapping live in [`activity-marks.md`](activity-marks.md), and iOS and Android draw the same marks natively. Chat marks use the text colour, and Live uses the accent. Pass `active={false}` for terminal states so the mark freezes on its still pose rather than disappearing.

## Verification

Check shared and custom actions in onboarding, the chat toolbar and composer,
queued-message dialogs, Settings, and compact windows. Exercise hover, keyboard
focus, disabled states, light and dark themes, narrow layouts, and overflow
menus. The interactive [element specimen](chatgpt-ui-element-specimen.html)
demonstrates the same geometry. Extend the button appearance contract and
Electron interaction tests when these rules change.
