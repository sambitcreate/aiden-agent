# Chronological Chat Motion

Status: Implemented locally; PR and visual acceptance pending.

## Objective

Show readable Thinking, tool activity, later Thinking, and assistant prose in the order Pi produced them. Keep one active status at the transcript tail and avoid scroll or disclosure jumps while a turn streams.

## Contract

- Version 3 thinking steps may carry UTF-16 offsets into the separately displayable reasoning string. In-progress steps may omit the end; settled steps with a start require an end.
- The canonical terminal Pi assistant message determines final public reasoning positions. Non-assistant `message_end` events cannot reconcile assistant spans.
- Invalid readable spans use the legacy single-disclosure presentation. Hidden Pi thinking stays in sequence as a timed status without exposing its content.
- Desktop and native views use stable chronological rows. Existing v1/v2/v3 histories without offsets still replay.
- The active phase uses one status surface. Approval, Stop, and first feedback are immediate; transient routine phase changes may wait 120 ms. Reduced motion skips the delay.
- Regular-chat Remote history can include at most 100,000 UTF-16 code units of already displayable parent reasoning per message. Optional reasoning is removed to stay within the whole response limit. Bot history never includes it.

## Delivery

1. Main-owned reasoning spans, canonical reconciliation, retries, detached reset, validation, and focused tests.
2. Desktop chronological rows, stable disclosures, single status presentation, bounded reveal scheduling, and coalesced bottom-following.
3. Remote history projection and schema, iOS and Android decoders, chronological live and persisted views, and native tests.
4. Desktop, Remote, iOS, Android, and Electron validation; two independent adversarial reviews; PR checks and review comments to green.

## Acceptance

A turn that goes Thinking → tool → prose → more Thinking → answer stays in that order while streaming, after persistence, and after reconnect. Older histories remain legible. The user can scroll away without being pulled back, and manual disclosure choice survives later deltas. Device visual acceptance remains separate from automated tests.
