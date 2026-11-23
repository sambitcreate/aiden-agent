# Agent Slider: replace the Model Pad

Status: Approved (2026-11-23). Shipping as a stack of six PRs (0–5), none merged yet. PR 0 is this plan, on branch `feature/model-pad-agent-slider-32cf16`.

Prototype: [`assets/agent-slider-prototype.html`](assets/agent-slider-prototype.html), an interactive mock built with Aiden's tokens, also published as a private [artifact](https://claude.ai/artifact/E37LVEP5pKRGudZPTfRezg). Sample models only.

## Summary

The Model Pad scores every model (benchmarks, measured pace, price) and plots it on a 2-D lattice. The owner wants the scores gone. The **Agent Slider** replaces it. It is one horizontal slider with 3 to 7 stops, and the person chooses the model and reasoning effort behind each stop. Moving the thumb chooses which model and effort handle the chat's next turn.

This plan came from three independent research plans (data and runtime, UX and design, retirement and rollout). The three plans were cross-reviewed against each other with file:line evidence, and the owner then answered the open questions.

## Concept

- **The composer popover** puts the slider on top:
  - a pill track with an accent fill up to a white thumb and a dot at each stop;
  - the stop's name, with the model and effort beneath it;
  - a decorative ⚡ at the left and ↺ (reset to the home stop) at the right.

  Below a separator, **Other models…** (⇧⌘M) opens today's searchable list as a sub-view. **Customize slider…** opens Settings.
- **Settings → Models & Context → Agent Slider** replaces the Model Pad page. It holds a live preview, a row per stop, Add stop (disabled at 7), Remove (disabled at 3), reorder, a home stop, and templates (an effort ladder for one model, local to cloud). Edits autosave with Undo.
- **Accessibility:** the thumb is `role="slider"` with a valid `aria-valuenow` in every state. In Custom it keeps the home stop's position, where the hollow thumb rests, and announces "Custom: <model>" through `aria-valuetext`.
- **The slider is the composer's model-and-effort control.** While a chat sits on a stop, `ThinkingControl` is hidden. When a chat's model and effort match no stop, the chat is **Custom**: the thumb goes hollow, the fill disappears, and `ThinkingControl` comes back.

## Owner decisions (2026-11-23)

