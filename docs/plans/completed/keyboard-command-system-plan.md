# Keyboard Command System and Command Palette Plan

Status: Complete — v1 shipped 2026-07-26
Date: 2026-07-26
Related: `docs/chatgpt-desktop-ui-inspiration.md`, `docs/plans/aiden-assistant-plan.md`

## Delivered v1

The implementation now has one typed command catalog and persisted override map,
one renderer dispatcher, transactional global-hotkey registration, derived native-menu
accelerators and visible labels, a searchable canonical Keyboard Shortcuts section, and
the `Command-K` palette with Commands, Chats, Models, Providers, and Quick Settings modes.

Provider credentials and connection flows deliberately remain in full Settings. The
palette offers explicit cached-state navigation and catalog refresh without collecting or
displaying secrets. Full-message chat search also remains a separate indexed-search
project, as scoped below.

## Outcome

Aiden should have one keyboard-command system that powers:

- system-wide hotkeys;
- in-app shortcuts;
- a `Command-K` command palette;
- native application-menu accelerators;
- shortcut labels, tooltips, and `aria-keyshortcuts`;
- one searchable Keyboard Shortcuts settings page.

The command palette is the fast path for finding chats, changing the active model,
opening or updating provider state, reaching settings, and invoking safe app actions
without navigating through the sidebar first.

This is not a second action system. Every palette result resolves to the same typed
command, availability rule, handler, and effective shortcut used by the rest of the app.

## Verdict

Adopt T3 Code's shared keybinding contract, default table, resolver, derived labels, and
settings model. Do not copy its arbitrary boolean `when` language, server/file-watcher
stack, warn-only conflicts, or distributed window listeners.

Aiden should improve on the reference with:

1. one typed command catalog;
2. one app-shell dispatcher with an authoritative context snapshot;
3. a separate transactional manager for the three true system-wide hotkeys;
4. one canonical settings editor;
5. a `Command-K` palette generated from the catalog.

## Current Aiden inventory

### System-wide hotkeys

| Command ID | Default | Existing action |
| --- | --- | --- |
| `composer.focus` | `Command-Option-Space` | Show Aiden and focus the main composer |
| `dictation.toggle` | `Command-Shift-D` | Start or stop global dictation |
| `assistant.open` | `Command-Option-A` | Show and focus the Aiden Assistant dock |

These are the only commands that should use Electron `globalShortcut`.

### Existing in-app product commands

| Command ID | Default | Existing action |
| --- | --- | --- |
| `settings.open` | `Command-,` | Open Settings |
| `workspace.openPreferredEditor` | `Command-O` | Open the workspace in the preferred editor |
| `sidebar.toggle` | `Control-Command-S` | Toggle the chat sidebar |
| `terminal.toggle` | `Command-J` | Toggle the terminal |
| `environment.toggle` | `Command-Shift-E` | Toggle Environment |
| `chat.jump.1` … `chat.jump.9` | `Command-1` … `Command-9` | Open the corresponding visible chat |
| `file.save` | `Command-S` | Save the active file editor |

Return/Shift-Return, Escape dismissal, Tab trapping, arrow navigation, radio behavior,
and keyboard resizing remain component-native semantics. They are not user-rebindable
product commands.

## Product additions

The first catalog release should add:

| Command ID | Default | Palette presence |
| --- | --- | --- |
| `commandPalette.toggle` | `Command-K` | Opens/closes the palette |
| `chat.new` | `Command-N` | Root action |
| `chat.search` | — | Opens the Chats palette mode |
| `chat.previous` | `Command-Shift-[` | Root action |
| `chat.next` | `Command-Shift-]` | Root action |
| `model.change` | — | Opens the Models palette mode |
| `provider.manage` | — | Opens the Providers palette mode |
| `settings.search` | — | Opens the Settings palette mode |

`Command-K` is app-local. By default it does not steal input from the terminal, an open
dialog, an active shortcut recorder, IME composition, or another surface that already
prevented the event. The native menu may expose **Command Palette…**, but it routes to
the same command ID.

## Command catalog

Define static metadata separately from runtime handlers:

