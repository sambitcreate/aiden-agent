# Transcript polish: sticky section headers, preparing tool stage, turn footers

Status: Complete — merged in [PR #269](https://github.com/sambitcreate/aiden-agent/pull/269) on 2026-09-28 and shipped in 0.51.0. The mobile and live-streaming footers remain follow-ups. Source: the DeepSeek transcript research page, items on sticky reasoning headers, tool-call staging and per-turn metadata.

## Goals

1. **Sticky Thinking and compaction headers.** When a reader opens a long Thinking disclosure or an activity/compaction trail, its header stays pinned just below the chat toolbar while the body scrolls past, so it can be collapsed from anywhere.
2. **Preparing stage for tool calls.** A tool call whose arguments are still streaming (timeline step status `pending`) reads as `Preparing <tool>` instead of claiming the work has started (`Reading src/app.ts`).
3. **Per-turn footer.** A settled assistant response shows a quiet one-line footer: duration, model, and provider-reported tokens (`12s · claude-sonnet-4-5 · 12.4k in · 830 out`) when known.

## Design

### Sticky headers

- `ScrollArea` publishes `--scroll-area-sticky-top` (the measured toolbar height) on its root, so sticky descendants rest below the overlaid toolbar. Nested scroll areas re-scope the variable.
- `.transcript-sticky-header` (in `renderer/styles.css`) is `position: sticky` with an opaque layered background made of a state fill (hover and focus-visible) over the surface token (`well` for Thinking) over `--color-background`. Scrolled text never shows through, and hover and focus stay legible while the header is pinned. The rule adds no borders and uses no new colors.
- Thinking disclosure layouts (`reasoningDisclosureLayout`):
  - `collapsed`: the disclosure is closed.
  - `preview`: the automatic one-second streaming preview. It keeps the bounded, tail-following, keyboard-scrollable viewport.
  - `full`: the reader opened it deliberately. The reasoning flows at full height in the transcript, so the sticky header becomes useful and there is no cramped nested scroller.
- Collapsing from a pinned header scrolls the section back to its resting position under the toolbar (`scroll-margin-top`). The scroll is instant (`behavior: "auto"`), so there is no motion for reduced-motion users or anyone else.
- Activity trails, including compaction trails, use the same sticky `<summary>` when open.

### Preparing stage

- `activityLine` returns `{ verb: "Preparing", object: label, stage: "preparing" }` for `pending` tool steps. The row keeps the live shimmer, which reduced motion already suppresses globally. Rows expose `data-activity-stage="preparing"`.
- Native parity: iOS `AidenAgentActivityPresentation.line(for:)` and Android `.line(step)` now return `Preparing <label>` for pending steps. This required no Remote contract change, because the step status was already projected.

### Turn footer

- New persisted, content-free `ChatMessage.turnStats` (`AssistantTurnStatsV1`) on assistant messages, with fields `version`, `startedAt`, `finishedAt` and optional `usage` (input, output, cacheRead, cacheWrite, total, requests). Usage is summed across every model request in the turn, including tool loops.
- `llm-client` aggregates `reportedTokens(message.usage)` at each assistant `message_end` and writes `turnStats` alongside the final message.
- `chat-store-core` replays it through a strict parser (`parseAssistantTurnStatsV1`). A malformed record, or one attached to a non-assistant message, is dropped whole.
- The renderer footer (`TurnFooter`) sits at the trailing end of the message-actions row. It carries a single screen-reader sentence ("Response details: …") and a hover title. Token usage is omitted when unknown or zero. Duration falls back to a settled timeline for older messages.
- Remote/mobile: the Remote chat projection whitelists message fields, so `turnStats` does not reach mobile clients and no protocol revision is needed.

## Follow-ups

- Mobile turn footer (requires a Remote projection field and contract revision).
- Live footer while streaming (elapsed timer).
- Sticky headers inside subagent detail views.
- A Playwright check of the pinned-header geometry in a long transcript.
