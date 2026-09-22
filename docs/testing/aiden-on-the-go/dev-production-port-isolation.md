# Development/production Remote Access isolation

Date: 2026-08-26

## Contract

- Production retains `49220/49221` and its 64-pair fallback range.
- Development owns a disjoint range beginning at `50220/50221`.
- Existing development state in the production range migrates without rotating
  instance identity, device credentials, or TLS identity. Persisted ownership
  retains its previous target so Aiden can remove that exact live daemon route
  before reconnecting at the migrated listener.
- A pending Tailscale route outcome defers migration until a later launch.
- Tailscale status reads retry/coalesce, while every Serve mutation preserves
  the existing exact ownership, conflict, and post-mutation verification gates.

## Automated evidence

- `npm run type-check`
- `npm run lint -- --quiet`
- Focused port, state, service, route, and controller suites: 104 passed, 1
  host-dependent legacy-port test skipped.
- Follow-up port, state, and controller suite: 56 passed.
- Registered `npm run test:aiden-remote` suite: 334 passed, 1
  host-dependent legacy-port test skipped; all 7 LAN transport spike tests
  passed.

## Live evidence

With packaged production still running, development launched successfully and
both complete listener pairs were simultaneously present:

- Production: LAN `49220`, Tailscale loopback `49221`.
- Development: LAN `50220`, Tailscale loopback `50221`.

The development state durably migrated to `50220`. The real local Tailscale
daemon reported a running backend, an exact certificate domain, empty Serve
state (`{}`), and source-level route inspection classified the development
target as `available` rather than `status_unavailable`.

After migration, the connected iPhone completed pairing exchange and
authenticated workspace, server, schedule, usage, model, chat, Bot, and health
requests successfully against the running development service.
