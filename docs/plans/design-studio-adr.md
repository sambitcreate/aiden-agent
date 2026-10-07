# ADR-DS: Design Studio architecture

Status: Proposed (Phase 0 deliverable; needs owner approval)
Date: 2026-10-07
Baseline: `main` @ `bd232b85`
Parent plan: [Design Studio + Create Images rebuild](design-studio-create-images-rebuild-plan.md) §6 ADR-DS and §8 Track DS
Depends on: [ADR-F, Studio Foundation](studio-foundation-adr.md). This ADR assumes ADR-F provides the `designStudio` capability, the lazy `/design` root route, the sidebar "Create" row, the `renderer/canvas/` kit (`<StudioCanvas>` on pinned `@xyflow/react`), the content-addressed `studio-assets` store with the `aiden-asset:` protocol, and the central hidden-chat visibility predicate (the chat `owner` field / `isUserVisibleChat()`). This ADR does not redefine any of them.
Supersedes: [Designer Mode plan](designer-mode-plan.md), which becomes DS-4. Its Phase 0 GO gate still applies.

## 1. Project model: a project owns one hidden chat

| Option | What it reuses | What it costs |
|---|---|---|
| **A. A first-class project record that owns one hidden chat** (`chat.owner = { kind: "design-project", projectId }` from ADR-F) | All of `llmClient.start`: `chatTurnAdmission`, the `active`/`initializing` ownership maps, `chat:cancel` / `detachRenderer`, approvals and questionnaires, `resolveModelRuntime`, usage accounting, `appendChatMessageWithReconciliation`, Pi compaction (`piCompactionSessionStore`), context pressure, and the existing stream notifications (`chat:delta`, `chat:status`, `chat:done`, `chat:error`) | One main-only option on `GenerationExecutionOptions` and one authority check (below). Hidden-chat leakage is handled centrally by ADR-F. |
| B. No chat; a direct llm-client run with its own transcript | Nothing above. `resolveModelRuntime`, stream ownership and the harness construction are internal to `main/services/llm-client.ts` | A second run pipeline covering cancellation, ownership, persistence, compaction, usage and stream protocol. This is the kind of work the old branch needed ~9k LOC of journals for. |

**Decision: A.** The coupling is narrow, and every piece of it is main-owned.

- **Ownership.** `DesignRunService` (main) calls `llmClient.start` itself, following the precedent of `AidenRemoteChatService` in `main/services/aiden-remote-service-main.ts`, which runs `beginChatTurn` → `chatApplicationService` append → `startGenerationAndMaybeTitle`. The renderer never calls `chat:start` or `chats:appendMessage` for a project chat. The title step is skipped, because the project owns its title.
- **Authority.** `authoritativeChatGenerationMode` (`main/services/chat-workspace-authority.ts`) already derives the mode from the persisted chat rather than from renderer params. It is extended so that a design-owned chat **throws** unless `options.designRun.projectId` matches `chat.owner.projectId`. `chats:appendMessage` and `chat:admitRunInput` reject design-owned chats, so there is no steering or follow-up in DS-1. Without this check, a renderer could start the hidden chat through ChatPane and get the full workspace tool set.
- **Lifecycle.**
  - The chat is created with the project, through `chatApplicationService`, with `owner` set and no workspace.
  - Deleting the project marks the manifest `deleting`, deletes the chat through the existing chat-deletion path (which `reconcilePendingChatDeletions` resumes after a crash), then removes the project directory.
  - If the chat is missing at the next run, a new empty one is created.
- **Cardinality.** One chat per project, not one per Screen. The transcript is the project's conversation. The project store, not the transcript, is the source of truth for Screens and revisions.

## 2. Storage layout, concurrency and recovery

```
<userData>/design-projects/<projectId>/manifest.json        writeJsonAtomic, ≤ 1 MiB
<userData>/design-projects/<projectId>/revisions/<revId>.html  writeFileAtomic, immutable
references → studio-assets (ADR-F), held by owner ref "design:<projectId>"
```

- **No index file.** `initialize()` reads every manifest (at most 250, typically ~20 KiB each) into a memory cache. The store is the only writer, so the cache never goes stale and listing needs no disk read. Exports go to a path the user picks and are not stored.
- **Schema v1 only.** One parser, `parseDesignProjectManifestV1`, built on `hasExactKeys` / `isRecord` from `main/shared/guards.ts`. There is no migration code. Later phases add only **optional** fields (`designLanguage` in DS-2, `referenceAssetIds` in DS-3, `connection` in DS-4), which old files still satisfy. A manifest that fails to parse shows as "Unreadable" in the library and is **never auto-deleted**.

