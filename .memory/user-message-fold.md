# User message bubble: wrapping, folding, copy (2026-10-27)

- `UserMessageBody` in `renderer/components/message-bubble.tsx` renders every sent prompt (local chats, Bot chats, remote chats, the draft worktree view).
- Wrapping uses `overflow-wrap: anywhere`, not Tailwind `break-words`. `break-word` does not lower the min-content width, so one unbroken token (an API key, hash, URL) made the content-sized, right-aligned bubble wider than its 80% column and it spilled left under the sidebar. Assistant prose is unaffected because its container is `flex-1 min-w-0`.
- Folding: `renderer/lib/user-message-fold.ts`. Six visible lines; folds only when at least two more would hide (8+ lines). First paint guesses from length (>320 chars) or hard lines; a `ResizeObserver` on the body then measures `scrollHeight` against the computed line height. Observation only, so rows the transcript defers with `content-visibility: auto` are not force-laid-out.
- CSS `.user-message-fold` in `styles.css`: `height: calc(var(--user-message-fold-lines) * 1lh)` with `interpolate-size` for the height transition, `overflow: clip`, and a mask fade (not a colour gradient, because the Bot queued bubble mixes its own fill).
- The chevron button has `aria-expanded`/`aria-controls`; focusing a link in the hidden tail expands. Clicking the bubble never toggles (text selection). Collapsing while the bubble's top is above the scroller scrolls it back to its top.
- Copy is a `CopyButton` absolutely positioned at the bubble's top-right, shown on `group-hover/bubble` or `group-focus-within/bubble`. It copies the full prompt. The user branch honours `showCopy`, so Bot rows (which have their own message menu Copy) no longer show two.
- OpenCode had a similar fold (64px, chevron, top-right copy) and removed it in its Feb 2026 turn rework; it now shows copy in a hover meta row below the bubble.
- Desktop only: iOS and Android do not fold user messages (iOS has `AidenApprovalFoldingText` that could be reused for parity).
- Tests: `renderer/lib/user-message-fold.test.ts`, `message-bubble.test.tsx`, and e2e `chat-shell-interactions.spec.ts` "a long prompt wraps inside its column…".
