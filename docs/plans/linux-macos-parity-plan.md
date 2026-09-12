# Linux macOS parity reconciliation

Status: Active — phase 1 complete; phase 2 in progress, 2026-09-12.

Baseline: Linux `6a397578` (0.36.1), macOS main `a4c85c6d` (0.40.0).

## Phases and gates

1. Integrate stacked Linux fixes `e0f48366`, repair the service status contract, and validate remote/Wayland behavior.
2. Reconcile current main shared runtime, persistence, chat, browser, terminal, settings, onboarding and mobile contracts while preserving Linux platform integrations.
3. Audit and implement remaining feasible Linux native parity, including Bots security backend, dictation and Computer Use; retain explicitly platform-specific Apple capabilities and respect compositor/package-manager ownership.
4. Validate macOS regressions and native Linux x64/arm64 packaging, desktop behavior, mobile contracts and final feature matrix.

After every phase, two independent GPT-6 Astra reviewers at medium effort review the implementation. Resolve actionable findings and rerun relevant checks before proceeding. Record evidence and limitations; no claim of full parity before applicable native acceptance passes.

## Evidence

- Linux support branch pulled; stacked fixes fast-forwarded locally.
- Phase 1 fixes a hosted TypeScript failure: service status omitted `permission_denied` although renderer status and runtime handling included it.

- Phase 1: type-check and focused lint passed; initial remote/Wayland suite 113 passed, 1 skipped; post-review regression suite 51 passed, 1 skipped. Two GPT-6 Astra medium reviewers cleared all findings after fixes for Chromium feature preservation and Tailscale error precedence.
