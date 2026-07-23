# Taracodlab Learnings Plan

Status: implementation plan only  
Date: 2026-07-22  
Source audited: `/Users/sambitbiswas/projects/opp/taracodlab-aiden` (`aiden-runtime` ~4.15)  
Aiden baseline: workspace `origin-main` (Electron macOS coding agent on Pi)

## Verdict

taracodlab-aiden is a broader **autonomous-agent platform** (CLI-first runtime, daemon, channels, first-party loop, “moat” safety). Our Aiden is a tighter **macOS workspace product** (in-process Pi, folder permissions, Git/Files/Terminal, native craft).

**Borrow agent reliability and operator clarity. Do not copy their Electron shell, multi-channel stack, or AGPL core patterns as a subsystem.**

One-line product fit: keep conversation primary (`PRODUCT.md`); make tool work legible, honest, and recoverable without turning Aiden into a dashboard OS.

## Outcome

After this plan ships in stages, Aiden should:

1. Keep the chat transcript readable while tool progress, approvals, and verification live in a clear **Activity** surface.
2. Refuse to *imply* tool success when the trace says otherwise (**honesty / claim check**).
3. Compress long contexts at real catalog limits without breaking tool-call chains.
4. Narrow or profile the tool menu so large MCP + skills sets do not bloat every turn.
5. Let the user **queue or redirect** while a generation is running, with truthful busy/interrupted states.
6. Treat MCP tool results as untrusted data (fence + redact) before the model sees them.
7. Never silently escalate free/local routing onto paid providers.

It should **not** become a personal multi-messenger AI OS, a Windows computer-use agent, or a port of taracodlab’s v3/v4 dual runtime.

## Source comparison (compressed)

| Area | taracodlab-aiden | Our Aiden | Takeaway |
| --- | --- | --- | --- |
| Loop owner | First-party `AidenAgent` + TCE | Pi `Agent` per generation | Keep Pi; add recovery/honesty *around* it |
| Desktop | Windows-first Electron + system Node + Next dashboard | macOS Electron, sandboxed renderer, in-process agent | Do not copy their shell |
| Safety | `moat/` (honesty, autonomy dial, approvals, scanners) | Workspace Full/Ask/None + path confinement + Ask approvals | Extend existing permission model; no parallel `moat/` package |
| Memory | `SOUL.md` / `USER.md` / `MEMORY.md` + FTS/semantic | Chat JSON + workspace binding | Optional identity files later; not phase 1 |
| Tools | ~100+ tools, profiles, planner narrowing | Coding tools + Exa + skills + MCP | Profiles / per-turn narrowing |
| Streaming UX | Activity ≠ chat; structured `ui_*` events | IPC `chat:delta` / `tool` / `approval` | Richer events + Activity panel |
| Providers | 19 adapters + billing-aware fallback | Compat presets + Pi Codex OAuth | Catalog limits + no silent paid fallback |
| License | AGPL-3.0 core | Private app | Study ideas only; do not vendor AGPL code |

Related plans (do not duplicate):

- `docs/pi-provider-integration-plan.md` — full Pi provider registry
- `docs/gemini-native-upgrade-plan.md` — Phase 0 catalog-driven runtime limits (overlaps context work)
- `docs/designer-mode-plan.md` — visual edit loop (orthogonal)

## Non-goals

- Porting taracodlab Electron packaging, tray/daemon, or Next dashboard monolith
- Discord / Slack / Telegram / WhatsApp / email channel adapters
- Windows computer-use / nut-js / PowerShell control as product core
- XP / level gamification
- Full TCE stack, dream engine, skill-teacher mining, or subagent fanout in v1 of this plan
- Copying AGPL-licensed source into this repo
- Runtime calls to public model catalogs (still forbidden per `AGENTS.md`)

## Architecture decision

**Implement as three concrete behaviors on existing seams, not a new `moat/` subsystem.**

