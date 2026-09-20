# Web access response cleanup — 2026-09-19

- Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.
- Both bounded body readers awaited underlying source cancellation; a pending cleanup promise held timeout, caller cancellation, and byte-limit errors open indefinitely. HTTP error cleanup in JSON, Wave 1, and Jina had the same problem.
- Shared `web-search-response.ts` now initiates cancellation once, handles its rejection without awaiting completion, and releases the reader lock. Existing exported reader names remain available. Response limits, fixed destinations, credentials, redirect policy, and explicit route/fallback behavior are preserved.
- Regression coverage is in the existing registered `web-search-provider-registry.test.ts`: pending/rejected cleanup, byte boundaries, malformed chunks, HTTP quota errors, real-adapter service deadlines/cancellation, and configured fallback.
- Source lessons: Pi Web Access `exa.ts:91-94` at `fd4dcc2712c5c81ec7549b08097bb01e7bb953b5` combines caller cancellation and deadlines; Hermes `tools/web_tools.py:866-891` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf` preserves configured provider boundaries. Both MIT; no reference code copied.
- Onboarding review: internal resilience fix; no new capability, setup flow, authority, or advertised feature. No UI or shared server/native contract changes; native suites and visual checks are not applicable.
- Validation: `npm run test:web-search` passed 149 tests; pre-fix regression run failed all 8 pending-cleanup cases. `npm run type-check` and scoped ESLint passed. No live provider requests were used.
