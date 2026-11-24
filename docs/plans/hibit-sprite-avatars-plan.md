# Hi-bit sprite Bot avatars

Written 2026-11-24. The owner chose **Sprite · Hi-bit** after a round of avatar studies. It is now the only Bot avatar direction (Figma file `iUQn8UF5HHe3Esli4wIgsd`, page 32:2, section 106:2435). This plan replaces the eight smooth "semantic" avatar bodies with Hi-bit pixel sprites, on desktop, iOS and Android together, in one PR.

**Status:** in review (2026-11-24). Desktop, iOS and Android are implemented on `claude/hibit-sprite-avatars`, and the final review round's fixes are in.

## Decisions

- **No new record or protocol revision.** The saved avatar stays `{ version: 1, shape, color }`.
  - Each of the eight existing shapes (`wisp`, `orb`, `drop`, `hex`, `cloud`, `peak`, `squircle`, `capsule`) now names one fixed, curated Hi-bit body.
  - `color` still picks one of the twelve tints.
  - Every saved Bot keeps its identity, and older phones keep reading the same fields.
- **The canonical photo still wins.** A Bot with a generated or uploaded photo shows the photo, as today. The sprite replaces only the drawn fallback.
- **Sprites stay pixel-exact.** No rotation, no anti-aliased edges, and no smoothing when scaling. Motion moves in multiples of 0.75 units on the 48 viewBox (a quarter cell), or changes opacity. Only the waiting breathe uses −0.75. Rig, row and prop motion otherwise moves in half-cell steps of 1.5. The per-state look offsets below are still glances held for the whole state, not motion.

## The shared spec: `botAvatarSprite` in `protocol/aiden-remote/v1/fixtures/contract.json`

The reference prototype generated this section. It is the single source of truth, and each platform keeps its own copy of the body strings and tones, tested against it.

- `bodies[shape]` is 12 rows of 6 half-columns, separated by `/`. The columns are mirrored, and the cell values are:
  - `1` = body
  - `2` = outline
  - `0` = empty
- `tones[color]` holds the precomputed hex colours:
  - `tint`: the body
  - `shade`: the outline
  - `deep`: the eyes and happy/wince strokes
  - `light`: highlight cells and the full-size eye glint
  - `markLight` / `markDark`: the state props (thought dots, plug, cursor) in light and dark appearance
- `smallMaxPx` (24) is the largest rendered size that draws the small cut.
- `smallGlintHex` (`#FFFFFF`): the small-cut glint fill.
- `grids[shape].full` and `grids[shape].small` are the expected 16×16 expansion, one string per row:
  - `.` = empty
  - `o` = outline (shade)
  - `b` = body (tint)
  - `h` = highlight (light)
  - Every platform's expansion function must reproduce both grids exactly.
  - The test parses the fixture and compares; it does not copy the algorithm into the test.
- An earlier draft also carried the prototype's `template` rows. No client read them, so they were removed.

### Expansion (what each platform implements)

1. Start with two 16×16 boolean grids, B (body) and O (outline).
2. Place the body rows. For row `ry` (0–11) and half-column `h` (0–5), set `y = ry + 2`, `xl = 2 + h` and `xr = 13 − h`.
   - A `1` sets B at both `xl` and `xr`.
   - A `2` sets O at both.
3. Auto outline: every empty cell (not B) with a 4-neighbour in B becomes O.
4. Drop every O cell that has no 8-neighbour in B.
5. Highlight: a B cell is `h` when there's no B cell directly above it and `y < 9`, but only at sizes above `smallMaxPx` (24 px). At 24 px and below every B cell is `b`. This is the "small cut".
6. Draw cell `(x, y)` as a 3×3 square at `(3x, 3y)` on a 48×48 viewBox.

### Face

- Two eyes at x = 15 and x = 27, y = 18.
  - Full size: 5×6 at x + 0.5 in `deep`, with a `light` glint square at the eye's top-left, sized 0.42 × min(w, h).
  - Small cut: 6×6 in `deep`, with a white `#FFFFFF` glint (`smallGlintHex`) at the eye's top-left, sized 0.42 × min(w, h). The glint shows only while the eyes are open.
  - Eyes are `deep` at every size and in every pose. The open poses (idle, thinking, reading, tool, writing, editing, waiting) keep the glint, including the narrowed reading (lid 0.78) and editing (lid 0.5) eyes and the waiting eyes scaled 1.14.
  - The glint rides with the eye under the lid, so the blink's shut frame (lid scaleY 0.08) closes it too. Happy and wince eyes have no glint.
- Happy eyes (done): a `^` chevron stroke per eye, from `(x + sw/2, y + 0.78h)` to `(cx, y + 0.2h)` to `(x + w − sw/2, y + 0.78h)`.
- Wince eyes (error): a `>` `<` pair. The left eye points right, the right eye points left: `M x0 (y + sw/2) L x1 (y + h/2) L x0 (y + h − sw/2)`.
- Stroke width `sw` is 1.6, or 2.4 at the small cut. Strokes use square caps and miter joins in `deep`.

### State props (`mark` tone: `markLight` in light appearance, `markDark` in dark)