```ts
interface DesignProjectManifestV1 {
  schema: 1; id: string; revision: number /* CAS */; title: string;
  chatId: string; state: "active" | "deleting"; createdAt: number; updatedAt: number;
  canvas: { viewport: { x: number; y: number; zoom: number };
            nodes: { id: string; kind: "screen"; screenId: string; x: number; y: number }[] };
  screens: Record<string, { id; title; frame: { preset: FramePreset; width; height };
            revisionIds: string[]; activeRevisionId: string; directionSetId?: string; createdAt }>;
  revisions: Record<string, { id; screenId; parentRevisionId?: string; runId; toolCallId;
            title; bytes; sha256; state: "draft" | "published" | "missing"; createdAt;
            model: { providerId: string; model: string } }>;
  directionSets: Record<string, { id; runId; requestedCount: 2 | 3 | 4; screenIds: string[];
            chosenScreenId?: string; archived: boolean }>;
  runs: Record<string, { id; kind: "explore" | "refine"; turnId; request: DesignRunRequest;
            status: "running" | "complete" | "partial" | "cancelled" | "interrupted" | "failed";
            revisionIds: string[]; startedAt; endedAt? }>;   // newest 100 kept
}
```

- **Concurrency.**
  - Each project has a keyed serial gate (`DesignProjectGate.run(projectId, op)`, the `BotMutationGate` pattern in `main/services/bot-mutation-gate.ts`, but deleting a settled tail). Every mutation, run start, artifact acceptance and delete goes through it.
  - Renderer mutations carry `expectedRevision`. A stale revision returns `{ ok: false, reason: "stale", snapshot }`; there is no silent last-write-wins.
- **Crash consistency.** Writes always go in this order: the revision file (`writeFileAtomic`, fsync), then the manifest (`writeJsonAtomic`). The manifest is the commit point.
  - A file the manifest does not reference is garbage and is deleted at startup.
  - A file the manifest references that is missing, or whose sha256 does not match, is marked `missing` and shown as broken. It never crashes the project.
- **Run ordering.** `beginChatTurn`, then append the user message, then write `runs[id] = running` into the manifest, then `llmClient.start`.
  - A crash after the append but before the run record leaves an orphan user message, which the context builder ignores.
  - The reverse order cannot happen.
- **Restart recovery.** `designProjectStore.initialize()` runs in the `main/index.ts` reconcile chain, next to `generativeUiArtifactStore.initialize()` and before `openProcessStartupIpcAdmission()`. It:
  1. Moves runs from `running` to `interrupted`. Their accepted drafts are kept and stay visible, with an "Interrupted · Keep / Discard / Retry missing" banner.
  2. Never resubmits a run automatically. Retry is an explicit new run whose output cap is the number of missing directions.
  3. Resumes any `deleting` cascade.
  4. Garbage-collects unreferenced revision files.
- **Perf lane.** Opening and saving a project with 200 revisions takes under 200 ms of store time. A mutation writes only the manifest and never rewrites HTML.

## 3. Revisions live in the project store, served through `aiden-genui:`

**Decision:** Design revisions are **not** stored in `generative-ui-artifact-store.ts`.

That store keeps HTML inline in one `DataStore` JSON file that is rewritten on every mutation. It has global caps (2,000 records, 200 uncommitted), and `stage()` enforces the per-chat limits `MAX_HTML_ARTIFACTS_PER_CHAT = 40` and `MAX_HTML_ARTIFACT_BYTES_PER_CHAT = 8 MiB` from `renderer/shared/generative-ui.ts`. To work around this, the old branch grafted on `designOwnership`/`designPublication` (+505 lines, a four-state publication machine plus `design-artifact-recovery.ts` at 922 lines).

**Serving.**
- A project-aware resolver, `wrapDesignRevision({ projectId, revisionId, theme })` in `main/services/design/design-preview.ts`, mirrors `wrapStoredHtmlArtifact` in `gui-artifact-recovery.ts`. It reads the revision file, checks its sha256, and calls `wrapGenerativeUiHtml` and then `registerGenerativeUiPreviewDocument`. Preview tokens are single-document and expire after 30 minutes.
- DS-1.3 adds an optional `csp` argument to `registerGenerativeUiPreviewDocument` for the design guest CSP (React Grab host library). The default `GENERATIVE_UI_GUEST_CSP` and the scheme registration are unchanged.
- Chat artifacts never see design revisions: a design run sends no `chat:artifact` events and stores nothing in `htmlArtifacts`.

