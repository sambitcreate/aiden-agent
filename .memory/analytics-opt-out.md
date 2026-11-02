# Analytics opt-out and shutdown — 2026-11-02

Disabling usage data revokes the batching SDK client before the isolated final event starts. Consent and the install ID are updated without waiting for that response. Shutdown honors pending consent changes within its existing deadline. The regression in analytics-client.test.ts holds the opt-out response while triggering shutdown and flush against the real SDK with an intercepted fetch.
