# Bot-First Aiden On The Go — Phase 1 evidence

Date: August 23, 2026
Status: Complete — contract revision 7, disjoint Chat classification, negotiated Bot authority, cross-platform contract decoding, physical-iPhone verification, and review/remediation loops passed.

## Delivered boundary

Phase 1 does not expose the production Bot application routes. It freezes their authenticated Remote API contract and fixes the existing Chat boundary so later phases can implement those routes without allowing Bot chats to masquerade as Workspace chats.

- The shared TypeScript and Swift `Chat` DTOs carry an optional, path-safe, 160-scalar `botId`.
- Ordinary `GET /chats` uses the regular-only application classification, and ordinary `POST /chats` rejects a client-authored `botId`.
- Retained chat, attachment, stream, SSE, cancel, and approval operations classify from main-owned metadata before reading a payload or admitting an effect.
- Bot-classified reads require `bot:read`; mutations additionally require `bot:write` and the route's existing grant. `bot:write` is invalid without `bot:read`.
- Missing authority and unknown or mismatched scoped resources use the same normalized failure boundary so older or under-granted devices cannot infer Bot existence.

## Negotiation and legacy behavior

Bot vocabulary support, device authority, and server support are separate values.

- A new client opts in during pairing with `acceptsBotCapabilities: true`.
- A strict early-v1 server can reject that additive field; iOS retries exactly once with the frozen four-field request.
- The Mac grants Bot authority only to an explicitly negotiating client.
- `/server.capabilities` is the authenticated device's exact grant, while `/server.serverCapabilities` is the supported inventory and is returned only when Bot vocabulary was negotiated.
- The persisted negotiation marker is independent from the grants, so a legacy state containing Bot-looking capability strings does not become authority.
- Swift persists `deviceCapabilities` and `serverCapabilities` separately. Legacy ambiguous snapshots lose Bot grants, server refresh may narrow but never widen a device grant, and the Chat cache namespace moved to v2 so ambiguous v1 projections cannot reappear offline.

## Frozen Bot contract

The normative OpenAPI document, shared fixture, TypeScript parser, and Swift DTOs now agree on:

- Bot summaries/details, semantic and canonical avatars, archive/restore, favorites, and paginated conversation rows;
- atomic identity plus Full/Custom access at Bot creation;
- exact `catalogRevision` on Bot access mutations and both `catalogRevision` and `expectedBotPolicyRevision` on chat reductions;
- a 512-model aggregate catalog ceiling, in addition to 64 providers and 256 models per provider;
- response tombstones for unavailable configured selections, while new mutation selections require currently available entries;
- provider/model pair-or-empty Bot-chat creation with no partial fallback;
- the known notice version `bot-full-access-v1`, with unknown future disclosure versions failing closed;
- 1 MiB JSON responses, at most 10,000 Chat messages, bounded Chat fields, and required timestamp ordering;
- harmless additive response-field tolerance with recursive rejection of managed paths, prompts, credential/header material, skill content/paths, owned asset filenames, and temporary asset URLs;
- read-only archived behavior: authorized identity/history/file/photo reads remain available, while new work and mutations fail with `bot_archived` until restore.

The canonical fixture also proves same-ID/same-revision projection equality, request-to-authoritative-response coherence, chat reductions no wider than their Bot, soft archive identity/avatar preservation, and exact cross-platform Bot/Chat identity binding.

## iOS integration

- `AidenBot.swift` contains the typed, bounded request and response DTOs used by the frozen contract.
- `AidenRemoteContractFixture` decodes every required top-level Bot fixture directly and checks cross-fixture invariants.
- `AidenChat` validates its optional Bot identity, Chat/message bounds, timestamp order, and `titlePending` discriminant while ignoring harmless future response fields.
- Workspace lists, create paths, and deep links defensively reject Bot-classified chats.
- The existing `AidenChatDetailView`, `AidenChatViewModel`, transcript, composer, attachment, streaming, and approval path remain the sole Swift Chat implementation.

## Review and remediation

The initial independent source-and-test review found no P0 issue, but found ten P1 contract/authority gaps and five P2 consistency/evidence gaps that the original green suites did not exercise. The remediation added atomic Custom creation, revision binding, catalog availability and ceiling checks, private-field rejection, an achievable aggregate catalog bound, a real typed Chat fixture parser, a fixed notice version, capability implication, provider/model pair binding, archived route semantics, response-addition coverage, schema bounds, lifecycle preservation, and same-revision equality checks.

Independent final read-only reviews then rechecked the integrated TypeScript/OpenAPI/router and Swift halves after remediation. They caught a cross-platform UTF-16 timeline mismatch, Unicode-scalar truncation defects, and a list-poisoning case where a valid full-message timeline exceeded the emitted text prefix. The fixes preserve emoji at exact title/message limits, reject unpaired surrogates without reflecting stored data, use the same UTF-16 timeline offsets as Swift, and omit rather than falsify a timeline that no longer fits the bounded projection. A different fresh reviewer rechecked the complete post-fix tree before commit. Every P0/P1 report was fixed and its affected checks rerun.

## Verification

```text
npm run type-check
PASS

Focused TypeScript protocol, operation-contract, service, and HTTP regressions
PASS — 42/42

npm run test:aiden-remote
PASS — 278 passed, 1 environment-only skip

LAN transport spike
PASS — 7/7

npm run test:aiden-service-boundary
PASS — 18/18

npm run test:ios-release
PASS — Ruby 20 runs / 42 assertions; Node 27/27

jq empty protocol/aiden-remote/v1/openapi.json
PASS

git diff --check
PASS
```

### Physical iPhone 13 Pro

The final integrated tree was built, installed, and tested on the connected, unlocked physical iPhone 13 Pro:

- Xcode destination: `00008110-00063CD91E98801E`
- Model: iPhone 13 Pro (`iPhone14,2`)
- OS: iOS 27.0
- Result: 142 passed, 5 configuration-only skips, 0 failures
- Result bundle: `/tmp/aiden-bot-phase1-final.gt0lpc/AidenBotPhase1Final2.xcresult`

The selected run covered `AidenBotContractTests`, `AidenChatTests`, `AidenRemoteClientTests`, and `AidenRemotePhase0Tests`. The five skips require external live-server or signed-Keychain configuration and are not product failures. Xcode emitted its known post-test `devicectl diagnose` collection warning after all selected tests finished; the `.xcresult` remains `Passed` with zero failures.

The final focused Bot contract run separately passed 31/31 at:

`/tmp/aiden-swift-remediation.Rd0JqH/AidenBotContractTests.xcresult`

## Gate result

Phase 1 is complete. Phase 2 may build the main-owned Bot application, policy, catalog, notice, and managed-home services against this frozen contract. No production Bot route is considered implemented by this evidence.