```text
Renderer (chat + Activity)
    │ IPC: delta | tool | approval | activity | done | error
    ▼
Main generation runtime (Pi Agent)
    ├── beforeToolCall  → existing Ask approvals (+ tier metadata later)
    ├── tool results    → fence MCP + redact secrets
    ├── after turn      → honesty / claim check (append-only footer or structured flag)
    ├── context         → catalog limits + compressor (tool-chain safe)
    └── tool assembly   → profiles or per-turn narrowing
```

Principles:

1. **Conversation stays primary** — Activity is progressive disclosure, not a second product.
2. **Honesty is append-only** — never rewrite the assistant’s prose in place; attach a structured outcome or quiet footer the UI can render.
3. **Recovery is policy, not vibes** — retry only non-mutating transient failures; surface everything else.
4. **Reuse Full / Ask / None** — map any “trust dial” language onto current permission modes rather than inventing Observer/Assistant/Partner as a second axis unless product explicitly wants both.
5. **Study, don’t vendor** — reimplement small policies; do not import taracodlab packages or large files.

## Prioritized roadmap

### P0 — Operator clarity (highest ROI)

#### 1. Chat vs Activity split

**Goal:** Transcript shows human + assistant prose (and compact tool chips if needed). A dedicated Activity surface shows running/done/blocked tools, approvals, exits, and verification.

**Likely touchpoints:**

- `main/services/llm-client.ts` — emit structured activity events (start/progress/end/error/approval)
- `renderer/` chat transcript + a collapsible Activity panel or Environment-adjacent strip
- Existing tool IPC (`chat:tool`, `chat:approval`) — normalize into an activity model rather than only inline bubbles

**Acceptance:**

- Multi-step coding turn does not bury the final answer under raw tool spam
- User can open Activity and see ordered tool outcomes with status
- Reduced-motion and keyboard access preserved; no dashboard-looking empty state

**UI note:** Review `docs/chatgpt-desktop-ui-inspiration.md` and the specimen HTML before adding chrome. Prefer Environment-card density over a new sidebar product.

#### 2. Honesty / claim check (post-turn)

**Goal:** If the model claims success after a failed `edit_file` / `run_command` / MCP tool, the UI shows a clear non-success state. Prefer structured turn outcome over LLM rewriting.

**Likely touchpoints:**

- Generation completion path in `llm-client.ts` / `generation-runtime.ts`
- Tool result records already streamed to the renderer
- Optional small pure module: `claim-check-core.ts` (input: assistant text + tool results → warnings)

**Acceptance:**

- Failed mutating tool + “done!” prose → visible warning or Activity “unverified claims” row
- Passing runs add no noisy chrome
- Unit tests for false-success and true-success cases

**Explicitly not in P0:** full evidence ledgers, subagent recheck, memory-write guards (those need durable memory first).

#### 3. Mid-run queue + redirect

**Goal:** While a generation is active, the user can type the next message (FIFO queue) or inject a short redirect/nudge at a safe boundary without always hard-canceling.

**Likely touchpoints:**

- Composer send path + generation cancel maps in `llm-client.ts`
- Renderer composer busy state (queue depth, “send to queue” vs interrupt)

**Acceptance:**

- Second message during a run is queued or explicitly interrupts (user-chosen default)
- Cancel remains reliable; queue drains after `chat:done` / error
- No lost messages on workspace permission revoke (cancel + clear or re-prompt)

### P1 — Context and tools

#### 4. Catalog-driven limits + context compression

**Goal:** Stop relying on fabricated 128K/8K for non-Codex models; compress when fill crosses a threshold without splitting tool-call / tool-result pairs.

**Depends on / aligns with:** `docs/gemini-native-upgrade-plan.md` Phase 0 for wiring catalog limits into runtime `Model`.

**Compression rules (draft):**

- Trigger near ~50–70% of true context window (tune with tests)
- Never orphan a `tool_use` without its `tool_result`
- Prefer summarizing older user/assistant prose; keep recent N turns verbatim
- Record compression events in Activity (not as fake assistant messages)

