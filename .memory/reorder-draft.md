# Reorder draft (UI SDK lessons Unit 7) — 2026-11-19

`renderer/lib/reorder-draft.ts`, ideas from the Vercel Labs UI SDK `foundation/drag-and-drop` (reorder.ts, draft-move.ts, auto-scroll.ts, pointer.ts); nothing imported.

- Pure model: `pickUp`, `stepDraft`/`moveDraftTo` (clamped), `draftChanged`, `reorderKeyAction` (Space/Enter pick or drop, arrows by orientation with RTL swap for horizontal, Home/End, `isEscapeKey` cancel; modifier keys ignored so ⌥↑ aliases keep working), `reorderMessage` (reference wording), `arrangeByDraft` (lays a list out in draft order, leaving non-members in place), `pointerDropTarget`, `edgeScrollVelocity` (48px band, 18px/frame).
- `useReorderDraft({ groupOf, label, onCommit, handle })`: draft in state; `onCommit(order, id)` once per changed drop; focus re-set on the handle in a layout effect after each move/drop/cancel (DOM moves can blur). Blur cancels only if, after a 0ms timeout, focus is really elsewhere. A group change under the draft (card added/removed) drops it quietly. Keys it handles get preventDefault + stopPropagation, so Escape doesn't also close Quick View (layer stack checks defaultPrevented).
- `ReorderAnnouncer`: one assertive `role="status"` region; no shared announce helper existed in the repo.
- `usePointerReorder({ targets, onDrop, scroller })`: window listeners, capture after 3px, rAF-batched measure + auto-scroll, `buttons===0` cancels, Escape (window capture) cancels, the click after a drag is swallowed. Used by Layers only; Quick View keeps its own sliding grip drag.
- Consumers: `QuickViewCards` (environment-panel.tsx), `LayersTab` (design-side-panel.tsx; groups = same parent + same container-ness, matching `reorderLayer`'s sibling rule).
- Tests: `renderer/lib/reorder-draft.test.tsx`, `renderer/design/design-side-panel-layers.test.tsx`, Quick View keyboard tests in `quick-view-cards.test.tsx`; e2e in quick-view-cards.spec.ts and design-canvas.spec.ts.