```ts
type CommandScope =
  | "app"
  | "chat"
  | "terminal"
  | "environment"
  | "fileEditor"
  | "settings";

type CommandExecutionDomain = "renderer" | "main" | "global";

interface CommandDefinition {
  id: CommandId;
  title: string;
  category: string;
  keywords: readonly string[];
  defaultBindings: readonly string[];
  scope: CommandScope;
  executionDomain: CommandExecutionDomain;
  allowRepeat: boolean;
  allowInEditable: boolean;
  showInPalette: boolean;
  showInSettings: boolean;
  menuPlacement?: "app" | "file" | "view";
}
```

Dynamic availability, labels, and handlers are registered at runtime against stable
command IDs. Static metadata remains importable by main and renderer without importing
React or Electron-only modules.

The catalog is the source for defaults and presentation. User configuration stores only
versioned overrides and explicit disabled tombstones.

## Command-K palette

### Interaction model

The palette opens centered over the active app surface and contains:

1. one search input;
2. a breadcrumb when the user enters a nested mode;
3. grouped, ranked results;
4. the effective shortcut and availability state for each command;
5. a short preview or consequence description when selection needs explanation.

Keyboard behavior:

- `Command-K` opens or closes the root palette.
- Escape returns from a nested mode, then closes from the root.
- Up/Down changes selection.
- Return invokes the selected enabled result.
- Left/Backspace on an empty nested query returns to the previous mode.
- Tab stays inside the palette without becoming an alternative selection mechanism.
- Opening focuses and selects the query; closing restores prior focus when it still
  exists.
- Repeated, composing, dead-key, and already-prevented events do not invoke commands.
- Reduced Motion removes scale/translation while retaining a quiet opacity transition.

The open palette is the highest local shortcut scope. Background shortcuts do not fire
while it is open, except its own close command and native accessibility behavior.

### Root mode

Root results combine stable commands and entry points:

- New chat
- Search chats
- Change model
- Manage providers
- Quick settings
- Open workspace in preferred editor
- Toggle sidebar
- Toggle terminal
- Open Environment
- Open Keyboard Shortcuts

Ranking order:

1. exact title or alias match;
2. prefix match;
3. keyword match;
4. fuzzy title match;
5. recent successful palette use as a bounded tie-breaker.

Recent usage is device-local and stores command IDs only. It must not store chat titles,
queries, API keys, workspace paths, or provider secrets.

### Chats mode

Chats mode searches the same ordered chat data used by the sidebar. Results show:

- title;
- workspace label when it disambiguates identical titles;
- pinned/archived state where relevant;
- current-chat indication.

Selecting a chat uses the existing navigation path. Search is local and incremental;
opening the palette performs no network request. Empty, loading, and failed chat-list
states must be explicit.

The first release searches already loaded/local chat metadata. Full-message search is a
separate indexed-search project and must not be implied by the placeholder or copy.

### Models mode

Models mode uses the same provider/model catalog, availability facts, selected model
state, and mutation path as the composer model picker.

Each result shows:

- model display name;
- provider identity;
- local/hosted status when meaningful;
- current selection;
- unavailable or needs-attention state.

Selecting an available model updates the canonical composer selection immediately and
closes the palette. It must not maintain palette-only model state. Disabled models remain
discoverable with a truthful reason and a route to the relevant provider settings.

The palette must not silently select a fallback model when the requested model becomes
unavailable between rendering and invocation.

### Providers mode

Providers mode is a safe management launcher, not a credential editor.

Supported results may include:

- Open Providers settings
- Open a specific provider's settings
- Connect or sign in, when that provider already exposes an explicit flow
- Refresh provider status
- Refresh the model catalog through the existing explicit development/runtime boundary
  appropriate to that provider
- Resolve a provider that needs attention

API keys, OAuth codes, destructive disconnects, provider removal, and complex endpoint
editing stay in the full Settings surface. The palette never captures or displays
secrets. A connection action must name the provider before starting an external flow,
show progress, and report cancellation or failure without claiming success.

The palette reads cached provider state on open. Network work occurs only after the user
chooses an explicit Connect, Sign in, or Refresh action.