**Likely touchpoints:**

- `model-runtime-core.ts`, `models-catalog-core.ts`
- New pure compressor used from `llm-client.ts` before `agent.continue()`
- Usage accounting may note compressed turns

**Acceptance:**

- Runtime `contextWindow` / `maxTokens` match bundled catalog when present
- Long coding chats survive past the old false 128K ceiling for models that truly allow more
- Invariant tests: no broken tool pairs after compress

#### 5. Tool profiles or per-turn narrowing

**Goal:** When many MCP servers + skills are enabled, the model does not always receive the full schema set.

**Options (pick one in implementation spike):**

| Option | Description | Prefer when |
| --- | --- | --- |
| A. Profiles | User setting: minimal (coding only) / standard (+ search/skills) / full (+ all MCP) | Simple mental model |
| B. Per-turn narrow | Heuristic or cheap classifier shrinks tool list by user intent | Power users with many MCP tools |
| C. Hybrid | Profile caps the ceiling; optional narrow inside the profile | Best long-term |

**Likely touchpoints:**

- `main/services/tools.ts` assembly
- Settings Agent section
- System prompt brief note of active profile

**Acceptance:**

- Measurable reduction in tool-schema tokens on standard coding prompts
- User can force full tools for a chat or globally
- MCP tools never appear when profile is minimal

### P2 — Trust boundaries and provider policy

#### 6. MCP result fencing + secret redaction

**Goal:** MCP tool output enters the model as clearly delimited untrusted data; secrets/PII patterns redacted before prompt inclusion.

**Likely touchpoints:**

- `main/services/mcp.ts` tool wrappers
- Shared redaction helper (also useful for shell output caps later)

**Acceptance:**

- Model-visible MCP payload is fenced (e.g. tagged block) and size-capped
- Known secret-shaped strings redacted in tests
- Failures to call MCP still surface in Activity honestly

#### 7. Billing-safe / no silent paid fallback

**Goal:** If we add provider fallbacks (rate limit, outage), never move from keyless-local or free tier to a paid key without explicit consent.

**Likely touchpoints:**

- Future fallback logic near `generation-runtime.ts` / provider registry
- Settings copy for “allow paid fallback”

**Acceptance:**

- Default: fail closed with a clear error
- Opt-in: user sees which provider was used on the turn (usage + Activity)

### P3 — Optional identity and inspectability (later)

Ship only if P0–P2 pay off and product still wants more “agent OS” depth without leaving the workspace thesis.

| Item | Notes |
| --- | --- |
| Workspace identity files | Optional `SOUL.md` / `USER.md` / `MEMORY.md` under workspace or `~/aiden/...`; user-editable; hot-reload on dirty bit; never invent a second hidden persona store |
| Connection probe onboarding | Key → list models → tiny tools probe; not just paste-and-pray |
| Artifacts / trace view | Provenance for files touched this turn; deep link into Review |
| Skill teacher | After repeated successful multi-step flows, *propose* a SKILL.md (user approves) |
| Model picker badges | Auth healthy / local / recommended markers — polish only after Pi provider plan lands |

## Suggested implementation order

```text
Phase A  Chat Activity model + IPC events          (P0.1)
Phase B  Honesty/claim check on turn complete      (P0.2)
Phase C  Composer queue + redirect/cancel UX       (P0.3)
Phase D  Catalog limits (shared with Gemini plan)  (P1.4a)
Phase E  Context compressor                        (P1.4b)
Phase F  Tool profiles (then optional narrowing)   (P1.5)
Phase G  MCP fence + redact                        (P2.6)
Phase H  Paid-fallback consent (when fallbacks exist) (P2.7)
Phase I  Identity files / probe / artifacts        (P3, optional)
```

Do not start Phase I until A–C are validated in daily use. Phase D may ship earlier if bundled with the Gemini Phase 0 PR.

