# Aiden On The Go — Phase 5 evidence

Date: 2026-08-19
Status: Implementation complete; physical-iPad launch acceptance remains open.

The shipping target now compiles only the Aiden application shell, remote transport, pairing, workspace, chat, cache, Keychain, and shared Aiden contract sources. Retained Hermex files remain available in repository history/imported source for later deliberate adaptation, but are not members of the Aiden target. Built-product identity assertions reject Hermes, Hermex, Kanban, Cloudflare, and legacy bundle/service identifiers.

A registered source-membership regression test now locks the exact app, test, and Live Activity widget source allowlists. It also scans only shipping Swift sources for imported product identity and legacy `/api/*` routes, and locks the shipping route family to `/api/aiden/v1`.

Automatic signing uses team `5WP229CBB8`, bundle identifier `sbtbiswas.AidenOnTheGo`, the Aiden Keychain service, and the approved URL/app-group namespace. The signed app builds, installs, launches, and runs tests on the physical iPhone 13 Pro. No simulator was used and the iPhone 16 Pro Max was untouched. A physical iPad was not connected, so the plan's physical-iPad launch criterion is recorded as open rather than inferred from compilation.
