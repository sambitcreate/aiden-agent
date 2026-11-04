# Task 9 onboarding

- The requested `onboarding-art/feature-art.test.tsx` does not exist. Root confirmed that art assertions belong in the existing gallery test; no new suite is needed.
- Long combined documentation reads truncate tool output. Read bounded sections to retain the plan and UI-reference requirements.
- The first intentional gallery RED left a mounted tile behind, cascading into the offscreen test. Per-test cleanup fixes isolation. Keep the fake observer inventory intact because production deliberately shares one observer; resetting it made the next RED's observer lookup fail.
- Full onboarding run: 84/85 pass. An out-of-scope `onboarding-flow.test.tsx` gallery assertion still requires older Bots copy that was already absent at the starting HEAD. Report it to root for its test-registration/integration ownership; do not expand this worker's file scope.