## Mapping “moat” without cargo-culting

taracodlab’s `moat/` is a useful *checklist*, not a folder to recreate.

| taracodlab idea | Aiden translation |
| --- | --- |
| Honesty enforcement | Post-turn claim check + Activity outcome (Phase B) |
| Approval engine | Existing Ask `beforeToolCall`; add risk labels later if needed |
| Autonomy dial | Keep Full / Ask / None; document mapping in settings copy |
| MemoryGuard | Only after durable MEMORY writes exist |
| SSRF / Tirith scanners | Consider for web_fetch/MCP URLs and write paths in a dedicated security pass |
| Yolo ≠ Partner | If we add a bypass, hard-blocks (e.g. path escape) always remain |

## Explicitly skip from taracodlab

- Electron shell that spawns system Node + packs a Next dashboard
- Multi-channel personal OS
- AGPL core as a dependency or copied tree
- ~5.5k-line monolithic dashboard page patterns
- Dual v3/v4 agent stacks
- XP/streak identity gamification
- Daemon trigger bus (file/webhook/IMAP/cron) as MVP — revisit only if product expands beyond interactive desktop

## Where we stay ahead (do not regress)

- macOS-native materials, appearance workbench, traffic-light layout
- In-process Pi agent (simpler than spawn-system-Node)
- Workspace path confinement, symlink hardening, `.env` hidden from model reads
- Git Review / Files / worktrees / terminal drawer
- Spatial model picker foundation
- Apple Foundation Models titles; Parakeet on-device STT
- Privacy: local chat/config, encrypted secrets, aggregate-only usage, no runtime public catalog fetches

## Risks

| Risk | Mitigation |
| --- | --- |
| Activity panel becomes a busy dashboard | Progressive disclosure; hide when idle; conversation-first layout tests |
| Claim check false positives | Pure functions + golden fixtures; warn, don’t block send |
| Compression breaks tool history | Invariant tests; abort compress if pairs would split |
| Tool narrowing hides needed MCP tools | Easy “use all tools” escape; per-chat override |
| Scope creep into agent-OS features | P3 gated; this doc’s non-goals are binding until revised |

## Success metrics (qualitative)

- Long agent turns remain scannable in the main transcript
- Users trust failure states (fewer “it said it worked but the file didn’t change” reports)
- Large MCP setups no longer feel slower/dumber by default
- Context errors decline after catalog limits + compression
- No increase in accidental paid provider use

## Open questions

1. Activity as **inline collapsible trail** vs **Environment-adjacent panel** vs **both**?
2. Queue default: always queue on Enter while busy, or prefer interrupt (Codex-like)?
3. Claim check: UI-only warning vs also inject a model-visible system note on the *next* turn?
4. Tool profiles: settings-global only, or per-workspace / per-chat?
5. Identity files: workspace-root vs Aiden-managed metadata directory (avoid polluting repos by default)?

Resolve these in a short product pass before Phase A UI lands.

## References

- taracodlab (ideas only): `core/v4/aidenAgent.ts`, `moat/honestyEnforcement.ts`, `moat/approvalEngine.ts`, `core/v4/contextCompressor.ts`, `core/v4/mcpClient.ts`, dashboard Activity separation
- Aiden: `main/services/llm-client.ts`, `main/services/tools.ts`, `main/services/coding-tools.ts`, `main/services/mcp.ts`, `main/services/generation-runtime.ts`, `PRODUCT.md`, `AGENTS.md`
- Prior exploration notes from multi-agent review (2026-07-22): chat/activity, honesty, compression, tool narrowing, mid-run control, MCP fencing, billing-safe fallbacks

## Next action

When implementing, start with **Phase A (Activity events + panel)** and **Phase B (claim check)** in one vertical slice on a multi-tool coding turn. Defer identity files, daemon-like automation, and picker badge polish until that slice feels native to Aiden.
