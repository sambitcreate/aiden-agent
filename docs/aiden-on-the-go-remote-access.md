# Aiden On The Go remote access

Aiden Agent can expose a small authenticated API to Aiden On The Go on iPhone and iPad. Remote Access is off by default. Aiden must remain running on the Mac, although its window may be closed.

## Local Network setup

1. Open **Settings → Remote Access** in Aiden Agent.
2. Choose **Local Network** or **Local Network + Tailscale**.
3. Turn on **Enable Remote Access**.
4. Add only the folders the phone or iPad may explore. Selecting the entire home directory requires a second confirmation on the Mac; the filesystem root is never allowed.
5. Choose **Pair over Local Network** and scan the one-time QR code in Aiden On The Go.

The Mac advertises `_aiden-agent._tcp` with Bonjour only while Local Network access is running. LAN traffic uses a per-install P-256 HTTPS identity. The QR contains the private CA trust anchor and the server public-key pin so the mobile client can validate the hostname, certificate chain, and pinned key. A certificate renewal keeps the server key; an identity-key change requires pairing again.

## Tailscale setup

Tailscale supplies reachability and network encryption, but Aiden still requires its own device credential on every request.

1. Install Tailscale on the Mac and sign in to the intended tailnet.
2. Ensure HTTPS certificates are available for the tailnet. Aiden reports this prerequisite rather than enabling it silently.
3. In **Settings → Remote Access**, select **Tailscale** or **Local Network + Tailscale** and enable Remote Access.
4. Review the exact command-equivalent route preview, then choose **Connect**.
5. Pair with **Pair over Tailscale** after the stable `https://…ts.net/api/aiden/v1` address appears.

Aiden owns only `/api/aiden/v1`, proxies it to the loopback-only HTTP listener's matching `/api/aiden/v1` base, and verifies the resulting route. The matching target base is required because Tailscale strips the public `--set-path` prefix before proxying. First-time connection works from an empty Serve configuration only after the node's exact Tailscale certificate domain proves HTTPS was already authorized. Aiden never enables Tailscale Funnel, never runs `tailscale serve reset`, never completes Tailscale authorization for you, and never changes unrelated Serve handlers. **Disconnect** removes only the exact route and target recorded by Aiden. A conflict is reported instead of being overwritten.

## Devices, credentials, and revocation

Each phone or iPad receives a separate random credential. Aiden persists only a fast lookup digest, a salted scrypt digest, and redacted device metadata—not the credential or pairing secret. Pairing QR codes expire after five minutes and work once.

Use **Revoke** beside a paired device to invalidate it immediately. Revocation does not rotate model-provider credentials or affect other paired devices. Pair the device again to restore access.

## Offline behavior

Closing the Aiden window does not stop Remote Access. Quitting Aiden does. The mobile app may retain its bounded offline read cache, but it cannot start new work or mutate the Mac while Aiden is stopped or unreachable. Temporary connection loss does not grant broader access and does not make an invalid or revoked credential valid.

## Mobile usage summary

The **Usage** row on the Aiden On The Go home screen reads aggregate usage from the paired Mac. It reflects Aiden Agent's device-local usage store and sends only aggregate request, token, activity, and estimated-cost totals to the phone. Chat content, workspace paths, and provider credentials are not included.

## Troubleshooting

- **Remote Access says Off:** enable it locally in Aiden Settings. No listener or Bonjour advertisement exists while it is off.
- **Local device cannot find Aiden:** confirm both devices are on the same network, Local Network mode is selected, and local-network permission is enabled for Aiden On The Go.
- **Certificate or pin changed:** do not bypass the warning. Verify the Mac, revoke the old device record, and pair again.
- **Tailscale not found or disconnected:** open Tailscale on the Mac and confirm it reports a stable MagicDNS name.
- **Tailnet HTTPS unavailable:** complete Tailscale's HTTPS authorization flow, then retry Connect in Aiden. Aiden will not authorize it on your behalf.
- **Serve conflict:** inspect the route shown in the error. Remove or relocate the conflicting handler yourself; Aiden will not take it over.
- **A folder is missing:** add it from the Mac. The phone cannot submit an arbitrary path or approve a new browser root.
- **Port already in use:** stop the other local service or repair the saved Remote Access configuration before enabling it again.

Remote Access diagnostics contain request IDs, route names, status codes, latency, and at most a device-ID suffix. They exclude bearer credentials, pairing secrets, provider keys, prompt bodies, and filesystem paths.
