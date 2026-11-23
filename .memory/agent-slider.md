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
  - The slider travels with the portable `~/.aiden/config.json`, which is its only durable home. `settings.json` never holds it; the renderer reads it through a projected field of the settings read.
  - When main clamps an unsupported level, it writes the resolved level back to the chat with a compare-and-set, so a newer selection wins.
  - A one-time, delete-only cleanup of the retired benchmark and Artificial Analysis keys and caches.
  - Phones are in scope (PR 5).
  - Quick Chat gets the slider.
  - The onboarding Thinking tile merges into the Agent Slider tile.
  - The home stop is only the ↺ target.
- The "Effort ⌃T" slider in the owner's reference screenshot is not in 0.69.0.
- `⌘[`, `⌘]`, `⇧⌘[` and `⇧⌘]` are already bound in `renderer/shared/keybindings.ts`.
- PR 1 (2026-11-23, `feature/agent-slider-1-data`):
  - The slider is stored raw (`unknown`) in `PortableConfigShape.agentSlider`, and a bad hand edit is never rewritten. `config-store-core`'s `publicSettings()` projects the normalized value into every settings result, cached per portable document.
  - Writes go only through `settings:setAgentSlider`, and `settings:set` refuses `agentSlider`.
  - `setChatModelSelection(id, provider, model, assertCurrent, thinkingLevel?)`: `null` clears the level, and leaving it out keeps the level only on the same model. A message append on another model drops the level.
  - Clamp write-back is `reconcileTurnThinkingLevel` (`main/services/chat-thinking-level-reconcile.ts`), called from llm-client's `prepareGeneration`. It broadcasts `chats:metadata-updated` with `thinkingLevel`.
  - The Remote summaries whitelist their fields (`safeSummaryMetadata`), so `ChatMeta.thinkingLevel` never reaches phones.
  - Stop limits match `chats:setModel`: provider 256 characters, model 512.
- PR 2 (2026-11-23, `feature/agent-slider-2-slider`):
  - `renderer/components/agent-slider.tsx` is the track; `renderer/components/agent-model-popover.tsx` is the composer popover (slider, "Other models…", "Customize slider…", list and reassign views). The pure rules live in `renderer/lib/agent-slider-view.ts`: stop views and reason text, position (Custom when no stop matches or none can run, thumb on home), stepping, and `agentSliderComposerState` / `agentSliderStepTarget` for the shortcuts.
  - Stepping from Custom starts at the home stop; when nothing can run that way, a runnable home stop is the step.
  - `ModelListPanel` (`renderer/components/model-list-panel.tsx`) is the list shared by `ModelPicker` and the popover. The composer list has no Pad toggle. `ModelPicker` with its Pad tab now remains only for a Bot's chat in chat-pane (and image nodes use their own picker).
  - "Other models…" is ⌘L (`OTHER_MODELS_SHORTCUT` in `renderer/shared/built-in-keys.ts`), popover-local. ⇧⌘M is `model.change`, caught at document capture by the command system first.
  - "Customize slider…" opens Settings section `modelData` (`AGENT_SLIDER_SETTINGS_SECTION`); PR 3 retargets it if the editor gets its own section.
  - First-run seed: `settings:seedAgentSlider` → `configStore.seedAgentSlider`, which writes only while `config.json` has no `agentSlider` key at all (checked inside `mutatePortable`), so a malformed hand edit is never replaced. Called when the popover opens with no slider (after the catalog loads) and at onboarding's provider step (`seedAgentSliderForModel`). Renderer helpers: `renderer/lib/agent-slider-seed.ts`.
  - Reassign saves the whole slider through `settings:setAgentSlider`, with the model's default level only when it has levels (`renderer/lib/composer-thinking-levels.ts`, which mirrors chat-pane's family rules), then moves the chat onto the stop.
  - chat-pane's `select(provider, model, level?)`: `undefined` keeps today's list behavior, `null` or a stop level is sent to `chats:setModel`. On a stop `ThinkingControl` is hidden; in Custom a change to it also clears the chat's own level, and it shows the chat's own level when the family offers it.
  - A new chat's first send carries `thinkingLevel` (`chats:createWithFirstMessage`), saved on the chat only with a model.
  - Quick Chat keeps the pick local until the first send (which carries the level); after that each stop or list pick goes through `chats:setModel` (now on its allowlist) and the selection follows the saved chat and any clamp `chats:metadata-updated`. Unavailable stops also get keyboard-reachable buttons under the track. Onboarding seeds from a fresh `providers:list`, not the cached query., reads the step bindings from `shortcut:get` when it opens, and refetches settings on `app:config-externally-changed`. Recent-model writes still fail there because `settings:set` is not on its allowlist (pre-existing).
