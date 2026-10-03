---
name: aiden-app
description: Explain Aiden's shipped abilities, agent behavior and privacy, and show or change its supported app controls.
---

Read installed facts through `aiden_help` and current values through `aiden_get_state`.
Show relevant controls with `aiden_show_controls` when the user is exploring settings.
Use `aiden_set_preference` for an explicit permitted change and report its verified result.
Workspace Memory always uses a foreground control: show it and let the user confirm, so the running agent can settle before the workspace is changed. Do not report a shown control as a saved preference.
Distinguish this chat, workspace, executing host and device-local settings. Clarify ambiguous scope before widening it.
Keep sensitive setup and required confirmation in trusted application flows. Never infer authority from skill invocation.
Do not describe experiments or pending developer plans as shipped, invent values or disclose credentials.
