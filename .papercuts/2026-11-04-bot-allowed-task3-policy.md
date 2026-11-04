# Task 3 policy work

- Large batched plan reads exceeded the tool output limit. Re-read bounded sections separately.
- Initial RED: target module missing as expected; real policy tests exposed missing entry authorization, requirements probe and revocation fence. Log: `/tmp/bot-allowed-d-task3-red.log`.
- Existing Mail fixture has no tools/list title. Task 3's local fixture must explicitly supply a title when asserting the offered title, rather than assume a display label.
- First implementation GREEN attempt exposed a named-input normalization mismatch between the hook and final tool fence. Normalized the hash binding while preserving raw ingress separately; focused 118 passed afterward.
- Inspection found stale ordinary fallback when a new rule appeared during an awaited book read. Real harness RED2 reproduced an unprefixed Ask and an executed hand-off action. Fallback now re-admits ordinary policy with both C coverage and D lookup disabled; log `/tmp/bot-allowed-d-task3-drift-red.log`.
- The dedicated `.papercuts` file is ignored by the repository; root must explicitly include it if desired.
- A separate probe-order RED showed unavailable browser authority could still trigger a page/book read before final refusal. The probe now applies the initial tool verdict before page classification. Log: `/tmp/bot-allowed-d-task3-probe-order-red.log`.