**Project-scoped quota** (in `renderer/shared/design/limits.ts`, enforced in `acceptRunArtifact` under the project gate):

| Limit | Value | Notes |
|---|---|---|
| Revision size | 256 KiB | Below the chat 512 KiB because the context builder must be able to include a base revision |
| Artifacts per run | Explore N ∈ {2, 3, 4}; Refine 1 | Same ceiling as `MAX_HTML_ARTIFACTS_PER_RESPONSE = 4` |
| Revisions per Screen / per project | 100 / 400 | Old caps were 100 per artboard and 250 nodes |
| Screens per project | 64 | |
| Revision bytes per project | 64 MiB | 8× today's chat ceiling; Explore 4 × 30 KiB fits ~500 turns |
| Projects / total design bytes | 250 / 2 GiB | A clear error names the project to clean up |

Archiving a direction set hides it but does **not** free quota. Deleting a Screen or a revision branch does, after a confirmation that shows the bytes freed.

## 4. Agent runtime: the `design` profile

**Plug point.**
- `GenerationExecutionOptions` (`llm-client.ts`) gains `designRun?: DesignRunBinding = { projectId, runId, request, contextMessage }`. It is main-only, like `interactionSurface`, and `parseParams` can never produce it.
- `resolveGenerationProfile(chat, options)` in a new pure module, `main/services/generation-profile.ts`, returns `{ kind: "default" } | { kind: "design", … }`.
- `prepareGeneration` gets **one** branch. When the profile is `design`, it skips `buildAgentTools`, MCP, ask_user, display_image, model operations, the chat generative-UI extension and workspace tool outputs. It then calls a `createGenerationHarness(…)` helper, split out of the existing `new PiAgentRuntimeHarness({…})` block (llm-client ~2690), with `tools: []`, `extensions: [designExtension]` and the design system prompt.
- `createGenerationHarness` asserts that the composed tool names are a subset of `profile.toolAllowlist`, and throws otherwise. This one invariant replaces scattered `!design` checks.

**Allowlist.**
- DS-1: `render_artifact` only. This is the design variant in `main/services/design/design-render-extension.ts`. It takes HTML only (no workspace `path`) and reuses `validateGenerativeUiHtml`, `requireGenerativeUiTitle` and `htmlArtifactByteLength`.
- DS-3: image generation stays UI-initiated through Create Images' service and consent sheet; it is not an agent tool.
- DS-4 adds a separate `design-connected` profile with read tools and a proposal tool. A design-profile `generate_image` is DS-5+ and must use CI consent, not chat approval.
- `usageSource` gets a new `"design"` category in `UsageRequestSource`.

**`finishTurn`.**
- `PiAgentRuntimeExtension` (`pi-agent-runtime-harness.ts:76`) has no `finishTurn` today. The host option passes through only because `...agentOptions` is spread into `new Agent`.
- Add an optional `finishTurn` to the extension interface. The harness composes it: on `error`/`aborted` it returns early without calling any extension; otherwise, if any contributor returns `{ action: "end" }`, the run ends; `continue` is ignored for extensions.
- The design extension returns `end` when any of these holds:

| Condition | Run status |
|---|---|
| Accepted artifacts = N (Explore N, Refine 1). This ends before Pi spends a summary request. | `complete` |
| Render calls ≥ 2N, counting rejected and invalid calls | `partial` |
| Provider turns ≥ N + 2 | `partial` |
| The model stopped with text only and fewer than N accepted (Pi ends naturally) | `partial` (offers Retry missing) |

- The tool also rejects any call past N (with `terminate: true`) and allows same-title replacement at most N times.
- On user cancel, the host shows a Keep / Discard sheet. Keep publishes the partial drafts; Discard deletes them under the project gate.

