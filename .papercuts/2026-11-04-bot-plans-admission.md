# Task4 enforcement integration

- Pi Durable safe-tool recovery skips `beforeTool`. Plan authorization must be restored at execution using the current invocation API, not a retained hook API or provider call ID.
- The adapter wraps an asynchronous authority fence. Passing that wrapper to `plans.admit` would admit before its awaits; the fence must hand over the actual callback.
- A real SIGKILL/recovery test caught authority restoration in the wrong order: safe recovery's `onAllow` ran inside an already-checked fence. Move restoration to adapter preparation so a fresh fence follows every restored approval callback. Red: `/tmp/bot-plans-task4-restored-onallow-red.log`.
- Strict committed Bot metadata exposed three incomplete memory-review fixtures, producing five failures. Root explicitly extended ownership only to complete those objects; every assertion stayed unchanged. The affected memory suite then passed 16 tests.
- `test:cli` begins with `npm ci`; skipped under this task's explicit no-dependency/no-network constraint. Root owns that broader verification.
- Added matching rules can arrive while `onAllow` waits. A failing runtime test showed the old permit running without their card; compare the rule snapshot after onAllow and fall back without another reservation. Root's C5 captured authorization must also bind the entire effective rule set across admission awaits. Red: `/tmp/bot-plans-task4-rule-drift-red.log`.
- Browser classification alone omits document/control revisions. Include the host-owned browser target in the canonical operation hash so same-URL reloads cannot reuse a reservation. Red: `/tmp/bot-plans-task4-browser-target-red.log`.
- Final validation: runtime 391, focused plus affected memory 153, browser 36, rules 62, registry 15; types/lint/diff checks green. Source frozen and handed back to root.