1. **Step shortcuts:** `agentSlider.next` and `agentSlider.previous`, default ⌥⌘] and ⌥⌘[ (`Command+Alt+]` and `Command+Alt+[`), rebindable through `renderer/shared/keybindings.ts`. Nothing else uses them; `Command+[`, `Command+]`, `Command+Shift+[` and `Command+Shift+]` are taken. ⌃T is not used because it transposes characters in macOS text fields. The "Effort ⌃T" slider in the owner's reference screenshot is not in 0.69.0.
2. **New chats start on the last model used,** keeping today's `lastProviderId` and `lastModel` behavior, extended with the last thinking level so a new chat lands on the same stop. The home stop is only what ↺ returns to.
3. **The slider travels with the portable `~/.aiden/config.json`,** which is its only durable home (see Storage below).
4. **A one-time, delete-only cleanup** removes the retired OpenRouter benchmark credential (`aiden-internal:model-pad-openrouter-benchmarks-v1`), `openrouter-benchmark-cache.json`, the Artificial Analysis credential and cache, and `model-pace.json`. It runs at startup and on onboarding reset. It makes no network calls, can run any number of times, and tolerates failure.
5. **List price stays** as plain text in the model hover card. Nothing orders, seeds or routes by price.
6. **Phones get the slider** in PR 5.
7. **Quick Chat gets the slider.** Bots, routines and Telegram keep their own model choice, and the slider is hidden in Bot chats.
8. **The onboarding "Thinking" tile merges** into the Agent Slider tile.

## Decisions settled by the three plans

| Topic | Decision |
|---|---|
| Stop | A label, an optional provider and model, and an optional thinking level. The same model may appear in several stops with different effort. |
| Effort storage | Per chat: a new `ChatMeta.thinkingLevel` and `chats:setModel(chatId, providerId, model, thinkingLevel?)`. A stop never writes the per-model thinking maps (`googleThinkingByModel` and friends). Those maps are global (`renderer/main/chat-pane.tsx` `settingsApi.setGoogleThinking(model, …)`), so writing them would change every chat on that model. They would also collide two stops on one model. |
| Active stop | Derived from the chat's own provider, model and thinking level, with the first match winning. No match means Custom. Never stored. |
| Unavailable stop | Stays in place, which keeps the 3-stop minimum. It shows a hollow dot and the reason ("Sign in to Anthropic", "Choose a model"). Arrow keys skip it. Clicking it opens reassign without committing. If every stop is unavailable, the popover shows Custom. Never silently substituted. |
| First run | The slider is seeded once and saved, so the thumb never moves under the person. If the current model has 3 or more thinking levels, the seed is that model's own effort ladder with the home stop in the middle. Otherwise it is 3 stops: the current model in the middle and two "Choose a model" stops. Seeding happens at onboarding provider confirmation, or the first time the picker opens without a slider. |
| Scores | Delete OpenRouter benchmarks, the Artificial Analysis leftovers, measured pace and the lattice. Keep the models.dev facts (context, capabilities, cutoff) and list price as plain text. |
| Storage | One authority: `agentSlider` lives only in the portable `~/.aiden/config.json` (`PortableConfigShape`), beside the providers its stops name, so it travels with that file and the existing watcher picks up hand edits. `settings.json` never stores it. The renderer reads it as a projected field of the settings read and writes it through a validated patch that updates only the portable store. A provider remap rewrites the stops in the same portable update that rewrites providers and aliases. `lastThinkingLevel` stays machine-local in `settings.json` beside `lastModel`. Old `modelPadPlacements` and `modelPadMetric` keys are ignored, not migrated (pre-1.0 rule). |
| Remote | No wire change until PR 5. Today `POST /chats/{id}/turns` takes `thinkingLevel` as turn input only and does not persist it; PR 5 makes a phone's choice durable and visible. |

## Data model

```ts
// renderer/shared/agent-slider.ts (shared by main, renderer and the CLI bundle)
export const AGENT_SLIDER_MIN_STOPS = 3;
export const AGENT_SLIDER_MAX_STOPS = 7;

export interface AgentSliderStop {
  id: string;                               // "stop_" + 8 hex; UI identity only
  label: string;                            // 1–24 code points, no control characters
  providerId?: string;                      // absent together with model = "Choose a model"
  model?: string;
  thinkingLevel?: GenerationThinkingLevel;  // absent = the model has no levels
}

export interface AgentSliderSettings {
  version: 1;
  stops: AgentSliderStop[];                 // left to right
  homeStopId: string;                       // where ↺ returns
}

// PortableConfigShape.agentSlider?: AgentSliderSettings  (the only durable copy; projected into the renderer's settings read as AppSettings.agentSlider)
// AppSettings.lastThinkingLevel?: GenerationThinkingLevel  (beside lastProviderId / lastModel)
// ChatMeta.thinkingLevel?: GenerationThinkingLevel

normalizeAgentSlider(value): AgentSliderSettings | undefined  // fail-closed; drops bad stops
parseAgentSliderPatch(value): AgentSliderSettings            // throws on <3, >7, duplicate ids
remapAgentSliderProvider(slider, from, to)
resolveAgentSliderStop(stop, inventory)                      // ok | unassigned | provider-missing | not-signed-in | model-missing | hidden
activeStopIndex(slider, selection)                           // -1 = Custom
seedAgentSlider(selection, thinkingLevels)                   // first-run seed
```

Pins and recents move out of `renderer/shared/model-pad-preferences.ts` into `renderer/shared/model-preferences.ts` unchanged in PR 3, when the Pad's own fields are deleted. PR 1 stays additive.

## How a turn picks its model

1. **Moving the thumb** calls `chats:setModel(chatId, providerId, model, thinkingLevel)`. `setChatModelSelection` (`main/services/chat-store-core.ts`) compares the level as well as the provider and model; today it returns early when only the provider and model are unchanged. It still refuses Bot chats and changes during a reply.
2. **A manual change in `ThinkingControl`** (Custom state) clears `ChatMeta.thinkingLevel`, so the per-model map applies as it does today.
3. **On send**, `chat-pane` sends the chat's own `thinkingLevel` when it is set, and otherwise the per-model map value. This replaces the four-way provider ternary.
4. **Main has the final say.** `resolveGenerationThinkingLevel(params.thinkingLevel ?? saved)` in `main/services/llm-client.ts` clamps any level the model no longer supports. When the resolved level differs from the chat's stored `thinkingLevel`, main writes the resolved level back to the chat with a compare-and-set: only if the stored level is still the one the turn started with, so a newer selection always wins. It emits the usual chat update, so the running turn, `ChatMeta`, the slider and a reopened chat all agree.
5. **Reopening the chat** derives the thumb again from the stored provider, model and level.
6. **A new chat** seeds from `lastProviderId`, `lastModel` and `lastThinkingLevel`.

## The stack

Each PR targets the branch below it. Merge bottom-up with merge commits, and only when CI is green on the PR's exact head. Never rebase a pushed branch: merge `origin/main` into PR 0 and carry it upward. Never delete a base branch by hand. Disable git rerere for these merges.

| PR | Branch | Contents | Local checks |
|---|---|---|---|
| 0 | `feature/model-pad-agent-slider-32cf16` | This plan, the prototype, the plans index row, `.memory/agent-slider.md` | None (docs only) |
| 1 | `feature/agent-slider-1-data` | `agent-slider.ts`, the settings fields and their normalization, provider remap and removal, portable config, `ChatMeta.thinkingLevel`, `setModel` with a level, the send path, `lastThinkingLevel`, and the clamp write-back. No UI, and no change in behavior until PR 2 uses it. | The touched `tsx --test` files, `test:main-shared`, `tsc --noEmit`, eslint, CLI type-check and bundle test |
| 2 | `feature/agent-slider-2-slider` | The `AgentSlider` component, the `ModelListPanel` extraction, the popover swap (composer and Quick Chat), the first-run seed, the step shortcuts, hiding `ThinkingControl` on a stop | `test:agent-slider`, the picker and composer tests, `test:preflight`, `check:aiden-rules`, E2E in a Cua Space |
| 3 | `feature/agent-slider-3-editor` | The Settings editor, deleting the Pad UI, CSS and `modelPad*` fields, moving pins and recents to `model-preferences.ts`, the token rename, the onboarding tile and art (Thinking tile merged), README, PRODUCT, `docs/keyboard.md` and `docs/settings-design-system.md` | `test:settings-design`, `test:onboarding`, the axe pass, E2E |
| 4 | `feature/agent-slider-4-retire-scoring` | Delete benchmarks, Artificial Analysis, pace, the `modelInsights:*` and `modelPace:*` IPC, and CLI `aiden insights`. Add the cleanup and the bounded analytics (`slider_stop` 1–7 or custom, `slider_stop_count` 3–7). Edit AGENTS.md (the models.dev, OpenRouter benchmark and CLI rules). Retire the Model Insights plan. | Trimmed `test:model-insights`, `test:model-catalog`, the IPC contract, onboarding reset, CLI parity and bundle tests, `test:analytics`, full `npm test` |
| 5 | `feature/agent-slider-5-mobile` | Capability-gated at the next Remote revision, claimed at merge time: `agentSlider` in `GET /models`; a phone's accepted provider, model and level persisted atomically as the chat's selection through `setChatModelSelection`, with the existing revision and concurrency checks; `thinkingLevel` in the chat and messages-window metadata projections; both strict native decoders updated; native sliders with haptic ticks; fixtures. | iOS and Android suites, contract fixtures, CLI bundle test |

PRs 2–4 ship in the same release, so `main` never releases a slider without its editor or with dead scoring code.

## Tests

The new tests are behavioral only. There are no source greps and no `className` snapshots.

- **`agent-slider.test.ts`:**
  - normalization fails closed, and a dangling home stop falls back to the middle stop;
  - the patch parser rejects 2 or 8 stops and duplicate ids;
  - remap and removal;
  - `resolveAgentSliderStop` gives each failure reason;
  - `activeStopIndex` handles the same model at two efforts, Custom, and unassigned stops;
  - `seedAgentSlider` with ladder and non-ladder models.
- **Portable config:** a round trip; an external `config.json` edit after local settings exist wins, and nothing in `settings.json` shadows it; leftover `modelPad*` keys are dropped.
- **Clamp write-back:** a stored level that becomes unsupported before send leaves the generation level, `ChatMeta` and a re-read in agreement, and a newer selection made during the turn is not overwritten.
- **`config-store-core`:** remap rewrites stops; removal keeps them.
- **Chat mutations:** the register-and-invoke test for `chats:setModel` with a level. A level-only change persists. Bot chats are refused.
- **Testing Library on the slider:**
  - the role, `aria-valuetext` and value;
  - arrow keys, Home and End skip unavailable stops;
  - Custom state;
  - reset;
  - typing opens the list with the filter seeded.
- **Editor:** the 3 and 7 bounds, reorder, Undo, and the effort select listing only the levels the model supports.
- **E2E:** pick a stop and send; the editor across widths; the axe snapshot.

## Risks

- **Two sources of effort.** Mitigation: `ThinkingControl` appears only in Custom, and a manual change clears the chat's level.
- **A clamped level could make the label lie.** Mitigation: the compare-and-set write-back in step 4.
- **Provider remap in `config-store-core` is subtle.** Tests cover remap and removal.
- **The mobile decoders are strict,** so PR 5 is capability-gated.
- **The large deletion diff conflicts** in the root `package.json` test chain and `scripts/ci-test-registry.json`. Resolve those by taking both sides.
- **A white thumb on the Paper and Monochrome presets depends on its shadow.** Check those presets.