**Bounded context builder.** This lives in `main/services/design/design-context-core.ts` (pure, Electron-free) and is applied through the extension's `transformContext`.
1. Every historical `render_artifact` `html` argument is replaced with `[design revision <revId> omitted]`, matched through `revision.toolCallId`.
2. One synthetic user message is inserted before the current turn, wrapped in `<design_context trust="untrusted">…</design_context>`, with closing tags inside it escaped. The design system prompt says this content is data, never instructions. It contains, in priority order:
   - the run request (op, N, creative range, aspects);
   - up to 5 selection targets, at most 2 KiB each;
   - the full HTML of the base revision. If that is over 96 KiB, inline `<script>` bodies and `data:` URIs are stripped deterministically, and if it is still too large the run is refused before it starts;
   - `DESIGN.md` (DS-2), up to 24 KiB.
3. The total budget is **128 KiB**. Going over it fails preflight; content is never silently truncated.
4. Ordinary compaction still applies to the conversation text, which is one of the benefits of using a chat.

**Model selection.** The existing `ModelPicker` + `useModelSelection` (app-wide) and `ThinkingControl`, with per-model thinking settings exactly as in ChatPane. `providerId`, `model` and `thinkingLevel` go with each `designProjects:run` and are validated by the same rules as `parseParams`. The provider and model are recorded on each revision.

## 5. Renderer architecture (`renderer/design/`, lazy, CSS imported only by the route)

**Composer reuse without ChatPane.** No hook exists today for sending and streaming a turn outside ChatPane: ChatPane and `useAssistantChat` (874 lines, unused outside its tests) each call `startGeneration` (`renderer/lib/ipc.ts`). DS-1 makes one refactor in `ipc.ts`: it extracts the subscription half of `startGeneration` into `subscribeGenerationStream(streamId, callbacks)` in `renderer/lib/generation-stream.ts`. `startGeneration` keeps calling it, so ChatPane's behavior is unchanged and covered by `ipc-stream.test.ts`. `useDesignRun` then subscribes first and invokes `designProjects:run` second, so no opening tokens are dropped, and cancels through the existing `chat:cancel`.

`Composer` (`renderer/components/composer.tsx`) is already reused standalone by `RemoteChatView`. Design passes:
- `chatId = project.chatId` (the draft key);
- `surfaces = DESIGN_COMPOSER_SURFACES`, with attachments, slash commands and local context turned off;
- `onSend`, wired to `useDesignRun.send`;
- `modelPicker` and `thinkingControl` slots.

The only Composer change is an optional `contextChips?: ReactNode` slot, covered by a render test.

| Module (`renderer/design/…`) | Responsibility | Budget (lines) |
|---|---|---|
| `design-route.tsx` | Replaces the placeholder from ADR-F; `/design` → library, `/design/$projectId` → project | 120 |
| `library/design-library-view.tsx`, `project-card.tsx`, `delete-project-dialog.tsx` | List, create, rename, duplicate; delete with a cascade preview | 300 / 150 / 150 |
| `project/design-project-view.tsx` | Layout shell: canvas, inspector, conversation panel, composer dock | 250 |
| `canvas/design-canvas.tsx`, `screen-node.tsx`, `direction-set-group.tsx` | Built on `<StudioCanvas>`; Choose / Archive actions on direction sets | 350 / 250 / 200 |
| `frame/design-screen-frame.tsx` | Reuses `HtmlArtifactIframe` from `html-artifact-frame.tsx` (exported, not copied); keeps at most 6 live iframes (LRU + IntersectionObserver) and shows placeholders for the rest | 200 |
| `composer/design-composer.tsx`, `run-mode-control.tsx`, `design-context-chips.tsx` | Composer and pickers; Explore count / creative range / Refine; chips that apply to one turn | 250 / 200 / 150 |
| `run/design-run-status.tsx`, `cancelled-run-sheet.tsx`, `interrupted-run-banner.tsx` | Live status; Keep / Discard; Retry missing | 200 / 150 / 120 |
| `inspector/design-inspector.tsx`, `preview-tab.tsx`, `code-tab.tsx`, `history-tab.tsx` | Preview / Code (read-only) / History with compare, Make current, Refine from this | 250 / 150 / 200 / 300 |
| `conversation/design-conversation-panel.tsx` | Text-only `MessageList`; revisions appear as links to their Screens | 200 |
| `hooks/use-design-projects.ts`, `use-design-project.ts` | TanStack Query on `list` / `get`, invalidated by `designProjects:changed`; `mutate` with CAS and rollback on `stale` | 150 / 250 |
| `hooks/use-design-selection.ts` | Wraps the ported `renderer/shared/design-selection.ts` | 150 |
| `hooks/use-design-preview.ts` | Resolves `previewSrc`, theme tokens and the live-frame LRU | 150 |
| `hooks/use-design-run.ts` | Subscribe / send / cancel; run status from `designProjects:run-changed` | 250 |
| `renderer/lib/design-ipc.ts` | Typed client built on `ipc-bridge.ts` `invoke` / `onNotification` (not `ipc.ts`) | 200 |

