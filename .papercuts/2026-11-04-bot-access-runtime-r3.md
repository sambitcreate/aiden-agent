# Runtime R3 corrections

- Initial combined context reads exceeded tool output limits. Re-read the complete R3 reports separately and used bounded source reads.
- R3 F1: eligible folder cards depend on receipt-journal reads even for Once and Not now. Capture real classified journal failures before changing authorization.
- R3 L1: person-owned run.access survives an unattended input join. Keep plan-owned grants eligible for future plan permit enforcement.
- First RED included a test-only wording mismatch for the existing read-only rejection. Matched the actual behavioral refusal, then recaptured RED with 13 genuine failures in /tmp/bot-access-runtime-r3-red-final.log.
- Runtime corrections pass the access suite. Journal tests exercise real EIO/schema classifiers and exact committed records through the real bridge/authorizer. No application-service or issue/Remote implementation changed by this worker.
- Initial full type-check overlapped root's Remote edits and found two open_settings narrowing errors in aiden-remote-bot-session.ts. Left that file untouched. Two subsequent full checks passed after the root correction, including final source.
- Final checks: test:bot-access 84 passed; full type-check, six-file ESLint and diff check passed. A read-only esbuild import-graph check found no session/main wiring reached by the new store classifier import.
