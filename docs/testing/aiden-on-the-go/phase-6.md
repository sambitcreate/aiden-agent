# Aiden On The Go — Phase 6 evidence

Date: 2026-08-19
Status: LAN and Tailscale implementation verified on a physical iPhone; physical-iPad acceptance remains open.

The Swift client supports canonical QR pairing, private-CA or system trust plus the exact P-256 leaf SPKI pin, per-installation Keychain credentials, multiple Aiden installations, switching/removal/revocation, workspace registry CRUD, managed scratch creation, and opaque approved-root folder exploration/selection. Legacy installation metadata without an explicit pairing trust policy fails closed and requires secure re-pairing.

On the physical iPhone 13 Pro, a real Wi-Fi LAN harness proved QR exchange, authenticated server discovery, folderless create/update/delete, scratch create/delete, approved roots/children, selected-folder registration, one-use selection replay rejection, and authoritative final reconciliation. The strict certificate proof separately covers wrong pin, renewal, rotation, host mismatch, and expiry. No simulator was used and the iPhone 16 Pro Max was untouched.

The same physical iPhone then passed 1/1 in 1.611 seconds through a real Aiden-owned Tailscale Serve route. It used the tailnet's system-trusted certificate plus the exact live SPKI pin, reported `connectionMode=tailscale`, paired, authenticated, browsed the approved root, completed folderless/scratch/selected-folder workspace CRUD, rejected selection replay, and reconciled to an empty authoritative workspace list. The proof began from an empty Serve configuration and exposed two defects that are now covered by regression tests: first-connect must derive HTTPS eligibility from the exact Tailscale certificate domain rather than requiring a pre-existing 443 listener, and the loopback proxy target must restore `/api/aiden/v1` because `--set-path` strips the public mount prefix. Cleanup removed only Aiden's exact path and returned `tailscale serve status --json` to `{}`.

The remaining Phase 6 acceptance work is explicit: repeat LAN and Tailscale pairing, browsing, and workspace CRUD from a physical iPad. No simulator was used and the iPhone 16 Pro Max was untouched.
