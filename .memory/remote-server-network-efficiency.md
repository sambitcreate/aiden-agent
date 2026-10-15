# Remote server network efficiency (optimization audit, 2026-10-03)

Branch `perf/remote-server`. Desktop-side only; no protocol revision change.

## EXT-32: gzip + ETag/304 on JSON reads
- `writeJson` in `main/services/aiden-remote-router.ts` looks up the request via a
  `WeakMap<ServerResponse, IncomingMessage>` set at handler entry.
- Only `GET` + status 200: adds weak `ETag` (sha256 of the identity JSON) and
  `Vary: accept-encoding`; a matching `If-None-Match` (weak compare, `*`) gets a
  body-less 304. Bodies >= 1 KiB stream gzip (zlib thread pool, chunked) when
  `Accept-Encoding` accepts gzip with q>0. Errors/non-GET are unchanged.
- Opt-in by header. URLSession and OkHttp add `Accept-Encoding: gzip`
  automatically and decode transparently, so current clients get gzip now; both
  only pre-check Content-Length (absent when chunked) and cap decoded bytes.
  `peer-transport.ts` pins `identity` and rejects encoded bodies; it stays identity.
  The device-hub proxy drops `accept-encoding`.
- Neither mobile client sends `If-None-Match` yet; 304 needs a client follow-up
  (keep last ETag per resource, treat 304 as "keep cached"). `cache-control:
  no-store` is unchanged, so URLCache never revalidates on its own.

## EXT-33: progress stream `after` cursor
- `AidenRemoteChatProgressService` keeps a bounded (1024) map of event
  sequence -> {deviceId, chatId, revisions sent so far}. A reconnect presenting a
  known cursor for the same device and chat seeds the dedupe map, so unchanged
  task/agent snapshots are not resent. Unknown cursors (restart, eviction, other
  device/chat) keep full hydration.
- Both clients currently reconnect with `after=0` and GET both snapshots first,
  so there is no wire change today. Client follow-up: pass the last progress
  sequence and treat the 200 open as live even when no snapshot arrives.
  Sequences stay process-local small ints (Android parses them as `Int`).

## EXT-35: deferred
- Behavior fixtures need coordinated iOS/Android test consumers; Android's
  fixture-directory read is still on unmerged `perf/android-lifecycle-streaming`.
