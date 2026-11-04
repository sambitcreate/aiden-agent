# Runtime R2 corrections

- Full historical brief and plan together exceed tool output limits. Read them in bounded ranges before implementation.
- F5 needs a separate live fixed-folder location: reusing run.access silently replaces a person's Once grant. Coordinating the router seam with storage before editing it.
- The ledger's NotExecuted wrapper forbids post-effect use. Added a distinct replay-safe retry error for exact-receipt access operations; ordinary failures retain existing handling.
- Error(message, {cause}) is outside the project's TypeScript target. Removed the second constructor argument; no classification relies on an error cause.
- Parent coordination needs t3_thread_send; child commentary alone did not deliver the F5 design proposal promptly. Sent it directly after discovering the exact parent thread ID.
- Actual durable harness reproduced a completed-task API failure: retaining the original Always owner.validate made run.saved vanish after that task's result committed. The saved slot now retains only host publication grant/signal/deadline; every lookup validates through the currently executing call. The real Always A -> Once B -> A read / B read / queued refusals sequence passes.
- A post-await current-call abort initially left the saved slot reusable. A behavioral lifecycle test reproduced it; the resolver now forgets that stale slot without affecting a newer concurrent publication.
- Receipt-first recovery initially made whole-Mac and Home no-Always cards depend on the grant journal. Red captured; lookup now runs only for folder prompts that actually offered Always and carry captured grant metadata.
- Final checks: access 63, host integration 347, root type-check, scoped lint and whitespace validation all pass. No test timeouts, retries or assertions weakened. Runtime worker stopped editing at final handoff.
