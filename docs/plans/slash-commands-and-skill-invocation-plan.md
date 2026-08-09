# Slash Commands and Active Skill Invocation Plan

- **Status:** Active — Phases 0–1 are complete; Phase 2 composer palette is next
- **Date:** 2026-07-29
- **Owners:** Composer, command system, chat lifecycle, and skills surfaces
- **Related plans:**
  [Keyboard Command System](completed/keyboard-command-system-plan.md),
  [Aiden Assistant](aiden-assistant-plan.md), and
  [Pi Provider Integration](pi-provider-integration-plan.md)

## Outcome

Aiden will add a keyboard-first slash palette directly above the main chat
composer. Typing `/` at the start of a draft opens one bounded, scrollable
surface with two named groups:

1. **Commands** — curated Aiden actions backed by the existing canonical
   command system.
2. **Skills** — available workspace and global skills that can be explicitly
   attached to the next message.

The palette is a discoverability and dispatch surface, not a second command
system. App commands continue through the same definitions, availability
checks, and handlers used by keyboard shortcuts, native menus, and Command-K.
Skill discovery, collision precedence, workspace binding, and instruction
expansion remain authoritative in the main process.

An explicitly selected skill is a structured modifier on one outgoing user
message. Aiden persists only safe provenance for that selection and injects the
resolved Pi skill invocation into that turn at generation time. It never
persists expanded skill instructions or exposes skill file paths to the
renderer.

## Research baseline

