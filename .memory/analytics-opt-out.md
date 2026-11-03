# Analytics opt-out and shutdown — 2026-11-02

Disabling usage data revokes the batching SDK client before the isolated final event starts. Consent and the install ID are updated without waiting for that response. Shutdown honors pending consent changes within its existing deadline. The regression in analytics-client.test.ts holds the opt-out response while triggering shutdown and flush against the real SDK with an intercepted fetch.

A queued opt-out followed by opt-in can install a second activity timer during quit. Shutdown clears the timer after the accepted consent changes settle, alongside the final transport. The service regression advances the clock after shutdown and checks the stored activity day. The SDK regression holds an abort-aware response and requires it to complete.

Analytics requests reject redirects, including the dedicated opt-out POST. Consent changes require the current main-window document when executed. Onboarding completion reports its outcome only when disclosure has independently authorized sending. An unread or off switch leaves fresh-install telemetry dormant.
