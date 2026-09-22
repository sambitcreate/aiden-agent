# Studio research improvements

Status: Complete; implementation and hosted acceptance passed on 2026-09-22. Scope is a bounded follow-on to the
completed Studio roadmap in PR #85, with no new engine or permission model.

## Verified research and scope

The September 12 MagicPath audit and September 21 Comfy Design mapping describe
PR head `37c7d37fa`, not current main. Current main was fetched and integrated in
`1edd2781` before implementation. MagicPath's current Canvas documentation URL
was checked; its client-rendered page did not provide a usable text specification.
Comfy-Org/ComfyUI's current repository documents partial execution and memory
management. These are conceptual references only; no upstream code was ported.

Sources:
- https://app.notion.com/p/3d980314a1c48170929fe91cf6ad40c2
- https://app.notion.com/p/3e280314a1c481c5813ee4e1da634b6e
- https://www.magicpath.ai/documentation/features/canvas
- https://github.com/Comfy-Org/ComfyUI

## Delivered

- Screen chrome offers **Explore variations**, using the existing two-direction,
  balanced Explore request and exact persisted base. It clears incompatible
  connected-source context and focuses the composer; nothing generates or writes
  until the existing attended send/preflight flow.
- Rapid revision scrubbing waits 120 ms before requesting a preview. Main still
  validates each requested source. Equal HTML/title/theme hashes preserve the
  existing frame and picker capability only within the same chat. Pending source
  transitions are inert; failures clear stale previews and late replies are ignored.
- After authorization, main reuses matching preview URLs by renderer document,
  chat, and content hash. The URL-only cache has 32 entries and a five-minute TTL,
  below the existing protocol's 30-minute expiry. This avoids repeated allocation
  for unchanged content; it is not a global bound on all generic preview documents.
- History loads at most the displayed and comparison HTML bodies. Other revisions
  retain lightweight selectable rows; unknown timestamps/provenance are not
  invented. Inactive Code tabs do not tokenize/render source bodies. Direct edit
  and Undo remain successful independently of the selected source read/retry UI.
- Stop and shutdown await the same process cleanup. Cleanup revokes authority,
  removes abort listeners, and waits for the owned process group, including when
  its launcher exits first. Up to 32 terminal outcomes preserve failure reasons
  and bounded logs across a missed notification; explicit stop/restart clears them.

The existing 128 KiB generation-context cap, CAS, exact immutable revisions,
source validation, approvals, network-free HTML sandbox, and native exclusion
remain unchanged. These refine an already-advertised capability, so onboarding's
existing Design tile/art and setup flow remain appropriate; no new tile is added.

## Deliberately deferred research items

- Progressive partial HTML and parallel loading nodes need a generation-status
  contract distinguishing pending, failed, cancelled and partially published work.
  Existing validated live candidates and partial direction sets remain authoritative.
- Refine-input caching cannot safely skip generation based only on base HTML:
  prompt, model, language, tools and other context also affect output.
- Idle process stopping needs an explicit visible-owner lease. HTTP inactivity
  cannot distinguish an idle background project from an actively viewed static app.
  This patch fixes provable teardown/reuse gaps without interrupting active previews.
- Virtualizing lightweight revision rows is deferred; eliminating full-body reads
  and hidden syntax work addresses the verified expensive path first.
- Reviewed scaffold, capture-to-Screen, cross-Screen style attribution, libraries,
  and Figma reference import are separate product/authority work. No automatic
  writes, public MCP, multiplayer, cloud source of truth, QR/LAN previews, Stitch
  dependency or Create Images changes are introduced.

## Verification

- Sol medium independently reviewed integration conflicts and post-change blast
  radius; a separate Sol medium reviewed adversarial cases. Findings were fixed
  and re-reviewed (final process-outcome follow-up tracked in PR evidence).
- Focused integration: 122 tests passed; Design suite: 451 tests, recovery/cache:
  44 tests, V2 policy: 12 tests, vendor contract: 3 tests, browser: 11 tests passed.
- Android unit tests, instrumentation test compilation, generic iOS hardware test
  compilation, type checking, lint, and production build passed. Remote tests:
  462 passed and one platform skip. Final incremental focused checks: 27 passed;
  process lifecycle: 12 passed. Exact-head CI remains tracked in PR #85.
- React Doctor scanned the full 259-file Studio diff: 66/100, with broad existing
  component/ref/dependency warnings. The new source-request ref is synchronized
  in a layout effect; selection-dependent reads use a stable explicit request key.
  No global rule suppression or unrelated rewrite was added.

## Hosted acceptance

Head `241ef9272416dffb433145d345d9b1e1ed53c5e8` passed CI verify and
Deterministic Electron E2E in [run 35738331314](https://github.com/sambitcreate/aiden-agent/actions/runs/35738331314),
and Release consumer contract in [run 35738331308](https://github.com/sambitcreate/aiden-agent/actions/runs/35738331308).
Android CI was path-skipped; local Android validation above passed. No PR
comments or unresolved review threads were present at 14:41 UTC.

The prior Vite Apply/Undo reload race was fixed with an exact same-page
navigation-error classifier; assertion strength and retry bounds are unchanged.
Both Sol medium reviewers approved the fix. Nine focused cases across three
repetitions and all 12 browser-suite tests passed with retries disabled.
Full local npm tests previously passed, including 1,721 final-suite tests.
No merge, release, deployment, or physical-device runtime acceptance is claimed.