### Quick Settings mode

Quick Settings combines:

- destinations for every Settings section;
- a small allowlist of reversible, immediately truthful toggles;
- the Keyboard Shortcuts destination.

Initial direct toggles should be limited to settings whose runtime behavior already
exists and whose consequences fit in one line. Theme selection is a reasonable first
candidate. Provider credentials, tool permissions, Full Access, computer-use enablement,
and future Assistant proactivity controls are navigation results, not one-keystroke
toggles.

Every direct toggle uses the existing validated settings mutation, shows its current
state, disables while saving, and remains open on failure so the user can read the error.

## Shortcut resolution

Use one canonical parser/formatter for recording, persistence, matching, menus, labels,
and ARIA metadata.

Resolution order:

1. shortcut recorder;
2. open modal or palette;
3. focused file editor;
4. focused terminal;
5. open Environment work surface;
6. active chat;
7. application shell.

The dispatcher takes one complete context snapshot. It checks exact modifiers,
availability, editable-target policy, repeat policy, composition state, and
`defaultPrevented` before invoking one command. Once claimed, it prevents default and
stops propagation.

Conflicts are evaluated by normalized shortcut plus intersecting typed scopes. Internal
conflicts are blocked unless the user explicitly chooses **Replace existing shortcut**.
Do not use “latest rule silently wins.”

## System-wide registration

Replace the current unregister-everything flow with a serialized transaction:

1. normalize and validate the proposed accelerators;
2. reject reserved and internal collisions before persistence;
3. register changed accelerators without dropping unrelated working registrations;
4. on failure, restore the previous known-working accelerator;
5. persist only the resolved configuration;
6. return `{ active, accelerator, errorReason }` for every global command.

The Focus, Voice, Assistant, and Keyboard Shortcuts settings surfaces all consume this
same status. Disposal unregisters only accelerators owned by Aiden's manager.

The focus-composer global command must await window creation and renderer readiness
before broadcasting, matching the safer Assistant-open path.

## Settings ownership

**Keyboard shortcuts** is the canonical editor for every binding:

- searchable command/category/key list;
- global versus in-app badge;
- record, cancel, clear, reset, and replace-conflict actions;
- active/unavailable status for global bindings;
- accessible pressed-key preview and `aria-live` validation;
- per-command “Default,” “Custom,” or “Disabled” source.

Voice and Aiden Assistant settings retain their feature explanations and show their
current shortcut/status, but render a shared summary row or navigate to Keyboard
Shortcuts. They do not own independent recorder or persistence implementations.

## Native menus and visible labels

Product menu items route through command IDs and use derived effective accelerators.
Standard Electron roles—copy, paste, undo, hide, quit, zoom, fullscreen, and window
management—remain native.

Buttons and menu items use derived shortcut labels. Rebinding a command updates its
tooltip, menu accelerator, palette row, hint, and `aria-keyshortcuts` without manual
string changes.

## Persistence and migration

Persist a versioned map of overrides:

```ts
interface KeybindingOverridesV1 {
  version: 1;
  commands: Partial<
    Record<CommandId, { bindings: string[]; disabled?: boolean }>
  >;
}
```

Migrate these legacy settings:

- `shortcutEnabled`
- `shortcutAccelerator`
- `dictationEnabled`
- `dictationAccelerator`
- `assistant.hotkeyEnabled`
- `assistant.hotkeyAccelerator`

Migration is idempotent. Preserve the existing defaults and continue reading legacy
fields until the new write has succeeded. Unknown future command IDs are preserved but
ignored so downgrades do not erase user choices.

## Implementation phases

### Phase 0 — registration and focus safety

- Add accelerator normalization and reserved-key validation.
- Detect global/global and global/local collisions.
- Make registration serialized and rollback-safe.
- Return structured status for all three global hotkeys.
- Fix the focus-composer cold-window readiness race.
- Add focused manager/parser tests before exposing broader customization.

Exit gate: a failed rebind cannot remove a previous working shortcut or produce a false
success message.

### Phase 1 — catalog and dispatcher

