# Phase C Task7 card

- Large combined reference reads truncate tool output. Read bounded sections separately.
- Testing Library uses happy-dom without user-event. Headless tests can verify native button semantics/focus order, but actual Tab/Enter activation needs root's Cua E2E; do not synthesize browser behavior and call it keyboard acceptance.
- Initial pane tests assumed ready=false disables the textarea. Existing Composer intentionally keeps drafts editable and disables sending. Corrected the new tests to check Send/Enter gating and host-event release; root notified for E2E alignment.
