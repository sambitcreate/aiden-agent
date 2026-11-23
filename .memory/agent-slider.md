# Agent Slider (replaces the Model Pad)

2026-11-23. Plan: `docs/plans/agent-slider-plan.md`. Prototype: `docs/plans/assets/agent-slider-prototype.html`.

- The owner asked to drop the Model Pad's scores and chart. In its place, one slider with 3 to 7 stops, each a label plus an optional provider, model and thinking level that the person picks. It ships as a six-PR stack: plan, data, slider, editor and Pad removal, scoring backend removal, phones.
- The plan came from three Opus research plans that were cross-reviewed against each other. They agreed on the following:
  - Effort is stored per chat (`ChatMeta.thinkingLevel`, plus `chats:setModel` taking a level). A stop never writes the global per-model thinking maps, because those maps would leak effort into other chats and collide two stops that use the same model.
  - The active stop is derived from the chat's provider, model and level, never stored. No match means the chat is Custom, and Custom shows `ThinkingControl`.
  - An unavailable stop stays where it is. Arrow keys skip it, and clicking it opens reassign.
  - Remove benchmarks, Artificial Analysis and measured pace. Keep models.dev facts, and keep list price as plain text.
- Owner decisions (2026-11-23):
  - Step shortcuts are ⌥⌘[ and ⌥⌘]. Not ⌃T, because ⌃T is transpose in macOS text fields.
  - New chats start on the last model used, together with `lastThinkingLevel`.
  - The slider travels in the portable config.
  - A one-time, delete-only cleanup of the retired benchmark and Artificial Analysis keys and caches.
  - Phones are in scope (PR 5).
  - Quick Chat gets the slider.
  - The onboarding Thinking tile merges into the Agent Slider tile.
  - The home stop is only the ↺ target.
- The "Effort ⌃T" slider in the owner's reference screenshot is not in 0.69.0.
- `⌘[`, `⌘]`, `⇧⌘[` and `⇧⌘]` are already bound in `renderer/shared/keybindings.ts`.