Shared, Electron-free code goes in `renderer/shared/design/` (`types.ts`, `ops.ts` (union + parser), `limits.ts`, `selection.ts`). Main code goes in `main/services/design/` (`store-core.ts` with pure `applyOp` / `acceptArtifact` / `reconcile`; `store.ts` with fs and the gate; `run-service.ts`; `design-render-extension.ts`; `design-context-core.ts`; `design-preview.ts`) and `main/handlers/design/` (`projects.ts`, `run.ts`, `params.ts`). Every file stays at or under 800 lines and every component at or under 400.

## 6. IPC (≤ 25 channels; `ipcMain.handle` only; `rendererDocumentOwner` on run and preview)

| # | Channel | Request → Response | Phase |
|---|---|---|---|
| 1 | `designProjects:list` | `{}` → `DesignProjectSummary[]` (`{ id, title, updatedAt, screenCount, bytes, health: "ok" \| "unreadable" \| "interrupted" }`) | DS-1 |
| 2 | `designProjects:get` | `{ projectId }` → `DesignProjectSnapshot` (manifest projection, no HTML) | DS-1 |
| 3 | `designProjects:create` | `{ title? }` → `DesignProjectSnapshot` | DS-1 |
| 4 | `designProjects:duplicate` | `{ projectId }` → `DesignProjectSnapshot` (new chat, copied revision files) | DS-1 |
| 5 | `designProjects:mutate` | `{ projectId, expectedRevision, op: DesignProjectOp }` → `{ ok: true, snapshot } \| { ok: false, reason: "stale" \| "quota" \| "invalid", snapshot }` | DS-1 |
| 6 | `designProjects:previewDelete` | `{ projectId }` → `{ screens, revisions, bytes, references }` | DS-1 |
| 7 | `designProjects:delete` | `{ projectId, expectedRevision }` → `void` | DS-1 |
| 8 | `designProjects:run` | `{ projectId, streamId, request: DesignRunRequest, prompt, chips: DesignContextChip[], providerId, model, thinkingLevel? }` → `{ accepted, runId, error? }` | DS-1 |
| 9 | `designProjects:previewSrc` | `{ projectId, revisionId, theme }` → `{ src, title }` | DS-1 |
| 10 | `designProjects:readSource` | `{ projectId, revisionId }` → `{ html, bytes }` | DS-1 |
| 11 | `designProjects:export` | `{ projectId, scope: "project" \| { screenId } }` → `{ saved, canceled }` | DS-2 |
| 12 | `designProjects:designLanguagePreview` | `{ projectId, source: { kind: "import" } \| { kind: "derive", revisionId } }` → `DesignLanguagePreview` | DS-2 |
| 13 | `designProjects:putReference` | `{ projectId, attachmentId }` → `{ assetId }` (via studio-assets) | DS-3 |
| 14 | `designProjects:generateReferenceImage` | `{ projectId, consentToken, … }` → CI service result | DS-3 |
| 15–21 | `designConnected:startPreview`, `stopPreview`, `previewState`, `bindSelection`, `proposeAction`, `applyAction`, `undoAction` | Shapes are set by the DS-4 Phase 0 ADR | DS-4 |

Four channels are held in reserve (22–25). Cancel, approvals and questionnaires reuse `chat:cancel`, `chat:approve` and `chat:answerQuestionnaire`, all owner-checked.

