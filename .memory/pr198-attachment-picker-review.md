# PR #198 attachment picker review follow-up

The native iOS attachment picker uses a bounded PhotoKit current rendering rather than loading original image bytes into the upload pipeline. The request preserves transparency through PNG encoding, uses JPEG otherwise, and validates the encoded size. Its checked continuation must resolve on PhotoKit error or cancellation even if the same callback is marked degraded; only a nonterminal degraded preview may be ignored.

Photos library refreshes are generation-fenced across authorization suspension, dismiss/reset, menu and camera transitions, and commit. The final result-application method checks the same generation and Photos mode before publishing assets, selection, or status; the focused regression exercises that publication seam, not only the helper predicate.

On iPad, picker layout classifies landscape against actual UIWindow bounds while clamping its panel to the detail container. The circular SwiftUI camera controls intentionally follow the approved native picker reference; the shared Electron squircle component does not apply to them. Physical iPad visual acceptance remains open.

The hosted deterministic Electron E2E job reached test 103/103 on the review head but was canceled at its 30-minute job limit before completion. The limit was raised to 45 minutes with a CI-policy assertion, preserving test coverage. This is a CI scheduling change, not an Electron feature change.
