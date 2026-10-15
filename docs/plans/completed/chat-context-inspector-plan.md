# Chat Context Inspector

Status: Complete locally — 2026-10-07; verification and shutdown-flake caveats tracked with the workspace panel redesign.
Date: 2026-10-07.
Baseline: `origin/main` at `0c708ad94`, fast-forwarded locally before planning.

## Intent and assumptions

Expand the existing context-meter popover into a dedicated, inspectable Context
tab, inspired by the supplied screenshots. Add a persisted setting to show or
hide the composer meter while keeping the detailed view accessible.

Interpret “next to Files” as a Context tab in the existing Environment work
surface alongside Review and Files. Interpret “store context” as retaining
useful session/context information across reopening a chat, not adding a new
memory system or changing what the model receives.

The user accepted the Context addition on 2026-10-07 and expanded the panel
direction into a tool launcher, user-opened tabs and optional Terminal placement.
See [Workspace panel redesign spike](workspace-panel-redesign-spike.md) for the
parent navigation architecture and delivery order. Context should use that
shared tab shell rather than adding another fixed destination button first.

## Source findings before implementation

- `renderer/components/context-meter.tsx` already displays next-request token
  pressure, reserves, estimated composition, and compaction state.
- `renderer/shared/context-pressure.ts` defines `ChatContextPressureV1`;
  `main/services/context-pressure.ts` and `generation-context.ts` derive it
  from the same projection used by the runtime. Keep this authoritative.
- `renderer/lib/context-pressure-feed.ts` protects against stale readings on
  chat, model, draft, and workspace changes. Reuse it for both surfaces.
- `renderer/lib/environment-panel-state.ts` owns the existing work-surface
  destinations. Add Context through this state model and its panel UI.
- Chats already retain metadata, messages, canonical Pi assistant payloads,
  and optional turn statistics in `main/services/types.ts`. Audit retained
  provider-call coverage before claiming complete historical totals.
- `usage.json` is an aggregate store that deliberately excludes chat IDs.
  It cannot provide per-chat totals and must retain that privacy contract.
- `AppearanceConfig.autoHideComposerContext` controls the workspace/branch
  strip. It is unrelated to the token meter; do not repurpose it.

## Proposed experience

1. **Context tab.** Open it from the workspace tool launcher, a chat-level
   “Show context” action, or “View details” in the composer popover. It remains
   reachable when the composer meter is hidden and for folderless chats.
   Reuse the existing pinned/floating panel behavior and focus restoration.
2. **Current context.** Show projected tokens, model window, usable input,
   response/safety reserves, usage percentage, compaction state, and reading
   freshness. Label the percentage as “of usable context,” matching the meter.
   Clearly identify estimates and provider-anchored projections. The current
   “Provider-reported composition” label should become “Estimated breakdown”
   with a separate provider-anchor note: the individual categories are estimates.
3. **Session information.** Show title, provider/model, created/last-activity
   times, and user/assistant message counts. Separately show cumulative input,
   output, reasoning, cache-read/write tokens, and cost when supported by the
   retained records. Label totals by their scope and completeness. Missing cost
   is “Unavailable,” not `$0.00`; historical model changes remain attributable.
4. **Breakdown.** Start with the runtime's conversation and system/tools
   estimates, with a textual legend. Do not stack the “recent work” diagnostic
   on top of categories that already include it. Add finer user/assistant/tool
   shares only if the runtime can supply non-overlapping categories; do not
   invent percentages from message counts or cumulative billing tokens.
5. **Composer preference.** Settings → Appearance → Chat gets a trailing switch
   labeled “Show context usage in composer,” default on to preserve today's
   behavior. Persist a separate `showComposerContextUsage` preference, normalize
   older settings to on, and apply changes immediately. Hiding it only changes
   presentation; runtime compaction and context accounting continue normally.

## Persistence and data boundaries

- Prefer deriving details from existing durable chat/journal data. Avoid a
  second raw transcript file or storing credentials, diagnostics, and prompts
  merely to support the inspector.