```ts
type DesignRunRequest =
  | { op: "explore"; count: 2 | 3 | 4; creativeRange: "close" | "balanced" | "bold";
      aspects: ("layout" | "color" | "typography" | "content")[]; baseRevisionId?: string;
      retryRunId?: string }                               // the cap becomes the missing count
  | { op: "refine"; screenId: string; baseRevisionId: string };
type DesignProjectOp =
  | { op: "rename"; title: string }
  | { op: "setLayout"; viewport: Viewport; nodes: { id: string; x: number; y: number }[] } // debounced
  | { op: "setActiveRevision"; screenId: string; revisionId: string }
  | { op: "setScreenFrame"; screenId: string; frame: ScreenFrame }
  | { op: "chooseDirection"; directionSetId: string; screenId: string }
  | { op: "archiveDirectionSet"; directionSetId: string; archived: boolean }
  | { op: "deleteScreen"; screenId: string }
  | { op: "settleRun"; runId: string; decision: "keep" | "discard" }  // cancelled or interrupted
  | { op: "applyDesignLanguage"; snapshot: DesignLanguageV1 }          // DS-2
  | { op: "removeReference"; assetId: string };                       // DS-3
```

`parseDesignProjectOp` is one exact-keys parser, tested by calling it with fixtures. **Notifications:**
- `designProjects:changed` `{ projectId, revision }`, throttled with `createThrottledTrigger`.
- `designProjects:run-changed` `{ projectId, runId, status, acceptedRevisionIds }`, sent on each acceptance and on settle. A subscriber re-reads `get` to get the full snapshot.

## 7. Port, rewrite or drop (old paths are in `ref-design-studio`)

| Old | Disposition | New home |
|---|---|---|
| `renderer/shared/design-selection.ts` (573, Node-free, 16 tests) | **Port as-is**; cut its import of `design-workspace` down to the needed types | `renderer/shared/design/selection.ts` |
| `main/services/design-project-export-core.ts` (499), `design-language-core.ts` (120), `design-prototype-core.ts` (58) | **Port** in DS-2 / DS-5+, with their behavioral tests; export uses an explicit allowlist of fields | `main/services/design/` |
| `design-direct-edit-core.ts` (578), `design-source-graph-core.ts`, `renderer/shared/source-designer.ts`, `source-preview-transport-core.ts`, `source-preview-websocket-proxy.ts`, `tests/fixtures/source-design-vite` | **Port** in DS-4, after the GO gate | `main/services/design/connected/` |
| System-prompt Explore/Refine wording; the strip-HTML-and-inject-untrusted context pattern (old `transformContext`, 128 KiB / 5 targets / 2 KiB) | **Port the ideas**, re-implemented in pure `design-context-core.ts` | §4 |
| `design-project-store.ts` (1,855) + `-contract.ts` + `-contract-v2.ts` + `-v2-policy.ts`, `design-project-lifecycle.ts` (538) | **Rewrite** as one v1 schema with files plus manifest (target < 600 lines core + < 300 lines io) | `main/services/design/store*.ts` |
| `main/handlers/designer.ts` (2,123; 68 handlers / ~71 channels) | **Rewrite** to ≤ 25 channels | `main/handlers/design/` |
| `design-workspace.tsx` (4,761), `design-project-inspector.tsx` (663), `chat-pane.tsx` `presentation="design"` (+2,046), `chat-layout.tsx` (+339) | **Rewrite** as `renderer/design/` modules ≤ 400 lines; **zero** ChatPane / chat-layout edits | §5 |
| `generative-ui-extension.ts` design mode (+358; `shouldStopAfterTurn`) | **Rewrite** as a separate design render extension with `finishTurn` | `design-render-extension.ts` |
| `generative-ui-artifact-store.ts` `designOwnership` / `designPublication` (+505), `design-artifact-recovery.ts` (922), `design-generation-publication.ts` | **Drop**; revisions live in the project store | – |
| `DESIGN_PROJECT_CHAT_WORKSPACE_ID = "design-projects"` and its exclusions | **Drop**; replaced by ADR-F `owner` | – |
| V1→V2 migration, legacy-chat migration, CDP prototype verification, export-history store, handoff journal and effect store (`design-handoff-*`), multi-file coordinator (1,115), design-system snapshots (1,182), comments store, `preflightGeneration` / `generationProvenance` channels | **Drop** (some are DS-5+ candidates that must be re-justified) | – |
| ~660 source-grep assertions | **Drop**; replaced by behavioral tests | – |

## 8. Phases (adjusted from plan §8)