- Add shared command IDs, metadata, defaults, and parser/formatter.
- Add the authoritative renderer command context.
- Install one capture-phase dispatcher.
- Migrate sidebar, terminal, Environment, chat jumps, editor save, settings, and preferred
  editor actions without changing defaults.
- Preserve component-native keyboard behavior.

Exit gate: product shortcuts have no independent document listeners or hard-coded
visible labels.

### Phase 2 — Command-K foundation

- Implement the accessible palette shell, focus lifecycle, root search, ranking, and
  command invocation.
- Add New Chat, panel toggles, Settings, Keyboard Shortcuts, and preferred editor.
- Add the native **Command Palette…** menu item derived from the catalog.
- Add empty/error/no-results states and keyboard-only tests.

Exit gate: `Command-K` can discover and execute the migrated root commands without
triggering background shortcuts or stealing terminal behavior.

### Phase 3 — chats, models, providers, and quick settings

- Add nested Chats, Models, Providers, and Quick Settings modes.
- Reuse canonical chat navigation and model selection.
- Add safe provider navigation, connect, status, and explicit refresh actions.
- Add a narrow allowlist of direct quick-setting mutations.
- Add stale-state revalidation immediately before invocation.

Exit gate: model changes are reflected in the composer, provider actions report their
real outcome, and opening the palette performs no network or credential operation.

### Phase 4 — canonical shortcut settings

- Replace the three recorder implementations with one accessible component.
- Add searchable bindings, conflict replacement, reset, disable, provenance, and global
  status.
- Convert Aiden Assistant and Voice pages to shared summaries/deep links.
- Add legacy migration and round-trip coverage.

Exit gate: each command has one persisted binding source and one recorder implementation.

### Phase 5 — derived consumers and polish

- Derive native product menus, tooltips, ARIA metadata, chat-number hints, and palette
  shortcut labels.
- Add recent-command tie-breaking without sensitive query persistence.
- Complete reduced-motion, high-contrast, narrow-window, IME, and keyboard-only QA.

## Test plan

### Pure contracts

- catalog ID uniqueness and default validity;
- parser/formatter/ARIA round trips;
- exact modifier and physical-key matching;
- typed-scope intersection and conflict replacement;
- explicit disabled tombstones;
- unknown-command preservation.

### Global manager

- enable/disable and unchanged registrations;
- internal collision rejection;
- OS registration failure and rollback;
- concurrent mutation serialization;
- owned-only disposal;
- persistence/restart and legacy migration;
- cold-window focus and Assistant-open readiness.

### Renderer dispatcher

- scope precedence;
- editable targets;
- terminal focus;
- open dialogs and palette;
- repeated, composing, dead-key, and prevented events;
- one command invocation per event;
- derived label updates after rebind.

### Command palette

- open/close/focus restoration;
- nested-mode Escape and empty-query Backspace;
- ranking and no-results behavior;
- local chat search;
- model selection and stale availability;
- provider connect/refresh progress and failure;
- quick-setting success and rollback;
- no network or secret access merely from opening/searching;
- menu, palette, tooltip, and settings parity.

### Manual keyboard-only matrix

- default and rebound shortcuts;
- terminal/editor/modal/palette focus;
- compact and wide windows;
- Voice and Assistant global hotkeys from another app;
- IME composition and non-US layouts;
- VoiceOver announcements;
- Reduce Motion and increased contrast;
- OS-level accelerator conflict followed by successful rollback.

## Acceptance criteria

- `Command-K` opens one responsive, keyboard-complete palette.
- Chats, models, providers, settings, and stable app commands are discoverable without
  duplicating state or handlers.
- Changing a model in the palette changes the canonical composer model.
- Provider actions are explicit, secret-safe, and truthful about progress and failure.
- Opening or searching the palette performs no network operation.
- Rebinding updates Settings, menus, tooltips, palette labels, hints, and ARIA metadata.
- A failed system-wide rebind preserves the previous working shortcut.
- No product command has multiple independent keyboard listeners or persistence paths.
- Component-native text, dialog, list, and resizing semantics remain intact.
