# Desktop multi-host PR 4b: pairing client and Connections settings

Status: Implemented; in review.
Parent plan: [Desktop multi-host control](desktop-multi-host-control-plan.md), delivery row 4 (client half).
Stack: PR 1 (#310) ← PR 2 (#313) ← PR 3 (#314) ← this PR, which also merges PR 4a (#315).

## Goal

From Settings → **Connections** → **Control other devices**, a person can add another Mac or Linux
desktop in one click. The other desktop shows "<device> wants to control this Mac" with the same
six-digit match code. When nobody is at the other desktop, they can enter its setup code instead.
Credentials, endpoints and pins stay in main and never reach a renderer.

## Scope

- **Discovery** (`main/services/peer-discovery.ts`). It runs only while the Add device sheet is
  open; the sheet starts and stops it over IPC, and there are no timers or background polling.
  - Tailscale: `tailscale status --json` through the fixed-path CLI resolver, bounded by the
    runner's 256 KiB buffer. Only online peers' MagicDNS names and OS are read, and nothing is
    persisted. Each `macOS`/`linux` peer (at most 64) is probed with
    `GET https://<magicdns>/api/aiden/v1/health?detail=host` under WebPKI, with at most 4 probes in
    flight and a 3 s timeout.
  - LAN: a Bonjour `_aiden-agent._tcp` browse. Its health probe is display-only and does not verify
    the certificate. Pairing over LAN is protected by the match code, which covers the observed SPKI.
  - Results are de-duplicated by `instanceId`, preferring the Tailscale route. This installation is
    excluded, and already paired hosts are marked.
  - The renderer sees `{id, name, platform?, route, pairingRequests, paired}`. Main resolves the
    address from the id.
- **Bootstrap transport** (`main/services/peer-bootstrap-transport.ts`). This is a JSON-only,
  unauthenticated client for pairing routes. It works in `webpki` mode (Tailscale) or `unverified`
  mode (LAN and setup codes).
  - The first TLS connection captures the leaf SPKI, and every later connection in the session must
    present the same key.
  - The check runs in the agent's `createConnection`, before any request byte is written.
  - Redirects are refused, bodies are bounded, and it sends the `Aiden-Pairing-Secret` header.
- **Pairing-request client** (`main/services/peer-pairing-client.ts`):
  1. Generate an ephemeral X25519 key pair.
  2. Create the request.
  3. Check the host commitment against the revealed host nonce.
  4. Compute the match code with PR 4a's primitives over the observed SPKI.
  5. Long-poll for at most 25 s per poll until the request reaches a terminal state, then open the
     sealed grant against the observed SPKI.

  Cancelling sends a best-effort `DELETE`. Each outcome is typed: `paired`, `denied`, `expired`,
  `cancelled`, `rate_limited` (with `retryAfterSeconds`), `closed`, `unsupported` or `failed`.
- **Registry** (`PeerHostRegistry`):
  - `pairWithRequest` and `pairWithSetupCode` share the existing reservation and finishing steps.
    Finishing means a pinned `/server` check, then persisting before publishing.
  - `replaceHostId` re-pairs an existing host and keeps its local name.
  - `rename` renames a host locally.
  - The manager gains `reconnect(hostId)`.
- **Setup-code fallback**: an unverified bootstrap `POST /pairing/manual-bootstrap {}`, then
  `decryptPeerPairing` with the address prefilled from discovery, then the normal pinned exchange.
  The setup code's AES-GCM authenticates the whole trust payload. "Paste pairing link" remains an
  advanced fallback.
- **Tailscale re-pin**:
  - Applies only to system-trust (Tailscale) hosts.
  - On `identity_changed`, the registry checks `GET /server` with the stored credential over WebPKI
    for the exact paired hostname. If that confirms the same `instanceId`, it saves the new SPKI,
    retries once, and records the `peer-host-repinned` diagnostics event.
  - Private-CA LAN hosts stay strictly pinned and become `blocked: identity_changed`, which shows a
    Re-pair prompt.
- **Settings**:
  - The `remoteAccess` section is retitled **Connections** and split into two segments:
    - **Control this device**: the existing content plus PR 4a's request switch.
    - **Control other devices**: paired hosts with live status, Reconnect, an enable switch and a
      "···" menu with Rename locally, Re-pair and Forget.
  - The **Add device** sheet lists discovered devices with Connect, Enter setup code and Paste
    pairing link, and shows the match code while waiting.

## Decisions

1. A LAN grant's endpoint is the host's canonical `.local` address, which can differ from the
   address Bonjour resolved, so the grant is opened without an endpoint and bound by the observed
   SPKI. A Tailscale grant must name the exact MagicDNS endpoint the request was sent to.
2. The grant must name the instance the user picked, and never this installation. Both are checked
   before anything is persisted.
3. Re-pin retries a request only after a TLS identity failure, which happens before any request
   byte is sent. That makes the retry safe for mutations.
4. No onboarding tile or illustration (user decision). Connections settings is the entry point.

## Verification

- `npm run test:peer-hosts`, which adds the discovery, bootstrap transport, pairing client and
  handler suites. The registry pairing tests run over real HTTPS against PR 4a's router in-process.
- `npm run test:aiden-remote`, `npm run test:settings-design` and the Settings Playwright specs that
  name the section.