| Phase | Scope | Exit criteria |
|---|---|---|
| **DS-1a Headless core** (PR 1) | Store and reconcile; gate; quota; `generation-profile.ts`; design render extension; harness `finishTurn` composition; context core; `DesignRunService`; IPC 1–10; `subscribeGenerationStream` extraction | Behavioral tests: CAS stale, crash between file and manifest write, restart → `interrupted` with drafts kept and **no new provider request** (a fake model counts requests), orphan GC, quota errors, Explore N stop with the summary request counted as 0, the 2N runaway stop, error/aborted guarded, a renderer `chat:start` on a design chat rejected, the allowlist invariant, 128 KiB refusal. Store perf lane: 200 revisions. ADR-F projection tests stay green with a design chat present; the iOS/Android contract suites run. |
| **DS-1b Studio UI** (PR 2) | `renderer/design/` modules; React Grab vendoring and design CSP (DS-1.3); inspector; Playwright | Playwright on macOS and xvfb: create → explore (fake model) → choose → refine → quit mid-run → relaunch → interrupted banner → Keep; flag off → no route and unchanged bundle budget; React Flow lazy; keyboard and `focus-visible` checks. |
| **DS-2 Export + Design Language** | IPC 11–12; `applyDesignLanguage` op; DESIGN.md in the context builder | Byte-identical export across runs; a hostile ZIP path and a hostile DESIGN.md fail closed; an e2e covers export and apply. |
| **DS-3 References + image** (after CI-1 and CI-1.10) | Reference nodes on the canvas (moved out of DS-1); IPC 13–14 through the CI consent sheet | A consent e2e; a request-counting fake proves cancelled consent sends 0 requests. |
| **DS-4 Connected app** | `design-connected` profile; IPC 15–21 | **Entry gate:** a written GO against the [Designer Mode Phase 0 GO criteria](designer-mode-plan.md#go-criteria): correct definition or explicit ambiguity, HMR rebind-or-stale, workspace byte- and Git-unchanged before approval, a malicious guest contained, signed-app start/stop without orphans, and the point→prompt loop preserved, on `tests/fixtures/source-design-vite`. The license and provenance ledger must also exist, and scope is Vite + React only. **Exit:** as in plan §8 DS-4. |
| **DS-5+** | Comments, prototype links (click-to-pick, no CDP), handoff via managed worktrees, multi-file actions, Next.js | Each gets its own ADR line and e2e. |

DS-1 is split into two PRs because it is the largest phase, and the headless half can be reviewed and land without the UI. Both stay behind `designStudio`.

## 9. Owner decisions (2026-10-07)

All five recommendations were adopted: project chats stay hidden everywhere through DS-3; the quotas stand as proposed; Explore defaults to 3 (range 2–4); archiving does not free quota; the model follows the app-wide picker.

### Original open questions (for the record)

1. **Do project conversations ever surface outside Design Studio** (sidebar, search, Remote, iOS/Android)? *Recommend no for DS-1..DS-3.* ADR-F hides them everywhere; mobile Design is a separate decision.
2. **Are the quotas acceptable?** (64 MiB and 400 revisions per project, 256 KiB per revision, 2 GiB total.) *Recommend yes*, and revisit after the owner tests real projects.
3. **What is the default Explore count?** *Recommend 3 (range 2–4).* Each direction is a separate model output, so the count multiplies cost and latency.
4. **Does archiving free quota?** *Recommend no.* Archive only hides; deleting a Screen frees its bytes after a confirmation.
5. **Should a project remember its own model,** or follow the app-wide picker? *Recommend app-wide* (matching chat) and showing the model on each revision. Pinning a model per project can wait.

## 10. Risks

| Risk | Mitigation |
|---|---|
| The stored Pi message (`storedPiAssistantMessage`, `pi-message-storage.ts`) and the compaction session may keep full `render_artifact` HTML arguments, which bloats the hidden chat's files | DS-1a measures this on 200 revisions. If it is material, the design profile redacts `html` to the `revId` sentinel at the persistence boundary, since the project store holds the bytes. |
| ADR-F's predicate filters `chatStore.list()` itself, so `main/index.ts` `visibleChatIds` then garbage-collects hidden chats' compaction and effect state | ADR-F must apply the predicate only in projections. DS-1a adds a restart test that a design chat keeps its compaction session. |
| `Composer` (2,703 lines) has hidden ChatPane assumptions | `RemoteChatView` already reuses it. If a needed prop is missing, add only optional slots, each with a render test. |
| The `ipc.ts` stream extraction regresses ChatPane | It is a pure extraction with `startGeneration` delegating to it, and `ipc-stream.test.ts` plus the chat Playwright specs run. |
| Model quality varies across N directions | The fake-model e2e covers the flow. The owner judges live quality each phase using the existing model picker. |
