# Aiden On The Go — Phase 6 evidence

Date: 2026-08-19
Status: LAN and Tailscale implementation verified on a physical iPhone; physical-iPad acceptance remains open.

The Swift client supports canonical QR pairing, private-CA or system trust plus the exact P-256 leaf SPKI pin, per-installation Keychain credentials, multiple Aiden installations, switching/removal/revocation, workspace registry CRUD, managed scratch creation, and opaque approved-root folder exploration/selection. Legacy installation metadata without an explicit pairing trust policy fails closed and requires secure re-pairing.

On the physical iPhone 13 Pro, a real Wi-Fi LAN harness proved QR exchange, authenticated server discovery, folderless create/update/delete, scratch create/delete, approved roots/children, selected-folder registration, one-use selection replay rejection, and authoritative final reconciliation. The strict certificate proof separately covers wrong pin, renewal, rotation, host mismatch, and expiry. No simulator was used and the iPhone 16 Pro Max was untouched.

The same physical iPhone then passed 1/1 in 1.611 seconds through a real Aiden-owned Tailscale Serve route. It used the tailnet's system-trusted certificate plus the exact live SPKI pin, reported `connectionMode=tailscale`, paired, authenticated, browsed the approved root, completed folderless/scratch/selected-folder workspace CRUD, rejected selection replay, and reconciled to an empty authoritative workspace list. The proof began from an empty Serve configuration and exposed two defects that are now covered by regression tests: first-connect must derive HTTPS eligibility from the exact Tailscale certificate domain rather than requiring a pre-existing 443 listener, and the loopback proxy target must restore `/api/aiden/v1` because `--set-path` strips the public mount prefix. Cleanup removed only Aiden's exact path and returned `tailscale serve status --json` to `{}`.

The remaining Phase 6 acceptance work is explicit: repeat LAN and Tailscale pairing, browsing, and workspace CRUD from a physical iPad. No simulator was used and the iPhone 16 Pro Max was untouched.

Manual setup-code follow-up 2026-08-21:

- The Mac now offers a uniformly random 100-bit Crockford setup code beside the QR. The code never crosses the network; iOS derives the envelope key locally with HKDF-SHA256, authenticates/decrypts AES-256-GCM, binds the selected exact endpoint, then reuses the existing certificate-pinned one-use exchange.
- Pairing issuance is fenced inside the durable server mutation. iOS authenticates the staged Mac before promotion, uses versioned per-device Keychain scopes, retains the previous working installation on every pre-promotion failure, and stream-bounds the unauthenticated bootstrap response.
- Three fresh-memory reviews were completed and all accepted server-race, Keychain atomicity, cancellation, canonical-input, Tailscale-address, expiry/regeneration, accessibility, contract-revision, and cross-runtime-vector findings were repaired.
- The final registered Remote Access gate passes 216 tests plus seven deterministic transport proofs. Type-check, lint, release-policy, and diff checks pass. The complete connected physical iPhone 13 Pro target passes 101 tests with five expected environment-gated live proofs skipped and zero failures. No simulator was used.
- Hands-on setup-code entry through the live LAN and Tailscale UI is still an explicit manual acceptance item, as is physical-iPad acceptance; neither is claimed as observed here.