For this plan, “Py” refers to the
[Pi coding agent](https://github.com/earendil-works/pi). Aiden currently pins
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at `0.80.10`; it does
not embed the Pi coding-agent terminal application.

The published `0.80.10` and current `0.82.1` coding-agent command registries
contain the same 22 core commands:

`/settings`, `/model`, `/scoped-models`, `/export`, `/import`, `/share`,
`/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`,
`/tree`, `/trust`, `/login`, `/logout`, `/new`, `/compact`, `/resume`,
`/reload`, and `/quit`.

Current Pi also ships `/llama` through a built-in extension rather than the
core registry. Pi skills are dynamic commands in the form
`/skill:<name> [arguments]`; prompt-template and extension commands are
optional extension points, not part of the default core registry.

Primary references:

- [Pi command registry](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/slash-commands.ts)
- [Pi command reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#commands)
- [Pi skill commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md#skill-commands)
- [Pi built-in Llama extension](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/extensions/llama/index.ts)

The goal is behavioral parity where Pi’s behavior fits Aiden, not literal
terminal-UI parity. Aiden must not advertise terminal-only commands whose
underlying product capability does not exist.

## Goals

- Make important chat, model, provider, workspace, and settings actions
  discoverable without leaving the composer.
- Let a user deliberately invoke an available skill for exactly one message.
- Keep Commands and Skills visually distinct but searchable in one scrollable
  popup.
- Preserve one source of truth for command labels, shortcuts, availability,
  and execution.
- Establish one deterministic, main-process skill registry shared by tool
  assembly, prompt disclosure, the palette catalog, and explicit invocation.
- Keep unknown slash text, paths, and ordinary prose sendable as normal chat.
- Support keyboard, pointer, VoiceOver, light/dark themes, reduced motion, and
  narrow windows from the first release.
- Add focused regression coverage and register it in the normal test gates.

## Non-goals

- Rebuilding or embedding Pi’s terminal UI.
- Exposing every Command-K action as a slash command automatically.
- Adding arbitrary extension commands, prompt-template commands, or shell
  shorthand in the first release.
- Allowing a skill to elevate Full Access, approval policy, MCP access, shell
  access, Computer Use access, or any other permission.
- Sending skill instructions, absolute paths, tool keys, or config secrets to
  the renderer.
- Persisting expanded skill instructions in chat history.
- Supporting explicit skill invocation in the Aiden Assistant dock initially.
  The Assistant’s empty-tool boundary remains intact.
- Shipping Pi session features that Aiden cannot yet represent truthfully.

## Pi command disposition

| Pi command       | Aiden disposition | Rationale / Aiden behavior                                                     |
| ---------------- | ----------------- | ------------------------------------------------------------------------------ |
| `/settings`      | Core              | Open Aiden Settings through the existing settings command.                     |
| `/model`         | Core              | Open the existing model picker; alias `/models`.                               |
| `/scoped-models` | Defer             | Aiden has no equivalent scoped-model editor yet.                               |
| `/export`        | Later             | Use a main-owned save dialog and an Aiden export schema.                       |
| `/import`        | Defer             | Requires schema/version, attachment, duplicate, and trust policy.              |
| `/share`         | Omit              | Aiden has no share service or privacy contract.                                |
| `/copy`          | Core              | Copy the most recent assistant response, with a disabled reason when absent.   |
| `/name`          | Core              | Rename the current chat; argument or small inline prompt.                      |
| `/session`       | Later             | Open a truthful Aiden session-details view when that view exists.              |
| `/changelog`     | Omit              | Do not inherit Pi release notes for an Aiden product surface.                  |
| `/hotkeys`       | Core              | Open Keyboard Shortcuts; alias `/shortcuts`.                                   |
| `/fork`          | Later             | Create a new chat from a selected completed turn using Aiden data rules.       |
| `/clone`         | Later             | Clone the current linear chat using Aiden data rules.                          |
| `/tree`          | Omit              | Aiden has no Pi session-tree UI or data model.                                 |
| `/trust`         | Omit              | Workspace trust is not currently an Aiden capability.                          |
| `/login`         | Core              | Open the canonical provider connection surface.                                |
| `/logout`        | Later             | Requires provider selection, impact copy, and confirmation.                    |
| `/new`           | Core              | Create a new chat through the existing canonical action.                       |
| `/compact`       | Defer             | Compaction exists internally, but the user-facing contract remains unfinished. |
| `/resume`        | Core              | Open chat search/history; alias `/chats`.                                      |
| `/reload`        | Omit              | Renderer reload is a developer operation, not a chat command.                  |
| `/quit`          | Omit              | Keep app quit in native application controls.                                  |
| `/llama`         | Omit              | Current Pi extension behavior is not an Aiden capability.                      |

Dynamic Pi skill commands inspire the Skills group, but Aiden will not expose
raw `/skill:<name>` strings as the internal identity. The visible syntax may be
typed and searched, while selection resolves to an opaque descriptor ID.

Pi prompt templates and third-party extension commands remain out of scope.
They can be revisited only after Aiden defines a signed/owned command extension
contract, namespace policy, permission model, and collision behavior.

## Aiden command catalog

The initial catalog is curated. Every entry declares a slash name, aliases,
search terms, icon, concise description, action kind, canonical command/action
adapter, availability function, and behavior when the draft contains content.

### Core release

| Command        | Aliases        | Behavior                                                                         |
| -------------- | -------------- | -------------------------------------------------------------------------------- |
| `/new`         | —              | Create a new chat. Disable while an active operation cannot safely change chats. |
| `/model`       | `/models`      | Open the existing model selector.                                                |
| `/settings`    | —              | Open Aiden Settings.                                                             |
| `/hotkeys`     | `/shortcuts`   | Open Keyboard Shortcuts in Settings.                                             |
| `/name`        | `/rename`      | Rename the current chat using the remaining argument or an inline prompt.        |
| `/copy`        | —              | Copy the latest assistant response.                                              |
| `/resume`      | `/chats`       | Open the existing chat-search/history flow.                                      |
| `/login`       | —              | Open provider management focused on connection.                                  |
| `/providers`   | —              | Open the Providers settings destination.                                         |
| `/assistant`   | —              | Open/focus the existing Aiden Assistant dock.                                    |
| `/terminal`    | —              | Toggle the existing terminal surface when available.                             |
| `/environment` | —              | Toggle the existing Environment surface.                                         |
| `/review`      | `/code-review` | Open Environment’s review destination using the shipped action path.             |
| `/sidebar`     | —              | Toggle the sidebar through the canonical command.                                |
| `/editor`      | —              | Open the current workspace in the preferred editor.                              |
| `/access`      | `/permissions` | Open the existing access-mode control; do not silently change it.                |
| `/mcp`         | —              | Open MCP settings/status; never connect on palette open.                         |
| `/skills`      | —              | Open skill management. This is distinct from invoking a skill row.               |
| `/theme`       | `/appearance`  | Open the current appearance choices.                                             |

### Later catalog additions

| Command     | Preconditions                                                              |
| ----------- | -------------------------------------------------------------------------- |
| `/logout`   | Provider chooser, confirmation, truthful account-impact copy, and tests.   |
| `/fork`     | Stable turn selection and an explicit copy contract.                       |
| `/clone`    | Stable current-chat cloning contract.                                      |
| `/export`   | Main-owned save dialog and versioned Aiden export schema.                  |
| `/session`  | A real Aiden session-details destination.                                  |
| `/worktree` | A managed-worktree creation flow with branch/name input and safety checks. |

The screenshot’s Chat, Cloud, Code review, Fast, Feedback, Goal, Init, MCP,
Memories, Model, and New worktree rows are visual and information-architecture
references, not a promise of identical capabilities. Aiden can truthfully map
Model, Code review, MCP, and eventually New worktree. Cloud, Fast, Feedback,
Goal, Init, and Memories stay absent until backed by a designed product
contract.

Low-level focus actions, previous/next-chat navigation, direct chat-number
jumps, dictation toggle, file save, and developer actions stay in Command-K or
their existing shortcuts. The slash list should remain useful rather than
becoming a mirror of every registered command.

## Interaction contract

### Triggering and query parsing

- Open only when the first non-whitespace character in the draft is `/` and
  the caret remains inside that first token.
- Do not open for a non-collapsed selection, active IME composition, or a slash
  later in ordinary prose.
- Parse the first token as the command/skill query. Preserve the remaining text
  as an argument or message body.
- Filter locally after one cached catalog load per workspace. Do not perform
  IPC, filesystem discovery, MCP work, or network work on every keystroke.
- Search command name, aliases, title, keywords, and description. Search skill
  name, safe description, and source label; never search or return skill
  instructions or paths.
- Rank exact command, exact alias, prefix, word-prefix, then fuzzy matches.
  Stable source/name ordering breaks equal scores.
- Escape closes the current slash session and leaves the draft unchanged. It
  stays closed until the triggering token changes or the user deliberately
  types a new slash session.
- If there is no match, show a small “No commands or skills found” state but do
  not block sending.
- Unknown slash text, file paths such as `/Users/...`, and intentionally
  unsupported commands remain ordinary message text when sent.

### Keyboard and pointer behavior

- `ArrowDown` and `ArrowUp` move the active option through both groups.
- `PageDown`, `PageUp`, `Home`, and `End` move by viewport or boundary.
- `Enter` selects the active option. `Shift+Enter` retains the composer’s
  newline behavior when it is otherwise valid.
- `Tab` may accept an unambiguous active option but must not trap focus.
- `Escape` closes the palette before any higher-level composer Escape behavior.
- Pointer hover may update the active visual row. Pointer down must not blur
  the textarea before selection is committed.
- Scrolling does not transfer focus away from the composer.
- When an approval, modal, picker, or higher-priority dropdown opens, the slash
  palette closes. Approval UI always wins the interaction layer.

### Command selection

Commands use explicit action kinds rather than parsing arbitrary text:

- **Immediate action:** consume the exact command token, preserve any unrelated
  draft text/attachments, then call the canonical action.
- **Picker action:** remove the token and open the existing model, provider,
  appearance, or other picker.
- **Argument action:** validate the remainder, show usage when missing/invalid,
  and call a typed handler only after validation.
- **Navigation/destructive-context action:** disable when residual text or
  attachments could be lost, or require an explicit confirmation. Never clear
  a meaningful draft implicitly.

Consumed app commands are not chat messages and do not enter history. Command
availability and disabled reasons derive from the same state as Command-K.

### Skill selection

- Skills appear in a dedicated **Skills** group below Commands in the same
  scroll viewport.
- Selecting a skill removes only the slash token and adds a removable chip
  above/inside the composer draft area.
- The chip shows the skill’s safe display name, source scope, availability
  state, and remove control. It does not expose a path or instructions.
- The first release permits one explicitly selected skill per message. The
  model may still choose other available skills through its normal tool path.
- A skill is a message modifier, not a standalone command. Require normal
  message text or at least one valid attachment before Send becomes available.
- Skill command arguments remain in the outgoing message body. Pi’s
  `formatSkillInvocation` supplies the authoritative expanded invocation.
- Changing workspace revalidates the selection. An unavailable or shadowed
  skill stays visible as invalid with a reason until removed or replaced.
- Send-time validation is authoritative. If the catalog changed, the workspace
  changed, or the skill disappeared, fail before appending the user message and
  keep the draft, attachments, and chip available for correction.
- Sending with an explicit skill never changes the access mode or bypasses
  approvals. All normal tool, MCP, shell, Computer Use, and workspace
  boundaries still apply.

## Popup UI specification

### Placement and structure

- Implement a dedicated `ComposerSlashPalette`; do not render the modal
  `CommandPalette` shell inside the composer.
- Anchor it absolutely to the composer context, spanning the usable composer
  width and sitting about 8 px above the composer.
- Overlay the transcript instead of increasing the measured footer height, so
  opening and filtering the palette never makes the conversation jump.
- Use one bounded viewport, approximately `max-height: min(22rem, available
space)`, with a single scrollbar and top/bottom scroll masks.
- Use sticky **Commands** and **Skills** group labels inside that viewport.
- Use compact 44 px minimum rows with a 16 px icon, primary label, secondary
  description, optional shortcut/state, and a full-width active treatment.
- Cap rendered catalog results and show “Keep typing to refine” when more
  matches exist rather than creating an unbounded DOM.
- At narrow widths, hide secondary shortcut/state copy before truncating the
  primary name. Never allow the popup to exceed the content bounds.

### Visual language

The supplied screenshot establishes the useful pattern: a wide selection list
immediately above the composer, recognizable left icons, descriptions aligned
to the right, one active row, and a contained scrollable surface.

Adapt rather than copy:

- Keep Aiden’s existing composer radius, spacing rhythm, typography, and orb
  language.
- Use semantic tokens from `renderer/styles.css` and
  `renderer/shared/appearance.ts`: popover surface/elevation, field border,
  list hover/selection, primary/secondary/tertiary text, focus ring, and status
  tokens. Add a semantic token only if no existing role fits.
- Do not reproduce the screenshot’s oversized empty height, low-contrast
  secondary text, dimming overlay, or separate command-entry field.
- Preserve readable contrast in every Aiden theme and in high-contrast system
  settings.

### Motion

- Open above the trigger from `translateY(4px) scale(.98)` to rest with opacity
  over approximately 150 ms and a bottom-center transform origin.
- Close with the shorter inverse treatment.
- Selection movement uses the existing list-state transition, not springy
  layout motion.
- Under `prefers-reduced-motion`, remove translate/scale and use an immediate or
  near-immediate opacity change.

### Accessibility

- Keep real DOM focus in the textarea. Do not apply `role="combobox"` to a
  multiline textarea whose semantics would become misleading.
- Add `aria-autocomplete="list"`, `aria-controls`, and
  `aria-activedescendant` while the palette is open.
- Use one labelled `role="listbox"`, `role="group"` for Commands and Skills,
  and `role="option"` plus `aria-selected` for each result.
- Give stable DOM option IDs independent of result position.
- Announce result counts, group changes, and unavailable-skill errors through a
  concise polite live region; do not announce every character.
- Disabled rows remain discoverable with a clear unavailable reason but cannot
  be selected.
- The skill chip has an accessible label and keyboard-reachable remove action.
- Manually verify VoiceOver navigation, focus retention, Send behavior, and
  Escape behavior. Automated ARIA assertions are necessary but not sufficient.

## Architecture

### 1. Canonical slash metadata and action adapters

Add a typed slash registry, for example:

- `renderer/shared/slash-commands.ts` — static names, aliases, safe labels,
  action kinds, and canonical command IDs.
- `renderer/lib/slash-command-core.ts` — pure parsing, ranking, session state,
  and selection helpers.
- `renderer/lib/slash-command-actions.ts` — adapters that build current command
  results/actions from the existing command system.

Where an action already exists in `renderer/shared/keybindings.ts`,
`renderer/lib/command-system.tsx`, or
`renderer/lib/command-system-core.ts`, reference that command ID and execute it
through the established dispatcher. Extract reusable result/action builders
from `renderer/components/command-palette.tsx` rather than importing the
Command-K component or duplicating its logic.

The registry must make availability a required part of every action. A slash
row and its Command-K equivalent must agree on whether an action can execute
and why it is unavailable.

### 2. Composer integration

Add `renderer/components/composer-slash-palette.tsx` and integrate it at the
existing composer seams:

- derive the slash session from draft text, selection, and IME state;
- fetch/cache the safe skill catalog by workspace;
- route key events before the textarea’s normal send/newline path;
- preserve draft, attachments, dictation state, access mode, and model state;
- expose a structured selected-skill value through the composer submission;
- render the popup in the composer stacking context without changing footer
  measurement; and
- clear a selected skill only after append and start handoff succeeds.

The parser and keyboard reducer stay framework-independent so most behavior can
be verified without mounting the full chat screen.

### 3. One authoritative skill registry

Create a main-process service such as `main/services/skill-registry.ts`. It
must become the shared resolver for:

- configured skills used as tools;
- discovered workspace/global skills;
- skills disclosed in the model prompt;
- the renderer-safe skill catalog; and
- explicit skill invocation.

Today, collision precedence diverges: tool assembly retains the first
configured skill for a tool key, while prompt disclosure overwrites that entry
so the last configured skill wins. Do not ship an invocation UI on top of that
ambiguity.

Define and test one precedence rule:

1. enabled configured skill;
2. workspace-discovered skill;
3. global-discovered skill;
4. deterministic stable ordering within the same source class.

If configured skills can collide with each other, reject or deterministically
shadow duplicates and return the same winner/reason to every consumer. The
catalog may include a shadowed entry only when the UI can explain that it is
unavailable.

Expose a main-owned IPC query such as `skills:catalog(workspaceId)`. The main
process resolves `workspaceId` to the authorized folder. Do not accept a
renderer-supplied folder path as the security boundary for invocation.

Use a renderer-safe DTO:

```ts
type SkillCatalogEntry = {
  invocationId: string; // opaque and workspace-bound
  name: string;
  description: string;
  source: "configured" | "workspace" | "global";
  available: boolean;
  unavailableReason?: string;
};
```

The DTO excludes instructions, absolute paths, config payloads, provider
secrets, and internal tool keys. Catalog reads use the existing bounded
discovery cache and are invalidated by workspace/config changes rather than
rescanning on keystrokes.

### 4. Structured, lease-bound skill invocation

Extend composer submission with a versioned reference, for example:

```ts
type SkillInvocationV1 = {
  version: 1;
  invocationId: string;
  displayName: string;
  source: "configured" | "workspace" | "global";
};
```

`displayName` and `source` are untrusted display hints. The main process uses
only the opaque ID plus the current chat/workspace when resolving behavior.

Bind resolution to the existing turn handoff:

1. `chats:appendMessage` begins the current chat turn lease.
2. While holding that lease, main resolves the skill against the chat’s
   authoritative workspace and current registry.
3. Main snapshots the formatted invocation for that exact turn and persists
   only normalized provenance on the user message.
4. If resolution fails, append fails before history mutation.
5. `chat:start` consumes the prepared invocation from the same turn lease.
6. `main/services/generation-messages.ts` prepends the invocation only to the
   current user turn passed to Pi.
7. Completion, failure, cancellation, or chat deletion clears the prepared
   snapshot.

This closes the catalog-to-send race without placing skill instructions in
`ChatStartParams` or trusting the renderer to expand them.

Reuse Pi core’s pinned `formatSkillInvocation()` behavior for instruction and
argument formatting. Do not migrate Aiden’s full generation stack to Pi
`AgentHarness.skill()` merely to gain slash invocation; doing so would collide
with Aiden’s existing persistence, approvals, compaction, cancellation,
streaming, and subagent lifecycle contracts.

Add optional normalized provenance to `ChatMessage`, render it as a compact
skill chip on the user message, and preserve it on replay/export. Never persist
expanded instructions. Older messages without provenance remain valid.

The Aiden Assistant dock rejects/does not offer explicit skill references in
this phase. Its intentionally empty tool set remains unchanged.

### 5. Bounds and privacy

Phase 0 must centralize and test explicit limits:

- maximum slash query length: 256 characters;
- maximum catalog entries returned to a renderer: 500;
- maximum visible ranked results: 100;
- normalized safe name/description lengths;
- existing message/attachment limits continue to govern skill arguments; and
- a bounded skill-instruction read/format limit that fails closed with a
  specific error before generation.

Do not persist search queries, recent skill IDs, or catalog snapshots. Opaque
IDs must not be reversible into local paths and must be invalidated when their
workspace/config binding changes.

Skill content is executable guidance, not trusted prose. Explicit invocation
changes what guidance Pi sees, but it never changes the permission decision
for a tool call.

## Session-command contracts for the later phase

The following commands should not ride on generic message parsing:

- `/fork`: choose a completed turn, copy only the permitted visible linear
  conversation and attachments through that turn, generate new message IDs,
  and omit reasoning, timeline, transient tool state, and subagent runtime
  records. Block while generation or an approval is active.
- `/clone`: create a new chat from the current permitted linear history with
  the same copy/redaction rules.
- `/export`: ask main to show the native save dialog and write a versioned
  Aiden export. Renderer-provided arbitrary output paths are not accepted.
- `/session`: open a read-only Aiden-owned session summary; do not emulate Pi
  fields that Aiden does not store.
- `/logout`: choose an authenticated provider, explain the effect, confirm,
  then use the existing secret/provider mutation boundary.
- `/worktree`: invoke only Aiden’s managed-worktree flow, with explicit naming,
  branch validation, existing dirty-worktree protections, and no hidden shell
  construction.

Each addition requires its own data contract and focused tests before its row
becomes available.

## Delivery phases

### Phase 0 — Freeze the contract

**Completed 2026-08-09.** The curated catalog, canonical action and availability
keys, parser/ranker/session reducer, exact skill DTOs, deterministic collision
policy, workspace/revision-bound opaque invocation identity, and centralized
bounds are implemented. Skill discovery now performs bounded, regular-file,
symlink-safe reads. The registered 29-test focused gate, command-system suite,
TypeScript, ESLint, and diff checks pass. Three independent high-reasoning
review lanes returned clean final P0/P1/P2 verdicts after the correction loops.

- Finalize the curated command list, aliases, icons, copy, and action kinds.
- Define the pure trigger/parser/ranker/session-state contract.
- Define `SkillCatalogEntry`, `SkillInvocationV1`, provenance, errors, and
  bounds.
- Decide deterministic skill collision and invalidation behavior.
- Add failing contract tests for parsing, ranking, DTO privacy, and collision
  precedence.
- Reinspect the settled `command-palette.tsx`, `ui.tsx`, appearance tokens, and
  styles before implementation because this planning worktree contains
  unrelated edits in those shared areas.

**Exit:** reviewed typed contracts and red tests, with no ambiguous command or
skill identity behavior.

### Phase 1 — Unify skill resolution

**Completed 2026-08-09.** One main-process registry snapshot now drives model
tools, prompt disclosure, the renderer-safe workspace catalog, and explicit
resolution. Content-derived revisions preserve unchanged invocation IDs while
workspace/config/permission changes invalidate every affected consumer.
Discovery and configured skills have per-file, source, count, aggregate, and
config-file byte bounds; root/file descriptor identities close symlink and
replacement races. No Access performs no workspace discovery, catalog IPC
accepts only main-resolved workspace IDs, and renderer DTOs expose no paths,
instructions, tool keys, or secrets. The registered 51-test Slash Commands
gate, focused config/discovery suites, full repository suite, TypeScript,
ESLint, and diff checks pass. Three independent high-reasoning review lanes
returned clean final P0/P1/P2 verdicts after the correction loops.

- Implement the main-process skill registry.
- Move tool assembly and prompt disclosure onto the shared resolver.
- Fix configured/workspace/global collision inconsistency.
- Add the safe workspace-bound catalog IPC and invalidation.
- Test duplicate names, enable/disable changes, workspace changes, cache
  expiry, missing files, oversized files, and renderer-path spoofing.

**Exit:** tools, prompt disclosure, catalog, and explicit resolution agree on
the same skill or the same unavailable reason.

### Phase 2 — Composer command palette

- Add pure slash parsing/ranking/session helpers.
- Extract canonical command action/result builders.
- Build the two-group popup above the composer.
- Ship the Core release command rows, initially with Skills loading/empty
  states wired to the safe catalog.
- Add keyboard, pointer, screen-reader metadata, reduced-motion, responsive,
  theme, and layering coverage.

**Exit:** all core app commands work from slash and their availability matches
Command-K; opening/filtering never shifts the transcript.

### Phase 3 — Active skill invocation

- Add the selected-skill composer chip and submission contract.
- Resolve and snapshot the invocation inside the append/start turn lease.
- Use Pi `formatSkillInvocation()` and inject only into the current generation
  turn.
- Persist/render safe provenance only.
- Preserve the draft/chip on stale or invalid skill failures.
- Verify that access modes and approval flows remain unchanged.

**Exit:** a user can select an available skill, send a real task, see its
provenance, and prove through tests that instructions were neither exposed to
the renderer nor persisted.

The user-requested feature is not complete until Phase 3 exits. Phase 2 must
not be presented as complete slash-command support without active skills.

### Phase 4 — Selected session commands

- Implement `/fork`, `/clone`, `/export`, `/session`, `/logout`, and
  `/worktree` only after each supporting contract exists.
- Update the disposition table if product decisions change.

**Exit:** each enabled row maps to a real, tested Aiden capability; unsupported
Pi rows remain absent.

### Phase 5 — Hardening and release

- Run full regression, packaged-app, accessibility, theme, and performance
  gates.
- Measure open/filter latency with large bounded catalogs.
- Verify no network, discovery scan, or MCP connection occurs on popup open.
- Validate safe recovery across send failure, cancellation, workspace switch,
  config change, crash/relaunch, and old histories.
- Update user-facing shortcuts/help and move this plan to `completed/` only
  after the original Phase 0–3 scope ships and passes release gates.

## Test plan

### Pure command tests

- Trigger at first non-whitespace slash only.
- Caret, selection, IME, whitespace, newline, path, and prose edge cases.
- Exact/alias/prefix/fuzzy ranking and deterministic ties.
- Commands and skills grouped in one navigation order.
- Sticky Escape and trigger-session reset.
- Argument extraction and unknown-command pass-through.
- Result caps and long-query bounds.

### Renderer tests

- Popup anchors above the composer without changing footer height.
- Commands and Skills headings, loading, empty, error, disabled, and overflow
  states.
- Arrow/Page/Home/End/Enter/Tab/Escape behavior.
- Pointer selection without textarea blur.
- Draft and attachments survive app actions, failures, and navigation guards.
- Skill chip add/remove/replace and one-explicit-skill rule.
- Successful send clears state only after the handoff succeeds.
- Workspace/config changes revalidate selected skills.
- ARIA relationships, active descendant, stable IDs, live-region copy, and
  reduced motion.

### Main and IPC tests

- One resolver produces identical precedence for tools, prompt disclosure,
  catalog, and explicit invocation.
- Workspace/global/configured collisions and deterministic shadow reasons.
- Renderer folder/path/descriptor spoofing cannot select another workspace’s
  skill.
- Catalog DTO serialization contains no instructions, paths, tool keys, or
  secrets.
- Catalog and instruction bounds fail closed.
- Append/start turn lease accepts one exact prepared invocation and rejects
  stale, replayed, cross-chat, cross-workspace, and post-cancellation
  references.
- Append failure leaves chat history unchanged.

### Generation and persistence tests

- Pi `formatSkillInvocation()` receives the selected skill and arguments.
- Expanded instructions affect only the current generated turn.
- Instructions never appear in stored `ChatMessage`, chat index, renderer IPC,
  logs, or export.
- Safe provenance survives reload and old messages remain compatible.
- Explicit selection cannot alter access/approval policy or Assistant tools.
- Attachments and message text retain their normal ordering/limits.

### Regression and manual gates

Register any new focused suite in `package.json` so the normal CI test command
runs it. Expected gates:

- focused slash-command, command-system, skill-registry, chat-lifecycle, and
  generation-message suites;
- `npm run test:command-system`;
- `npm run test:preflight`;
- `npm run test`;
- `npm run type-check`;
- `npm run lint`; and
- `npm run build`.

Manual packaged-app checks:

- light and dark themes plus every shipped appearance preset;
- narrow and wide windows, long descriptions, and large bounded skill lists;
- keyboard-only use, VoiceOver, reduced motion, and high contrast;
- composer with attachments, dictation, approval UI, model picker, and
  generation in progress;
- offline launch and no unexpected network activity; and
- skill add/change/delete between catalog display and Send.

## Definition of done

- The main composer opens a stable, accessible, scrollable slash palette above
  itself without shifting the conversation.
- Commands and Skills are separately labelled and keyboard-navigable in one
  viewport.
- Every enabled command dispatches through a canonical Aiden action and reports
  truthful availability.
- Unknown slash text remains normal chat.
- A user can explicitly select one skill for one substantive message.
- Main resolves that skill against the authoritative chat workspace at Send,
  injects it only into that Pi turn, and preserves only safe provenance.
- All skill consumers share one deterministic collision resolver.
- No skill instructions, paths, tool keys, or secrets reach the renderer or
  persisted chat.
- Permissions and approvals are unchanged by explicit invocation.
- Focused, aggregate, accessibility, theme, and packaged-app gates pass.
- `docs/plans/README.md` and `.memory/PROJECT-HISTORY.md` reflect the shipped
  status before the plan moves to `completed/`.
