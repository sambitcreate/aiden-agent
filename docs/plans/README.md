# Plans

This directory is the source of truth for Aiden's implementation plans. The engineer changing a plan owns its status row and should update it in the same change when a meaningful milestone lands.

## Active and partial

| Plan                                                                                        | Status  | Current state                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Aiden Assistant](aiden-assistant-plan.md)                                                  | Partial | The dock, Markdown rendering, and confirmed provider-connection/model-pinned project-or-MCP automation creation/editing ship; settings tools and proactivity remain planned. |
| [Compaction](compaction-plan.md)                                                            | Partial | Core context transformation has landed; the broader design remains open.                                                                                                     |
| [Designer Mode](designer-mode-plan.md)                                                      | Planned | Phase 0 validation has not started in the runtime.                                                                                                                           |
| [Dynamic Model Catalog](dynamic-model-catalog-plan.md)                                      | Partial | Stored Pi catalogs, cache-only hydration, and explicit provider refresh ship; remote overlays for otherwise-static providers remain open.                                    |
| [Generation Progress Notes](generation-progress-notes-plan.md)                              | Planned | No implementation yet.                                                                                                                                                       |
| [Performance, Stability, Battery, and Efficiency](performance-stability-efficiency-plan.md) | Planned | Whole-app source audit is complete; implementation starts with instrumentation, durable state, and hard memory bounds.                                                       |
| [Pi Provider Integration](pi-provider-integration-plan.md)                                  | Partial | Pi built-ins, stores, auth, native routing, refresh, and voice credential lookup ship; custom composition, provenance, scalable UX, and rollout cleanup remain.              |
| [Slash Commands and Skill Invocation](slash-commands-and-skill-invocation-plan.md)          | Planned | Pi command, Aiden architecture, and composer UI audits are complete; implementation has not started.                                                                         |
| [Subagent Orchestration Expansion](subagent-orchestration-expansion-plan.md)                | Active  | Phases 0–6, Phase 7A durable lifecycle, and the canonical Phase 7B1 storage seam are complete; app-lifetime coordinator activation is next.                                |
| [Taracodlab Learnings](taracodlab-learnings-plan.md)                                        | Partial | Phases A–B and D, plus core Phase E, are implemented; the remaining roadmap is open.                                                                                         |

## Completed

| Plan                                                                                           | Status   | Completion note                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Keyboard Command System](completed/keyboard-command-system-plan.md)                           | Complete | One command catalog now powers transactional global hotkeys, scoped app shortcuts, native menus, canonical settings, and the `Command-K` palette. |
| [Aiden-Native Subagents](completed/aiden-native-subagents-plan.md)                             | Complete | All five phases passed focused/package gates, two final fresh reviews, and the default 100-cycle packaged lifecycle soak.                         |
| [Development and Production Coexistence](completed/development-production-coexistence-plan.md) | Complete | Development now has a visibly distinct app identity, isolated state roots, opt-in global shortcuts, and production-only updates.                  |
| [Gemini Native Upgrade](completed/gemini-native-upgrade-plan.md)                               | Complete | Its funded delivery phases shipped; deliberately deferred Gemini tracks remain future work.                                                       |
| [Scheduled Tasks](completed/scheduled-tasks-plan.md)                                           | Complete | Implemented through the plan's original Phase 4 scope.                                                                                            |

Move a plan to `completed/` only when its original delivery scope is complete. Keep the original plan as historical documentation; follow-on work belongs in a new active plan.
