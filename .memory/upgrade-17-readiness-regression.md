# Lane 17: renderer readiness contract repair

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

`main/services/renderer-readiness-core.test.ts` assumed a zero-argument crash callback with readiness reset first and an immediate tracked loadURL call. `main/index.ts:1073` now records diagnostic details before reset and uses a backoff promise before reloading. The baseline command-system suite reproducibly failed 1 of 64 tests.

The repaired source contract scopes matching to the renderer crash callback, preserving reset-before-tracked-recovery and reload checks while accepting diagnostic statements and the backoff wrapper. Existing readiness generation and disposal behavioral tests remain unchanged. No runtime or native contract changes, so onboarding and plan statuses are unchanged.

Validation: command-system 64/64; focused instrumented readiness 3/3 with 100% core line/branch/function coverage; type-check passed. Six temporary source mutations (missing reset, missing tracking, missing reload, wrong event, reset outside callback, reload outside callback) each failed the intended assertion; main/index.ts restored byte-for-byte. Full lint passed after regex spacing fix.

`pretest:coverage` invokes command-system, so this repair unblocks that prerequisite. Full `test:coverage` was not run; ordinary CI npm test/pretest does not directly invoke this suite. No workflow changes or propagation to other lanes. Electron runtime/visual checks are not part of this test-only repair. Hosted CI and central Luna/Pullfrog review are separate gates.
