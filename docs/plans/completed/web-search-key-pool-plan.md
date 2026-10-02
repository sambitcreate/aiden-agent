# Web Search API key pool

Status: Complete (Tavily) — merged in [PR #278](https://github.com/sambitcreate/aiden-agent/pull/278) on 2026-09-29 and shipped in 0.51.0. Other keyed providers and CLI parity remain follow-ups.

## Goal

Let a Web Search provider hold several API keys. When one key is rejected or
runs out of quota, the search moves to the next key without the user noticing.
The idea comes from pi-web-access #453. Tavily is the first provider because
its adapter already maps 401/403 to `auth` and 429/432/433 to `quota`.

## Design

- **Storage.** Each key is its own encrypted secret with the provider's
  endpoint binding.
  - The first key stays in the existing single-key slot
    (`web-search:<provider>:api-key`), which the pool calls the `primary`
    entry.
  - Other keys use `…:pool:<entryId>`.
  - An encrypted index at `…:pool-index` stores the order, labels, `addedAt`
    and the strategy. It never holds key material.
  - A key saved before this change, when no index exists yet, is read as a
    one-entry pool. No migration step is needed.
  - Provider-wide removal deletes the credential's colon-delimited secret
    family in one encrypted-map write, including secondary slots omitted from
    a corrupt or stale index.
- **Selection.** Two strategies:
  - `ordered` always starts with the first key.
  - `round-robin` starts each search one key further along.
  - With either strategy, keys that are cooling down are skipped.
- **Failover.** What happens depends on the error:

  | Error | Result |
  | --- | --- |
  | `auth` (401/403) | The key cools down for 15 minutes, doubling on each repeat up to 24 hours. The next key is tried. |
  | `quota` (429/432/433) | The key cools down for 1 minute, doubling on each repeat up to 1 hour. The next key is tried. |
  | Any other error, including cancellation and timeout | The search stops immediately. |

  - Cooldowns live only in memory, so restarting Aiden clears them.
  - If every key is cooling down, no request is sent. The search fails with
    `quota` if any key hit a quota limit, and with `auth` otherwise. Automatic
    routing then falls back to the next provider as usual.
- **Budget.** The subagent `beforeProviderAttempt` fence runs before every
  keyed request, so each key tried counts against the child's network budget.
- **IPC.** The `webSearch:keyPool:get|add|remove|reorder|setStrategy|resetCooldown`
  channels:
  - check the owner document;
  - enforce the rollout mutation fence;
  - return only IDs, labels, order, strategy and cooldown state.

  Keys can be written but never read back from the renderer.
- **Settings.** In Settings → Web Search → provider setup, Tavily replaces its
  single API-key field with a pool editor. The editor offers:
  - an ordered key list with a position, label and status badge;
  - move up and down buttons, plus Alt+Arrow keyboard reordering;
  - Remove, and Retry now for a key that is cooling down;
  - an optional label and a password field for adding a key;
  - a strategy radio group with no card borders.
- **Logging.** Keys never appear in errors, logs or the renderer state.

## Tests

| Test file | Covers |
| --- | --- |
| `main/services/web-search-key-pool-core.test.ts` | Rotation and failover through the real Tavily adapter with a fake `fetch`, cooldown timing, and the index parser. |
| `main/services/web-search-credential-core.test.ts` | Pool storage, legacy primary synthesis, duplicate keys and the maximum pool size, serialization, corrupt-index cleanup, and removal of orphaned secondary slots. |
| `main/services/web-search.test.ts` | Service-level failover, charging each key attempt, and falling back to the next route. |
| `main/handlers/web-search-key-pool.test.ts` | Register-and-invoke IPC. |
| `renderer/components/settings/web-search-key-pool.test.tsx` | The rendered list's status, order and disabled states. |

## Follow-ups

- Extend the pool to other keyed providers once their adapters map
  quota/auth statuses reliably.
- Optionally persist cooldowns across restarts.
- CLI parity for `packages/cli`, which still uses one key per provider.
