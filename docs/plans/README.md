# Plans

This directory is the source of truth for Aiden's implementation plans. The engineer changing a plan owns its status row and should update it in the same change when a meaningful milestone lands.

## Active and partial

| Plan | Status | Current state |
| --- | --- | --- |
| [Aiden Assistant](aiden-assistant-plan.md) | Planned | Task-level implementation plan written and verified against the codebase; no code yet. |
| [Compaction](compaction-plan.md) | Partial | Core context transformation has landed; the broader design remains open. |
| [Designer Mode](designer-mode-plan.md) | Planned | Phase 0 validation has not started in the runtime. |
| [Dynamic Model Catalog](dynamic-model-catalog-plan.md) | In progress | Local implementation work exists; the remote-overlay plan is not complete. |
| [Generation Progress Notes](generation-progress-notes-plan.md) | Planned | No implementation yet. |
| [Pi Provider Integration](pi-provider-integration-plan.md) | Partial | Codex and Google slices are shipped; the full registry migration remains open. |
| [Taracodlab Learnings](taracodlab-learnings-plan.md) | Partial | Phases A–B and D, plus core Phase E, are implemented; the remaining roadmap is open. |

## Completed

| Plan | Status | Completion note |
| --- | --- | --- |
| [Gemini Native Upgrade](completed/gemini-native-upgrade-plan.md) | Complete | Its funded delivery phases shipped; deliberately deferred Gemini tracks remain future work. |
| [Scheduled Tasks](completed/scheduled-tasks-plan.md) | Complete | Implemented through the plan's original Phase 4 scope. |

Move a plan to `completed/` only when its original delivery scope is complete. Keep the original plan as historical documentation; follow-on work belongs in a new active plan.
