# Design mode P4e: point, comment and send to Aiden

Status: in progress 2026-11-05 (owner approved P4a and said continue). Parent plan: [P4 the full canvas](2026-11-05-design-mode-p4-full-canvas.md). Spec: [design mode](../specs/2026-10-31-design-mode-design.md) §5.5 and §5.6. Branch: `claude/project-thread-29fzrr` (PR #778).

**Goal:** a person points at something on the canvas, writes what should change, and Aiden gets it as a scoped request. This is the core loop of design mode.

**Constraints:** behind `AIDEN_EXPERIMENTAL_DESIGN_MODE`; frames stay `sandbox="allow-scripts"` with no network; comments live in the canvas document (main-owned, revision CAS); the only thing written into a source file is a `data-aiden-comment` id, and only Aiden writes it; Aiden's design system; light and dark screenshots before approval.

## How it works

- **Comment tool (C).** A new toolbar button. In comment mode:
  - a click on a live page frame picks the element under the pointer through the bridge, and a pin with a comment box appears on it;
  - a click on any other frame drops a pin on that frame at that spot;
  - a click on empty canvas drops a free pin.
- **The comment box** says what it is attached to ("Hero › h1 "Ship faster""), takes the note, has a microphone that uses the existing voice input, and a **Send to Aiden** checkbox (on by default). Saving with it on queues the comment for Aiden; off, it stays a comment.
- **Pins** follow their frame when it moves. On a live page they follow their element: anchored (found by its comment id or an exact selector), stale (found again by a fuzzy score: selector 4, text 2, tag 1, up to 1 for nearness; 2 or more is a match) or lost (a ghost pin at the last place, "Element not found").
- **The tray** sits above the composer while comments are queued: "3 comments for Aiden" with **Send**, and each comment can be taken out. Queued comments also go with the next message the person sends. Either way the message carries:
  - a text attachment holding an `<attached-design-comments>` block (frame, file, selector, source stamp, comment id, note, and "Change only these elements unless told otherwise"), marked as the person's own words about untrusted page content;
  - a picture of each commented spot, taken when the comment was made, when the model takes images and room is left.
- **After sending**, comments turn "sent". When Aiden's turn ends and the page reloads, a sent comment whose element still anchors resolves. People can reopen a resolved comment.
- **All comments** opens a list from the toolbar with Open, Sent and Resolved filters. Choosing a comment brings its page and frame on screen and opens it.
- **Draw marks:** the comment box has a pen that draws marks over the frame. Marks are stored normalised to 0..1 inside their frame, or in canvas units for a free pin, and go to Aiden in the block and in the picture.
- **Aiden:** `canvas_read` lists the open comments on the page it describes. The `aiden-design` skill asks Aiden to add `data-aiden-src` stamps, to write `data-aiden-comment="<id>"` onto the element a comment is about, and to keep those ids when it edits.

## Tasks

1. **Comment core** (`renderer/shared/design-canvas/comments.ts`, pure): add, edit, delete, queue and unqueue, mark sent, resolve, reopen, apply an anchor report, the "attached to" label, the `<attached-design-comments>` block and the fuzzy score. Comment fields added to the schema as optional: `queued`, `sentAt`, `resolvedAt`. A frame comment's x and y are relative to its frame's top left, in canvas units. Tests with fixtures.
2. **Bridge v2** (`bridge-source.ts`): pick mode with a neutral hover outline drawn inside the page, `pick` (selector, text, tag, rect, nearest `data-aiden-src`, nearest `data-aiden-comment`), `locate` → `anchors`, and `highlight`. It accepts messages only from its parent. Tests run the script in happy-dom.
3. **Comment mode and pins** on the canvas: the C tool, picking on live pages, pins on frames and the canvas, the comment box (label, note, Send to Aiden, microphone), a crop of the spot kept in memory for sending, stale and lost states.
4. **Tray and sending:** the tray above the design-mode composer, queued comments added to the next send and the tray's Send, marking sent on success, nothing marked when the send fails.
5. **Resolution after reload**, and reopening.
6. **All comments panel** with filters and jump.
7. **Draw marks** in the comment box.
8. **Aiden:** comments in `canvas_read`, the skill and prompt text.
9. **E2E** in `tests/e2e/design-canvas.spec.ts` (pick an element on a live page, comment, send, see the block reach the fake model, resolve after an edit), docs (`docs/keyboard.md`, the spec, `.memory/design-mode.md`, the plans index) and light and dark screenshots.

Analytics (`design_comments_sent`) lands with the other design mode events in P5.
