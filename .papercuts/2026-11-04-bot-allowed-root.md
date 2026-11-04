# Phase D root papercuts, 2026-11-04

- The approved D plan still reserved Remote54 from the pre-A stack. At phase start updated its active provisional references to57 after A54/B55/C56; merge-time recheck remains mandatory.
- Existing ToolApprovalRuleBook uses a512KiB DataStore ceiling. New Bot entries/receipts must not commit a document that becomes unreadable at the next load; worker must address the concrete byte-budget and receipt-retention seam before publishing.

- Task1 inspection found a fresh publication operation on an existing target changed consent revision but emitted no Bot change event. Extended the existing API test, captured event RED, then emit once for every new publication receipt while exact transport replay stays silent. /tmp/bot-allowed-d-task1-parent-event-red.log.