- **Think dots:** three 2.6×2.6 squares at x = 36 + i·3.9, y = max(0.5, top·3 − 4). `top` is the first grid row with any B or O cell.
- **Plug arm:** a 4.5×3 rect at (42, 27) in `shade`, plus a 3.3×5.1 `mark` rect at (42 + 4.5 − 0.6, 27 − 1.05).
- **Cursor:** a 2×8 `mark` rect at (45, 16.5).

## States

| State | Source on each platform | Still pose (Reduce Motion, and where every animation starts and ends) | Motion (≤ 1.2 s loop, transform and opacity only, stepped) |
|---|---|---|---|
| idle | nothing running | eyes open | blink: lid scaleY 1 → 0.08 → 1 shut from 97% to the end of a 6 s loop |
| thinking | reasoning / thinking stream | look offset (+1.05, −1.19); think dots visible | rig bob 0 → −1.5 at 50% (step), dots fade 0.25 → 1, staggered 0.3 s |
| reading | read / grep / find / ls / fetch / search tools | look (−1.12, +0.63); lid scaleY 0.78 | a row-by-row scan: cell opacity 1 → 0.42 → 1 (step), delayed by (y div 2) × 0.11 s on a 1.1 s loop |
| tool | MCP or any other tool | look (+1.54, 0); plug visible | plug slides in: x −4.5 → −1.5 → 0, holds, then −3 (step), 1.2 s |
| writing | assistant text streaming | look (0, +1.19); body (non-outline) cells opacity 0.92 | typing: body cell opacity 0.35 → 0.92, delayed by (x div 2) × 0.15 s (step), 1.2 s; outlines stay at 1 |
| editing | edit / write / apply-patch tools | look (+0.84, +0.49); lid scaleY 0.5; cursor visible | cursor blink: opacity 0.35 ↔ 1, 1 s step |
| waiting | an approval or question card is waiting for the person | open eyes scale 1.14 | breathe: rig 0 → −0.75 at 50% (step); blink shut from 97% to the end of a 2.4 s loop |
| done | a turn that finished normally (not a Stop or pause) | happy eyes | once: hop 0, −3, −4.5, −1.5, 0 over 0.6 s; then idle after about 1.5 s |
| error | a failed turn, an interrupted session, or a Bot with no usable model | wince eyes; rig +1.5 down; odd-pair rows shifted +1.5 in x | once: the odd-pair rows glitch −3, +3, −1.5, +1.5 (a quarter of 0.52 s each) while the rig drops in Y only, 0 → +1.5 (step) at 260 ms; the whole body never shakes sideways; then idle after about 1.5 s |

### Mapping and endings (all platforms)

- **Phases.** A running turn maps its live phase: preparing, thinking, tidying, resuming, reconnecting and stopping → thinking; reading, photo and searching → reading; command, app, helper, computer, remembering, routine and working → tool; editing → editing; writing → writing; waiting → waiting. A running turn with no known phase (a sidebar row, which only knows the session) is thinking. Anything waiting on the person wins over the phase.
- **Endings.** A Stop or a pause settles quietly: straight to idle, with no done or error moment. A failed turn, an interrupted session or `needs_model` gives error. Only a turn that finished normally gives done.
- **Failed and stopped turns on desktop.** The chat pane reads them from the newest transcript entry (`failed_turn`, an aborted reply, or a stopped tool result). Sidebar rows read the same signal from the live summary's `lastTurnEnd`, so they need no transcript. A failure reported just after the turn ended turns the done moment into error, and a session that failed after a Stop still shows its error. The desktop treats `model_error` as a failed session; phones never receive it.
- **Timing.** Done and error appear at once, with no debounce; only working states wait about 250 ms. A turn that ended before any working pose showed settles quietly, and so does a card the person answered while no turn was running.
- **Phones.** Home rows never show done: phones get only the session state, `needsYou` and `lastReplyAt`, so a Stop or a failure can't be told from a normal end without a wire change. A normal end settles to idle quietly, and an `interrupted` or `needs_model` session shows error. An ordinary failed turn also looks like a normal end there, so it settles to idle. Done shows in the phone chat header only.
- **Idle.** Idle avatars on phones and in the desktop chat header are static, with no blink; the header animates only while its Bot works or has a done, error or waiting moment. Desktop sidebar rows and the pinned card are static at idle too, and blink only while waiting.

The "look" offsets are the prototype's per-state values × 0.7, which is the Sprite family's `--g`. Each platform's state mapping reuses the activity signal that already drives its "working" indicator. Changes are debounced by about 250 ms so fast tool bursts don't flicker. Reduce Motion (`prefers-reduced-motion`, `accessibilityReduceMotion`, `aidenReduceMotion()`) shows the still pose only. Avatars that are offscreen or in lists that don't show activity stay idle and don't animate.

## Where states show

- Animated: the chat header avatar of a Bot while it works or has a done, error or waiting moment (static at idle), the Bot's sidebar row and pinned card while it runs or needs the person, the phone home rows, and the Bot computer tab's face, which shows the tool pose while the Bot drives its computer.
- Everywhere else (pickers, onboarding art, small list rows), the avatar is static idle.
- The editor's shape picker shows the eight sprite bodies in the selected tint.

## Out of scope

- New body variety beyond the eight curated bodies (a seed-per-Bot genome is a later, protocol-visible change).
- Changing the canonical photo pipeline.