- If existing records omit intermediate provider calls, introduce a versioned,
  bounded per-chat accounting summary through the chat persistence layer.
  Account each call once, define parent/child and compaction-call scopes, and
  preserve partial-history status. Do not modify aggregate usage storage to
  add chat identity. Old chats remain readable without fabricated backfills.
- Recompute next-request pressure on reopening. If a last-known snapshot is
  needed for loading states, timestamp and label it stale until refreshed;
  never let saved display data govern runtime limits or compaction.
- Use main-owned, document/chat-authorized IPC and renderer-safe DTOs. Switching
  chats or hosts must invalidate pending results. No provider/catalog fetches,
  MCP connections, or new polling are needed to inspect local information.
- Initial delivery targets local desktop chats. For paired-host chats, show
  explicit unavailability until an authorized host contract supplies the data;
  never estimate remote state from this device's local settings.

## Delivery sequence

1. **Data and accounting:** audit persisted usage coverage, define the inspector
   DTO and completeness rules, implement scoped reads and any necessary bounded
   summary migration. Keep context pressure separate from cumulative usage.
2. **Context panel:** add the destination, entry points, summary, token details,
   accessible breakdown, and loading/empty/unavailable states. Share the live
   projection with the popover and preserve draft/model-switch behavior.
3. **Preference:** wire the Appearance switch through defaults, parsing,
   persistence, live updates, and composer rendering. Keep panel access intact.
4. **Acceptance:** verify the scenarios below, update project memory and this
   index, and archive this plan only after the approved scope is delivered.

The screenshot's expandable raw-message list and Export session action are
suggested follow-on scope, not required for the first delivery. If selected,
use bounded lazy message reads and an explicit local save action with clear
content disclosure; do not export raw runtime journals or credentials.

## Design, onboarding, and verification

Follow `docs/design-guide.md`, both ChatGPT UI references, and
`docs/settings-design-system.md`: semantic tokens, shared squircle actions,
soft status fills, neutral keyboard focus, reduced motion, and responsive
one/two-column details. No decorative colored outlines or brain icons.

- Extend behavioral tests for projection agreement, partial/missing accounting,
  cache/reasoning semantics, model changes, compaction, restart, and stale async
  results after chat/host switches. Verify any new summary against duplicate
  events, forks, deletion, and corrupt/legacy records.
- Extend meter/panel and Environment-state tests; verify keyboard navigation,
  focus restoration, folderless chats, and hidden-meter access.
- Test preference defaults, invalid values, older exports, immediate updates,
  and persistence across relaunch. Extend `test:settings-design` coverage.
- Add Electron interaction coverage for panel entry points, live updates,
  hidden/visible meter, narrow windows, light/dark themes, and reduced motion.
  Register new tests in `package.json` and the applicable CI registry.
- Inspect iOS and Android consumers if shared chat storage/contracts change;
  update affected implementations and run applicable mobile suites. A later
  Remote inspector endpoint requires explicit protocol and native-client work.
- Review the onboarding gallery. This inspector adds no setup requirement;
  update relevant shipped-feature copy if needed. A new advertised capability
  tile must include its own optimized 1024 × 1024 transparent illustration and
  onboarding asset-contract coverage.

Acceptance: popover and inspector agree for the same next request; cumulative
usage is clearly separate; unsupported data is honest; settings survive restart;
and hiding the meter leaves both inspection access and runtime behavior intact.

## Delivery result

The Context tab and independent Appearance switch are implemented in the shared
workspace panel. Existing `AssistantTurnStatsV1` totals already include tool-loop
requests, so no new persistence, IPC, or migration was necessary. Reported totals
show saved-turn coverage and exclude live work and separately run subagents.
Reasoning and cost remain explicitly unavailable because complete renderer-safe
session totals are not stored. Current context comes from the existing pressure
feed and is never conflated with cumulative reported usage.

Electron verifies hidden-meter access and preference persistence across relaunch;
focused tests cover defaults, validation, aggregation, deduplication, partial
coverage, meter rendering and stale pressure updates. No shared Remote or mobile
contract changed. Raw-message inspection/export remain follow-on scope.
