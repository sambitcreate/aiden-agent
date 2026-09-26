# Type-to-focus composer and Command-hold chat shortcut hints (PR #128, 0.50.0)

- `renderer/lib/composer-type-focus.ts` decides whether a document keydown should focus the chat composer (and insert the printable key). The hook `use-composer-type-focus.ts` runs it in capture phase; only `ChatPane` mounts it (`enabled` is false while an ask-user questionnaire is open).
- It ignores modifier chords (AltGr allowed), IME/dead keys, other editable targets, the terminal/Ghostty/file editor/shortcut recorder, open dialogs/menus/listbox popovers, and Space on a focused activation control. A read-only composer only receives focus.
- #240 busy controls: the composer stays writable while generating, so type-to-focus fills a Queue/Steer/Redirect draft; the busy action menu (role=menu) and Redirect AlertDialog (dialog-content) block redirection.
- The old text Assistant dock panel was removed on main (Aiden Live orb), so the dock scope parameter was dropped during the 2026-09-26 merge.
- `use-held-modifier-reveal.ts` + `held-modifier-reveal.ts` replace the sidebar's inline Command-hold effect (500 ms delay, hides on release/blur/visibility change).
- Coverage: pure decision/modifier unit tests plus the e2e "holding Command reveals chat shortcuts and typing outside a field lands in the composer" in `tests/e2e/chat-shell-interactions.spec.ts`. Source-grep tests from the original PR were removed per AGENTS.md.
