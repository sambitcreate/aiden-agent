# Todo chip transcript clearance — 2026-09-24

The floating todo chip sits above the composer footer, while `ScrollArea` previously reserved only the measured footer height. At the bottom of a chat, the final transcript row could therefore remain under the chip.

`ScrollArea` now accepts an additional bottom content offset. ChatPane supplies 56 px only while todo chrome is visible: 44 px for the existing chip placement and 12 px of breathing room. The scroll-area layout effect follows the new bottom synchronously when the user was already there. The scroll-to-bottom button retains its 44 px offset. No persisted todo or native contract changes.

Verification: 101/101 focused todo tests, TypeScript type-check, scoped ESLint, and Vite renderer build passed. The focused test covers the snapshot visibility matrix, chat wiring, and rendered scroll-area padding. Installed-app visual acceptance remains separate from local build verification.

PR review follow-up: renderer preflight had a strict source assertion for the old one-line padding style. Its contract now checks the additive, clamped scroll clearance while preserving the toolbar and footer assertions. The focused todo suite alone did not cover this shared component contract.
