# Chat width setting (T3 #11594)

- `AppearanceConfig.chatWidth`: `narrow | default | wide | full`, default `default`. `CHAT_WIDTH_OPTIONS` / `chatContentMaxWidth()` in `renderer/shared/appearance.ts` map these to 44rem / 52rem / 64rem / `none`.
- `applyAppearanceConfig` sets `--chat-content-max-width` inline on `<html>` and sets `data-chat-width`. The `:root` 52rem in `styles.css` is only the pre-hydration fallback.
- The field is optional in `parseAppearanceConfig`, so legacy v1 settings and exports load. A supplied invalid value throws "Chat width is unsupported."
- UI: an Appearance "Chat width" section (`ChatWidthPicker`, a radiogroup labelled by its h2) that uses the same roving-radio helper as the theme pickers.
- The chat `ScrollArea` measures any reserved classic-scrollbar gutter and narrows its fixed footer to the scrollport's usable width. This keeps Full-width messages centered with the composer on Linux without overflowing or clipping the transcript; overlay-scrollbar platforms measure zero. Keep this opt-in for the main chat surface because other scroll areas do not share the footer geometry.
- Desktop only. Mobile clients keep their own local appearance and do not read this field, and the Remote protocol is unchanged.
- Covered by e2e `settings-unification.spec.ts` "chat width setting…", which measures geometry at 1800px and checks the value after a relaunch, and by unit tests in `appearance.test.ts`.
