# Connection reliability — October 2026

Branch `fix/connection-reliability`; implementation complete; [PR #370](https://github.com/sambitcreate/aiden-agent/pull/370) opened, hosted validation in progress.

- Desktop uncertain chat sends, guidance, approvals, questions, stop requests and
  forks use exact saved request identities. Admission persists an encrypted bounded
  record in main before network transmission. Recovery is scoped to host/chat and
  paired device identity. Main fences saved-operation admission against credential
  replacement; renderer restart restores explicit recovery notices. No automatic
  sends. Desktop retry eligibility is conservatively 23 hours from submission,
  inside the host's 24-hour settled-result retention. Expired attempts remain visible
  until reviewed/dismissed. New-chat first turns use the same ledger.
- Native clients persist uncertain turn and run-input attempts, preserve exact keys,
  requests and stream IDs, recover after recreation, and expose explicit Retry or
  review/dismiss actions. Progress recovery parks offline and uses an epoch-scoped
  cursor; conditional reads reuse bounded, credential-scoped ETag caches.
- Desktop route discovery/failover keeps trust per route and host identity independent
  of address. Verified `/server` carries the LAN CA and route information. Learned
  routes may be suppressed/restored. Healthy wake probes preserve streams.
- Settings distinguishes secure connection from synchronized chat state, includes
  route/freshness details, exposes list failure + Retry, and keeps failed Forget open.
  Device connections includes desktop/Android types; “Recently active” is recency.
- Native connection failures expose specific recovery guidance and last contact.
  Android Nearby uses only a bounded untrusted canonical hostname hint for initial
  setup-code pairing. It does not treat discovery data as trusted routes or trust roots.
- Existing onboarding text and connection guide updated. Existing feature-tour artwork
  remains accurate; no new core-capability tile.

Local validation: Remote suite 864 passed, 1 existing skip; final transport 31 passed,
service 68 passed, 1 existing skip. Desktop remote-chat 137, settings 58, onboarding 68,
IPC inventory 8, CI policy 56 pass. Typecheck, lint, production build, E2E typecheck,
and all four Electron connection lifecycle cases pass. The new removal-failure flow
found the shared dialog's default automatic close; Forget and learned-route removal
now use its existing keep-open option and only close after success. Native results
are recorded in native-connection-reliability.md. Exact-head hosted CI pending.

Local flake to disclose in PR: `main/services/aiden-remote-service.test.ts`,
“a failed loopback companion bind rolls back the partial LAN listener before retrying”
reported “operation timed out” in a broad concurrent run (helper line 111, ~1.1s).
Its one narrow rerun passed (68 passed, 1 skipped). No timeout or retry settings changed.
Logs: `/tmp/aiden-remote-full.log`, `/tmp/peer-service-rerun.log`.

Packaged multi-device LAN/Tailscale, Linux↔Mac, real Wi-Fi roaming, and physical-device
acceptance remain distinct from fixture/simulator results; do not claim them based on CI.

Hosted Android check initially found a stale revision-24 assertion in the Bot fixture
consumer after the shared contract moved to 25. The assertion is updated and the
full Android unit suite passed all 427 cases in follow-up validation; this was a coverage
omission in the focused local run, not a transient CI failure.

CI also exposed an unrelated Git watcher flake: the unstaged-edit test received one
generation-1 notification; its one focused local rerun passed all 6 cases. No timeout
or assertion was weakened. Evidence: PR #370 core-git job 112626770363 in run
37569980985. The PR records the symptom and link; this flake remains an open bug.

PR review follow-up: optional Tailscale advertisement discovery no longer delays
LAN identity or healthy-wake checks. Ads are partial observations and omission
preserves previously validated routes within the bound. Native matching receipts
settle the original retained pairing's exact pending request even after switching
presentation; UI adoption stays fenced. Actual Android QR/setup-code requests now
use the Android identity, with explicit older-desktop update guidance.
